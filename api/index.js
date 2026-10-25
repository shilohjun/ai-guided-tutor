/**
 * Vercel serverless 入口。
 *
 * 作用：让公开 Demo 有一个"别人点开就能对话"的链接。
 *
 * 四个刻意的设计决定：
 *
 * ① **默认不接真模型，强制走离线规则桩。**
 *    公网服务如果带着 API Key 跑真模型，等于把额度挂出去；
 *    而且本 PoC 的安全保证（7 类守卫、层级护栏）全部在决策层与守卫层，
 *    与模型能力无关 —— 离线桩下安全指标同样是 0 泄漏。
 *    因此这里显式清空 Key，把这个决定写在代码里，而不是靠部署时"记得别配"。
 *
 * ② **业务逻辑不在这里，全部复用 src/server/router.js。**
 *    否则线上和本地一定会漂移成两套行为。
 *
 * ③ **静态文件由 Vercel 直接托管 public/**（见 vercel.json），不经本函数。
 *    这样前端资源走 CDN，只有 /api/* 才唤醒函数。
 *
 * ④ **教师视图在公网一律锁死。**
 *    本地不配 TEACHER_KEY 时教师视图是开放的（自己看得方便），
 *    但那个默认值不能上公网 —— 教师接口返回完整解题路径与参考答案。
 *    所以这里在没有口令时强制置位，让 router 走 'off' 分支。
 *
 * ============================================================================
 * ⑤ 访问口令门（DEMO_ACCESS_CODE）—— 怎么在"公开"和"烧钱"之间取一个中间点
 * ============================================================================
 * 现实问题：想把真模型和拍照识题给特定的人用（自己、评委、内测同学），
 * 但又不能把 Key 裸挂在公网链接上。两个极端都不对：
 *   · 全关  → 链接只能看规则桩，演示效果大打折扣
 *   · 全开  → 任何拿到链接的人都能刷额度，OCR 按次计费且没有"用完自动停"
 *
 * 所以加了一道口令：
 *   · 配了 DEMO_ACCESS_CODE：带对口令（请求头 x-demo-code 或 ?code=）→ 真模型 + OCR
 *                            不带 / 带错                              → 退回离线桩，页面照常可看
 *   · 没配 DEMO_ACCESS_CODE：行为与以前完全一致（见 ①）
 *
 * **关键实现约束：绝不修改 process.env。**
 *   serverless 的一个实例会连续处理多个请求，process.env 是进程级的。
 *   若靠"进请求删 Key、出请求还原"来切换两种形态，并发交错必然串号 ——
 *   没带口令的请求会白捡到上一个请求留下的真模型，而且几乎无法复现。
 *   因此这里构造一份**请求级** env，交给 router 的 AsyncLocalStorage 上下文使用。
 *   代价是 router 里读配置必须走 envFor() 而不是 process.env —— 已在那边统一。
 */

import { handleApi, requestEnv } from '../src/server/router.js';

/** 定时安全比较：避免用 === 逐字符短路泄露口令长度与前缀 */
function safeEqual(a, b) {
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
 * @returns {{ state: 'off'|'locked'|'unlocked', unlocked: boolean }}
 *   'off'      没有配置口令门 → 沿用旧的 PUBLIC_DEMO_* 开关
 *   'locked'   配了口令门但这次没带对 → 离线桩
 *   'unlocked' 口令对 → 真模型
 */
function resolveDemoGate(req, url) {
  const expected = String(process.env.DEMO_ACCESS_CODE ?? '').trim();

  if (!expected) {
    // 没配口令门：老的显式开关仍然说了算（默认强制离线）
    const unlocked = process.env.PUBLIC_DEMO_FORCE_OFFLINE === '0';
    return { state: 'off', unlocked };
  }

  const provided = String(req.headers?.['x-demo-code'] ?? url.searchParams.get('code') ?? '').trim();
  const unlocked = safeEqual(provided, expected);
  return { state: unlocked ? 'unlocked' : 'locked', unlocked };
}

/**
 * 构造这一次请求可见的配置。
 *
 * 注意是"挑一份能看见什么"，而不是"改全局再改回来"：
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
 */
function buildRequestEnv(gate) {
  const env = { ...process.env };

  if (gate.state === 'off') {
    if (env.PUBLIC_DEMO_FORCE_OFFLINE !== '0') {
      delete env.LLM_API_KEY;
      delete env.OPENAI_API_KEY;
    }
    if (String(env.PUBLIC_DEMO_ALLOW_OCR ?? '') !== '1') {
      delete env.ALIYUN_OCR_APPCODE;
    }
    return env;
  }

  if (!gate.unlocked) {
    delete env.LLM_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.ALIYUN_OCR_APPCODE;
  }

  return env;
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  // ---- 决定 ⑤：先判口令，再决定这次请求能看见哪些凭据 ----
  const gate = resolveDemoGate(req, url);
  /** 交给 router 回报健康检查用（只报形态，不回报口令） */
  req.__demoGate = gate.state;

  // ---- 决定 ④：公开部署一律锁死教师视图 ----
  // 教师接口返回完整解题路径与参考答案。本地默认"无口令可进"是为了自己看得方便，
  // 但那个默认值绝不能跟着代码上公网 —— 否则这份公开链接就等于把答案挂在网上。
  // 确实要在公网开教师视图，就配 TEACHER_KEY（配了之后本行不再生效）。
  //
  // 这一条仍然直接写 process.env：它只往 '1' 单向置位、永不回退，
  // 因此不存在上面 ⑤ 里那种并发串号问题。
  if (!String(process.env.TEACHER_KEY ?? '').trim()) {
    process.env.DSH_FORCE_TEACHER_LOCK = '1';
  }

  if (!url.pathname.startsWith('/api/')) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: `未知接口 ${url.pathname}（静态资源由 Vercel 直接托管）` }));
    return;
  }

  try {
    const handled = await requestEnv.run(buildRequestEnv(gate), () => handleApi(req, res, url));
    if (!handled) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: `未知接口 ${url.pathname}` }));
    }
  } catch (err) {
    console.error('[api] 未捕获错误：', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ error: '内部错误', detail: String(err?.message ?? err) }));
  }
}
