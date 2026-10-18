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
import { readOcrConfig, recognizeProblemImage, ocrStatus } from '../core/ocr.js';
import { createEngine } from '../core/engine.js';
import { totalSteps } from '../core/locate.js';
import { understandProblem } from '../core/intake.js';
import { getProblemById, listProblems, getImportMeta, getProblemAnalysis, registerImportedProblem, registryStats } from '../core/registry.js';
import { toStudentAnalysis, toTeacherAnalysis } from '../core/analysis.js';
import { createSessionRecord, appendTurn, buildReport } from '../core/report.js';
import { formulaCardFor } from '../core/formula-cards.js';
import { demoAnswerFor } from '../core/demo-answers.js';
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

/**
 * 拍照识题的"已验证调用形状"缓存：{ url, imageField }。
 *
 * 为什么要单独一个进程级缓存：云市场商品的接口地址与传图字段名在首次调用前是未知的
 * （商品页的接口文档是前端渲染的图片，抓不到正文），而**每试一个候选就是一次计费调用**。
 * 缓存之后一个进程只探索一次，之后每张图都走已验证的形状。
 * 它是纯优化：丢了只会让下一个进程再探索一次，不影响正确性。
 */
let ocrShape = null;

function resolveCachedShape() {
  return ocrShape;
}

function rememberShape(shape) {
  if (shape?.url && shape?.imageField) ocrShape = shape;
}

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
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      /**
       * 体积上限按**路由**分档，而不是全局一个数。
       *
       * 为什么：拍照识题要把图片 base64 塞进 JSON body，base64 比原图大约 1.33 倍，
       * 一张 640KB 的压缩图约 850KB —— 卡在原来的 1MB 上会随机失败，
       * 而失败信息是"请求体过大"，看起来像网络问题。
       * 但也不能全局放宽：文字类接口（chat/import）本来就不该收到大 body，
       * 放宽等于给所有人一个免费的放大攻击面。
       *
       * 2_600_000 的来由：base64 后 ~1.95MB 图片 ⇒ 原图约 1.46MB，
       * 覆盖"前端压缩到长边 1600px"的正常产出，同时离 Vercel serverless
       * 请求体上限（约 4.5MB）还有安全距离。
       */
      const limit = String(req.url ?? '').startsWith('/api/ocr') ? 2_600_000 : 1_000_000;
      if (size > limit) {
        aborted = true;
        /**
         * 超限之后：**既不 destroy，也不 pause，只是停止累积**。
         *
         * 这两个坑都是实测踩出来的（路由层测试抓到的）：
         *   · req.destroy() —— 会在响应写出去之前掐断 socket，
         *     客户端看到的是一句 "fetch failed / connection reset"，
         *     而不是我们精心写的 413 + "图片太大"。学生会以为网络不好，反复重试，
         *     而每次重试都在烧调用次数。
         *   · req.pause() —— 客户端在等响应、服务端在等 body，直接死锁（测试挂住）。
         *
         * 正确做法：让请求体继续流完但**一个字节都不再存**（chunks 不再 push，
         * 内存占用封顶在 limit 附近，不会随上传大小增长），
         * 由调用方立刻写出 413。客户端收到响应即停止上传。
         */
        reject(new Error(limit > 1_000_000 ? '图片太大，请压缩后重试' : '请求体过大'));
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
      /**
       * 拍照识题状态：只报"配没配 / 走哪个通道"，**绝不回传 AppCode**。
       * 与 llmConfigured 同一口径 —— 健康检查是用来判断可用性的，不是用来泄密的。
       */
      ocr: ocrStatus(),
      capabilities: {
        intake: typeof adapter.understandProblem === 'function',
        intakeFallback: true,
        /** 拍图识题：配了凭据才为 true；前端据此决定是否显示拍照入口 */
        ocr: readOcrConfig().available,
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

  // ---- POST /api/ocr（题目照片 → 题干文本） ----
  /**
   * 这一环**只做一件事**：把图变成文字。它不导入题目。
   *
   * 为什么故意不在这里顺手调 /api/problem/import：
   *   OCR 约 0.083 元/次，而识别错了会导致读题链路生成一张错图谱 ——
   *   而那张错图谱不会报错，只会让后面的提示全都跑偏。
   *   所以识别结果先回填到输入框，**由学生看一眼、改掉错字，再点"读懂这道题"**。
   *   这一步把 OCR 错误从"故障"降级成"可修正的输入"，是整个接入里最划算的设计。
   */
  if (path === '/api/ocr' && req.method === 'POST') {
    const body = await readJson(req).catch((err) => ({ __error: err.message }));
    if (body?.__error) {
      sendJson(res, 413, { error: body.__error });
      return true;
    }

    const image = typeof body?.image === 'string' ? body.image : '';
    if (!image) {
      sendJson(res, 400, { error: '缺少图片数据（image 字段需要是 dataURL 或 base64 字符串）' });
      return true;
    }
    /**
     * 前置体积校验：**在调用之前**拦掉过大的图。
     * 为什么重要：这类接口对"图片过大"是**返回业务错误码并计费**的，
     * 也就是说学生上传一张 5MB 原图，我们会为一个必然失败的请求付钱。
     */
    const approxBytes = Math.floor((image.length - (image.indexOf(',') + 1)) * 0.75);
    if (approxBytes > 1_500_000) {
      sendJson(res, 413, {
        error: `图片约 ${(approxBytes / 1024 / 1024).toFixed(1)} MB，超过识别上限（约 1.5 MB）。前端应压缩到长边 1600 像素后再上传。`,
      });
      return true;
    }

    const config = readOcrConfig();
    if (!config.available) {
      sendJson(res, 503, {
        error: ocrStatus().hint,
        hint: '拍照识题是可选能力：未配置时请使用左侧的「粘贴题目文字」入口，那条链路完全可用。',
      });
      return true;
    }

    /**
     * 命中过的调用形状缓存在进程里。
     *
     * 为什么要缓存：候选形状（地址 + 传图字段名）在首次调用前是未知的，
     * 每换一个候选就是一次计费调用。缓存之后，**一个进程只探索一次**，
     * 之后每张图都走已验证的形状。
     */
    const cached = resolveCachedShape();
    const result = await recognizeProblemImage(image, {
      /** shape 优先级最高：命中过就直接用它，不再走候选轮换（轮换是要花钱的） */
      config: cached ? { ...config, shape: cached } : config,
    });

    if (result.ok && result.shape) rememberShape(result.shape);

    if (!result.ok) {
      /**
       * 失败也要给学生**可操作**的话，而不是一个原始错误码。
       * 并且明确区分"没扣费"（网络层失败）与"可能已扣费"——
       * 前者可以放心重试，后者重试就是再花钱。
       */
      sendJson(res, result.reason === 'not_configured' ? 503 : 502, {
        error: result.message,
        reason: result.reason,
        code: result.code ?? null,
        detail: result.detail ?? null,
        charged: result.charged,
        hint: result.charged
          ? '这次调用可能已经计费，建议先确认照片是否清晰、是否确实是题目，再决定要不要重试。'
          : '这次请求没有到达识别服务（未计费），可以直接重试。',
      });
      return true;
    }

    sendJson(res, 200, {
      rawText: result.rawText,
      /** 有配图时提醒：题干文本里可能缺图形信息（坐标给不出"图里画了什么"） */
      figureCount: Array.isArray(result.figures) ? result.figures.length : 0,
      latencyMs: result.latencyMs,
      provider: result.provider,
      /** 首次探索花的候选次数（1 = 一次命中）；正常稳定后恒为 1 */
      attempts: result.attempts,
      /** 明确告诉前端：这一步只是拿到了文字，**还没有导入** */
      nextStep: 'edit_then_import',
    });
    return true;
  }

  // ---- POST /api/problem/import（新题目文字 → 结构化题目） ----
  if (path === '/api/problem/import' && req.method === 'POST') {
    /**
     * body 解析失败要自己接住并回 413/400。
     * 不接的话会冒泡到 server 的最外层 catch 变成 500 "内部错误" ——
     * 而"题干太长"本来是用户能自己解决的事，报 500 等于把责任推给系统。
     */
    const body = await readJson(req).catch((err) => ({ __error: err.message }));
    if (body?.__error) {
      sendJson(res, 413, { error: body.__error });
      return true;
    }
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

  // ---- POST /api/demo/answer ----
  /**
   * 演示模式专用：只在演示者点击“我已做出答案（演示）”时返回最终结果。
   * 不是学生端接口 —— 必须显式带 demo:true，避免被普通页面误用。
   */
  if (path === '/api/demo/answer' && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    if (body?.demo !== true) {
      sendJson(res, 403, { error: '这个接口只用于演示模式。' });
      return true;
    }
    const problemId = String(body?.problemId ?? '');
    const answer = demoAnswerFor(problemId);
    if (!answer) {
      sendJson(res, 404, { error: '这道题暂时没有演示答案。' });
      return true;
    }
    sendJson(res, 200, answer);
    return true;
  }

  // ---- POST /api/formula ----
  /**
   * 公式卡：只在同一步已经给过 L3 之后开放，内容来自教研维护的知识点表。
   *
   * 不把公式放进 /api/problem 的响应里 —— 那样学生打开 F12 就能提前看到；
   * 也不让模型生成 —— 模型写公式正是防泄题要拦的东西。
   */
  if (path === '/api/formula' && req.method === 'POST') {
    const body = await readJson(req);
    const sessionId = String(body?.sessionId ?? '');
    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: '这个学习会话不存在或已过期，请重新开始一道题。' });
      return true;
    }
    const problem = getProblemById(session.problemId);
    if (!problem) {
      sendJson(res, 404, { error: '这道题已不在题库里。' });
      return true;
    }
    const l3 = [...session.record.hintLog].reverse().find((log) => log.deliveredLevel === 3);
    if (!l3) {
      sendJson(res, 409, { error: '公式卡要在同一步给过 L3 提示之后才能用。' });
      return true;
    }
    const card = formulaCardFor(problem);
    if (!card) {
      sendJson(res, 404, { error: '这道题暂时没有匹配的公式卡。' });
      return true;
    }
    session.record.formulaCards = session.record.formulaCards ?? [];
    session.record.formulaCards.push({ at: new Date().toISOString(), topic: card.topic, stepIndex: l3.stepIndex ?? null });
    sendJson(res, 200, { card });
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
