/**
 * Vercel serverless 入口。
 *
 * 作用：让公开 Demo 有一个"别人点开就能对话"的链接。
 *
 * 三个刻意的设计决定：
 *
 * ① **默认不接真模型，强制走离线规则桩。**
 *    公网服务如果带着 API Key 跑真模型，等于把额度挂出去；
 *    而且本 PoC 的安全保证（7 类守卫、层级护栏）全部在决策层与守卫层，
 *    与模型能力无关 —— 离线桩下安全指标同样是 0 泄漏。
 *    因此这里显式摘掉 Key，把这个决定写在代码里，而不是靠部署时"记得别配"。
 *
 * ② **业务逻辑不在这里，全部复用 src/server/router.js。**
 *    否则线上和本地一定会漂移成两套行为。
 *
 * ③ **静态文件由 Vercel 直接托管 public/**（见 vercel.json），不经本函数。
 *    这样前端资源走 CDN，只有 /api/* 才唤醒函数。
 *
 * ============================================================================
 * 口令门与凭据裁剪：规则不在这里，在 src/server/demo-gate.js
 * ============================================================================
 * 同一份判定还要跑在 Cloudflare Workers 上（api/worker.js）。
 * 两边各写一份必然漂移成"Vercel 上关着、Workers 上开着"这种最难发现的差别，
 * 所以判定逻辑抽到 demo-gate.js，本文件只负责把 Node 的 req/res 喂进去。
 *
 * 这个入口必须守住的一条：**配置按请求构造，绝不修改 process.env。**
 *   serverless 的一个实例会连续处理多个请求，process.env 是进程级的；
 *   靠"进请求删 Key、出请求还原"在并发下必然串号 ——
 *   没带口令的请求会白捡上一个请求留下的真模型，而且几乎无法复现。
 *   所以这里构造一份请求级 env，交给 router 的 AsyncLocalStorage 上下文使用，
 *   下游一律通过 envFor() 取配置。
 */

import { handleApi, requestEnv } from '../src/server/router.js';
import { buildRequestContext } from '../src/server/demo-gate.js';

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  /**
   * 一次算出「这次请求是哪种形态」与「它能看见哪些凭据」。
   *
   * 这一行同时决定了三件事：
   *   · 真模型 / 离线桩（见 demo-gate 的 PUBLIC_DEMO_FORCE_OFFLINE 与口令门）
   *   · 拍照识题开不开（OCR 按次计费，默认摘掉凭据）
   *   · 教师视图锁不锁（公网默认锁死，配了 TEACHER_KEY 才开）
   */
  const { gateState, env } = buildRequestContext({
    headers: req.headers,
    url,
    source: process.env,
  });

  /** 交给 router 回报健康检查用（只报形态，不回报口令） */
  req.__demoGate = gateState;

  if (!url.pathname.startsWith('/api/')) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: `未知接口 ${url.pathname}（静态资源由 Vercel 直接托管）` }));
    return;
  }

  try {
    const handled = await requestEnv.run(env, () => handleApi(req, res, url));
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
