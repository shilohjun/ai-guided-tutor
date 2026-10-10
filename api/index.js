/**
 * Vercel serverless 入口。
 *
 * 作用：让公开 Demo 有一个"别人点开就能对话"的链接。
 *
 * 三个刻意的设计决定：
 *
 * ① **不接真模型，强制走离线规则桩。**
 *    公网服务如果带着 API Key 跑真模型，等于把额度挂出去；
 *    而且本 PoC 的安全保证（7 类守卫、层级护栏）全部在决策层与守卫层，
 *    与模型能力无关 —— 离线桩下安全指标同样是 0。
 *    因此这里显式清空 Key，把这个决定写在代码里，而不是靠部署时"记得别配"。
 *
 * ② **业务逻辑不在这里，全部复用 src/server/router.js。**
 *    否则线上和本地一定会漂移成两套行为。
 *
 * ③ **静态文件由 Vercel 直接托管 public/**（见 vercel.json），不经本函数。
 *    这样前端资源走 CDN，只有 /api/* 才唤醒函数。
 */

import { handleApi } from '../src/server/router.js';

/**
 * Vercel Node.js runtime 传入的是 (req, res)（Node IncomingMessage / ServerResponse）。
 * 这里保持与本地服务器完全一致的调用方式。
 */
export default async function handler(req, res) {
  // ---- 决定 ①：公开部署一律用离线规则桩 ----
  // 必须在读取配置之前清空，且不能依赖部署平台是否配置了环境变量。
  if (process.env.PUBLIC_DEMO_FORCE_OFFLINE !== '0') {
    delete process.env.LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (!url.pathname.startsWith('/api/')) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: `未知接口 ${url.pathname}（静态资源由 Vercel 直接托管）` }));
    return;
  }

  try {
    const handled = await handleApi(req, res, url);
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
