/**
 * 跨驱动等价性测试。
 *
 * ============================================================================
 * 为什么必须有这个文件
 * ============================================================================
 * 已提交的存储测试只覆盖了端口 21 个成员里的 9 个，而且**默认驱动（memory）
 * 与落盘驱动（file）从来没有被同一段脚本跑过两遍对比过**。
 * 于是"两个驱动行为一致"这句话没有自动证据，只有我的信心 ——
 * 而信心在这次评审里已经被证伪过一次：同一个事件，file 按 `sessionId || visitId`
 * 归档、`listEventsBySession(visitId)` 能取到；memory 只认 `sessionId`，
 * 传 visitId 返回空数组。同一份前端数据，换一个驱动就少一半事件。
 *
 * 所以这里用表驱动的方式跑**同一段脚本**：左边 memory，右边 file，
 * 断言每个观察点的返回值**逐字段相同**（把 `seq` 也纳入比较，
 * 因为它就是排序的依据 —— 不比它，顺序一致这件事等于没验）。
 *
 * ---------------------------------------------------------------------------
 * 为什么脚本直接调 appendEvent，而不是调 recordEvent
 * ---------------------------------------------------------------------------
 * `recordEvent` 会给 `at` 盖服务端时间。两次运行（memory 一遍、file 一遍）
 * 必然差几毫秒，那样"逐字段相同"就只能靠把 `at` 挖掉才成立 —— 而挖掉字段
 * 的对比会漏掉"两个驱动对 at 的处理不同"这类真实分歧。
 * 所以脚本用端口原语：`seq` 自己用 `incrCounter('seq:event', 1)` 取
 * （与 recordEvent 的做法完全相同），`at` 全部显式给死。
 * 这样两条记录的每个字段都可比，而且验的正是端口本身。
 *
 * 本文件覆盖 B5 点名的全部成员：
 *   appendEvent / listEventsBySession（含"传 visitId"）/ listEventsByBatch /
 *   incrCounter / getCounter
 */

import { describe, it, assertEquals, assert } from './runner.js';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/server/store/index.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'bsj-store-eq-'));
}

/**
 * 递归按 key 排序后序列化。
 *
 * 为什么不能直接 `JSON.stringify`：两个驱动产生对象的**字段顺序**不保证相同
 * （file 是 JSON.parse 出来的，memory 是 structuredClone）——
 * 而"逐字段相同"说的是值相同，不是 key 的先后相同。
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

const show = (value) => JSON.stringify(canonical(value), null, 2);

/**
 * 同一段脚本。**改动这里必须同时能让两个驱动跑通** —— 它就是"契约"本身。
 *
 * 脚本刻意安排了三组会让驱动分叉的形状：
 *   ① 只带 visitId 的事件（第 1 页：拍照、选课，那时还没有 session）；
 *   ② 同时带 sessionId 与 visitId 的事件（归属必须收敛到 sessionId）；
 *   ③ batchId 与会话/访问对不上的事件（事件自带 batchId，不回查）；
 * 以及一组"同一毫秒"的事件（10:00:00.000 有三条）—— 只有 `seq` 能让顺序确定。
 */
async function runScript(store) {
  await store.putSession({ id: 's1', userId: 'u1', batchId: 'b1', startedAt: '2026-11-09T09:00:00.000Z' });
  await store.putSession({ id: 's2', userId: 'u2', batchId: 'b2', startedAt: '2026-11-09T09:10:00.000Z' });
  await store.putVisit({ id: 'v1', userId: 'u1', batchId: 'b1' });

  const nextSeq = () => store.incrCounter('seq:event', 1);

  /** ①③ 只带 visitId，且 batchId 指向一个没有任何会话/访问的批次 */
  await store.appendEvent({
    type: 'visit_open',
    at: '2026-11-09T10:00:00.000Z',
    userId: 'u1',
    visitId: 'v1',
    batchId: 'b1',
    payload: { referrer: 'qr' },
    seq: await nextSeq(),
  });
  /** 与上一条同一毫秒，归属不同：顺序只能由 seq 决定 */
  await store.appendEvent({
    type: 'page_enter',
    at: '2026-11-09T10:00:00.000Z',
    userId: 'u1',
    sessionId: 's1',
    batchId: 'b1',
    payload: { page: 2 },
    seq: await nextSeq(),
  });
  await store.appendEvent({
    type: 'page_enter',
    at: '2026-11-09T10:00:00.000Z',
    userId: 'u1',
    visitId: 'v1',
    batchId: 'b1',
    payload: { page: 3 },
    seq: await nextSeq(),
  });
  await store.appendEvent({
    type: 'chat_send',
    at: '2026-11-09T10:00:01.000Z',
    userId: 'u2',
    sessionId: 's2',
    batchId: 'b2',
    payload: { len: 12, copiedStem: false },
    seq: await nextSeq(),
  });
  /** ③ 归属的会话在库里根本不存在：batchId 只能来自事件自己，回查就会丢 */
  await store.appendEvent({
    type: 'chat_error',
    at: '2026-11-09T10:00:00.000Z',
    userId: 'u2',
    sessionId: 'ghost-session',
    batchId: 'b2',
    payload: { code: 'UPSTREAM', status: 502 },
    seq: await nextSeq(),
  });
  /** ③' 同上，反方向：批次 b9 里没有这个 visit */
  await store.appendEvent({
    type: 'ocr_call',
    at: '2026-11-09T10:00:02.000Z',
    userId: 'u1',
    visitId: 'v1',
    batchId: 'b9',
    payload: { bytes: 850 },
    seq: await nextSeq(),
  });
  /**
   * ② 同时带两个归属键，且**不带 seq**（模拟直接调 appendEvent 的调用点）：
   * 归属必须收敛到 sessionId（否则同一条事件会在两份数据里各出现一次），
   * 而没有 seq 的老数据必须排在有序号的之后，不能反过来把顺序搅乱。
   */
  await store.appendEvent({
    type: 'login',
    at: '2026-11-09T10:00:03.000Z',
    userId: 'u1',
    sessionId: 's1',
    visitId: 'v1',
    batchId: 'b1',
    payload: { displayName: 'S01' },
  });

  /** 计数器：键里带冒号，顺带压一压 file 驱动的文件名转义 */
  const counter = {};
  counter.incr1 = await store.incrCounter('ocr:daily:2026-11-09', 1);
  counter.incr2 = await store.incrCounter('ocr:daily:2026-11-09', 2);
  counter.value = await store.getCounter('ocr:daily:2026-11-09');
  counter.missing = await store.getCounter('不存在的键');
  counter.seq = await store.getCounter('seq:event');

  return {
    counter,
    bySessionS1: await store.listEventsBySession('s1'),
    /** B1：参数是归属键，不是"只认 session"——传 visitId 必须能取到事件 */
    bySessionV1: await store.listEventsBySession('v1'),
    bySessionGhost: await store.listEventsBySession('ghost-session'),
    bySessionMissing: await store.listEventsBySession('nope'),
    bySessionEmpty: await store.listEventsBySession(''),
    byBatchB1: await store.listEventsByBatch('b1'),
    byBatchB2: await store.listEventsByBatch('b2'),
    byBatchB9: await store.listEventsByBatch('b9'),
    byBatchMissing: await store.listEventsByBatch('nope'),
  };
}

/** 每个观察点一个用例，失败时能直接指出是哪一段分叉了 */
const OBSERVATIONS = [
  ['listEventsBySession(sessionId)', (r) => r.bySessionS1],
  ['listEventsBySession(visitId)', (r) => r.bySessionV1],
  ['listEventsBySession(归属的会话不存在)', (r) => r.bySessionGhost],
  ['listEventsBySession(没有的归属)', (r) => r.bySessionMissing],
  ['listEventsBySession(空参数)', (r) => r.bySessionEmpty],
  ['listEventsByBatch(b1)', (r) => r.byBatchB1],
  ['listEventsByBatch(b2)', (r) => r.byBatchB2],
  ['listEventsByBatch(b9)', (r) => r.byBatchB9],
  ['listEventsByBatch(没有的批次)', (r) => r.byBatchMissing],
  ['incrCounter / getCounter', (r) => r.counter],
];

/**
 * 同一个脚本分别跑在两个驱动上，返回两边的观察结果。
 * 临时目录交给调用方删（它才知道用例什么时候结束）。
 */
async function runBothDrivers() {
  const memory = await openStore({});
  const dir = tmp();
  const file = await openStore({ STORE: 'file', STORE_DIR: dir });
  try {
    const left = await runScript(memory);
    const right = await runScript(file);
    return { dir, left, right };
  } finally {
    await memory.close();
    await file.close();
  }
}

describe('存储 · 跨驱动等价性（memory vs file）', () => {
  it('确实是两个不同的驱动（不是一个驱动跑了两遍）', async () => {
    const memory = await openStore({});
    const dir = tmp();
    const file = await openStore({ STORE: 'file', STORE_DIR: dir });
    try {
      assertEquals(memory.kind, 'memory');
      assertEquals(file.kind, 'file');
      await runScript(file);
      // 落盘证据：真的出现了 events/*.jsonl 与 counter/*.json，而不是"两个内存驱动"
      assert(existsSync(join(dir, 'events')), 'file 驱动应当已经建出 events/ 目录');
      assert(
        readdirSync(join(dir, 'events')).some((name) => name.endsWith('.jsonl')),
        'file 驱动应当按归属写了 .jsonl 事件文件',
      );
      assert(existsSync(join(dir, 'counter')), 'file 驱动应当已经建出 counter/ 目录');
    } finally {
      await memory.close();
      await file.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同一段脚本在两个驱动上逐字段相同（表驱动，逐个观察点比对）', async () => {
    const { dir, left, right } = await runBothDrivers();
    try {
      const failures = [];
      for (const [label, pick] of OBSERVATIONS) {
        if (show(pick(left)) !== show(pick(right))) {
          failures.push(`▸ ${label}\n  memory:\n${show(pick(left))}\n  file:\n${show(pick(right))}`);
        }
      }
      assert(failures.length === 0, `${failures.length} 个观察点在两个驱动之间不一致：\n${failures.join('\n')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('传 visitId 也能取到那个 visit 的事件（B1 的分叉已消掉）', async () => {
    const { dir, left, right } = await runBothDrivers();
    try {
      for (const [name, result] of [['memory', left], ['file', right]]) {
        assertEquals(result.bySessionV1.length, 3, `${name}: visitId v1 应该有 3 条事件`);
        assertEquals(
          result.bySessionV1.map((e) => e.type).join(','),
          'visit_open,page_enter,ocr_call',
          `${name}: 1 号事件按 seq 排在最前，且同时带两个归属键的 login 不得混进 visit 的视图`,
        );
        assertEquals(result.bySessionV1.map((e) => e.seq).join(','), '1,3,6', `${name}: 顺序必须按 seq`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('名单按事件自带的 batchId 过滤，不回查会话/访问（B2）', async () => {
    const { dir, left, right } = await runBothDrivers();
    try {
      for (const [name, result] of [['memory', left], ['file', right]]) {
        assertEquals(
          result.byBatchB1.map((e) => e.type).join(','),
          'visit_open,page_enter,page_enter,login',
          `${name}: b1 应当按 seq 升序，没有 seq 的那条排在最后`,
        );
        assertEquals(
          result.byBatchB2.map((e) => e.type).join(','),
          'chat_send,chat_error',
          `${name}: 会话在库里不存在的 chat_error 也必须按事件自带的 batchId 归到 b2`,
        );
        assertEquals(
          result.byBatchB9.map((e) => e.type).join(','),
          'ocr_call',
          `${name}: 批次里没有这个 visit，也不影响它按事件自带的 batchId 归到 b9`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('seq 由计数器发号：两个驱动的序号与计数器读数一致', async () => {
    const { dir, left, right } = await runBothDrivers();
    try {
      for (const [name, result] of [['memory', left], ['file', right]]) {
        assertEquals(result.counter.seq, 6, `${name}: 写了 6 条带序号的事件`);
        assertEquals(result.counter.value, 3, `${name}: 计数器 1 + 2 = 3`);
        const seqs = result.byBatchB1.map((e) => e.seq).filter((s) => typeof s === 'number');
        assertEquals(seqs.join(','), '1,2,3', `${name}: seq 必须单调递增且落库`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
