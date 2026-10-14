/**
 * 题目识别 —— 首次真实验收（**只花 1 次识别调用**）。
 *   node scripts/ocr-verify.js --appcode <code> --image <图片路径>
 *
 * ============================================================================
 * 为什么单独写一个脚本，而不是直接用 /api/ocr
 * ============================================================================
 * 首次真实调用要一次拿到三件事，否则等于白花这次调用：
 *   ① 响应信封的确切结构（字段名是什么 —— 决定后续解析规则）
 *   ② img 字段是否**确实**要纯 base64（契约原文只说"base64编码"，
 *      而带不带 data: 前缀在真实系统里两种都有，且用错就是一次白花的调用）
 *   ③ 识别质量的第一印象（这是产品判断，不是技术判断）
 *
 * 所以本脚本：先用**一次不带图片的请求**零成本确认②（缺参数必然报错，
 * 报错信息会说明它期望什么），再花 1 次真实调用把①③拿到手。
 *
 * 硬约束：本脚本对"真实识别"只发一次请求，不做任何重试。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const APPCODE = String(args.appcode ?? process.env.ALIYUN_OCR_APPCODE ?? '').trim();
const IMAGE = String(args.image ?? '').trim();
const URL = 'https://mquestion.market.alicloudapi.com/ocrservice/mathQuestion';

if (!APPCODE || !IMAGE) {
  console.error('用法：node scripts/ocr-verify.js --appcode <code> --image <图片路径>');
  process.exit(2);
}
if (!existsSync(IMAGE)) {
  console.error(`图片不存在：${IMAGE}`);
  process.exit(2);
}

const HEADERS = {
  Authorization: `APPCODE ${APPCODE}`,
  'Content-Type': 'application/json; charset=UTF-8',
};

async function post(payload, timeoutMs = 40000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await res.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, json, raw };
  } catch (err) {
    return { status: 0, json: null, raw: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

const bytes = statSync(IMAGE).size;
const ext = extname(IMAGE).toLowerCase().replace('.', '') || 'jpeg';
const base64 = readFileSync(IMAGE).toString('base64');
const base64Size = Buffer.byteLength(base64, 'utf8');

console.log('\n══ 步骤 0：参数与体积自检（零调用）══');
console.log(`  图片：${IMAGE}`);
console.log(`  原始：${(bytes / 1024).toFixed(0)} KB    base64 后：${(base64Size / 1024 / 1024).toFixed(2)} MB`);
console.log(`  格式：${ext}`);
if (base64Size > 4 * 1024 * 1024) {
  console.error('\n  ✗ base64 后超过 4M 上限，必须先压缩。中止（不浪费调用）。');
  process.exit(1);
}
console.log('  ✓ 体积在上限内');

// ---------------------------------------------------------------------------
// 步骤 1：零成本确认 img 字段的期望形态
// ---------------------------------------------------------------------------

console.log('\n══ 步骤 1：确认契约（零成本 —— 故意传不带图片的请求，必然被拒）══');

const probe = await post({ img: '', prob: false, rotate: false });
console.log(`  HTTP ${probe.status}`);
if (probe.json) {
  console.log(`  返回：${JSON.stringify(probe.json).slice(0, 400)}`);
} else {
  console.log(`  正文：${probe.raw.slice(0, 200).replace(/\s+/g, ' ')}`);
}
console.log('  → 这一步不产生成功识别，不计费；它只是把"参数错"与"图片错"分开。');

// ---------------------------------------------------------------------------
// 步骤 2：唯一一次真实识别调用
// ---------------------------------------------------------------------------

console.log('\n══ 步骤 2：真实识别（第 1 次，也是本次唯一一次计费调用）══');

const t0 = Date.now();
const real = await post({ img: base64, prob: false, rotate: false });
const ms = Date.now() - t0;

console.log(`  HTTP ${real.status}   耗时 ${ms} ms\n`);

if (!real.json) {
  console.log(`  正文：${real.raw.slice(0, 500)}`);
  console.log('\n  ✗ 非 JSON 响应。把上面这段贴给我。');
  process.exit(1);
}

console.log('  ── 完整响应结构 ──');
console.log(`  ${JSON.stringify(real.json, null, 2).slice(0, 2500)}`);

/** 递归找出所有"像题干"的字符串，用来确定文本到底在哪个字段 */
function findText(value, depth = 0, trail = '') {
  if (depth > 6 || value == null) return [];
  if (typeof value === 'string') {
    const han = (value.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    return value.trim().length >= 8 && han >= 4 ? [{ path: trail || '(root)', text: value }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => findText(v, depth + 1, `${trail}[${i}]`)).slice(0, 6);
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => findText(v, depth + 1, trail ? `${trail}.${k}` : k)).slice(0, 6);
  }
  return [];
}

const found = findText(real.json);
console.log('\n  ── 判定 ──');
if (found.length) {
  console.log(`  ✅ 识别成功。文本位于字段：${found.map((f) => f.path).join(' / ')}`);
  console.log('\n  ── 识别出的题干（前 800 字）──');
  console.log('  ┌' + '─'.repeat(66));
  console.log(
    found[0].text
      .slice(0, 800)
      .split('\n')
      .map((l) => `  │ ${l}`)
      .join('\n'),
  );
  console.log('  └' + '─'.repeat(66));
  console.log('\n  请人工判断两件事（这才是验收，不是脚本能替你判断的）：');
  console.log('   1) 数值、单位、上下标有没有丢或错？');
  console.log('   2) 公式是怎么表达的（LaTeX？还是被拍平成自然语言）？');
} else {
  console.log('  ⚠️ 拿到响应但没找到像题干的文本 —— 把上面完整响应贴给我。');
}
console.log('');
