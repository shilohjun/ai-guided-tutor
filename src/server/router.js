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
 * 学生视图 = 白名单投影
 * ============================================================================
 * /api/chat 返回的每一个字段都是"挑出来给学生看的"，而不是"把内部数据打码后再发"。
 * 学生载荷里没有解题路径、没有答案指纹、没有错因标签、没有完整解析。
 *
 * 为什么用"白名单投影"而不是"打码"：打码依赖"记得打哪里"，漏一处就是泄题；
 * 白名单反过来 —— 漏一处只是少说一句话，不会多说一句不该说的话。
 *   这个取舍与 guard 用封闭词表而不是黑名单是同一条思路。
 *
 * 关于会话状态（serverless 下的已知局限，写在明处）：
 *   会话存在进程内存里。本地运行时完全没问题；
 *   serverless 下只在"热实例"期间有效，冷启动或换实例会丢。
 *   因此这里加了 TTL 清理，并且前端对"会话不存在"做了友好降级。
 *   PoC 阶段刻意不引持久化存储 —— 换来的是零依赖，代价是长间隔的对话可能丢上下文。
 *   导入的题目也一样（见 registry.js：用内容哈希做 id，丢了就重新生成同一个 id）。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { loadEnvFile, maskSecret } from '../core/env.js';
import { createAdapter, readLLMConfig } from '../core/llm.js';
import { readOcrConfig, recognizeProblemImage, ocrStatus } from '../core/ocr.js';
import { createEngine } from '../core/engine.js';
import { totalSteps, findStepByPosition } from '../core/locate.js';
import { safeStepRef } from '../core/guard.js';
import { understandProblem } from '../core/intake.js';
import { getProblemById, listProblems, getImportMeta, getProblemAnalysis, registerImportedProblem, registryStats } from '../core/registry.js';
import { toStudentAnalysis } from '../core/analysis.js';
import { createSessionRecord, appendTurn, buildReport } from '../core/report.js';
import { formulaCardFor } from '../core/formula-cards.js';
import { looksLikeHelpRequest } from '../core/route.js';
import { runEvaluation, formatEvaluation } from '../core/eval.js';
import { STUDENT_LEVEL_NOTE, inspectVoice } from '../core/prompt.js';
import { PROBLEMS } from '../core/problems.data.js';
import { DEFAULT_PERSONA, PERSONA_IDS, PERSONAS, normalizePersona, personaById, stylePersonaReply } from '../core/personas.js';

loadEnvFile();

/**
 * 请求级配置源 —— 公网口令门能成立的前提。
 *
 * 为什么不能直接改 process.env：
 *   口令门要求「带口令的请求用真模型、不带口令的用离线桩」这两种形态
 *   在**同一个实例**上共存。而 serverless 的一个实例会连续处理多个请求，
 *   process.env 又是进程级的 —— 只要靠「进请求时删 Key、出请求时还原」，
 *   并发一交错就会串号：没带口令的人白捡到上一个请求留下的真模型。
 *   那等于加了口令和没加一样，而且极难复现。
 *
 * AsyncLocalStorage 是 Node 原生的请求作用域存储：每次请求开一份独立配置，
 * 下游代码通过 envFor() 拿到的永远是「这次请求的」那份。
 * 本地服务器（server/server.js）不包这一层，envFor() 直接退回 process.env，
 * 所以本地行为一个字节都不用变。
 */
export const requestEnv = new AsyncLocalStorage();

/** 当前请求的配置源；没有请求上下文时退回进程环境（本地开发 / 直接调用测试） */
export function envFor() {
  return requestEnv.getStore() ?? process.env;
}

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
/**
 * adapter 缓存按「形态」分键，而不是单例。
 *
 * 单例在口令门下会翻车：同一个实例上，带口令的请求先建了真模型 adapter，
 * 之后没带口令的请求会直接复用这个缓存 —— 又回到串号。
 * 键只取「有没有可用 Key」，因为配置的其余部分（baseUrl / model）来自同一份 env 形状，
 * 同一形态下不会变。
 */
const adapters = new Map();

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

function adapterTagFor(env) {
  const apiKey = String(env.LLM_API_KEY ?? '').trim() || String(env.OPENAI_API_KEY ?? '').trim();
  if (!apiKey) return 'offline';

  /**
   * 缓存键必须带上配置指纹，不能只用 'llm'。
   *
   * 只用 'llm' 会有一个隐藏的错配：同一个进程里如果出现过两份不同的模型配置
   * （例如测试里用假配置、而进程环境里带着真配置），后一份会复用前一份的 adapter ——
   * 表现是"配了 A 模型，健康检查却报 B 模型"。生产环境配置是固定的所以看不出来，
   * 但这属于"只在特定顺序下发作"的坑，不值得留。
   *
   * 指纹取 Key 的长度与首尾各 2 位，而不是 Key 本身：足够区分不同配置，
   * 又不会把完整凭据长期当作字典键留在内存里。
   */
  const fingerprint = `${apiKey.length}:${apiKey.slice(0, 2)}${apiKey.slice(-2)}`;
  return `llm|${String(env.LLM_BASE_URL ?? '').trim()}|${String(env.LLM_MODEL ?? '').trim()}|${fingerprint}`;
}

function getAdapter() {
  const env = envFor();
  const tag = adapterTagFor(env);
  if (!adapters.has(tag)) adapters.set(tag, createAdapter(env));
  return adapters.get(tag);
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
  const adapterTag = adapterTagFor(envFor());
  if (!s || s.problemId !== problemId) {
    s = {
      id: sessionId,
      problemId,
      engine: createEngine({ adapter: getAdapter(), problem: problemId ? getProblemById(problemId) : null }),
      adapterTag,
      history: [],
      record: createSessionRecord(problemId),
      createdAt: new Date().toISOString(),
      touchedAt: now,
    };
    sessions.set(sessionId, s);
  } else if (s.adapterTag !== adapterTag) {
    /**
     * 会话的"模型形态"变了，必须换引擎。
     *
     * 为什么不能沿用：engine 持有创建时那个 adapter，它决定了这一轮是真模型还是规则桩。
     * 会话是按 sessionId 缓存的，而同一个 sessionId 完全可能先后出现在两种形态下 ——
     * 比如有人先用公开链接（离线桩）建了会话，之后再带口令进来；
     * 更危险的是反过来：带口令建的会话被没口令的人接着用，就能白蹭真模型。
     *
     * 所以这里以"这一次请求的形态"为准重建引擎，历史对话保留
     * （history 是引擎的输入而不是引擎的一部分，换引擎不会丢上下文）。
     */
    s.engine = createEngine({ adapter: getAdapter(), problem: problemId ? getProblemById(problemId) : null });
    s.adapterTag = adapterTag;
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


/**
 * 把"已走过的步骤号"翻译成学生可读的步骤名。
 *
 * 单一出口：所有名字都过 safeStepRef，不在这里自己拼标题 ——
 * 一旦这里自己拼，就会出现"界面比提示更早说出结论"的口子。
 */
function stepLabelsFor(problem, graphId, completed) {
  const out = {};
  if (!problem || !Array.isArray(completed)) return out;
  for (const index of completed) {
    const step = findStepByPosition(problem, { graphId, stepIndex: index });
    const ref = safeStepRef(problem, step);
    if (ref) out[index] = ref.replace(/^「|」$/g, '');
  }
  return out;
}

/**
 * 学生可见的一轮回复。
 *
 * 这个函数是"学生拿不到教研数据"的**唯一执行点** ——
 * 想确认某个字段有没有外泄，只看这里就够了。
 */
export function buildStudentTurn(response, mode, problem, personaValue = DEFAULT_PERSONA, turn = 0) {
  const d = response.diagnosis;
  const guardBlocked = (response.meta.guardHistory ?? []).filter((g) => !g.passed).length;
  const stepCount = response.stepCount ?? 0;
  const personaId = normalizePersona(personaValue);
  const persona = personaById(personaId);
  /**
   * 哪些回复需要补一层措辞。
   *
   * 两种情况：
   *   ① 离线桩：它从来没有收到过《教学规范》与语言风格，所以整轮都要补；
   *   ② 守卫兜底 / 确认 / 静默：这三类**不是模型写的**，是我方模板写的 ——
   *      真模型那条路径上它们同样没有老师口气，所以也要补。
   * 真模型正常起草的那一轮不再套，否则等于把同一套风格叠加两次。
   */
  const ours = ['fallback', 'confirm', 'silent'].includes(response.hint.form);
  const styleIt = String(response.meta.engine).startsWith('offline') || ours;
  const visible = styleIt
    ? stylePersonaReply(personaId, {
        text: response.hint.text,
        nextAsk: response.hint.nextAsk,
        form: response.suppressed ? 'silent' : response.hint.form,
        level: response.hint.level,
        turn,
      })
    : { text: response.hint.text, nextAsk: response.hint.nextAsk };

  return {
    message: response.message,
    persona: { id: personaId, name: persona.name, avatar: persona.avatar },
    hint: {
      level: response.hint.level,
      levelName: LEVEL_NAMES[response.hint.level] ?? '-',
      /** 给学生的人话版本（教研名对学生只会造成"我被分类了"的观感） */
      levelNote: STUDENT_LEVEL_NOTE[response.hint.level] ?? '',
      form: response.hint.form,
      text: visible.text,
      concepts: response.hint.concepts,
      nextAsk: visible.nextAsk,
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
      /**
       * 已走过步骤的**可公开名字**（键 = 步号，值 = 这一句在做什么）。
       *
       * 为什么只给"已走过"的：未走到的步骤标题等于提前泄题 ——
       * 学生看到"第 6 步：用匀速条件做受力平衡"，就等于拿到了下一步该干什么。
       * 已走完的步骤再告诉他叫什么，是复盘，不是剧透。
       *
       * 取值一律走 safeStepRef（与提示文案、学习报告同一条出口规则）：
       * 推导 / 结论类步骤会自动退化成"第 N 步（推导）"，
       * 因此这里**没有新增任何暴露面**，只是把同一套规则再用一次。
       */
      stepLabels: stepLabelsFor(problem, d.position.graphId, d.position.completedSteps ?? []),
      /** 只给"有多确定"的粗档，不给 0.55 这种数字（学生会追问 0.55 是什么） */
      confidenceLabel: d.position.confidence >= 0.7 ? '高' : d.position.confidence >= 0.5 ? '中' : '低',
    },
    enginePath: response.enginePath ?? [],
    /** 学生已经想对的地方 —— 学习反馈的主角 */
    understood: d.strengths ?? [],
    nextStep: visible.nextAsk ?? null,
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
    const env = envFor();
    const config = readLLMConfig(env);
    const adapter = getAdapter();
    sendJson(res, 200, {
      ok: true,
      /**
       * 口令门形态：'off' 未配置口令 / 'locked' 配了但没带对 / 'unlocked' 已放行。
       * 只报形态，绝不回传口令本身 —— 健康检查不是用来泄密的。
       */
      demoGate: req.__demoGate ?? 'off',
      engine: adapter.kind,
      model: adapter.model ?? null,
      llmConfigured: config.available,
      llmBaseUrl: config.available ? config.baseUrl : null,
      keyMask: config.available ? maskSecret(config.apiKey) : null,
      problemCount: PROBLEMS.length,
      registry: registryStats(),
      /**
       * 拍照识题状态：只报"配没配 / 走哪个通道"，**绝不回传 AppCode**。
       * 与 llmConfigured 同一口径 —— 健康检查是用来判断可用性的，不是用来泄密的。
       */
      ocr: ocrStatus(env),
      capabilities: {
        /**
         * 本部署支持的学习方式。
         * 只列真实上线的：AI 伴学（陪着一步步想）尚未上线，前端按这份清单
         * 渲染 —— 不在清单里的模式显示为禁用并标「暂未更新」，而不是假装能点。
         */
        modes: ['self_training'],
        intake: typeof adapter.understandProblem === 'function',
        intakeFallback: true,
        /** 拍图识题：配了凭据才为 true；前端据此决定是否显示拍照入口 */
        ocr: readOcrConfig(env).available,
        /**
         * 可选的陪学老师。
         *
         * 前端在 index.html 里保留一份同样的展示投影（图片路径、一句简介），
         * 目的是首屏在 /api/health 返回前就能画出来；test/personas.test.js
         * 会核对两份的名字与路径，避免服务端和页面各改各的。
         */
        personas: PERSONA_IDS.map((id) => {
          const p = PERSONAS[id];
          return { id: p.id, name: p.name, tagline: p.tagline, intro: p.intro, quote: p.quote, avatar: p.avatar, fullBody: p.fullBody };
        }),
        /** 默认是谁；前端在没存过偏好时用它 */
        defaultPersona: DEFAULT_PERSONA,
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

  // ---- GET /api/related?id=xxx（巩固页：同一知识点的同类题） ----
  /**
   * 为什么放在服务端而不是前端从题库里筛：
   *   题库以后会变成"导入题 + 校本题 + 爬取题"的混合体，筛选规则一旦写进前端，
   *   每接一个来源就要改一次界面代码。规则只留一处，界面只负责渲染。
   */
  if (path === '/api/related' && req.method === 'GET') {
    const id = url.searchParams.get('id');
    const base = getProblemById(id);
    if (!base) {
      sendJson(res, 404, { error: `未找到题目 ${id}` });
      return true;
    }
    sendJson(res, 200, { problems: relatedProblems(base) });
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

    const ocrEnv = envFor();
    const config = readOcrConfig(ocrEnv);
    if (!config.available) {
      sendJson(res, 503, {
        error: ocrStatus(ocrEnv).hint,
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
          ? '这次调用可能已经产生费用，建议先确认照片是否清晰、是否确实是题目，再决定要不要重试。'
          : result.reason === 'http'
            ? '请求已被服务拒绝，没有可用结果；可以直接重试，或先检查拍照识题的配置。'
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

  // ---- POST /api/chat ----
  if (path === '/api/chat' && req.method === 'POST') {
    const body = await readJson(req);
    const { sessionId, problemId, utterance, mode, explicitHelpSeeking } = body ?? {};
    /**
     * 老师只影响措辞：不认识的值回落到派蒙，不报错 ——
     * 前端存的偏好可能来自旧版本，为一个 id 打回整个请求不值得。
     */
    const persona = normalizePersona(body?.persona);
    if (!problemId || typeof utterance !== 'string') {
      sendJson(res, 400, { error: '需要 problemId 与 utterance' });
      return true;
    }
    const problem = getProblemById(problemId);
    if (!problem) {
      sendJson(res, 404, { error: `未找到题目 ${problemId}。如果是导入的题目，服务重启后需要重新导入。` });
      return true;
    }

    if (mode === 'ai_companion') {
      // 只上线了自主训练：能力位（/api/health 的 capabilities.modes）里没有的模式，
      // 前端点不到、服务端也不接 —— 免得改漏一处就悄悄跑出一个没验收过的模式。
      sendJson(res, 400, { error: 'AI 伴学暂未上线，目前只支持自主训练。', code: 'MODE_UNAVAILABLE' });
      return true;
    }

    const session = getSession(sessionId || 'demo', problemId);
    const normalizedMode = 'self_training';

    let response;
    try {
      response = await session.engine.handleTurn({
        problemId,
        utterance,
        history: session.history,
        mode: normalizedMode,
        // 前端只负责"点了快捷问句"这种显式信号；自由输入由服务端按这句话本身判定，
        // 免得"自主训练"退化成"每句都算求助"或"问破喉咙也没人理"
        explicitHelpSeeking: Boolean(explicitHelpSeeking) || looksLikeHelpRequest(utterance),
        sessionId: session.id,
        persona,
      });
    } catch (error) {
      if (!['OBSERVATION_UNAVAILABLE', 'REPLY_UNAVAILABLE'].includes(error.code)) throw error;
      sendJson(res, 503, { error: error.message, retryable: true });
      return true; // 系统故障不写入学生学习记录。
    }

    const now = new Date().toISOString();
    session.history.push({ role: 'student', text: utterance, at: now });
    if (!response.suppressed) session.history.push({
      role: 'ai',
      text: response.message,
      form: response.hint.form,
      metaStuckKind: response.diagnosis.stuckKind,
      at: now,
      level: response.hint.level,
      metaStep: response.diagnosis.position.stepIndex,
      metaGraphId: response.diagnosis.position.graphId,
    });
    appendTurn(session.record, { utterance, response, problem });

    // 学生载荷 —— 只走白名单投影
    const turnIndex = session.history.filter((t) => t.role === 'ai').length;
    sendJson(res, 200, buildStudentTurn({ ...response, stepCount: totalSteps(problem, response.diagnosis.position.graphId) }, normalizedMode, problem, persona, turnIndex));
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
      const bankId = url.searchParams.get('problemId');
      const bank = bankId && bankId.startsWith('qbank-') ? getProblemById(bankId) : null;
      if (bank) {
        const report = buildReport(bank, createSessionRecord(bank.id), { engine: 'no-conversation' });
        report.meta.recordMissing = true;
        sendJson(res, 200, { report, turns: [] });
        return true;
      }
    }

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

  return false;
}

/**
 * 同类题：先按知识点重合挑，重合的没有才退化成"题库里除它之外的题"。
 *
 * 不按难度排序 —— 巩固的目标是"换个情境把同一条规律再用一次"，
 * 难度跳太多就变成做新题了，反而练不到刚卡住的那一步。
 */
function relatedProblems(base) {
  const mine = new Set(base.topics ?? []);
  const rest = listProblems().filter((p) => p.id !== base.id);
  const same = rest.filter((p) => (p.topics ?? []).some((t) => mine.has(t)));
  return (same.length ? same : rest).slice(0, 6);
}

export { sessions, SESSION_TTL_MS, MAX_SESSIONS, sendJson, sendText, readJson, getAdapter, getSession, adapterTagFor };
