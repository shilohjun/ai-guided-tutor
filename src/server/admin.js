/**
 * 管理接口（看板的数据面）与 `ADMIN_CODE` 闸门。
 *
 * ============================================================================
 * 为什么逻辑全在这个文件里，router.js 只留一个挂载点
 * ============================================================================
 * router.js 已经 1500 行往上，Task 11 还要改它。而管理接口是一条**只读旁路**：
 * 它和学生做题那条路没有一处共用判定 —— 口令与学生令牌是两件事、它不写事件、
 * 它不碰内存会话表。塞进 router 只会让"哪一段属于看板"越来越难看清，
 * 也让"看板改坏了学生端"变成可能。
 *
 * ============================================================================
 * 三态闸门：disabled / locked / ok
 * ============================================================================
 *   disabled  没配 `ADMIN_CODE` → **404**，连"这是管理员接口"都不承认。
 *             与"公网一律锁死教师视图"同源：一个能打开的网址会被转发到班级群，
 *             而"存在但你没权限"这句话本身就已经说明了这里有什么。
 *   locked    配了但没带 / 带错 → 401，只回一句"需要管理员口令"。
 *   ok        放行。
 *
 * `x-test-token` / `authorization: Bearer …` **一律不认**：学生令牌要是能开管理员门，
 * 等于每个学生都是管理员 —— 而这不会报错，只会静静地多出一批"老师"。
 * 比较走 `demo-gate.js` 的 `safeEqual`：`===` 逐字符短路，能靠响应时间把口令猜出来。
 *
 * ============================================================================
 * 没有库的部署一律 404（Vercel / Workers 就是这样跑的）
 * ============================================================================
 * 那两个入口强制内存库，而内存库重启即空 —— "看板能打开但永远是空的"比"打不开"
 * 更糟：空数据会被读成"这批没人用"。所以这条判在**第一行**，口令对不对都不影响。
 * 库都读不到时同样按这个走（`store` 为 null）：那里也没有数据可看。
 *
 * ============================================================================
 * G3：事件必须**同时**拼给 session 与 visit
 * ============================================================================
 * metrics 的约定（它的文件头写明了）：页 1–2 的事件挂在 `visit.id` 上
 * （会话要到进第 3 页才创建），页 3–4 的挂在 `session.id` 上。
 *
 * 只拼 session 时，页 1、页 2 的停留会**结构性**地永远是 0 —— 看板会把"没读那个
 * 字段"画成"学生没停"，而这两件事要做的决定正好相反，且看板上完全看不出来。
 * 反之只拼 visit 时，页 3、页 4 与技能指标（一轮失败率、沉默率）会一起归零。
 * 所以 `stitchEvents` 是 overview 的必经一步，不是可选优化。
 *
 * 也不能两边都挂：页 2 从 visit 读、页 3 从 session 读，一条带 `sessionId` 的事件
 * 再回到 visit 上，同一段时间就被算了两遍。分组一律用 `ownerOf`（它已经写死
 * "sessionId 优先"），规则只有一处。
 *
 * ============================================================================
 * 只读（G5）
 * ============================================================================
 * 这里**不写任何事件**。为"有人看了看板"发事件会把事件表变成访问日志，
 * 更糟的是它会进漏斗的分母：老师看得越多，"打开人数"越大，而那是头条数字。
 *
 * ============================================================================
 * 错误只说一句话，不回 `err.message`
 * ============================================================================
 * `err.message` 里可能有内部路径、云调用栈、集合名。看板是给教研用的，
 * 一句"读取失败，请刷新页面重试"才是他能处理的信息；详情进日志。
 */

import { buildFunnel, isAbandoned, summarizeSessions } from './metrics.js';
import { exportBatch, exportSingle } from './export.js';
import { ownerOf, eventsForSessions } from './events.js';
import { safeEqual } from './demo-gate.js';
import { readSessionRecord } from './session-store.js';

/** 产品只有四页（`setPage(5)` 只是 4 的别名）。越界的 maxPage 只能是坏数据。 */
const MAX_PAGE = 4;

/**
 * 单人页每个人的会话列表最多给这么多条。
 *
 * 为什么不给全量：展开区回答的是"这个人最近做了什么"，一次试点里一个人做到
 * 50 道题已经很反常；真给全量，一个重做很多遍的人会把整页展开区撑成几百行，
 * 而看板是给一个班用的。截断**必须说出来**（`sessionListTruncated`），
 * 否则"只有 50 条"会被读成"他只做了 50 道"。
 */
const MAX_SESSION_LIST = 50;

const NOT_FOUND = { error: '没有这个接口' };
const LOCKED = { error: '需要管理员口令' };
/** 人删了但记录还在时显示的代号：与导出件的降级同一句话（`export.js` 的 UNKNOWN_STUDENT） */
const UNKNOWN_STUDENT = '未知';

// ---------------------------------------------------------------------------
// 小工具：都保证"坏输入 → 空 / 0"，不抛
// ---------------------------------------------------------------------------

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function asList(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

/** 计数类字段：缺失、空串、坏值一律 0（与 metrics 的 `finiteNumber` 同口径） */
function countOf(value) {
  if (value === undefined || value === null || value === '') return 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/** 取请求头：Node 是普通对象（键已小写），Workers/Vercel 可能是 Headers 实例 */
function headerOf(req, name) {
  const headers = req?.headers;
  if (typeof headers?.get === 'function') return headers.get(name);
  const raw = headers?.[name] ?? headers?.[String(name).toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * 回一个 JSON。
 *
 * 为什么不 import router.js 的 `sendJson`：router 会 import 本文件来挂载路由，
 * 反向 import 就是一个环。为了一行 `res.end` 引入一个循环依赖不值得 ——
 * 形状照抄（`application/json` + `no-store`），看板那一侧看不出差别。
 */
function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** 已经回过话了：返回 true 让 router 不再往下走 */
function answer(res, status, payload) {
  json(res, status, payload);
  return true;
}

// ---------------------------------------------------------------------------
// 闸门
// ---------------------------------------------------------------------------

/**
 * 这个部署有没有管理员入口。
 *
 * `trim()` 是必须的：`ADMIN_CODE=' '`（部署脚本里多一个空格、或者只写了个占位符）
 * 若不 trim 就会被当成"配了"，而任何人都能用那些空白打开全班数据。
 *
 * @param {object} env 配置来源（`process.env` 或平台传入的 env）
 * @returns {boolean}
 */
export function adminEnabled(env) {
  return String(env?.ADMIN_CODE ?? '').trim().length > 0;
}

/**
 * 这次请求能不能进管理接口。
 *
 * 只认 `x-admin-code`：学生的 `x-test-token` / `authorization` 都**不认** ——
 * 两把钥匙不能互相开锁。
 *
 * @param {object} req
 * @param {object} env
 * @returns {'ok'|'locked'|'disabled'}
 */
export function checkAdmin(req, env) {
  if (!adminEnabled(env)) return 'disabled';
  const expected = String(env.ADMIN_CODE).trim();
  const provided = text(headerOf(req, 'x-admin-code'));
  return safeEqual(provided, expected) ? 'ok' : 'locked';
}

// ---------------------------------------------------------------------------
// G3：把事件拼给会话与打开记录
// ---------------------------------------------------------------------------

/**
 * 按归属键把事件拼到会话与打开记录上。
 *
 * 返回的是**副本**：入参原样不动（调用方可能还要拿它们做别的事），
 * `events` 一律被替换成拼好的那一份，而不是往后追加 —— 库里落的会话快照
 * 本来就不带事件（事件在事件表里），追加只会让同一批事件出现两遍。
 *
 * 分组用 `events.js` 的 `ownerOf`（`sessionId` 优先、否则 `visitId`），
 * 不在这里再写一次 `sessionId || visitId`：第四份手抄迟早会多一个 `??`，
 * 而那次分叉的症状正是"页 2 的停留翻倍"。
 *
 * **会话还要拿到"它那次打开"的事件**（B2）：页 1–2 的事件只带 `visitId`，
 * 而漏斗的页 3–4 与导出的三个操作列读的都是 `session.events` —— 不挂上来，
 * 「退回次数 / 报告次数 / 改入场次数」在真实数据上恒为 0（见 `eventsForSessions`）。
 * 页 1–2 的停留仍只从 `visit.events` 读，所以两边都有不会重复计。
 *
 * 顺序：直接沿用入参的顺序。入参是 `listEventsByBatch` 的产物（驱动已按 `seq` 升序），
 * 而 `metrics.js` 对会话的事件还会再排一次、对 visit 的不再排 —— 所以调用方必须
 * 按库里读出来的那份顺序给，不能自己拼一个乱序数组进来。会话那一侧的合并
 * （自己 + visit）也走 `eventsForSessions`，它保证仍是同一个顺序。
 *
 * @param {object[]} events 该批次的事件（`listEventsByBatch` 的产物，已按 seq 升序）
 * @param {object[]} sessions 会话
 * @param {object[]} visits 打开记录
 * @returns {{ sessions: object[], visits: object[] }}
 */
export function stitchEvents(events, sessions, visits) {
  const byOwner = new Map();
  for (const event of asList(events)) {
    const owner = ownerOf(event);
    if (!owner) continue;
    const list = byOwner.get(owner);
    if (list) list.push(event);
    else byOwner.set(owner, [event]);
  }

  /** 会话侧的归属比 `ownerOf` 多一档：它自己那次打开的事件也算它的 */
  const bySession = eventsForSessions(events, sessions);

  const attachOwner = (record) => ({
    ...record,
    events: byOwner.get(text(record?.id)) ?? [],
  });
  const attachSession = (record) => ({
    ...record,
    events: bySession.get(text(record?.id)) ?? [],
  });

  return {
    sessions: asList(sessions).map(attachSession),
    visits: asList(visits).map(attachOwner),
  };
}

// ---------------------------------------------------------------------------
// 组装：批次 → 会话 / 打开记录（都带事件）
// ---------------------------------------------------------------------------

/**
 * 这个批次的打开记录。
 *
 * 两个来源，缺一不可：
 *   ① 会话上的 `visitId` —— 走过第 3 页的那些打开；
 *   ② **只带 `visitId` 的事件** —— 页 1–2 的事件挂在 visit 上，所以
 *      "打开了链接、一道题都没选"的那次打开只能从这里发现。
 *
 * 只要 ① 的话，p1 会退化成"有作答的人数"，第一根柱子不再回答"多少人打开了链接"，
 * 而它和第二根柱子的差值正是这个漏斗最想看的那个数。
 *
 * `getVisit` 读不到就跳过：没有记录就不是一次打开（历史数据缺件时不许凭空造一次，
 * 那会把分母撑大，而撑大分母会让完成率变好看 —— 错的方向）。
 */
async function loadVisits(store, sessions, events) {
  const ids = new Set();
  for (const session of sessions) {
    const id = text(session?.visitId);
    if (id) ids.add(id);
  }
  for (const event of events) {
    if (text(event?.sessionId)) continue;
    const id = text(event?.visitId);
    if (id) ids.add(id);
  }

  /**
   * 并发取（F2），不是一条一条串行。
   *
   * 为什么：存储端口没有 `listVisitsByBatch`，只能按 id 一份一份取；
   * 串行时一次看板就是 1 + 2N 次库调用、每次一个网络往返 —— 40 人的班还能忍，
   * 一个学期之后它就会变成"看板一直转圈"。这里的 id 最多几十个，并发没有风险。
   *
   * `getVisit` 读不到就跳过（见上），所以只把成功的那几份收进结果；
   * 顺序按 id 排好再发，两次刷新给同一批人（看板不该因为并发完成的先后而抖动）。
   */
  const visitIds = [...ids].sort();
  const found = await Promise.all(visitIds.map((id) => store.getVisit(id)));
  return found.filter(Boolean);
}

/**
 * 系统失败轮次（B3）：有 `chat_send`、但**这一批里没有任何会话认领它**的轮数。
 *
 * ============================================================================
 * 为什么这个数必须有一个名字
 * ============================================================================
 * `TURN_SLOW` / `UPSTREAM` 在落会话之前就返回了（那一轮本来就不该写成学习记录），
 * 于是这一批只剩客户端发的 `chat_send`，一条会话行都没有。看板于是显示
 * 「0 会话 · 0.0% 一轮失败率」，而 `p1 > 0` 又让空态不触发 ——
 * **"模型 Key 不对"和"学生没来"在屏幕上完全一样**，而这两件事要做的动作相反。
 * 这个数就是给那一屏用的一条可见的线，不是一个新的指标。
 *
 * ============================================================================
 * 判据是"有没有会话认领"，不是"事件有没有归属键"
 * ============================================================================
 * 事件一定有归属键（服务端写入时就拦了），所以"孤儿"不是"没归属"，
 * 而是"它指向的那条会话**不在会话表里**"。用对象身份对账而不是再拼一次 id：
 * `sessions` 是 `stitchEvents` 的产物，它里面的事件就是 `events` 里的同一批对象
 * （合并只搬引用、不复制），所以一次 Set 查找就够，也不会因为 `'s1'` 与 `' s1 '`
 * 这种脏值分叉出第二套口径。
 *
 * 认领包括"经由 visit 认领"：页 1–2 的 `chat_send`（若有）会挂在它那次打开下的
 * 每一条会话上，那种轮次不算孤儿 —— 它确实写进了某条学习记录。
 */
function orphanTurnsOf(events, sessions) {
  const claimed = new Set();
  for (const session of asList(sessions)) {
    for (const event of asList(session?.events)) claimed.add(event);
  }

  let turns = 0;
  for (const event of asList(events)) {
    if (event?.type !== 'chat_send') continue;
    if (claimed.has(event)) continue;
    turns += 1;
  }
  return turns;
}

/**
 * 用量那一行（看板顶部常驻）。
 *
 * OCR 的两个数按**计数器**读：阿里云那条链路查不到余量，我们自己的计数是唯一口径
 * （设计稿 §5.8）。键名是这里与 Task 11 之间的契约，改一处就必须改两处：
 *   `ocr:batch:<batchId>`   整批累计（按成功调用计）
 *   `ocr:daily:<YYYY-MM-DD>` 当日累计（UTC，与所有时间戳同一个口径）
 * 现在没人写它们，读出来就是 0 —— 0 是真的"今天还没用过"，不是"没实现"。
 *
 * `ocrCap` 取批次上的整批额度，`dailyCap` 取环境变量（日粒度是部署级的，
 * 不属于某一批）。两个都是 0 表示没配，怎么解释留给 Task 11 的闸门。
 *
 * `orphanTurns` 见 `orphanTurnsOf`：它不是"失败率"，而是"这一批有多少轮
 * 根本没进学习记录" —— 必须和失败率分开看，否则 0.0% 会读成"一切正常"。
 */
async function usageOf(store, batch, batchId, env, sessions, summary, events) {
  const today = new Date().toISOString().slice(0, 10);

  let chatTurns = 0;
  for (const session of sessions) chatTurns += countOf(session?.counters?.chatTurns);

  return {
    ocrBatch: countOf(await store.getCounter(`ocr:batch:${batchId}`)),
    ocrDaily: countOf(await store.getCounter(`ocr:daily:${today}`)),
    ocrCap: countOf(batch?.ocrCap),
    dailyCap: countOf(env?.OCR_DAILY_CAP),
    /**
     * 对话轮数读 `counters.chatTurns`：那是**服务端**每一轮自己加的（见 session-store
     * 的 markActivity），而事件表里的 `chat_send` 是客户端报的。计费用前者。
     */
    chatTurns,
    /** 与 summary 同源：同一个数只许有一处算它（这里只是把它挪到用量行） */
    turnFailureRate: countOf(summary?.turnFailureRate),
    /** 有 `chat_send` 却没有会话认领的轮数（B3）：非 0 说明这一批系统性失败了 */
    orphanTurns: orphanTurnsOf(events, sessions),
  };
}

// ---------------------------------------------------------------------------
// 三个查询
// ---------------------------------------------------------------------------

/** `?batchId=` → 该批次；缺参数 400，查不到 404（两种都要说清楚，别都回 404） */
async function batchOf(store, url) {
  const batchId = text(url.searchParams.get('batchId'));
  if (!batchId) return { error: { status: 400, body: { error: '需要 batchId' } } };
  const batch = await store.getBatch(batchId);
  if (!batch) return { error: { status: 404, body: { error: '这个批次不存在' } } };
  return { batchId, batch };
}

/**
 * `GET /api/admin/overview?batchId=` → `{ batch, funnel, summary, usage, generatedAt }`
 *
 * 库调用：批次、会话、事件各一次，外加"每次打开各一次 `getVisit`"。
 * 最后那一项是**存储端口缺一个 `listVisitsByBatch`** 的代价（设计稿 §5.2 的布局里
 * 有 visit 集合，端口目前只给了按 id 取）。试点班 40 人量级没问题；
 * 到一个学期之后要改的是端口，不是在这里逐会话回查（那会变成 1 + 2N 次）。
 */
async function sendOverview(res, store, env, url) {
  const found = await batchOf(store, url);
  if (found.error) return answer(res, found.error.status, found.error.body);

  const { batch, batchId } = found;
  const sessions = asList(await store.listSessionsByBatch(batchId));
  const events = asList(await store.listEventsByBatch(batchId));
  const visits = await loadVisits(store, sessions, events);
  const stitched = stitchEvents(events, sessions, visits);

  const summary = summarizeSessions(stitched.sessions, batch, Date.now());

  return answer(res, 200, {
    batch,
    funnel: buildFunnel(stitched.visits, stitched.sessions),
    summary,
    usage: await usageOf(store, batch, batchId, env, stitched.sessions, summary, events),
    generatedAt: new Date().toISOString(),
  });
}

/** 这个人所有会话里最靠后的那一页；一次没开始过就是 0（画面上显示"—"） */
function lastPageOf(session) {
  const raw = session?.progress?.maxPage;
  if (raw === undefined || raw === null || raw === '') return 0;
  const page = Number(raw);
  if (!Number.isFinite(page) || page < 1) return 0;
  return Math.min(MAX_PAGE, Math.floor(page));
}

/** 两个时间戳取晚的那个；认不出的那个让位（不把 NaN 变成"现在"） */
function laterOf(a, b) {
  const left = text(a);
  const right = text(b);
  if (!right) return left || null;
  if (!left) return right;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

/**
 * `questionIndex`（题单序号，0 起）。
 *
 * 为什么不直接 `Number(...)`：`Number(null)`、`Number('')`、`Number([])` 全是 **0**，
 * 于是"没记题号"会被显示成"第 1 道"—— 一个具体的、错的位置，读的人不会怀疑它。
 * 所以只认有限数与非空数字串，其余一律 `null`（页面据此写"题号未知"）。
 */
function indexOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value.trim());
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/**
 * 会话列表里的一行（单人页展开区的数据）。
 *
 * `abandoned` 走 `metrics.isAbandoned`，与人的列表那一行**同一个判定**：
 * 两处各写一份的话，同一条会话可能在汇总行算"放弃"、在明细行算"没放弃"，
 * 而两个数都在同一屏上，读的人只会觉得看板不可信。
 *
 * `finished` 是布尔（这一条做完没有）；人的列表上的 `finished` 是**条数**。
 * 同名不同义是刻意的：两个位置各自读起来都自然，改名反而会在页面上多出一层翻译。
 */
function sessionSummary(session, batch, now) {
  return {
    id: text(session?.id) || null,
    problemId: text(session?.problemId) || null,
    questionIndex: indexOf(session?.questionIndex),
    page: lastPageOf(session),
    startedAt: text(session?.startedAt) || null,
    lastAt: text(session?.lastAt) || null,
    finished: Boolean(session?.finishedAt),
    abandoned: isAbandoned(session, batch, now),
  };
}

/**
 * 会话列表排序：`startedAt` 降序（最近的在前），同值再按 `id` 升序。
 *
 * 三档的理由：
 *   · 降序是这一屏的方向 —— 点开一个人，先看他刚做的事；
 *   · 同毫秒的两条（一次连做两道题会出现）必须有确定答案，否则两次刷新顺序不同，
 *     而"顺序变了"会被读成"数据变了"；
 *   · 解析不出时间的排在后面：它是坏数据，不该顶在"最近做了什么"的第一行。
 * 用 `<` 而不是 `localeCompare`：码位序不受运行环境 ICU 版本影响（与人的列表同一理由）。
 */
function byStartedDesc(a, b) {
  const left = Date.parse(String(a?.startedAt ?? ''));
  const right = Date.parse(String(b?.startedAt ?? ''));
  const leftOk = Number.isFinite(left);
  const rightOk = Number.isFinite(right);
  if (leftOk && rightOk && left !== right) return right - left;
  if (leftOk !== rightOk) return leftOk ? -1 : 1;
  const x = String(a?.id ?? '');
  const y = String(b?.id ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * `GET /api/admin/users?batchId=` → 人的列表（看板第三屏）。
 *
 * 名单是**并集**：
 *   · 成员表 —— "这个批次有哪些人"的事实。一次都没打开的人也必须在这里，
 *     否则"没人来"这件事在页面上完全看不见（而它是最需要被看见的那个数）；
 *   · 会话的归属 —— 已被删号但有作答的人。少了他，这一行的题数会凭空消失，
 *     而 `summary.sessionCount` 仍然算着他，两个数就对不上。
 *
 * `lastPage` 取该人所有会话里的最大页：一个人重做五道题时，"最后停在哪"问的是
 * "最好那一道做到第几页"，不是"最后创建的那条会话做到第几页"。
 *
 * `abandoned` 用 `metrics.isAbandoned`（唯一一份判定）套在"这个人最后一次活动"上，
 * 并且要求**还有没做完的会话**：`abandonHours` 是一批人的统一阈值，看板不该另立一份。
 *
 * `sessionList` 是这个人自己的会话（单人页展开区，控制者补充 I1），按开始时间降序、
 * 每人最多 `MAX_SESSION_LIST` 条，超出时在行上带 `sessionListTruncated`。
 * `sessions` 仍然是**条数**：那个字段已经在看板与用例里，改名会让两处静默对不上。
 */
async function sendUsers(res, store, url) {
  const found = await batchOf(store, url);
  if (found.error) return answer(res, found.error.status, found.error.body);

  const { batch, batchId } = found;
  const sessions = asList(await store.listSessionsByBatch(batchId));
  const now = Date.now();

  const stats = new Map();
  for (const session of sessions) {
    const userId = text(session?.userId);
    if (!userId) continue;
    const row = stats.get(userId) ?? { sessions: 0, finished: 0, lastPage: 0, lastAt: null, list: [] };
    row.sessions += 1;
    if (session.finishedAt) row.finished += 1;
    row.lastPage = Math.max(row.lastPage, lastPageOf(session));
    row.lastAt = laterOf(row.lastAt, session.lastAt);
    row.list.push(sessionSummary(session, batch, now));
    stats.set(userId, row);
  }

  const roster = new Set();
  for (const member of asList(await store.listMembers(batchId))) {
    const userId = text(member?.userId);
    if (userId) roster.add(userId);
  }
  for (const userId of stats.keys()) roster.add(userId);

  const rows = [];
  for (const userId of roster) {
    const user = await store.getUserById(userId);
    const stat = stats.get(userId) ?? { sessions: 0, finished: 0, lastPage: 0, lastAt: null, list: [] };
    const list = stat.list.slice().sort(byStartedDesc);
    const row = {
      userId,
      displayName: text(user?.displayName) || UNKNOWN_STUDENT,
      sessions: stat.sessions,
      finished: stat.finished,
      lastPage: stat.lastPage,
      lastAt: stat.lastAt,
      /** 还有没做完的、且最后一次活动已过阈值 → 放弃。"做完了"永远不算放弃 */
      abandoned: stat.sessions > stat.finished && isAbandoned({ lastAt: stat.lastAt }, batch, now),
      sessionList: list.slice(0, MAX_SESSION_LIST),
    };
    /** 只在真的切掉了东西时才加这个键：`false` 也会被读成"这里有个开关" */
    if (list.length > MAX_SESSION_LIST) row.sessionListTruncated = true;
    rows.push(row);
  }

  /**
   * 按代号字典序（同代号再按 id，保证两次导出/两次刷新顺序一致）。
   * 用 `<` 而不是 `localeCompare`：前者是确定的码位序，不受运行环境的 ICU 版本影响 ——
   * 同一份数据在两台机器上必须给出同一个顺序。
   */
  rows.sort((a, b) => {
    if (a.displayName !== b.displayName) return a.displayName < b.displayName ? -1 : 1;
    if (a.userId === b.userId) return 0;
    return a.userId < b.userId ? -1 : 1;
  });

  return answer(res, 200, rows);
}

// ---------------------------------------------------------------------------
// 一条会话的对话（单人页的第三层）
// ---------------------------------------------------------------------------

/**
 * 一条发言 → 页面要的那五档。
 *
 * **不 trim `text`**：首尾的空行是学生原话的一部分，而页面用 `pre-wrap` 原样显示
 * （控制者补充 I3 要求"保留换行"）。这里 trim 一下，界面上看起来只是少了一个空行，
 * 但抄进教研结论里的引文就和学生说的不一样了。
 *
 * `metaStep` / `metaGraphId` 刻意不带：它们指向解题路径上的位置，是教师复盘用的。
 * 整条 `turn` 直接透传就会把它们带出去，而页面上根本看不出多过什么。
 */
function turnOf(turn, index) {
  const item = {
    i: index,
    at: text(turn?.at) || null,
    role: text(turn?.role) || 'student',
    text: typeof turn?.text === 'string' ? turn.text : text(turn?.text),
  };
  if (turn?.level !== undefined && turn?.level !== null) item.level = turn.level;
  return item;
}

/**
 * 会话里的全部发言，按**数组顺序**（即发生时序）给出去。
 *
 * 两个来源：报告侧的 `record.turns`（`appendTurn` 写的那一份）与落库时统一过名字的
 * `turns`（`snapshotSession` 会把 record.turns 搬过来）。优先前者 —— 它才是原始的
 * 那一份；后者只是给导出与看板读的同一份拷贝。
 */
function turnsOf(record) {
  const source = Array.isArray(record?.record?.turns)
    ? record.record.turns
    : Array.isArray(record?.turns)
      ? record.turns
      : [];

  const turns = [];
  for (let i = 0; i < source.length; i += 1) {
    const turn = source[i];
    /** 坏条目（null / 字符串）跳过：它渲染出来只是一个空气泡，而 `i` 保留原位 */
    if (!turn || typeof turn !== 'object') continue;
    turns.push(turnOf(turn, i));
  }
  return turns;
}

/**
 * `GET /api/admin/session?sessionId=` → 一段对话。
 *
 * ============================================================================
 * 为什么必须显式投影，不能 `JSON.stringify(session)`
 * ============================================================================
 * 会话记录上挂着 `hintLog`，里面每一条都有 `rationale`（引擎的判断理由）、
 * `evidenceQuotes`（从题干里摘的原句）、`guardViolations`（被拦下的原话）、
 * `trace`。它们是教研复盘的原料，也是**这道题的解题路径**。整条回去等于把
 * 教师视图塞进了一个"看对话"的接口 —— 而这个泄漏不会报错、页面上也看不出来。
 *
 * 所以只回三样：`meta`（表头，都是归属与时间）、`turns`（学生说了什么、AI 回了什么）、
 * `reportSnapshot`（学生当时看到的那份报告，快照里本来就没有答案 —— 它冻结于
 * 出报告那一刻，导出件读的也是同一份）。
 *
 * ============================================================================
 * 三种"没有"要分开
 * ============================================================================
 *   400 缺 `sessionId`  —— 客户端的事，说清楚缺什么；
 *   404 记录不存在     —— 别再试了（`readSessionRecord` 回 null 只代表"确实没有"）；
 *   503 读不出来       —— 刷新重试有意义（它还在库里，只是这次没读到）。
 * 混成一个答案的后果在 `session-store.js` 的文件头写过一遍：调用方会"现造一条新的"。
 * 这里不回 `err.message`，详情进日志。
 */
async function sendSession(res, store, url) {
  const sessionId = text(url.searchParams.get('sessionId'));
  if (!sessionId) return answer(res, 400, { error: '需要 sessionId' });

  let record;
  try {
    record = await readSessionRecord(store, sessionId);
  } catch (err) {
    if (text(err?.code) !== 'SESSION_READ_FAILED') throw err;
    return answer(res, 503, { error: '读取学习记录失败，请刷新页面重试。', retryable: true });
  }
  if (!record) return answer(res, 404, { error: '这条学习记录不存在' });

  /**
   * 代号只在这条记录**有归属**时才查：匿名创建的会话没有 `userId`，
   * 去查一次只会拿到 null，还会让驱动处理一个 undefined 的键。
   * 查不到就写"未知"——与导出件的降级同一句话，不把内部 id 亮出来当人名。
   */
  const userId = text(record.userId);
  const user = userId ? await store.getUserById(userId) : null;

  return answer(res, 200, {
    meta: {
      id: text(record.id) || sessionId,
      userId: userId || null,
      displayName: text(user?.displayName) || UNKNOWN_STUDENT,
      problemId: text(record.problemId) || null,
      batchId: text(record.batchId) || null,
      startedAt: text(record.startedAt) || null,
      lastAt: text(record.lastAt) || null,
      /** 布尔：这一条做完没有（与 `sessionList` 里那一档同义） */
      finished: Boolean(record.finishedAt),
      page: lastPageOf(record),
    },
    turns: turnsOf(record),
    reportSnapshot: record.reportSnapshot ?? null,
  });
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/**
 * 导出路由的错误码映射。
 *
 * 只认 `code`，不匹配中文文案：文案随时会改，`code` 是契约。
 * 三个分支的差别是**可操作性**：
 *   404 → 这条/这一批不在了（别再试了）；
 *   503 → 我们这边读不出来（刷新重试有意义）。
 * 混成一个答案时，一次云调用超时会被报成"这条记录不存在" —— 而它其实还在库里，
 * 老师会去重新导一遍，然后得到同样的 404。
 */
function sendExportError(res, err) {
  const code = text(err?.code);
  if (code === 'SESSION_NOT_FOUND') return answer(res, 404, { error: '这条学习记录不存在' });
  if (code === 'BATCH_NOT_FOUND') return answer(res, 404, { error: '这个批次不存在' });
  if (code === 'SESSION_READ_FAILED') {
    return answer(res, 503, { error: '读取学习记录失败，请刷新页面重试。', retryable: true });
  }
  /** 认不出的错误：不回 `err.message`（里面可能有内部路径），但要让重试有意义 */
  return answer(res, 503, { error: '导出失败，请稍后重试。', retryable: true });
}

/**
 * `GET /api/admin/export?sessionId=` / `?batchId=` → `application/zip` 二进制。
 *
 * **不走 `sendJson`**：zip 是二进制，JSON.stringify 一个 Buffer 会得到
 * `{"type":"Buffer","data":[…]}` —— 它照样 200、照样有内容，只是老师打不开。
 *
 * 文件名用 ASCII（`bubujie-export.zip`）：中文文件名在老浏览器里会变成一串乱码，
 * 而收件人第一眼看到的就是文件名。
 */
async function sendExport(res, store, url) {
  const sessionId = text(url.searchParams.get('sessionId'));
  const batchId = text(url.searchParams.get('batchId'));
  if (!sessionId && !batchId) return answer(res, 400, { error: '需要 sessionId 或 batchId' });

  let buf;
  try {
    /** 两个都给时按单条导：那是更具体的那一个 */
    buf = sessionId ? await exportSingle(store, sessionId) : await exportBatch(store, batchId);
  } catch (err) {
    return sendExportError(res, err);
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', 'attachment; filename="bubujie-export.zip"');
  res.setHeader('content-length', String(buf.length));
  res.setHeader('cache-control', 'no-store');
  res.end(buf);
  return true;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 处理一个 `/api/admin/*` 请求。
 *
 * 调用方（router.js）**必须在登录守卫之前**调它：管理员口令与学生 token 是两件事，
 * 一个有口令的老师不该被"请先登录"挡在门外。
 *
 * @param {object} req
 * @param {object} res
 * @param {URL} url
 * @param {{ store: object|null, env: object }} ctx
 *   `store` 由 router 用 `getStore()` 打开（打不开时传 null）；`env` 是**请求级**配置
 *   （`envFor()` 的结果）—— 口令与额度都从它读，绝不读 process.env（公网那两个入口
 *   的配置根本不在 process.env 上）。
 * @returns {Promise<boolean>} 是否已处理（永远是 true）
 */
export async function handleAdminApi(req, res, url, { store, env } = {}) {
  /**
   * ① 这个部署有没有库 —— 写在第一行，先于口令。
   *    没有库的部署（内存驱动）上，"看板能打开但永远是空的"比"打不开"更糟：
   *    空数据会被读成"这批没人用"，而那是要拿去做结论的。
   */
  if (!store || text(store.kind) === 'memory') return answer(res, 404, NOT_FOUND);

  /**
   * ② 口令。没配 → 404（不承认这里有接口）；配了没带对 → 401。
   */
  const state = checkAdmin(req, env ?? {});
  if (state === 'disabled') return answer(res, 404, NOT_FOUND);
  if (state !== 'ok') return answer(res, 401, LOCKED);

  /** ③ 口令之后才判方法与路径：没口令的人连"哪些路径存在"都不该看到差别 */
  if (req.method !== 'GET') return answer(res, 405, { error: '只支持 GET' });

  const route = url.pathname.slice('/api/admin/'.length);

  try {
    if (route === 'overview') return await sendOverview(res, store, env ?? {}, url);
    if (route === 'users') return await sendUsers(res, store, url);
    /** 单人页：读一条会话的对话。只读，与导出那条路共用 `readSessionRecord` */
    if (route === 'session') return await sendSession(res, store, url);
    if (route === 'export') return await sendExport(res, store, url);
  } catch (err) {
    /**
     * 读库失败：503 而不是 500，且**不回 err.message**（可能有内部路径/集合名）。
     * `retryable` 是给页面的：它据此显示"刷新重试"而不是"联系管理员"。
     */
    console.warn('[admin] 读库失败：', err?.message ?? err);
    return answer(res, 503, { error: '读取数据失败，请刷新页面重试。', retryable: true });
  }

  return answer(res, 404, NOT_FOUND);
}
