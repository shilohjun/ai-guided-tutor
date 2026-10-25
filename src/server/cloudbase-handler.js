/**
 * 腾讯云 CloudBase（云函数 + HTTP 访问服务）入口。
 *
 * 为什么要有这一份：
 *   *.vercel.app 解析到 157.240.x.x、*.workers.dev 解析到 128.121.x.x，
 *   都是被投毒的假地址，国内页面根本打不开。
 *   换到 CloudBase 跟换到 Workers 是同一个性质的事：**换一条能走的网络路径**，
 *   不是换技术栈 —— 所以业务代码一行没动，只加这一层适配。
 *
 * ---------------------------------------------------------------------------
 * 为什么页面也由函数出，而不是甩给静态托管
 * ---------------------------------------------------------------------------
 * CloudBase 的静态托管默认域名是 `*.tcloudbaseapp.com`，HTTP 访问服务是
 * `*.service.tcloudbase.com` —— **两个不同的域**，跨域就要 CORS + 前置 OPTIONS，
 * 前端还得记一个绝对地址。而站点的静态资源一共 8 个文件、0.33 MB，
 * 让函数顺手发出去，换来的是：单域、无跨域、前端一行不改、本地线上完全同构。
 * 对一个演示站点，这个交换是划算的。
 *
 * 这一层只做三件事：
 *   ① 静态请求 → 从函数包内的 public/ 读文件（页面、样式、脚本）
 *   ② /api/* → 翻译成 router 认识的 (req, res)
 *   ③ router 写出来的响应 → 翻译回云函数认识的 { statusCode, headers, body }
 *
 * 刻意复用的两处，避免和另外两个入口漂移：
 *   · 口令门与凭据裁剪 → ./demo-gate.js（与 Vercel、Workers 同一份）
 *   · 业务逻辑        → ./router.js（与本地服务同一份）
 *
 * ---------------------------------------------------------------------------
 * 为什么入口是 CJS 包装一层动态 import
 * ---------------------------------------------------------------------------
 * 云函数的 handler 是 `exports.main`，要求 CommonJS；
 * 而本项目 `package.json` 是 `"type": "module"`，src/ 全是 ESM。
 * 打包时把 src/ 单独放一个带 `{"type":"module"}` 的 package.json，
 * 外层 index.js 用动态 `import()` 加载 —— 两边都不必改写源码。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize as pathNormalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleApi, requestEnv } from './router.js';
import { buildRequestContext } from './demo-gate.js';

/**
 * 函数包根目录。
 *
 * 本文件在 <函数根>/src/server/ 下，所以往上两级就是函数根，
 * public/ 与 src/ 同级 —— 打包脚本（scripts/build-cloudbase.mjs）按这个布局铺。
 */
const FN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PUBLIC_DIR = join(FN_ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * CloudBase HTTP 访问服务 → 一次完整的请求处理。
 *
 * @param {object} event 云函数事件（HTTP 触发时是 API 网关形状）
 * @param {object} [source] 配置来源，默认 process.env。
 *   留这个参数是为了让测试能直接喂一份配置进来，而不必去改 process.env ——
 *   云函数实例是长驻的，测试里改全局变量会污染同文件后续用例。
 * @returns {Promise<{statusCode:number, headers:Record<string,string>, body:string, isBase64Encoded:boolean}>}
 */
export async function handleCloudbaseEvent(event, source = process.env) {
  const raw = event ?? {};
  const method = String(raw.httpMethod ?? raw.requestContext?.httpMethod ?? 'GET').toUpperCase();
  const headers = normalizeHeaders(raw.headers);

  const pathname = normalizePath(raw);
  const search = buildSearch(raw);

  // ① 接口：/api/* 走与另外两平台完全相同的判定与路由
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return handleApiRequest({ raw, method, headers, pathname, search, source });
  }

  // ② 静态：命中就直接返回；HEAD 只回头不回体
  const file = await readStatic(pathname);
  if (file) {
    if (method === 'HEAD') return { ...file, body: '' };
    return file;
  }

  /**
   * ③ 静态没命中，再按接口试一次。
   *
   * 网关有可能把 `/api` 前缀吃掉（enablePathTransmission 的两种取值），
   * 那样 `/api/chat` 到这边就只剩 `/chat`。先当静态找不到，
   * 再补回前缀试接口，两边都不会误判。
   */
  return handleApiRequest({ raw, method, headers, pathname: `/api${pathname}`, search, source });
}

/** 组装一次 API 调用（含口令门、凭据裁剪、未捕获错误兜底） */
async function handleApiRequest({ raw, method, headers, pathname, search, source }) {
  const url = new URL(`http://cloudbase.local${pathname}${search}`);
  const body = decodeBody(raw);

  const { gateState, env: requestScopedEnv } = buildRequestContext({ headers, url, source });

  const { req, res, readResponse } = createNodeLikeExchange({
    method,
    headers,
    pathWithQuery: `${url.pathname}${url.search}`,
    body,
    gateState,
  });

  try {
    const handled = await requestEnv.run(requestScopedEnv, () => handleApi(req, res, url));
    if (!handled) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: `未知接口 ${url.pathname}` }));
    }
  } catch (err) {
    console.error('[cloudbase] 未捕获错误：', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ error: '内部错误', detail: String(err?.message ?? err) }));
  }

  const out = readResponse();
  return { statusCode: out.statusCode, headers: out.headers, body: out.body, isBase64Encoded: false };
}

/**
 * 读一个静态文件。
 *
 * 目录穿越按"解析后必须仍在 PUBLIC_DIR 内"挡；
 * 缓存一律 no-store —— 与本地服务器、以及本项目其它部署形态保持一致，
 * 改完文件刷新就能看到，不用跟 CDN 缓存较劲。
 */
async function readStatic(pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const candidate = join(PUBLIC_DIR, pathNormalize(rel).replace(/^([/\\])+/, ''));

  if (!candidate.startsWith(PUBLIC_DIR)) {
    return { statusCode: 403, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '禁止访问', isBase64Encoded: false };
  }
  if (!existsSync(candidate)) return null;

  const buf = await readFile(candidate);
  return {
    statusCode: 200,
    headers: {
      'content-type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    },
    body: buf.toString('utf8'),
    isBase64Encoded: false,
  };
}

/** path 只取路径部分；空值兜底成根 */
function normalizePath(event) {
  const raw = String(event.path ?? event.requestContext?.path ?? '/').split('?')[0];
  const pathname = raw.startsWith('/') ? raw : `/${raw}`;
  return pathname === '' ? '/' : pathname;
}

/**
 * 查参数有两个来源：event.queryStringParameters 与 path 里自带的 `?`。
 * 两者都收，重复的按出现顺序叠加 —— 口令判定只看最后取到的那个值。
 */
function buildSearch(event) {
  const search = new URLSearchParams();

  const fromQuery = event.queryStringParameters;
  if (fromQuery && typeof fromQuery === 'object') {
    for (const [key, value] of Object.entries(fromQuery)) {
      if (value !== undefined && value !== null) search.append(key, String(value));
    }
  }

  const rawPath = String(event.path ?? '');
  const inlineQuery = rawPath.includes('?') ? rawPath.slice(rawPath.indexOf('?') + 1) : '';
  if (inlineQuery) {
    for (const [key, value] of new URLSearchParams(inlineQuery)) search.append(key, value);
  }

  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/** 请求头统一小写，并且只留字符串值 */
function normalizeHeaders(input) {
  const headers = {};
  if (!input || typeof input !== 'object') return headers;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    headers[String(key).toLowerCase()] = String(value);
  }
  return headers;
}

/** 请求体：可能是普通字符串，也可能被网关 base64 过 */
function decodeBody(event) {
  const raw = event.body;
  if (raw === undefined || raw === null || raw === '') return Buffer.alloc(0);
  if (event.isBase64Encoded) return Buffer.from(String(raw), 'base64');
  if (Buffer.isBuffer(raw)) return raw;
  return Buffer.from(String(raw), 'utf8');
}

/**
 * 造一对"长得像 node:http"的 req / res。
 *
 * router 只用到很少的几个成员，精确对上就够，不需要真的起一个 http server：
 *   req：method / url / headers / on(data|end|error)
 *   res：statusCode / setHeader / end / headersSent
 *
 * 与 api/worker.js 里那份是同一套形状，但两边最终产物不同
 * （这边返回普通对象给云函数，那边返回 Fetch API 的 Response），
 * 所以各留一份，而不是为了合并而合并。
 */
function createNodeLikeExchange({ method, headers, pathWithQuery, body, gateState }) {
  const req = {
    method,
    /**
     * 必须是 path + query，不能是整个 URL：
     * router 里靠 `req.url.startsWith('/api/ocr')` 判断该用哪一档体积上限。
     */
    url: pathWithQuery,
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

  function readResponse() {
    return {
      statusCode: collected.statusCode,
      headers: collected.headers,
      body: collected.chunks.join(''),
    };
  }

  return { req, res, readResponse };
}
