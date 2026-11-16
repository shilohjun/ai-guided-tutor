/**
 * 会话的落库形状、冷启动回载与续做投影。
 *
 * ============================================================================
 * 为什么这些东西不在 router.js 里
 * ============================================================================
 * router.js 已经 1100 行往上，而"会话落什么、读回来怎么拼、续做给哪几个字段"
 * 是**数据形状**的问题，不是路由的问题。更实际的理由：后面还有两个任务
 * （管理接口、OCR 配额）要改同一个 router.js，把这段逻辑塞进去只会让它继续变大。
 * 所以这里只做数据，路由只负责调用。
 *
 * ============================================================================
 * 三条边界（都是"看起来对、上线才发现"的那种）
 * ============================================================================
 * ① **引擎绝不落库。** 引擎里挂着 adapter 与闭包，`JSON.stringify` 写不出、
 *    `structuredClone` 直接抛。所以快照是**显式字段投影**：把要存的字段逐个点名，
 *    最后把其余字段浅拷贝过来、唯独漏掉 `engine`。故意不深克隆整个对象 ——
 *    那不是"更安全"，那是必然抛。
 *
 * ② **回载要把历史与提示记录一起交回引擎。** 只重建引擎不交历史，学生隔天回来
 *    听到的是"你想从哪一步开始"（提示层级归零）。`record.hintLog` 是报告与
 *    "这一步给过 L3 没有"的唯一依据，少它等于把公式卡也一起锁上。
 *
 * ③ **每个对话版本的报告快照只冻结一次。** 导出件不能随代码变化而变化（设计稿 §5.2）——
 *    冻结之后 `buildReport` 再怎么改，学生当时看到的那份就是那份。
 *    有新对话时旧快照留入 reportHistory，再生成新版本；重复读取同一版本不重算。
 *
 * ============================================================================
 * 写失败与读失败的策略是**不对称**的，这是刻意的
 * ============================================================================
 * 写失败（C6）：记一条 warn，请求照常返回。理由：丢一条记录 < 丢掉学生刚打完的一段话。
 *
 * 读失败：**必须与"没有这条"分开**（评审 Important 3）。这里抛 `SessionReadError`，
 *   只有**确实没有**那条记录时才回 null。理由：两者混成同一个答案时，调用方会
 *   "现造一条新的"并写穿 —— 用一条刚建的空会话盖掉库里那份真记录，学生的历史、
 *   提示记录、报告快照全没了，而且没有任何一条日志说得清为什么。
 *   坏库必须看起来像坏库：503 可重试，而不是 404「重新开始」。
 *   留痕仍在这里（warn）：503 是给学生看的，日志是给我们看的。
 */

import { randomBytes } from 'node:crypto';

import { createSessionRecord } from '../core/report.js';

/**
 * 落库时**必须有**的字段（设计稿 §5.2 的 session 形状里本任务能诚实填上的那些）。
 *
 * 为什么要显式点名而不是直接 `{...session}`：
 *   · 点名的字段不会因为将来改一次内部字段名就悄悄从库里消失（导出与看板读它们）；
 *   · 它同时是"这个任务承诺存什么"的唯一文档 —— 后面的任务照这张表取数即可。
 * 点名的之外仍然原样带上（见 snapshotSession 的第二段），只是**永不带 engine**。
 */
export const SNAPSHOT_FIELDS = [
  'id',
  'userId',
  'batchId',
  'visitId',
  'problemId',
  'problemSnapshot',
  'inputLog',
  'questionIndex',
  'startedAt',
  'lastAt',
  'finishedAt',
  'endState',
  'progress',
  'counters',
  'history',
  'record',
  'reportSnapshot',
  'reportBuiltAt',
  'reportHistory',
];

/**
 * 造一个"活会话"（内存里的那一份）。
 *
 * 默认值全部按设计稿 §5.2 的 session 形状给全，而不是等某个路由用到再补：
 * 少一个字段就会在导出/看板上表现为"这一列全是空的"，而那种空不会报错。
 *
 * 关于 `progress.maxPage = 3`：会话 id 是前端在**第 3 页**才生成的
 * （index.html 的 startSession），也就是说走到"创建会话"这一步时，
 * 学生必然已经选完题（p2）、进了第 3 页（p3）。所以这两个进度是**既成事实**，
 * 不是猜的；p1（打开）记在 visit 上，p4（报告）等出报告时再记。
 */
export function createLiveSession({ id, problemId, engine = null, adapterTag = 'offline', now = Date.now() }) {
  const at = new Date(now).toISOString();
  return {
    id,
    problemId,
    problemSnapshot: null,
    inputLog: [],
    engine,
    adapterTag,
    /** 归属：登录之后第一次写穿时由 /api/chat 从令牌补上（见 persistSession 的 owner） */
    userId: null,
    batchId: null,
    /** 第 1–2 页的访问 id。本任务不收这个字段，留给前端埋点联调时补 */
    visitId: null,
    /** 题号：要 batch.questionIds 才算得出来，而它现在还没有任何任务去填（预检 R6） */
    questionIndex: null,
    startedAt: at,
    lastAt: at,
    finishedAt: null,
    endState: 'in_progress',
    progress: { maxPage: 3, reached: { p2: at, p3: at }, backtracks: 0 },
    counters: { resetCount: 0, chatTurns: 0, hintLevels: [], formulaOpens: 0 },
    reportSnapshot: null,
    reportBuiltAt: null,
    /**
     * 被重置掉的那些报告（C11）。元素 `{ reportSnapshot, reportBuiltAt, archivedAt, reason }`。
     * **只追加**：C5 的"冻结一次不覆盖"对历史同样成立，重置不许改写已经压进去的条目。
     */
    reportHistory: [],
    history: [],
    record: createSessionRecord(problemId),
    /** 既有的内存字段：createdAt 给日志看，touchedAt 给 TTL 回收算 */
    createdAt: at,
    touchedAt: now,
  };
}

/**
 * 会话 → 可落库的快照。
 *
 * **绝不深克隆**：见文件头的边界 ①。这里是两段显式投影：
 *   ① `SNAPSHOT_FIELDS` 里点过名的字段（有就带上，值原样，不转格式）；
 *   ② 其余字段浅拷贝（除下面这两个）—— 将来加的标量字段不会因为没人记得改这张表而丢。
 * 两段都是**一层**，不走引擎，所以它对活会话不会抛。
 *
 * 两个例外：
 *   · `engine` —— 挂着闭包，写不进去（写进去整条会话就坏了）；
 *   · `adapterTag` —— 进程内的"模型形态"缓存键，里面是 **Key 的长度与首尾各两位**。
 *     它重启之后必然被重算，落盘没有用处；而会话会被导出成 zip（设计稿 §5.3），
 *     凭据指纹不该出现在那里面。
 */
const NOT_PERSISTED = new Set(['engine', 'adapterTag']);

export function snapshotSession(session) {
  const snap = {};
  for (const key of SNAPSHOT_FIELDS) {
    if (session?.[key] !== undefined) snap[key] = session[key];
  }
  for (const key of Object.keys(session ?? {})) {
    if (NOT_PERSISTED.has(key) || key in snap) continue;
    snap[key] = session[key];
  }
  /**
   * 设计稿 §5.2 的 `session.turns`：导出与看板读它，而报告侧用的是 `record.turns`。
   * 两个名字指同一份东西，落库时由这里统一 —— 下游不必知道"报告那边叫什么"。
   */
  const sourceTurns = Array.isArray(session?.turns)
    ? session.turns
    : Array.isArray(session?.record?.turns)
      ? session.record.turns
      : [];

  /**
   * 三个分支对象必须复制（评审 Minor）：`history` / `record` / `progress` 与活会话
   * 共享引用时，"落库的那一份"会顺着引用看到内存里后来的修改。file 驱动看不出来
   * （JSON 往返天然断开），memory / cloudbase 也不该靠驱动实现来兜底 ——
   * 快照的正确性不能建立在"驱动会克隆"这个假设上。
   */
  if (Array.isArray(snap.history)) snap.history = snap.history.slice();
  if (snap.problemSnapshot) snap.problemSnapshot=structuredClone(snap.problemSnapshot);
  if (Array.isArray(snap.inputLog)) snap.inputLog=snap.inputLog.map(x=>({...x}));
  if (snap.progress && typeof snap.progress === 'object') {
    snap.progress = { ...snap.progress, reached: { ...(snap.progress.reached ?? {}) } };
  }
  if (snap.record && typeof snap.record === 'object') {
    snap.record = { ...snap.record };
    for (const key of ['turns', 'hintLog', 'formulaCards']) {
      if (Array.isArray(snap.record[key])) snap.record[key] = snap.record[key].slice();
    }
  }
  snap.turns = sourceTurns.slice();
  return snap;
}

/**
 * 库里的记录 → 活会话（引擎由调用方重建后传进来）。
 *
 * 只做装配，不读库、不查题目表：**题目找不到时 engine 传 null**，
 * 这个对象就只用于"读"（报告快照、公式卡判断），绝不放进内存表 ——
 * 放进去了 `/api/chat` 就会拿到一个没有引擎的会话并当场崩。
 */
export function hydrateSession(record, { engine = null, adapterTag = 'offline', now = Date.now() } = {}) {
  const live = createLiveSession({
    id: record?.id,
    problemId: record?.problemId ?? null,
    engine,
    adapterTag,
    now,
  });

  /** 时间与状态：库里写过的就以库为准；没写过的保留创建时的默认值 */
  for (const key of [
    'userId',
    'batchId',
    'visitId',
    'questionIndex',
    'problemSnapshot',
    'inputLog',
    'startedAt',
    'lastAt',
    'finishedAt',
    'endState',
    'reportSnapshot',
    'reportBuiltAt',
  ]) {
    if (record?.[key] !== undefined && record[key] !== null) live[key] = record[key];
  }

  if (record?.progress && typeof record.progress === 'object') {
    live.progress = {
      maxPage: Number(record.progress.maxPage ?? live.progress.maxPage),
      reached: { ...(record.progress.reached ?? {}) },
      backtracks: Number(record.progress.backtracks ?? 0),
    };
  }
  if (record?.counters && typeof record.counters === 'object') {
    live.counters = {
      ...live.counters,
      ...record.counters,
      hintLevels: Array.isArray(record.counters.hintLevels) ? [...record.counters.hintLevels] : [],
    };
  }
  if (Array.isArray(record?.history)) live.history = [...record.history];

  /**
   * 被重置掉的历史快照（C11）：整份带回来。
   * 少这一步的后果不是"少一列"，而是**导出件里只有最终报告**，
   * 重置掉的那一份永久消失 —— 而"他重置前看到的是什么"正是看板要回答的问题。
   */
  if (Array.isArray(record?.reportHistory)) live.reportHistory = [...record.reportHistory];

  /**
   * 报告侧的记录：整份以库里的为准（hintLog 决定了报告与"这一步给过 L3 没有"）。
   * 缺 `record` 时用 `turns` 兜底重建 —— 那种记录只可能来自导出/测试手写的形状，
   * 兜底之后至少"对话还在"，而不是一片空白。
   */
  const stored = record?.record && typeof record.record === 'object' ? record.record : null;
  if (stored) {
    live.record = {
      ...createSessionRecord(live.problemId),
      ...stored,
      problemId: live.problemId ?? stored.problemId ?? null,
      turns: Array.isArray(stored.turns) ? [...stored.turns] : [],
      hintLog: Array.isArray(stored.hintLog) ? [...stored.hintLog] : [],
      formulaCards: Array.isArray(stored.formulaCards) ? [...stored.formulaCards] : [],
    };
  } else {
    live.record = {
      ...createSessionRecord(live.problemId),
      turns: Array.isArray(record?.turns) ? [...record.turns] : [],
    };
  }
  return live;
}

/**
 * 读库失败 —— **不是**"没有这条记录"。
 *
 * 两者混成同一个 null 的后果是灾难性的（评审 Important 3）：调用方会当成
 * "新学生第一次说话"而现造一条会话并写穿，把库里那份真记录整条盖掉。
 * 所以这里带类型地抛出来，让调用方回 503（可重试），而不是 404（叫他重新开始）。
 */
export class SessionReadError extends Error {
  constructor(cause) {
    super('读取学习记录失败');
    this.name = 'SessionReadError';
    this.code = 'SESSION_READ_FAILED';
    /** 驱动报的原始错误：503 是给学生看的，cause 是给我们看的 */
    this.cause = cause;
  }
}

/**
 * 读一条会话记录。
 *
 * 只有**确实没有**这条记录时才回 null；读不出来（文件坏了、云调用失败、权限不对）
 * 抛 `SessionReadError`。warn 在这里打一次，调用方不必再打一遍。
 */
export async function readSessionRecord(store, sessionId) {
  if (!store || !sessionId) return null;
  try {
    return await store.getSession(sessionId);
  } catch (err) {
    console.warn(`[session] 读取会话失败（不是"没有这条"，是读不出来）：${err?.message ?? err}`);
    throw new SessionReadError(err);
  }
}

/**
 * 记一次活动：`lastAt` 是唯一的"这个人刚才还在"的事实，续做与放弃判定都读它。
 * 所有写穿点都先过这里，时间戳只有一处来源。
 */
export function markActivity(
  session,
  { page = null, hintLevel = null, chatTurn = false, formulaOpen = false } = {},
  nowIso = new Date().toISOString(),
) {
  session.lastAt = nowIso;
  if (!session.progress) session.progress = { maxPage: 1, reached: {}, backtracks: 0 };
  session.progress.reached = session.progress.reached ?? {};
  if (page) {
    session.progress.maxPage = Math.max(Number(session.progress.maxPage ?? 1), page);
    const key = `p${page}`;
    if (!session.progress.reached[key]) session.progress.reached[key] = nowIso;
  }
  if (!session.counters) session.counters = { resetCount: 0, chatTurns: 0, hintLevels: [], formulaOpens: 0 };
  if (chatTurn) {
    session.counters.chatTurns = Number(session.counters.chatTurns ?? 0) + 1;
    session.counters.hintLevels = Array.isArray(session.counters.hintLevels) ? session.counters.hintLevels : [];
    if (hintLevel !== null && hintLevel !== undefined) session.counters.hintLevels.push(hintLevel);
  }
  if (formulaOpen) session.counters.formulaOpens = Number(session.counters.formulaOpens ?? 0) + 1;
  return session;
}

/**
 * 写穿被拒绝：库里这条会话属于别人，**故意不写**（与"写失败"不是一回事）。
 * 调用方照 C6 吞掉即可，但不要把它当成"已经落库"。
 */
export const PERSIST_REFUSED = Object.freeze({ refused: true, code: 'NOT_OWNER' });

/**
 * 记一次活动并写穿。**所有写穿点都走这一个函数**（C6）：
 *
 *   · 只在这里刷 `lastAt` 与计数，时间与计数的口径只有一份；
 *   · 写失败只 warn，请求照常返回 —— 丢一条记录比丢掉学生刚打完的一段话好；
 *   · `owner` 只在会话还没有归属时补上（会话可能先匿名创建，登录后才写库）；
 *   · **绝不覆盖别人名下的记录**（见下面那段"纵深防御"）。
 *
 * @returns {Promise<object|null|{refused: true, code: string}>}
 *   落库的那一份快照；没写或写失败时是 null；故意不写时是 `PERSIST_REFUSED`
 */
export async function persistSession(
  store,
  session,
  { page = null, hintLevel = null, chatTurn = false, formulaOpen = false, owner = null } = {},
  nowIso = new Date().toISOString(),
) {
  if (owner && session.userId == null) {
    session.userId = owner.user?.id ?? null;
    session.batchId = owner.batchId ?? null;
  }

  /**
   * 纵深防御（评审 Important 1）：写之前再看一眼库里那份是谁的。
   *
   * restoreSession 已经在"库记录 → 活会话"那条路上拦过同一条规则，这里是第二道：
   * 只要还有任意一条路径拿到一个 `userId` 被清空的会话对象，写下去就会**永久覆盖**
   * 别人的记录 —— history / hintLog / reportSnapshot / 进度全丢，而且静默。
   * 宁可不写，也不覆盖。代价是每次写穿多一次读；试点量级下可以接受。
   */
  if (store && session?.id) {
    let stored;
    try {
      stored = await store.getSession(session.id);
    } catch (err) {
      /** 读不回来就不写：写下去有可能盖掉那份正读不出来的记录（与读失败同一条理由） */
      console.warn(`[session] 写穿前读不回库里的记录，这次不写（不覆盖读不出来的记录）：${err?.message ?? err}`);
      return null;
    }
    const storedOwner = typeof stored?.userId === 'string' && stored.userId !== '' ? stored.userId : null;
    if (storedOwner && storedOwner !== session.userId) {
      console.warn(
        `[session] 拒绝写穿：库里这条会话属于 ${storedOwner}，不是 ${session.userId ?? '(匿名)'} —— 不覆盖别人的记录`,
      );
      return PERSIST_REFUSED;
    }
  }

  markActivity(session, { page, hintLevel, chatTurn, formulaOpen }, nowIso);

  if (!store) return null;
  const snap = snapshotSession(session);
  try {
    await store.putSession(snap);
    return snap;
  } catch (err) {
    console.warn(`[session] 写入失败（这一轮照常返回，只是没落库）：${err?.message ?? err}`);
    return null;
  }
}

/**
 * 重置：清空这一轮对话，但**会话本身留在库里**。
 *
 * 为什么不留一个空壳就直接删记录：`counters.resetCount` 是"重来"这个指标的分子
 * （设计稿 §5.4），删掉记录等于让"他重来了几次"永远算不出来。
 * `endState` / `finishedAt` 不变（控制者补充 C6 明确要求），`progress` 也不回退
 * —— 他确实走到过第 3 页，那是事实，改小它等于让漏斗说谎。
 *
 * 清掉 `reportSnapshot` 是**必须**的：报告是"那一轮对话"的结论，
 * 对话被丢弃了它就必须一起走，否则学生会在新对话上看到上一轮的结论。
 *
 * 但清之前先压进 `reportHistory`（C11）：重置丢掉的是"这一轮对话"，
 * 学生**重置前看到的那份报告**是既成事实。清掉而不留档，导出件里就只剩最终报告，
 * "他重置前看到的是什么"永久消失 —— 而设计稿 §5.4 要看"重来"前后的差别。
 * 只追加、不改写已有条目（C5 的"冻结一次不覆盖"对历史同样成立）。
 *
 * @returns {Promise<object>} 清空后的那份快照（写失败时也返回，方便调用方断言）
 */
export async function persistReset(store, session, nowIso = new Date().toISOString()) {
  const cleared = snapshotSession(session);
  /** C11：清之前先留档。没有快照（还没出过报告）就不压空条目 */
  if (cleared.reportSnapshot) {
    cleared.reportHistory = [
      ...(Array.isArray(cleared.reportHistory) ? cleared.reportHistory : []),
      {
        reportSnapshot: cleared.reportSnapshot,
        reportBuiltAt: cleared.reportBuiltAt ?? null,
        archivedAt: nowIso,
        reason: 'reset',
      },
    ];
  }
  cleared.history = [];
  cleared.record = createSessionRecord(session.problemId);
  cleared.inputLog=[];
  cleared.turns = [];
  cleared.lastAt = nowIso;
  cleared.reportSnapshot = null;
  cleared.reportBuiltAt = null;
  cleared.counters = {
    ...(cleared.counters ?? { chatTurns: 0, hintLevels: [], formulaOpens: 0 }),
    resetCount: Number(cleared.counters?.resetCount ?? 0) + 1,
  };

  if (!store) return cleared;
  try {
    await store.putSession(cleared);
  } catch (err) {
    console.warn(`[session] 重置后写入失败（内存里已经清空）：${err?.message ?? err}`);
  }
  return cleared;
}

/**
 * 续做条要的那几个字段（C2 的形状）。
 *
 * `page` 取 `progress.maxPage`：设计稿的四页是 1–4，越界的值一律回到 1 ——
 * 宁可让学生回到第 1 页，也不要给他一个"第 7 页"的按钮。
 * `idleMinutes` 一律**服务端算**：客户端时钟不可信（全局约束）。
 */
export function resumeInfo(record, now = Date.now()) {
  const page = Number(record?.progress?.maxPage);
  const lastAt = Date.parse(String(record?.lastAt ?? ''));
  const turns = Array.isArray(record?.turns)
    ? record.turns
    : Array.isArray(record?.record?.turns)
      ? record.record.turns
      : [];
  return {
    id: record?.id ?? null,
    problemId: record?.problemId ?? null,
    questionIndex: record?.questionIndex ?? null,
    page: Number.isFinite(page) && page >= 1 && page <= 4 ? Math.floor(page) : 1,
    idleMinutes: Number.isFinite(lastAt) ? Math.max(0, Math.round((now - lastAt) / 60_000)) : null,
    turnCount: turns.length,
  };
}

/**
 * 从某个人的会话里挑出"继续刚才那道题"该给的那一条。
 *
 * **不看隔了多久**（设计稿 §5.5）：只要没有 `finishedAt` 就给。
 * 这一点是刻意的 —— 一旦按时间过滤，"一天做一道题"的学生隔夜就会被判成没有会话，
 * 而那个结论是阈值自己造出来的，不是事实。
 */
export function pickResumable(records, now = Date.now()) {
  const open = (Array.isArray(records) ? records : []).filter((r) => r && !r.finishedAt);
  if (!open.length) return null;
  const lastAtOf = (r) => {
    const t = Date.parse(String(r.lastAt ?? r.startedAt ?? ''));
    return Number.isFinite(t) ? t : 0;
  };
  open.sort((a, b) => {
    const diff = lastAtOf(b) - lastAtOf(a);
    if (diff) return diff;
    /** 同一毫秒也要有确定答案：按 id 码位倒序（不用 localeCompare，见 store 里的说明） */
    const x = String(a.id ?? '');
    const y = String(b.id ?? '');
    return x < y ? 1 : x > y ? -1 : 0;
  });
  return resumeInfo(open[0], now);
}

/**
 * 一次"打开"的记录（C8）。同一个 ID 形如 `v-<时间戳36进制><随机>`：
 * 前缀让人一眼看出这是 visit 而不是 session，时间戳让排查时能排序。
 */
export function createVisit({ userId, batchId = null, now = Date.now() }) {
  const at = new Date(now).toISOString();
  return {
    id: `v-${now.toString(36)}${randomBytes(3).toString('hex')}`,
    userId,
    batchId,
    openedAt: at,
    lastAt: at,
    /** 一次打开里可能做几道题；这个数组由后续任务的会话创建逻辑 append */
    sessionIds: [],
  };
}

/**
 * 把一条会话挂回它发生在的那次打开（J6 —— 本任务补的那一格）。
 *
 * ============================================================================
 * 为什么非要回填
 * ============================================================================
 * `session.visitId` 从 Task 4 起就存在，但**从来没有任何写入方**：
 *   · `metrics.js` 的 `identityOf` 有一档就是 visitId，那一档在真实数据上永远是空的；
 *   · 页 1–2 的事件挂在 visit 上（会话要到进第 3 页才造），
 *     而"这个会话属于哪次打开"只能靠这一格，不然 p1 的对账只能靠 userId 猜。
 * 这种缺口不会报错：看板上页 1、页 2 的停留会安静地偏低，而"偏低"看起来像
 * "学生没停"。
 *
 * ============================================================================
 * 三条规矩
 * ============================================================================
 * ① **先认这次打开**：`visitId` 指向的记录不存在时什么都不做。凭空相信一个
 *    id（比如被还原的标签页里存着的旧 visitId）只会写出一条指向虚空的会话。
 * ② **会话侧只认领，不改嫁**：`visitId` 已经有值就不覆盖 —— 一条会话只属于
 *    它被创建的那次打开，覆盖等于把这段作答记到另一次打开上。
 * ③ **不覆盖别人的记录**：库里的会话已有主人且不是这次请求的人时，不写。
 *    与 `persistSession` 的纵深防御同一条规则。
 *
 * 传了 `session`（内存里那条活会话）就只改内存、由调用方随后的写穿落库；
 * 没传就读库、只补这一个字段再写回去 —— `/api/events` 那条路没有写穿时机，
 * 而它恰恰是"学生一句话都没说就离开"时唯一的回填机会。
 *
 * @param {object} store
 * @param {{ visitId?: string, sessionId?: string, session?: object|null, owner?: object|null }} link
 * @returns {Promise<object|null>} 认出来的那次打开（没认出来是 null）
 */
export async function linkSessionToVisit(store, { visitId, sessionId, session = null, owner = null } = {}) {
  if (!store) return null;
  const vid = typeof visitId === 'string' ? visitId.trim() : '';
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!vid || !sid) return null;

  let visit;
  try {
    visit = await store.getVisit(vid);
  } catch (err) {
    console.warn(`[visit] 读不出这次打开（${vid}），这一轮不回填：${err?.message ?? err}`);
    return null;
  }
  if (!visit) return null;

  const ids = Array.isArray(visit.sessionIds) ? visit.sessionIds : [];
  if (!ids.includes(sid)) {
    try {
      await store.putVisit({ ...visit, sessionIds: [...ids, sid] });
    } catch (err) {
      console.warn(`[visit] 追加 sessionIds 失败（${vid}）：${err?.message ?? err}`);
    }
  }

  if (session) {
    if (!session.visitId) session.visitId = vid;
    return visit;
  }

  try {
    const stored = await store.getSession(sid);
    if (!stored || stored.visitId) return visit;
    const storedOwner = typeof stored.userId === 'string' && stored.userId !== '' ? stored.userId : null;
    const mine = owner?.user?.id ?? null;
    if (storedOwner && mine && storedOwner !== mine) return visit;
    await store.putSession({ ...stored, visitId: vid });
  } catch (err) {
    console.warn(`[visit] 回填 session.visitId 失败（${sid}）：${err?.message ?? err}`);
  }
  return visit;
}
