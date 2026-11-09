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
 *
 *   试点之后存储端口（src/server/store/）已经就位，账号与令牌走它；
 *   现在会话本身也写穿了：/api/chat、/api/formula、/api/report、/api/reset
 *   每一处成功之后都把会话快照写进库，冷启动再从库里回载（见 session-store.js）。
 *   内存 Map 仍然保留 —— 它是热路径的缓存，不是唯一副本。
 *   serverless 下的"间隔较久"问题因此只剩导入题目（内存注册表，TTL 6 小时）。
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
import { openStore } from './store/index.js';
import { checkLoginRate, login, noteLoginFailure, noteLoginSuccess } from './auth.js';
import { ownerOf, recordEvent, validateEvent } from './events.js';
import { resolveUser, tokenFromHeaders } from './demo-gate.js';
import {
  createLiveSession,
  createVisit,
  hydrateSession,
  persistReset,
  persistSession,
  pickResumable,
  readSessionRecord,
  SessionReadError,
  snapshotSession,
} from './session-store.js';

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

/**
 * 存储的进程级单例。
 *
 * 缓存的为什么是 Promise 而不是 Store 实例：`openStore` 是异步的，
 * 两个请求同时到达时各开一次，memory 驱动就会变成两个互不相干的库
 * （file 驱动也会白开一次目录）。缓存 Promise 让并发请求等同一个打开动作。
 *
 * 打开失败要清掉缓存：否则一次瞬时故障（目录没权限、云 SDK 还没装）
 * 会把这个进程永久钉在一个 rejected promise 上 —— 之后每个请求都 500，
 * 直到实例重启，而重启之后故障可能已经消失了。
 *
 * `STORE` 没配时是 memory，所以本地与现有测试的行为一个字节都不变。
 */
let storePromise = null;

export function getStore() {
  if (!storePromise) {
    storePromise = openStore(envFor());
    storePromise.catch(() => {
      storePromise = null;
    });
  }
  return storePromise;
}

/**
 * 测试钩子：把单例丢掉，下一次 `getStore()` 按当时的 env 重新打开。
 *
 * 为什么必须有它：单例是进程级的，而"冷启动还在不在"这件事只能靠
 * "换一个 STORE_DIR 再看一次"来验（file 驱动每次读盘，所以换目录就是换库）。
 * 名字带下划线是明示：生产代码不该调它 —— 调了之后同一个进程里会出现两个库。
 */
export function __resetStoreForTests() {
  storePromise = null;
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

/**
 * 取会话；顺带做过期清理。
 *
 * 它是**内存**的访问器（与存储端口的 `store.getSession` 同名但不是一回事）：
 * 命中就返回同一个对象，没命中才现造一个。落库与回载不在这里，见 restoreSession。
 */
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
    /** 默认形状（含 progress / counters / 时间戳）只在 session-store.js 里定义一份 */
    s = createLiveSession({
      id: sessionId,
      problemId,
      engine: createEngine({ adapter: getAdapter(), problem: problemId ? getProblemById(problemId) : null }),
      adapterTag,
      now,
    });
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

/**
 * 会话是别人的（C10）—— 归属规则的唯一说明在 `notMine` 上方那段注释里。
 *
 * 为什么用异常而不是再塞一个 `null`：`null` 已经是"这条会话不存在"，
 * 两者混用就一定会出现"别人的 → 当成没有 → 现造一条新的"（评审 Important 1 的洞）。
 * 翻转成 403 的地方是 `restoreForRoute`，四条受保护的路由都走它。
 */
class NotOwnerError extends Error {
  constructor(owner) {
    super('这不是你的学习记录');
    this.name = 'NotOwnerError';
    this.code = 'NOT_OWNER';
    this.owner = owner ?? null;
  }
}

/**
 * 回载：内存命中就直接用，否则从库里读回来、重建引擎、放回内存。
 *
 * 顺序是刻意的 —— **先看内存再看库**：
 *   · 热路径上不能每轮都读一次盘；
 *   · 内存里那份带着这一轮刚推进的状态，比库里上一次写穿的更"新"。
 *
 * 返回 null 的含义是"这条会话没法复活"，调用方各有各的答法：
 *   · 库里没有这条（含 problemId 对不上）→ /api/chat 现造一条，/api/report 走 404；
 *   · 题目已经不在注册表（照片/粘贴题过了 TTL）→ 只有报告还能说有快照的那份。
 *
 * 另外两种失败**不伪装成 null**（伪装过一次，代价是静默覆盖别人的记录）：
 *   · 库读不出来 → 抛 `SessionReadError`（调用方回 503，且不许写穿）；
 *   · 会话是别人的 → 抛 `NotOwnerError`（调用方回 403）。
 *
 * 注意 `problemId` 传 null 表示"不限定题目"（/api/formula、/api/report 只知道
 * sessionId）。这时以库里的 problemId 为准，不会拿一个空 id 去查题目表。
 *
 * @param {object} store
 * @param {string} sessionId
 * @param {string|null} problemId
 * @param {{user: object, batchId: string|null}|null} me 调用者身份（没登录就是 null）
 */
export async function restoreSession(store, sessionId, problemId, me = null) {
  const hot = sessions.get(sessionId);
  if (hot && (!problemId || hot.problemId === problemId)) {
    /** 走 getSession 而不是直接返回：TTL 清理与"形态变了要换引擎"都在那里 */
    return getSession(sessionId, hot.problemId);
  }
  if (!store || !sessionId) return null;

  const record = await readSessionRecord(store, sessionId);
  if (!record) return null;

  /**
   * 归属必须在**任何替换之前**判（评审 Important 1）。
   *
   * 放到 `problemId` 比对之后就晚了：对不上会先返回 null，调用方于是
   * `getSession(...)` 现造一条 `userId: null` 的新会话 —— "这是别人的"被洗成
   * "这是一条新会话"，`notMine` 对空归属放行，随后的写穿把原主人的记录整条盖掉。
   * 归属只从**库里的记录**读（`record.userId`），不看请求参数。
   */
  if (notMine(record, me)) throw new NotOwnerError(record.userId);

  if (problemId && record.problemId !== problemId) return null;

  const liveProblem = getProblemById(record.problemId);
  const live = hydrateSession(record, {
    /**
     * 题目没了就**没有引擎**：这个对象只用于读（报告快照、公式卡判断）。
     * 绝不放进内存表 —— 放进去了 /api/chat 会拿到一个没有引擎的会话并当场崩。
     */
    engine: liveProblem ? createEngine({ adapter: getAdapter(), problem: liveProblem }) : null,
    adapterTag: adapterTagFor(envFor()),
  });
  if (!live.engine) return live;

  sessions.set(sessionId, live);
  /** 再走一遍 getSession：TTL 清理、形态判定都不必在这里重复一遍 */
  return getSession(sessionId, live.problemId);
}

/** 库读不出来：**可重试**，措辞要让人知道刷新一下就好，而不是去重开一道题 */
function sendStoreUnreadable(res) {
  sendJson(res, 503, { error: '读取学习记录失败，请刷新页面重试。', retryable: true });
}

/**
 * 回载 + 两种失败的统一答法 —— **四条受保护的路由都走它**（chat / formula / report / reset）。
 *
 * 返回 `{ replied: true }` 表示已经答复过（调用方直接 `return true`）；
 * 否则返回 `{ session }`，其中 null 仍是"库里确实没有这条"——新建还是 404
 * 由各路由自己决定（chat 是"开始一道新题"，report 是 404）。
 *
 * 这两种失败都不许落到"现造一条新会话"上：读失败时那条新会话会盖掉真记录，
 * 归属失败时等于让别人接着写你的历史。
 */
async function restoreForRoute(res, store, sessionId, problemId, me) {
  try {
    return { session: await restoreSession(store, sessionId, problemId, me) };
  } catch (err) {
    if (err instanceof NotOwnerError) {
      sendNotOwner(res);
      return { replied: true };
    }
    if (err instanceof SessionReadError) {
      sendStoreUnreadable(res);
      return { replied: true };
    }
    throw err;
  }
}

/** 落库快照 —— 从 router 导出是为了让测试与后续任务按计划的那一处取 */
export { snapshotSession };

// ---------------------------------------------------------------------------
// 响应工具（统一封装，本地与 serverless 共用）
// ---------------------------------------------------------------------------

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
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

/**
 * 这次请求算谁。
 *
 * `x-forwarded-for` 取**第一段**：代理会把自己一层层追加在后面，
 * 第一段才是客户端地址；整串拿来当键，等于每个 IP 都算成新的一个。
 * 没有这个头（本地直连）时退回 socket 地址 —— 拿不到就统一记 'unknown'。
 * `'unknown'` 这一桶**不参与 IP 维度的锁**（锁它等于锁所有人），
 * 原因与代价写在 auth.js 的 `checkLoginRate` 上。
 *
 * 前提（按 IP 限速的通用前提，不是这一段能解决的）：部署层必须**自己写**这个头。
 * 若它把客户端带来的 XFF 原样透传，那么每发一个请求换一个伪造的 XFF 就能绕过限速 ——
 * 遇到这种部署形态，限速要改成按"口令+IP"或加一层 TTL 缓存来兜底。
 */
function clientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = String(raw ?? '').split(',')[0].trim();
  return first || req.socket?.remoteAddress || 'unknown';
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
// 请求身份（C1）
// ---------------------------------------------------------------------------

/**
 * 这一次请求算谁 —— **每个请求只解一次**，下游一律读 `req.__user`。
 *
 * 为什么放在 router 而不是入口（api/index.js、api/worker.js）：
 *   store 的配置来自**这次请求的 env**（Workers 的库配置就在 env 绑定里），
 *   而入口调 `buildRequestContext` 的时候 `requestEnv` 还没被 `run` 起来。
 *   在入口解析会拿到一个用进程环境打开的库；在 router 里解析才拿得到正确的那份。
 *
 * 为什么要判"有没有带令牌"才读库：
 *   没带令牌的请求连 store 都不碰，于是**不配登录守卫时行为一个字节都不变**
 *   （现有 400+ 用例里绝大多数请求都不带令牌）。
 *
 * 解析失败（令牌过期、库读不出来）一律按未登录处理，不抛 500：
 *   一个坏库不该让所有请求变成"内部错误"，那样连"请先登录"都发不出去。
 *
 * @param {object} req
 * @returns {Promise<{user: object, batchId: string|null}|null>}
 */
async function resolveRequestUser(req) {
  /** 入口或测试可以预置（预置了就照用，不再读库） */
  if (req.__user !== undefined) return req.__user;
  if (!tokenFromHeaders(req.headers)) return null;

  const store = await getStore().catch(() => null);
  if (!store) return null;
  return resolveUser({ headers: req.headers, store });
}

/**
 * 登录守卫（C1）：`PILOT_REQUIRE_LOGIN=1` 时，除健康检查与登录之外一律 401。
 *
 * 两个例外各有理由：
 *   · `/api/health` —— 监控与部署校验要能问"你还活着吗"，把它挡在登录后面
 *     等于一个配错的环境连"哪里配错了"都看不到；
 *   · `/api/auth/login` —— 挡住它就没有任何人能登录了。
 *
 * **不配这个变量时完全不存在这条分支**：本地开发、现有测试、公网离线 Demo
 * 都照旧可用（设计稿要求的是"试点环境必须登录"，不是一个全局的强制开关）。
 */
const LOGIN_EXEMPT_PATHS = new Set(['/api/health', '/api/auth/login']);

function loginGuardBlocks(path, user) {
  if (envFor().PILOT_REQUIRE_LOGIN !== '1') return false;
  if (LOGIN_EXEMPT_PATHS.has(path)) return false;
  return !user;
}

/**
 * 归属规则（C10）—— **唯一的一份，四条受保护的路由全部走它**：
 *
 *   · POST /api/chat     别人的 sessionId 不能拿来续聊（续聊会写穿，等于改别人的记录）
 *   · POST /api/formula  公式卡读的是 `record.hintLog` —— 别人做到了哪一步
 *   · GET  /api/report   报告是整段对话的结论（也含 `turns`）
 *   · POST /api/reset    重置会清空对话，比读更狠，必须同样拦
 *
 * 归属**只从存储里的那条记录读**（库记录的 `userId` / 活会话的 `session.userId`），
 * 不由请求参数决定：sessionId 是前端生成的可猜字符串（`'ui-' + Date.now().toString(36)`），
 * "拿得出 sessionId 就说明是你的"这条推断是错的。判定点三处，缺一不可：
 *   ① `restoreSession`：库记录 → 活会话之前。**必须在 problemId 比对之前**，
 *      否则对不上时调用方会现造一条 `userId: null` 的新会话，把"这是别人的"
 *      洗成"这是新的"，随后的写穿覆盖原主人的记录（评审 Important 1）；
 *   ② 各路由拿到会话之后：内存里命中的那条不经过库，① 看不到它；
 *   ③ `persistSession` 写之前：纵深防御 —— 任何新路径都不许覆盖别人名下的记录。
 *
 * 判的是"有归属且不是你"，而不是 `session.userId !== 我`：
 * 会话的 `userId` 起初是 null —— sessionId 由前端生成，第一次说话时才由
 * persistSession 从令牌补上归属。若把 null 也判成"不是你的"，登录之后
 * **第一句话就会被自己的接口拒掉**：那不是收紧权限，是把门焊死。
 *
 * 没有登录态（`req.__user` 为空）时一律放行：没配守卫的环境里不存在"归属"这回事，
 * 行为必须与加这条校验之前一模一样（C10 第三条：不放宽也不收紧）。
 *
 * 为什么判在这里而不是每路由各写一次：它是**身份规则**，不是业务规则。
 * 四条各写一份，就一定会出现"报告拦了、重置没拦"这种后门。
 */
function notMine(session, me) {
  const owner = session?.userId;
  if (!me?.user || typeof owner !== 'string' || owner === '') return false;
  return owner !== me.user.id;
}

/** 403 只回一句人话：不确认"这条会话存在"以外的任何事（报告内容、题目、对话都不带） */
function sendNotOwner(res) {
  sendJson(res, 403, { error: '这不是你的学习记录', code: 'NOT_OWNER' });
}

// ---------------------------------------------------------------------------
// 埋点上报（POST /api/events）
// ---------------------------------------------------------------------------

/** 空串、空白、非字符串一律收敛成 null —— 库里不想出现 `userId: ''` 这种"有值但没意义" */
function textOrNull(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
}

/**
 * 一批埋点的全部处理。**永远不抛**，永远返回两个计数（B4）。
 *
 * ============================================================================
 * 为什么这个接口"永远返回 200"
 * ============================================================================
 * 埋点是**旁路**：它坏了不能影响学生做题。而它又几乎一定在最糟的时刻坏
 * （弱网、页面被杀、后台标签页被节流）—— 这时候回 4xx/5xx，前端的常见反应是
 * 重试，于是坏请求被放大成一串坏请求，还可能顶掉真正的主流程请求。
 * 所以这里把"丢掉"当成正常结果：逐条判断，能收几条收几条，剩下的计数返回。
 *
 * 下面这几种情况都不许 5xx：
 *   ① 请求体解析失败（半截 JSON / 超过 1MB / 空 body）→ `{ accepted: 0, rejected: 0 }`
 *   ② 单条不合法（未知 type / payload 超 2KB / 没有归属）→ 跳过并计入 rejected
 *   ③ 存储写失败（磁盘满、驱动不可用）→ 同样计入 rejected，不往上报错
 *   ④ 令牌解析失败 → 当作"没有身份"，回落到 body 里的 userId（Task 4 会把它收紧成必须登录）
 *   ⑤ **读不出来**的（既没有归属、也没有 batchId，见下一节）→ 同样计入 rejected、不写
 *
 * `rejected` 存在的意义不是给前端看，而是**让埋点坏掉这件事有数字**：
 * 没有它，"这周为什么少了三分之一的事件"只能靠猜。
 *
 * ============================================================================
 * "收下"的定义：至少能被一条查询路径读出来
 * ============================================================================
 * 事件表只有两个读入口 —— `listEventsBySession(归属键)` 与 `listEventsByBatch(batchId)`。
 * 一条**既没有归属、也没有 batchId** 的事件落库之后，两个都读不到它：
 * 前者按归属键分文件/过滤，后者对空 batchId 直接返回 `[]`。
 * 于是它被写进磁盘、计入 `accepted`，然后对漏斗 / 看板 / 导出**永久不可见** ——
 * 那三个功能只读事件表，而且不会报错。`accepted` 在这里就成了谎话。
 *
 * 所以可读性是**收下的前提**，判在归属键与 batchId 都解析完之后：
 * 读不出来的一条，计入 `rejected`、不写。这不是校验规则 —— `validateEvent`
 * 不认识 `batchId`，它照旧放行无归属的 `login`（B7-1 的纯函数契约）。
 *
 * 现实路径不受影响：登录之后客户端就握着令牌，下面会把用户和当前批次解出来，
 * `login` 于是既可查、也被收下。真正会被拒的只有"匿名 + 没带 batchId"那种埋点 ——
 * 它本来就没有任何分析价值。
 *
 * ============================================================================
 * 身份与时间都不信客户端
 * ============================================================================
 * - `userId` / `batchId`：带了令牌就用令牌里的（`batchId` 是令牌解析出的**当前批次**）。
 *   令牌缺席时才回落到 body —— 没配登录守卫的本地/演示环境需要这条路；
 *   配了守卫（`PILOT_REQUIRE_LOGIN=1`）时请求根本走不到这里，回落自然失效。
 * - `at`：**先盖服务端时间、再逐条校验**（B7-2），所以客户端漏发 `at` 不会丢事件；
 *   值最终仍由 `recordEvent` 换成服务端时间。`missing_at` 作为纯函数契约保留，
 *   但这条 HTTP 路径上不可达 —— 半截埋点会以别的理由（未知 type / 缺归属）被拒。
 *
 * @param {object} req
 * @param {object|null} body 已解析好的请求体；解析失败传 null
 * @returns {Promise<{ accepted: number, rejected: number }>}
 */
async function acceptEvents(req, body) {
  const items = Array.isArray(body?.events) ? body.events : [];
  if (!items.length) return { accepted: 0, rejected: 0 };

  /** 存储打不开（例如 STORE=cloudbase 还没实现）时，这一批全部记成 rejected，而不是 500 */
  const store = await getStore().catch(() => null);
  if (!store) return { accepted: 0, rejected: items.length };

  /**
   * 身份已经从请求头解过一次了（`handleApi` 开头的 `req.__user`），这里直接用 ——
   * 一套取令牌的写法只能有一处，否则"某个接口认这个头、另一个不认"是必然的。
   */
  const identity = req.__user ?? null;

  let accepted = 0;
  let rejected = 0;
  for (const item of items) {
    /**
     * 非对象一条条看起来很像"数组里混了 null/字符串"（前端拼接出错时就是这样），
     * 它们连 validateEvent 的入参都不该是 —— 直接计数跳过。
     */
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rejected += 1;
      continue;
    }

    /**
     * 先盖时间戳、再校验（B7-2）：客户端漏发 `at` 不会因此丢掉事件。
     * 因为这里已经盖过章，`validateEvent` 的 `missing_at` 分支从 HTTP 不可达 ——
     * 那条分支作为纯函数的契约保留（测试仍会直接命中）。
     */
    const stamped = { ...item, at: new Date().toISOString() };

    if (!validateEvent(stamped).ok) {
      rejected += 1;
      continue;
    }

    const event = {
      ...stamped,
      /** 令牌优先；body 只在没有身份时兜底（见上面的说明） */
      userId: identity ? identity.user.id : (textOrNull(item.userId) ?? textOrNull(body?.userId)),
      batchId: identity ? (identity.batchId ?? null) : (textOrNull(item.batchId) ?? textOrNull(body?.batchId)),
    };

    /**
     * **读不出来就不算收下**（见上面"收下的定义"）：归属键与 batchId 都为空的事件，
     * 两条查询路径都取不到它 —— 写进去只会让 `accepted` 变成谎话。
     *
     * 判在校验**之后**是刻意的：`validateEvent` 放行无归属的 `login` 是纯函数契约（B7-1），
     * 而且它不认识 `batchId`；"这条以后查不查得出来"是这里才知道的事。
     * 也判在 `recordEvent` **之前**：被拒的事件不该占掉一个 seq。
     */
    if (!ownerOf(event) && !event.batchId) {
      rejected += 1;
      continue;
    }

    try {
      await recordEvent(store, event);
      accepted += 1;
    } catch {
      /** 单条写失败不牵连整批，也不把异常放到路由外 */
      rejected += 1;
    }
  }

  return { accepted, rejected };
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

  /**
   * ① 先解身份，② 再判守卫 —— 顺序不能反过来。
   *
   * 反过来的话令牌还没解出来守卫就先拒了：带对令牌的人也会吃 401。
   *
   * 关于"库读不出来"：**这里不区分**，也区分不了。`resolveRequestUser` 把
   * "没带令牌"、"令牌过期"、"读库失败"一律收敛成"没有身份"（它不抛、也不回 500）。
   * 于是配了守卫时这三种都是 `401 请先登录` —— 这是 C1 要求的：未登录一律 401，
   * 而且 401 这个响应不该告诉外面"我们的库坏了"。
   * 真正的"库坏了"只在**拿到身份之后**的读写路径上暴露：那里回 503 并记 warn
   * （见 `restoreForRoute` 与 session-store 的 `readSessionRecord`）。
   * 记法：**401 是"请去登录"，503 才是"我们这边坏了"**。
   *
   * 解析结果挂在 `req.__user` 上：下游（埋点、续做、访问记录）一律读它，
   * 不允许各自再解一遍 —— 一处解析、一处分叉机会。
   */
  req.__user = await resolveRequestUser(req);
  if (loginGuardBlocks(path, req.__user)) {
    sendJson(res, 401, { error: '请先登录', code: 'AUTH_REQUIRED' });
    return true;
  }

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

  // ---- POST /api/events（埋点批量上报：永不因埋点失败返回 4xx/5xx） ----
  /**
   * 读体失败**只在本路由内消化**：
   * 半截 JSON、超过 1MB、空 body 都走同一条路 —— 回 `200 { accepted: 0, rejected: 0 }`。
   * 埋点坏了不能影响主流程，也不能给学生端一个"内部错误"。
   *
   * 外面再包一层 catch：`acceptEvents` 里已经逐段兜过，但"永远不 5xx"是承诺，
   * 承诺要由最后一道兜底来兑现，而不是靠"我记得里面都兜住了"。
   */
  if (path === '/api/events' && req.method === 'POST') {
    const body = await readJson(req).catch(() => null);
    let summary;
    try {
      summary = await acceptEvents(req, body);
    } catch {
      summary = { accepted: 0, rejected: 0 };
    }
    sendJson(res, 200, summary);
    return true;
  }

  // ---- POST /api/auth/login（6 位口令 → 令牌） ----
  /**
   * 顺序是有讲究的：**先限速，再哈希**。
   * 反过来写的话，被拒绝的那一次其实已经做完了哈希 —— 一次 sha256 不贵，
   * 但乘以"每秒几百次"就是另一回事；限速只挡住了响应，没挡住成本。
   * 所以 `checkLoginRate` 在读体之后、`login()`（它才是哈希与查库）之前。
   *
   * 两个维度（见 auth.js 的注释，这是本路由必须照做的那一半）：
   *   `code_locked` —— 这一对 (IP, 口令) 试错太多。换一个口令照样能登。
   *   `ip_locked`   —— 这个来源 IP 的失败总量到顶。任何口令都不放行。
   * 两个都回同一句"稍后再试"是不行的：前者的正确下一步是**核对纸条**，
   * 后者才是**等**。文案分开写，学生才知道该做什么。
   *
   * 401 只有一句话（`口令不对`）：不区分"没有这个人"与"口令错了"，
   * 否则枚举脚本能靠错误文案二分出有效账号。
   *
   * 只有"真的验过一次且没通过"才记账。**被 429 拒绝的那次不记账**：
   * 它不是一次验证，记了会让锁自己续期（每次被拒都把窗口往后推），永远解不开。
   * 坏请求体（半截 JSON、断网）同理，单独回 400 且不消耗任何次数。
   */
  if (path === '/api/auth/login' && req.method === 'POST') {
    /**
     * 读体失败用一个**本地哨兵变量**记，而不是往 body 里塞 `__readError` 字段：
     * serverless 平台上 `req.body` 可能是平台已经解析好的对象（也就是学生可控的
     * JSON），往那个对象里认字段，等于让客户端自己声明"我这次是坏请求"。
     */
    let readFailed = null;
    const body = await readJson(req).catch((err) => {
      readFailed = err;
      return null;
    });
    if (readFailed) {
      const tooLarge = String(readFailed.message ?? '').includes('过大');
      sendJson(res, tooLarge ? 413 : 400, {
        error: tooLarge ? '请求体过大' : '请求体不是合法 JSON，请重新提交',
      });
      return true;
    }

    const ip = clientIp(req);
    const code = typeof body?.code === 'string' ? body.code.trim() : '';

    const verdict = checkLoginRate(ip, code);
    if (verdict !== 'ok') {
      /**
       * `retry-after` 是**提示**不是承诺：两个维度都取 900（15 分钟），
       * 比 IP 维度最长 60 分钟的窗口短 —— 到点重试可能仍是 429，
       * 但让学生"先等一会儿再看一眼"比让它消失一小时好。
       */
      const locked = verdict === 'ip_locked'
        ? '这个网络试错的次数太多了，请稍后再试'
        : '这个口令试错太多次了，请核对老师发给你的 6 位数字，或稍后再试';
      sendJson(res, 429, { error: locked }, { 'retry-after': '900' });
      return true;
    }

    const result = await login(await getStore(), code, ip);
    if (!result) {
      /** 真的验过一次、没通过：这才叫一次失败 */
      noteLoginFailure(ip, code);
      sendJson(res, 401, { error: '口令不对' });
      return true;
    }

    /**
     * 成功只清**这一对 (IP, 口令)**。
     * 不清 IP 总量：那是枚举防线，清了就等于"错几次 → 用自己的号登一次 → 重来"。
     */
    noteLoginSuccess(ip, code);
    sendJson(res, 200, {
      token: result.token,
      displayName: result.user.displayName,
      batchId: result.batchId,
      expiresAt: result.expiresAt,
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

    /**
     * 会话：先回载（冷启动/换实例之后会话只在库里），库里没有才现造一条。
     *
     * `??` 而不是"回载失败就报错"：新学生第一次说话时库里本来就没有记录 ——
     * 那不是错误，是开始。回载返回 null 只有两种情形（库里没有 / 题目对不上），
     * 两种都该走"新建"，与加写穿之前的冷启动行为完全一致。
     *
     * 真正的失败不在这里，也不许落到"新建"上：读不出来 → 503、是别人的 → 403
     * （见 restoreForRoute）。旧版本把两者都当成 null，于是"新建"盖掉了真记录。
     */
    const sid = sessionId || 'demo';
    const store = await getStore().catch(() => null);
    const restored = await restoreForRoute(res, store, sid, problemId, req.__user);
    if (restored.replied) return true;
    const session = restored.session ?? getSession(sid, problemId);
    /** 归属校验（C10）：内存命中的那条不经过库，这里再判一次（新会话 userId 为空，照常放行） */
    if (notMine(session, req.__user)) {
      sendNotOwner(res);
      return true;
    }
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

    /**
     * 写穿（C6）：历史与提示记录都在这一份里，写失败只 warn。
     * 归属（userId / batchId）在这里补：会话可能是匿名建的，登录之后才第一次落库。
     */
    await persistSession(store, session, {
      chatTurn: true,
      hintLevel: response.hint.level,
      owner: req.__user,
    });

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
    const store = await getStore().catch(() => null);
    /**
     * 回载：公式卡的开放条件是"同一步给过 L3"，而那条记录在 `record.hintLog` 里 ——
     * 只读内存的话，冷启动之后同一张卡会被判成"还没给过 L3"，学生拿不到。
     */
    const restored = await restoreForRoute(res, store, sessionId, null, req.__user);
    if (restored.replied) return true;
    const session = restored.session;
    if (!session) {
      sendJson(res, 404, { error: '这个学习会话不存在或已过期，请重新开始一道题。' });
      return true;
    }
    /** 归属校验（C10）：公式卡读的是 hintLog，也就是别人做到了哪一步 */
    if (notMine(session, req.__user)) {
      sendNotOwner(res);
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
    /** 写穿（C6）：用过哪张卡要落库，否则重启之后"他用过工具"这件事消失 */
    await persistSession(store, session, { formulaOpen: true, owner: req.__user });
    sendJson(res, 200, { card });
    return true;
  }

  // ---- GET /api/report?sessionId=xxx（学生自己的学习报告） ----
  if (path === '/api/report' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || 'demo';
    const store = await getStore().catch(() => null);
    const restored = await restoreForRoute(res, store, sessionId, null, req.__user);
    if (restored.replied) return true;
    const session = restored.session;
    if (!session) {
      const bankId = url.searchParams.get('problemId');
      const bank = bankId && bankId.startsWith('qbank-') ? getProblemById(bankId) : null;
      if (bank) {
        const report = buildReport(bank, createSessionRecord(bank.id), { engine: 'no-conversation' });
        report.meta.recordMissing = true;
        sendJson(res, 200, { report, turns: [] });
        return true;
      }

      // 没有会话可回载 —— 给出可操作的提示，而不是一个空白错误
      sendJson(res, 404, {
        error: '该会话不存在或已过期',
        detail:
          '会话已经写进存储，但这个 id 在库里没有记录：可能是在别的环境开始的，也可能是链接里的 id 不对。请回到题单重新开始一道题。',
      });
      return true;
    }

    /**
     * 归属校验（C10）：sessionId 是前端生成的可猜字符串，写穿之后
     * "猜中一个 id 就能读走别人的报告"是真漏洞，不是理论风险。
     */
    if (notMine(session, req.__user)) {
      sendNotOwner(res);
      return true;
    }

    const problem = getProblemById(session.problemId);
    /**
     * 快照优先（C5）：已经冻结过的那一份**哪怕题目被回收了也照发** ——
     * 报告是学生当时看到的结论，注册表清理不该让它变成 404。
     * 只有"没有快照 + 题目也没了"才说实话（照片/粘贴题就是这个形状）。
     */
    if (!session.reportSnapshot) {
      if (!problem) {
        sendJson(res, 404, { error: '该会话的题目已不在注册表里（导入题目有存活时间）' });
        return true;
      }
      session.reportSnapshot = buildReport(problem, session.record, {
        engine: session.engine?.adapter?.kind ?? 'unknown',
        model: session.engine?.adapter?.model,
      });
      session.reportBuiltAt = new Date().toISOString();
      /** 到报告页就是"走完了"：写进 finishedAt，续做条才不会一直劝他回来 */
      session.finishedAt = session.reportBuiltAt;
      session.endState = 'finished';
      /** 写穿（C6）：快照与完成状态一起落库（导出件读的是库里那份） */
      await persistSession(store, session, { page: 4, owner: req.__user });
    }
    sendJson(res, 200, { report: session.reportSnapshot, turns: session.record.turns });
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

  // ---- GET /api/session/resume（续做：「继续刚才那道题」条） ----
  /**
   * 身份**只能来自令牌**（C2）。计划里原本写的是 `?userId=`，那是可伪造的：
   * 换一个 id 就能看到别人做到哪道题、停在第几页。所以查询参数一律忽略，
   * 连读都不读 —— 读了就迟早有人顺手用上。
   *
   * 没有登录态时回 401，**不退化成"返回所有人的最近一条"**：
   * 那种"降级"在演示里看起来很友好，在试点里就是把全班进度发给第一个人。
   */
  if (path === '/api/session/resume' && req.method === 'GET') {
    const me = req.__user;
    if (!me?.user) {
      sendJson(res, 401, { error: '请先登录', code: 'AUTH_REQUIRED' });
      return true;
    }
    const store = await getStore().catch(() => null);
    if (!store) {
      sendStoreUnreadable(res);
      return true;
    }
    try {
      const records = await store.listSessionsByUser(me.user.id);
      sendJson(res, 200, { session: pickResumable(records) });
    } catch (err) {
      /**
       * 读库失败**不冒充"没有未完成的题"**：那会让学生以为自己什么都没做过，
       * 而真正的问题是库坏了。宁可说"读不出来"。
       */
      console.warn(`[session] 续做查询失败：${err?.message ?? err}`);
      sendStoreUnreadable(res);
    }
    return true;
  }

  // ---- POST /api/visit（一次打开 = 一次 visit） ----
  /**
   * 为什么需要它：会话 id 是前端在**第 3 页**才生成的，而拍照、粘贴、选题
   * 全都发生在第 1 页 —— 没有 visit 这一层，漏斗第一级的分母（"打开了但一道题都没选"）
   * 根本记不下来（设计稿 §5.2）。
   *
   * 同一个人当天重复打开就是**新的**一次 visit，不去重："一次打开"就是一次 visit，
   * 去重等于把"他又回来了一次"这件事抹掉。
   */
  if (path === '/api/visit' && req.method === 'POST') {
    const me = req.__user;
    if (!me?.user) {
      sendJson(res, 401, { error: '请先登录', code: 'AUTH_REQUIRED' });
      return true;
    }
    const store = await getStore().catch(() => null);
    if (!store) {
      sendJson(res, 503, { error: '记录本次打开失败，请刷新页面重试。', retryable: true });
      return true;
    }
    const visit = createVisit({ userId: me.user.id, batchId: me.batchId ?? null });
    try {
      await store.putVisit(visit);
    } catch (err) {
      console.warn(`[visit] 写入失败：${err?.message ?? err}`);
      sendJson(res, 503, { error: '记录本次打开失败，请刷新页面重试。', retryable: true });
      return true;
    }
    sendJson(res, 200, { visitId: visit.id });
    return true;
  }

  // ---- POST /api/reset ----
  /**
   * 重置 = 内存里丢掉这条会话（老行为），库里**清空对话但保留会话本身**：
   * `counters.resetCount` 是"重来"这个指标的分子，把记录删掉就永远算不出来了。
   * 详见 session-store.js 的 persistReset。
   */
  if (path === '/api/reset' && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const sessionId = body?.sessionId || 'demo';
    const store = await getStore().catch(() => null);
    /** 冷启动之后内存里没有它，但库里可能有 —— 先回载再按"重置"写回去 */
    const restored = await restoreForRoute(res, store, sessionId, null, req.__user);
    if (restored.replied) return true;
    const session = restored.session;
    /**
     * 归属校验（C10）：sessionId 是猜得出来的，而重置**会毁掉数据**（清空对话、把快照
     * 压进 reportHistory、resetCount +1）。读错别人的记录只是泄露，重置错是永久损失，
     * 所以判在 `sessions.delete` **之前** —— 判晚了内存里那条已经没了。
     */
    if (notMine(session, req.__user)) {
      sendNotOwner(res);
      return true;
    }
    sessions.delete(sessionId);
    if (session) await persistReset(store, session);
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
