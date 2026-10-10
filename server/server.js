/**
 * Demo HTTP 服务（零依赖，Node 内置模块）。
 *
 * 为什么不用 Express：
 *   这个 PoC 要直接交到教研/企业手里跑。零依赖意味着
 *   "clone 下来 node server/server.js 就能打开"，不需要联网装包。
 *   企业内网环境这一点尤其重要。
 *
 * 安全约定（与 types.js 的 toPublicProblem 呼应）：
 *   参考答案、错因教研标签、答案指纹**绝不出网**。
 *   前端只拿到题干与"有几条路径、各几步"。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, dirname, normalize as pathNormalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile, maskSecret } from '../src/core/env.js';
import { createAdapter, readLLMConfig } from '../src/core/llm.js';
import { createEngine } from '../src/core/engine.js';
import { PROBLEMS, getProblem, toPublicProblem } from '../src/core/problems.data.js';
import { createSessionRecord, appendTurn, buildReport } from '../src/core/report.js';
import { runEvaluation, formatEvaluation } from '../src/core/eval.js';

loadEnvFile();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

// ---------------------------------------------------------------------------
// 会话状态（内存）
// ---------------------------------------------------------------------------

/**
 * 会话存储。PoC 阶段刻意用内存：
 *   重启即清空，避免 demo 时"上次别人的对话还留着"的尴尬。
 *   生产化时应替换为带学生 id 的持久化存储。
 */
const sessions = new Map();

function getSession(sessionId, problemId) {
  let s = sessions.get(sessionId);
  if (!s || s.problemId !== problemId) {
    s = {
      id: sessionId,
      problemId,
      engine: createEngine({ adapter: getAdapter(), problem: getProblem(problemId) }),
      history: [],
      record: createSessionRecord(problemId),
      createdAt: new Date().toISOString(),
    };
    sessions.set(sessionId, s);
  }
  return s;
}

let adapterInstance = null;
function getAdapter() {
  if (!adapterInstance) adapterInstance = createAdapter();
  return adapterInstance;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

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
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(res, path);
  } catch (err) {
    console.error('[server] 未捕获错误：', err);
    sendJson(res, 500, { error: '内部错误', detail: String(err?.message ?? err) });
  }
});

async function handleApi(req, res, url) {
  const path = url.pathname;

  // ---- GET /api/health ----
  if (path === '/api/health' && req.method === 'GET') {
    const config = readLLMConfig();
    const adapter = getAdapter();
    return sendJson(res, 200, {
      ok: true,
      engine: adapter.kind,
      model: adapter.model ?? null,
      /** 只回显脱敏信息，绝不返回 Key 本身 */
      llmConfigured: config.available,
      llmBaseUrl: config.available ? config.baseUrl : null,
      keyMask: config.available ? maskSecret(config.apiKey) : null,
      problemCount: PROBLEMS.length,
      hintPolicy: {
        levels: ['L0 结构化澄清', 'L1 条件追问', 'L2 方向提示', 'L3 降级示范'],
        neverRevealsAnswer: true,
        guardChecks: ['answer_in_text', 'formula_leak', 'level_overflow', 'solution_dump', 'final_conclusion'],
      },
    });
  }

  // ---- GET /api/problems ----
  if (path === '/api/problems' && req.method === 'GET') {
    return sendJson(res, 200, {
      problems: PROBLEMS.map((p) => ({
        id: p.id,
        subject: p.subject,
        difficulty: p.difficulty,
        topics: p.topics,
        stemPreview: `${p.stem.slice(0, 60)}…`,
      })),
    });
  }

  // ---- GET /api/problem?id=xxx ----
  if (path === '/api/problem' && req.method === 'GET') {
    const id = url.searchParams.get('id') ?? PROBLEMS[0].id;
    let problem;
    try {
      problem = getProblem(id);
    } catch {
      return sendJson(res, 404, { error: `未找到题目 ${id}` });
    }
    // 关键：走 toPublicProblem，参考答案不出网
    return sendJson(res, 200, { problem: toPublicProblem(problem) });
  }

  // ---- GET /api/demo-scripts?id=xxx ----
  // 提供典型学生剧本，方便 demo 一键演示（教研可直接照着念）
  if (path === '/api/demo-scripts' && req.method === 'GET') {
    const { SCENARIOS } = await import('../src/core/eval.js');
    const id = url.searchParams.get('id');
    const list = SCENARIOS.filter((s) => !id || s.problemId === id).map((s) => ({
      id: s.id,
      problemId: s.problemId,
      title: s.title,
      kind: s.kind,
      utterances: s.utterances,
    }));
    return sendJson(res, 200, { scripts: list });
  }

  // ---- POST /api/chat ----
  if (path === '/api/chat' && req.method === 'POST') {
    const body = await readJson(req);
    const { sessionId, problemId, utterance, mode, explicitHelpSeeking } = body ?? {};
    if (!problemId || typeof utterance !== 'string') {
      return sendJson(res, 400, { error: '需要 problemId 与 utterance' });
    }
    let session;
    try {
      session = getSession(sessionId || 'demo', problemId);
    } catch {
      return sendJson(res, 404, { error: `未找到题目 ${problemId}` });
    }

    const response = await session.engine.handleTurn({
      problemId,
      utterance,
      history: session.history,
      mode: mode === 'self_training' ? 'self_training' : 'ai_companion',
      explicitHelpSeeking: Boolean(explicitHelpSeeking),
      sessionId: session.id,
    });

    // 记录会话（用于生成报告）
    session.history.push({ role: 'student', text: utterance, at: new Date().toISOString() });
    session.history.push({
      role: 'ai',
      text: response.hint.text,
      at: new Date().toISOString(),
      level: response.hint.level,
      metaStep: response.diagnosis.position.stepIndex,
      metaGraphId: response.diagnosis.position.graphId,
    });
    appendTurn(session.record, { utterance, response });

    // 返回给学生看的信息 —— 诊断细节是"教学面板"用途，前端默认折叠
    return sendJson(res, 200, {
      message: response.message,
      hint: {
        level: response.hint.level,
        levelName: LEVEL_NAMES[response.hint.level] ?? '-',
        form: response.hint.form,
        text: response.hint.text,
        concepts: response.hint.concepts,
        nextAsk: response.hint.nextAsk,
        rationale: response.hint.rationale,
      },
      diagnosis: {
        stepIndex: response.diagnosis.position.stepIndex,
        graphId: response.diagnosis.position.graphId,
        confidence: response.diagnosis.position.confidence,
        feasibility: response.diagnosis.feasibility,
        stuckKind: response.diagnosis.stuckKind,
        /** 信息是否充足：为 false 说明走的是"反问"路径，UI 应据此改变展示 */
        sufficientInfo: response.diagnosis.sufficientInfo,
        probeQuestion: response.diagnosis.probeQuestion ?? null,
        /** 学生已经想对的地方（正面反馈） */
        strengths: response.diagnosis.strengths ?? [],
        // 错因标签是教研视角用词，仅在"教师视图"里展示
        teacherView: {
          misconceptionLabels: response.diagnosis.misconceptions.map((m) => m.label),
          evidenceQuotes: response.diagnosis.evidenceQuotes,
          trace: response.diagnosis.trace,
        },
      },
      refusal: response.refusal ?? null,
      suppressed: response.suppressed ?? false,
      allowedNextLevel: response.allowedNextLevel,
      meta: {
        engine: response.meta.engine,
        model: response.meta.model ?? null,
        latencyMs: response.meta.latencyMs,
        guardPassed: response.meta.guard.passed,
        guardBlocked: (response.meta.guardHistory ?? []).filter((g) => !g.passed).length,
      },
    });
  }

  // ---- GET /api/report?sessionId=xxx ----
  if (path === '/api/report' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || 'demo';
    const session = sessions.get(sessionId);
    if (!session) return sendJson(res, 404, { error: '该会话不存在或已过期（服务重启会清空）' });
    const problem = getProblem(session.problemId);
    const report = buildReport(problem, session.record, {
      engine: session.engine.adapter.kind,
      model: session.engine.adapter.model,
    });
    return sendJson(res, 200, { report, turns: session.record.turns });
  }

  // ---- POST /api/eval ----
  // 一键跑评测（教研/路演时很有用：当场证明"泄题率 0%"）
  //
  // 重要：**默认使用离线规则桩**，即使当前引擎接的是真模型。
  // 原因：这个按钮是演示用的，若默认走真模型，一次请求要发 39 轮 LLM 调用、
  // 耗时数分钟并消耗额度 —— 演示现场点一下就会卡住，非常难看。
  // 安全指标（泄题率 / 跳级率 / 确认答案 / 解法倾倒）本来就与模型能力无关，
  // 用离线桩跑出的结果完全能支撑"护栏有效"这个论点。
  // 需要真模型数据时用命令行：`node scripts/eval.js --adapter llm`。
  if (path === '/api/eval' && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const { createOfflineAdapter } = await import('../src/core/llm.js');
    const useLlm = Boolean(body?.useLlm);
    const report = await runEvaluation({
      adapter: useLlm ? getAdapter() : createOfflineAdapter(),
      scenarioIds: body?.scenarioIds,
    });
    return sendJson(res, 200, {
      metrics: report.metrics,
      rows: report.rows,
      adapter: { kind: report.adapter.kind, model: report.adapter.model ?? null },
      text: formatEvaluation(report),
    });
  }

  // ---- POST /api/reset ----
  if (path === '/api/reset' && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const sessionId = body?.sessionId || 'demo';
    sessions.delete(sessionId);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: `未知接口 ${path}` });
}

const LEVEL_NAMES = {
  0: 'L0 结构化澄清',
  1: 'L1 条件追问',
  2: 'L2 方向提示',
  3: 'L3 降级示范',
};

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------

async function serveStatic(res, path) {
  const rel = path === '/' ? '/index.html' : path;
  const candidate = join(PUBLIC_DIR, pathNormalize(rel).replace(/^([/\\])+/, ''));
  // 目录穿越防护：解析后必须仍在 PUBLIC_DIR 内
  if (!candidate.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, '禁止访问');
  }
  if (!existsSync(candidate)) {
    return sendText(res, 404, '未找到资源');
  }
  const buf = await readFile(candidate);
  res.writeHead(200, {
    'content-type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(buf);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

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
  console.log('');
  console.log('  ▸ 核心承诺：只给提示，不给答案（出口由 guard 强制校验）');
  console.log('');
});
