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
 *
 * ④ **教师视图在公网一律锁死。**
 *    本地不配 TEACHER_KEY 时教师视图是开放的（自己看得方便），
 *    但那个默认值不能上公网 —— 教师接口返回完整解题路径与参考答案。
 *    所以这里在没有口令时强制置位，让 router 走 'off' 分支。
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

  /**
   * ---- 决定 ①b：公开部署一律关闭拍照识题 ----
   *
   * 为什么必须单独锁这一条（它和 LLM Key 是两件事）：
   *   拍照识题是**按成功调用次数计费**的（题目识别约 0.083 元/次），
   *   而它没有"额度用完自动停"的保护 —— 挂在公开链接上，
   *   任何访客点几次"识别成题干"，烧的都是真金白银，而且删 Key 也拦不住已经发出去的调用。
   *
   *   所以默认清除凭据，让 /api/ocr 走"未配置"分支：
   *   前端会照实显示"拍照识题未启用"，而不是假装能用。
   *   真要在公网演示这一环，必须显式设 PUBLIC_DEMO_ALLOW_OCR=1 ——
   *   这个变量名本身就是一句提醒，不是靠部署时"记得别配 Key"。
   */
  if (String(process.env.PUBLIC_DEMO_ALLOW_OCR ?? '') !== '1') {
    delete process.env.ALIYUN_OCR_APPCODE;
  }

  // ---- 决定 ④：公开部署一律锁死教师视图 ----
  // 教师接口返回完整解题路径与参考答案。本地默认"无口令可进"是为了自己看得方便，
  // 但那个默认值绝不能跟着代码上公网 —— 否则这份公开链接就等于把答案挂在网上。
  // 同一条原则：默认值由部署形态决定，而不是靠部署时"记得配"。
  // 确实要在公网开教师视图，就配 TEACHER_KEY（配了之后本行不再生效）。
  if (!String(process.env.TEACHER_KEY ?? '').trim()) {
    process.env.DSH_FORCE_TEACHER_LOCK = '1';
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
