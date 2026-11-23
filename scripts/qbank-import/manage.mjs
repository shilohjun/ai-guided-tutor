#!/usr/bin/env node
/**
 * 题库手动维护入口：add / update / delete / list / template。
 *
 * 示例：
 *   node scripts/qbank-import/manage.mjs template --out q.json
 *   node scripts/qbank-import/manage.mjs add --file q.json
 *   node scripts/qbank-import/manage.mjs update --id 836 --file q.json
 *   node scripts/qbank-import/manage.mjs delete --id 836
 *   node scripts/qbank-import/manage.mjs list
 */
import { readFile, writeFile, mkdir, copyFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QBANK_SOURCE } from '../../src/core/qbank-source.data.js';
import { QBANK_GRAPHS } from '../../src/core/qbank-graphs.data.js';
import { QBANK_KEYSTEPS } from '../../src/core/qbank-keysteps.data.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_FILE = join(ROOT, 'src/core/qbank-source.data.js');
const GRAPHS_FILE = join(ROOT, 'src/core/qbank-graphs.data.js');
const KEYSTEPS_FILE = join(ROOT, 'src/core/qbank-keysteps.data.js');
const INDEX_FILE = join(ROOT, 'public/qbank/data.json');
const MAP_FILE = join(ROOT, 'public/qbank/map.html');
const PUBLIC_Q_DIR = join(ROOT, 'public/qbank/q');
const BACKUP_DIR = join(ROOT, '.qbank-backups');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const args = process.argv.slice(2);
const command = args[0];
const dryRun = args.includes('--dry-run');
const yes = args.includes('--yes');

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function wrapHtml(text) {
  const escaped = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped ? `<p>${escaped.replace(/\n/g, '<br>')}</p>` : '';
}

function diffText(value) {
  if (value === 2 || value === '易') return '易';
  if (value === 4 || value === '难') return '难';
  return '中';
}

function diffNumber(value) {
  return { 易: 2, 中: 3, 难: 4 }[diffText(value)] || 3;
}

function optionNormalize(options) {
  if (!Array.isArray(options)) return [];
  return options.map((option, index) => {
    if (typeof option === 'string') {
      const match = /^([A-Z])(?:[.、])\s*(.*)$/.exec(option);
      const l = match?.[1] || String.fromCharCode(65 + index);
      const text = match?.[2] || option;
      return { l, text, html: wrapHtml(text) };
    }
    const l = String(option.l || option.label || String.fromCharCode(65 + index));
    const text = String(option.text ?? stripHtml(option.html ?? '') ?? '');
    const html = String(option.html ?? wrapHtml(text));
    return { l, text, html };
  });
}

function findKnowledge(idOrName) {
  for (const mod of QBANK_GRAPHS.knowledge) {
    for (const chap of mod.children) {
      for (const leaf of chap.children) {
        if (leaf.id === idOrName || leaf.name === idOrName) return { mod, chap, leaf };
      }
    }
  }
  return null;
}

function findMethod(idOrName) {
  for (const cat of QBANK_GRAPHS.methods) {
    for (const sub of cat.children) {
      if (sub.id === idOrName || sub.name === idOrName) return { cat, sub };
    }
  }
  return null;
}

function patchMap(html, data) {
  const open = '<script type="application/json" id="qdata">';
  const at = html.indexOf(open);
  if (at < 0) throw new Error('map.html 缺少 qdata');
  const from = at + open.length;
  const to = html.indexOf('</script>', from);
  if (to < 0) throw new Error('qdata 没有闭合标签');
  return html.slice(0, from) + JSON.stringify(data).replace(/</g, '\\u003C') + html.slice(to);
}

async function readJsonInput(file) {
  if (!file) throw new Error('缺少 --file');
  const text = file === '-' ? await readStdin() : await readFile(resolve(ROOT, file), 'utf8');
  return JSON.parse(text);
}

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', reject);
  });
}

function normalizeQuestion(input, existing, id) {
  const stemHtml = input.stemHtml ?? existing?.stemHtml ?? wrapHtml(input.stemText || '');
  const stemText = input.stemText ?? existing?.stemText ?? stripHtml(stemHtml);
  const options = optionNormalize(input.options ?? existing?.options ?? []);
  const knowledgeIds = [...new Set((input.knowledgeIds ?? existing?.knowledgeIds ?? []).map(String).filter(Boolean))];
  const methodIds = [...new Set((input.methodIds ?? existing?.methodIds ?? []).map(String).filter(Boolean))];
  if (!knowledgeIds.length) throw new Error('至少需要一个 knowledgeIds');
  for (const knowledgeId of knowledgeIds) {
    if (!findKnowledge(knowledgeId)) throw new Error(`未知知识点 ID：${knowledgeId}`);
  }
  for (const methodId of methodIds) {
    if (!findMethod(methodId)) throw new Error(`未知解题思路 ID：${methodId}`);
  }

  const primaryKnowledge = findKnowledge(knowledgeIds[0]);
  const primaryMethod = methodIds.length ? findMethod(methodIds[0]) : null;
  const mod = input.mod ?? existing?.mod ?? primaryKnowledge?.mod.name;
  const chap = input.chap ?? existing?.chap ?? primaryKnowledge?.chap.name;
  const leaf = input.leaf ?? existing?.leaf ?? primaryKnowledge?.leaf.name;
  const t1 = input.t1 ?? existing?.t1 ?? primaryMethod?.cat.name ?? '';
  const t2 = input.t2 ?? existing?.t2 ?? primaryMethod?.sub.name ?? '';
  const answerHtml = input.answerHtml ?? existing?.answerHtml ?? '<p>（待补充）</p>';
  const answerText = input.answerText ?? existing?.answerText ?? stripHtml(answerHtml);
  const analysisHtml = input.analysisHtml ?? existing?.analysisHtml ?? '<p>（待补充）</p>';
  const analysisText = input.analysisText ?? existing?.analysisText ?? stripHtml(analysisHtml);

  return {
    ...(existing ? existing : {}),
    i: id,
    code: input.code ?? existing?.code ?? `MANUAL-${String(id).padStart(3, '0')}`,
    no: input.no ?? existing?.no ?? String(id).padStart(3, '0'),
    ty: input.ty ?? existing?.ty ?? '计算',
    d: diffText(input.d ?? existing?.d ?? 3),
    p: input.p ?? existing?.p ?? '手动录入',
    mod,
    chap,
    leaf,
    t1,
    t2,
    src: input.src ?? existing?.src ?? '手动录入',
    stemHtml,
    stemText,
    options,
    nF: Number(input.nF ?? existing?.nF ?? (stemHtml.match(/class=["'][^"']*qf/g) || []).length),
    nFig: Number(input.nFig ?? existing?.nFig ?? (stemHtml.match(/class=["'][^"']*qfig/g) || []).length),
    knowledgeIds,
    methodIds,
    answerHtml,
    answerText,
    analysisHtml,
    analysisText,
  };
}

function publicRecord(q) {
  const primaryKnowledge = findKnowledge(q.knowledgeIds[0]);
  const primaryMethod = q.methodIds.length ? findMethod(q.methodIds[0]) : null;
  return {
    i: q.i,
    c: q.code,
    no: q.no,
    ty: q.ty,
    d: diffNumber(q.d),
    p: q.p,
    mod: q.mod,
    chap: q.chap,
    leaf: q.leaf,
    t1: q.t1,
    t2: q.t2,
    src: q.src,
    stemHtml: q.stemHtml,
    stemText: q.stemText,
    options: q.options,
    nF: q.nF,
    nFig: q.nFig,
    knowledgeIds: q.knowledgeIds,
    methodIds: q.methodIds,
  };
}

function mapRecord(q) {
  const primaryKnowledge = findKnowledge(q.knowledgeIds[0]);
  const primaryMethod = q.methodIds.length ? findMethod(q.methodIds[0]) : null;
  return {
    i: q.i,
    c: q.code,
    src: q.src,
    m: q.mod,
    k: primaryKnowledge ? `c-${primaryKnowledge.mod.name}-${primaryKnowledge.chap.name}` : `c-${q.mod}-${q.chap}`,
    l: q.knowledgeIds[0] || '',
    t: primaryMethod ? primaryMethod.cat.id : '',
    t2: primaryMethod ? primaryMethod.sub.id : '',
    ty: q.ty,
    d: diffNumber(q.d),
    p: q.p,
    s: stripHtml(q.stemHtml).slice(0, 900),
    stem: stripHtml(q.stemHtml).slice(0, 900),
    opt: q.options.map((option) => `${option.l}. ${option.text}`).join(' ').slice(0, 400),
  };
}

function recomputeGraphs(source) {
  const knowledgeCounts = new Map();
  const methodCounts = new Map();
  for (const q of source) {
    for (const id of q.knowledgeIds) knowledgeCounts.set(id, (knowledgeCounts.get(id) || 0) + 1);
    for (const id of q.methodIds) methodCounts.set(id, (methodCounts.get(id) || 0) + 1);
  }

  const knowledge = structuredClone(QBANK_GRAPHS.knowledge);
  for (const mod of knowledge) {
    let moduleCount = 0;
    for (const chap of mod.children) {
      let chapterCount = 0;
      for (const leaf of chap.children) {
        leaf.count = knowledgeCounts.get(leaf.id) || 0;
        chapterCount += leaf.count;
      }
      chap.count = chapterCount;
      moduleCount += chapterCount;
    }
    mod.count = moduleCount;
  }

  const methods = structuredClone(QBANK_GRAPHS.methods);
  for (const cat of methods) {
    let catCount = 0;
    for (const sub of cat.children) {
      sub.count = methodCounts.get(sub.id) || 0;
      catCount += sub.count;
    }
    cat.count = catCount;
  }

  return { knowledge, methods };
}

async function backupFiles(ids) {
  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(BACKUP_DIR, stamp);
  await mkdir(dir, { recursive: true });
  for (const file of [SOURCE_FILE, GRAPHS_FILE, KEYSTEPS_FILE, INDEX_FILE, MAP_FILE]) {
    if (existsSync(file)) await copyFile(file, join(dir, file.slice(ROOT.length + 1).replace(/[\\/]/g, '__')));
  }
  for (const id of ids) {
    const file = join(PUBLIC_Q_DIR, `${id}.json`);
    if (existsSync(file)) await copyFile(file, join(dir, `q__${id}.json`));
  }
  return dir;
}

async function writeAll(source, keySteps) {
  const graphs = recomputeGraphs(source);
  const index = JSON.parse(await readFile(INDEX_FILE, 'utf8'));
  const data = {
    ...index,
    kg: graphs.knowledge.map((mod) => ({
      id: mod.id,
      name: mod.name,
      count: mod.count,
      children: mod.children.map((chap) => ({
        id: chap.id,
        name: chap.name,
        count: chap.count,
        children: chap.children.map((leaf) => ({ id: leaf.id, name: leaf.name, count: leaf.count })),
      })),
    })),
    think: graphs.methods.map((cat) => ({
      id: cat.id,
      name: cat.name,
      count: cat.count,
      sub: cat.sub,
      desc: cat.desc,
      children: cat.children.map((sub) => ({ id: sub.id, name: sub.name, count: sub.count })),
    })),
    qs: source.map(mapRecord),
  };

  const mapHtml = await readFile(MAP_FILE, 'utf8');
  const mapPatched = patchMap(mapHtml, data);

  if (dryRun) {
    console.log(`[dry-run] 将同步 ${source.length} 道题`);
    return;
  }

  await mkdir(PUBLIC_Q_DIR, { recursive: true });
  await writeFile(SOURCE_FILE, `// Generated from the supplied question bank; data only. Reference answers are server-only.\nexport const QBANK_SOURCE = ${JSON.stringify(source)};\n`, 'utf8');
  await writeFile(GRAPHS_FILE, `// Source knowledge and method taxonomies, including original IDs.\nexport const QBANK_GRAPHS = ${JSON.stringify(graphs)};\n`, 'utf8');
  await writeFile(KEYSTEPS_FILE, `// 题库关键点链：由题库维护脚本同步；手动修改题目时对应关键点会失效并被移除。\nexport const QBANK_KEYSTEPS = ${JSON.stringify(keySteps)};\n`, 'utf8');
  await writeFile(INDEX_FILE, JSON.stringify(data), 'utf8');
  await writeFile(MAP_FILE, mapPatched, 'utf8');

  const sourceIds = new Set(source.map((q) => q.i));
  const publicFiles = await readdir(PUBLIC_Q_DIR);
  for (const file of publicFiles) {
    if (!file.endsWith('.json')) continue;
    const id = Number(file.replace(/\.json$/, ''));
    if (!sourceIds.has(id)) await rm(join(PUBLIC_Q_DIR, file), { force: true });
  }
  for (const q of source) {
    await writeFile(join(PUBLIC_Q_DIR, `${q.i}.json`), JSON.stringify(publicRecord(q)), 'utf8');
  }
}

async function main() {
  if (!command || !['add', 'update', 'delete', 'list', 'template'].includes(command)) {
    console.log(`用法：
  manage.mjs list
  manage.mjs template [--out question.json]
  manage.mjs add --file question.json [--dry-run]
  manage.mjs update --id 836 --file question.json [--dry-run]
  manage.mjs delete --id 836 [--yes] [--dry-run]`);
    process.exit(1);
  }

  if (command === 'list') {
    console.log(`题库共有 ${QBANK_SOURCE.length} 道题`);
    for (const q of QBANK_SOURCE) console.log(`${q.i}\t${q.code}\t${q.ty}\t${q.mod}/${q.chap}/${q.leaf}`);
    return;
  }

  if (command === 'template') {
    const template = {
      code: 'MANUAL-001',
      no: '001',
      ty: '计算',
      d: '中',
      p: '手动录入',
      mod: '力学',
      chap: '牛顿运动定律',
      leaf: '受力分析与正交分解',
      src: '手动录入',
      stemText: '题干纯文本',
      stemHtml: '<p>题干 HTML，可在公式位置放置 <img class=\"qf\" src=\"图片地址\"></p>',
      options: [{ l: 'A', text: '选项一', html: '<p>选项一</p>' }],
      answerText: '答案',
      answerHtml: '<p>答案</p>',
      analysisText: '解析',
      analysisHtml: '<p>解析</p>',
      knowledgeIds: ['k5'],
      methodIds: ['t3a'],
    };
    const out = arg('out');
    const text = JSON.stringify(template, null, 2);
    if (out) {
      await writeFile(resolve(ROOT, out), text + '\n', 'utf8');
      console.log(`模板已写入 ${resolve(ROOT, out)}`);
    } else {
      console.log(text);
    }
    return;
  }

  if (command === 'delete') {
    const id = Number(arg('id'));
    if (!Number.isInteger(id)) throw new Error('缺少有效 --id');
    const existing = QBANK_SOURCE.find((q) => q.i === id);
    if (!existing) throw new Error(`题目不存在：${id}`);
    if (!dryRun && !yes) throw new Error(`删除前请确认：使用 --yes；目标 qbank-${id}`);
    const source = QBANK_SOURCE.filter((q) => q.i !== id);
    const keySteps = { ...QBANK_KEYSTEPS };
    delete keySteps[String(id)];
    if (!dryRun) await backupFiles([id]);
    await writeAll(source, keySteps);
    console.log(`${dryRun ? '[dry-run] 将删除' : '已删除'}题目 ${id}`);
    return;
  }

  const input = await readJsonInput(arg('file'));
  if (command === 'add') {
    const explicitId = arg('id') ? Number(arg('id')) : null;
    const id = explicitId && Number.isInteger(explicitId)
      ? explicitId
      : Math.max(...QBANK_SOURCE.map((q) => q.i)) + 1;
    if (QBANK_SOURCE.some((q) => q.i === id)) throw new Error(`题目编号已存在：${id}`);
    const q = normalizeQuestion(input, null, id);
    const source = [...QBANK_SOURCE, q].sort((a, b) => a.i - b.i);
    const keySteps = { ...QBANK_KEYSTEPS };
    if (!dryRun) await backupFiles([id]);
    await writeAll(source, keySteps);
    console.log(`${dryRun ? '[dry-run] 将添加' : '已添加'}题目 ${id}`);
    return;
  }

  if (command === 'update') {
    const id = Number(arg('id'));
    if (!Number.isInteger(id)) throw new Error('缺少有效 --id');
    const existing = QBANK_SOURCE.find((q) => q.i === id);
    if (!existing) throw new Error(`题目不存在：${id}`);
    const q = normalizeQuestion(input, existing, id);
    const source = QBANK_SOURCE.map((item) => item.i === id ? q : item);
    const keySteps = { ...QBANK_KEYSTEPS };
    delete keySteps[String(id)];
    if (!dryRun) await backupFiles([id]);
    await writeAll(source, keySteps);
    console.log(`${dryRun ? '[dry-run] 将更新' : '已更新'}题目 ${id}`);
  }
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exit(1);
});
