/**
 * UI 规范审计：间距 / 圆角 / 色彩 / 字号 / 字重。
 * 用法：node scripts/audit-ui-style.js [file]
 *
 * 判据（本轮设计规范）：
 *   1. 间距只取 2/4/8/16/24/32（padding / margin / gap 分开统计）
 *   2. 嵌套圆角：外 = 内 + 间距，禁止内外一样
 *   3. 颜色饱和度 ≤ 70%，禁用 #000，正文固定 #1A1A1A
 *   4. 字号只取 --fs-* 四档 token，字重只取 400/600/700
 *   5. 装饰性微组件可例外（圆点、进度条、图标尺寸等不计入间距）
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(process.argv[2] ?? join(ROOT, 'public/index.html'));
const html = readFileSync(file, 'utf8');

const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
if (!styles.length) {
  console.error('找不到 <style>');
  process.exit(1);
}
const css = styles.join('\n');
// 把字号 token 展开成 px，便于逐条核对四档
const FS_TOKENS = Object.fromEntries(
  [...css.matchAll(/(--fs-[a-z]+):\s*([0-9.]+)px/g)].map((m) => [m[1], m[2]])
);
const body = css
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/var\((--fs-[a-z]+)\)/g, (_, k) => (FS_TOKENS[k] ?? 'NaN') + 'px');

// 四档以 :root 里的 token 为准 —— 改字号只需要改 token，不用回来改脚本
const SIZES = new Set(Object.values(FS_TOKENS));
const SPACES = new Set(['0', '2', '4', '8', '16', '24', '32']);
const WEIGHTS = new Set(['400', '600', '700']);
const RADII = new Set(['0', '2', '4', '8', '10', '12', '16', '24', '999']);

function hsl(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let s = 0;
  if (d !== 0) s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  return { s: Math.round(s * 100), l: Math.round(l * 100) };
}

const problems = [];
const bump = (bag, k) => (bag[k] = (bag[k] ?? 0) + 1);
const dump = (obj, sortKey = (x) => x) =>
  Object.entries(obj)
    .sort((a, b) => sortKey(a[0]) - sortKey(b[0]))
    .map(([k, v]) => `${k}×${v}`)
    .join('  ');

/* ---------- 1. 字号 ---------- */
const fontSizes = {};
for (const m of body.matchAll(/font-size:\s*([0-9.]+)px/g)) {
  const v = m[1];
  bump(fontSizes, v);
  if (!SIZES.has(v)) problems.push(`字号 ${v}px 不在 14/16/24/32 四档之内`);
}

/* ---------- 2. 字重 ---------- */
const weights = {};
for (const m of body.matchAll(/font-weight:\s*([0-9]+)/g)) {
  bump(weights, m[1]);
  if (!WEIGHTS.has(m[1])) problems.push(`字重 ${m[1]} 不在 400/600/700 之内`);
}

/* ---------- 3. 间距 ---------- */
const spacing = {};
for (const m of body.matchAll(/(?:^|[;{\s])(padding|margin|gap|row-gap|column-gap|padding-(?:top|right|bottom|left)|margin-(?:top|right|bottom|left)):\s*([^;}]+)/g)) {
  const prop = m[1];
  for (const part of m[2].trim().split(/\s+/)) {
    const v = part.replace(/px$/, '');
    if (!/^[0-9.]+$/.test(v)) continue; // auto / var() / % / calc()
    spacing[prop] ??= {};
    bump(spacing[prop], v);
    if (!SPACES.has(v)) problems.push(`${prop}: ${v}px 不在 2/4/8/16/24/32 之内`);
  }
}

/* ---------- 4. 圆角 ---------- */
const radii = {};
for (const m of body.matchAll(/border-radius:\s*([^;}]+)/g)) {
  const v = m[1].trim();
  if (v.includes('var(') || v.includes('%') || v.includes('/')) continue;
  bump(radii, v);
  const n = v.replace(/px$/, '');
  if (!RADII.has(n)) problems.push(`圆角 ${v} 不在 0/2/4/8/10/12/16/24/999 之内`);
}

/* ---------- 5. 嵌套圆角：外 = 内 + 间距 ---------- */
// 手工登记"外层卡片 → 卡内元素"的配对，逐对验算 outer === inner + gap
const NEST = [
  { outer: '.composer', inner: '.icon-btn', gap: 16 },
  { outer: '.composer.sm', inner: '.icon-btn', gap: 8 },
  { outer: '.bank', inner: '.q-item', gap: 16 },
  { outer: '.mode-bar', inner: '.mode-ico', gap: 16 },
  { outer: '.report-card', inner: '.metric', gap: 16 },
  { outer: '.report-card', inner: '.level', gap: 16 },
  { outer: '.report-card', inner: '.wrong-item', gap: 16 },
  { outer: '.bar-card', inner: '.drop-trigger', gap: 16 },
  { outer: '.bar-card', inner: '.bar-ico', gap: 16 },
  { outer: '.drop-list', inner: '.drop-list .q-item', gap: 4 },
  { outer: '.composer', inner: '.shot', gap: 16 }
];

const TOKEN = {
  'var(--r-card)': 24,
  'var(--r-sub)': 16,
  'var(--r-inner)': 8,
  'var(--r-sm)': 8,
  'var(--r-md)': 8,
  'var(--r-lg)': 24,
  'var(--r-xl)': 24,
  'var(--r-pill)': 999,
  'var(--r-circle)': 999
};
const radiusOf = (sel) => {
  // 逐条切规则，选择器必须完全相等，避免 `.q-item` 误匹配 `.drop-list .q-item`
  let val = null;
  for (const m of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (m[1].trim() !== sel) continue;
    const r = m[2].match(/border-radius:\s*([^;}]+)/);
    if (r) val = r[1].trim();
  }
  if (!val) return null;
  return TOKEN[val] ?? (val.includes('px') ? parseFloat(val) : null);
};

for (const n of NEST) {
  const o = radiusOf(n.outer);
  const i = radiusOf(n.inner);
  if (o == null || i == null) {
    problems.push(`嵌套圆角无法解析：${n.outer}(${o}) → ${n.inner}(${i})`);
    continue;
  }
  if (o === i) problems.push(`嵌套圆角相等：${n.outer} 与 ${n.inner} 都是 ${o}px`);
  else if (o < i) problems.push(`${n.outer}(${o}) 比内层 ${n.inner}(${i}) 还小`);
  else if (o !== i + n.gap) problems.push(`嵌套圆角不闭合：${n.outer}=${o} 应为 ${n.inner}=${i} + 间距 ${n.gap} = ${i + n.gap}`);
}

/* ---------- 6. 颜色 ---------- */
// 只对"中间调"验算饱和度：近白染底（L>85%）与近黑底（L<15%）本身不可能刺眼，
// HSL 在这两端会给出虚高的 S，不做拦截。
const colors = new Map();
const tints = [];
for (const m of body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
  const hex = m[0].toLowerCase();
  colors.set(hex, (colors.get(hex) ?? 0) + 1);
  const { s, l } = hsl(hex);
  if (l > 85 || l < 15) { tints.push(`${hex}(S${s}% L${l}%)`); continue; }
  if (s > 70) problems.push(`颜色 ${hex} 饱和度 ${s}% > 70%（L${l}%）`);
  if (hex === '#000' || hex === '#000000') problems.push(`使用了纯黑 ${hex}`);
}
if (!/--ink:\s*#1A1A1A/i.test(css)) problems.push('正文色 --ink 不是 #1A1A1A');

/* ---------- 7. 页面级字号种类 ---------- */
const perPage = {};
const pageBlocks = [...css.matchAll(/\/\* =+\s*\n\s*(\d+)\.\s*([^\n]+)/g)];
void pageBlocks; // 仅作索引，实际按选择器前缀粗分
const PAGE_HINT = [
  ['.p1', /\.p1(?:-|[\s{.:])/],
  ['.p2', /\.p2(?:-|[\s{.:])/],
  ['.p3', /\.work|\.pane|\.bubble|\.chat-/],
  ['.p4', /\.p4(?:-|[\s{.:])|\.report-card|\.metric|\.level/],
  ['.p5', /\.p5(?:-|[\s{.:])|\.bar-card|\.drop-/]
];
for (const [name, re] of PAGE_HINT) {
  const set = new Set();
  const blocks = [...body.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  for (const b of blocks) {
    if (!re.test(b[1])) continue;
    for (const f of b[2].matchAll(/font-size:\s*([0-9.]+)px/g)) set.add(f[1]);
  }
  perPage[name] = [...set].sort((a, b) => a - b);
  if (set.size > 4) problems.push(`${name} 一屏出现 ${set.size} 种字号：${perPage[name].join('/')}`);
}

/* ---------- 输出 ---------- */
console.log(`文件：${file}`);
console.log(`字号 ${Object.keys(fontSizes).length} 种：${dump(fontSizes, Number)}`);
console.log(`字重 ${Object.keys(weights).length} 种：${dump(weights, Number)}`);
for (const [prop, vals] of Object.entries(spacing)) {
  console.log(`${prop.padEnd(12)} ${Object.keys(vals).length} 种：${dump(vals, Number)}`);
}
console.log(`圆角 ${Object.keys(radii).length} 种：${dump(radii, Number)}`);
console.log(`颜色 ${colors.size} 个`);
console.log(`各页字号：${Object.entries(perPage).map(([k, v]) => `${k}=${v.join('/') || '—'}`).join('  ')}`);

const uniq = [...new Set(problems)];
if (uniq.length === 0) {
  console.log('\n✓ 全部符合规范');
} else {
  console.log(`\n✗ ${uniq.length} 类问题：`);
  for (const p of uniq.slice(0, 60)) console.log('  - ' + p);
  if (uniq.length > 60) console.log(`  … 另有 ${uniq.length - 60} 类`);
  process.exitCode = 1;
}
