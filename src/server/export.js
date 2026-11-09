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
 * 独立完成度。
 *
 * 两种形状都要认：`buildReport` 给的是对象（`{score, note, …}`），
 * 而手写/迁移过来的快照可能直接是数字。留两位小数：0.6 与 0.60 对学生是同一个数，
 * 但在一列里对不齐就会让人以为精度不同。
 */
function renderIndependence(independence) {
  const direct = finiteNumber(independence);
  if (direct !== null) return direct.toFixed(2);
  const score = finiteNumber(independence?.score);
  if (score === null) return null;
  const note = text(independence?.note);
  return note ? `${score.toFixed(2)} —— ${note}` : score.toFixed(2);
}

/**
 * 卡点清单。
 *
 * 只写快照里已有的：`stepTitle` 是**学生可见**的那份说法（`buildReport` 走的是
 * `safeStepRef`，有些步骤标题本身就是结论），所以直接用它，不要回头去查题目。
 * `kind` 是内部枚举名（`precondition_gap` 这种），不写给人看 —— 结构化数据在
 * session.json 里全都有。
 */
function renderStuckPoints(stuckPoints) {
  if (!Array.isArray(stuckPoints) || stuckPoints.length === 0) return [];
  return stuckPoints.map((point) => {
    const stepIndex = finiteNumber(point?.stepIndex);
    const where = text(point?.stepTitle) || (stepIndex !== null ? `第 ${stepIndex} 步` : '答题位置未知');
    const parts = [where];
    const rounds = finiteNumber(point?.hintRounds);
    if (rounds !== null) parts.push(`引导 ${rounds} 轮`);
    const maxLevel = finiteNumber(point?.maxLevel);
    if (maxLevel !== null) parts.push(`最高 L${maxLevel}`);
    const labels = Array.isArray(point?.misconceptionLabels)
      ? point.misconceptionLabels.map((label) => text(label)).filter(Boolean)
      : [];
    if (labels.length) parts.push(`错因：${labels.join('、')}`);
    return `  - ${parts.join(' · ')}`;
  });
}

/** 报告段：只渲染快照，快照没有就写明"未到达报告页" */
function renderReport(snapshot) {
  if (!snapshot) {
    return ['## 报告', '', '未到达报告页：这条记录停在报告之前，没有报告快照。'].join('\n');
  }

  const lines = ['## 报告', ''];
  const level = text(snapshot.level);
  if (level) lines.push(`- 掌握程度：${level}`);
  const independence = renderIndependence(snapshot.independence);
  if (independence) lines.push(`- 独立完成度：${independence}`);

  const stuck = renderStuckPoints(snapshot.stuckPoints);
  if (stuck.length) lines.push('- 卡点：', ...stuck);

  /** 一条都没渲染出来时说清是快照空，而不是让段落留白（同 E6 的理由） */
  if (lines.length === 2) lines.push('报告快照是空的：这一版没有记录可展示的内容。');
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
