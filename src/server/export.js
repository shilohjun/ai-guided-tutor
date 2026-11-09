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
