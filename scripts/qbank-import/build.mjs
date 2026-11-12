#!/usr/bin/env node
/**
 * 题库导入：把《高中物理高考真题题库》HTML 导出成应用要的数据资产。
 *
 *   node scripts/qbank-import/build.mjs --source "高中物理高考真题题库 (4).html"
 *   node scripts/qbank-import/build.mjs --source … --dry      # 只报告，不写文件
 *
 * 做什么
 *   1. 解析 HTML 里的封面数据（KG 知识树 / TH 思路树 / 图片表 / 逐题正文）。
 *   2. 已入库的旧题按「题号 + 题干」对上号，沿用原 id（qbank-1… 不变，会话与导出记录不失效）；
 *      新题按文件顺序接在后面编号。
 *   3. 补源数据的漏：题干里没有叶子标签的题落到本章「综合应用」叶子；只给了方法大类的题
 *      保留大类（方法细分留空，不替源数据编分类）；引用了树上不存在的节点（如已删除的
 *      热学实验章节）时按上一版的名字把节点补回树上，绝不静默丢标签。
 *   4. 产出五处产物，全部同源（同一份解析结果，不各写一套）：
 *        public/qbank/q/<id>.json          逐题公开题面（含公式图，不含答案）
 *        public/qbank/data.json            题库地图的双轴索引
 *        public/qbank/map.html             内嵌 <script id="qdata"> 同步成本次数据
 *        src/core/qbank-source.data.js     服务端题库（含参考答案与解析，含图片）
 *        src/core/qbank-graphs.data.js     两棵分类树（含计数）
 *
 * 只依赖 node 内置模块；零依赖是仓库约定。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SOURCE = resolve(ROOT, arg('source', '高中物理高考真题题库 (4).html'));
const DRY = process.argv.includes('--dry');
const ALLOW_DROP = process.argv.includes('--allow-drop');

// ---------------------------------------------------------------- 解析工具

/** 取以 openIndex 处 <div …> 开头的那个 div 的内容（按标签深度配平，不用非贪婪正则）。 */
function tagInner(html, openIndex, tag) {
  const gt = html.indexOf('>', openIndex);
  if (gt < 0) throw new Error('unterminated tag');
  const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'g');
  re.lastIndex = openIndex;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(gt + 1, m.index);
    } else depth += 1;
  }
  throw new Error(`unbalanced ${tag}`);
}

const divInner = (html, at) => tagInner(html, at, 'div');
const spanInner = (html, at) => tagInner(html, at, 'span');

function divByClass(html, cls) {
  const at = html.indexOf(`<div class="${cls}"`);
  return at < 0 ? null : divInner(html, at);
}

const ENTITIES = {
  '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'",
  '&nbsp;': '\u00a0', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…', '&amp;': '&',
};
const decodeEntities = (s) => s.replace(/&(?:lt|gt|quot|#39|#x27|nbsp|mdash|ndash|hellip|amp);/g, (m) => ENTITIES[m]);

function attrOf(attrs, name) {
  const m = new RegExp(`data-${name}="([^"]*)"`).exec(attrs);
  return m ? decodeEntities(m[1]) : '';
}

/** 从 "var KG=" / "TH=" 之后抠出完整 JSON（括号配平 + 字符串感知，数组/对象都认）。 */
function jsonAt(text, from) {
  const cands = [text.indexOf('{', from), text.indexOf('[', from)].filter((x) => x >= 0);
  if (!cands.length) throw new Error('JSON start not found');
  const start = Math.min(...cands);
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) throw new Error('bracket mismatch');
      if (!stack.length) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('JSON end not found');
}

// ---------------------------------------------------------------- 读源文件

const raw = readFileSync(SOURCE, 'utf8');
const IMGS = new Map();
for (const m of raw.matchAll(/"(\d+)":"(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)"/g)) IMGS.set(m[1], m[2]);

const KG = jsonAt(raw, raw.indexOf('var KG='));
const TH = jsonAt(raw, raw.indexOf('TH='));

const articles = [...raw.matchAll(/<article class="q" id="q(\d+)"([^>]*)>/g)];

// ---------------------------------------------------------------- 上一版的分类树（只在源数据缺节点时借用名字）

const OLD_GRAPH_FILE = join(ROOT, 'src/core/qbank-graphs.data.js');
const OLD_NAMES = { mod: new Map(), chap: new Map(), leaf: new Map(), cat: new Map(), sub: new Map() };
if (existsSync(OLD_GRAPH_FILE)) {
  try {
    const text = readFileSync(OLD_GRAPH_FILE, 'utf8');
    const g = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    for (const m of g.knowledge || []) {
      OLD_NAMES.mod.set(m.id, m.name);
      for (const c of m.children || []) {
        OLD_NAMES.chap.set(c.id, c.name);
        for (const l of c.children || []) OLD_NAMES.leaf.set(l.id, l.name);
      }
    }
    for (const t of g.methods || []) {
      OLD_NAMES.cat.set(t.id, t.name);
      for (const s of t.children || []) OLD_NAMES.sub.set(s.id, s.name);
    }
  } catch {
    /* 上一版不在或坏了，缺名字时用 id 顶替 */
  }
}

// ---------------------------------------------------------------- 分类树（可变，后面按标签补节点）

/** @type {{id:string,name:string,real:boolean,children:{id:string,name:string,real:boolean,children:{id:string,name:string,real:boolean}[]}[]}[]} */
const tree = KG.map((m) => ({
  id: m.id,
  name: m.name,
  restored: false,
  children: (m.children || []).map((c) => ({
    id: c.id,
    name: c.name,
    restored: false,
    children: (c.children || []).map((l) => ({ id: l.id, name: l.name, restored: false })),
  })),
}));

const methodTree = TH.map((t) => ({
  id: t.id,
  name: t.name,
  sub: t.sub ?? '',
  desc: t.desc ?? '',
  children: (t.children || []).map((c) => ({ id: c.id, name: c.name })),
}));

const findMod = (id) => tree.find((m) => m.id === id);
const findChap = (id) => tree.flatMap((m) => m.children).find((c) => c.id === id);
const findLeaf = (id) => tree.flatMap((m) => m.children.flatMap((c) => c.children)).find((l) => l.id === id);
const findCat = (id) => methodTree.find((t) => t.id === id);
const findSub = (id) => methodTree.flatMap((t) => t.children).find((s) => s.id === id);

const restored = [];

/** 源数据引用了树上没有的节点：按上一版的名字补回来，并记在报告里。 */
function ensureKnowledgeNode(kgIds) {
  const modId = kgIds.find((x) => x.startsWith('m-'));
  const chapId = kgIds.find((x) => x.startsWith('c-'));
  const leafId = kgIds.find((x) => x.startsWith('k'));
  if (modId && !findMod(modId)) {
    tree.push({ id: modId, name: OLD_NAMES.mod.get(modId) ?? modId, restored: true, children: [] });
    restored.push(`${modId} ${OLD_NAMES.mod.get(modId) ?? ''}`);
  }
  if (chapId && !findChap(chapId)) {
    const owner = findMod(modId) ?? tree[0];
    owner.children.push({ id: chapId, name: OLD_NAMES.chap.get(chapId) ?? chapId, restored: true, children: [] });
    restored.push(`${chapId} ${OLD_NAMES.chap.get(chapId) ?? ''}`);
  }
  if (leafId && !findLeaf(leafId)) {
    const owner = findChap(chapId);
    if (!owner) throw new Error(`叶节点 ${leafId} 无处安放：章节 ${chapId} 也不存在`);
    owner.children.push({ id: leafId, name: OLD_NAMES.leaf.get(leafId) ?? leafId, restored: true });
    restored.push(`${leafId} ${OLD_NAMES.leaf.get(leafId) ?? ''}`);
  }
}

// ---------------------------------------------------------------- 逐题解析

const IMG_RE = /<img\b([^>]*?)class="(f|fig)"([^>]*?)>/g;
const missingImgs = new Set();

/** 把 <img class="f|fig" data-k="…"> 换成内联图片；同时给一份占位纯文本。 */
function fmt(fragment) {
  let nF = 0;
  let nFig = 0;
  const html = fragment.replace(IMG_RE, (whole, head, kind, tail) => {
    const blob = head + tail;
    const k = /data-k="(\d+)"/.exec(blob);
    if (!k) return whole;
    const src = IMGS.get(k[1]);
    if (!src) {
      missingImgs.add(k[1]);
      return '〔图〕';
    }
    if (kind === 'f') nF += 1;
    else nFig += 1;
    const w = /width="(\d+)"/.exec(blob);
    const h = /height="(\d+)"/.exec(blob);
    const size = `${w ? ` width="${w[1]}"` : ''}${h ? ` height="${h[1]}"` : ''}`;
    const alt = kind === 'f' ? '公式' : '图形';
    return `<img class="q${kind}" data-k="${k[1]}" src="${src}"${size} alt="${alt}" loading="lazy" decoding="async">`;
  }).replace(/\s+/g, ' ').trim();

  const text = decodeEntities(
    fragment
      .replace(IMG_RE, (whole, head, kind) => (kind === 'f' ? '〔式〕' : '〔图〕'))
      .replace(/<br\s*\/?>/g, ' ')
      .replace(/<\/p>\s*<p[^>]*>/g, ' ')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\s+/g, ' ').trim();

  return { html, text, nF, nFig };
}

/** 行内 LaTeX 保留原样：地图与工作台都装了 KaTeX，能直接画出来。 */
const squashTex = (s) => String(s);

/** 地图用的纯文本：公式图/图形换成占位符，行内 LaTeX 原样留着给 KaTeX 渲染。 */
function mapText(fragment) {
  return squashTex(decodeEntities(
    fragment
      .replace(/<img[^>]*class="f"[^>]*>/g, '⟨式⟩')
      .replace(/<img[^>]*class="fig"[^>]*>/g, '⟨图⟩')
      .replace(/<img[^>]*>/g, '⟨图⟩')
      .replace(/<(sup|sub)[^>]*>(.*?)<\/\1>/g, '$2')
      .replace(/<br\s*\/?>/g, ' ')
      .replace(/<\/p>\s*<p[^>]*>/g, ' ')
      .replace(/<[^>]+>/g, ''),
  )).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

const parsed = [];
for (const m of articles) {
  const attrs = m[2];
  const bodyStart = m.index + m[0].length;
  const body = raw.slice(bodyStart, raw.indexOf('</article>', bodyStart));

  const stemFrag = divByClass(body, 'stem') ?? '';
  const stem = fmt(stemFrag);

  const options = [];
  const optAt = body.indexOf('<div class="options"');
  if (optAt > -1) {
    const block = divInner(body, optAt);
    const re = /<div class="opt">/g;
    let om;
    while ((om = re.exec(block))) {
      const inner = divInner(block, om.index);
      const olAt = inner.indexOf('<span class="ol">');
      const ocAt = inner.indexOf('<span class="oc">');
      const label = olAt > -1 ? spanInner(inner, olAt).trim() : '';
      const ocFrag = ocAt > -1 ? inner.slice(inner.indexOf('>', ocAt) + 1, inner.lastIndexOf('</span>')) : '';
      const o = fmt(ocFrag);
      options.push({ l: label, html: o.html, text: o.text });
      stem.nF += o.nF;
      stem.nFig += o.nFig;
    }
  }

  const ansAt = body.indexOf('<div class="ansval"');
  const ans = ansAt > -1 ? fmt(divInner(body, ansAt)) : { html: '', text: '', nF: 0, nFig: 0 };
  const anaAt = body.indexOf('<div class="analysis"');
  const ana = anaAt > -1 ? fmt(divInner(body, anaAt)) : { html: '', text: '', nF: 0, nFig: 0 };
  // nF / nFig 沿用旧口径：题干 + 选项 + 答案 + 解析 里的公式图 / 图形张数
  stem.nF += ans.nF + ana.nF;
  stem.nFig += ans.nFig + ana.nFig;

  const kgIds = attrOf(attrs, 'kg').split(/\s+/).filter(Boolean);
  const thIds = attrOf(attrs, 'think').split(/\s+/).filter(Boolean);

  // 有的题选项是图片，而导出没把图片内联，只在选项里留了 `figs/09a.png` 这样的文件名。
  // 这种题在界面上是一段文件路径，等于没有选项：默认不入库，记进 docs/qbank-import-excluded.json。
  const brokenRefs = [
    stem.html, ans.html, ana.html, ...options.map((o) => o.html),
  ].flatMap((htmlFrag) => [
    ...htmlFrag.matchAll(/figs\/[\w.-]+\.(?:png|jpe?g|webp|gif|svg)/gi),
    ...htmlFrag.matchAll(/<img[^>]*src="(?!data:)([^"]+)"/gi),
  ].map((mm) => mm[0]));

  parsed.push({
    n: Number(m[1]),
    code: (/<span class="q-id">([^<]*)<\/span>/.exec(body)?.[1] ?? '').trim(),
    no: (/<span class="q-index">([^<]*)<\/span>/.exec(body)?.[1] ?? '').trim(),
    ty: attrOf(attrs, 'type'),
    d: attrOf(attrs, 'difficulty'),
    p: attrOf(attrs, 'province'),
    src: (/<span class="q-source"[^>]*>([^<]*)<\/span>/.exec(body)?.[1] ?? '').trim(),
    stemHtml: stem.html,
    stemText: stem.text,
    mapStem: mapText(stemFrag),
    mapOpt: options.map((o) => `${o.l}. ${o.text}`).join(' '),
    options,
    answerHtml: ans.html,
    answerText: ans.text,
    analysisHtml: ana.html,
    analysisText: ana.text,
    nF: stem.nF,
    nFig: stem.nFig,
    kgIds,
    thIds,
    brokenRefs,
  });
}

// ---------------------------------------------------------------- 补标签（源数据漏标 / 引用已删节点）

const retagged = { leaf: [], method: [] };
for (const q of parsed) {
  ensureKnowledgeNode(q.kgIds);
  const leafId = q.kgIds.find((x) => x.startsWith('k'));
  const chapId = q.kgIds.find((x) => x.startsWith('c-'));

  if (leafId) q.knowledgeIds = q.kgIds.filter((x) => x.startsWith('k'));
  else {
    // 只标到章节：落到本章「综合应用」叶子，宁可给泛化卡片，也不让报告缺知识点
    const chap = findChap(chapId);
    const fallback = chap?.children.find((c) => c.name === '综合应用');
    if (!fallback) throw new Error(`q#${q.n}（${q.code}）没有叶子标签，且章节 ${chapId} 没有综合应用叶子`);
    q.knowledgeIds = [fallback.id];
    retagged.leaf.push(`q#${q.n} ${q.code} → ${fallback.id}`);
  }

  const sub = q.thIds.find((x) => x.length > 2);
  const cat = q.thIds.find((x) => x.length === 2);
  if (sub) {
    q.methodIds = q.thIds.filter((x) => x.length > 2);
    q.methodCat = cat || methodTree.find((t) => t.children.some((c) => c.id === sub))?.id || '';
    q.methodSub = sub;
  } else {
    // 只标到方法大类：保留大类，细分留空（不替源数据编细分）
    if (!cat || !findCat(cat)) throw new Error(`q#${q.n}（${q.code}）没有任何方法标签`);
    q.methodIds = [cat];
    q.methodCat = cat;
    q.methodSub = '';
    retagged.method.push(`q#${q.n} ${q.code} → ${cat} ${findCat(cat).name}`);
  }

  q.leafId = q.knowledgeIds[0];
}

const modOf = (q) => tree.find((m) => m.children.some((c) => c.children.some((l) => l.id === q.leafId)))?.name ?? '';
const chapOf = (q) => tree.flatMap((m) => m.children).find((c) => c.children.some((l) => l.id === q.leafId))?.name ?? '';
const leafOf = (q) => findLeaf(q.leafId)?.name ?? '';
const catOf = (q) => findCat(q.methodCat)?.name ?? '';
const subOf = (q) => (q.methodSub ? findSub(q.methodSub)?.name ?? '' : '');

for (const q of parsed) {
  q.mod = modOf(q);
  q.chap = chapOf(q);
  q.leaf = leafOf(q);
  q.t1 = catOf(q);
  q.t2 = subOf(q);
  q.chapId = tree.flatMap((m) => m.children).find((c) => c.children.some((l) => l.id === q.leafId))?.id ?? '';
}

// ---------------------------------------------------------------- id 分配（旧题保号）

const oldDir = join(ROOT, 'public/qbank/q');
const oldRecords = existsSync(oldDir)
  ? readdirSync(oldDir).filter((f) => /^\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(oldDir, f), 'utf8')))
  : [];
const norm = (s) => String(s ?? '').replace(/\s+/g, '');
const oldByCode = new Map();
for (const r of oldRecords) {
  if (!oldByCode.has(r.code)) oldByCode.set(r.code, []);
  oldByCode.get(r.code).push(r);
}

// 先按题号码配对，再用题干消歧（同一题号码在新文件里可能重复）；
// 只按题干配会漏掉源文件改过排版的题，所以题干只当"优先项"。
const usedOld = new Set();
for (const q of parsed) {
  const candidates = (oldByCode.get(q.code) ?? []).filter((r) => !usedOld.has(r.i));
  if (!candidates.length) {
    q.i = 0;
    continue;
  }
  const exact = candidates.find((r) => norm(r.stemText) === norm(q.stemText));
  const pick = exact ?? candidates[0];
  usedOld.add(pick.i);
  q.i = pick.i;
}
const takenIds = new Set(usedOld);

// 选项图没内联、只剩文件名的题：默认不入库。旧题不受影响（它们的题面取自上一版，不是这份新导出）。
const excluded = process.argv.includes('--include-broken') ? [] : parsed.filter((q) => q.brokenRefs.length && !q.i);
const excludedSet = new Set(excluded);
const bank = parsed.filter((q) => !excludedSet.has(q));

/** 被挡在库外的题：留一份清单给下一版对账，注明缺的是什么。 */
const excludedReport = excluded.map((q) => ({
  sourceIndex: q.n,
  code: q.code,
  type: q.ty,
  province: q.p,
  difficulty: q.d,
  missingRefs: [...new Set(q.brokenRefs)].slice(0, 8),
  reason: '选项图片没有内联进导出文件，选项位置只剩 figs/*.png 文件名，界面上没有图可看',
}));

let cursor = oldRecords.length ? Math.max(...oldRecords.map((r) => r.i)) + 1 : 1;
for (const q of bank) {
  if (q.i) continue;
  while (takenIds.has(cursor)) cursor += 1;
  q.i = cursor;
  takenIds.add(cursor);
}

const orphanOld = oldRecords.filter((r) => !usedOld.has(r.i));
if (orphanOld.length && !ALLOW_DROP) {
  throw new Error(`旧题在新文件里找不到（会丢 id；确认后加 --allow-drop）：${orphanOld.map((r) => `${r.i}:${r.code}`).join(', ')}`);
}

const seen = new Set();
for (const q of bank) {
  if (seen.has(q.i)) throw new Error(`id 冲突：${q.i}`);
  seen.add(q.i);
}

// 旧题保内容：新导出把公式上下标、分式压成了纯文本，用它重写已经入库的题只会变差。
// 所以题面 / 选项 / 答案解析沿用上一版，分类用最新标签（标签与最新分类树是一套编号，不能混）。
const OLD_SOURCE_FILE = join(ROOT, 'src/core/qbank-source.data.js');
let oldSourceById = new Map();
if (existsSync(OLD_SOURCE_FILE)) {
  const text = readFileSync(OLD_SOURCE_FILE, 'utf8');
  try {
    oldSourceById = new Map(JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)).map((r) => [r.i, r]));
  } catch {
    /* 上一版读不出来：当作没有，全量用新导出 */
  }
}
const oldPublicById = new Map(oldRecords.map((r) => [r.i, r]));
const keptContent = [];
for (const q of bank) {
  const old = oldPublicById.get(q.i);
  if (!old) continue;
  q.code = old.code; q.no = old.no; q.ty = old.ty; q.d = old.d; q.p = old.p; q.src = old.src;
  q.stemHtml = old.stemHtml; q.stemText = old.stemText; q.options = old.options;
  q.nF = old.nF; q.nFig = old.nFig;
  q.mapStem = squashTex(old.stemText.replace(/〔式〕/g, '⟨式⟩').replace(/〔图〕/g, '⟨图⟩'));
  q.mapOpt = squashTex(old.options.map((o) => `${o.l}. ${o.text}`).join(' '));
  const src = oldSourceById.get(q.i);
  if (src) {
    q.answerHtml = src.answerHtml; q.answerText = src.answerText;
    q.analysisHtml = src.analysisHtml; q.analysisText = src.analysisText;
  }
  keptContent.push(q.i);
}

const ordered = [...bank].sort((a, b) => a.i - b.i);

// ---------------------------------------------------------------- 计数

const leafCount = new Map();
const chapCount = new Map();
const modCount = new Map();
const subCount = new Map();
const catCount = new Map();
const bump = (map, k) => map.set(k, (map.get(k) || 0) + 1);
for (const q of ordered) {
  for (const leaf of q.knowledgeIds) {
    bump(leafCount, leaf);
    const chap = tree.flatMap((m) => m.children).find((c) => c.children.some((l) => l.id === leaf));
    const mod = tree.find((m) => m.children.some((c) => c.children.some((l) => l.id === leaf)));
    bump(chapCount, chap.id);
    bump(modCount, mod.id);
  }
  for (const id of q.methodIds) {
    if (id.length > 2) {
      bump(subCount, id);
      const cat = methodTree.find((t) => t.children.some((c) => c.id === id));
      bump(catCount, cat.id);
    } else bump(catCount, id);
  }
}

const kgTree = tree.map((m) => ({
  id: m.id,
  name: m.name,
  count: modCount.get(m.id) || 0,
  children: m.children.map((c) => ({
    id: c.id,
    name: c.name,
    count: chapCount.get(c.id) || 0,
    children: c.children.map((l) => ({ id: l.id, name: l.name, count: leafCount.get(l.id) || 0 })),
  })),
}));
const thinkTree = methodTree.map((t) => ({
  id: t.id,
  name: t.name,
  count: catCount.get(t.id) || 0,
  children: t.children.map((c) => ({ id: c.id, name: c.name, count: subCount.get(c.id) || 0 })),
}));

// 服务端用的分类树：知识树同 kgTree；方法树额外带 sub / desc（复盘卡要）
const graphTree = {
  knowledge: kgTree,
  methods: methodTree.map((t) => ({
    id: t.id,
    name: t.name,
    sub: t.sub,
    desc: t.desc,
    count: catCount.get(t.id) || 0,
    children: t.children.map((c) => ({ id: c.id, name: c.name, count: subCount.get(c.id) || 0 })),
  })),
};

// ---------------------------------------------------------------- 产物

const DIFF = { 易: 2, 中: 3, 难: 4 };
const mapIndex = {
  kg: kgTree,
  think: thinkTree,
  qs: ordered.map((q) => ({
    i: q.i,
    c: q.code,
    src: q.src,
    m: q.mod,
    k: q.chapId,
    l: q.leafId,
    t: q.methodCat,
    t2: q.methodSub,
    ty: q.ty,
    d: DIFF[q.d] ?? 3,
    p: q.p,
    s: q.mapStem.slice(0, 900),
    stem: q.mapStem.slice(0, 900),
    opt: q.mapOpt.slice(0, 400),
  })),
};

const base = (q) => ({
  i: q.i, code: q.code, no: q.no, ty: q.ty, d: q.d, p: q.p,
  mod: q.mod, chap: q.chap, leaf: q.leaf, t1: q.t1, t2: q.t2, src: q.src,
  stemHtml: q.stemHtml, stemText: q.stemText, options: q.options,
  nF: q.nF, nFig: q.nFig, knowledgeIds: q.knowledgeIds, methodIds: q.methodIds,
});
const publicRecord = (q) => base(q);
const sourceRecord = (q) => ({
  ...base(q),
  // Report-only provenance: a chapter fallback is not an explicit concept tag.
  ...(!q.kgIds.some((id) => id.startsWith('k')) ? { knowledgeScope: 'chapter' } : {}),
  answerHtml: q.answerHtml, answerText: q.answerText,
  analysisHtml: q.analysisHtml, analysisText: q.analysisText,
});

const outQ = join(ROOT, 'public/qbank/q');
const outData = join(ROOT, 'public/qbank/data.json');
const outMap = join(ROOT, 'public/qbank/map.html');
const outSource = join(ROOT, 'src/core/qbank-source.data.js');
const outGraphs = join(ROOT, 'src/core/qbank-graphs.data.js');

/** 地图 HTML：只换内嵌 JSON，其余一字不动。 */
function patchMap(html, data) {
  const open = '<script type="application/json" id="qdata">';
  const at = html.indexOf(open);
  if (at < 0) throw new Error('map.html 里找不到 qdata');
  const from = at + open.length;
  const to = html.indexOf('</script>', from);
  if (to < 0) throw new Error('qdata 没有闭合');
  return html.slice(0, from) + JSON.stringify(data) + html.slice(to);
}

if (!DRY) {
  mkdirSync(outQ, { recursive: true });
  let written = 0;
  for (const q of ordered) {
    const file = join(outQ, `${q.i}.json`);
    const next = JSON.stringify(publicRecord(q));
    if (existsSync(file)) {
      try {
        // 内容没变就不重写：别为了排版把已有题目的文件全部刷一遍 diff
        if (JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))) === next) continue;
      } catch {
        /* 坏文件直接重写 */
      }
    }
    writeFileSync(file, next, 'utf8');
    written += 1;
  }
  for (const f of readdirSync(outQ)) {
    if (!/^\d+\.json$/.test(f)) continue;
    if (!takenIds.has(Number(f.replace('.json', '')))) throw new Error(`过期题目文件需要手工确认：${f}`);
  }
  writeFileSync(outData, JSON.stringify(mapIndex), 'utf8');
  writeFileSync(outMap, patchMap(readFileSync(outMap, 'utf8'), mapIndex), 'utf8');
  writeFileSync(outSource,
    '// Generated from the supplied question bank; data only. Reference answers are server-only.\n'
    + `export const QBANK_SOURCE = ${JSON.stringify(ordered.map(sourceRecord))};\n`, 'utf8');
  writeFileSync(outGraphs,
    '// Source knowledge and method taxonomies, including original IDs.\n'
    + `export const QBANK_GRAPHS = ${JSON.stringify(graphTree)};\n`, 'utf8');
  writeFileSync(join(ROOT, 'docs/qbank-import-excluded.json'),
    `${JSON.stringify(excludedReport, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------- 报告

const types = {};
for (const q of ordered) types[q.ty] = (types[q.ty] || 0) + 1;
const mods = {};
for (const q of ordered) mods[q.mod] = (mods[q.mod] || 0) + 1;
const leaves = tree.flatMap((m) => m.children.flatMap((c) => c.children));
const subs = methodTree.flatMap((t) => t.children);
const zero = (list, map) => list.filter((x) => !map.has(x.id)).map((x) => `${x.id}:${x.name}`);

console.log('源文件     ', SOURCE);
const prevMax = oldRecords.length ? Math.max(...oldRecords.map((r) => r.i)) : 0;
const fresh = ordered.filter((q) => q.i > prevMax).length;
console.log('题量       ', ordered.length, `（已在库 ${ordered.length - fresh} 道沿用原 id，本次新编号 ${fresh} 道；id 区间 1..${Math.max(...takenIds)}）`);
console.log('挡在库外   ', excluded.length ? `${excluded.length} 题：选项图未内联（清单见 docs/qbank-import-excluded.json，加 --include-broken 可强行导入）` : '无');
console.log('旧题题面   ', `${keptContent.length} 道沿用上一版题面与答案解析（新导出把公式上下标/分式压平了，不拿它覆盖已入库内容）`);
if (orphanOld.length) console.log('！！丢掉的旧题：', orphanOld.map((r) => `${r.i}:${r.code}`).join(', '));
console.log('题型       ', JSON.stringify(types));
console.log('模块       ', JSON.stringify(mods));
console.log('知识树     ', `${tree.length} 模块 / ${tree.reduce((a, m) => a + m.children.length, 0)} 章 / ${leaves.length} 叶；零题叶 ${zero(leaves, leafCount).length} 个 ${zero(leaves, leafCount).slice(0, 6).join(' ')}`);
console.log('思路树     ', `${methodTree.length} 类 / ${subs.length} 细分；零题细分 ${zero(subs, subCount).length} 个 ${zero(subs, subCount).slice(0, 6).join(' ')}`);
console.log('补回节点   ', restored.length ? restored.join('、') : '无');
console.log('补知识点   ', retagged.leaf.length ? retagged.leaf.join('、') : '无');
console.log('补方法大类 ', retagged.method.length ? `${retagged.method.length} 题：${retagged.method.slice(0, 6).join('、')}` : '无');
console.log('图片       ', `${IMGS.size} 张 / ${([...IMGS.values()].reduce((a, b) => a + b.length, 0) / 1024 / 1024).toFixed(2)} MB；题面引用缺失 ${missingImgs.size} 个 ${[...missingImgs].slice(0, 5).join(' ')}`);
console.log('完整性     ', `缺 code/ty/d/p ${ordered.filter((q) => !q.code || !q.ty || !q.d || !q.p).length} 题；无答案 ${ordered.filter((q) => !q.answerText).length} 题；无解析 ${ordered.filter((q) => !q.analysisText).length} 题；无选项 ${ordered.filter((q) => !q.options.length).length} 题`);
if (DRY) console.log('（--dry：只报告，不写文件）');
