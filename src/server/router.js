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
 * ============================================================================
 * 本轮最重要的结构变化：**学生视图与教师视图在服务端分流**
 * ============================================================================
 * 以前 /api/chat 把 diagnosis.teacherView（错因标签、证据原话、完整 trace）
 * 和学生消息一起返回，靠前端的一个 checkbox 决定显不显示。
 * 那是"前端不显示"，不是"学生拿不到" —— 打开 F12 就能看到。
 *
 * 现在：
 *   /api/chat            只返回学生可见内容（见 buildStudentTurn）
 *                        没有错因标签、没有置信度、没有路径名、没有守卫细节、没有 rationale
 *   /api/teacher/*       必须带 TEACHER_KEY，才返回完整图谱、参考答案、指纹、trace
 *
 * 为什么用"白名单投影"而不是"给教师数据打码"：
 *   打码依赖"记得打哪里"，漏一处就是泄题，而且每加一个字段都要重新审一遍；
 *   白名单投影依赖"允许说什么"，漏一处只是少说一句话。
 *   这个取舍与 guard 用封闭词表而不是黑名单是同一条思路。
 *
 * 关于会话状态（serverless 下的已知局限，写在明处）：
 *   会话存在进程内存里。本地运行时完全没问题；
 *   serverless 下只在"热实例"期间有效，冷启动或换实例会丢。
 *   因此这里加了 TTL 清理，并且前端对"会话不存在"做了友好降级。
 *   PoC 阶段刻意不引持久化存储 —— 换来的是零依赖，代价是长间隔的对话可能丢上下文。
 *   导入的题目也一样（见 registry.js：用内容哈希做 id，丢了就重新生成同一个 id）。
 */

import { loadEnvFile, maskSecret } from '../core/env.js';
import { createAdapter, readLLMConfig } from '../core/llm.js';
import { createEngine } from '../core/engine.js';
import { totalSteps } from '../core/locate.js';
import { understandProblem } from '../core/intake.js';
import { getProblemById, listProblems, getImportMeta, getProblemAnalysis, registerImportedProblem, registryStats } from '../core/registry.js';
import { toStudentAnalysis, toTeacherAnalysis } from '../core/analysis.js';
import { createSessionRecord, appendTurn, buildReport } from '../core/report.js';
import { runEvaluation, formatEvaluation } from '../core/eval.js';
import { STUDENT_LEVEL_NOTE, inspectVoice } from '../core/prompt.js';
import { PROBLEMS } from '../core/problems.data.js';

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
      engine: createEngine({ adapter: getAdapter(), problem: problemId ? getProblemById(problemId) : null }),
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
// 教师视图鉴权
// ---------------------------------------------------------------------------

/**
 * 教师视图的三种形态。
 *
 *   'key'  配了 TEACHER_KEY ⇒ 必须带对口令才能取教研数据
 *   'open' 没配口令，且不是公网部署 ⇒ 本机开发模式，直接进
 *   'off'  没配口令，但被强制锁死（公网部署）⇒ 一律 403
 *
 * 为什么要有 'off' 这一档，而不是"没配口令就一律开放"：
 *   教师接口返回的是**完整解题路径 + 参考答案 + 答案指纹**。
 *   如果"没配口令 = 开放"这个默认值跟着代码上了 Vercel，
 *   那份公开链接就等于把答案挂在网上 —— 而这恰恰是最容易发生的疏忽：
 *   本地跑得好好的，部署时没人会想起来"还得去配个口令"。
 *
 *   所以默认值由**部署形态**决定，而不是由"有没有配"决定：
 *     server/server.js（本地）      → open
 *     api/index.js（Vercel / 公网） → off，除非显式配了口令
 *   这条规则写在代码里，不依赖部署时"记得"。
 */
function readTeacherKey() {
  return String(process.env.TEACHER_KEY ?? '').trim();
}

/** 公网入口会把它设为 '1'，强制锁死教师视图 */
export function teacherMode() {
  if (readTeacherKey()) return 'key';
  if (String(process.env.DSH_FORCE_TEACHER_LOCK ?? '') === '1') return 'off';
  return 'open';
}

/** 定时安全比较：避免用 === 逐字符短路比较口令 */
function safeEqual(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i += 1) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/** @returns {{ok: true} | {ok: false, status: number, error: string, hint?: string}} */
export function checkTeacherAuth(req, url) {
  const mode = teacherMode();

  if (mode === 'off') {
    return {
      ok: false,
      status: 403,
      error: '教师视图在本部署形态下已关闭',
      hint:
        '公网部署默认关闭教师视图 —— 它包含完整解题路径与参考答案。' +
        '确实需要开放时，在部署环境里设置 TEACHER_KEY，然后带口令访问。',
    };
  }

  // 本地开发模式：不设口令，直接进
  if (mode === 'open') return { ok: true };

  const expected = readTeacherKey();
  const provided = req.headers?.['x-teacher-key'] || url.searchParams.get('key') || '';
  if (!safeEqual(provided, expected)) {
    return { ok: false, status: 401, error: '教师口令不正确' };
  }
  return { ok: true };
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
// 载荷投影（白名单）
// ---------------------------------------------------------------------------

/**
 * 学生可见的题目 —— 带"解析"，但不带"解法"。
 *
 * 与 problems.data.js 的 toPublicProblem 的差别：
 *   旧的 graphSummary 带**路径名**（如"电动势—电流—安培力—平衡"）——
 *   那个名字本身就把解法说出来了。对学生只给"一共几步"。
 *
 * ⚠️ 曾经的一个漏洞（已修）：这里原本还带 `conceptTags`，而它是从 steps[].concepts
 * 汇总来的。那道题的概念里有「电源与内阻」「匀速直线运动合力为零」——
 * 恰好就是本题的两个 solutionInsights，**等于把答案印在题目下面**。
 * 现在知识点只从 problem.topics（章节级）来，见 analysis.js 的 buildKnowledgeGraph。
 */
export function toStudentProblem(problem) {
  if (!problem) return null;
  const analysis = getProblemAnalysis(problem);
  return {
    id: problem.id,
    source: problem.source ?? 'library',
    subject: problem.subject,
    topics: problem.topics,
    difficulty: problem.difficulty,
    stem: problem.stem,
    givens: problem.givens,
    asked: problem.asked,
    figure: problem.figure ?? null,
    /** 只说"有几关"，不说每关是什么 */
    stepCount: totalSteps(problem, problem.solutionGraphs[0]?.id),
    /**
     * 解析：关键变量 / 关键条件 / 知识图谱。
     * 走 toStudentAnalysis 白名单投影 —— 会剧透的条件只给提问，不给结论。
     */
    analysis: toStudentAnalysis(analysis, problem),
  };
}

/** 教师可见的题目：完整图谱 + 参考答案 + 指纹 + 完整解析（只有带对口令才走到这里） */
export function toTeacherProblem(problem) {
  if (!problem) return null;
  const importMeta = getImportMeta(problem.id);
  const analysis = getProblemAnalysis(problem);
  return {
    id: problem.id,
    source: problem.source ?? 'library',
    subject: problem.subject,
    difficulty: problem.difficulty,
    topics: problem.topics,
    stem: problem.stem,
    givens: problem.givens,
    asked: problem.asked,
    figure: problem.figure ?? null,
    solutionGraphs: problem.solutionGraphs,
    misconceptions: problem.misconceptions,
    referenceAnswer: problem.referenceAnswer,
    answerFingerprints: problem.answerFingerprints ?? [],
    formulaFingerprints: problem.formulaFingerprints ?? [],
    solutionInsights: problem.solutionInsights ?? [],
    /** 完整解析：关键条件带 meaning 与 reveals 标记；知识图谱含步骤里的概念 */
    analysis: toTeacherAnalysis(analysis),
    /** 导入题的生成质量元数据：路径概览、关键关节、生成告警、创建时间 */
    importMeta,
  };
}

/**
 * 学生可见的一轮回复。
 *
 * 这个函数是"学生拿不到教研数据"的**唯一执行点** ——
 * 想确认某个字段有没有外泄，只看这里就够了。
 */
export function buildStudentTurn(response, mode) {
  const d = response.diagnosis;
  const guardBlocked = (response.meta.guardHistory ?? []).filter((g) => !g.passed).length;
  const stepCount = response.stepCount ?? 0;

  return {
    message: response.message,
    hint: {
      level: response.hint.level,
      levelName: LEVEL_NAMES[response.hint.level] ?? '-',
      /** 给学生的人话版本（教研名对学生只会造成"我被分类了"的观感） */
      levelNote: STUDENT_LEVEL_NOTE[response.hint.level] ?? '',
      form: response.hint.form,
      text: response.hint.text,
      concepts: response.hint.concepts,
      nextAsk: response.hint.nextAsk,
    },
    progress: {
      stepIndex: d.position.stepIndex,
      stepCount,
      /**
       * 已走过的步骤号（只有编号，没有标题）。
       *
       * 为什么可以给学生：编号本身不含信息 ——
       * "你走过了第 1~3 步"和"第 3 步是【检查 E = BLv 的使用前提】"是两件事。
       * 前端用它画路径轨道：走过的点亮、当前的高亮、没到的置灰。
       *
       * 注意它是**推断**而不是确认：locate 的口径是"定位到第 N 步 ⇒ 之前的都算走过"。
       * UI 上因此写的是"已走过"而不是"已做对"。
       */
      completed: d.position.completedSteps ?? [],
      /** 只给"有多确定"的粗档，不给 0.55 这种数字（学生会追问 0.55 是什么） */
      confidenceLabel: d.position.confidence >= 0.7 ? '高' : d.position.confidence >= 0.5 ? '中' : '低',
    },
    enginePath: response.enginePath ?? [],
    /** 学生已经想对的地方 —— 学习反馈的主角 */
    understood: d.strengths ?? [],
    nextStep: response.hint.nextAsk ?? null,
    mode,
    /** 本轮是否经过复核重写（只说"复核过"，不说违规类型） */
    reviewed: guardBlocked > 0,
    suppressed: Boolean(response.suppressed),
    refused: Boolean(response.refusal),
    /**
     * 答案判定结果。
     *
     * `matched` 里的每个数字都来自**学生本人这一轮的原话**，引擎只负责取出来放大。
     * 这条不是风格问题：`engine.js` 在返回前用 `findUnstatedAnswers()` 断言过
     * 确认文本里没有出现学生尚未说出的答案（比守卫更紧的判据）。
     */
    completion: response.completion
      ? {
          complete: response.completion.complete,
          matched: response.completion.matched,
          remainingCount: response.completion.remainingCount,
          expectedCount: response.completion.expectedCount,
        }
      : null,
    /** 引擎信息：只给"真模型/离线"与耗时，不给守卫结论 */
    meta: {
      engine: response.meta.engine,
      model: response.meta.model ?? null,
      latencyMs: response.meta.latencyMs,
    },
  };
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
      registry: registryStats(),
      /**
       * 只报告形态，绝不回传口令本身。
       * 'open' = 本地开发模式（点一下就能进教师视图）
       * 'key'  = 需要口令
       * 'off'  = 公网部署下强制关闭
       */
      teacherView: teacherMode(),
      capabilities: {
        intake: typeof adapter.understandProblem === 'function',
        intakeFallback: true,
      },
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
    sendJson(res, 200, { problems: listProblems() });
    return true;
  }

  // ---- GET /api/problem?id=xxx（学生可见版本） ----
  if (path === '/api/problem' && req.method === 'GET') {
    const id = url.searchParams.get('id') ?? PROBLEMS[0].id;
    const problem = getProblemById(id);
    if (!problem) {
      sendJson(res, 404, { error: `未找到题目 ${id}` });
      return true;
    }
    // 关键：走 toStudentProblem，参考答案、答案指纹、路径名均不出网
    sendJson(res, 200, { problem: toStudentProblem(problem) });
    return true;
  }

  // ---- POST /api/problem/import（新题目文字 → 结构化题目） ----
  if (path === '/api/problem/import' && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const rawText = String(body?.rawText ?? '').trim();
    if (rawText.length < 8) {
      sendJson(res, 400, { error: '题干太短，至少需要 8 个字。请把完整题目文字粘贴进来。' });
      return true;
    }
    const adapter = getAdapter();
    let result;
    try {
      result = await understandProblem(rawText, {
        adapter,
        subjectHint: body?.subjectHint ?? null,
      });
    } catch (err) {
      sendJson(res, 422, { error: `读题失败：${err.message}` });
      return true;
    }

    // 登记进注册表（同一道题重复导入会覆盖，id 由内容哈希决定）
    registerImportedProblem(result.problem, result.analysis, result.warnings, result.modelRaw);

    const student = toStudentProblem(result.problem);
    const graphReady = (result.problem.answerFingerprints ?? []).length > 0;

    sendJson(res, 200, {
      problem: student,
      intake: {
        usedModel: result.usedModel,
        latencyMs: result.latencyMs,
        topics: result.problem.topics,
        stepCount: student.stepCount,
        /** 图谱是否可用于守卫（没有指纹就等于数值防泄题失效） */
        graphReady,
        /** 解析是否来自模型（false = 由题干与图谱派生，关系图会标 derived） */
        analysisFromModel: Boolean(result.usedModel && result.modelRaw?.knowledgeGraph),
        conditionCount: student.analysis?.keyConditions?.length ?? 0,
        /**
         * 给使用者的**人话**反馈。
         * 注意这里只描述"我做了什么"，不描述"这道题怎么解" ——
         * 路径本身只出现在教师视图里。
         */
        notice: result.usedModel
          ? graphReady
            ? '已读懂这道题：条件、目标、知识点与解题路径都已建档（路径对学生不可见，只用于后续引导）。'
            : '已读懂这道题，但没能给出可靠的答案指纹 —— 数值型防泄题对本题会弱一些，教师视图里已标记。'
          : '未启用模型读题（当前是离线规则桩）：只抽取了已知量与待求量，解题路径是通用六步骨架，定位精度会明显下降。配置 LLM_API_KEY 后重新导入即可得到真正的读题结果。',
        warningCount: result.warnings.length,
      },
    });
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
    const problem = getProblemById(problemId);
    if (!problem) {
      sendJson(res, 404, { error: `未找到题目 ${problemId}。如果是导入的题目，服务重启后需要重新导入。` });
      return true;
    }

    const session = getSession(sessionId || 'demo', problemId);
    const normalizedMode = mode === 'self_training' ? 'self_training' : 'ai_companion';

    const response = await session.engine.handleTurn({
      problemId,
      utterance,
      history: session.history,
      mode: normalizedMode,
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
    appendTurn(session.record, { utterance, response, problem });

    // 学生载荷 —— 只走白名单投影
    sendJson(res, 200, buildStudentTurn({ ...response, stepCount: totalSteps(problem, response.diagnosis.position.graphId) }, normalizedMode));
    return true;
  }

  // ---- GET /api/report?sessionId=xxx（学生自己的学习报告） ----
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
    const problem = getProblemById(session.problemId);
    if (!problem) {
      sendJson(res, 404, { error: '该会话的题目已不在注册表里（导入题目有存活时间）' });
      return true;
    }
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

  // =========================================================================
  // 以下为教师视图端点：全部需要 TEACHER_KEY
  // =========================================================================

  // ---- GET /api/teacher/problem?id=xxx ----
  if (path === '/api/teacher/problem' && req.method === 'GET') {
    const auth = checkTeacherAuth(req, url);
    if (!auth.ok) return sendAuthError(res, auth);
    const id = url.searchParams.get('id');
    const problem = getProblemById(id);
    if (!problem) {
      sendJson(res, 404, { error: `未找到题目 ${id}` });
      return true;
    }
    sendJson(res, 200, { problem: toTeacherProblem(problem), teacherView: true });
    return true;
  }

  // ---- GET /api/teacher/session?sessionId=xxx ----
  if (path === '/api/teacher/session' && req.method === 'GET') {
    const auth = checkTeacherAuth(req, url);
    if (!auth.ok) return sendAuthError(res, auth);
    const sessionId = url.searchParams.get('sessionId') || 'demo';
    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: '该会话不存在或已过期' });
      return true;
    }
    const problem = getProblemById(session.problemId);
    sendJson(res, 200, buildTeacherPayload(session, problem));
    return true;
  }

  // ---- GET /api/teacher/overview（教学与学习成果汇总） ----
  if (path === '/api/teacher/overview' && req.method === 'GET') {
    const auth = checkTeacherAuth(req, url);
    if (!auth.ok) return sendAuthError(res, auth);
    sendJson(res, 200, buildTeacherOverview());
    return true;
  }

  return false;
}

function sendAuthError(res, auth) {
  sendJson(res, auth.status, { error: auth.error, hint: auth.hint ?? null });
  return true;
}

// ---------------------------------------------------------------------------
// 教师载荷
// ---------------------------------------------------------------------------

/**
 * 单个会话的教研视图。
 *
 * 这里**故意包含**参考答案与指纹：
 *   教师需要拿它来核对"AI 给的提示有没有真的贴近这道题"。
 *   它之所以安全，是因为它只在口令正确时才被构造出来 ——
 *   不带口令的请求根本走不到这个函数。
 */
export function buildTeacherPayload(session, problem) {
  const hintLog = session.record.hintLog ?? [];
  const byLevel = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const l of hintLog) byLevel[l.deliveredLevel] = (byLevel[l.deliveredLevel] ?? 0) + 1;

  const hitCount = new Map();
  for (const l of hintLog) {
    for (const id of l.misconceptionIds ?? []) hitCount.set(id, (hitCount.get(id) ?? 0) + 1);
  }

  /**
   * 路径进度：这一节课里学生走到过哪些步骤。
   *
   * 与"最后一次定位"不同 —— 学生可能先走到第 5 步、又退回来问第 2 步，
   * 只记最后位置会把中间的轨迹全丢掉。教研复盘要看的恰恰是**轨迹**：
   * "他在第 4 步来回三次"比"他停在第 4 步"信息量大得多。
   */
  const graphId = hintLog.find((l) => l.graphId)?.graphId ?? problem.solutionGraphs[0]?.id ?? null;
  const graph = problem.solutionGraphs.find((g) => g.id === graphId) ?? problem.solutionGraphs[0];
  const stepTotal = graph?.steps?.length ?? 0;
  const reached = new Set();
  const visitsByStep = new Map();
  for (const l of hintLog) {
    if (typeof l.stepIndex !== 'number') continue;
    for (let i = 1; i < l.stepIndex; i += 1) reached.add(i); // 走过的（推断）
    reached.add(l.stepIndex);
    visitsByStep.set(l.stepIndex, (visitsByStep.get(l.stepIndex) ?? 0) + 1);
  }
  const lastLocated = [...hintLog].reverse().find((l) => typeof l.stepIndex === 'number')?.stepIndex ?? null;

  return {
    sessionId: session.id,
    createdAt: session.createdAt,
    problem: {
      id: problem.id,
      source: problem.source ?? 'library',
      subject: problem.subject,
      topics: problem.topics,
      difficulty: problem.difficulty,
      stem: problem.stem,
      givens: problem.givens,
      asked: problem.asked,
      solutionGraphs: problem.solutionGraphs,
      misconceptions: (problem.misconceptions ?? []).map((m) => ({
        id: m.id,
        label: m.label,
        rootCause: m.rootCause,
        hitCount: hitCount.get(m.id) ?? 0,
      })),
      referenceAnswer: problem.referenceAnswer,
      answerFingerprints: problem.answerFingerprints ?? [],
      formulaFingerprints: problem.formulaFingerprints ?? [],
      solutionInsights: problem.solutionInsights ?? [],
      importMeta: getImportMeta(problem.id),
    },
    turns: hintLog.map((l, i) => ({
      index: i + 1,
      utterance: l.utterance ?? '',
      hintText: l.hintText ?? '',
      studentMessage: l.message ?? '',
      deliveredLevel: l.deliveredLevel,
      levelName: LEVEL_NAMES[l.deliveredLevel] ?? '-',
      stuckKind: l.stuckKind,
      stepIndex: l.stepIndex ?? null,
      stepTitle: l.stepTitle ?? null,
      graphId: l.graphId ?? null,
      misconceptionIds: l.misconceptionIds ?? [],
      misconceptionLabels: (l.misconceptionIds ?? [])
        .map((id) => problem.misconceptions?.find((m) => m.id === id)?.label)
        .filter(Boolean),
      guardPassed: l.guardPassed,
      repairStrategy: l.repairStrategy ?? null,
      violationKinds: l.violationKinds ?? [],
      guardViolations: l.guardViolations ?? [],
      evidenceQuotes: l.evidenceQuotes ?? [],
      rationale: l.rationale ?? '',
      voice: l.voice ?? null,
      trace: l.trace ?? [],
    })),
    summary: {
      totalTurns: hintLog.length,
      byLevel,
      guardBlocked: hintLog.filter((l) => !l.guardPassed).length,
      levelProgression: hintLog.map((l) => l.deliveredLevel),
      /** 路径进度图用：这条路径有几步、走到过哪几步、最后停在哪 */
      pathProgress: {
        graphId,
        graphName: graph?.name ?? null,
        stepCount: stepTotal,
        reachedSteps: [...reached].sort((a, b) => a - b),
        lastLocatedStep: lastLocated,
        /** 每一步被问了几轮 —— 数值大的那一步就是真正的卡点 */
        visitsByStep: [...visitsByStep.entries()].map(([stepIndex, count]) => ({ stepIndex, count })).sort((a, b) => a.stepIndex - b.stepIndex),
        steps: (graph?.steps ?? []).map((s) => ({
          index: s.index,
          title: s.title,
          kind: s.kind,
          reached: reached.has(s.index),
          isCurrent: s.index === lastLocated,
          visits: visitsByStep.get(s.index) ?? 0,
        })),
      },
      /** 给教研的一句提醒：这个数是"帮助强度"，不是学生水平 */
      locateAccuracyNote:
        '定位为双通道交叉校验结果：关键词通道（学生原话）优先于语义通道（模型推断）。冲突时会显式记录在 trace 里。',
    },
  };
}

/** 教学总览：跨会话的聚合成果（教师页顶部用） */
export function buildTeacherOverview() {
  const now = Date.now();
  const live = [...sessions.values()].filter((s) => now - s.touchedAt <= SESSION_TTL_MS);

  const byLevel = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const stuckKinds = new Map();
  const misHits = new Map();
  let turns = 0;
  let blocked = 0;

  for (const s of live) {
    for (const l of s.record.hintLog ?? []) {
      turns += 1;
      byLevel[l.deliveredLevel] = (byLevel[l.deliveredLevel] ?? 0) + 1;
      if (!l.guardPassed) blocked += 1;
      stuckKinds.set(l.stuckKind, (stuckKinds.get(l.stuckKind) ?? 0) + 1);
      for (const id of l.misconceptionIds ?? []) misHits.set(id, (misHits.get(id) ?? 0) + 1);
    }
  }

  return {
    registry: registryStats(),
    sessions: live.length,
    sessionsDetail: live.map((s) => {
      const p = getProblemById(s.problemId);
      return {
        sessionId: s.id,
        problemId: s.problemId,
        problemSource: p?.source ?? 'unknown',
        topics: p?.topics?.slice(0, 3) ?? [],
        turns: (s.record.hintLog ?? []).length,
        startedAt: s.createdAt,
        lastActiveAt: new Date(s.touchedAt).toISOString(),
      };
    }),
    summary: {
      turns,
      byLevel,
      guardBlocked: blocked,
      /** 卡点性质分布：教研最关心的"学生普遍卡在哪一类" */
      stuckKindDistribution: [...stuckKinds.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
      topMisconceptions: [...misHits.entries()]
        .map(([id, count]) => ({ id, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
    },
    note: '统计口径：内存中的活跃会话（TTL 2 小时）。冷启动会清零 —— 这是 PoC 的存储取舍，不是数据丢失 bug。',
  };
}

export { sessions, SESSION_TTL_MS, MAX_SESSIONS, sendJson, sendText, readJson, getAdapter };
