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
import { maskSecret } from '../src/core/env.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

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

const server = createServer(async (req, res) => {
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
});

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
  const teacherKey = String(process.env.TEACHER_KEY ?? '').trim();
  console.log(
    `  ▸ 教师视图：${
      teacherKey
        ? `需要口令（${maskSecret(teacherKey)}）`
        : String(process.env.DSH_FORCE_TEACHER_LOCK ?? '') === '1'
          ? '已关闭（本部署形态锁死了教师视图）'
          : '无需口令 · 本地模式，点一下直接进'
    }`,
  );
  console.log('');
  console.log('  ▸ 核心承诺：只给提示，不给答案（出口由 guard 强制校验）');
  console.log('  ▸ 视图隔离：学生视图拿不到解题路径 / 答案指纹 / 错因标签 —— 由服务端分流');
  console.log('');
});
