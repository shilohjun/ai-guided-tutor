/**
 * 拍题 OCR 适配层 —— 「图像 → 题干文本」。
 *
 * ============================================================================
 * 它在整条链路里的位置
 * ============================================================================
 *   学生拍照 ──► 【本模块】 ──► 题干文本 ──► /api/problem/import ──► 结构化题目
 *                    ↑                                    ↑
 *              唯一的成本点                          已经有、且一行不改
 *
 * 也就是说：本模块**只负责一件事** —— 把一张图变成一段文字。
 * 它不建档、不解析、不决定给学生的提示。读题那一步复用现成链路
 * （intake.js 的 understandProblem），因此这里的产出只要"是一段题干原文"就够了。
 *
 * ============================================================================
 * 三条设计红线
 * ============================================================================
 * ① **按次计费，所以一次调用要尽量成事。**
 *    云市场/官方 OCR 都是**按成功调用次数**计费（题目识别约 0.083 元/次）。
 *    这意味着两件事：
 *      · 错误不能靠"换个参数重试"来兜 —— 重试就是再花钱；
 *      · 识别失败时**不要自动重试**，要把原因如实告诉学生，让他自己决定。
 *    所以 retry 的默认值是 0，且只有"网络层失败"（根本没到服务端）才允许重试。
 *    区分判据：HTTP 请求根本没发出去 / 连接断了 ⇒ 未计费，可重试；
 *    拿到了 HTTP 响应 ⇒ 无论成败都可能已计费，不重试。
 *
 * ② **绝不伪造识别结果。**
 *    没配 AppCode ⇒ 明确返回"未配置"，前端照旧提示用文字入口。
 *    这条与项目既有原则一致：Demo 页至今写着"这一环还没接，我也没有伪造它的结果"，
 *    接上之后这句话要变成真的，而不是把假结果填进去。
 *
 * ③ **契约配置化，而不是把猜测写死。**
 *    云市场商品的接口地址与参数名由服务商定义（服务商不同、商品不同都可能不一样），
 *    而商品页的「API接口」栏是前端渲染的图片，抓不到正文。
 *    所以地址与参数名放在 PROVIDERS 里，可用环境变量覆盖 ——
 *    实测确认后改一行即可，不用重写逻辑。
 */

import { clip } from './text.js';

// ---------------------------------------------------------------------------
// 契约表：调用形状
// ---------------------------------------------------------------------------

/** 阿里云 OCR 在云市场官方店铺的接口域名（tysbgpu 为通用 OCR 类商品的网关前缀） */
const MARKET_HOST = 'https://tysbgpu.market.alicloudapi.com';

/**
 * 支持的通道。
 *
 * ============================================================================
 * marketplace 的契约是**实测拿到的**，不是猜的（重要）
 * ============================================================================
 * 商品页「API 接口」栏给出的确切契约：
 *   调用地址：https://mquestion.market.alicloudapi.com/ocrservice/mathQuestion
 *   请求方式：POST       返回：JSON
 *   认证：Authorization: APPCODE <code>
 *   Content-Type: application/json; charset=UTF-8     ← 是 JSON，不是表单！
 *   请求体：
 *     { "img": "", "url": "", "prob": false, "rotate": false }
 *
 * 三个与"常见做法"相反、写错就必然失败的细节：
 *   ① **JSON 而不是 form-urlencoded。** 云市场多数接口是表单，
 *      这一个偏偏是 JSON —— 用表单提交会得到一个参数错误的响应。
 *   ② **图片字段名是 `img`，而且值必须是纯 base64，不能带 `data:image/jpeg;base64,` 前缀。**
 *      云市场另一类接口（如 ShowAPI 系）要求带前缀，两者正好相反。
 *   ③ `img` 与 `url` **只能存在一个**，都传会报错。
 *
 * 图片限制（来自同一份契约）：
 *    base64 编码后 ≤ 4M；最短边 ≥ 15px；最长边 ≤ 4096px；支持 jpg / png / bmp。
 *    注意"最长边 4096"与前端压缩目标（长边 1600）不冲突，但反过来说明
 *    **前端不要压得太狠** —— 公式里的上下标很小，压过头会直接丢。
 *
 * 域名说明：mquestion 是题目识别专用域名。
 * 这也解释了为什么在 tysbgpu 上试的所有路径都是 404 —— 它们根本不在这台网关上。
 */
const PROVIDERS = {
  marketplace: {
    label: '云市场·题目识别（AppCode）',
    auth: 'appcode',
    /** 确切调用地址（可由 ALIYUN_OCR_ENDPOINT 覆盖） */
    paths: ['https://mquestion.market.alicloudapi.com/ocrservice/mathQuestion'],
    /** 请求体格式：'json' | 'form' */
    bodyFormat: 'json',
    /** 图片字段名 */
    imageFields: ['img'],
    /** 图片值形态：false = 纯 base64（不带 dataURL 前缀） */
    dataUrlPrefix: false,
    /**
     * 附加参数。两个都显式传 false：
     *   prob   不需要每行置信度（我们只要整段题干，置信度对学生没有意义）
     *   rotate 不需要自动旋转 —— 前端已经按 EXIF 方向解码过，
     *          再让服务端转一次可能反而转错
     */
    extraParams: { prob: false, rotate: false },
    /**
     * 返回信封的文本字段（按可能性排序）。
     * `content` 排在第一位是**实测确认的** —— 见下方 parseOcrResponse 的说明。
     */
    textKeys: ['content', 'str', 'text', 'result', 'question', 'questionText', 'data'],
    /** 云市场：无需开通，买资源包即可调用 */
    needsActivation: false,
  },

  /**
   * 阿里云官方 POP 接口（AK/SK + V3 签名）。
   *
   * 为什么即使不用也要留着这一项：
   *   官方通道**每月赠送 200 次**题目识别的免费额度（当月生效、过期作废），
   *   而云市场渠道不含免费额度、也没有按量付费托底。
   *   也就是说：短期用云市场（接入省事），长期该切官方（每月白送 200 次）。
   *   把它登记在这里，切换只需要改一个环境变量，而不是重写一个适配器。
   *
   * 注意：本文件**不实现** V3 签名。签名有 60~80 行且必须逐字节正确，
   * 在真正需要走官方通道时单独实现（见 docs/06 的说明），
   * 现在放一个明确的"未实现"比放一个不能用的实现诚实。
   */
  official: {
    label: '阿里云官方 OCR（AK/SK 签名）',
    auth: 'ak-sk-v3',
    implemented: false,
    needsActivation: true,
  },
};

/** 业务错误码 → 给学生的人话。云市场这类接口普遍用 10~90 十档错误码。 */
const BUSINESS_ERRORS = {
  10: '请求参数有问题，这次没能识别（这是服务端返回的，不是你的照片的问题）',
  20: '图片格式不支持，请换 JPG 或 PNG 重试',
  30: '同一张图请勿重复提交，稍等一下再试',
  40: '服务端下载图片失败，若是网络图片请换成本地上传',
  50: '图片太大了，请压缩后重试（建议长边不超过 1600 像素）',
  60: '图片解析失败，可能是分辨率过高或文件损坏',
  70: '没有识别到题目文字 —— 可能是照片太模糊、光线太暗，或者不是题目',
  80: '识别服务超时，稍后重试',
  90: '识别服务异常，稍后重试',
};

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/**
 * 读 OCR 配置。
 *
 * 与 llm.js 的 readLLMConfig 同构：**没配就返回 available:false，绝不抛错**。
 * 理由是同一个 —— 这个 PoC 要能"clone 下来直接跑"，
 * 缺一个可选能力的凭据不应该让整个服务起不来。
 */
export function readOcrConfig(env = process.env) {
  const appCode = String(env.ALIYUN_OCR_APPCODE ?? '').trim();
  const providerName = String(env.ALIYUN_OCR_PROVIDER ?? 'marketplace').trim() || 'marketplace';
  const provider = PROVIDERS[providerName] ?? PROVIDERS.marketplace;

  const endpoint = String(env.ALIYUN_OCR_ENDPOINT ?? '').trim();
  const imageField = String(env.ALIYUN_OCR_IMAGE_FIELD ?? '').trim();
  /** 超时：拍题图通常 1MB 以内，官方建议 30s；给足但不无限等 */
  const timeoutMs = Number(env.ALIYUN_OCR_TIMEOUT_MS || 30000);
  /** 默认 0 次重试 —— 按次计费，重试就是再花钱（见文件头红线 ①） */
  const retries = Math.max(0, Math.min(2, Number(env.ALIYUN_OCR_RETRIES ?? 0)));

  /**
   * 可用性判据：**只要配了 AppCode 就算可用**。
   * 地址缺失不算"不可用"，而是走候选数组去发现 —— 否则第一次部署会
   * 因为"还没确认地址"而整体降级，白白浪费一次实测机会。
   */
  const available = provider.auth === 'appcode' ? Boolean(appCode) : false;

  return {
    provider: providerName,
    providerLabel: provider.label,
    providerSpec: provider,
    appCode,
    endpoint,
    imageField,
    timeoutMs,
    retries,
    available,
    /** 未实现通道的显式说明（不静默降级成"没配"，那会让人误以为配了就能用） */
    unimplemented: provider.implemented === false,
  };
}

/** 启动日志/健康检查用：只报形态，永不回传 AppCode 本身 */
export function ocrStatus(env = process.env) {
  const c = readOcrConfig(env);
  return {
    configured: c.available,
    provider: c.provider,
    providerLabel: c.providerLabel,
    endpoint: c.endpoint || null,
    hint: c.unimplemented
      ? '该通道尚未实现（需要 AK/SK 签名）'
      : c.available
        ? '可用'
        : '未配置 ALIYUN_OCR_APPCODE —— 拍照识题不可用（不影响文字导入）',
  };
}

// ---------------------------------------------------------------------------
// 调用形状解析
// ---------------------------------------------------------------------------

/**
 * 把配置解析成一次具体调用。
 *
 * `attempt` 用于在候选之间轮换（第一次调用试第 0 个，失败试第 1 个……）。
 * 一旦某个候选成功，调用方会把它记进 resolved 缓存，后续不再轮换。
 */
export function resolveCallShape(config, attempt = 0) {
  const spec = config.providerSpec;

  /**
   * 已验证过的形状优先级最高。
   * 它由调用方（router）从进程缓存里带进来 —— 一旦命中过，就不再轮换候选。
   */
  if (config.shape?.url && config.shape?.imageField) {
    return { url: config.shape.url, imageField: config.shape.imageField, spec };
  }

  const paths = config.endpoint ? [config.endpoint] : spec.paths ?? [];
  const imageFields = config.imageField ? [config.imageField] : spec.imageFields ?? [];

  const path = paths[Math.min(attempt, paths.length - 1)];
  const imageField = imageFields[Math.min(attempt, imageFields.length - 1)];
  if (!path || !imageField) return null;

  const url = /^https?:\/\//i.test(path) ? path : `${MARKET_HOST}${path}`;
  return { url, imageField, spec };
}

/**
 * 构造请求体。
 *
 * 两种格式必须都支持，因为云市场商品**两种都有**：
 *   · marketplace（题目识别）：JSON —— `{"img": "<纯base64>", "prob": false, ...}`
 *   · ShowAPI 系接口：表单 —— `img_base64=<base64>`
 * 用错格式的后果是"参数错误"，而那次调用可能已经计费 —— 所以格式来自契约表，不靠猜。
 *
 * @param {string} imageField 图片字段名
 * @param {string} imageValue 已归一化的图片值（是否带 dataURL 前缀由 spec.dataUrlPrefix 决定）
 * @param {object} spec 通道契约
 */
export function buildRequestBody(imageField, imageValue, spec, extra = {}) {
  const merged = { ...(spec.extraParams ?? {}), ...extra };

  if (spec.bodyFormat === 'json') {
    const payload = { [imageField]: imageValue };
    for (const [k, v] of Object.entries(merged)) {
      if (v != null) payload[k] = v;
    }
    return {
      body: JSON.stringify(payload),
      contentType: 'application/json; charset=UTF-8',
    };
  }

  const body = new URLSearchParams();
  body.set(imageField, imageValue);
  for (const [k, v] of Object.entries(merged)) {
    if (v != null && v !== '') body.set(k, String(v));
  }
  return {
    body: body.toString(),
    contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
  };
}

// ---------------------------------------------------------------------------
// 返回解析
// ---------------------------------------------------------------------------

/**
 * 从返回信封里取出文本。
 *
 * ============================================================================
 * 实测确认的真实结构（1 次真实调用换来的，见 scripts/ocr-verify.js）
 * ============================================================================
 * 成功：
 *   { "content": "识别出的整段题干…",
 *     "figure": [ { "type": "subject_table", "x":40, "y":827, "w":462, "h":90, ... } ] }
 * 失败：
 *   { "error_code": 400, "error_msg": "img和url参数不能同时为空", "requestId": "..." }
 *
 * 三点与"常见做法"不同，都是实测才知道的：
 *   ① **没有 showapi_res_code / ret_code 那层信封** —— 是扁平结构。
 *      我原先按云市场通用形态预设了解析，第一次真机测试就被纠正了。
 *   ② **错误用 `error_code` + `error_msg`**，不是业务码表。
 *      所以"错误码 10/20/…/90 翻人话"在这条通道上其实用不到 ——
 *      但代码保留，因为 ShowAPI 系通道确实用那套（多通道共用一个解析器）。
 *   ③ **`content` 是整段文本**，`figure` 是配图坐标（含 angle，可表示旋转的图）。
 *
 * 两层状态码的判据也保留：只要返回里出现系统码（showapi_res_code / code）
 * 就按两层判；没有就按扁平结构判。这样两种通道共用一个解析器而不互相污染。
 */
export function parseOcrResponse(json) {
  if (!json || typeof json !== 'object') {
    return { ok: false, reason: 'empty', message: '识别服务没有返回内容' };
  }

  // ---- 扁平结构的错误（本通道的真实形态）----
  const errCode = json.error_code ?? json.errorCode;
  if (errCode !== undefined && errCode !== null && Number(errCode) !== 0) {
    const code = Number(errCode);
    const msg = json.error_msg ?? json.errorMsg ?? json.message;
    return {
      ok: false,
      /**
       * 2001 是"识别失败/没识别出内容"这一类的语义（实测大概率落在这里），
       * 但**不写死映射** —— 只有确实收到过才敢归类，否则一律按网关错误处理，
       * 免得把"参数错"说成"照片不清楚"，让学生白改照片。
       */
      reason: code === 2001 ? 'business' : 'gateway',
      code,
      message: msg
        ? `识别服务返回错误：${clip(String(msg), 120)}`
        : `识别服务返回错误（错误码 ${code}）`,
      detail: json.requestId ?? null,
    };
  }

  // ---- ShowAPI 风格的两层信封（另一条通道，保留兼容）----
  const sysCode = json.showapi_res_code ?? json.code ?? json.status;
  const sysError = json.showapi_res_error || json.message || json.msg || json.error;
  if (sysCode !== undefined && Number(sysCode) !== 0) {
    return {
      ok: false,
      reason: 'gateway',
      code: Number(sysCode),
      message: sysError ? `识别网关返回错误：${clip(String(sysError), 120)}` : `识别网关返回错误（${sysCode}）`,
    };
  }

  const bodyRoot = json.showapi_res_body ?? json.data ?? json.result ?? json;
  const retCode = bodyRoot?.ret_code ?? json.ret_code;

  if (retCode !== undefined && Number(retCode) !== 0) {
    const code = Number(retCode);
    return {
      ok: false,
      reason: 'business',
      code,
      message: BUSINESS_ERRORS[code] ?? `识别失败（业务码 ${code}）`,
      /** 原始 remark 保留给教师视图排查，不给学生看 */
      detail: bodyRoot?.remark ?? json.remark ?? null,
    };
  }

  // ---- 取文本 ----
  const spec = PROVIDERS.marketplace;
  let text = null;
  for (const k of spec.textKeys) {
    const v = bodyRoot?.[k];
    if (typeof v === 'string' && v.trim()) {
      text = v;
      break;
    }
  }
  /**
   * 逐行结果形态（list，每项含 text/confidence/text_region）：
   * 仅当没有整段文本时才用，且**按坐标顺序拼回**。
   * 直接按数组顺序拼是错的 —— 那会得到"右栏在上、左栏在下"的错乱题干，
   * 而错乱的题干会让读题链路生成一张错乱的图谱，且**不报错**。
   */
  if (!text && Array.isArray(bodyRoot?.list)) {
    const lines = bodyRoot.list
      .filter((it) => it && typeof it.text === 'string')
      .map((it, i) => ({ text: it.text, i, box: it.text_region ?? it.box ?? null }));
    if (lines.length) {
      const sorted = sortByReadingOrder(lines);
      text = sorted.map((l) => l.text).join('\n');
    }
  }

  if (!text || !text.trim()) {
    return { ok: false, reason: 'empty', message: '识别服务返回成功，但没有文字内容（可能是图片里没有题目）' };
  }

  return {
    ok: true,
    rawText: text.trim(),
    /**
     * 配图位置：用于提醒学生"这题有图，题干里可能缺图形信息"。
     * 实测形状：{ type, x, y, w, h, box:{angle}, points:[...] } ——
     * 注意 box.angle 可以为 -90（表示图被旋转了），这对"图里画了什么"没有帮助，
     * 所以只用来数个数与提示，不试图解释图形内容。
     */
    figures: Array.isArray(bodyRoot?.figure) ? bodyRoot.figure : null,
  };
}

/**
 * 按阅读顺序排序（先上后下、同一行内先左后右）。
 *
 * 容差按行高估算：同一行的文字 y 会有几像素差异，
 * 用固定阈值会把一行拆成两行。
 */
export function sortByReadingOrder(lines) {
  const withBox = lines.filter((l) => Array.isArray(l.box) && l.box.length);
  if (withBox.length !== lines.length) return lines; // 坐标不全就不排序，避免半排序更乱
  const yOf = (l) => Math.min(...l.box.map((p) => (Array.isArray(p) ? p[1] : 0)));
  const xOf = (l) => Math.min(...l.box.map((p) => (Array.isArray(p) ? p[0] : 0)));
  const heights = withBox.map((l) => {
    const ys = l.box.map((p) => (Array.isArray(p) ? p[1] : 0));
    return Math.max(...ys) - Math.min(...ys);
  });
  const tol = Math.max(8, median(heights) * 0.6);

  return [...lines].sort((a, b) => {
    const dy = yOf(a) - yOf(b);
    if (Math.abs(dy) > tol) return dy;
    return xOf(a) - xOf(b);
  });
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 识别一张题图。
 *
 * @param {string} image   dataURL（含前缀）或图片的 base64 字符串
 * @param {{ config?: object, fetchImpl?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {Promise<{ok: boolean, rawText?: string, figures?: any[]|null, message?: string,
 *                    reason?: string, code?: number, latencyMs: number, provider: string,
 *                    endpoint?: string, charged: boolean, attempts: number}>}
 */
export async function recognizeProblemImage(image, options = {}) {
  const startedAt = Date.now();
  const config = options.config ?? readOcrConfig();
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  if (!config.available) {
    return {
      ok: false,
      reason: 'not_configured',
      message: config.unimplemented
        ? '拍照识题当前通道尚未实现（官方通道需要 AK/SK 签名）'
        : '未配置拍照识题凭据 —— 请把题目文字粘贴进来，或让管理员配置 ALIYUN_OCR_APPCODE',
      latencyMs: 0,
      provider: config.provider,
      charged: false,
      attempts: 0,
    };
  }

  const value = normalizeImage(image, config.providerSpec);
  if (!value) {
    return {
      ok: false,
      reason: 'bad_image',
      message: '没有拿到有效的图片数据',
      latencyMs: 0,
      provider: config.provider,
      charged: false,
      attempts: 0,
    };
  }

  /**
   * 候选轮换只发生在**还没有任何形状被验证过**时。
   * 一旦带进来了已验证的 shape（config.shape），就只走这一个 ——
   * 否则每张图都从候选 0 开始试，等于每张图都多花一次钱。
   */
  const shapesToTry = config.shape ? 1 : Math.max(1, (config.providerSpec.paths ?? []).length);
  let lastFailure = null;
  let attempts = 0;

  for (let attempt = 0; attempt < shapesToTry; attempt += 1) {
    const shape = resolveCallShape(config, attempt);
    if (!shape) break;
    attempts += 1;

    const { body, contentType } = buildRequestBody(shape.imageField, value, shape.spec);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const onOuterAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onOuterAbort);

    let res;
    try {
      res = await doFetch(shape.url, {
        method: 'POST',
        headers: {
          /**
           * 头部按契约原样写：`Authorization: APPCODE <code>`（中间一个英文空格）。
           * 网关对大小写不敏感，但照抄契约能避免"看起来一样却失败"这类无谓排查。
           */
          Authorization: `APPCODE ${config.appCode}`,
          'Content-Type': contentType,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuterAbort);
      /**
       * 网络层失败：请求很可能没到服务端 ⇒ 大概率未计费 ⇒ 可以换下一个候选。
       * 这是唯一允许"再试一次"的情形（见文件头红线 ①）。
       */
      lastFailure = {
        ok: false,
        reason: err?.name === 'AbortError' ? 'timeout' : 'network',
        message: err?.name === 'AbortError'
          ? `识别服务超时（${config.timeoutMs} ms）`
          : `连接识别服务失败：${clip(String(err?.message ?? err), 120)}`,
        latencyMs: Date.now() - startedAt,
        provider: config.provider,
        charged: false,
        attempts,
      };
      continue;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }

    const raw = await res.text().catch(() => '');
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* 下面按"非 JSON 响应"处理 */
    }

    /**
     * 拿到 HTTP 响应之后**不再换候选**：
     * 这次调用可能已经计费，再试一次就是再花一次钱。
     * 把真实原因告诉用户，由他决定要不要重来。
     */
    const charged = res.ok;

    if (!json) {
      lastFailure = {
        ok: false,
        reason: res.ok ? 'bad_response' : 'http',
        code: res.status,
        message: res.ok
          ? '识别服务返回了无法解析的内容'
          : httpMessage(res.status, raw),
        latencyMs: Date.now() - startedAt,
        provider: config.provider,
        charged,
        attempts,
      };
      break;
    }

    const parsed = parseOcrResponse(json);
    if (parsed.ok) {
      return {
        ok: true,
        rawText: parsed.rawText,
        figures: parsed.figures ?? null,
        latencyMs: Date.now() - startedAt,
        provider: config.provider,
        endpoint: shape.url,
        /** 命中形状：调用方（router）可以据此把它记下来，避免下次重新轮换 */
        shape: { url: shape.url, imageField: shape.imageField },
        charged: true,
        attempts,
      };
    }

    /**
     * 业务失败（ret_code≠0）要看**错误码本身**决定是否换候选：
     *   · 10（参数错误）⇒ 很可能就是字段名不对，换下一个候选值得；
     *   · 50/60/70/80/90 ⇒ 图的问题或服务的问题，换字段名没用，白花钱。
     * 这是本模块唯一一处"看错误码做分支"的地方，判据写在明处。
     */
    const isParamError = parsed.reason === 'business' && parsed.code === 10;
    lastFailure = {
      ok: false,
      reason: parsed.reason,
      code: parsed.code,
      message: parsed.message,
      detail: parsed.detail ?? null,
      latencyMs: Date.now() - startedAt,
      provider: config.provider,
      charged,
      attempts,
    };
    if (!isParamError) break;
  }

  return (
    lastFailure ?? {
      ok: false,
      reason: 'unknown',
      message: '识别失败',
      latencyMs: Date.now() - startedAt,
      provider: config.provider,
      charged: false,
      attempts,
    }
  );
}

function httpMessage(status, raw) {
  if (status === 401 || status === 403) {
    return '识别服务的凭据无效或未授权（AppCode 可能不正确，或该商品未开通）';
  }
  if (status === 429) return '识别服务限流，稍后重试';
  if (status >= 500) return `识别服务暂时不可用（HTTP ${status}）`;
  const snippet = clip(String(raw ?? '').replace(/\s+/g, ' '), 100);
  return `识别请求被拒绝（HTTP ${status}）${snippet ? `：${snippet}` : ''}`;
}

/**
 * 图片值归一化。
 *
 * 两种输入都接受：带 dataURL 前缀的、和裸 base64 的。
 * 输出形态由契约决定（`spec.dataUrlPrefix`）：
 *   · **题目识别要求"纯 base64，不带前缀"**（契约原文：`"img":"<base64编码>"`）
 *   · ShowAPI 系的通用 OCR 反而要求带 `data:image/jpeg;base64,`
 * 两者正好相反，所以这一项必须来自契约表，不能靠"多数接口都这样"来猜。
 */
export function normalizeImage(image, spec = PROVIDERS.marketplace) {
  const s = String(image ?? '').trim();
  if (!s) return null;

  const m = s.match(/^data:([^;,]+);base64,(.*)$/s);
  const bare = (m ? m[2] : s).replace(/\s+/g, '');
  if (!bare || bare.length < 32) return null;
  // 基本合法性：base64 字符集（宽松判断，不做解码）
  if (!/^[A-Za-z0-9+/=]+$/.test(bare.slice(0, 200))) return null;

  if (spec.dataUrlPrefix === true) {
    return m ? `data:${m[1]};base64,${bare}` : `data:image/jpeg;base64,${bare}`;
  }
  return bare;
}

export { PROVIDERS, BUSINESS_ERRORS };
