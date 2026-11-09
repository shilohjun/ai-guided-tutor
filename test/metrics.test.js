/**
 * 漏斗与指标（纯函数）：四页漏斗、放弃判定、批次汇总。
 *
 * ============================================================================
 * 为什么这些数字值得逐条钉死
 * ============================================================================
 * 这一套函数产出的是**会被直接抄进结论里的数字**："第 2 页掉了一半"
 * "一轮失败率 6%"。抄的人不会重算，所以口径必须在这里留下可判定的断言：
 *
 *   ① 分母是**人**还是**次**：一个人重做五道题不许把漏斗撑爆，
 *      但 p1 又是"打开次数"（一次打开 = 一次 visit）—— 两者刻意不同，各自钉一条。
 *   ② 空数据 / 单人 / 坏数据：只能是 `0` 或 `null`，不许出现 `NaN` / `Infinity`。
 *      看板上一个 NaN 会变成一根到天的柱子，而它看起来像"数据"。
 *   ③ 一轮失败率按 D2 的**配对**口径，不是"数 reply 条数"：一条多出来的 reply
 *      不许替下一轮背书；`chat_error` 只有 `TURN_SLOW` / `UPSTREAM` 才算失败。
 *   ④ 放弃是**读时算**的（`abandoned` 不落库）：`lastAt` 解析不出来时宁可算
 *      "没放弃"，也不凭空造一个放弃。
 */

import { describe, it, assertEquals, assert } from './runner.js';
import { isAbandoned, buildFunnel, summarizeSessions, deriveDwell } from '../src/server/metrics.js';

const BATCH = { id: 'b1', abandonHours: 24, idleMinutes: 8 };

const H = 3600e3;
/**
 * 2026-11-09 的 h 点。h 可以是小数：T(1.5) = 01:30。
 * 不能用 `Date.UTC(..., h)` —— 它会把小时截成整数，1.5 变成 1，
 * 于是"待了半小时"的断言会静默地变成"待了 0 秒"。
 */
const T = (h) => new Date(Date.UTC(2026, 10, 9) + h * H).toISOString();

/** page 系列事件：页号在 `payload.page`（设计稿 §5.3 的字典），`at` 由服务端盖。 */
const pageEv = (type, h, page) => ({ type, at: T(h), payload: { page } });
/** 对话事件：payload 里放 ms / suppressed / code。 */
const chatEv = (type, h, payload = {}) => ({ type, at: T(h), payload });

/**
 * 本模块最容易被破的一条：任何数值字段都不能是 NaN / Infinity。
 * 逐个字段查而不是抽查 —— 抽查总会漏掉那个刚加的字段。
 */
function assertAllFinite(record, label) {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'number') continue;
    assert(Number.isFinite(value), `${label} 的 ${key} 必须是有限数，实际 ${value}`);
  }
}

// ---------------------------------------------------------------------------
// §8 A3 fixture：3 个人，1 个没选就关掉、1 个停在第 3 页、1 个走到报告
// ---------------------------------------------------------------------------

const VISITS = [{ id: 'v1', userId: 'u1' }, { id: 'v2', userId: 'u2' }, { id: 'v3', userId: 'u3' }];

const SESSIONS = [
  { id: 's2', userId: 'u2', lastAt: T(2), progress: { reached: { p1: T(1), p2: T(1), p3: T(2) }, maxPage: 3, backtracks: 0 } },
  { id: 's3', userId: 'u3', lastAt: T(3), finishedAt: T(3), progress: { reached: { p1: T(1), p2: T(1), p3: T(2), p4: T(3) }, maxPage: 4, backtracks: 0 } },
];

describe('指标 · 四页漏斗', () => {
  it('p1 是 visit 数，p2 起按 session 的 reached 计数', () => {
    const f = buildFunnel(VISITS, SESSIONS);
    assertEquals([f.p1, f.p2, f.p3, f.p4].join(','), '3,2,2,1', '打开 3、选到题 2、进解题 2、到报告 1');
  });
  it('最大掉点指向第 2 页（3 打开 → 2 选题）', () => {
    assertEquals(buildFunnel(VISITS, SESSIONS).dropOffPage, 2);
  });
  it('零数据时不出 NaN，dropOffPage 为 null，并标明样本不足', () => {
    const f = buildFunnel([], []);
    assertEquals(f.p1, 0);
    assertEquals(f.dropOffPage, null, '没有数据时不得编造掉点页');
    assert(Number.isFinite(f.conversion.p1_p2), '转化率必须是有限数');
    assertEquals(f.sampleTooSmall, true, '0 个访客必须被标成样本不足');
    assertAllFinite(f.conversion, '空数据的转化率');
    for (const row of f.perPage) assertAllFinite(row, '空数据的 perPage');
  });
  it('只有一个人时也不算掉点（样本不足要看样本不足）', () => {
    const f = buildFunnel([VISITS[0]], []);
    assertEquals(f.dropOffPage, null, 'p1 为 1 时不该得出任何掉点结论');
    assertEquals(f.sampleTooSmall, true);
  });
  it('转化率是两位小数：3 → 2 → 2 → 1 就是 0.67 / 1 / 0.5', () => {
    const f = buildFunnel(VISITS, SESSIONS);
    assertEquals(f.conversion.p1_p2, 0.67, '2/3 按 D3 收到两位小数，不是 0.6666666666');
    assertEquals(f.conversion.p2_p3, 1);
    assertEquals(f.conversion.p3_p4, 0.5);
    assertEquals(f.sampleTooSmall, false);
  });
  it('p2 起人数按 userId 去重：一个人重做五道题只算一个人', () => {
    /**
     * 这是漏斗最容易悄悄错的地方：会话条数不是人数。
     * 一个人重做五道题，如果按会话条数算，他能把 p3 撑到 5 个人。
     */
    const five = [1, 2, 3, 4, 5].map((i) => ({
      id: `s${i}`,
      userId: 'u1',
      progress: { reached: { p2: T(1), p3: T(1) }, maxPage: 3 },
    }));
    const f = buildFunnel([{ id: 'v1', userId: 'u1' }], five);
    assertEquals([f.p1, f.p2, f.p3, f.p4].join(','), '1,1,1,0', '五条会话仍然是同一个人');
  });
  it('p1 是打开次数而不是人数（一次打开 = 一次 visit）', () => {
    const f = buildFunnel(
      [{ id: 'v1', userId: 'u1' }, { id: 'v2', userId: 'u1' }],
      [{ id: 's1', userId: 'u1', progress: { reached: { p2: T(1), p4: T(2) }, maxPage: 4 } }],
    );
    assertEquals(f.p1, 2, '同一个人今天打开两次，p1 就是两次打开');
    assertEquals(f.p2, 1, '但 p2 起算的是人');
  });
  it('每一页的掉点一样大时，取最靠前的那一级', () => {
    /**
     * 4 → 3 → 2 → 1：每一级都掉 1 个人。看板只能指一个页码，
     * 取最靠前的一级 —— 学生越早流失，修它的收益越大。
     */
    const visits = [1, 2, 3, 4].map((i) => ({ id: `v${i}`, userId: `u${i}` }));
    // u1 走到 p4、u2 到 p3、u3 到 p2、u4 只有 visit：每一级都恰好掉 1 个人
    const sessions = [
      { id: 's1', userId: 'u1', progress: { reached: { p2: T(1), p3: T(1), p4: T(1) }, maxPage: 4 } },
      { id: 's2', userId: 'u2', progress: { reached: { p2: T(1), p3: T(1) }, maxPage: 3 } },
      { id: 's3', userId: 'u3', progress: { reached: { p2: T(1) }, maxPage: 2 } },
    ];
    const f = buildFunnel(visits, sessions);
    assertEquals([f.p1, f.p2, f.p3, f.p4].join(','), '4,3,2,1');
    assertEquals(f.dropOffPage, 2, '并列时取最早的一级');
  });
  it('一个人都没掉时 dropOffPage 是 null（没有掉点这回事）', () => {
    const visits = [{ id: 'v1', userId: 'u1' }, { id: 'v2', userId: 'u2' }];
    const sessions = [1, 2].map((i) => ({
      id: `s${i}`,
      userId: `u${i}`,
      progress: { reached: { p1: T(1), p2: T(1), p3: T(1), p4: T(1) }, maxPage: 4 },
    }));
    const f = buildFunnel(visits, sessions);
    assertEquals(f.dropOffPage, null, '四根柱子一样高时不许硬指一页');
    assertEquals(f.sampleTooSmall, false, '样本够，只是没掉点');
  });
  it('perPage 是四页（不是五页），页号就是 1–4', () => {
    const f = buildFunnel(VISITS, SESSIONS);
    assertEquals(f.perPage.length, 4, '产品是四页：题目/方式/解题/报告；setPage(5) 只是别名，没有第五级台阶');
    assertEquals(f.perPage.map((r) => r.page).join(','), '1,2,3,4');
    assertEquals(f.perPage.map((r) => r.visitors).join(','), '3,2,2,1', 'perPage 的 visitors 与柱子同源');
    for (const row of f.perPage) assertAllFinite(row, `perPage ${row.page}`);
  });
  it('没带 events 的会话停留贡献 0，但它仍然算一个人（分母不偷偷变）', () => {
    const visits = [{ id: 'v1', userId: 'u1' }, { id: 'v2', userId: 'u2' }];
    const sessions = [
      {
        id: 's1',
        userId: 'u1',
        progress: { reached: { p1: T(1), p2: T(1), p3: T(1) }, maxPage: 3 },
        events: [pageEv('page_enter', 1, 3), pageEv('page_exit', 2, 3)],
      },
      { id: 's2', userId: 'u2', progress: { reached: { p1: T(1), p2: T(2) }, maxPage: 2 } },
    ];
    const f = buildFunnel(visits, sessions);
    const page2 = f.perPage[1];
    const page3 = f.perPage[2];
    assertEquals(page2.visitors, 2, '两个人都在第 2 页待过');
    assertEquals(page2.avgDwellMs, 0, '两条都没在第 2 页留下配对事件 → 0，而不是跳过');
    assertEquals(page3.visitors, 1);
    assertEquals(page3.avgDwellMs, H, 'u1 在第 3 页待了 1 小时');
    assertAllFinite(page3, 'perPage 第 3 页');
  });
  it('同一个人多条会话：人只算一个，停留是这个人在这页的总时间', () => {
    const visits = [{ id: 'v1', userId: 'u1' }];
    const sessions = [1, 3].map((start) => ({
      id: `s${start}`,
      userId: 'u1',
      progress: { reached: { p3: T(1) }, maxPage: 3 },
      events: [pageEv('page_enter', start, 3), pageEv('page_exit', start + 1, 3)],
    }));
    const f = buildFunnel(visits, sessions);
    assertEquals(f.p3, 1, '两条会话是同一个人重做');
    assertEquals(f.perPage[2].visitors, 1);
    assertEquals(f.perPage[2].avgDwellMs, 2 * H, '两次各 1 小时 = 这个人一共在这页待了 2 小时');
  });
  it('visited 传 null、session 是坏形状时，只有 0 和 null，没有 NaN', () => {
    const f = buildFunnel(null, [null, { id: 'x' }, { progress: null }, { progress: { reached: 'nope' } }]);
    assertEquals(f.p1, 0);
    assertEquals(f.p2, 0);
    assertEquals(f.dropOffPage, null);
    assertEquals(f.sampleTooSmall, true);
    assertAllFinite(f, '坏输入的漏斗');
    for (const row of f.perPage) assertAllFinite(row, '坏输入的 perPage');
  });
});

// ---------------------------------------------------------------------------
// D5：放弃是读时算的
// ---------------------------------------------------------------------------

describe('指标 · 放弃是读时算的', () => {
  it('隔 26 小时（T27 − T1）没动且没 finishedAt → 放弃', () => {
    assert(isAbandoned({ lastAt: T(1) }, BATCH, Date.parse(T(27))));
  });
  it('隔 26 小时但已 finishedAt → 不算放弃', () => {
    assert(!isAbandoned({ lastAt: T(1), finishedAt: T(1) }, BATCH, Date.parse(T(27))));
  });
  it('刚好 24 小时不算放弃（判据是"超过"，不是"达到"）', () => {
    assert(!isAbandoned({ lastAt: T(1) }, BATCH, Date.parse(T(25))));
  });
  it('lastAt 解析不出来时返回 false —— 不凭空造一个放弃', () => {
    assert(!isAbandoned({ lastAt: '不是时间' }, BATCH, Date.parse(T(27))));
    assert(!isAbandoned({}, BATCH, Date.parse(T(27))));
  });
  it('批次没给 abandonHours 时返回 false，而不是把所有人算成放弃', () => {
    assert(!isAbandoned({ lastAt: T(1) }, { id: 'b1' }, Date.parse(T(27))));
  });
});

// ---------------------------------------------------------------------------
// D4：页面停留
// ---------------------------------------------------------------------------

describe('指标 · 页面停留', () => {
  it('有配对的 page_enter / page_exit 就用它们', () => {
    assertEquals(deriveDwell([pageEv('page_enter', 1, 3), pageEv('page_exit', 2, 3)], 3), H);
  });
  it('同一页进出多次要相加（学生退回去又进来）', () => {
    const events = [
      pageEv('page_enter', 1, 3),
      pageEv('page_exit', 1.5, 3),
      pageEv('page_enter', 2, 3),
      pageEv('page_exit', 3, 3),
    ];
    assertEquals(deriveDwell(events, 3), 1.5 * H);
  });
  it('没有 page_exit 时，用该页 page_enter 之后第一条事件的时间差兜底', () => {
    /**
     * 手机上切走、进程被杀都会丢 page_exit。丢了这个数不能就是 0 ——
     * 但也不能猜：只认"下一条事件真的发生了"这个证据。
     */
    const events = [pageEv('page_enter', 1, 3), chatEv('chat_send', 1.5, { len: 8 })];
    assertEquals(deriveDwell(events, 3), H / 2);
  });
  it('只有一个 page_enter、之后什么都没有 → 0（不是 Infinity）', () => {
    assertEquals(deriveDwell([pageEv('page_enter', 1, 3)], 3), 0);
    assertEquals(deriveDwell([], 3), 0);
  });
  it('只看这一页：别的页的进出不参与计算', () => {
    const events = [pageEv('page_enter', 1, 2), pageEv('page_exit', 2, 2), pageEv('page_enter', 3, 3), pageEv('page_exit', 4, 3)];
    assertEquals(deriveDwell(events, 3), H);
    assertEquals(deriveDwell(events, 4), 0, '没去过第 4 页就是 0');
  });
  it('坏时间戳、颠倒的进出顺序都不能造出负数或 NaN', () => {
    const bad = [pageEv('page_enter', 1, 3), { type: 'page_exit', at: '不是时间', payload: { page: 3 } }];
    const reversed = [{ type: 'page_exit', at: T(1), payload: { page: 3 } }, pageEv('page_enter', 2, 3)];
    const negative = [pageEv('page_enter', 2, 3), pageEv('page_exit', 1, 3)];
    for (const events of [bad, reversed, negative]) {
      const dwell = deriveDwell(events, 3);
      assert(Number.isFinite(dwell) && dwell >= 0, `停留必须是有限的非负数，实际 ${dwell}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 批次汇总
// ---------------------------------------------------------------------------

describe('指标 · 批次汇总', () => {
  it('空输入时所有率都是 0 而不是 NaN', () => {
    const s = summarizeSessions([], BATCH, Date.now());
    assertEquals(s.turnFailureRate, 0);
    assertEquals(s.suppressedRate, 0);
    assertEquals(s.avgMaxPage, 0);
    assertEquals(s.sessionCount, 0);
    assertEquals(s.userCount, 0);
    assertEquals(s.avgQuestionsPerUser, 0);
    assertEquals(s.resetTotal, 0);
    assertEquals(s.intakeChangeTotal, 0);
    assertEquals(s.latencyP50, 0);
    assertEquals(s.latencyP90, 0);
    assertEquals(s.abandonCount, 0);
    assertEquals(s.overnightReturns, 0);
    assertAllFinite(s, '空批次的汇总');
  });
  it('一轮失败率 = 有 send 无 reply 的轮数 / send 总数', () => {
    /**
     * 3 次发送里 **2 轮失败**（不是 1 轮，计划里那句注释写错了）：
     * 第 1 轮 send→reply 成功；第 2 轮 send 之后是下一条 send，没等到回复；
     * 第 3 轮 send 落在会话结尾，也没等到回复。2/3 按 D3 收到两位小数 → 0.67。
     */
    const sessions = [{
      id: 's1', turns: [],
      events: [
        { type: 'chat_send' }, { type: 'chat_reply' },
        { type: 'chat_send' }, { type: 'chat_send' },
      ],
    }];
    const s = summarizeSessions(sessions, BATCH, Date.parse(T(28)));
    assertEquals(s.turnFailureRate, 0.67, '3 次发送里有 2 轮没等到回复');
  });
  it('多出来的 reply 不许替下一轮背书（按轮配对）', () => {
    const sessions = [{
      id: 's1',
      events: [
        { type: 'chat_send' }, { type: 'chat_reply' }, { type: 'chat_reply' },
        { type: 'chat_send' }, { type: 'chat_reply' },
      ],
    }];
    assertEquals(summarizeSessions(sessions, BATCH, Date.parse(T(28))).turnFailureRate, 0);
  });
  it('chat_error 只有 TURN_SLOW / UPSTREAM 算失败，GUARD 不算（那是我方拦住了）', () => {
    const turn = (code) => summarizeSessions(
      [{ id: 's1', events: [{ type: 'chat_send' }, { type: 'chat_error', payload: { code } }] }],
      BATCH,
      Date.parse(T(28)),
    ).turnFailureRate;
    assertEquals(turn('TURN_SLOW'), 1, '慢到学生走了，这一轮等于没有回复');
    assertEquals(turn('UPSTREAM'), 1, '上游挂了，同上');
    assertEquals(turn('GUARD'), 0, '护栏拦下并给了替代回复，这一轮不算失败');
  });
  it('没有 send 的 reply 不属于任何一轮，也不进分母', () => {
    const s = summarizeSessions([{ id: 's1', events: [{ type: 'chat_reply' }, { type: 'chat_error' }] }], BATCH, Date.parse(T(28)));
    assertEquals(s.turnFailureRate, 0, '分母为 0 时返回 0，不是 NaN');
  });
  it('AI 沉默率 = suppressed 的 reply / 全部 reply', () => {
    const sessions = [{
      id: 's1',
      events: [
        chatEv('chat_reply', 1, { ms: 100, suppressed: true }),
        chatEv('chat_reply', 1, { ms: 100, suppressed: false }),
        chatEv('chat_reply', 1, { ms: 100 }),
      ],
    }];
    assertEquals(summarizeSessions(sessions, BATCH, Date.parse(T(28))).suppressedRate, 0.33, '1/3 收到两位小数');
  });
  it('模型延迟取真实样本（nearest-rank），没有样本时是 0', () => {
    const events = [120, 80, 500, 300, 200].map((ms) => chatEv('chat_reply', 1, { ms }));
    const s = summarizeSessions([{ id: 's1', events }], BATCH, Date.parse(T(28)));
    assertEquals(s.latencyP50, 200, '排序后第 3 个（ceil(0.5×5)-1 = 2）');
    assertEquals(s.latencyP90, 500, '第 5 个（ceil(0.9×5)-1 = 4）');
    assertEquals(summarizeSessions([], BATCH, Date.parse(T(28))).latencyP50, 0);
  });
  it('延迟里夹着坏的 ms 时跳过它，不把 0 塞进分位数', () => {
    const events = [
      chatEv('chat_reply', 1, { ms: '120' }),
      chatEv('chat_reply', 1, { ms: 400 }),
      chatEv('chat_reply', 1, {}),
      chatEv('chat_reply', 1, { ms: Number.NaN }),
    ];
    const s = summarizeSessions([{ id: 's1', events }], BATCH, Date.parse(T(28)));
    assertEquals(s.latencyP50, 400, '只剩一个真样本');
    assertEquals(s.latencyP90, 400);
    assertEquals(s.suppressedRate, 0, '四条 reply 仍然都在沉默率的分母里');
  });
  it('人数按 userId 去重，人均题数按"不同题号"算（重做同一道题不是新题）', () => {
    const sessions = [
      { id: 's1', userId: 'u1', problemId: 'q1', progress: { maxPage: 2 } },
      { id: 's2', userId: 'u1', problemId: 'q1', progress: { maxPage: 4 } },
      { id: 's3', userId: 'u2', problemId: 'q2', progress: { maxPage: 3 } },
      { id: 's4', userId: 'u2', problemId: 'q3' },
    ];
    const s = summarizeSessions(sessions, BATCH, Date.parse(T(28)));
    assertEquals(s.sessionCount, 4, '会话仍是四条（重来要看得见）');
    assertEquals(s.userCount, 2);
    assertEquals(s.avgQuestionsPerUser, 1.5, 'u1 一道（q1 重做）、u2 两道 → 人均 1.5');
    assertEquals(s.avgMaxPage, 2.5, '2、4、3 和缺省的 1 平均');
  });
  it('resetTotal / intakeChangeTotal 累加，缺字段按 0', () => {
    const sessions = [
      { id: 's1', counters: { resetCount: 2, intakeChanges: 1 } },
      { id: 's2', counters: { resetCount: 1 } },
      { id: 's3', counters: { resetCount: '坏值' } },
      { id: 's4' },
    ];
    const s = summarizeSessions(sessions, BATCH, Date.parse(T(28)));
    assertEquals(s.resetTotal, 3);
    assertEquals(s.intakeChangeTotal, 1);
    assertAllFinite(s, '计数累加');
  });
  it('放弃人数按 D5 逐个会话判', () => {
    const sessions = [
      { id: 's1', lastAt: T(1) },
      { id: 's2', lastAt: T(1), finishedAt: T(1) },
      { id: 's3', lastAt: T(26) },
    ];
    assertEquals(summarizeSessions(sessions, BATCH, Date.parse(T(27))).abandonCount, 1);
  });
  it('隔夜回来 = 相邻两段之间断了 6 小时以上（同一段里的停顿不算）', () => {
    const sessions = [
      { id: 's1', segments: [{ start: T(1), lastEventAt: T(2) }, { start: T(20), lastEventAt: T(21) }] },
      { id: 's2', segments: [{ start: T(1), lastEventAt: T(2) }, { start: T(4), lastEventAt: T(5) }] },
      { id: 's3', segments: [{ start: T(1), lastEventAt: T(1) }, { start: T(7) }] },
      { id: 's4' },
      { id: 's5', segments: [] },
    ];
    assertEquals(summarizeSessions(sessions, BATCH, Date.parse(T(28))).overnightReturns, 1);
  });
  it('segments 缺 lastEventAt 时按 start 算，坏时间不产生 NaN', () => {
    const sessions = [
      { id: 's1', segments: [{ start: T(1) }, { start: T(20) }] },
      { id: 's2', segments: [{ start: '不是时间' }, { start: T(20) }] },
    ];
    const s = summarizeSessions(sessions, BATCH, Date.parse(T(28)));
    assertEquals(s.overnightReturns, 1);
    assertAllFinite(s, '坏 segments');
  });
  it('坏会话（null、events 不是数组、progress 缺失）不让汇总出现 NaN', () => {
    const s = summarizeSessions(
      [null, { id: 's1', events: 'nope', segments: 'nope', progress: null, counters: { resetCount: 'x', intakeChanges: 'y' } }],
      BATCH,
      Date.parse(T(28)),
    );
    assertEquals(s.sessionCount, 1, 'null 不算一个会话');
    assertAllFinite(s, '坏会话');
  });
});
