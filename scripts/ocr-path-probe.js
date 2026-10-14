/**
 * 题目识别 —— 路径探测（**零计费优先**）。
 *   node scripts/ocr-path-probe.js --appcode <AppCode> [--image <可选图片>]
 *
 * ============================================================================
 * 为什么要先探路径，而不是直接拿真图去试
 * ============================================================================
 * 题目识别按「成功调用次数」计费，额度有限。而"路径猜错"这件事
 * **不需要用真图去发现**：
 *
 *   · 路径不存在 ⇒ API 网关直接回 404，请求根本没进识别服务 ⇒ 不计费
 *     （实测：tysbgpu.market.alicloudapi.com/ocr/question 回 404、正文为空）
 *   · 路径存在但参数不对 ⇒ 返回结构化信封 + 业务错误码 ⇒ 能确认"路径对了"
 *
 * 所以本脚本第一轮全部用**故意不合法的参数**（空 base64），
 * 只在"哪条路径是对的"这件事上花网络请求，不花识别额度。
 * 确认路径后，再用第二小节的一次真实调用验收入口。
 *
 * 用法分两步：
 *   1) node scripts/ocr-path-probe.js --appcode <code>            # 零计费探路径
 *   2) node scripts/ocr-path-probe.js --appcode <code> --image x.jpg --confirm  # 一次真实调用
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const APPCODE = String(args.appcode ?? process.env.ALIYUN_OCR_APPCODE ?? '').trim();
const HOST = 'https://tysbgpu.market.alicloudapi.com';

if (!APPCODE) {
  console.error('缺少 AppCode：node scripts/ocr-path-probe.js --appcode <code>');
  process.exit(2);
}

/**
 * 候选路径。
 *
 * 排序依据（都是外部证据，不是拍脑袋）：
 *   ① 阿里云开发者社区里给出的真实可用地址是
 *      `https://tysbgpu.market.alicloudapi.com/api/predict/ocr_general`
 *      —— 说明该商品的路径族是 `/api/predict/ocr_*`；
 *   ② 题目识别的官方 Action 名是 RecognizeEduQuestionOcr，
 *      云市场商品常把 Action 转成小写短名，于是有 ocr_eduquestion / ocr_question 两种可能；
 *   ③ 我第一轮探测已确认 `/ocr/question` 不存在（404）。
 */
const CANDIDATE_PATHS = [
  '/api/predict/ocr_eduquestion',
  '/api/predict/ocr_question',
  '/api/predict/ocr_edu_question',
  '/api/predict/ocr_question_recognize',
  '/api/predict/ocr_paper_question',
];

/** 故意不合法的值：空 base64。目的只是"把请求送到识别服务门口看它认不认这条路径"。 */
const INVALID_IMAGE = 'data:image/jpeg;base64,';

async function call(path, imageValue, timeoutMs = 20000) {
  const body = new URLSearchParams();
  body.set('image_base64', imageValue);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${HOST}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `APPCODE ${APPCODE}`,
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: body.toString(),
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

function digest(r) {
  if (r.status === 0) return `网络失败：${r.raw.slice(0, 80)}`;
  if (r.status === 404) return '404 —— 网关层就没有这条路径（未进识别服务，不计费）';
  if (r.status === 401 || r.status === 403) {
    return `${r.status} —— 鉴权被拒（AppCode 无效，或该商品未包含这条路径）`;
  }
  if (!r.json) return `${r.status}，非 JSON 正文：${r.raw.slice(0, 120).replace(/\s+/g, ' ')}`;
  const sys = r.json.showapi_res_code ?? r.json.code ?? r.json.status;
  const body = r.json.showapi_res_body ?? r.json.data ?? {};
  const ret = body.ret_code ?? r.json.ret_code;
  const keys = Object.keys(body).slice(0, 8).join(',');
  return `${r.status} 系统码=${sys ?? '-'} 业务码=${ret ?? '-'} 字段=[${keys}]${body.remark ? ` remark=${String(body.remark).slice(0, 60)}` : ''}`;
}

// ---------------------------------------------------------------------------
// 第一轮：零计费探路径
// ---------------------------------------------------------------------------

console.log('\n══ 第一轮：用不合法参数探路径（网关 404 不计费）══\n');

let foundPath = null;
const results = [];

for (const p of CANDIDATE_PATHS) {
  const r = await call(p, INVALID_IMAGE);
  const line = digest(r);
  results.push({ path: p, status: r.status, line, json: r.json });
  console.log(`  ${p}\n    → ${line}\n`);

  // 404 = 这条路径不存在；其它任何状态码都说明"路径被网关认了"
  if (r.status !== 404 && r.status !== 0 && !foundPath) {
    foundPath = p;
  }
}

if (!foundPath) {
  console.log('⚠️  候选路径全部 404。需要从控制台的「API 接口」栏拿到确切地址。');
  console.log('    获取方法：云市场买家控制台 → 已购服务 → 该商品 → API 接口 → 请求地址。');
  process.exit(0);
}

console.log(`✅ 路径命中：${foundPath}`);
console.log(`   把它写进 .env：ALIYUN_OCR_ENDPOINT=${HOST}${foundPath}\n`);

const hit = results.find((r) => r.path === foundPath);
if (hit?.json) {
  console.log('   返回信封结构（照此写解析规则）：');
  console.log(`   ${JSON.stringify(hit.json).slice(0, 500)}\n`);
}

// ---------------------------------------------------------------------------
// 第二轮：一次真实调用（只有显式 --confirm 且给了图才做）
// ---------------------------------------------------------------------------

if (String(args.confirm ?? '') !== 'true' || !args.image) {
  console.log('─'.repeat(70));
  console.log('第一轮完成，**未产生识别调用**。');
  console.log('要验收入口，再执行（会真实计费 1 次）：');
  console.log(`  node scripts/ocr-path-probe.js --appcode <code> --image .\\样题.jpg --confirm\n`);
  process.exit(0);
}

const imgPath = String(args.image);
if (!existsSync(imgPath)) {
  console.error(`图片不存在：${imgPath}`);
  process.exit(2);
}
const buf = readFileSync(imgPath);
const ext = extname(imgPath).toLowerCase().replace('.', '') || 'jpeg';
const dataUrl = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`;

console.log('─'.repeat(70));
console.log(`\n══ 第二轮：真实调用 1 次 ══`);
console.log(`   图片：${imgPath}（${(statSync(imgPath).size / 1024).toFixed(0)} KB）`);
console.log(`   计数：这是第 1 次真实识别调用（成功则计费）。\n`);

const real = await call(foundPath, dataUrl, 40000);
console.log(`   HTTP ${real.status}`);
if (real.json) {
  console.log(`   ${JSON.stringify(real.json).slice(0, 1200)}\n`);
  const body = real.json.showapi_res_body ?? {};
  const text = body.content ?? body.str ?? body.text ?? null;
  if (typeof text === 'string' && text.trim()) {
    console.log('   ✅ 取到题干文本：');
    console.log('   ─────────────────────────────────────');
    console.log(text.trim().split('\n').map((l) => `   ${l}`).join('\n'));
    console.log('   ─────────────────────────────────────');
  } else {
    console.log('   ⚠️ 返回成功标记但没有文本，检查字段名是否与 textKeys 候选一致。');
  }
} else {
  console.log(`   正文：${real.raw.slice(0, 300)}`);
}
console.log('');
