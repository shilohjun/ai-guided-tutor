/**
 * 公网入口的公共判定：访问口令门 + 这一次请求能看见哪些凭据。
 *
 * 为什么单独一层：
 *   同一份规则现在要跑在两个 serverless 平台上：
 *     api/index.js   → Vercel（Node 函数，req/res 来自 node:http）
 *     api/worker.js  → Cloudflare Workers（Fetch API）
 *   如果每个入口各写一份，就一定会漂移成"Vercel 上关着、Workers 上开着"
 *   这种最难发现的问题。所以判定只写在这里，入口只负责搬运。
 *
 * ---------------------------------------------------------------------------
 * 核心约束：**配置按请求构造，绝不修改 process.env。**
 * ---------------------------------------------------------------------------
 * serverless 的一个实例会连续处理多个请求，process.env 是进程级的。
 * 若靠"进请求删 Key、出请求还原"来切换形态，并发一交错就会串号 ——
 * 没带口令的请求会白捡上一个请求留下的真模型，而且几乎无法复现。
 *
 * 另外 Cloudflare Workers 里 process.env 并不映射到绑定的 Secret，
 * 改它根本不生效 —— 所以这里统一接收一个 `source` 对象：
 *   Vercel  传 process.env
 *   Workers 传函数收到的 env
 */

/** 定时安全比较：避免用 === 逐字符短路泄露口令长度与前缀 */
export function safeEqual(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i += 1) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/**
 * 判定这次请求该走哪种形态。
 *
 * @param {object} params
 * @param {object} params.headers  请求头，键名大小写不敏感（这里统一按小写取）
 * @param {URL}    params.url
 * @param {object} params.source   配置来源（process.env 或 Workers 的 env）
 * @returns {{ state: 'off'|'locked'|'unlocked', unlocked: boolean }}
 *   'off'      没有配置口令门 → 沿用旧的 PUBLIC_DEMO_* 开关
 *   'locked'   配了口令门但这次没带对 → 离线桩
 *   'unlocked' 口令对 → 真模型
 */
export function resolveDemoGate({ headers, url, source }) {
  const env = source ?? {};
  const expected = String(env.DEMO_ACCESS_CODE ?? '').trim();

  if (!expected) {
    // 没配口令门：老的显式开关仍然说了算（默认强制离线）
    return { state: 'off', unlocked: env.PUBLIC_DEMO_FORCE_OFFLINE === '0' };
  }

  // 请求头可能是 Headers 实例（Workers）也可能是普通对象（Node），两种都取
  const fromHeader =
    typeof headers?.get === 'function' ? headers.get('x-demo-code') : headers?.['x-demo-code'];
  const provided = String(fromHeader ?? url.searchParams.get('code') ?? '').trim();

  const unlocked = safeEqual(provided, expected);
  return { state: unlocked ? 'unlocked' : 'locked', unlocked };
}

/**
 * 构造这一次请求可见的配置。
 *
 * 是"挑一份能看见什么"，而不是"改全局再改回来"。
 * 返回的普通对象会被 router 用作这次请求的唯一配置源。
 *
 * 分两种形态，不要混：
 *
 *   state === 'off'（没配口令门）
 *     完整保留从前的两把显式开关，行为一个字节都不变：
 *       PUBLIC_DEMO_FORCE_OFFLINE=0 → 放行模型
 *       PUBLIC_DEMO_ALLOW_OCR=1     → 放行拍照识题
 *     默认则两者皆关。
 *
 *   state === 'locked' / 'unlocked'（配了口令门）
 *     口令说了算，不再看那两个开关 —— 否则"配了口令却被旧开关绕过"，
 *     口令就成了一句装饰。没带对时把两套凭据一起摘掉：
 *     OCR 的 AppCode 与 LLM Key 是两件事，一个按 token 计费、
 *     一个按成功调用次数计费，必须分别摘。
 *
 * 另外无论哪种形态，**公网部署一律锁死教师视图**：
 *   教师接口返回完整解题路径与参考答案，挂在公开链接上等于把答案发出去。
 *   本地服务器不走这个模块，所以本地"点一下就能进"的行为不受影响。
 */
export function buildRequestEnv(gate, source) {
  const base = source ?? {};
  const env = { ...base };

  if (gate.state === 'off') {
    if (env.PUBLIC_DEMO_FORCE_OFFLINE !== '0') {
      delete env.LLM_API_KEY;
      delete env.OPENAI_API_KEY;
    }
    if (String(env.PUBLIC_DEMO_ALLOW_OCR ?? '') !== '1') {
      delete env.ALIYUN_OCR_APPCODE;
    }
  } else if (!gate.unlocked) {
    delete env.LLM_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.ALIYUN_OCR_APPCODE;
  }

  if (!String(env.TEACHER_KEY ?? '').trim()) {
    env.DSH_FORCE_TEACHER_LOCK = '1';
  }

  return env;
}

/**
 * 一步到位：给定请求头、URL 与配置来源，算出 { gate, gateState, env }。
 * 两个平台入口都调这个，避免各自拼装出细微差别。
 */
export function buildRequestContext({ headers, url, source }) {
  const gate = resolveDemoGate({ headers, url, source });
  return { gate, gateState: gate.state, env: buildRequestEnv(gate, source) };
}
