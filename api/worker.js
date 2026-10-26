/**
 * Cloudflare Workers 入口。
 *
 * 为什么要有这一份：
 *   Vercel 的 *.vercel.app 在国内被 DNS 投毒（解析到 157.240.x.x 这种假地址），
 *   页面根本打不开。换到 Cloudflare 是为了**换一条能走的网络路径**，
 *   不是为了换技术栈 —— 所以业务代码一行没动，只在这里加一层适配。
 *
 * 这一层只做三件事：
 *   ① 静态资源交给 Workers Static Assets（wrangler.jsonc 里绑成 ASSETS）
 *   ② /api/* 把 Fetch API 的 Request 翻译成 router 认识的 (req, res)
 *   ③ 把 router 写出来的响应再翻译回 Response
 *
 * 刻意复用的两处，避免和 Vercel 版漂移：
 *   · 口令门与凭据裁剪 → src/server/demo-gate.js（两个入口同一份）
 *   · 业务逻辑        → src/server/router.js（连本地服务也是同一份）
 *
 * 顺带一个副产品：因为 router 里的配置读取已经统一走 envFor()
 * （AsyncLocalStorage），Workers 的 env 绑定可以直接喂进去，
 * 不需要像 Vercel 那样从 process.env 里取 —— 两边行为一致。
 */

import { handleApi, requestEnv } from '../src/server/router.js';
import { buildRequestContext } from '../src/server/demo-gate.js';

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS?: { fetch: (r: Request) => Promise<Response> } } & Record<string, unknown>} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // ① 静态资源：CSS / JS / HTML 全走 Cloudflare 的边缘缓存，不消耗函数时间
    if (!url.pathname.startsWith('/api/')) {
      if (!env.ASSETS) return new Response('静态资源绑定缺失（ASSETS）', { status: 500 });
      return env.ASSETS.fetch(request);
    }

    // ② 与 Vercel 版同一份判定：这次请求能用真模型吗？教师视图锁不锁？
    const { gateState, env: requestScopedEnv } = buildRequestContext({
      headers: request.headers,
      url,
      source: env,
    });

    /**
     * 请求体一次性读完再回放。
     *
     * 为什么不直接把流透传给 router：readJson() 的写法是
     * `req.on('data')` / `req.on('end')` 的事件式消费。
     * 在 Fetch API 里对应的是 ReadableStream，硬接会多出一层背压处理，
     * 而这里的请求体本来就是 JSON（最大也就拍照识题那 2.6 MB）。
     * 读完再回放，既简单又不会改变 router 的行为 ——
     * 体积上限的检查仍然由 readJson 自己按 req.url 分档执行。
     */
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? Buffer.alloc(0)
        : Buffer.from(await request.arrayBuffer());

    const { req, res, toResponse } = createNodeLikeExchange({ request, url, body, gateState });

    try {
      const handled = await requestEnv.run(requestScopedEnv, () => handleApi(req, res, url));
      if (!handled) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: `未知接口 ${url.pathname}` }));
      }
    } catch (err) {
      console.error('[worker] 未捕获错误：', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
      }
      res.end(JSON.stringify({ error: '内部错误', detail: String(err?.message ?? err) }));
    }

    // ③ 写回 Response
    return toResponse();
  },
};

/**
 * 造一对"长得像 node:http"的 req / res。
 *
 * 这是整个迁移里唯一需要小心的部分：router 只用到很少的几个成员，
 * 把它们精确对上就够了，不需要真的造一个 http server。
 *   req：method / url / headers / on(data|end|error)
 *   res：statusCode / setHeader / end / headersSent
 */
function createNodeLikeExchange({ request, url, body, gateState }) {
  const headers = {};
  for (const [key, value] of request.headers) headers[key.toLowerCase()] = value;

  const req = {
    method: request.method,
    /**
     * 必须是 path + query，不能是整个 URL：
     * router 里靠 `req.url.startsWith('/api/ocr')` 判断该用哪一档体积上限。
     */
    url: `${url.pathname}${url.search}`,
    headers,
    /** 健康检查回显用（只报形态，不回报口令） */
    __demoGate: gateState,
    /**
     * 事件回放：请求体在进入本函数前已经读完，
     * 所以监听器一注册就把 data / end 立刻补发。
     * readJson() 是先 on('data') 再 on('end')，这个顺序天然对上。
     */
    on(event, listener) {
      if (event === 'data' && body.length) listener(body);
      else if (event === 'end') listener();
      return req;
    },
  };

  const collected = { statusCode: 200, headers: {}, chunks: [] };

  const res = {
    get statusCode() {
      return collected.statusCode;
    },
    set statusCode(value) {
      collected.statusCode = value;
    },
    headersSent: false,
    setHeader(name, value) {
      collected.headers[String(name).toLowerCase()] = String(value);
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        collected.chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      }
      res.headersSent = true;
    },
  };

  function toResponse() {
    return new Response(collected.chunks.join(''), {
      status: collected.statusCode,
      headers: collected.headers,
    });
  }

  return { req, res, toResponse };
}
