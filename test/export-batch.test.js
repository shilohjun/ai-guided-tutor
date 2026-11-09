/**
 * 整批导出：一个批次一个 zip（设计稿 §5.7，Task 7）。
 *
 * ============================================================================
 * 这个套件钉住的是"发给外人之后还能用"，不是"函数返回了一个 Buffer"
 * ============================================================================
 * 整批导出件会被拷到 U 盘、发给教研、在 Excel 里打开、被下一个人拿 `git diff`
 * 比对两次跑的结果。四件事各自失败的方式都不一样，却都不会报错：
 *
 * ① **Excel 打开是乱码** —— 少一个 BOM 就成。中文用户看到的第一屏就是乱码，
 *    而写代码的人在 Linux 上用 `cat` 看是好的。
 * ② **行数对不上** —— 少一行、多一行，读的人以为"这批只有这些人"。
 *    所以行数口径写死：`sessions.csv` = 会话数 + 1（表头），按 `\r\n` 数。
 * ③ **顺序每次不一样** —— 导出件会被逐版本 diff。`listEventsByBatch` 的并列顺序
 *    在两个驱动下可能不同（Task 1 记下的 Minor），所以导出自己**再排一次**：
 *    事件按 `sessionId` 分组、组内按 `seq`、组间按 `sessionId` 字典序；
 *    对话按 `sessionId`、组内按 `i`。顺序不定就永远对不齐。
 * ④ **人删了就把整行丢掉** —— 少的那一行没有任何人会发现。降级规则是：
 *    `students.csv` 不出现这个人，`sessions.csv` 的代号写"未知"，**会话行留着**。
 *
 * ============================================================================
 * README 里那三句话是照抄的，不是"意思对了就行"
 * ============================================================================
 * 它们要回答的是**产品定位**问题（这批数据能得出什么结论、不能得出什么结论），
 * 改写一句就可能把"会不会用"写成"有没有效果"—— 那是两个完全不同的结论。
 * 所以用例逐字钉住（控制者补充 F4）。
 *
 * 另有一条：字段字典必须**由 `sessions.csv` 的表头生成**，不许手写第二份。
 * 手写的那份一定会在某次改动后和实现分叉，而分叉的字段说明比没有更糟。
 * 用例按表头逐个核对，就是为了让"加了列却忘了改文档"当场变红。
 *
 * ============================================================================
 * 为什么用 `await import` + 解构取本任务的新函数
 * ============================================================================
 * 静态 import 一个还不存在的导出，会让整个套件在**加载阶段**就挂掉：
 * 一条用例都跑不起来，RED 只能证明"文件里没有这个名字"，证明不了行为不对。
 * 这里解构出来的是什么就用什么 —— 没实现时每条用例各自在调用处失败。
 */

import { describe, it, assert, assertEquals, assertIncludes, assertNotIncludes } from './runner.js';
import { snapshotSession } from '../src/server/session-store.js';

const { exportBatch, toCsv, renderStudentsCsv, renderSessionsCsv, renderBatchReadme } = await import(
  '../src/server/export.js'
);

// ---------------------------------------------------------------------------
// 夹具：一个像样的批次（三个成员，其中一个一道题都没做；另有一条会话属于已删的人）
// ---------------------------------------------------------------------------

/**
 * "现在"。
 *
 * 放弃（`isAbandoned`）是**导出时**算的，与"现在"有关。不钉住它，这个套件会
 * 在某一天自己变红：今天算"未放弃"的记录，明天就超过 24 小时了。
 * 所以凡是要断言放弃/字节一致的地方，都把"现在"传进去。
 */
const NOW = '2026-11-09T12:00:00.000Z';

const BATCH = { id: 'b1', label: '第二版', questionIds: ['qbank-1', 'qbank-2'], abandonHours: 24 };

const USERS = {
  u1: {
    id: 'u1',
    displayName: 'S01',
    batches: ['b1'],
    firstSeenAt: '2026-11-08T19:58:00.000Z',
    lastSeenAt: '2026-11-09T10:20:00.000Z',
  },
  u2: {
    id: 'u2',
    displayName: 'S02',
    batches: ['b1'],
    firstSeenAt: '2026-11-09T09:59:00.000Z',
    lastSeenAt: '2026-11-09T10:05:00.000Z',
  },
  /** u3 是这个批次的成员，但一道题都没做 —— 它不该出现在 students.csv 里 */
  u3: { id: 'u3', displayName: 'S03', batches: ['b1'], firstSeenAt: null, lastSeenAt: null },
};

const MEMBERS = [{ userId: 'u1', joinedAt: '2026-11-01T00:00:00.000Z' }, { userId: 'u2' }, { userId: 'u3' }];

/**
 * 事件：**真实形状**，刻意打乱给进去。
 *
 * `chat_send` 的 payload 就是设计稿 §5.3 写的 `{ len, copiedStem }`。
 * 从前这套夹具自造了 `counters.firstMessageLength` / `counters.copiedStem`——
 * 而 `counters` 里根本没有这两个字段（设计稿 §5.2 只有 7 个），真实数据上
 * 「首条消息字数 / 是否复制题干」会永远是 0 / 否。夹具自造字段，所以套件看不出来。
 * 现在这里只放真实事件：那两列必须从事件流推出来。
 *
 * 其中三条没有 `sessionId`（登录、页 1–2 挂在 `visitId` 上）：它们不是"该丢的脏数据"，
 * 是学生在第 1 页停留的证据 —— 丢了就读成"没有采集"。
 */
const EVENTS = [
  { seq: 11, type: 'page_enter', at: '2026-11-09T10:10:00.000Z', userId: 'u1', batchId: 'b1', sessionId: 's1', payload: { page: 4 } },
  { seq: 3, type: 'page_enter', at: '2026-11-09T09:59:30.000Z', userId: 'u1', batchId: 'b1', visitId: 'v1', payload: { page: 2 } },
  { seq: 8, type: 'chat_send', at: '2026-11-09T10:01:10.000Z', userId: 'u1', batchId: 'b1', sessionId: 's1', payload: { len: 12, copiedStem: true } },
  { seq: 1, type: 'login', at: '2026-11-09T09:58:00.000Z', userId: 'u1', batchId: 'b1', payload: { displayName: 'S01' } },
  { seq: 15, type: 'page_enter', at: '2026-11-09T10:16:00.000Z', userId: 'u1', batchId: 'b1', sessionId: 's1', payload: { page: 4 } },
  { seq: 5, type: 'page_enter', at: '2026-11-09T10:01:00.000Z', userId: 'u1', batchId: 'b1', sessionId: 's1', payload: { page: 3 } },
  { seq: 9, type: 'chat_reply', at: '2026-11-09T10:01:20.000Z', userId: 'u2', batchId: 'b1', sessionId: 's2', payload: {} },
  { seq: 13, type: 'page_enter', at: '2026-11-09T10:14:00.000Z', userId: 'u1', batchId: 'b1', sessionId: 's1', payload: { page: 3 } },
  { seq: 7, type: 'chat_send', at: '2026-11-09T10:01:10.000Z', userId: 'u2', batchId: 'b1', sessionId: 's2', payload: { len: 7, copiedStem: false } },
  { seq: 12, type: 'practice_pick', at: '2026-11-09T10:12:00.000Z', userId: 'u1', batchId: 'b1', sessionId: 's1', payload: {} },
  { seq: 6, type: 'intake_choose', at: '2026-11-09T10:01:05.000Z', userId: 'u1', batchId: 'b1', sessionId: 's1', payload: { path: 'photo' } },
  { seq: 16, type: 'chat_send', at: '2026-11-09T10:17:00.000Z', userId: 'u1', batchId: 'b1', sessionId: 's1', payload: { len: 5, copiedStem: false } },
  { seq: 2, type: 'page_enter', at: '2026-11-09T09:59:00.000Z', userId: 'u1', batchId: 'b1', visitId: 'v1', payload: { page: 1 } },
  { seq: 10, type: 'chat_reply', at: '2026-11-09T10:01:20.000Z', userId: 'u1', batchId: 'b1', sessionId: 's1', payload: {} },
  { seq: 4, type: 'page_enter', at: '2026-11-09T10:00:00.000Z', userId: 'u2', batchId: 'b1', sessionId: 's2', payload: { page: 3 } },
  { seq: 14, type: 'intake_choose', at: '2026-11-09T10:14:30.000Z', userId: 'u1', batchId: 'b1', sessionId: 's1', payload: { path: 'paste' } },
];

/** 该会话的事件（保持打乱的字面顺序：排序是导出的事，不是夹具的事） */
const eventsOf = (sessionId) => EVENTS.filter((event) => event.sessionId === sessionId);

/**
 * 三条会话。刻意**不按 id 排序**给进去：条目顺序、报告顺序、jsonl 分组顺序
 * 都由导出自己排，不能靠调用方（或驱动）恰好有序。
 *
 * 会话自带 `events`（与 `metrics.js` 的 D1 约定一致）：`renderSessionsCsv` 是纯渲染器，
 * 事件由调用方按 `sessionId` 分组塞进来 —— `exportBatch` 那边就是把整批事件分组带下来的。
 */
const SESSIONS = [
  {
    id: 's2',
    userId: 'u2',
    batchId: 'b1',
    problemId: 'qbank-2',
    questionIndex: 1,
    startedAt: '2026-11-08T20:00:00.000Z',
    lastAt: '2026-11-09T10:05:00.000Z',
    finishedAt: null,
    endState: 'in_progress',
    /** 两段之间断了 13 小时：这一条就是"隔离夜回来" */
    segments: [
      { start: '2026-11-08T20:00:00.000Z', lastEventAt: '2026-11-08T21:00:00.000Z' },
      { start: '2026-11-09T10:00:00.000Z', lastEventAt: '2026-11-09T10:05:00.000Z' },
    ],
    progress: { maxPage: 3, reached: { p2: '2026-11-08T20:00:00.000Z', p3: '2026-11-09T10:00:00.000Z' }, backtracks: 0 },
    /** 只留设计稿 §5.2 真有的计数器；事件能推的列不再从 counters 里编一个出来 */
    counters: { resetCount: 0, hintLevels: [1] },
    events: eventsOf('s2'),
    turns: [{ i: 0, at: '2026-11-09T10:01:00.000Z', role: 'student', text: '我先把力分解' }],
    reportSnapshot: null,
  },
  {
    id: 's1',
    userId: 'u1',
    batchId: 'b1',
    problemId: 'qbank-1',
    questionIndex: 0,
    startedAt: '2026-11-09T10:00:00.000Z',
    lastAt: '2026-11-09T10:20:00.000Z',
    finishedAt: '2026-11-09T10:20:00.000Z',
    endState: 'finished',
    segments: [{ start: '2026-11-09T10:00:00.000Z', lastEventAt: '2026-11-09T10:20:00.000Z' }],
    progress: {
      maxPage: 4,
      reached: { p2: '2026-11-09T10:00:00.000Z', p3: '2026-11-09T10:01:00.000Z', p4: '2026-11-09T10:20:00.000Z' },
      /**
       * 旧口径写的是 2，事件流按 n→n−1 数出来是 1（页序 3→4→3→4，只有 4→3 是退一步）。
       * 这一列现在以事件流为准：两个数不一致时，CSV 必须是 1。
       */
      backtracks: 2,
    },
    counters: { resetCount: 1, hintLevels: [1, 3, 2] },
    /** 公式卡次数的主来源是记录里的公式卡数组（counters.formulaOpens 只在缺失时回落） */
    record: {
      formulaCards: [
        { at: '2026-11-09T10:02:00.000Z', topic: '受力分析', stepIndex: 0 },
        { at: '2026-11-09T10:12:00.000Z', topic: '受力分析', stepIndex: 1 },
      ],
    },
    events: eventsOf('s1'),
    /** 刻意倒序给：组内必须按 `i` 升序 */
    turns: [
      { i: 1, at: '2026-11-09T10:01:20.000Z', role: 'ai', text: '分解之后，哪个方向没有加速度？', level: 1 },
      { i: 0, at: '2026-11-09T10:01:00.000Z', role: 'student', text: '我先把力分解' },
    ],
    reportSnapshot: { independence: 0.6, formulaCards: 2 },
  },
  {
    /** u9 不在成员表里（人被删了）：代号要写"未知"，会话那一行不能丢 */
    id: 's3',
    userId: 'u9',
    batchId: 'b1',
    problemId: 'qbank-2',
    startedAt: '2026-11-07T09:00:00.000Z',
    lastAt: '2026-11-07T10:00:00.000Z',
    finishedAt: null,
    progress: { maxPage: 9, reached: {}, backtracks: 0 },
    /**
     * 残缺的老记录：**没有事件**，counters 里也没有那两个不存在的字段。
     * 首条消息字数只能是空（不是 0 —— 0 会被读成"他说了一个空消息"）。
     */
    counters: { hintLevels: [] },
    turns: [],
    reportSnapshot: null,
  },
];

/**
 * 假存储：只实现整批导出允许用到的那几个读接口。
 *
 * 另外两个（`getSession` / `listEventsBySession`）故意做成"一调就抛"：
 * 逐会话回查会让一次导出的库调用从 5 次变成 1 + 2N 次 —— 试点班 40 人还行，
 * 一个学期之后就没人证明得出它还是那个数量级。这条约束只能靠测试钉住。
 */
function makeStore({ batch = BATCH, members = MEMBERS, users = USERS, sessions = SESSIONS, events = EVENTS } = {}) {
  const calls = [];
  return {
    calls,
    store: {
      async getBatch(id) {
        calls.push('getBatch');
        return batch && batch.id === id ? structuredClone(batch) : null;
      },
      async listMembers() {
        calls.push('listMembers');
        return structuredClone(members);
      },
      async getUserById(id) {
        calls.push(`getUserById:${id}`);
        return users[id] ? structuredClone(users[id]) : null;
      },
      async listSessionsByBatch() {
        calls.push('listSessionsByBatch');
        return structuredClone(sessions);
      },
      async listEventsByBatch() {
        calls.push('listEventsByBatch');
        return structuredClone(events);
      },
      async getSession() {
        calls.push('getSession');
        throw new Error('整批导出不该逐条读会话');
      },
      async listEventsBySession() {
        calls.push('listEventsBySession');
        throw new Error('整批导出不该逐条读事件');
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 读 zip / 读 CSV 的小工具
// ---------------------------------------------------------------------------

/** 从中央目录读条目（顺序 = 写入顺序）。整批导出只关心"有哪些、什么顺序、内容是什么"。 */
function zipEntries(buf) {
  const eocd = buf.length - 22;
  assertEquals(buf.readUInt32LE(eocd), 0x06054b50, 'EOCD 签名应当正好在最后 22 字节处');
  const total = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < total; i += 1) {
    assertEquals(buf.readUInt32LE(at), 0x02014b50, `第 ${i + 1} 条中央目录签名`);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26);
    entries.push({ name, data: buf.subarray(dataAt, dataAt + size) });
    at += 46 + nameLen;
  }
  return entries;
}

function entryText(buf, name) {
  const found = zipEntries(buf).find((entry) => entry.name === name);
  assert(found, `zip 里应当有 ${name}`);
  return found.data.toString('utf8');
}

/** 拆一行为单元格。夹具里没有带逗号的单元格（转义另有用例），按逗号拆就够。 */
const cellsOf = (line) => line.split(',');

/** CSV → 以表头为键的行（BOM 与 `\r\n` 一起在这里被吃掉，用例不必各拆一遍） */
function csvRows(csv) {
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  const headers = cellsOf(lines[0]);
  return lines.slice(1).map((line) => {
    const values = cellsOf(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

/** 按会话 id 取一行（用例里 90% 的断言都是"某条会话的那一格"） */
const rowOf = (csv, sessionId) => csvRows(csv).find((row) => row['会话id'] === sessionId);

// ---------------------------------------------------------------------------
// 条目与顺序
// ---------------------------------------------------------------------------

describe('整批导出 · 条目与顺序', () => {
  it('固定五个文件 + 每条会话一份报告：条目数对得上，一个不少', async () => {
    const { store } = makeStore();
    const entries = zipEntries(await exportBatch(store, 'b1', { now: NOW }));
    assertEquals(entries.length, SESSIONS.length + 5, '5 个固定文件（README + 两份 CSV + 两份 jsonl）+ 每条会话一份报告');
    const names = entries.map((entry) => entry.name);
    for (const name of ['README.md', 'students.csv', 'sessions.csv', 'events.jsonl', 'turns.jsonl']) {
      assert(names.includes(name), `缺条目 ${name}`);
    }
    for (const session of SESSIONS) assert(names.includes(`reports/${session.id}.json`), `缺 reports/${session.id}.json`);
  });

  it('条目顺序固定：README 打头、报告按会话 id 字典序收尾（两次 diff 才比得动）', async () => {
    const { store } = makeStore();
    const names = zipEntries(await exportBatch(store, 'b1', { now: NOW })).map((entry) => entry.name);
    assertEquals(
      names.join('|'),
      'README.md|students.csv|sessions.csv|events.jsonl|turns.jsonl|reports/s1.json|reports/s2.json|reports/s3.json',
    );
  });

  it('同一输入两次导出字节完全相同（导出件要能逐版本 diff）', async () => {
    const first = await exportBatch(makeStore().store, 'b1', { now: NOW });
    const second = await exportBatch(makeStore().store, 'b1', { now: NOW });
    assert(first.equals(second), '同样的输入必须产出同样的字节：任何时间戳/随机名混进导出件都会让 diff 全是噪音');
  });

  it('一次导出只按批次读库：不逐条回查会话与事件', async () => {
    const { store, calls } = makeStore();
    await exportBatch(store, 'b1', { now: NOW });
    assertEquals(calls.filter((name) => name === 'getBatch').length, 1, '批次只查一次');
    assertEquals(calls.filter((name) => name === 'listMembers').length, 1, '成员表只查一次');
    assertEquals(calls.filter((name) => name === 'listSessionsByBatch').length, 1, '会话只查一次');
    assertEquals(calls.filter((name) => name === 'listEventsByBatch').length, 1, '事件只查一次');
    /** 代号只查"留下会话的成员"：u3 发了号却没做题（不必查），u9 不在名单里（查不到） */
    const userLookups = calls.filter((name) => name.startsWith('getUserById:'));
    assertEquals(userLookups.join(','), 'getUserById:u1,getUserById:u2', '按人查一次，不按会话查');
    assertEquals(calls.filter((name) => name === 'getSession').length, 0, '不许逐条读会话');
    assertEquals(calls.filter((name) => name === 'listEventsBySession').length, 0, '不许逐条读事件');
  });
});

// ---------------------------------------------------------------------------
// sessions.csv
// ---------------------------------------------------------------------------

describe('整批导出 · sessions.csv', () => {
  const render = () => renderSessionsCsv(SESSIONS, { batch: BATCH, now: NOW });

  it('行数 = 会话数 + 表头（按 \\r\\n 数，Excel 与 wc -l 才对得上）', () => {
    const lines = render().replace(/^\uFEFF/, '').split('\r\n');
    assertEquals(lines.length, SESSIONS.length + 1, '3 条会话 + 1 行表头');
  });

  it('表头顺序固定（21 列，从左到右；它是字段字典的唯一来源）', () => {
    const header = render().replace(/^\uFEFF/, '').split('\r\n')[0];
    assertEquals(
      header,
      '批次,代号,会话id,题目id,题单序号,开始时间,最后活动时间,是否完成,走到第几页,退回次数,重置次数,改入场次数,对话轮数,给过的最高层级,公式卡次数,报告次数,再练次数,首条消息字数,是否复制题干,是否放弃,隔离夜回来',
    );
    assertEquals(cellsOf(header).length, 21);
  });

  it('每一行的字段数都与表头一致（少一格就是所有列整体错位）', () => {
    const lines = render().replace(/^\uFEFF/, '').split('\r\n');
    for (const line of lines) assertEquals(cellsOf(line).length, 21, `这一行的字段数不对：${line}`);
  });

  it('是否完成看 finishedAt；是否放弃按 isAbandoned 算（都写中文是/否）', () => {
    const rows = csvRows(render());
    assertEquals(rows.find((row) => row['会话id'] === 's1')['是否完成'], '是', 's1 有 finishedAt');
    assertEquals(rows.find((row) => row['会话id'] === 's2')['是否完成'], '否', 's2 没做完');
    /** s3 的最后活动是两天前，且没有 finishedAt —— 到 NOW 已经超过 24 小时 */
    assertEquals(rows.find((row) => row['会话id'] === 's3')['是否放弃'], '是');
    assertEquals(rows.find((row) => row['会话id'] === 's2')['是否放弃'], '否', 's2 两小时内还在，不算放弃');
  });

  it('给过的最高层级取 hintLevels 的最大值，空数组写 0', () => {
    const rows = csvRows(render());
    assertEquals(rows.find((row) => row['会话id'] === 's1')['给过的最高层级'], '3', '[1,3,2] 的最高层是 3');
    assertEquals(rows.find((row) => row['会话id'] === 's3')['给过的最高层级'], '0', '没给过是 0，不是空、不是 -Infinity');
  });

  it('隔离夜回来：相邻两段断开超过 6 小时才是"是"', () => {
    const rows = csvRows(render());
    assertEquals(rows.find((row) => row['会话id'] === 's2')['隔离夜回来'], '是', '13 小时的断口');
    assertEquals(rows.find((row) => row['会话id'] === 's1')['隔离夜回来'], '否', '只有一段');
    assertEquals(rows.find((row) => row['会话id'] === 's3')['隔离夜回来'], '否', '没有 segments 就是没有证据，不猜');
  });

  it('走到第几页夹在 1–4：产品只有四页，导出件里不许出现"第 9 页"', () => {
    /** s3 的 maxPage 是 9（坏数据）。夹平比原样写出去诚实：界面上没有第 9 页 */
    assertEquals(rowOf(render(), 's3')['走到第几页'], '4');
    assertEquals(rowOf(render(), 's2')['走到第几页'], '3');
  });

  it('残缺记录只退成 0 / 否 / 空，不写 undefined 与 NaN', () => {
    const csv = render();
    assertNotIncludes(csv, 'undefined');
    assertNotIncludes(csv, 'NaN');
    const s3 = rowOf(csv, 's3');
    assertEquals(s3['重置次数'], '0');
    assertEquals(s3['改入场次数'], '0');
    assertEquals(s3['公式卡次数'], '0');
    assertEquals(s3['对话轮数'], '0');
    assertEquals(s3['首条消息字数'], '', '没有事件也没有这个计数器：留空，不写 0');
    assertEquals(s3['是否复制题干'], '否');
    assertEquals(s3['题单序号'], '', '题单序号算不出来时留空，不写 0（0 是"第一道题"）');
  });

  it('完整的计数逐列写对（这几列是看板的分子分母）', () => {
    const s1 = rowOf(render(), 's1');
    assertEquals(s1['批次'], 'b1');
    assertEquals(s1['题目id'], 'qbank-1');
    assertEquals(s1['题单序号'], '0');
    assertEquals(s1['开始时间'], '2026-11-09T10:00:00.000Z');
    assertEquals(s1['最后活动时间'], '2026-11-09T10:20:00.000Z');
    assertEquals(s1['退回次数'], '1', '3→4→3→4：只有 4→3 是 n→n−1 的一步（progress.backtracks 的 2 不算）');
    assertEquals(s1['重置次数'], '1');
    assertEquals(s1['改入场次数'], '1', 'intake_choose 有两种 path（photo / paste）');
    assertEquals(s1['对话轮数'], '2', '两条 chat_send');
    assertEquals(s1['公式卡次数'], '2', 'record.formulaCards 的长度');
    assertEquals(s1['报告次数'], '2', '两次进入页 4');
    assertEquals(s1['再练次数'], '1', '一条 practice_pick');
    assertEquals(s1['首条消息字数'], '12', '第一条 chat_send 的 payload.len，不是第二条的 5');
    assertEquals(s1['是否复制题干'], '是', '第一条 chat_send 的 payload.copiedStem');
  });

  it('事件流优先于 counters：两边都有时以事件为准（counters 只是补漏的回落）', () => {
    const session = {
      id: 's7',
      batchId: 'b1',
      /** 每一条都能从事件流算出来，counters 里故意放一组对不上的数 */
      counters: {
        resetCount: 0,
        hintLevels: [],
        chatTurns: 9,
        intakeChanges: 8,
        reportViews: 7,
        practicePicks: 6,
        formulaOpens: 5,
        backtracks: 4,
      },
      progress: { backtracks: 4 },
      /** 公式卡的主来源是记录，不是 counters.formulaOpens：这里 3 张 */
      record: { formulaCards: [{}, {}, {}] },
      events: [
        { seq: 1, type: 'page_enter', at: '2026-11-09T10:00:00.000Z', sessionId: 's7', payload: { page: 3 } },
        { seq: 2, type: 'page_enter', at: '2026-11-09T10:01:00.000Z', sessionId: 's7', payload: { page: 4 } },
        { seq: 3, type: 'page_enter', at: '2026-11-09T10:02:00.000Z', sessionId: 's7', payload: { page: 3 } },
        { seq: 4, type: 'chat_send', at: '2026-11-09T10:03:00.000Z', sessionId: 's7', payload: { len: 4, copiedStem: false } },
        { seq: 5, type: 'practice_pick', at: '2026-11-09T10:04:00.000Z', sessionId: 's7', payload: {} },
      ],
    };
    const row = rowOf(renderSessionsCsv([session], { batch: BATCH, now: NOW }), 's7');
    assertEquals(row['对话轮数'], '1', '一条 chat_send：counters.chatTurns 的 9 不算');
    assertEquals(row['改入场次数'], '0', '没有 intake_choose：counters.intakeChanges 的 8 不算');
    assertEquals(row['退回次数'], '1', '3→4→3：只有 4→3 是 n→n−1 的一步，counters / progress 的 4 不算');
    assertEquals(row['报告次数'], '1', '一次进入页 4：counters.reportViews 的 7 不算');
    assertEquals(row['再练次数'], '1', '一条 practice_pick：counters.practicePicks 的 6 不算');
    assertEquals(row['公式卡次数'], '3', '记录里 3 张公式卡：counters.formulaOpens 的 5 不算');
    assertEquals(row['首条消息字数'], '4');
    assertEquals(row['是否复制题干'], '否');
  });

  it('会话没有 counters、只有事件：这几列仍然有正确值（真实数据就是这个形状）', () => {
    const session = {
      id: 's9',
      batchId: 'b1',
      events: [
        { seq: 1, type: 'page_enter', at: '2026-11-09T10:00:00.000Z', sessionId: 's9', payload: { page: 3 } },
        { seq: 2, type: 'page_enter', at: '2026-11-09T10:01:00.000Z', sessionId: 's9', payload: { page: 4 } },
        { seq: 3, type: 'page_enter', at: '2026-11-09T10:02:00.000Z', sessionId: 's9', payload: { page: 2 } },
        { seq: 4, type: 'intake_choose', at: '2026-11-09T10:03:00.000Z', sessionId: 's9', payload: { path: 'photo' } },
        { seq: 5, type: 'intake_choose', at: '2026-11-09T10:04:00.000Z', sessionId: 's9', payload: { path: 'paste' } },
        { seq: 6, type: 'chat_send', at: '2026-11-09T10:05:00.000Z', sessionId: 's9', payload: { len: 9, copiedStem: true } },
        { seq: 7, type: 'chat_send', at: '2026-11-09T10:06:00.000Z', sessionId: 's9', payload: { len: 3, copiedStem: false } },
        { seq: 8, type: 'practice_pick', at: '2026-11-09T10:07:00.000Z', sessionId: 's9', payload: {} },
        { seq: 9, type: 'practice_pick', at: '2026-11-09T10:08:00.000Z', sessionId: 's9', payload: {} },
      ],
    };
    const row = rowOf(renderSessionsCsv([session], { batch: BATCH, now: NOW }), 's9');
    assertEquals(row['对话轮数'], '2', '两条 chat_send');
    assertEquals(row['首条消息字数'], '9', '第一条 chat_send 的 payload.len，不是最后一条的 3');
    assertEquals(row['是否复制题干'], '是', '第一条 chat_send 的 copiedStem');
    assertEquals(row['改入场次数'], '1', '两种 path：2 - 1');
    assertEquals(row['退回次数'], '0', '4→2 一次退两页，不是 n→n−1，不计');
    assertEquals(row['报告次数'], '1');
    assertEquals(row['再练次数'], '2', '两条 practice_pick');
    assertEquals(row['公式卡次数'], '0', '没有 record 也没有 counters：没有就是 0');
    assertEquals(row['重置次数'], '0');
    assertEquals(row['给过的最高层级'], '0');
  });

  it('既没有事件也没有 counters：首条消息字数留空（不写 0），是否复制题干写否，数字列写 0', () => {
    const row = rowOf(renderSessionsCsv([{ id: 's8', batchId: 'b1' }], { batch: BATCH, now: NOW }), 's8');
    assertEquals(row['首条消息字数'], '', '没有消息 ≠ 消息长度 0：留空才读得出"没有"');
    assertEquals(row['是否复制题干'], '否', '布尔列空与否同义，写否更清楚');
    for (const column of ['退回次数', '重置次数', '改入场次数', '对话轮数', '给过的最高层级', '公式卡次数', '报告次数', '再练次数']) {
      assertEquals(row[column], '0', `${column} 没有数据时写 0`);
    }
  });

  it('首条消息字数退到第一条学生消息：没有事件、没有 counters 时量 turns', () => {
    const session = {
      id: 's6',
      batchId: 'b1',
      turns: [
        { i: 0, role: 'ai', text: '老师先说' },
        { i: 1, role: 'student', text: '这一点我不太明白' },
      ],
    };
    const row = rowOf(renderSessionsCsv([session], { batch: BATCH, now: NOW }), 's6');
    assertEquals(row['首条消息字数'], String('这一点我不太明白'.length), '退到第一条学生消息的字数');
  });

  it('整批导出真的把事件接到了会话上：CSV 的那几列与事件流一致（不只直调渲染器才对）', async () => {
    const { store } = makeStore();
    const s1 = rowOf(entryText(await exportBatch(store, 'b1', { now: NOW }), 'sessions.csv'), 's1');
    assertEquals(s1['首条消息字数'], '12');
    assertEquals(s1['是否复制题干'], '是');
    assertEquals(s1['对话轮数'], '2');
    assertEquals(s1['再练次数'], '1');
  });

  it('人被删了：代号写"未知"，但会话那一行必须还在', () => {
    const csv = render();
    assertEquals(rowOf(csv, 's3')['代号'], '未知', '查不到人的时候写"未知"，不写 undefined');
    assertEquals(csvRows(csv).length, SESSIONS.length, '一行都不许少');
  });

  it('只传会话列表（不加任何选项）也照常出表：渲染器不读库、也不挑调用方', () => {
    /** 计划里写的签名就是 `renderSessionsCsv(sessions)`；第二参是可选加强，不是义务 */
    const lines = renderSessionsCsv(SESSIONS).replace(/^\uFEFF/, '').split('\r\n');
    assertEquals(lines.length, SESSIONS.length + 1, '行数口径与带选项时一致');
    for (const line of lines) assertEquals(cellsOf(line).length, 21, `这一行的字段数不对：${line}`);
  });

  it('学生代号由调用方解析后带进来（这个渲染器不碰库）', () => {
    const withNames = SESSIONS.map((session) => ({ ...session, studentName: session.userId === 'u1' ? 'S01' : '' }));
    const rows = csvRows(renderSessionsCsv(withNames, { batch: BATCH, now: NOW }));
    assertEquals(rows.find((row) => row['会话id'] === 's1')['代号'], 'S01');
    assertEquals(rows.find((row) => row['会话id'] === 's2')['代号'], '未知', '空名字同样降级成"未知"');
  });
});

// ---------------------------------------------------------------------------
// sessions.csv · 退回次数的口径
// ---------------------------------------------------------------------------

/**
 * 设计稿 §5.2 的原文是「`backtracks`，从 n 页退到 n−1 页的次数」——**相邻两条 `page_enter`
 * 之间正好退一页**才算一步。不是"比此前最大页号小"：按那个口径，学生退回去再往前翻，
 * 回程沿途每一页都会再记一次，`4→3→2→3→4` 会记成 3 次，而这段路只退了两步。
 *
 * 每个用例只给事件、不给 counters：这一列必须从事件流推出来。
 */
function backtracksOf(pages) {
  const session = {
    id: 's-page',
    batchId: 'b1',
    events: pages.map((page, index) => ({
      seq: index + 1,
      type: 'page_enter',
      at: '2026-11-09T10:00:00.000Z',
      sessionId: 's-page',
      payload: { page },
    })),
  };
  return rowOf(renderSessionsCsv([session], { batch: BATCH, now: NOW }), 's-page')['退回次数'];
}

describe('整批导出 · 退回次数只数 n→n−1', () => {
  it('4→3→2→3→4 记 2：退两步算两次，回程 2→3 / 3→4 不算', () => {
    assertEquals(backtracksOf([4, 3, 2, 3, 4]), '2');
  });

  it('3→3→2 记 1：同一页重进不算，3→2 才是退一步', () => {
    assertEquals(backtracksOf([3, 3, 2]), '1');
  });

  it('2→3 记 0：只往前走', () => {
    assertEquals(backtracksOf([2, 3]), '0');
  });

  it('只有一条 page_enter 记 0：没有上一条可比', () => {
    assertEquals(backtracksOf([3]), '0');
  });

  it('4→2 记 0：一次退两页不是 n→n−1（尺子是设计稿那句话，不是"任何往回走"）', () => {
    assertEquals(backtracksOf([4, 2]), '0');
  });

  it('没有事件的老记录仍退到 counters.backtracks（回落不因新口径丢掉）', () => {
    const row = rowOf(
      renderSessionsCsv([{ id: 's-old', batchId: 'b1', counters: { backtracks: 3 } }], { batch: BATCH, now: NOW }),
      's-old',
    );
    assertEquals(row['退回次数'], '3', '没有事件时读 counters.backtracks，而不是一律写 0');
  });
});

// ---------------------------------------------------------------------------
// students.csv
// ---------------------------------------------------------------------------

describe('整批导出 · students.csv', () => {
  it('列固定：代号,批次,首次登录,最后登录,会话数,完成数', () => {
    const header = renderStudentsCsv([
      { displayName: 'S01', batchId: 'b1', firstSeenAt: NOW, lastSeenAt: NOW, sessionCount: 1, finishedCount: 1 },
    ])
      .replace(/^\uFEFF/, '')
      .split('\r\n')[0];
    assertEquals(header, '代号,批次,首次登录,最后登录,会话数,完成数');
  });

  it('只列"有会话的成员"：发过号但一道题没做的人不出现', async () => {
    const { store } = makeStore();
    const rows = csvRows(entryText(await exportBatch(store, 'b1', { now: NOW }), 'students.csv'));
    assertEquals(rows.map((row) => row['代号']).join(','), 'S01,S02', 'u3（S03）没有会话，不该出现；u9 已删，也不该出现');
  });

  it('会话数与完成数按这个人的会话算', async () => {
    const { store } = makeStore();
    const rows = csvRows(entryText(await exportBatch(store, 'b1', { now: NOW }), 'students.csv'));
    const s01 = rows.find((row) => row['代号'] === 'S01');
    assertEquals(s01['会话数'], '1');
    assertEquals(s01['完成数'], '1');
    const s02 = rows.find((row) => row['代号'] === 'S02');
    assertEquals(s02['完成数'], '0');
  });

  it('首次/最后登录取登录时回填的那两个时间；没登录过写"未登录"', () => {
    const csv = renderStudentsCsv([
      { displayName: 'S01', batchId: 'b1', firstSeenAt: null, lastSeenAt: null, sessionCount: 1, finishedCount: 0 },
    ]);
    const row = csvRows(csv)[0];
    assertEquals(row['首次登录'], '未登录');
    assertEquals(row['最后登录'], '未登录');
  });

  it('导出件里没有真名，只有代号', () => {
    const csv = renderStudentsCsv([{ displayName: 'S01', batchId: 'b1' }]);
    assertIncludes(csv, 'S01');
    assertNotIncludes(csv, '张');
  });
});

// ---------------------------------------------------------------------------
// CSV 编码（Excel 打开这是第一屏）
// ---------------------------------------------------------------------------

describe('整批导出 · CSV 编码', () => {
  it('以 BOM 开头、用 \\r\\n 分隔（Excel 打开中文不乱码）', () => {
    const csv = toCsv([{ 代号: 'S01', 题数: 2 }], ['代号', '题数']);
    assertEquals(csv.charCodeAt(0), 0xfeff, '必须以 BOM 开头');
    assertIncludes(csv, 'S01');
    assert(!/[^\r]\n/.test(csv), '\\n 只能作为 \\r\\n 的后半段出现');
  });

  it('表头 + 数据行，不额外多一行空行（行数口径写死在这里）', () => {
    const csv = toCsv(
      [
        { 代号: 'S01', 题数: 2 },
        { 代号: 'S02', 题数: 0 },
      ],
      ['代号', '题数'],
    );
    assertEquals(csv.replace(/^\uFEFF/, '').split('\r\n').length, 3, '2 条数据 + 1 行表头');
  });

  it('单元格里的逗号、引号、换行被引号包住，行数不变', () => {
    const csv = toCsv([{ 说明: 'a,b', 备注: '他说"再来一次"', 其他: '第一行\n第二行' }], ['说明', '备注', '其他']);
    const body = csv.replace(/^\uFEFF/, '').split('\r\n');
    assertEquals(body.length, 2, '单元格里的换行被引号包住之后不该再拆出一行');
    assertIncludes(csv, '"a,b"');
    assertIncludes(csv, '"他说""再来一次"""');
    assertIncludes(csv, '"第一行\n第二行"');
  });

  it('空值写成空单元格，不写 null / undefined', () => {
    const csv = toCsv([{ 代号: 'S01', 备注: null, 其他: undefined }], ['代号', '备注', '其他']);
    const row = csvRows(csv)[0];
    assertEquals(row['备注'], '');
    assertEquals(row['其他'], '');
    assertNotIncludes(csv, 'null');
  });
});

// ---------------------------------------------------------------------------
// events.jsonl / turns.jsonl
// ---------------------------------------------------------------------------

describe('整批导出 · jsonl', () => {
  it('events.jsonl：按 sessionId 字典序分组、组内按 seq 升序（不依赖库的返回顺序）', async () => {
    const { store } = makeStore();
    const lines = entryText(await exportBatch(store, 'b1', { now: NOW }), 'events.jsonl')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    assertEquals(
      lines.map((event) => event.sessionId ?? '(无归属)').join(','),
      '(无归属),(无归属),(无归属),s1,s1,s1,s1,s1,s1,s1,s1,s1,s1,s2,s2,s2',
      '空键（登录 + 挂 visitId 的页面事件）排最前，其余按 sessionId 字典序',
    );
    assertEquals(
      lines.map((event) => event.seq).join(','),
      '1,2,3,5,6,8,10,11,12,13,14,15,16,4,7,9',
      '组内按 seq 升序：空键那一组的三条虽然 seq 更小，也不能混进会话组',
    );
  });

  it('没有 seq、at 也解不出来时仍按 type 兜底定序（不依赖驱动返回顺序）', async () => {
    /**
     * 这一条钉的是排序的**最后一级**：既没有数字 `seq`、`at` 也解不出时间时，
     * 从前返回 0，于是行序退化成"驱动先读到谁"——同一批数据两个驱动导出不同。
     * 补上 at 字符串 → type → 归属键之后，这里必须稳定地是 chat_send 在前。
     */
    const events = [
      { type: 'session_reset', at: '不是时间', userId: 'u1', batchId: 'b1', sessionId: 's1', payload: {} },
      { type: 'chat_send', at: '不是时间', userId: 'u1', batchId: 'b1', sessionId: 's1', payload: {} },
    ];
    const { store } = makeStore({ sessions: [], events });
    const lines = entryText(await exportBatch(store, 'b1', { now: NOW }), 'events.jsonl')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    assertEquals(lines.map((event) => event.type).join(','), 'chat_send,session_reset');
  });

  it('events.jsonl 里一条都不丢：没有 sessionId 的页面事件也在', async () => {
    const { store } = makeStore();
    const lines = entryText(await exportBatch(store, 'b1', { now: NOW }), 'events.jsonl').trimEnd().split('\n');
    assertEquals(lines.length, EVENTS.length, '少了就是"没有采集"，而它们其实是采集到了');
    assertIncludes(lines.join('\n'), 'page_enter');
  });

  it('turns.jsonl：按 sessionId 字典序、组内按 i 升序，每条带上会话 id', async () => {
    const { store } = makeStore();
    const lines = entryText(await exportBatch(store, 'b1', { now: NOW }), 'turns.jsonl')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    assertEquals(
      lines.map((turn) => `${turn.sessionId}#${turn.i}`).join(','),
      's1#0,s1#1,s2#0',
      's1 的两轮在夹具里是倒着给的，导出必须按 i 排回来',
    );
    assertIncludes(lines[0].text, '我先把力分解', '每一轮都要带原文');
    assertEquals(lines[1].level, 1, '老师轮次的层级是这个产品最要紧的信息，不能丢');
  });

  it('没有任何事件/对话时，两个 .jsonl 仍然是空文件（不是没有这个文件）', async () => {
    const { store } = makeStore({ sessions: [], events: [] });
    const buf = await exportBatch(store, 'b1', { now: NOW });
    const entries = zipEntries(buf);
    for (const name of ['events.jsonl', 'turns.jsonl']) {
      const found = entries.find((entry) => entry.name === name);
      assert(found, `空批次也要出 ${name}`);
      assertEquals(found.data.length, 0, `${name} 应当是空文件`);
    }
    assertEquals(entries.length, 5, '没有会话时就是 5 个固定文件，一份报告都没有');
  });
});

// ---------------------------------------------------------------------------
// 逐条报告
// ---------------------------------------------------------------------------

describe('整批导出 · 逐条报告', () => {
  it('reports/<id>.json 就是 snapshotSession 的结果（与单条导出同一份投影）', async () => {
    const { store } = makeStore();
    const buf = await exportBatch(store, 'b1', { now: NOW });
    for (const session of SESSIONS) {
      const parsed = JSON.parse(entryText(buf, `reports/${session.id}.json`));
      assertEquals(JSON.stringify(parsed), JSON.stringify(snapshotSession(session)), `${session.id} 的报告快照对不上`);
      assertNotIncludes(entryText(buf, `reports/${session.id}.json`), 'studentName', '代号不进报告：报告是库里那一份');
    }
  });
});

// ---------------------------------------------------------------------------
// README.md
// ---------------------------------------------------------------------------

describe('整批导出 · README.md', () => {
  const readme = () => renderBatchReadme({ batch: BATCH, generatedAt: NOW, sessionCount: SESSIONS.length });

  it('三句固定文案逐字照抄（改写一句就可能把"会不会用"写成"有没有效果"）', () => {
    const md = readme();
    assertIncludes(
      md,
      '这批数据回答的是**会不会用**（学生停在哪一页、在哪一页退回去、一道题重来几次），**不回答有没有效果**。',
    );
    assertIncludes(md, '掌握程度是页面上由独立完成度推导出的颜色档，不存库；本导出件以数字为准。');
    assertIncludes(md, '代号与真名的对照表不在导出件里，由发号时的 CSV 保管。');
    /** 这两条是上面那句的"意思"：单独钉一次，免得有人为了让措辞好看而改坏立场 */
    assertIncludes(md, '会不会用');
    assertIncludes(md, '不回答有没有效果');
  });

  it('字段字典由 sessions.csv 的表头生成：21 个字段一个不少、顺序一致', () => {
    const headers = renderSessionsCsv([], { batch: BATCH, now: NOW }).replace(/^\uFEFF/, '').split('\r\n')[0];
    const lines = readme().split('\n');
    const first = lines.findIndex((line) => line.includes('字段字典'));
    assert(first >= 0, 'README 里应当有字段字典一节');
    /** 只取这一节（到下一个二级标题为止），后面的小节不会再被当成字段 */
    const rest = lines.slice(first + 1);
    const end = rest.findIndex((line) => line.startsWith('## '));
    const dictionary = (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.startsWith('- `'));
    assertEquals(dictionary.length, cellsOf(headers).length, '字典里的字段数必须等于表头的列数');
    cellsOf(headers).forEach((header, index) => {
      assert(
        dictionary[index].startsWith(`- \`${header}\``),
        `字典第 ${index + 1} 项应当是 ${header}，实际是 ${dictionary[index]}`,
      );
    });
    /**
     * 缺说明时不能静默写占位符：那份字典是发给教研的唯一字段解释，
     * 一句"（这一版没有写说明）"会被读成"这列本来就没有含义"。
     * 加了列却忘了写说明，这一条必须当场变红。
     */
    assertNotIncludes(readme(), '这一版没有写说明', '每个表头都必须有对应的说明常量');
  });

  it('写明数据覆盖到、批次标识与版本、以及"清理前必须先导出、保留 90 天"', () => {
    const md = readme();
    assertIncludes(md, '数据覆盖到');
    assertNotIncludes(md, '数据截止时间', '标签必须说明"数据到哪儿"，不能被读成"文件何时生成"');
    assertIncludes(md, NOW, '数据覆盖到取调用方传进来的那一刻，不自己在渲染器里读钟');
    assertIncludes(md, '本导出件不含生成时刻，以保证同一批数据两次导出完全一致。');
    assertIncludes(md, 'b1');
    assertIncludes(md, '第二版');
    assertIncludes(md, '批次版本');
    assertIncludes(md, '清理前必须先导出');
    assertIncludes(md, '90 天');
  });

  it('说明手册里有什么文件（收到 zip 的人不该靠猜）', () => {
    const md = readme();
    for (const name of ['students.csv', 'sessions.csv', 'events.jsonl', 'turns.jsonl', 'reports/']) {
      assertIncludes(md, name, `README 应当说明 ${name} 是什么`);
    }
  });

  it('缺参数时不写 undefined：只给 batch 也能渲染', () => {
    const md = renderBatchReadme({ batch: { id: 'b1', label: '第二版' } });
    assertNotIncludes(md, 'undefined');
    assertNotIncludes(md, 'null');
    assertIncludes(md, '会不会用');
  });
});

// ---------------------------------------------------------------------------
// 缺批次
// ---------------------------------------------------------------------------

describe('整批导出 · 缺批次', () => {
  it('批次不存在 → 抛中文错误并带 BATCH_NOT_FOUND（Task 8 据此回 404）', async () => {
    const { store } = makeStore({ batch: null });
    let err = null;
    try {
      await exportBatch(store, 'b1');
    } catch (error) {
      err = error;
    }
    assert(err, '批次不存在必须抛错，不能返回一个空 zip');
    assertEquals(err.message, '无法导出：这个批次不存在');
    assertEquals(err.code, 'BATCH_NOT_FOUND');
  });
});
