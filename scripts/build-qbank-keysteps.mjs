#!/usr/bin/env node
/**
 * 离线编译题库的关键点链：835 题 × 官方解析 → `keysteps.jsonl`
 *
 * 为什么离线跑：这一步是"把题库从选择题变成教学资产"的工序，
 * 不该在学生提问时才发生 —— 那会把一次 4 秒的模型调用塞进学生等待的路径里，
 * 而且同一道题每次都可能抽出不一样的关键点。
 *
 * 用法：
 *   node scripts/build-qbank-keysteps.mjs --dry                    看一眼提示词长什么样
 *   node scripts/build-qbank-keysteps.mjs --limit 12 --types 计算,实验,单选
 *   node scripts/build-qbank-keysteps.mjs                          全量（可断点续跑）
 *
 * 断点续跑：输出是 JSONL，启动时读一遍已完成的题号，跳过它们。
 * 中断（Ctrl-C / 掉网）不丢已完成的题，重跑同一条命令就接着来。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../src/core/env.js';
import { readLLMConfig } from '../src/core/llm.js';
import { QBANK_SOURCE } from '../src/core/qbank-source.data.js';
import { KEYSTEPS_SYSTEM_PROMPT, buildKeystepsPrompt, parseKeystepsReply } from '../src/core/keysteps-prompt.js';
import { normalizeKeysteps } from '../src/core/keysteps.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// .env 必须先读，readLLMConfig 只认 process.env
loadEnvFile();

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { out: '.tmp-rag/keysteps.jsonl', concurrency: 6, limit: Infinity, types: null, ids: null, dry: false, redo: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') out.dry = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--types') out.types = String(argv[++i]).split(',').map((t) => t.trim()).filter(Boolean);
    else if (a === '--ids') out.ids = String(argv[++i]).split(',').map((t) => t.trim()).filter(Boolean);
    else if (a === '--redo') out.redo = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const OUT_PATH = resolve(ROOT, args.out);
const FAIL_PATH = OUT_PATH.replace(/\.jsonl$/, '-fail.jsonl');

// ---------------------------------------------------------------------------
// 选题
// ---------------------------------------------------------------------------

/** 按题型过滤后均匀抽样：直接取前 N 道会全落在同一册书里，抽不出题型差异。 */
function pickQuestions() {
  let list = QBANK_SOURCE.slice();
  if (args.ids?.length) {
    const want = new Set(args.ids);
    list = list.filter((q) => want.has(q.code) || want.has(String(q.i)));
  }
  if (args.types?.length) {
    const want = new Set(args.types);
    list = list.filter((q) => want.has(String(q.ty)));
  }
  if (list.length <= args.limit) return list;

  const picked = [];
  const stride = list.length / args.limit;
  for (let k = 0; k < args.limit; k++) picked.push(list[Math.floor(k * stride)]);
  return picked;
}

function readDone() {
  if (!existsSync(OUT_PATH)) return new Set();
  const done = new Set();
  for (const line of readFileSync(OUT_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.i != null && Array.isArray(row.keysteps)) done.add(Number(row.i));
    } catch {
      // 半截行（上次被 Ctrl-C 打断）——重跑会补上
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// 模型调用
// ---------------------------------------------------------------------------

const config = readLLMConfig();

async function chat(messages) {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, messages, temperature: 0.2, max_tokens: 1800 }),
    signal: AbortSignal.timeout(config.timeoutMs * 2),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 160)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

function toQuestionPayload(q) {
  return {
    i: q.i,
    code: q.code,
    ty: q.ty,
    difficulty: q.d,
    stem: String(q.stemText ?? '').trim(),
    opt: (q.options ?? []).map(String).join(' '),
    analysis: String(q.analysisText ?? '').trim(),
  };
}

/**
 * 一道题 → 关键点链。
 *
 * 失败重试一次，并且把"上一次错在哪"写回提示里 ——
 * 大多数失败不是模型不会做，而是它漏字段或者把数组写成了字符串。
 */
async function compileOne(q) {
  const payload = toQuestionPayload(q);
  const basePrompt = buildKeystepsPrompt(payload);
  let lastError = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const userContent = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\n上一次的输出不合格：${lastError}\n请严格按 JSON 契约重新输出，不要解释。`;

    const reply = await chat([
      { role: 'system', content: KEYSTEPS_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ]);

    try {
      const keysteps = normalizeKeysteps(parseKeystepsReply(reply));
      return { keysteps, attempt };
    } catch (err) {
      lastError = err.message;
    }
  }
  throw new Error(lastError || '未知失败');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

if (!config.available) {
  console.error('✗ 没有 LLM_API_KEY，无法编译。检查 .env。');
  process.exit(1);
}

const questions = pickQuestions();
if (!questions.length) {
  console.error('✗ 选题为空，检查 --types / --ids。');
  process.exit(1);
}

if (args.dry) {
  const sample = questions[0];
  console.log(`模型：${config.model} @ ${config.baseUrl}`);
  console.log(`\n===== 系统提示 =====\n${KEYSTEPS_SYSTEM_PROMPT}`);
  console.log(`\n===== 用户提示（${sample.code} ${sample.ty}）=====\n${buildKeystepsPrompt(toQuestionPayload(sample))}`);
  process.exit(0);
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
const done = readDone();
// --redo：提示词改过之后重跑指定题，别被断点续跑挡住（JSONL 按 i 去重取最后一条）
const pending = args.redo ? questions.slice() : questions.filter((q) => !done.has(Number(q.i)));

console.error(`▶ ${config.model} @ ${config.baseUrl}`);
console.error(`  待编译 ${pending.length} 道（已完成 ${questions.length - pending.length}，总选题 ${questions.length}）`);
console.error(`  输出 ${OUT_PATH}\n`);

const started = Date.now();
let cursor = 0;
let ok = 0;
const failures = [];
const counts = new Map();

async function worker() {
  while (cursor < pending.length) {
    const q = pending[cursor++];
    const t0 = Date.now();
    try {
      const { keysteps, attempt } = await compileOne(q);
      appendFileSync(OUT_PATH, `${JSON.stringify({
        i: q.i,
        code: q.code,
        ty: q.ty,
        d: q.d,
        model: config.model,
        keysteps,
        attempt,
        ts: new Date().toISOString(),
      })}\n`);
      ok++;
      const bucket = q.ty === '实验' ? '实验' : q.ty === '计算' ? '计算' : '选择';
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      console.error(`  ✓ [${ok}/${pending.length}] ${q.code} ${q.ty} ${keysteps.length} 点 ${((Date.now() - t0) / 1000).toFixed(1)}s${attempt > 1 ? ' (重试)' : ''}`);
    } catch (err) {
      failures.push({ i: q.i, code: q.code, ty: q.ty, error: err.message });
      appendFileSync(FAIL_PATH, `${JSON.stringify({ i: q.i, code: q.code, ty: q.ty, error: err.message })}\n`);
      console.error(`  ✗ [${q.code}] ${q.ty} ${err.message}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.max(1, Math.min(args.concurrency, pending.length)) }, worker));

const seconds = ((Date.now() - started) / 1000).toFixed(0);
console.error(`\n完成：${ok} 成功 / ${failures.length} 失败，用时 ${seconds}s`);
if (counts.size) {
  console.error(`分题型：${[...counts].map(([k, v]) => `${k} ${v}`).join('  ')}`);
}
if (failures.length) {
  console.error(`失败明细在 ${FAIL_PATH}；重跑同一条命令会只补失败的题。`);
  writeFileSync(FAIL_PATH.replace(/\.jsonl$/, '.md'), failures.map((f) => `- ${f.code} (${f.ty}) ${f.error}`).join('\n'));
  process.exitCode = 1;
}
