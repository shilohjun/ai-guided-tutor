/**
 * 云市场题目 OCR 接入探测脚本（一次性诊断工具）。
 *   node scripts/ocr-probe.js --appcode <你的AppCode> --image <图片路径或URL>
 *
 * ============================================================================
 * 为什么需要这个脚本，而不是直接写适配器
 * ============================================================================
 * 买的是**云市场 API 网关**商品（cmapi00043052），不是阿里云官方 OCR 的 POP 接口：
 *   官方接口：Product=ocr-api，Action=RecognizeEduQuestionOcr，AK/SK + V3 签名
 *   云市场接口：网关域名 + AppCode 简单认证，参数名与返回结构由服务商定义
 *
 * 云市场商品页是前端渲染的，文档正文抓不到 —— 也就是说，
 * **在真正调一次之前，参数名与返回字段名是无法从公开渠道确认的**。
 * 与其猜一套写进适配器（错了会表现为"识别不出东西"或"参数错误"，
 * 与代码 bug 表现相似，白排查半天），不如先用最小代价把真实契约问出来：
 * 最多打 N 次（默认 8 次，成功即停），把命中的请求形状与返回信封打印出来。
 *
 * 拿到结果后，把它固化成 src/core/ocr.js 里的一张配置表，这个脚本就功成身退。
 *
 * 注意：
 *   · 每次调用**会计费/扣次数**（云市场按调用次数计），所以默认 8 次上限、成功即停。
 *   · AppCode 只从命令行或环境变量读，**不写进任何文件、不落日志**。
 *   · 本脚本不动项目里的任何代码，也不写入工作区。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { limit: 8, timeoutMs: 30000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[key] = val;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const APPCODE = String(args.appcode ?? process.env.ALIYUN_OCR_APPCODE ?? '').trim();
const IMAGE = String(args.image ?? '').trim();
const LIMIT = Math.max(1, Number(args.limit ?? 8));
const TIMEOUT_MS = Number(args.timeoutMs ?? 30000);

if (!APPCODE) {
  console.error('缺少 AppCode。用法：node scripts/ocr-probe.js --appcode <AppCode> --image <图片路径或URL>');
  process.exit(2);
}
if (!IMAGE) {
  console.error('缺少图片。用法：--image ./样题.jpg  或  --image https://.../a.png');
  process.exit(2);
}

/** 图片：本地文件转 dataURL；http(s) 直接当 URL 用 */
function loadImage(input) {
  if (/^https?:\/\//i.test(input)) return { kind: 'url', url: input };
  if (!existsSync(input)) throw new Error(`图片不存在：${input}`);
  const buf = readFileSync(input);
  const size = statSync(input).size;
  const ext = extname(input).toLowerCase().replace('.', '') || 'jpeg';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return {
    kind: 'file',
    size,
    bytes: buf,
    dataUrl: `data:image/${mime};base64,${buf.toString('base64')}`,
    bare: buf.toString('base64'),
  };
}

let image;
try {
  image = loadImage(IMAGE);
} catch (err) {
  console.error(`\n${err.message}\n用法：node scripts/ocr-probe.js --appcode <AppCode> --image <本地图片路径或https图片URL>\n`);
  process.exit(2);
}
if (image.kind === 'file') {
  console.log(`\n图片：${IMAGE}  ${(image.size / 1024).toFixed(0)} KB`);
  /**
   * 云市场网关普遍用表单提交，base64 走表单字段。
   * 多数服务商的上限在 0.7MB ~ 2MB 之间（见文档里"文件内容过大"这类错误码），
   * 这里只做提示不做拦截 —— 真正的大小上限要靠实测错误码确认。
   */
  if (image.size > 700 * 1024) {
    console.log('  ⚠️ 超过 700KB：若返回"文件内容过大"，请先压缩（前端应压到长边 ~1600px）');
  }
}

// ---------------------------------------------------------------------------
// 候选请求形状
// ---------------------------------------------------------------------------

/**
 * 每个候选 = 一种"可能是对的"调用方式。
 * 命中判据：HTTP 2xx 且能从返回里抽出一段像题干的中文文本。
 *
 * 域名候选 3 个 × 参数名候选若干 —— 但**不是笛卡尔积**：
 * 先按最可能的组合排好序，成功即停，避免把调用次数浪费在排列组合上。
 */
const HOSTS = [
  'https://tysbgpu.market.alicloudapi.com',   // 云市场题目/试卷 OCR 类接口常见前缀
  'https://ocrapi-advanced.taobao.com',       // 通用文字识别类常见前缀
  'https://token.market.alicloudapi.com',     // 另一类云市场 AI 接口前缀（qSlove 等）
];

const PATHS = ['/ocr/question', '/api/predict/ocr_question', '/question', '/api/ocr/question'];

/** 参数名候选：不同服务商命名不同，这些是教育/OCR 类接口里出现过的写法 */
const PARAM_NAMES = ['image_base64', 'img_base64', 'pic_base64', 'image', 'body'];

/** 构建候选列表（有序，最可能的在前） */
function buildCandidates() {
  const list = [];

  const push = (label, make) => list.push({ label, make });

  for (const host of HOSTS) {
    for (const path of PATHS) {
      for (const pname of PARAM_NAMES) {
        push(`POST ${host}${path} 表单[${pname}] 头鉴权`, () => {
          const body = new URLSearchParams();
          body.set(pname, image.kind === 'file' ? image.dataUrl : image.url);
          return {
            url: `${host}${path}`,
            headers: {
              Authorization: `APPCODE ${APPCODE}`,
              'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
            body: body.toString(),
          };
        });
      }
    }
  }

  /** 形态二：AppCode 放 Query（网关两种都支持，见官方文档） */
  push('POST AppCode 放 Query（tysbgpu + /ocr/question + image_base64）', () => {
    const body = new URLSearchParams();
    body.set('image_base64', image.kind === 'file' ? image.dataUrl : image.url);
    return {
      url: `${HOSTS[0]}/ocr/question?AppCode=${encodeURIComponent(APPCODE)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    };
  });

  /** 形态三：只传图片 URL（有些接口只收 url） */
  push('POST tysbgpu + /ocr/question 表单[url]', () => ({
    url: `${HOSTS[0]}/ocr/question`,
    headers: {
      Authorization: `APPCODE ${APPCODE}`,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: new URLSearchParams({ url: image.kind === 'file' ? '' : image.url }).toString(),
  }));

  return list;
}

// ---------------------------------------------------------------------------
// 返回解析
// ---------------------------------------------------------------------------

/** 已知的"文本就在这里"的字段名（按可能性排序） */
const TEXT_KEYS = ['content', 'str', 'text', 'result', 'question', 'questionText', 'question_text', 'words', 'data'];

/**
 * 从任意 JSON 结构里挖出最可能是题干的字符串。
 * 判据：含中文、长度 ≥ 8 —— 与项目 intake 的 MIN_STEM_LENGTH 对齐。
 */
function extractText(value, depth = 0, trail = '') {
  if (depth > 6 || value == null) return [];
  if (typeof value === 'string') {
    const s = value.trim();
    const han = (s.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    if (s.length >= 8 && han >= 4) return [{ path: trail || '(root)', text: s }];
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => extractText(v, depth + 1, `${trail}[${i}]`)).slice(0, 3);
  }
  if (typeof value === 'object') {
    const out = [];
    // 先按已知字段名找，再兜底遍历
    for (const k of TEXT_KEYS) {
      if (k in value) out.push(...extractText(value[k], depth + 1, trail ? `${trail}.${k}` : k));
    }
    for (const [k, v] of Object.entries(value)) {
      if (TEXT_KEYS.includes(k)) continue;
      out.push(...extractText(v, depth + 1, trail ? `${trail}.${k}` : k));
    }
    return out.slice(0, 5);
  }
  return [];
}

/** 识别返回信封：云市场/ShowAPI 风格 vs 直给 JSON */
function describeEnvelope(json) {
  const notes = [];
  if (json.showapi_res_code !== undefined) {
    notes.push(`showapi 信封：showapi_res_code=${json.showapi_res_code} error=${JSON.stringify(json.showapi_res_error ?? '')}`);
    const b = json.showapi_res_body ?? {};
    if (b.ret_code !== undefined) notes.push(`业务码 ret_code=${b.ret_code} remark=${JSON.stringify(b.remark ?? '')}`);
  }
  if (json.code !== undefined) notes.push(`code=${json.code} message=${JSON.stringify(json.message ?? json.msg ?? '')}`);
  if (json.error !== undefined) notes.push(`error=${JSON.stringify(json.error)}`);
  if (json.success !== undefined) notes.push(`success=${json.success}`);
  return notes;
}

/** 只打印结构，不打印整段 base64 */
function shapeOf(value, depth = 0) {
  if (value == null) return String(value);
  if (Array.isArray(value)) return depth > 3 ? '[…]' : `[${value.length ? shapeOf(value[0], depth + 1) : ''}]`;
  if (typeof value === 'object') {
    if (depth > 3) return '{…}';
    return `{${Object.entries(value).slice(0, 25).map(([k, v]) => `${k}: ${shapeOf(v, depth + 1)}`).join(', ')}}`;
  }
  if (typeof value === 'string') return value.length > 60 ? `string(${value.length})` : JSON.stringify(value);
  return `${typeof value}(${value})`;
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

const candidates = buildCandidates();
console.log(`\n候选形状共 ${candidates.length} 个，本次最多尝试 ${LIMIT} 次（成功即停）\n`);

let attempts = 0;
let hit = null;

for (const [i, cand] of candidates.entries()) {
  if (attempts >= LIMIT) break;
  attempts += 1;

  const { url, headers, body } = cand.make();
  const shown = url.replace(APPCODE, 'APPCODE***');
  process.stdout.write(`[${attempts}/${LIMIT}] ${cand.label}\n     ${shown}\n`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    const raw = await res.text();
    clearTimeout(timer);

    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* 非 JSON，下面按文本处理 */
    }

    console.log(`     HTTP ${res.status}${res.headers.get('content-type') ? `  ${res.headers.get('content-type')}` : ''}`);

    if (json) {
      for (const n of describeEnvelope(json)) console.log(`     · ${n}`);
      console.log(`     结构：${shapeOf(json).slice(0, 400)}`);

      const found = extractText(json);
      if (res.ok && found.length) {
        const hitUrl = url.replace(APPCODE, '<APPCODE>');
        const paramNames = [...new URLSearchParams(body).keys()];
        hit = { cand, hitUrl, paramNames, json, found };
        console.log(`     ✅ 命中：文本位于 ${found.map((f) => f.path).join(' / ')}`);
        console.log(`     片段：${found[0].text.slice(0, 120).replace(/\n/g, ' ⏎ ')}`);
        console.log('');
        break;
      }
    } else {
      const snippet = raw.slice(0, 200).replace(/\s+/g, ' ');
      console.log(`     正文：${snippet || '(空)'}`);
      // 网关的鉴权/限流错误在非 JSON 时也会带关键词
      if (/Invalid|Unauthorized|Forbidden|APPCODE|appcode/i.test(raw)) {
        console.log('     · 看起来是**鉴权或网关层**的拒绝，不是参数问题');
      }
    }
  } catch (err) {
    clearTimeout(timer);
    console.log(`     失败：${err?.name === 'AbortError' ? '超时' : err.message}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// 结论
// ---------------------------------------------------------------------------

console.log('─'.repeat(70));
if (hit) {
  console.log('\n✅ 找到可用调用形状。把下面这段贴给我，我据此写 src/core/ocr.js：\n');
  console.log(`  请求：POST ${hit.hitUrl}`);
  console.log(`  参数名：${hit.paramNames.join(', ')}`);
  console.log(`  鉴权：${hit.cand.label.includes('Query') ? 'AppCode 放 Query' : 'Authorization: APPCODE <code>（Header）'}`);
  console.log(`  文本路径：${hit.found.map((f) => f.path).join(' / ')}`);
  console.log(`  信封结构：${shapeOf(hit.json).slice(0, 600)}`);
  console.log('\n  另请确认：这个形状是否**扣了调用次数**（云市场按次计费）。');
} else {
  if (attempts >= LIMIT) {
    console.log(`\n⏹  已用完 ${LIMIT} 次调用上限（可用 --limit 调整，但会消耗调用次数）。`);
  }
  console.log('\n⚠️ 未命中。最省事的下一步不是继续盲试，而是拿到接口文档：');
  console.log('   云市场买家控制台 → 已购服务/我的服务 → 该商品的「接口文档」页，');
  console.log('   把**接口地址、请求参数表（名称/类型/必填）、返回参数表**三块贴给我。');
  console.log('   如果买的是 ShowAPI（万维易源）那套，接口地址形如 https://route.showapi.com/<编号>-<接入点>?appKey=…，');
  console.log('   参数通常是 img_base64 / img_url，返回在 showapi_res_body.str。');
}
console.log('');
