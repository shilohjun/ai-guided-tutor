/**
 * 本地开发服务器（零依赖，Node 内置模块）。
 *
 * 为什么不用 Express：
 *   这个 PoC 要直接交到教研/企业手里跑。"clone 下来 node server/server.js 就能开"
 *   比"先 npm install 300 个包"重要。企业内网环境这一点尤其关键。
 *
 * 本文件只做三件事：起 HTTP 服务、转发 /api/* 给共享路由、提供静态文件。
 * 所有业务逻辑在 src/server/router.js 里 —— 线上 Demo（api/index.js）复用同一份。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, dirname, normalize as pathNormalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleApi, getAdapter } from '../src/server/router.js';
import { readLLMConfig } from '../src/core/llm.js';
import { ocrStatus } from '../src/core/ocr.js';
import { maskSecret } from '../src/core/env.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

/**
 * 可选的第二个端口：**只给"试点入口单独一个端口"用**。
 *
 * 为什么需要它：试点期间同一台机器上常常既有"给学生做测试的入口"（/pilot.html），
 * 又有"平时大家看的 Demo"（/）。分成两个端口之后，前端、投屏、内网转发的配置
 * 可以各管各的，不用在一个端口上分辨"这次是测试还是演示"。
 *
 * 什么时候不生效（都按"没配"处理，不是报错）：
 *   · 空值 / 非数字 / 越界（1–65535）；
 *   · 与 PORT 相同 —— 那是同一条监听，写出来等于没写。
 *
 * 注意 CloudBase 上**不适用**：云函数只有一个入口，试点入口走同域的 `/pilot.html`。
 * 所以这个开关只影响本地开发与自托管。
 */
function parsePilotPort(raw, mainPort) {
  const value = Number(String(raw ?? '').trim());
  if (!Number.isInteger(value) || value <= 0 || value > 65535) return 0;
  return value === mainPort ? 0 : value;
}

const PILOT_PORT = parsePilotPort(process.env.PILOT_PORT, PORT);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * 一个请求的处理过程。
 *
 * 抽成函数是因为它要被两个端口共用（见文件末尾的 PILOT_PORT）：第二端口是
 * **同一个进程、同一份路由、同一个库**，不是第二个应用 —— 分成两份代码，
 * 就会出现"测试入口能用、Demo 入口不能用"这种只在一边复现的问题。
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    if (path.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: `未知接口 ${path}` }));
      }
      return;
    }

    await serveStatic(res, path);
  } catch (err) {
    console.error('[server] 未捕获错误：', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ error: '内部错误', detail: String(err?.message ?? err) }));
  }
}

const server = createServer(handleRequest);

async function serveStatic(res, path) {
  const rel = path === '/' ? '/index.html' : path;
  const candidate = join(PUBLIC_DIR, pathNormalize(rel).replace(/^([/\\])+/, ''));
  // 目录穿越防护：解析后必须仍在 PUBLIC_DIR 内
  if (!candidate.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('禁止访问');
  }
  if (!existsSync(candidate)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('未找到资源');
  }
  const buf = await readFile(candidate);
  res.writeHead(200, {
    'content-type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(buf);
}

server.listen(PORT, HOST, () => {
  const adapter = getAdapter();
  const config = readLLMConfig();
  console.log('');
  console.log('  ┌──────────────────────────────────────────────────────────┐');
  console.log('  │  AI 重难题引导助手 · 提示引擎 Demo                        │');
  console.log('  └──────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`  ▸ 打开：http://${HOST}:${PORT}`);
  console.log('');
  console.log(`  ▸ 引擎模式：${adapter.kind}${adapter.model ? `（${adapter.model}）` : '（离线规则桩，无需 API Key）'}`);
  if (config.available) {
    console.log(`  ▸ 模型接入：${config.baseUrl}   Key ${maskSecret(config.apiKey)}`);
  } else {
    console.log('  ▸ 模型接入：未配置 .env —— 当前用离线规则桩，全流程可跑');
    console.log('    要接真模型：复制 .env.example 为 .env，填入 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL');
  }
  console.log(
    `  ▸ 读题能力：${typeof adapter.understandProblem === 'function' ? '可用（可导入任意新题目）' : '不可用（导入题目走通用骨架）'}`,
  );
  const ocr = ocrStatus();
  console.log(
    `  ▸ 拍照识题：${ocr.configured ? `可用 · ${ocr.providerLabel}` : `未启用（${ocr.hint}）`}`,
  );
  if (ocr.configured && !ocr.endpoint) {
    // 明说"地址还没确认"：否则第一次调用会静默多花几次候选调用的钱，而日志里看不出来
    console.log('    （接口地址未指定，首次识别会自动探索候选地址并缓存；确认后建议写进 ALIYUN_OCR_ENDPOINT）');
  }
  console.log('');
  console.log('  ▸ 核心承诺：只给提示，不给答案（出口由 guard 强制校验）');
  console.log('  ▸ 学生视图：白名单投影 —— 拿不到解题路径 / 答案指纹 / 错因标签');
  console.log('');

  /**
   * 第二端口（可选）：同一个 handler、同一个库，只是多一条监听。
   *
   * 为什么要明说"哪个端口是试点入口"：两个端口跑的是同一个应用，光看地址栏
   * 分不出该用哪个。日志里点一句，比写在 .env.example 里更可能被看到。
   */
  if (PILOT_PORT) {
    const pilotServer = createServer(handleRequest);
    /**
     * 先挂 error 再 listen：端口被占用时 `EADDRINUSE` 可能在 listen 的同一个 tick 里
     * 就抛出来，晚一步挂就变成未捕获的 error 事件 —— 那会把整个进程带走，
     * 连主端口的 Demo 也一起没了。
     */
    pilotServer.on('error', (err) => {
      // 端口被占用不该让主服务跟着退：Demo 入口仍然能用，试点入口换个端口再来
      console.error(`  ✗ 试点端口 ${PILOT_PORT} 不能监听：${err?.message ?? err}`);
    });
    pilotServer.listen(PILOT_PORT, HOST, () => {
      console.log(`  ▸ 试点入口：http://${HOST}:${PILOT_PORT}/pilot.html（PILOT_PORT，同一个进程同一个库）`);
      console.log('');
    });
  }
});
