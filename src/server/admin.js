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
import { ownerOf } from './events.js';
import { safeEqual } from './demo-gate.js';

/** 产品只有四页（`setPage(5)` 只是 4 的别名）。越界的 maxPage 只能是坏数据。 */
const MAX_PAGE = 4;

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
 * 顺序：直接沿用入参的顺序。入参是 `listEventsByBatch` 的产物（驱动已按 `seq` 升序），
 * 而 `metrics.js` 对会话的事件还会再排一次、对 visit 的不再排 —— 所以调用方必须
 * 按库里读出来的那份顺序给，不能自己拼一个乱序数组进来。
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

  const attach = (record) => ({
    ...record,
    events: byOwner.get(text(record?.id)) ?? [],
  });

  return {
    sessions: asList(sessions).map(attach),
    visits: asList(visits).map(attach),
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

  const visits = [];
  for (const id of [...ids].sort()) {
    const visit = await store.getVisit(id);
    if (visit) visits.push(visit);
  }
  return visits;
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
 */
async function usageOf(store, batch, batchId, env, sessions, summary) {
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
    usage: await usageOf(store, batch, batchId, env, stitched.sessions, summary),
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
    const row = stats.get(userId) ?? { sessions: 0, finished: 0, lastPage: 0, lastAt: null };
    row.sessions += 1;
    if (session.finishedAt) row.finished += 1;
    row.lastPage = Math.max(row.lastPage, lastPageOf(session));
    row.lastAt = laterOf(row.lastAt, session.lastAt);
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
    const stat = stats.get(userId) ?? { sessions: 0, finished: 0, lastPage: 0, lastAt: null };
    rows.push({
      userId,
      displayName: text(user?.displayName) || UNKNOWN_STUDENT,
      sessions: stat.sessions,
      finished: stat.finished,
      lastPage: stat.lastPage,
      lastAt: stat.lastAt,
      /** 还有没做完的、且最后一次活动已过阈值 → 放弃。"做完了"永远不算放弃 */
      abandoned: stat.sessions > stat.finished && isAbandoned({ lastAt: stat.lastAt }, batch, now),
    });
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
