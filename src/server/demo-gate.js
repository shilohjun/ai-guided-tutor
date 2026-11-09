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

/**
 * 与 auth.js 之间是**互相引用**（那边用这里的 `safeEqual`）。这是安全的：
 * 两边都只在函数体里用对方的东西，没有模块求值期的调用；
 * 判定（口令、时限）仍然只写在 auth.js 一处，这里只负责"把它接上请求"。
 */
import { resolveToken } from './auth.js';

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


  return env;
}

/**
 * 一步到位：给定请求头、URL 与配置来源，算出 { gate, gateState, env }。
 * 两个平台入口都调这个，避免各自拼装出细微差别。
 *
 * `user` 是**已经解析好的**学生身份（`{ user, batchId } | null`），由调用方传进来。
 * 为什么不在这个函数里解析：它必须是同步的（三个入口都在 `requestEnv.run` **之前**
 * 调它，而 store 的配置恰恰来自那份请求级 env —— Workers 的库配置就在 env 绑定里，
 * 根本不在 process.env 上）。等它变成 async，Workers 那条路会拿到一个用
 * 进程环境打开的库，而账号在 env 绑定里 —— 两边就此分叉。
 *
 * 所以真正的解析在 router.js 的 `handleApi` 里（那里 store 与请求级 env 都在），
 * 解析结果挂到 `req.__user`；这里保留字段并把传进来的身份原样透出，
 * 将来哪个入口能提前解析，就不必再改签名。
 */
export function buildRequestContext({ headers, url, source, user = null }) {
  const gate = resolveDemoGate({ headers, url, source });
  return { gate, gateState: gate.state, env: buildRequestEnv(gate, source), user };
}

// ---------------------------------------------------------------------------
// 学生身份：`x-test-token` → 库里的账号记录
// ---------------------------------------------------------------------------

/**
 * 取这次请求带的令牌。
 *
 * 三个头都认，是**兼容**不是设计：
 *   · `x-test-token` —— 设计稿 §5.1 定的头，前端（第 10 个任务）带这个；
 *   · `authorization: Bearer …` —— 标准形状，已经发出去的埋点代码在用它；
 *   · `x-pilot-token` —— 埋点代码分散在各处、写法不一定统一，留着它免得漏一个。
 * 取串只留这一处：三处各写一份，就一定会出现"某个接口认、另一个不认"的分叉。
 */
export function tokenFromHeaders(headers) {
  const read = (name) => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]);
  /**
   * 按顺序取**第一个非空**的：不能写成 `a ?? b` —— 前端若发了一个空的
   * `x-test-token`（登录前那一下），`??` 会把它当成"有值"，于是后面那个
   * 真正带着令牌的 `authorization` 被跳过，表现是"明明登录了却没身份"。
   */
  for (const name of ['x-test-token', 'authorization', 'x-pilot-token']) {
    const raw = read(name);
    const text = String(Array.isArray(raw) ? raw[0] : (raw ?? '')).replace(/^bearer\s+/i, '').trim();
    if (text) return text;
  }
  return '';
}

/**
 * 这次请求算谁：令牌 → `resolveToken` → `{ user, batchId } | null`。
 *
 * **永远不抛**：解析失败一律按"未登录"处理。理由写在 router 的登录守卫上——
 * 读库读挂了应该由业务层报 503，而不是让一个坏库把所有请求变成 500，
 * 那样连"请先登录"这句话都发不出去，学生只会看到"内部错误"。
 *
 * 没有 store（或没带令牌）时直接返回 null：不读库，行为与加身份之前一模一样。
 *
 * ⚠️ 返回的 `user` 是库里的**完整账号记录**（含 `codeHash`、`disabled`）。
 * 它只用于服务端判定，任何路由都不得把它整个回给前端 —— 要回就回 `displayName` 之类的投影。
 */
export async function resolveUser({ headers, store }) {
  const token = tokenFromHeaders(headers);
  if (!token || !store) return null;
  try {
    const identity = await resolveToken(store, token);
    if (!identity?.user) return null;
    return { user: identity.user, batchId: identity.batchId ?? null };
  } catch {
    return null;
  }
}
