/**
 * 漏斗与指标 —— 纯函数：不碰存储、不读时钟（"现在"一律由调用方传进来）。
 *
 * ============================================================================
 * 为什么这里连 store 都不碰（D1）
 * ============================================================================
 * 事件在库里是按归属键（`sessionId` / `visitId`）分开存的。这个模块若自己去读库，
 * 三种"读不到"就会混成同一个答案：真的没有事件、存储层坏了、归属键拼错了。
 * 三种都表现为"这一批没有失败"—— 而那正好是 §4 换平台触发条件要看的那一行。
 * 所以这里只认**调用方拼好的** `session.events`（Task 8 组装 overview 时先
 * `listEventsByBatch`，再按 `sessionId` 分组塞回会话对象）。
 *
 * 副作用是它可以在离线环境里被反复复算。这不只是"好测"：这批数字会被抄进
 * 给校长看的结论里（"第 2 页掉了一半""一轮失败率 6%"），抄的人不会重算。
 *
 * ============================================================================
 * 四页，不是五页
 * ============================================================================
 * `PAGES = ['题目','方式','解题','报告']` 是产品事实（public/index.html:1944），
 * `setPage(5)` 只是别名到 4；"再练一道"是报告页上的一个动作，不是第五级台阶。
 * 所以漏斗是 `p1→p2→p3→p4`，`practicePicks` 是一个计数器，不是柱子。
 * 若按五页实现，多出来的那根柱子会永远是 0，"走完了没有"就永远算不出来。
 *
 * ============================================================================
 * p1 与 p2..p4 的计数单位**刻意不同**
 * ============================================================================
 * p1 = `visits.length`（一次打开 = 一次 visit）：登录后落地就算打开，那时连会话
 *      都还没造出来，所以只能数打开。
 * p2..p4 = **不同的人**（`Set<userId>`）：会话是"一道题的一次作答"，一个人重做
 *      五道题会留下五条 session。若按会话条数算，他能把第 3 页撑成五个人，
 *      而"第 2 页掉了一半"这句话就成了假的 —— 而且不会报错。
 *
 * ============================================================================
 * 比率：分母为 0 时是 0，不是 NaN（D3）
 * ============================================================================
 * 绝不允许 NaN / Infinity 流到看板或 CSV：一根 NaN 柱子在界面上会画成一根到天的
 * 柱子，而它看起来像数据。所有比率统一 `Math.round(x * 100) / 100` ——
 * `0.6666666666` 这种尾数会被下一个人当成精度引用。
 *
 * ============================================================================
 * 一轮失败率的精确口径（D2 —— §4 的换平台触发条件）
 * ============================================================================
 * 按"轮"配对，不是数 reply 条数：
 *
 *   把该会话的 events 按 `seq` 顺序走一遍，每遇到一个 `chat_send` 就开一轮；
 *   到下一个 `chat_send` 之前出现的 `chat_reply` / `chat_error` 归给这一轮；
 *   到会话结尾仍没等到回复的那一轮算失败。
 *
 *     分子 = 有 `chat_send` 但没等到 `chat_reply` / `chat_error` 的轮数
 *          + 出现 `chat_error` 且 `code ∈ {TURN_SLOW, UPSTREAM}` 的轮数
 *     分母 = `chat_send` 总数（为 0 时返回 0）
 *
 * 为什么 `chat_error` 只认这两个码：`GUARD` 是我方护栏拦下并给了替代回复的，
 * 那一轮学生**收到了东西**。把它算成失败，失败率就会随着护栏变严而升高，
 * 于是这个数不再回答"平台稳不稳"，而是回答"护栏严不严"—— 两件事不能混。
 *
 * ============================================================================
 * 两个"不要猜"（D4 / D5）
 * ============================================================================
 * · 停留（`deriveDwell`）：手机切走、进程被杀都会丢 `page_exit`。丢了就退回
 *   "这一页 `page_enter` 之后的第一条事件"作为离开时刻；连这个都没有就报 0，
 *   不报 Infinity，也不去编一个"平均停留"。
 * · 放弃（`isAbandoned`）：`lastAt` 解析不出来时返回 false。宁可算"没放弃"，
 *   也不要凭空造一个放弃 —— 这个数会被拿去支持"学生不用"的结论。
 */

/** 产品是四页：题目 / 方式 / 解题 / 报告（`setPage(5)` 只是别名到 4，没有第五级台阶）。 */
const PAGES = [1, 2, 3, 4];

/** `progress.maxPage` 缺省值。缺进度就按"刚进来"算 1，不猜他走到了后面。 */
const DEFAULT_MAX_PAGE = 1;

/**
 * 隔夜：相邻两段之间真的断了 6 小时以上。
 * 用"上一段的最后一条事件 → 下一段的开始"，而不是两个 start 相减 ——
 * 段内的最后一条事件才是学生真正离开的时刻。
 */
const OVERNIGHT_GAP_MS = 6 * 3600e3;

/**
 * 一轮里算"真失败"的错误码。`GUARD` 不在里面（见文件头）：
 * 它是护栏拦下并给了替代回复的一轮，学生收到了东西。
 */
const TURN_FAILURE_CODES = new Set(['TURN_SLOW', 'UPSTREAM']);

// ---------------------------------------------------------------------------
// 小工具（都是纯的，且都保证"坏输入 → 0 / NaN 由调用方判"，不抛）
// ---------------------------------------------------------------------------

/** 两位小数。非有限数一律收成 0 —— 这个模块里没有"未知"，只有"还没算出来"。 */
function round2(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

/** 分子 / 分母；分母为 0（或不是有限数）时返回 0，不是 NaN（D3）。 */
function rate(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return round2(numerator / denominator);
}

/**
 * 时间 → 毫秒。ISO 字符串（服务端盖的 24 字符形状）、毫秒数、Date 都认。
 * 认不出来返回 NaN —— 由调用方决定"算没发生"还是"跳过这一对"，
 * 绝不在这里顺手当成 0（那会把"不知道"变成一个具体时刻）。
 */
function msOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : Number.NaN;
  if (typeof value === 'string') return Date.parse(value);
  return Number.NaN;
}

/** 计数类字段用：缺失、空串、'坏值' 一律算 0，不让 NaN 混进累加。 */
function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function textOf(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/**
 * "这个人是谁"的唯一判据：`userId` → `visitId` → `id`。
 *
 * 为什么要有退路：`userId` 是登录后才有的，而 Task 3 的校验允许只带 `visitId`
 * 或什么都不带（只有 `login` 允许全空）。两个都空的时候给这一条一个独立键
 * （`#序号`）—— 宁可把一个人算成两个，也不要把两个不同的人并成一个：
 * 合并是**少算人**，而少算的人不会以任何形式暴露出来。
 */
function userKeyOf(record, index = 0) {
  for (const field of ['userId', 'visitId', 'id']) {
    const text = textOf(record?.[field]);
    if (text !== '') return text;
  }
  return `#${index}`;
}

/** 这个会话走到过第 n 页没有。`reached.pN` 有值就是走到过（值只是时间戳）。 */
function reachedOf(session, page) {
  const reached = session?.progress?.reached;
  if (!reached || typeof reached !== 'object') return false;
  return Boolean(reached[`p${page}`]);
}

/**
 * `progress.maxPage`，夹到 1–4。
 *
 * 夹的原因：产品只有四页，越界值只能是坏数据。让 5 混进"人均走到第几页"，
 * 看板就会显示一个界面上不存在的页。
 */
function maxPageOf(session) {
  const raw = Number(session?.progress?.maxPage);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_PAGE;
  return Math.min(PAGES.length, Math.max(1, raw));
}

/**
 * nearest-rank 百分位：`Math.ceil(p * n) - 1`，不插值。
 *
 * 不插值的理由：这个数要能被对回**某一次真实回复**（"P90 = 4.1 秒"说的是
 * "十次里有一次比 4.1 秒更慢"，而 4.1 秒最好真的是某次发生过的时长）。
 * 同样不四舍五入：它取的就是样本值本身。没有样本时返回 0。
 */
function nearestRank(sortedSamples, percentile) {
  const n = sortedSamples.length;
  if (n === 0) return 0;
  const rank = Math.ceil(percentile * n) - 1;
  const index = Math.min(n - 1, Math.max(0, rank));
  const value = sortedSamples[index];
  return Number.isFinite(value) ? value : 0;
}

/**
 * 一轮失败率的配对（D2）。
 *
 * 返回 `{ sends, failures }`，由调用方跨会话累加后再相除 —— 而不是每个会话
 * 各算一个比率再平均：后者会让"只发了一轮且失败"的会话权重和"发了二十轮"的一样大。
 */
function countTurns(events) {
  const turns = [];
  let current = null;

  for (const event of events) {
    const type = event?.type;
    if (type === 'chat_send') {
      current = { responded: false, hardFailure: false };
      turns.push(current);
      continue;
    }
    // 没有 send 的 reply/error 不属于任何一轮（弱网重发、上一次会话的尾巴）
    if (!current) continue;
    if (type === 'chat_reply') {
      current.responded = true;
      continue;
    }
    if (type === 'chat_error') {
      // 收到 error 也算"有回应"：学生拿到了错误提示，不是无限等待
      current.responded = true;
      if (TURN_FAILURE_CODES.has(event?.payload?.code)) current.hardFailure = true;
    }
  }

  const failures = turns.filter((turn) => !turn.responded || turn.hardFailure).length;
  return { sends: turns.length, failures };
}

/**
 * 这个会话有没有"隔夜回来"：相邻两段之间断了 6 小时以上。
 *
 * 为什么要单独报这个数：设计稿 §7 的风险是"阈值自己制造结论"——
 * `abandonHours` 一调，'放弃'的人就变。隔夜回来是不受阈值影响的旁证，
 * 用来看这个阈值到底误伤了多少人。
 *
 * 没有 `segments` 的会话（事件还没组装，或 Task 4 之前的旧记录）贡献 0，不猜。
 */
function hasOvernightReturn(session) {
  const segments = session?.segments;
  if (!Array.isArray(segments) || segments.length < 2) return false;

  for (let i = 1; i < segments.length; i += 1) {
    const previous = segments[i - 1];
    const current = segments[i];
    const lastEventAt = msOf(previous?.lastEventAt);
    // 段里没有 lastEventAt（事件还没组装进来）就退到这个段的开始时刻
    const before = Number.isFinite(lastEventAt) ? lastEventAt : msOf(previous?.start);
    const after = msOf(current?.start);
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    if (after - before > OVERNIGHT_GAP_MS) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 放弃：读时算（D5）
// ---------------------------------------------------------------------------

/**
 * 这个会话算不算"放弃了"。
 *
 * 判据只有一条：**没有 `finishedAt`，且 `lastAt` 已经超过 `batch.abandonHours`**。
 * `abandoned` 刻意不落库（设计稿 §5.2）：一旦写成状态，它就会变成续做入口的门槛，
 * 而那个门槛会自己制造数据 —— "一天做一道题"的学生隔夜被判放弃、并且真的回不来。
 *
 * 三个"宁可不变 true"的边界：
 *   · `lastAt` 解析不出来（NaN）→ false。凭空造一个放弃，比漏报一个更危险。
 *   · `now` / `abandonHours` 不是有限数 → false。阈值缺失时全员不算放弃，
 *     而不是全员算放弃 —— 错的方向要选不会误伤学生的那一边。
 *   · 判据是"**超过**"，不是"达到"：正好 24 小时整的那次不算。
 *
 * @param {object} session 会话（只需要 `lastAt` / `finishedAt`）
 * @param {object} batch 批次（用 `abandonHours`）
 * @param {number|string|Date} now "现在"，毫秒数（也接受 ISO / Date，便于调用方）
 * @returns {boolean}
 */
export function isAbandoned(session, batch, now) {
  if (!session || session.finishedAt) return false;

  const lastAt = msOf(session.lastAt);
  const at = msOf(now);
  const hours = Number(batch?.abandonHours);
  if (!Number.isFinite(lastAt) || !Number.isFinite(at) || !Number.isFinite(hours)) return false;

  return at - lastAt > hours * 3600e3;
}

// ---------------------------------------------------------------------------
// 页面停留（D4）
// ---------------------------------------------------------------------------

/**
 * 某一页的停留时长（毫秒）。
 *
 * 两条规则，按优先级：
 *   ① 配对的 `page_enter` / `page_exit` 相减；同一页进出多次就相加（学生退回去又进来）。
 *      这里用**页号**配对，不是"随便找下一个 exit"：学生对第 2 页按了后退、
 *      又进第 3 页时，第 3 页的 exit 不能被算给第 2 页。
 *   ② 没有 `page_exit`（手机上切走、进程被杀 —— 这两个事件本来就常常发不出来）
 *      就退一步：用该页 `page_enter` 之后的**第一条事件**的时刻当离开时刻。
 *      那是一个"他还活着"的真实证据，比"报 0"或"猜一个平均值"都诚实。
 *      之后什么都没有（它就是最后一条事件）→ 0，不报 Infinity。
 *
 * 坏时间戳、颠倒的进出顺序都只影响这一段：负数截成 0，NaN 的那段跳过，
 * 绝不让一个坏 `at` 把整页的停留变成 NaN。
 *
 * @param {object[]} events 该会话的事件（按 `seq` 升序，调用方保证）
 * @param {number} page 1–4
 * @returns {number} 毫秒，有限的非负数
 */
export function deriveDwell(events, page) {
  const list = Array.isArray(events) ? events : [];
  const wanted = Number(page);

  let total = 0;
  let openAt = Number.NaN;
  let openIndex = -1;

  for (let i = 0; i < list.length; i += 1) {
    const event = list[i];
    if (Number(event?.payload?.page) !== wanted) continue;
    const at = msOf(event?.at);

    if (event?.type === 'page_enter') {
      // 上一段没等到 exit 就又进了一次：用这次 enter 收尾上一段（规则 ②）
      if (Number.isFinite(openAt) && Number.isFinite(at)) total += Math.max(0, at - openAt);
      openAt = at;
      openIndex = i;
      continue;
    }

    if (event?.type === 'page_exit') {
      if (Number.isFinite(openAt) && Number.isFinite(at)) total += Math.max(0, at - openAt);
      openAt = Number.NaN;
      openIndex = -1;
    }
  }

  if (Number.isFinite(openAt)) {
    const nextAt = msOf(list[openIndex + 1]?.at);
    if (Number.isFinite(nextAt)) total += Math.max(0, nextAt - openAt);
  }

  return Number.isFinite(total) && total > 0 ? total : 0;
}

// ---------------------------------------------------------------------------
// 四页漏斗
// ---------------------------------------------------------------------------

/**
 * 四页漏斗。
 *
 * `p1 = visits.length`（打开次数），`p2..p4` 是**不同的人**（见文件头）。
 * `perPage` 是看板画柱子要的四行：每行的 `visitors` 就是 p1..p4，
 * `avgDwellMs` 是**这一页的这批人**的平均停留 —— 分母与 `visitors` 同源，
 * 读者不会把"多少个柱子"和"多少个样本"混着引用。
 *
 * 停留的来源只有会话自带的 `events`：一个会话没带事件，它的停留贡献就是 0，
 * 但它仍然算一个人（分母不偷偷变小）。第 1 页的事件挂在 visit 上，
 * 本函数拿不到 —— 那一行的平均停留就诚实地是 0，而不是拿别的页去顶。
 *
 * 若调用方没把 `visits` 传全（弱网下 `visit_open` 丢过），`conversion` 可能大于 1。
 * 这是刻意的：悄悄夹平会让"visit 记录缺了"这件事永远看不见。
 *
 * `dropOffPage` 的口径：相邻两页里**人数掉得最多**的那一级，返回落点页号 2/3/4。
 *   · 并列时取最靠前的一级 —— 学生越早流失，修它的收益越大；
 *   · 一级都没掉 → `null`（没有掉点这回事，不许硬指一页）；
 *   · `visits.length <= 1` → `null` 且 `sampleTooSmall: true`。一个人的样本算出来的
 *     "最大掉点"是假结论，看板据此显示"样本不足"而不是画一根很像样的柱子。
 *
 * @param {object[]} visits 本次批次的打开记录
 * @param {object[]} sessions 会话（可带 `events`）
 * @returns {{ p1: number, p2: number, p3: number, p4: number,
 *            conversion: { p1_p2: number, p2_p3: number, p3_p4: number },
 *            dropOffPage: number|null, sampleTooSmall: boolean,
 *            perPage: Array<{ page: number, visitors: number, avgDwellMs: number }> }}
 */
export function buildFunnel(visits, sessions) {
  const visitList = Array.isArray(visits) ? visits : [];
  const sessionList = Array.isArray(sessions) ? sessions : [];

  const p1 = visitList.length;

  /** page → Set（这一页出现过的人） */
  const usersByPage = new Map(PAGES.map((page) => [page, new Set()]));
  /** page → Map<人, 毫秒>（同一个人在这一页的总停留） */
  const dwellByPage = new Map(PAGES.map((page) => [page, new Map()]));

  for (let i = 0; i < sessionList.length; i += 1) {
    const session = sessionList[i];
    if (!session || typeof session !== 'object') continue;
    const key = userKeyOf(session, i);

    for (const page of PAGES) {
      if (!reachedOf(session, page)) continue;
      usersByPage.get(page).add(key);
      const previous = dwellByPage.get(page).get(key) ?? 0;
      dwellByPage.get(page).set(key, previous + deriveDwell(session.events, page));
    }
  }

  const counts = [p1, ...PAGES.slice(1).map((page) => usersByPage.get(page).size)];
  const [p2, p3, p4] = counts.slice(1);

  const perPage = PAGES.map((page, index) => {
    const perUser = dwellByPage.get(page);
    const totalDwell = [...perUser.values()].reduce((sum, ms) => sum + ms, 0);
    return {
      page,
      visitors: counts[index],
      avgDwellMs: perUser.size > 0 ? round2(totalDwell / perUser.size) : 0,
    };
  });

  const sampleTooSmall = p1 <= 1;
  let dropOffPage = null;
  if (!sampleTooSmall) {
    let biggestLoss = 0;
    for (let i = 0; i < counts.length - 1; i += 1) {
      const loss = counts[i] - counts[i + 1];
      // 严格大于：并列时保住先遇到的那一级（最靠前的流失）
      if (loss > biggestLoss) {
        biggestLoss = loss;
        dropOffPage = i + 2;
      }
    }
  }

  return {
    p1,
    p2,
    p3,
    p4,
    conversion: {
      p1_p2: rate(p2, p1),
      p2_p3: rate(p3, p2),
      p3_p4: rate(p4, p3),
    },
    dropOffPage,
    sampleTooSmall,
    perPage,
  };
}

// ---------------------------------------------------------------------------
// 批次汇总
// ---------------------------------------------------------------------------

/**
 * 一个批次的汇总指标（设计稿 §5.4 的"每批次都算的数"）。
 *
 * 只读 `session.events`（D1 的约定，见文件头）。三个跨会话的比率
 * （沉默率 / 一轮失败率 / 分位数）都是**先累加原始计数、最后相除**，
 * 不是每个会话各算一个再平均 —— 后者会让"只发了一轮"的会话和"发了二十轮"
 * 的会话权重一样大，而"一轮失败率"的分母必须是**轮**。
 *
 * `avgQuestionsPerUser` 的数的是**不同的题号**，不是会话条数：同一道题重做一次
 * 不是一道新题（"重来"由 `resetTotal` / `intakeChangeTotal` 与同题多会话另算）。
 * 认不出题号的会话（照片/粘贴那条路）自己算一道，不互相合并。
 *
 * 所有比率两位小数；分母为 0 时是 0（D3）。`latencyP50/P90` 例外 ——
 * 它们取的是真实样本值本身（nearest-rank，不插值、不四舍五入），见 `nearestRank`。
 *
 * @param {object[]} sessions 会话（`events` / `progress` / `counters` / `segments` 可选）
 * @param {object} batch 批次（用 `abandonHours`）
 * @param {number|string|Date} now "现在"，毫秒数
 * @returns {{ sessionCount: number, userCount: number, avgQuestionsPerUser: number,
 *            avgMaxPage: number, resetTotal: number, intakeChangeTotal: number,
 *            suppressedRate: number, latencyP50: number, latencyP90: number,
 *            turnFailureRate: number, abandonCount: number, overnightReturns: number }}
 */
export function summarizeSessions(sessions, batch, now) {
  /**
   * 空项（`null` / 字符串）不算一个会话：那是坏数组的形状，不是"有一个会话什么都没有"。
   * 把它算进 `sessionCount`，人均题数与人均页数的分母就凭空变大了。
   */
  const list = Array.isArray(sessions) ? sessions.filter((session) => session && typeof session === 'object') : [];

  const userKeys = new Set();
  const questionsByUser = new Map();
  const latencies = [];

  let maxPageTotal = 0;
  let resetTotal = 0;
  let intakeChangeTotal = 0;
  let replyCount = 0;
  let suppressedCount = 0;
  let sendCount = 0;
  let failedTurnCount = 0;
  let abandonCount = 0;
  let overnightReturns = 0;

  for (let i = 0; i < list.length; i += 1) {
    const session = list[i];
    const key = userKeyOf(session, i);
    userKeys.add(key);

    if (!questionsByUser.has(key)) questionsByUser.set(key, new Set());
    questionsByUser.get(key).add(textOf(session.problemId) || `#${i}`);

    maxPageTotal += maxPageOf(session);
    resetTotal += finiteNumber(session.counters?.resetCount);
    intakeChangeTotal += finiteNumber(session.counters?.intakeChanges);

    const events = Array.isArray(session.events) ? session.events : [];
    for (const event of events) {
      if (event?.type !== 'chat_reply') continue;
      replyCount += 1;
      /**
       * 只认布尔 `true`：埋点里若出现字符串 `'false'`（前端把布尔忘了转），
       * 宽松判断会把它算成"AI 沉默了"，而这个数是要拿去做质量结论的。
       */
      if (event?.payload?.suppressed === true) suppressedCount += 1;
      const ms = event?.payload?.ms;
      if (typeof ms === 'number' && Number.isFinite(ms)) latencies.push(ms);
    }

    const turns = countTurns(events);
    sendCount += turns.sends;
    failedTurnCount += turns.failures;

    if (isAbandoned(session, batch, now)) abandonCount += 1;
    if (hasOvernightReturn(session)) overnightReturns += 1;
  }

  latencies.sort((a, b) => a - b);
  const sessionCount = list.length;
  const userCount = userKeys.size;
  const questionTotal = [...questionsByUser.values()].reduce((sum, problems) => sum + problems.size, 0);

  return {
    sessionCount,
    userCount,
    avgQuestionsPerUser: userCount > 0 ? round2(questionTotal / userCount) : 0,
    avgMaxPage: sessionCount > 0 ? round2(maxPageTotal / sessionCount) : 0,
    resetTotal,
    intakeChangeTotal,
    suppressedRate: rate(suppressedCount, replyCount),
    latencyP50: nearestRank(latencies, 0.5),
    latencyP90: nearestRank(latencies, 0.9),
    turnFailureRate: rate(failedTurnCount, sendCount),
    abandonCount,
    overnightReturns,
  };
}
