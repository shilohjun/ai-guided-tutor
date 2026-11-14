#!/usr/bin/env node
/**
 * `keysteps.jsonl` → `src/core/qbank-keysteps.data.js`
 *
 * 为什么产物是大写常量的 JS 模块、而不是 JSON：
 * 这份数据要被 Node / Cloudflare Workers / 腾讯云函数三端同时 import，
 * 三边对 JSON 模块（import assertions）的支持不一致，而 JS 模块处处都能跑。
 * 同目录下的 qbank-graphs.data.js 也是这个理由。
 *
 * 用法：
 *   node scripts/build-keysteps-data.mjs
 *   node scripts/build-keysteps-data.mjs --dev-partial   # 开发期用已有题先验证接入
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QBANK_SOURCE } from '../src/core/qbank-source.data.js';
import { normalizeKeysteps } from '../src/core/keysteps.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

// 开发期可以先拿一部分数据验证接入，但产物必须能被一眼认出是半成品，
// 否则"只有一部分题的题库"会被当成完整数据带进发布。
const DEV_PARTIAL = process.argv.includes('--dev-partial');

const IN_PATH = resolve(ROOT, arg('--in', '.tmp-rag/keysteps.jsonl'));
const OUT_PATH = resolve(ROOT, arg('--out', 'src/core/qbank-keysteps.data.js'));

if (!existsSync(IN_PATH)) {
  console.error(`✗ 找不到 ${IN_PATH}。先跑 scripts/build-qbank-keysteps.mjs。`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 读 + 去重（同一题重跑过就取最后一条）
// ---------------------------------------------------------------------------

const byId = new Map();
for (const line of readFileSync(IN_PATH, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue; // 半截行
  }
  if (row?.i == null) continue;
  byId.set(Number(row.i), row);
}

// ---------------------------------------------------------------------------
// 校验：缺题、坏数据都要在这里拦住，别让它们变成"这道题没有路径"
// ---------------------------------------------------------------------------

const missing = [];
const invalid = [];
const data = {};

for (const q of QBANK_SOURCE) {
  const row = byId.get(Number(q.i));
  if (!row) {
    missing.push(q.code);
    continue;
  }
  try {
    // 再走一次归一化：保证落盘的是引擎真正能吃的东西（含末步补 conclude）
    const keysteps = normalizeKeysteps(row.keysteps);
    data[q.i] = keysteps.map((k) => ({
      title: k.title,
      type: k.type,
      judge: k.judge,
      why: k.why,
      do: k.do,
      expr: k.expr,
      cues: k.cues,
      concepts: k.concepts,
    }));
  } catch (err) {
    invalid.push(`${q.code}: ${err.message}`);
  }
}

const covered = Object.keys(data).length;
console.error(`覆盖 ${covered}/${QBANK_SOURCE.length} 题`);
if (invalid.length) {
  console.error(`\n✗ ${invalid.length} 题的关键点不合格：`);
  for (const line of invalid.slice(0, 20)) console.error(`  ${line}`);
}
if (missing.length) {
  console.error(`\n✗ 缺 ${missing.length} 题：${missing.slice(0, 20).join(' ')}${missing.length > 20 ? ' …' : ''}`);
}

if ((invalid.length || missing.length) && !DEV_PARTIAL) {
  console.error('\n补齐后再生成（重跑 build-qbank-keysteps.mjs 只补缺的题）。');
  process.exit(1);
}
if (DEV_PARTIAL && (invalid.length || missing.length)) {
  console.error('\n⚠ --dev-partial：只写了已有的题，产物是半成品，发布前必须全量重跑。');
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

const header = [
  '// 题库关键点链：每道题解完必须作出的关键判断，据官方解析编译。',
  '// 由 scripts/build-qbank-keysteps.mjs 生成，勿手改（改了下次重跑就没了）。',
  '// 字段：title 这道坎叫什么 / judge 要作出什么判断 / why 依据 / do 动作 / expr 关系式 /',
  '//       cues 学生口语说法（关键词定位通道的输入）/ concepts 物理概念名词。',
].concat(DEV_PARTIAL ? ['// ⚠ 半成品：--dev-partial 生成，缺题，禁止发布。'] : []).join('\n');

writeFileSync(OUT_PATH, `${header}\nexport const QBANK_KEYSTEPS = ${JSON.stringify(data)};\n`);

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const sizes = Object.values(data).map((k) => k.length);
const avg = (sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(1);
const bytes = readFileSync(OUT_PATH).length;

const perType = new Map();
for (const q of QBANK_SOURCE) {
  if (!data[q.i]) continue;
  const bucket = q.ty === '实验' ? '实验' : q.ty === '计算' ? '计算' : '选择';
  const acc = perType.get(bucket) ?? { n: 0, points: 0 };
  acc.n += 1;
  acc.points += data[q.i].length;
  perType.set(bucket, acc);
}

console.error(`\n✓ 写入 ${OUT_PATH}`);
console.error(`  体积 ${(bytes / 1024).toFixed(0)} KB，平均 ${avg} 点/题（最少 ${Math.min(...sizes)}，最多 ${Math.max(...sizes)}）`);
for (const [k, v] of perType) {
  console.error(`  ${k} ${v.n} 题，平均 ${(v.points / v.n).toFixed(1)} 点`);
}
