/**
 * 单条会话导出：给人看的 Markdown + 给机器看的 JSON（设计稿 §5.7）。
 *
 * ============================================================================
 * 这个文件只做两件事
 * ============================================================================
 * ① 把一条会话渲染成人能读的 Markdown；
 * ② 把它打成 zip（`session.md` + `session.json`，控制者补充 E7 说不多不少两份）。
 *
 * ============================================================================
 * 为什么不在这里算报告
 * ============================================================================
 * 报告快照是**冻结**的：学生当时看到的那份就是那份（见 session-store.js 的边界 ③）。
 * 导出时重新调 `buildReport` 会得到"用今天的代码算昨天的结论"——
 * 代码一改，同一份历史数据导出两次结果不同，而这种差异没有任何人会发现。
 * 所以这里只读 `reportSnapshot`，快照里没有的字段一个字都不写。
 *
 * 同理，**题目对象不进这里**：`problem` 里有参考答案与解题路径，
 * 而导出件是要发给外人打开的。渲染器只接触 `{ session, user, batch }` 三个参数，
 * 想泄漏也没有入口。
 *
 * ============================================================================
 * 颜色档不进导出件，只进数字（控制者裁决 E8）
 * ============================================================================
 * `buildReport` **不产**顶层 `level`；页面上那个"掌握 / 待巩固 / 薄弱"的颜色
 * 是前端拿独立完成度推出来的，不存库。所以导出件不自造颜色：
 *   · 快照里带 `level` 就照抄（向前兼容），没有就不写这一行；
 *   · 有没有颜色都写数字：独立完成度、层级分布、卡点、公式卡次数；
 *   · 报告段末尾用一句话说明"颜色不存库"——单条导出件会一个人出差，
 *     收件人看不到页面上那个颜色，也看不到批量导出的 README。
 *
 * ============================================================================
 * 记录不全时不能崩（控制者补充 E5）
 * ============================================================================
 *   · 会话不存在 → 抛带 `code` 的中文错误，由路由层转 404（不该在路由里猜文案）；
 *   · 用户被删了但记录还在 → 名字写"未知"（不能写 undefined，那看起来像 bug）；
 *   · 批次查不到 → "未知批次"。
 *
 * 会话可能根本没走到报告页。那种情况 Markdown 里必须写明**"未到达报告页"**
 * （控制者补充 E6），不能留白：留白会被读成"报告丢了"，而"没走到报告页"
 * 恰恰是这类数据里最有信息量的一条。
 */

import { readSessionRecord, snapshotSession } from './session-store.js';
import { OVERNIGHT_GAP_MS, hasOvernightReturn, isAbandoned } from './metrics.js';
import { ownerOf } from './events.js';
import { createZip } from './zip.js';

/** 查不到时的兜底：中文，且一眼能看出是"查不到"而不是"字段叫这个" */
const UNKNOWN_STUDENT = '未知';
const UNKNOWN_BATCH = '未知批次';

/** 导出件只允许两份（E7） */
const MARKDOWN_NAME = 'session.md';
const JSON_NAME = 'session.json';

/**
 * 报告段末尾那句说明（控制者裁决 E8）。
 *
 * 为什么必须印在 Markdown 里、而不是只写在批量导出的 README 里：
 * 单条导出件会**一个人出差**（发给家长、发给教研），它身边没有 README。
 * 收件人看到一张没有"掌握/待巩固/薄弱"的报告，第一反应会是"报告缺了"。
 */
const LEVEL_DISCLAIMER = '掌握程度是页面上由独立完成度推导出的颜色档，不存库；导出件以数字为准。';

/** 卡点最多列 10 条；超出部分写"…另有 K 条" */
const STUCK_LIMIT = 10;

/** 深层问题 / 下一步各最多 5 条 */
const LIST_LIMIT = 5;

/**
 * 只接受真正的有限数。
 *
 * 为什么不用 `Number(x)` 直接判：`Number(null)` 是 0，于是"没有 stepIndex"的记录
 * 会在导出件里变成"第 0 步"——一个看起来像数据、其实是默认值的数字。
 */
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 取一个非空字符串字段，否则给兜底值 */
function text(value, fallback = '') {
  const s = typeof value === 'string' ? value.trim() : '';
  return s === '' ? fallback : s;
}

/**
 * 相对分钟：`+00` / `+01` / `+02`（控制者补充 E4）。
 *
 * 为什么不用绝对时间：导出件是给人读的。读的人关心的是"隔了多久才开口"，
 * 不是"他那边几点"——而绝对时间还会逼着读者去换算时区（导出是 UTC，
 * 读者在东八区，差八小时看着就像"半夜三点在做题"）。
 *
 * 解析不出来时返回 null（调用方写"时间未知"）：宁可承认不知道，
 * 也不要在导出件里出现 `+NaN 分钟`。
 */
function relativeMinutes(startIso, atIso) {
  const start = Date.parse(String(startIso ?? ''));
  const at = Date.parse(String(atIso ?? ''));
  if (!Number.isFinite(start) || !Number.isFinite(at)) return null;
  /** 时钟被拨过时差值为负，夹到 0：导出件里不该出现 `+-3 分钟` */
  const minutes = Math.max(0, Math.round((at - start) / 60_000));
  return `+${String(minutes).padStart(2, '0')}`;
}

/**
 * 一轮对话的小标题。
 *
 * 老师的轮次带层级（L1–L3）：这份导出件最有价值的量就是"给了多强的帮助"，
 * 而它只在 `level` 里。学生轮次没有层级，也不该有。
 */
function turnHeading(turn, startedAt) {
  const when = relativeMinutes(startedAt, turn?.at);
  const clock = when ? `${when} 分钟` : '时间未知';
  const level = finiteNumber(turn?.level);
  const who = turn?.role === 'student' ? '学生' : turn?.role === 'ai' ? '老师' : '其他记录';
  const badge = who === '老师' && level !== null ? `${who}（L${level}）` : who;
  return `### ${clock} · ${badge}`;
}

/** 标题：谁、哪一批、哪道题、何时开始（顺序固定，见控制者补充的段落顺序） */
function renderHead({ student, batchLabel, problemId, startedAt }) {
  return [
    `# 学习记录 · ${student}`,
    '',
    `- 学生：${student}`,
    `- 批次：${batchLabel}`,
    `- 题目：${problemId}`,
    `- 开始：${startedAt || '未知'}`,
  ].join('\n');
}

/**
 * 题目段。
 *
 * 这里放不了题干：导出件不接触题目对象（那里面有答案）。所以写清"为什么不写"，
 * 而不是留一个空段 —— 空段会被读成"导出漏了题干"，而实际上是刻意不导。
 */
function renderProblem(problemId, snapshot) {
  const lines = ['## 题目', '', `- 题号：${problemId}`];
  const title = text(snapshot?.problemTitle);
  if (title) lines.push(`- 题名：${title}`);
  lines.push('', '导出件只含作答过程：不含题干原文，也不含答案与解题路径。');
  return lines.join('\n');
}

/** 对话段：按轮次顺序，每轮一个小标题 + 原文 */
function renderConversation(turns, startedAt) {
  const lines = ['## 对话', ''];
  if (turns.length === 0) {
    lines.push('还没有对话：这条记录里学生还没有说过话。');
    return lines.join('\n');
  }
  lines.push(turns.map((turn) => `${turnHeading(turn, startedAt)}\n\n${String(turn?.text ?? '')}`).join('\n\n'));
  return lines.join('\n');
}

/**
 * 0..1 的比例 → 无小数的百分数：`0.6157` → `62%`（控制者裁决 E8）。
 *
 * 为什么不留小数：读者要的是"大概走了几成"。`61.57%` 那两位是假精度——
 * `independence` 本身是"走过的步数 / 总步数"再扣分，不是测量值。
 *
 * 为什么认"已经是百分数"的输入：手写或从旧版迁移来的快照可能直接存 `62`。
 * 再乘 100 会让导出件写出 `6200%`——一个一眼就错、却很容易漏掉的数。
 */
function percentText(value) {
  const n = finiteNumber(value);
  if (n === null) return null;
  const percent = n > 1 ? n : n * 100;
  return `${Math.round(Math.min(100, Math.max(0, percent)))}%`;
}

/**
 * 独立完成度。
 *
 * 两种形状都要认：`buildReport` 给的是对象（`{score, note, …}`），
 * 而手写/迁移过来的快照可能直接是数字。
 *
 * `note` 为什么不丢：它是"你独立走过了 3 / 6 个关键步骤"这种人话，
 * 数字替代不了它——`50%` 说不出扣分扣在哪。
 */
function renderIndependence(independence) {
  const direct = percentText(independence);
  if (direct !== null) return direct;
  const score = percentText(independence?.score);
  if (score === null) return null;
  const note = text(independence?.note);
  return note ? `${score} —— ${note}` : score;
}

/**
 * 引导轮次的层级分布：`L0 1 次 · L1 2 次 · L2 1 次 · L3 0 次`（控制者裁决 E8）。
 *
 * 为什么 0 次也写：教研看的是分布的形状。"L3 一次都没有"与"这一级没统计"
 * 是两件事，少一项就会被读成后者。
 */
function renderHintLevels(hintStats) {
  const byLevel = hintStats?.byLevel;
  if (!byLevel || typeof byLevel !== 'object') return null;
  const parts = [0, 1, 2, 3].map((level) => `L${level} ${finiteNumber(byLevel[level]) ?? 0} 次`);
  return `- 引导轮次：${parts.join(' · ')}`;
}

/**
 * 卡点清单：`第 N 步 · <kind> · 引导 M 轮`（控制者裁决 E8）。
 *
 * `kind` 是内部枚举名，但这一版导出件的读者是教研：`precondition_gap` 对他们
 * 是分类，不是噪音。`stepTitle` 不进这一行——同一步的标题是学生可见的说法，
 * 定位用步号；完整字段在 `session.json` 里，随时可以对回去。
 */
function renderStuckPoints(stuckPoints) {
  if (!Array.isArray(stuckPoints)) return [];
  const shown = stuckPoints.slice(0, STUCK_LIMIT);
  const lines = shown.map((point) => {
    const parts = [];
    const stepIndex = finiteNumber(point?.stepIndex);
    parts.push(stepIndex === null ? '步骤未知' : `第 ${stepIndex} 步`);
    const kind = text(point?.kind);
    if (kind) parts.push(kind);
    const rounds = finiteNumber(point?.hintRounds);
    if (rounds !== null) parts.push(`引导 ${rounds} 轮`);
    return `  - ${parts.join(' · ')}`;
  });
  const rest = stuckPoints.length - shown.length;
  if (rest > 0) lines.push(`  - …另有 ${rest} 条`);
  return lines;
}

/**
 * 字符串清单（深层问题 / 下一步行动）：一行一条，最多 5 条。
 *
 * 截断必须留痕：少写的那几条如果静默消失，读的人只会以为"这份报告就这些"。
 */
function renderTextList(items, limit = LIST_LIMIT) {
  if (!Array.isArray(items)) return [];
  const shown = items.slice(0, limit);
  const lines = shown.map((item) => text(item)).filter(Boolean).map((s) => `  - ${s}`);
  const rest = items.length - shown.length;
  if (rest > 0) lines.push(`  - …另有 ${rest} 条`);
  return lines;
}

/**
 * 报告段：只渲染快照里真有的数，快照没有就写明"未到达报告页"。
 *
 * 渲染顺序（控制者裁决 E8，缺的整条跳过）：`level`（只有快照带才写）→
 * 独立完成度 → 引导轮次 → 卡点 → 公式卡次数 → 深层问题 → 下一步。
 */
function renderReport(snapshot) {
  if (!snapshot) {
    return ['## 报告', '', '未到达报告页：这条记录停在报告之前，没有报告快照。'].join('\n');
  }

  const lines = ['## 报告', ''];

  /** ① 只有快照自己带 `level` 时才写——不猜、不算、不默认（E8） */
  const level = text(snapshot.level);
  if (level) lines.push(`- 掌握程度：${level}`);

  /** ② 数字优先：没有颜色档的导出件，靠这几行才有内容 */
  const independence = renderIndependence(snapshot.independence);
  if (independence) lines.push(`- 独立完成度：${independence}`);

  const hintLevels = renderHintLevels(snapshot.hintStats);
  if (hintLevels) lines.push(hintLevels);

  const stuck = renderStuckPoints(snapshot.stuckPoints);
  if (stuck.length) lines.push('- 卡点：', ...stuck);

  const formulaCards = finiteNumber(snapshot.formulaCards);
  if (formulaCards !== null && formulaCards > 0) lines.push(`- 公式卡 ${formulaCards} 次`);

  const issues = renderTextList(snapshot.deeperIssues);
  if (issues.length) lines.push('- 深层问题：', ...issues);

  const actions = renderTextList(snapshot.nextActions);
  if (actions.length) lines.push('- 下一步：', ...actions);

  /** 一条都没渲染出来时说清是快照空，而不是让段落留白（同 E6 的理由） */
  if (lines.length === 2) lines.push('报告快照是空的：这一版没有记录可展示的内容。');

  /** 末尾单独一句，不并进上面任何一行：它解释的是"为什么没有颜色档" */
  lines.push('', LEVEL_DISCLAIMER);
  return lines.join('\n');
}

/**
 * 一条会话 → Markdown。
 *
 * 段落顺序固定：标题（谁 / 哪一批 / 哪道题 / 何时开始）→ 题目 → 对话 → 报告。
 * 段与段之间一个空行 —— Markdown 里挨着写会被并成一块。
 *
 * @param {{ session: object, user?: object|null, batch?: object|null }} input
 *   `user` / `batch` 允许为 null：人删了但记录还在（E5）
 * @returns {string}
 */
export function renderSessionMarkdown({ session, user, batch } = {}) {
  const record = session ?? {};
  const student = text(user?.displayName, UNKNOWN_STUDENT);
  const batchLabel = text(batch?.label, UNKNOWN_BATCH);
  const problemId = text(record.problemId, '未知题目');
  const startedAt = text(record.startedAt);
  const turns = Array.isArray(record.turns) ? record.turns : [];
  const snapshot = record.reportSnapshot ?? null;

  const blocks = [
    renderHead({ student, batchLabel, problemId, startedAt }),
    renderProblem(problemId, snapshot),
    renderConversation(turns, startedAt),
    renderReport(snapshot),
  ];
  /** 末尾留一个换行：拼进别的文件（或 cat 到一起）时不会把两段黏在一行 */
  return `${blocks.join('\n\n')}\n`;
}

/**
 * 单条导出：`session.md` + `session.json` 打成 zip。
 *
 * `session.json` 放的是 `snapshotSession` 的结果（控制者补充 E7）——
 * 与落库的是同一份投影，所以导出件与库里、看板上读到的永远是同一组字段，
 * 引擎（挂着闭包与凭据指纹）不会跟着出去。
 *
 * @param {object} store 存储端口（只用 getSession / getUserById / getBatch）
 * @param {string} sessionId
 * @returns {Promise<Buffer>}
 * @throws {Error & { code: 'SESSION_NOT_FOUND' }} 会话不存在时
 *   —— 带 `code` 是为了让路由层直接映射成 404，而不是去匹配中文文案
 * @throws {Error & { code: 'SESSION_READ_FAILED' }} 数据库读不出来时（由
 *   `readSessionRecord` 抛，路由层该回 503 而不是 404）
 */
export async function exportSingle(store, sessionId) {
  /**
   * 走 `readSessionRecord` 而不是直接 `store.getSession`：它把"读不出来"
   * （坏库、云调用失败）与"没有这条"分开（`SESSION_READ_FAILED` vs 我们的
   * `SESSION_NOT_FOUND`）。混成一个答案时，路由会把 503 的事报成 404
   * ——"记录不存在，重新开始吧"，而那份记录其实还在库里。
   */
  const session = await readSessionRecord(store, sessionId);
  if (!session) {
    const err = new Error('无法导出：这条学习记录不存在');
    err.code = 'SESSION_NOT_FOUND';
    throw err;
  }

  /**
   * 只在真有归属时才查：没有 `userId` / `batchId` 的记录（匿名创建的会话）
   * 去查一次只会拿到 null，还得让驱动处理一个 undefined 的键。
   */
  const user = session.userId ? await store.getUserById(session.userId) : null;
  const batch = session.batchId ? await store.getBatch(session.batchId) : null;

  const markdown = renderSessionMarkdown({ session, user, batch });
  const json = `${JSON.stringify(snapshotSession(session), null, 2)}\n`;

  return createZip([
    { name: MARKDOWN_NAME, data: markdown },
    { name: JSON_NAME, data: json },
  ]);
}

// ===========================================================================
// 整批导出：一个批次一个 zip（设计稿 §5.7，Task 7）
// ===========================================================================
/**
 * 与单条导出是**同一份数据的两种装箱**，不是两套逻辑：
 *   · 逐条报告不写第二个渲染器，直接 `snapshotSession` 投影成 `reports/<id>.json`
 *     （控制者补充 F1）—— 库里、看板上、导出件里读到的永远是同一组字段；
 *   · 容器仍然走 `createZip`（固定时间戳、拒绝危险条目名）；
 *   · 单条 Markdown 那份人话版留在 `session.md`，整批不出 —— 一批 40 份 Markdown
 *     没人会逐份打开，要读细节的人直接开 `reports/<id>.json`。
 *
 * ===========================================================================
 * 三件事决定了这个文件的大部分篇幅
 * ===========================================================================
 * ① **收到 zip 的人不在我们的页面上。** 他不知道是哪一批、数据到什么时候、
 *    哪一列是什么意思、颜色档为什么不在这份文件里。所以 `README.md` 不是"附带说明"，
 *    它是导出件的一半：三句立场文案（F4）**照抄**，字段字典**由表头生成**（F2）。
 *    手写第二份字段说明一定会和实现在某次改动后分叉，而分叉的字段说明比没有更糟。
 *
 * ② **会被 diff。** 同一批数据导出两次要能逐字节比。所以排序全部自己来
 *    （不能依赖 `listEventsByBatch` 的返回顺序，它的并列顺序在两个驱动下可能不同，
 *    这是 Task 1 就记下的 Minor），时间戳也不放"导出这一刻"（见 `dataCutoff`）。
 *
 * ③ **只在内存里拼一遍。** 一次导出只按批次读库：批次、成员、会话、事件各一次，
 *    代号按"留下会话的成员"查。逐条回查会话/事件会让库调用从 5 次变成 1 + 2N 次
 *    —— 40 人的班撑得住，一个学期之后就没人证明得出它还是那个数量级。
 *
 * ===========================================================================
 * 缺件时的降级（F5 / F6）
 * ===========================================================================
 *   · 批次查不到 → 抛 `BATCH_NOT_FOUND`（路由回 404，不去猜文案）；
 *   · 人被删了 → `students.csv` 不出现这个人，`sessions.csv` 的代号写"未知"，
 *     但**会话那一行留着**：少了的那一行没有任何人会看出来；
 *   · 某个 `.jsonl` 一条记录都没有 → 仍然出这个**空文件**。缺文件会被读成
 *     "没有采集"，空文件才是"确实没有"。
 */

/**
 * `sessions.csv` 的表头，顺序固定（控制者补充 F2）。
 *
 * 它同时是 README 里那份字段字典的**唯一来源**：字典按这张表逐项生成，
 * 所以"加了一列却忘了写文档"这件事在这套代码里不可能发生。
 */
const SESSION_CSV_HEADERS = [
  '批次',
  '代号',
  '会话id',
  '题目id',
  '题单序号',
  '开始时间',
  '最后活动时间',
  '是否完成',
  '走到第几页',
  '退回次数',
  '重置次数',
  '改入场次数',
  '对话轮数',
  '给过的最高层级',
  '公式卡次数',
  '报告次数',
  '再练次数',
  '首条消息字数',
  '是否复制题干',
  '是否放弃',
  '隔离夜回来',
];

/**
 * `students.csv` 的列，固定 6 列（F6）。
 *
 * 它只回答一个问题：**这批人里谁真的留下了数据**（会话数 / 完成数）。
 * 发过号却一道题都没做的人不在这张表里 —— 那不是"数据缺失"，是"没来"。
 */
const STUDENT_CSV_HEADERS = ['代号', '批次', '首次登录', '最后登录', '会话数', '完成数'];

/**
 * 字段字典的说明。**只写说明，不写字段名**：字段名的顺序一律来自 `SESSION_CSV_HEADERS`。
 *
 * 说明写的是"这一列回答什么问题"，不是"这一列是什么类型"——读这份 CSV 的人是教研，
 * 他要判断的是"这个数能不能支撑一个结论"，不是字段的 schema。
 */
const FIELD_NOTES = {
  批次: '会话所属批次的标识，与这份导出件的批次一致',
  代号: '发号时定的代号，不是真名；查不到这个人时写"未知"',
  会话id: '一道题的一次作答就是一条会话，与 reports/ 下的文件名一致',
  题目id: '题库里的题号',
  题单序号: '这道题在批次题单里的位置（从 0 起）；算不出来时留空，不写 0',
  开始时间: '会话创建的时刻（UTC）',
  最后活动时间: '最后一次有动作的时刻（UTC），放弃判定读的就是它',
  是否完成: '走到过报告页就是"是"（有结束时间）',
  走到第几页: '最远到达的页码，只有 1–4',
  退回次数: '往回翻页的次数（数 `page_enter`：进入的页号小于此前到过的最大页号就计 1）',
  重置次数: '把这一轮对话清掉重来的次数',
  改入场次数: '重新读题（换题干 / 换方式）的次数（数该会话不同 `intake_choose` 的 path，减 1）',
  对话轮数: '学生发出的消息条数，沉默与否看它（数 `chat_send` 事件）',
  给过的最高层级: '给过的最强一级帮助（L0–L3）；一次都没给过是 0',
  公式卡次数: '打开公式卡的次数（数记录里的公式卡）',
  报告次数: '打开报告页的次数（数页号为 4 的 `page_enter`）',
  再练次数: '点"再练一道"的次数（数 `practice_pick` 事件）',
  首条消息字数: '第一句话的字数，回答"他到底开不开口"（读第一条 `chat_send` 的 `payload.len`）',
  是否复制题干: '有没有把题干复制走（读第一条 `chat_send` 的 `payload.copiedStem`）',
  是否放弃: '没有结束时间，且最后活动已超过批次的放弃阈值（默认 24 小时）',
  隔离夜回来: `相邻两段之间断过 ${OVERNIGHT_GAP_MS / 3600e3} 小时以上；这是不受阈值影响的旁证`,
};

/**
 * README 里那三句**固定文案**（控制者补充 F4，照抄，别改写）。
 *
 * 为什么一个字都不许改：它们回答的是产品定位 —— 这批数据能得出什么结论、
 * 不能得出什么结论。把"不回答有没有效果"改写成"不是有没有效果"读起来更顺，
 * 但那是在替产品改口径，而口径一改，40 个人的数据可以被拿去做一个它撑不住的结论。
 */
const README_SCOPE =
  '这批数据回答的是**会不会用**（学生停在哪一页、在哪一页退回去、一道题重来几次），**不回答有没有效果**。';
const README_LEVEL = '掌握程度是页面上由独立完成度推导出的颜色档，不存库；本导出件以数字为准。';
const README_NAMES = '代号与真名的对照表不在导出件里，由发号时的 CSV 保管。';

/** 打包规则变了就 +1：读 README 的人据此判断这份说明是否适用于手上这个 zip */
const EXPORT_FORMAT_VERSION = 1;

/** 逐条报告的目录（zip 里是 `reports/<sessionId>.json`） */
const REPORT_PREFIX = 'reports/';

/** 没登录过的人写这三个字，不写空白：Excel 里的空格看不出是"没登录"还是"导出漏了" */
const NEVER_SIGNED_IN = '未登录';

/** 布尔列一律写中文，Excel 里看到的是"是/否" */
const YES = '是';
const NO = '否';

/**
 * 码位序比较。
 *
 * **不用 `localeCompare`**：各语言环境的排序不一样（与 session-store.js 里
 * `pickResumable` 的理由相同），而这份导出件要能被逐字节 diff。
 */
function compareText(left, right) {
  const a = text(left);
  const b = text(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 读回来的列表：不是数组就当空。
 *
 * 导出是只读的最后一环 —— 驱动哪怕返回了一个坏形状（`null`、对象、字符串），
 * 也该出一份"确实没有记录"的导出件，而不是 500。空件能被看出来，500 不能。
 */
function asList(value) {
  return Array.isArray(value) ? value : [];
}

/** 布尔列写中文 */
const yesNo = (value) => (value ? YES : NO);

/**
 * 只认真正的 `true`（字符串 `'true'` 也认）。
 *
 * 埋点里出现过字符串 `'false'`（前端把布尔忘了转）：宽松判断会把它读成"复制过题干"，
 * 而"有没有把题干复制走"是防泄题那条链上唯一能被观察到的信号。
 */
function strictTrue(value) {
  return value === true || value === 'true';
}

/** 完成 = 走到过报告页（`router.js` 在报告落定时写 `finishedAt`） */
function isFinished(session) {
  return typeof session?.finishedAt === 'string' && session.finishedAt.trim() !== '';
}

/** 走到第几页：产品只有四页，越界一律夹回来（界面上不存在"第 5 页"） */
function pagesWalked(session) {
  const raw = finiteNumber(session?.progress?.maxPage);
  if (raw === null) return 1;
  return Math.min(4, Math.max(1, Math.trunc(raw)));
}

/** 给过的最强一级帮助：`hintLevels` 的最大值，一次都没给过是 0（不是 -Infinity） */
function highestHintLevel(counters) {
  const levels = asList(counters?.hintLevels);
  let highest = null;
  for (const level of levels) {
    const value = finiteNumber(level);
    if (value === null) continue;
    highest = highest === null ? value : Math.max(highest, value);
  }
  return highest ?? 0;
}

/**
 * 首条学生消息的字数 —— 事件流与 counters 都没有时的**最后一档**回落。
 *
 * 只认第一条 `role: 'student'`：后面几条回答的不是"他到底开不开口"。
 * 第一条没有文本（坏记录）时返回 null：跳过它去量第二条会量到另一个人说的话。
 */
function firstStudentMessageLength(turns) {
  for (const turn of asList(turns)) {
    if (turn?.role !== 'student') continue;
    return typeof turn?.text === 'string' ? turn.text.length : null;
  }
  return null;
}

/**
 * 事件流 → 一个会话的派生信号。
 *
 * ============================================================================
 * 本轮的裁决：能从事物流推出来的列，一律从事件流推
 * ============================================================================
 * `counters` 只在事件流**给不出这个数**时回落：整条事件流没有，或者（对 `chat_send`
 * 的两列）第一条消息没带那个字段。只要会话有事件，其余几列一律以事件流为准
 * （推出来是 0 就写 0，不再看 counters）。
 * 理由不是"事件更准"，而是 counters 里有一半字段根本没有人写：
 * `reportViews` / `practicePicks` / `intakeChanges` / `backtracks` 在设计稿里
 * 有名字，全仓却找不到一处给它们 +1。从 counters 读，那几列在真实数据上
 * 永远是 0 —— 而 0 看起来像"学生没做"，不像"我们没记"。
 *
 * `events` 由调用方按 `sessionId` 分组带进来（`exportBatch` 做这件事）。
 * 这里再按 `byEventSeq` 排一遍：第一条 `chat_send` 是谁取决于顺序，
 * 不能靠"调用方拼的时候恰好没弄反"（与 metrics.js 的 D1 约定相同）。
 */
function deriveFromEvents(events) {
  const ordered = asList(events).slice().sort(byEventSeq);
  const sends = ordered.filter((event) => event?.type === 'chat_send');

  let maxPage = null;
  let backtracks = 0;
  let reportViews = 0;
  let practicePicks = 0;
  const intakePaths = new Set();

  for (const event of ordered) {
    const type = event?.type;
    if (type === 'page_enter') {
      const page = finiteNumber(event?.payload?.page);
      /** 页号缺失或不是数字：这条埋点是坏的，不能凭空算一次退回 */
      if (page === null) continue;
      /**
       * 退回的口径（裁决原文）：**进入的页号小于此前出现过的最大页号**就计 1。
       * 不是"小于上一页" —— 学生从第 4 页直接跳回第 2 页，也是退了一次。
       */
      if (maxPage !== null && page < maxPage) backtracks += 1;
      if (maxPage === null || page > maxPage) maxPage = page;
      if (page === 4) reportViews += 1;
    } else if (type === 'intake_choose') {
      const path = text(event?.payload?.path);
      if (path !== '') intakePaths.add(path);
    } else if (type === 'practice_pick') {
      practicePicks += 1;
    }
  }

  return {
    hasEvents: ordered.length > 0,
    sendCount: sends.length,
    firstSend: sends[0] ?? null,
    backtracks,
    reportViews,
    /** 改入场 = 换过几种入场方式：两种 path 是 1 次，一种都没有是 0 */
    intakeChanges: Math.max(0, intakePaths.size - 1),
    practicePicks,
  };
}

/**
 * 公式卡次数：记录里的那张卡片清单是第一来源。
 *
 * `counters.formulaOpens` 只在投影里没带 `record` 时回落 —— `record.formulaCards`
 * 是"打开过哪几张"的原始证据，而计数器只是它的一个和。记录在、但 `formulaCards`
 * 不是数组（更老的形状）时也算"没有记录"，继续往下退。
 */
function formulaCardCount(record) {
  if (!record || typeof record !== 'object') return null;
  if (!Array.isArray(record.formulaCards)) return null;
  return record.formulaCards.length;
}

/**
 * 一个值 → CSV 单元格。
 *
 * 逗号、引号、换行在 CSV 里是**结构**：不包引号就会多拆一列或一整行，
 * 而那种错在屏幕上只表现为"这一格内容短了"，没人会去数行数。
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const cell = String(value);
  if (!/[",\r\n]/.test(cell)) return cell;
  return `"${cell.replace(/"/g, '""')}"`;
}

/**
 * 二维表 → CSV 文本（UTF-8 带 BOM）。
 *
 * @param {Array<object>} rows 每行是以表头为键的对象；缺的键写空单元格
 * @param {string[]} headers 列顺序（也决定第一行）
 * @returns {string}
 */
export function toCsv(rows, headers) {
  const columns = asList(headers);
  const lines = [columns.map(csvCell).join(',')];
  for (const row of asList(rows)) {
    lines.push(columns.map((header) => csvCell(row?.[header])).join(','));
  }
  /**
   * BOM 必须在最前面：没有它，Excel（中文 Windows 的默认编码是 GBK）打开就是乱码，
   * 而 `cat` / `less` 看却完全正常 —— 只有中文用户看得到这个 bug（全局约束）。
   *
   * 末尾**不加**换行：行数口径是"表头 1 行 + 数据 N 行"，按 `\r\n` 拆就该正好 N+1 段。
   * 加一个尾换行会让每个读的人各自过滤一次空行，而这种"各自过滤"迟早有一处漏掉。
   */
  return `\uFEFF${lines.join('\r\n')}`;
}

/**
 * 学生名单 → `students.csv`。
 *
 * 参数是**已经组装好的名单行**（`{ displayName, batchId, firstSeenAt, lastSeenAt,
 * sessionCount, finishedCount }`），不是库里的 `user` 记录：会话数与完成数不挂在人身上，
 * 而"哪些人有会话"是存储那边的事实。分工写在 `exportBatch` 里。
 *
 * @param {Array<object>} students
 * @returns {string}
 */
export function renderStudentsCsv(students) {
  const rows = asList(students).map((student) => ({
    代号: text(student?.displayName, UNKNOWN_STUDENT),
    批次: text(student?.batchId),
    首次登录: text(student?.firstSeenAt, NEVER_SIGNED_IN),
    最后登录: text(student?.lastSeenAt, NEVER_SIGNED_IN),
    会话数: finiteNumber(student?.sessionCount) ?? 0,
    完成数: finiteNumber(student?.finishedCount) ?? 0,
  }));
  return toCsv(rows, STUDENT_CSV_HEADERS);
}

/**
 * 会话明细 → `sessions.csv`（一行一条会话）。
 *
 * `batch` / `now` 是**可选第二参**：放弃判定要批次的阈值与"现在"，而这个渲染器
 * 自己不碰库、不读钟（读钟会让导出件每次跑都不一样）。缺省时按默认 24 小时、
 * 用当前时刻 —— 与 `isAbandoned` 的缺省口径一致。
 *
 * 代号（`studentName`）由调用方解析后随会话带进来：这个函数不该为了一个名字去查库，
 * 否则它就从"渲染器"变成了"又一个导出流程"。
 *
 * 同理，事件也**随会话带进来**（`session.events`，与 `metrics.js` 的 D1 约定相同）：
 * 这个渲染器不碰库。`exportBatch` 把整批事件按 `sessionId` 分组后塞进每条会话，
 * 于是「对话轮数 / 首条消息字数 / 是否复制题干 / 改入场次数 / 退回次数 / 报告次数 /
 * 再练次数」都能从事件流算出来 —— 而不是去读 counters 里那些**根本没人写**的字段。
 *
 * 三类来源的优先级，逐列写在下面的代码注释里：
 *   ① 事件流（只要这个会话有事件，可推导的列就以它为准）；
 *   ② `counters` 里真有的字段（事件流给不出这个数时才回落）；
 *   ③ 都没有：数字列写 0，`首条消息字数` 留空（0 会被读成"他发了个空消息"）。
 *
 * @param {object[]} sessions 每条可带 `events`（该会话的事件）与 `studentName`
 * @param {{ batch?: object|null, now?: number|string|Date|null }} [options]
 * @returns {string}
 */
export function renderSessionsCsv(sessions, { batch = null, now = null } = {}) {
  const at = now ?? new Date().toISOString();
  const rows = asList(sessions).map((session) => {
    const counters = session?.counters ?? {};
    const questionIndex = finiteNumber(session?.questionIndex);
    const derived = deriveFromEvents(session?.events);

    /**
     * 首条消息字数：第一条 `chat_send` 的 `payload.len` → `counters.firstMessageLength`
     * （这个计数器在设计稿里并不存在，只兼容手写/迁移来的旧记录）→ 第一条学生消息的
     * 字数 → 留空。**最后一档不给 0**：没有消息和"消息长度是 0"是两件事。
     */
    const firstPayload = derived.firstSend?.payload ?? null;
    const eventLength = firstPayload ? finiteNumber(firstPayload.len) : null;
    const firstLength =
      eventLength ?? finiteNumber(counters.firstMessageLength) ?? firstStudentMessageLength(session?.turns);

    /**
     * 是否复制题干：第一条 `chat_send` 的 `payload.copiedStem` → `counters.copiedStem`
     * → 否。布尔列没有"空"这一档：空与否同义，写否更清楚。
     */
    const eventCopied =
      firstPayload && firstPayload.copiedStem !== undefined && firstPayload.copiedStem !== null
        ? strictTrue(firstPayload.copiedStem)
        : null;
    const counterCopied =
      counters.copiedStem !== undefined && counters.copiedStem !== null ? strictTrue(counters.copiedStem) : null;
    const copiedStem = eventCopied ?? counterCopied ?? false;

    return {
      批次: text(session?.batchId),
      代号: text(session?.studentName, UNKNOWN_STUDENT),
      会话id: text(session?.id),
      题目id: text(session?.problemId),
      /** 留空 = 算不出来。写 0 会被读成"第一道题"，那是另一个意思 */
      题单序号: questionIndex === null ? '' : questionIndex,
      开始时间: text(session?.startedAt),
      最后活动时间: text(session?.lastAt),
      是否完成: yesNo(isFinished(session)),
      走到第几页: pagesWalked(session),
      /**
       * 退回次数：走一遍 `page_enter`（见 `deriveFromEvents`）。没有事件的老记录退到
       * `progress.backtracks`（模型里的字段，也是这一列原来的口径）；裁决里写的
       * `counters.backtracks` 一起认，兼容手写/迁移来的记录。
       */
      退回次数: derived.hasEvents
        ? derived.backtracks
        : (finiteNumber(session?.progress?.backtracks) ?? finiteNumber(counters.backtracks) ?? 0),
      重置次数: finiteNumber(counters.resetCount) ?? 0,
      /** 改入场次数：该会话不同 `intake_choose` 的 path 数减 1（一种都没有是 0） */
      改入场次数: derived.hasEvents ? derived.intakeChanges : (finiteNumber(counters.intakeChanges) ?? 0),
      /**
       * 对话轮数：`chat_send` 事件条数。没有事件的老记录才读 `counters.chatTurns`
       * （那个计数器是 `markActivity` 真在写的）；两者都没有就是 0 —— 这里没有
       * "空"这一档，0 轮与"没记"在读的人眼里都是"没开口"，不会做出相反的结论。
       */
      对话轮数: derived.hasEvents ? derived.sendCount : (finiteNumber(counters.chatTurns) ?? 0),
      给过的最高层级: highestHintLevel(counters),
      公式卡次数: formulaCardCount(session?.record) ?? finiteNumber(counters.formulaOpens) ?? 0,
      /** 报告次数：页号为 4 的 `page_enter` 条数（没有事件才读 counters） */
      报告次数: derived.hasEvents ? derived.reportViews : (finiteNumber(counters.reportViews) ?? 0),
      /** 再练次数：`practice_pick` 事件条数（第 14 种事件，见 events.js） */
      再练次数: derived.hasEvents ? derived.practicePicks : (finiteNumber(counters.practicePicks) ?? 0),
      首条消息字数: firstLength ?? '',
      是否复制题干: yesNo(copiedStem),
      是否放弃: yesNo(isAbandoned(session, batch, at)),
      隔离夜回来: yesNo(hasOvernightReturn(session)),
    };
  });
  return toCsv(rows, SESSION_CSV_HEADERS);
}

/**
 * 导出件里的说明手册（`README.md`）。
 *
 * 三句立场文案是常量（F4）；字段字典**由 `SESSION_CSV_HEADERS` 生成**，
 * 不在这里手写第二份（F2）。`generatedAt` 由调用方传：这个渲染器不读钟。
 *
 * @param {{ batch?: object|null, generatedAt?: string|null, sessionCount?: number }} [input]
 *   `generatedAt` 是**这批数据覆盖到哪一刻**（`exportBatch` 传的是本批最新一条记录
 *   的时间，见 `dataCutoff`），不是"生成这份文件的时刻"；缺了写"未知"，不写 `undefined`
 * @returns {string}
 */
export function renderBatchReadme({ batch, generatedAt, sessionCount } = {}) {
  const label = text(batch?.label, UNKNOWN_BATCH);
  const batchId = text(batch?.id, '未知标识');
  /** 批次记录里这一版没有 `version` 字段：写"未标注"，不猜一个版本号 */
  const batchVersion = text(batch?.version, '未标注');
  const cutoff = text(generatedAt, '未知（本批还没有带时间的记录）');
  const count = finiteNumber(sessionCount) ?? 0;

  const dictionary = SESSION_CSV_HEADERS.map(
    (name) => `- \`${name}\`：${FIELD_NOTES[name] ?? '（这一版没有写说明）'}`,
  );

  return (
    [
      `# 批次导出 · ${label}`,
      '',
      `- 批次标识：${batchId}`,
      `- 批次版本：${batchVersion}`,
      `- 会话数：${count}`,
      `- 数据覆盖到：${cutoff}`,
      `- 导出格式版本：${EXPORT_FORMAT_VERSION}`,
      '',
      '本导出件不含生成时刻，以保证同一批数据两次导出完全一致。',
      '',
      '## 这批数据回答什么',
      '',
      README_SCOPE,
      '',
      '## 关于掌握程度',
      '',
      README_LEVEL,
      '',
      '## 代号与真名',
      '',
      README_NAMES,
      '',
      '## 里面有什么',
      '',
      '| 文件 | 内容 |',
      '| --- | --- |',
      '| `README.md` | 就是这一份 |',
      '| `students.csv` | 这批学生：代号、首次 / 最后登录、会话数、完成数。**只含有会话的人** |',
      '| `sessions.csv` | 一道题的一次作答一行：停在哪一页、退回去几次、重来几次、给过多强的帮助 |',
      '| `events.jsonl` | 埋点原始事件，一行一条；按会话分组，组内按写入顺序（`seq`） |',
      '| `turns.jsonl` | 对话原文，一行一轮；按会话分组，组内按轮次（`i`） |',
      '| `reports/<会话id>.json` | 每条会话的报告快照，与库里冻结的那一份完全相同（不重算） |',
      '',
      `学生名单（\`students.csv\`）的列：${STUDENT_CSV_HEADERS.join(',')}`,
      '',
      `## 字段字典（\`sessions.csv\` 的 ${SESSION_CSV_HEADERS.length} 列，从左到右）`,
      '',
      ...dictionary,
      '',
      '## 保留与清理',
      '',
      '- 清理前必须先导出：账号与作答记录一删就没有第二份。',
      '- 导出件保留 90 天，到期连同一开始的发号 CSV 一起销毁。',
      '- 导出件里只有代号：代号与真名的对照表在发号时的那个 CSV 里，不随这个 zip 出去。',
      '',
    ].join('\n')
  );
}

/** 会话 id 的字典序（报告文件、jsonl 分组都用它，两处必须同一口径） */
function bySessionId(left, right) {
  return compareText(left?.id, right?.id);
}

/**
 * 事件的排序：`seq` 升序 → 缺 `seq` 的排在有序号的之后 → 再按 `at`。
 *
 * 与 `metrics.js` 的 `byEventOrder`、store 的 `byEventOrder` 同一口径：`seq` 是写入
 * 那一刻盖上的定稿，没有它才退到 `at`。
 *
 * 最后还有三级 tie-break（`at` 原始字符串 → `type` → 归属键）：两档都相同时返回 0
 * 等于把行序交给驱动 —— 内存按写入序、file 按目录读取序，同一批数据两个驱动导出
 * 不同。`seq` 由全局自增保证唯一，所以这几级只对**没有 `seq` 的老记录**起作用，
 * 而正是那些老记录最可能在同一批里出现并列。归属键走 `events.js` 的 `ownerOf`，
 * 不在这里再抄一遍 `sessionId || visitId`。
 */
function byEventSeq(left, right) {
  const a = typeof left?.seq === 'number' && Number.isFinite(left.seq) ? left.seq : null;
  const b = typeof right?.seq === 'number' && Number.isFinite(right.seq) ? right.seq : null;
  if (a !== null && b !== null) {
    if (a !== b) return a - b;
  } else if (a !== null) {
    return -1;
  } else if (b !== null) {
    return 1;
  }
  const atA = Date.parse(String(left?.at ?? ''));
  const atB = Date.parse(String(right?.at ?? ''));
  if (Number.isFinite(atA) && Number.isFinite(atB) && atA !== atB) return atA - atB;
  const rawA = text(left?.at);
  const rawB = text(right?.at);
  if (rawA !== rawB) return rawA < rawB ? -1 : 1;
  const typeA = text(left?.type);
  const typeB = text(right?.type);
  if (typeA !== typeB) return typeA < typeB ? -1 : 1;
  return compareText(ownerOf(left), ownerOf(right));
}

/** 对话的排序：`i` 升序；缺 `i` 的那几条保持原相对顺序（不猜，也不排到最前） */
function byTurnIndex(left, right) {
  const a = finiteNumber(left?.i);
  const b = finiteNumber(right?.i);
  if (a === null || b === null) return 0;
  return a - b;
}

/**
 * JSONL：一行一条 JSON。
 *
 * 没有记录时返回**空字符串**（而不是不生成这个文件）：缺文件会被读成"没有采集"，
 * 空文件才是"确实没有"（F6）。
 */
function jsonLines(records) {
  if (records.length === 0) return '';
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

/**
 * 事件按 `sessionId` 分组、组内按 `byEventSeq` 升序。
 *
 * 两个用途共用这一份：`events.jsonl` 的行序，以及 `sessions.csv` 的派生列
 * （`session.events` 就是这里分出来的那一份）。分成两套实现的话，"同一批事件
 * 在两处顺序不同"只会表现为某个计数差 1，而那种差没人查得出来。
 *
 * 没有 `sessionId` 的事件**不丢**：页 1–2 的事件挂的是 `visitId`（设计稿 §5.2），
 * 而"第 1 页停留多久"正是这批数据要回答的问题之一。它们自成一组（空键）。
 */
function groupEventsBySession(events) {
  const groups = new Map();
  for (const event of asList(events)) {
    const key = text(event?.sessionId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  for (const [key, list] of groups) groups.set(key, list.slice().sort(byEventSeq));
  return groups;
}

/**
 * 事件 → `events.jsonl`：按 `sessionId` 分组、组内按 `seq` 升序、组间按 `sessionId` 字典序。
 *
 * 为什么不直接用 `listEventsByBatch` 的返回顺序：两个驱动的并列顺序可能不同
 * （Task 1 记下的 Minor），而"两次导出能不能 diff"取决于这里。顺序全部自己排一遍，
 * 这条依赖就不存在了。空键（登录 + 挂 `visitId` 的页面事件）排在最前。
 */
function renderEventLines(events) {
  const groups = groupEventsBySession(events);
  const records = [];
  for (const key of [...groups.keys()].sort(compareText)) {
    records.push(...groups.get(key));
  }
  return jsonLines(records);
}

/**
 * 会话 → `turns.jsonl`：按 `sessionId` 字典序、组内按 `i` 升序。
 *
 * 每一行都带 `sessionId`：这个文件是给别的程序读的，靠行序猜归属靠不住。
 * 只读 `session.turns`（不碰 `record.turns`，那是报告侧的名字；两者指同一份东西，
 * 而统一由 `snapshotSession` 负责）。
 */
function renderTurnLines(sessions) {
  const records = [];
  for (const session of asList(sessions).slice().sort(bySessionId)) {
    const sessionId = text(session?.id);
    const turns = asList(session?.turns).slice().sort(byTurnIndex);
    for (const turn of turns) records.push({ sessionId, ...turn });
  }
  return jsonLines(records);
}

/**
 * 数据覆盖到：本批**最新一条记录**的时间（ISO）。
 *
 * 为什么不是"导出这一刻"：导出件会被逐版本 diff（zip 的时间戳已经固定死了，
 * 见 zip.js），而墙上时钟每跑一次都不一样 —— 一份每次都变的导出件没法比对。
 * 用数据自己的最新时刻，这句话也是自明的："这批数据覆盖到这一刻为止"。
 * README 里的标签刻意写「数据覆盖到」而不是「数据截止时间」：后者容易被读成
 * "这份文件是什么时候生成的"，而这个值不是生成时刻。
 *
 * 一条带时间的记录都没有（空批次）时返回 null，由 `renderBatchReadme` 写"未知"。
 */
function dataCutoff(sessions, events) {
  let latest = Number.NaN;
  const consider = (value) => {
    const ms = Date.parse(String(value ?? ''));
    if (!Number.isFinite(ms)) return;
    if (!Number.isFinite(latest) || ms > latest) latest = ms;
  };
  for (const session of asList(sessions)) {
    consider(session?.lastAt);
    consider(session?.finishedAt);
    consider(session?.startedAt);
  }
  for (const event of asList(events)) consider(event?.at);
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

/**
 * 整批导出：一个批次一个 zip。
 *
 * 条目顺序固定（裁决 ⑥）：`README.md` → `students.csv` → `sessions.csv` →
 * `events.jsonl` → `turns.jsonl` → `reports/<id>.json`（按会话 id 字典序）。
 * 顺序固定，两次导出才逐字节可比。
 *
 * 库调用只有这些，**一条会话一次都不查**：
 *   `getBatch` / `listMembers` / `listSessionsByBatch` / `listEventsByBatch` 各一次，
 *   外加"留下会话的成员"各一次 `getUserById`（代号）。
 *
 * @param {object} store 存储端口
 * @param {string} batchId
 * @param {{ now?: number|string|Date }} [options]
 *   `now` 是放弃判定的"现在"。缺省用当前时刻；测试与逐版本比对时传固定值
 *   —— 不钉住它，同一个 fixture 今天算"未放弃"、明天就算"放弃"
 * @returns {Promise<Buffer>}
 * @throws {Error & { code: 'BATCH_NOT_FOUND' }} 批次不存在时（Task 8 据此回 404）
 */
export async function exportBatch(store, batchId, { now } = {}) {
  const batch = await store.getBatch(batchId);
  if (!batch) {
    const err = new Error('无法导出：这个批次不存在');
    err.code = 'BATCH_NOT_FOUND';
    throw err;
  }

  /** 放弃判定与"数据截止"各用各的时间：前者是判定时刻，后者是数据自身的边界 */
  const at = now ?? new Date().toISOString();

  const members = asList(await store.listMembers(batchId));
  const sessions = asList(await store.listSessionsByBatch(batchId));
  const events = asList(await store.listEventsByBatch(batchId));

  /**
   * 代号：只查**留下会话的成员**，不按会话逐条回查。
   *
   * 为什么按"成员 ∩ 有会话"而不是按会话的 `userId`：会话上的 `userId` 可能是
   * 一个已经被删掉的人（F5），也可能根本不在这一批的名单里；成员表才是"这个批次
   * 有哪些人"的事实。两边取交集之后，查询次数只跟"真的做了题的人数"有关。
   */
  const owners = new Set();
  for (const session of sessions) {
    const userId = text(session?.userId);
    if (userId !== '') owners.add(userId);
  }

  const nameByUser = new Map();
  const roster = [];
  for (const member of asList(members)) {
    const userId = text(member?.userId);
    if (userId === '' || !owners.has(userId)) continue;
    const user = await store.getUserById(userId);
    /** 人被删了：这张名单里不出现他（F5）。会话那一边照旧出件，代号写"未知" */
    if (!user) continue;
    const displayName = text(user.displayName, UNKNOWN_STUDENT);
    nameByUser.set(userId, displayName);
    roster.push({
      userId,
      displayName,
      firstSeenAt: user.firstSeenAt,
      lastSeenAt: user.lastSeenAt,
    });
  }

  /** 会话数 / 完成数按人聚合：`students.csv` 要的就是这两个数 */
  const statsByUser = new Map();
  for (const session of sessions) {
    const userId = text(session?.userId);
    if (userId === '') continue;
    const stats = statsByUser.get(userId) ?? { sessionCount: 0, finishedCount: 0 };
    stats.sessionCount += 1;
    if (isFinished(session)) stats.finishedCount += 1;
    statsByUser.set(userId, stats);
  }

  const batchKey = text(batch?.id) || text(batchId);
  const students = roster
    .map((member) => ({
      ...member,
      batchId: batchKey,
      ...(statsByUser.get(member.userId) ?? { sessionCount: 0, finishedCount: 0 }),
    }))
    /** 名单按代号排（码位序）：导出的第一列看着就是一份名单，不是一堆 id */
    .sort((a, b) => compareText(a.displayName, b.displayName) || compareText(a.userId, b.userId));

  /** 事件按会话分好、组内按 `seq` 排好：`events.jsonl` 的行序与 CSV 的派生列共用这一份 */
  const eventsBySession = groupEventsBySession(events);

  /**
   * 代号与事件**一起**随会话带进 CSV：代号给「代号」列，事件给「对话轮数 /
   * 首条消息字数 / 是否复制题干 / 改入场次数 / 退回次数 / 报告次数 / 再练次数」。
   * 报告快照不带这两样（报告是库里那一份，见 `snapshotSession`）。
   *
   * 没有事件的会话给空数组（而不是不给 `events`）：`deriveFromEvents` 对两者
   * 一视同仁，都退到 counters —— 而"空数组"比"字段不在"少一种形状要猜。
   */
  const sessionsWithNames = sessions.map((session) => {
    const displayName = nameByUser.get(text(session?.userId));
    const sessionId = text(session?.id);
    const enriched = {
      ...session,
      events: sessionId === '' ? [] : (eventsBySession.get(sessionId) ?? []),
    };
    return displayName ? { ...enriched, studentName: displayName } : enriched;
  });

  const reportEntries = sessions
    .slice()
    .sort(bySessionId)
    .map((session) => ({
      name: `${REPORT_PREFIX}${text(session?.id)}.json`,
      data: `${JSON.stringify(snapshotSession(session), null, 2)}\n`,
    }));

  return createZip([
    {
      name: 'README.md',
      data: renderBatchReadme({
        batch,
        generatedAt: dataCutoff(sessions, events),
        sessionCount: sessions.length,
      }),
    },
    { name: 'students.csv', data: renderStudentsCsv(students) },
    { name: 'sessions.csv', data: renderSessionsCsv(sessionsWithNames, { batch, now: at }) },
    { name: 'events.jsonl', data: renderEventLines(events) },
    { name: 'turns.jsonl', data: renderTurnLines(sessions) },
    ...reportEntries,
  ]);
}
