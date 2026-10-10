/**
 * 请求路由与业务处理 —— 与运行环境无关。
 *
 * 为什么要从 server.js 里抽出来：
 *   同一套逻辑要跑在两种环境里：
 *     ① 本地：Node http.createServer（server/server.js）
 *     ② Vercel：serverless 函数（api/index.js，导出一个 handler）
 *   serverless 环境没有"长期监听的服务器"，只有"每次请求调用一次函数"。
 *   如果把路由写死在 createServer 里，线上 Demo 就得复制一份代码 ——
 *   而重复的代码一定会跟主逻辑漂移，最后线上和本地行为不一致。
 *
 * 关于会话状态（serverless 下的已知局限，写在明处）：
 *   会话存在进程内存里。本地运行时完全没问题；
 *   serverless 下只在"热实例"期间有效，冷启动或换实例会丢。
 *   因此这里加了 TTL 清理，并且前端对"会话不存在"做了友好降级。
 *   PoC 阶段刻意不引持久化存储 —— 换来的是零依赖，代价是长间隔的对话可能丢上下文。
 */

import { loadEnvFile, maskSecret } from '../core/env.js';
import { createAdapter, readLLMConfig } from '../core/llm.js';
import { createEngine } from '../core/engine.js';
import { PROBLEMS, getProblem, toPublicProblem } from '../core/problems.data.js';
import { createSessionRecord, appendTurn, buildReport } from '../core/report.js';
import { runEvaluation, formatEvaluation } from '../core/eval.js';

loadEnvFile();

const LEVEL_NAMES = {
  0: 'L0 结构化澄清',
  1: 'L1 条件追问',
  2: 'L2 方向提示',
  3: 'L3 降级示范',
};

/** 会话存活时间：超过即回收，避免 serverless 常驻进程内存无限增长 */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** 会话数量上限（防内存被打满） */
const MAX_SESSIONS = 500;

const sessions = new Map();
let adapterInstance = null;

function getAdapter() {
  if (!adapterInstance) adapterInstance = createAdapter();
  return adapterInstance;
}

/** 取会话；顺带做过期清理 */
function getSession(sessionId, problemId) {
  const now = Date.now();
  if (sessions.size > MAX_SESSIONS || (sessions.size > 0 && sessions.size % 50 === 0)) {
    for (const [k, v] of sessions) {
      if (now - v.touchedAt > SESSION_TTL_MS) sessions.delete(k);
    }
  }
  let s = sessions.get(sessionId);
  if (!s || s.problemId !== problemId) {
    s = {
      id: sessionId,
      problemId,
      engine: createEngine({ adapter: getAdapter(), problem: getProblem(problemId) }),
      history: [],
      record: createSessionRecord(problemId),
      createdAt: new Date().toISOString(),
      touchedAt: now,
    };
    sessions.set(sessionId, s);
  }
  s.touchedAt = now;
  return s;
}

// ---------------------------------------------------------------------------
// 响应工具（统一封装，本地与 serverless 共用）
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function sendText(res, status, text) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(text);
}

function readJson(req) {
  return new Promise((resolvePromise, reject) => {
    // serverless 环境下 body 可能已被平台解析好
    if (req.body !== undefined) {
      if (typeof req.body === 'string') {
        if (!req.body) return resolvePromise({});
        try {
          return resolvePromise(JSON.parse(req.body));
        } catch (err) {
          return reject(new Error(`请求体不是合法 JSON：${err.message}`));
        }
      }
      return resolvePromise(req.body ?? {});
    }
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
// API 处理
// ---------------------------------------------------------------------------

/**
 * 处理一个 /api/* 请求。
 * @returns {Promise<boolean>} 是否已处理（false 表示不是 API 路由）
 */
export async function handleApi(req, res, url) {
  const path = url.pathname;

  // ---- GET /api/health ----
  if (path === '/api/health' && req.method === 'GET') {
    const config = readLLMConfig();
    const adapter = getAdapter();
    sendJson(res, 200, {
      ok: true,
      engine: adapter.kind,
      model: adapter.model ?? null,
      llmConfigured: config.available,
      llmBaseUrl: config.available ? config.baseUrl : null,
      keyMask: config.available ? maskSecret(config.apiKey) : null,
      problemCount: PROBLEMS.length,
      hintPolicy: {
        levels: ['L0 结构化澄清', 'L1 条件追问', 'L2 方向提示', 'L3 降级示范'],
        neverRevealsAnswer: true,
        guardChecks: [
          'answer_in_text',
          'formula_leak',
          'level_overflow',
          'solution_dump',
          'final_conclusion',
          'concept_out_of_domain',
          'solution_insight',
        ],
      },
    });
    return true;
  }

  // ---- GET /api/problems ----
  if (path === '/api/problems' && req.method === 'GET') {
    sendJson(res, 200, {
      problems: PROBLEMS.map((p) => ({
        id: p.id,
        subject: p.subject,
        difficulty: p.difficulty,
        topics: p.topics,
        stemPreview: `${p.stem.slice(0, 60)}…`,
      })),
    });
    return true;
  }

  // ---- GET /api/problem?id=xxx ----
  if (path === '/api/problem' && req.method === 'GET') {
    const id = url.searchParams.get('id') ?? PROBLEMS[0].id;
    let problem;
    try {
      problem = getProblem(id);
    } catch {
      sendJson(res, 404, { error: `未找到题目 ${id}` });
      return true;
    }
    // 关键：走 toPublicProblem，参考答案、答案指纹、错因标签均不出网
    sendJson(res, 200, { problem: toPublicProblem(problem) });
    return true;
  }

  // ---- GET /api/demo-scripts ----
  if (path === '/api/demo-scripts' && req.method === 'GET') {
    const { SCENARIOS } = await import('../core/eval.js');
    const id = url.searchParams.get('id');
    const list = SCENARIOS.filter((s) => !id || s.problemId === id).map((s) => ({
      id: s.id,
      problemId: s.problemId,
      title: s.title,
      kind: s.kind,
      utterances: s.utterances,
    }));
    sendJson(res, 200, { scripts: list });
    return true;
  }

  // ---- POST /api/chat ----
  if (path === '/api/chat' && req.method === 'POST') {
    const body = await readJson(req);
    const { sessionId, problemId, utterance, mode, explicitHelpSeeking } = body ?? {};
    if (!problemId || typeof utterance !== 'string') {
      sendJson(res, 400, { error: '需要 problemId 与 utterance' });
      return true;
    }
    let session;
    try {
      session = getSession(sessionId || 'demo', problemId);
    } catch {
      sendJson(res, 404, { error: `未找到题目 ${problemId}` });
      return true;
    }

    const response = await session.engine.handleTurn({
      problemId,
      utterance,
      history: session.history,
      mode: mode === 'self_training' ? 'self_training' : 'ai_companion',
      explicitHelpSeeking: Boolean(explicitHelpSeeking),
      sessionId: session.id,
    });

    const now = new Date().toISOString();
    session.history.push({ role: 'student', text: utterance, at: now });
    session.history.push({
      role: 'ai',
      text: response.hint.text,
      at: now,
      level: response.hint.level,
      metaStep: response.diagnosis.position.stepIndex,
      metaGraphId: response.diagnosis.position.graphId,
    });
    appendTurn(session.record, { utterance, response });

    sendJson(res, 200, {
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
        sufficientInfo: response.diagnosis.sufficientInfo,
        probeQuestion: response.diagnosis.probeQuestion ?? null,
        strengths: response.diagnosis.strengths ?? [],
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
    return true;
  }

  // ---- GET /api/report?sessionId=xxx ----
  if (path === '/api/report' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || 'demo';
    const session = sessions.get(sessionId);
    if (!session) {
      // serverless 冷启动会丢会话 —— 给出可操作的提示，而不是一个空白错误
      sendJson(res, 404, {
        error: '该会话不存在或已过期',
        detail:
          '公开演示部署在 serverless 环境，会话只保留在单个实例内存里，间隔较久或实例切换后会丢失。本地运行不受影响。',
      });
      return true;
    }
    const problem = getProblem(session.problemId);
    const report = buildReport(problem, session.record, {
      engine: session.engine.adapter.kind,
      model: session.engine.adapter.model,
    });
    sendJson(res, 200, { report, turns: session.record.turns });
    return true;
  }

  // ---- POST /api/eval ----
  // 默认走离线规则桩：公开演示绝不能因为配了 Key 就发几十轮真实请求。
  if (path === '/api/eval' && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const { createOfflineAdapter } = await import('../core/llm.js');
    const useLlm = Boolean(body?.useLlm);
    const report = await runEvaluation({
      adapter: useLlm ? getAdapter() : createOfflineAdapter(),
      scenarioIds: body?.scenarioIds,
    });
    sendJson(res, 200, {
      metrics: report.metrics,
      rows: report.rows,
      adapter: { kind: report.adapter.kind, model: report.adapter.model ?? null },
      text: formatEvaluation(report),
    });
    return true;
  }

  // ---- POST /api/reset ----
  if (path === '/api/reset' && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    sessions.delete(body?.sessionId || 'demo');
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

export { sessions, SESSION_TTL_MS, MAX_SESSIONS, sendJson, sendText, readJson, getAdapter };
