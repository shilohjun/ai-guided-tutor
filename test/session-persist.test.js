/**
 * 会话写穿、冷启动回载与续做（Task 4）。
 *
 * ============================================================================
 * 为什么这一层必须单独有测试
 * ============================================================================
 * 到本任务为止，会话只活在进程内存里（router.js 的 `sessions` Map）：
 * serverless 冷启动、本地重启、换实例，学生那一段对话就没了 —— 而"没了"的表现
 * 不是报错，是**提示层级从 L0 重来**。学生看到的是"AI 忘了我做到哪一步"，
 * 而且这种情况几乎不会被当成 bug 报上来。
 *
 * 所以这里钉的不是"存进去了"，是三条会静默退化的性质：
 *   ① 落库的那一份**不带引擎**（引擎里有闭包，写不进去；强行写=整条会话写坏）；
 *   ② 回载之后**历史与提示记录都还在**（少了任一条，层级就归零）；
 *   ③ 报告快照**只冻结一次**（导出件不能随代码变化而变化，设计稿 §5.2）。
 *
 * 另外两条是本任务补的边界：
 *   · 照片/粘贴题活在内存注册表里（TTL 6 小时），重启之后 `getProblemById` 返回 null ——
 *     这种会话必须**说清楚"题目没了"，而不是假装还在**（设计稿 §5.5）。
 *   · 写库失败不能让学生的这一轮变成 500（丢一条记录 < 丢掉学生刚打完的一段话）；
 *     但**读库失败不许装作没事**（否则一个坏库看起来和一个好库一模一样）。
 */

import { describe, it, assertEquals, assert, assertIncludes } from './runner.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/server/store/index.js';
import { PERSIST_REFUSED, persistSession } from '../src/server/session-store.js';
import {
  handleApi,
  getStore,
  getSession,
  requestEnv,
  restoreSession,
  sessions,
  snapshotSession,
  __resetStoreForTests,
} from '../src/server/router.js';

/** 题库题：永久存在，题目与公式卡都有 */
const P1 = 'phy-emi-01';
/** 第二道题库题：用来复现"换个 problemId 就能绕过归属判定"那条路 */
const P2 = 'phy-emi-02';

const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
const iso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// 最小落库记录：只放"读回来要用"的字段，形状与 snapshotSession 的产物一致
// ---------------------------------------------------------------------------
function recordFor({ id, problemId = P1, userId = 'u1', batchId = 'b1', lastAt = iso(), turns = [], hintLog = [], extra = {} }) {
  const at = iso();
  return {
    id,
    problemId,
    userId,
    batchId,
    startedAt: at,
    lastAt,
    finishedAt: null,
    endState: 'in_progress',
    progress: { maxPage: 3, reached: { p2: at, p3: at }, backtracks: 0 },
    counters: { resetCount: 0, chatTurns: 0, hintLevels: [], formulaOpens: 0 },
    history: turns.slice(),
    record: { problemId, turns: turns.slice(), hintLog, formulaCards: [], startedAt: at },
    turns: turns.slice(),
    ...extra,
  };
}

/**
 * 起一个真 HTTP 服务，但把 STORE 指到临时目录。
 *
 * 为什么必须换目录：路由层用的是**进程级单例存储**，默认是 memory ——
 * 而"冷启动之后还在"这件事只有真的落了盘才成立。所以先 `__resetStoreForTests()`，
 * 用例结束时再重置一次，否则后面几个套件会读到这个临时目录里的数据。
 *
 * 为什么显式摘掉 LLM Key：开发者的 `.env` 里可能带着真 Key，
 * 那样这一组用例会打真模型 —— 又慢又不可复现，还会烧钱。
 */
async function withRouterServer(envPatch, fn) {
  const { createServer } = await import('node:http');
  const dir = mkdtempSync(join(tmpdir(), 'bsj-sp-http-'));
  const env = { ...process.env, STORE: 'file', STORE_DIR: dir };
  delete env.LLM_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.PILOT_REQUIRE_LOGIN;
  Object.assign(env, envPatch ?? {});

  __resetStoreForTests();
  const store = await requestEnv.run(env, () => getStore());

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const handled = await requestEnv.run(env, () => handleApi(req, res, url));
    if (!handled) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'not handled' }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, store, dir, env });
  } finally {
    await new Promise((r) => server.close(r));
    __resetStoreForTests();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 真实 HTTP 调用：返回 { status, json } */
async function call(base, path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/**
 * 聊一轮（与前端调用同一个接口）。
 * `explicitHelpSeeking` 固定为 true：自主训练模式在"看起来还在自己想"的时候会静默观察
 * （不产生 AI 轮次），而这一组用例需要的是"真有两轮对话"的那种会话。
 */
const chat = (base, { sessionId, problemId = P1, utterance = '我想用安培力，但是不知道力怎么求', headers = {} }) =>
  call(base, '/api/chat', {
    method: 'POST',
    body: { sessionId, problemId, utterance, mode: 'self_training', explicitHelpSeeking: true },
    headers,
  });

/** 发一个号并登录，拿到真令牌（登录守卫生效时用它） */
async function signIn(store, batchId = uid('batch')) {
  const { issueAccounts, login } = await import('../src/server/auth.js');
  const [account] = await issueAccounts(store, { batchId, count: 1 });
  const session = await login(store, account.code);
  assert(session?.token, '发号后应当能登录拿到令牌');
  return { token: session.token, user: session.user, batchId };
}

/** 把 console.warn 收进数组：用来证明"失败只记一条"而不是悄悄吞掉 */
async function captureWarn(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.warn = original;
  }
}

// ===========================================================================
// 1. 快照与落库（计划 Step 1 的三条最小证据）
// ===========================================================================

describe('会话 · 写穿与回载', () => {
  it('snapshotSession 不带 engine（引擎不可序列化）', () => {
    const snap = snapshotSession({ id: 's1', engine: {}, turns: [] });
    assertEquals(snap.engine, undefined, '快照里不得有 engine');
    assertEquals(snap.id, 's1');
  });

  it('会话落库后，内存清空也能读回（这是 G2 的最小证据）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsj-sp-'));
    const s = await openStore({ STORE: 'file', STORE_DIR: dir });
    await s.putSession({ id: 's1', userId: 'u1', batchId: 'b1', turns: [{ role: 'student', text: 'x', at: '2026-11-09T10:00:00.000Z' }] });
    const again = await openStore({ STORE: 'file', STORE_DIR: dir });
    const got = await again.getSession('s1');
    assertEquals(got.turns.length, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('两个用户各自只有自己的会话', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsj-sp2-'));
    const s = await openStore({ STORE: 'file', STORE_DIR: dir });
    await s.putSession({ id: 'a', userId: 'u1', batchId: 'b1', turns: [] });
    await s.putSession({ id: 'b', userId: 'u2', batchId: 'b1', turns: [] });
    const u1 = await s.listSessionsByUser('u1');
    assertEquals(u1.map((x) => x.id).join(','), 'a', 'u1 只能看到自己的会话');
    rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// 2. 快照的边界（C3）
// ===========================================================================

describe('会话 · 快照的边界', () => {
  it('活会话可以被快照：不深拷贝引擎里的闭包，也不抛', () => {
    /**
     * 这条钉的是**实现方式**：`structuredClone(session)` 会走一遍引擎对象，
     * 而引擎里挂着闭包与 Map —— 克隆直接抛 `DataCloneError`。
     * 所以快照必须是"显式字段投影 + 只把 engine 摘掉"。
     */
    sessions.delete('snap-live');
    const live = getSession('snap-live', P1);
    assert(typeof live.engine.handleTurn === 'function', '前提：活会话上挂着真引擎');

    const snap = snapshotSession(live);
    assertEquals(snap.engine, undefined, '快照里不得有引擎');
    assertEquals(snap.adapterTag, undefined, 'adapterTag 里带着 Key 指纹，不该落库、更不该进导出件');
    assertEquals(snap.problemId, P1, '其余字段原样带过来');
    assertEquals(typeof live.engine.handleTurn, 'function', '活会话的引擎不能被摘掉（快照不能改原对象）');

    /** 真落进 file 驱动会走 JSON.stringify：这里先验一次"写得出去" */
    const text = JSON.stringify(snap);
    assertIncludes(text, P1, '快照必须能序列化（否则 file 驱动整条写坏）');
  });

  it('落库的那一份与会话对象不共享分支（改了会话不会悄悄改库里的历史）', async () => {
    /**
     * 这条钉的是**快照本身**，不是驱动的序列化（评审的 Minor）：`history` / `record` /
     * `progress` 三个分支对象若与活会话共享引用，内存驱动的库会顺着引用看到内存里后来的修改。
     * 旧版本只用 file 驱动，而 file 靠 JSON 往返天然断开 —— 那样钉住的是驱动，不是快照。
     */
    const store = await openStore({ STORE: 'memory' });
    sessions.delete('snap-ref');
    const live = getSession('snap-ref', P1);
    live.history.push({ role: 'student', text: '第一句', at: iso() });
    live.record.turns.push({ role: 'student', text: '第一句', at: iso() });
    live.record.hintLog.push({ at: iso(), deliveredLevel: 1, stepIndex: 0 });

    const snap = snapshotSession(live);
    assertEquals(snap.history === live.history, false, 'history 必须是另一份');
    assertEquals(snap.record === live.record, false, 'record 必须是另一份');
    assertEquals(snap.record.hintLog === live.record.hintLog, false, 'record.hintLog 也要断开');
    assertEquals(snap.turns === live.record.turns, false, 'turns 也不能指向内存那一份');
    assertEquals(snap.progress === live.progress, false, 'progress 必须是另一份');
    assertEquals(snap.progress.reached === live.progress.reached, false, 'progress.reached 也要断开');

    await store.putSession(snap);
    live.history.push({ role: 'student', text: '第二句', at: iso() });
    live.record.hintLog.push({ at: iso(), deliveredLevel: 2, stepIndex: 0 });
    live.record.turns.push({ role: 'student', text: '第二句', at: iso() });
    live.progress.maxPage = 4;

    const stored = await store.getSession('snap-ref');
    assertEquals(stored.history.length, 1, '库里的 history 不能被内存里后来的修改带着走');
    assertEquals(stored.record.hintLog.length, 1, '库里的 hintLog 同理');
    assertEquals(stored.turns.length, 1, '库里的 turns 同理');
    assertEquals(stored.progress.maxPage, 3, '库里的 progress 同理');
  });
});

// ===========================================================================
// 3. 冷启动回载（C4）
// ===========================================================================

describe('会话 · 冷启动回载', () => {
  it('回载后历史与提示记录都在，恢复后的第一轮沿用原定位（层级不归零）', async () => {
    await withRouterServer({}, async ({ base, store, env }) => {
      const sessionId = uid('restore');
      const first = await chat(base, { sessionId, utterance: '我想用安培力，但是不知道力怎么求' });
      assertEquals(first.status, 200, '离线桩下聊天应 200');

      const stored = await store.getSession(sessionId);
      assert(stored, '一轮之后会话应当已经落库');
      assertEquals(stored.engine, undefined, '库里不得有引擎（写不进去）');
      const historyLength = stored.history.length;
      const hintLogLength = stored.record.hintLog.length;
      assert(hintLogLength > 0, '前提：库里应当有提示记录，否则"层级不归零"无从谈起');

      /** 冷启动：内存里什么都不剩（换实例、重启就是这个形状） */
      sessions.clear();

      /**
       * 回载与那一轮对话都必须跑在**这次请求的 env** 里 ——
       * 与 router 里真实发生的顺序一致。跑在外面的话 `envFor()` 会退回 process.env，
       * 而本机 `.env` 里带着真 Key：那就会打真模型（又慢、又要钱、还不可复现）。
       */
      const { back, next } = await requestEnv.run(env, async () => {
        const restored = await restoreSession(store, sessionId, P1);
        if (!restored) return { back: null, next: null };
        /**
         * 判据不能停在"字段都在"：只有**引擎真的用上了这段历史**才算没归零。
         * `carriedOver` 是定位阶段"本轮没新信息 ⇒ 沿用上一轮位置"的标记，
         * 空历史时它永远是 false —— 所以这条断言能抓住"历史传了但没进引擎"。
         */
        const turn = await restored.engine.handleTurn({
          problemId: P1,
          utterance: '还是不会',
          history: restored.history,
          mode: 'self_training',
          explicitHelpSeeking: true,
        });
        return { back: restored, next: turn };
      });

      assert(back, '库里有记录就应当回载得回来');
      assertEquals(back.history.length, historyLength, '对话历史必须原样回来');
      assertEquals(back.record.hintLog.length, hintLogLength, '提示记录必须原样回来');
      assert(typeof back.engine?.handleTurn === 'function', '必须重建引擎，否则只能看不能接着做');

      const locate = (next?.diagnosis.trace ?? []).find((t) => t.data && 'carriedOver' in t.data);
      assertEquals(locate?.data?.carriedOver, true, '恢复后的第一轮必须沿用历史里的定位');
      assert(
        next.hint.level >= stored.record.hintLog[0].deliveredLevel,
        `层级不得归零：上一轮 ${stored.record.hintLog[0].deliveredLevel}，这一轮 ${next.hint.level}`,
      );
    });
  });

  it('库里没有这条会话 → 回载返回 null（由调用方按"没有会话"作答，而不是现造一个空的）', async () => {
    await withRouterServer({}, async ({ store }) => {
      sessions.clear();
      assertEquals(await restoreSession(store, uid('ghost'), P1), null);
    });
  });

  it('题目已不在注册表（照片/粘贴题过期）→ 不假装，且说清是哪一步没了', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const sessionId = uid('imported');
      const goneId = 'imported-deadbeef00'; // 照片/粘贴题的 id 形如 imported-<内容哈希>
      await store.putSession(recordFor({ id: sessionId, problemId: goneId }));

      const noSnap = await call(base, `/api/report?sessionId=${sessionId}`);
      assertEquals(noSnap.status, 200, '旧会话即使缺题目快照，也保留有边界的过程报告');
      assertEquals(noSnap.json.report.meta.problemContextMissing, true);
      assertEquals(noSnap.json.report.assessment.accuracy.percent, null);

      /** 换一个入口问同一件事：聊天必须说清"重新导入"，而不是 500 或者凭空开始 */
      const chatAfterSweep = await call(base, '/api/chat', {
        method: 'POST',
        body: { sessionId, problemId: goneId, utterance: '还是不会', mode: 'self_training', explicitHelpSeeking: true },
      });
      assertEquals(chatAfterSweep.status, 404, '题目不在注册表时聊天应 404，而不是崩在回载里');
      assertIncludes(String(chatAfterSweep.json?.error ?? ''), '重试题目读取', '要给出可操作的下一步且不要求重做');

      /** 已经冻结过快照的：照发那一份（导出件不能因为注册表回收就变样） */
      await store.putSession(
        recordFor({
          id: `${sessionId}-snap`,
          problemId: goneId,
          extra: { reportSnapshot: { problemId: goneId, level: '待巩固' }, reportBuiltAt: iso(), finishedAt: iso(), endState: 'finished' },
        }),
      );
      const withSnap = await call(base, `/api/report?sessionId=${sessionId}-snap`);
      assertEquals(withSnap.status, 200, '有快照就该照发，哪怕题目已经回收');
      assertEquals(withSnap.json?.report?.level, '待巩固');
    });
  });

  it('读库失败 ≠ 没有这条会话：/api/report 回 503 可重试，不是 404 让学生重新开始', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const sessionId = uid('broken');
      await store.putSession(recordFor({ id: sessionId }));
      sessions.clear();

      const original = store.getSession;
      store.getSession = async () => {
        throw new Error('磁盘坏了（故障注入）');
      };
      try {
        const { result, lines } = await captureWarn(() => call(base, `/api/report?sessionId=${sessionId}`));
        assertEquals(result.status, 503, '读不出来是可重试的故障，不是"会话不存在"');
        assertEquals(result.json?.retryable, true, '要明确告诉前端这一下可以重试');
        assertIncludes(String(result.json?.error ?? ''), '读取学习记录失败', '文案说的是"读不出来"，不是"请重新开始"');
        assert(lines.some((l) => l.includes('读取会话失败')), `读库失败必须留一条 warn，实际：${JSON.stringify(lines)}`);
      } finally {
        store.getSession = original;
      }

      /** 真的没有这条记录时仍然是 404 —— 这两种情况的答法必须分得开 */
      const ghost = await call(base, `/api/report?sessionId=${uid('ghost')}`);
      assertEquals(ghost.status, 404, '库里确实没有这条时才是 404（此处不钉文案，只钉状态码）');
    });
  });
});

// ===========================================================================
// 4. 写穿（C6）
// ===========================================================================

describe('会话 · 写穿时机', () => {
  it('一轮对话之后真的落库，且落库的那份带 turns / 进度 / 时间戳', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const sessionId = uid('wir');
      const res = await chat(base, { sessionId });
      assertEquals(res.status, 200, '离线桩下聊天应 200');

      const stored = await store.getSession(sessionId);
      assert(stored, '/api/chat 之后必须已经落库');
      assertEquals(stored.id, sessionId);
      assertEquals(stored.problemId, P1);
      assertEquals(stored.endState, 'in_progress');
      assertEquals(stored.engine, undefined, '引擎不得落库');
      assertEquals(stored.record.hintLog.length, 1, '提示记录要跟着落库（报告与导出都靠它）');
      assertEquals(stored.turns.length, 2, '一轮问答两条：学生一条、老师一条');
      assertEquals(stored.progress.maxPage, 3, '第 3 页才创建会话，进度应当是 3');
      assert(/^\d{4}-\d{2}-\d{2}T/.test(stored.lastAt), 'lastAt 由服务端盖（客户端时钟不可信）');
      assertEquals(stored.counters.chatTurns, 1);
    });
  });

  it('写库失败不影响这一轮：200 照常返回，只记一条 warn（丢记录 < 丢学生刚打的话）', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const sessionId = uid('wifail');
      const original = store.putSession;
      store.putSession = async () => {
        throw new Error('磁盘满了（故障注入）');
      };
      try {
        const { result, lines } = await captureWarn(() => chat(base, { sessionId }));
        assertEquals(result.status, 200, '写库失败不得让学生的这一轮变成 500');
        assert(String(result.json?.hint?.text ?? '').length > 0, '提示照常返回');
        assert(lines.some((l) => l.includes('写入失败')), `写库失败必须留一条 warn，实际：${JSON.stringify(lines)}`);
        assertEquals(await store.getSession(sessionId), null, '前提确认：这次确实没写进去');
      } finally {
        store.putSession = original;
      }
    });
  });

  it('读库失败时 /api/chat 回 503，不现造新会话、不写穿（否则一条空会话盖掉真记录）', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const me = await signIn(store);
      const sessionId = uid('readfail');
      await chat(base, { sessionId, headers: { 'x-test-token': me.token } });
      await chat(base, { sessionId, headers: { 'x-test-token': me.token }, utterance: '还是不会' });
      const before = structuredClone(await store.getSession(sessionId));
      assert(before.turns.length >= 2 && before.record.hintLog.length > 0, '前提：库里已经有一段对话');

      /** 冷启动：内存里没有它，这一次只能靠读库 */
      sessions.clear();

      const originalGet = store.getSession;
      const originalPut = store.putSession;
      let puts = 0;
      store.getSession = async () => {
        throw new Error('云调用超时（故障注入）');
      };
      store.putSession = async (snap) => {
        puts += 1;
        return originalPut(snap);
      };
      try {
        const { result, lines } = await captureWarn(() =>
          chat(base, { sessionId, headers: { 'x-test-token': me.token }, utterance: '还是不会' }),
        );
        assertEquals(result.status, 503, `读不出来要回 503，实际 ${result.status} ${JSON.stringify(result.json)}`);
        assertEquals(result.json?.retryable, true, '读失败是可重试的');
        assertEquals(puts, 0, '读不出来就不许写穿 —— 写下去的是刚现造的那条空会话');
        assert(lines.some((l) => l.includes('读取会话失败')), `要留一条 warn，实际：${JSON.stringify(lines)}`);
        assertEquals(sessions.has(sessionId), false, '读失败也不许把新会话塞进内存表');
      } finally {
        store.getSession = originalGet;
        store.putSession = originalPut;
      }

      const after = await store.getSession(sessionId);
      assertEquals(
        JSON.stringify(after),
        JSON.stringify(before),
        '库里的记录必须一个字段都没变（对话 / 提示记录 / 快照都在）',
      );
    });
  });

  it('公式卡用过之后也写穿（否则重启后"用过卡"这件事消失）', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const sessionId = uid('formula');
      const at = iso();
      await store.putSession(
        recordFor({
          id: sessionId,
          hintLog: [{ at, deliveredLevel: 3, stepIndex: 1, graphId: 'phy-emi-01-g1', form: 'direction' }],
        }),
      );
      sessions.clear();

      const res = await call(base, '/api/formula', { method: 'POST', body: { sessionId } });
      assertEquals(res.status, 200, '同一步给过 L3 之后应能取到公式卡');
      assert(res.json?.card?.formula, '应返回一张公式卡');

      const stored = await store.getSession(sessionId);
      assertEquals(stored.record.formulaCards.length, 1, '用过公式卡必须落库');
      assertEquals(stored.counters.formulaOpens, 1, '计数也要落库');
    });
  });

  it('/api/reset 之后库里被清空，但会话本身还在（resetCount +1，endState 不变）', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const sessionId = uid('reset');
      await chat(base, { sessionId });
      const before = await store.getSession(sessionId);
      assertEquals(before.turns.length, 2);
      const finishedAtBefore = before.finishedAt;

      const res = await call(base, '/api/reset', { method: 'POST', body: { sessionId } });
      assertEquals(res.status, 200);
      assertEquals(sessions.has(sessionId), false, '内存里的会话照旧被删掉（老行为）');

      const after = await store.getSession(sessionId);
      assert(after, '重置也要写穿：会话本身仍在库里（否则"重来"这件事没人算得清）');
      assertEquals(after.turns.length, 0, '对话要被清空');
      assertEquals(after.record.hintLog.length, 0, '提示记录跟着一起清');
      assertEquals(after.counters.resetCount, 1, '重来次数要记下来（设计稿 §5.4 的"重来"要用它）');
      assertEquals(after.endState, before.endState, 'endState 不变');
      assertEquals(after.finishedAt, finishedAtBefore, 'finishedAt 不变');
      assertEquals(after.progress.maxPage, before.progress.maxPage, '走到第几页是事实，不能因为重来就改小');
    });
  });

  it('写穿绝不覆盖别人名下的记录：库里属于别人就不写，返回 PERSIST_REFUSED（纵深防御）', async () => {
    await withRouterServer({}, async ({ store }) => {
      const sessionId = uid('foreign');
      const before = recordFor({
        id: sessionId,
        userId: 'b-owner',
        turns: [{ role: 'student', text: 'B 的话', at: iso() }],
      });
      await store.putSession(before);
      const snapshot = structuredClone(await store.getSession(sessionId));

      /**
       * 模拟"某条新路径拿到一个 userId 为空的会话对象"——正是要拦的形状：
       * 它没有归属，写下去就会把 B 的记录整条盖成 A 的一条空会话。
       */
      sessions.delete(sessionId);
      const live = getSession(sessionId, P1);
      assertEquals(live.userId, null, '前提：这条活会话没有归属');

      const { result, lines } = await captureWarn(() =>
        persistSession(store, live, { chatTurn: true, owner: { user: { id: 'a-owner' }, batchId: 'b1' } }),
      );
      assertEquals(result, PERSIST_REFUSED, '写穿必须被拒绝，而不是覆盖别人的记录');
      assertEquals(result.code, 'NOT_OWNER');
      assert(lines.some((l) => l.includes('拒绝写穿')), `拒绝要留一条 warn，实际：${JSON.stringify(lines)}`);

      const after = await store.getSession(sessionId);
      assertEquals(JSON.stringify(after), JSON.stringify(snapshot), '库里那条属于 B 的记录必须原封不动');
    });
  });

  it('登录之后第一轮把归属补上：userId / batchId 来自令牌，续做才找得到', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const me = await signIn(store);
      const sessionId = uid('owned');
      const res = await chat(base, { sessionId, headers: { 'x-test-token': me.token } });
      assertEquals(res.status, 200);

      const stored = await store.getSession(sessionId);
      assertEquals(stored.userId, me.user.id, 'userId 必须落到会话上');
      assertEquals(stored.batchId, me.batchId, 'batchId 跟着令牌里的当前批次');
    });
  });
});

// ===========================================================================
// 5. 续做（C2）
// ===========================================================================

describe('会话 · 续做接口', () => {
  it('没有登录态 → 401，绝不退化成"返回所有人的最近一条"', async () => {
    await withRouterServer({}, async ({ base }) => {
      const res = await call(base, '/api/session/resume');
      assertEquals(res.status, 401);
      assertEquals(res.json?.error, '请先登录');
      assertEquals(res.json?.session, undefined, '401 时不得带出任何会话数据');
    });
  });

  it('带 token → 返回自己的未完成会话，形状与设计稿一致（page 取 maxPage）', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const me = await signIn(store);
      const sessionId = uid('resume');
      await chat(base, { sessionId, headers: { 'x-test-token': me.token } });

      const res = await call(base, '/api/session/resume', { headers: { 'x-test-token': me.token } });
      assertEquals(res.status, 200);
      const s = res.json?.session;
      assert(s, '自己的未完成会话应当能续做');
      assertEquals(s.id, sessionId);
      assertEquals(s.problemId, P1);
      assertEquals(s.page, 3, 'page 取 progress.maxPage');
      assertEquals(s.turnCount, 2, '一轮问答两条记录');
      assertEquals(s.questionIndex, null, '题号要靠批次 questionIds（尚无任务填它）');
      assertEquals(s.idleMinutes, 0, '刚聊完就是 0 分钟');
    });
  });

  it('?userId= 一律忽略：拿别人的 id 也只会拿到自己的那条', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const me = await signIn(store);
      const other = await signIn(store);
      const mine = uid('mine');
      await chat(base, { sessionId: mine, headers: { 'x-test-token': me.token } });
      /** 别人的会话直接写库（模拟他已经聊过） */
      await store.putSession(recordFor({ id: uid('other'), userId: other.user.id, batchId: other.batchId }));

      const res = await call(base, `/api/session/resume?userId=${encodeURIComponent(other.user.id)}`, {
        headers: { 'x-test-token': me.token },
      });
      assertEquals(res.status, 200);
      assertEquals(res.json?.session?.id, mine, '身份只能来自令牌；查询参数可伪造，必须忽略');
    });
  });

  it('已经出过报告的会话不再出现在续做里（finishedAt 是唯一的门槛）', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const me = await signIn(store);
      const sessionId = uid('done');
      await chat(base, { sessionId, headers: { 'x-test-token': me.token } });
      const before = await call(base, '/api/session/resume', { headers: { 'x-test-token': me.token } });
      assertEquals(before.json?.session?.id, sessionId, '前提：出报告之前它应当能被续做');

      const report = await call(base, `/api/report?sessionId=${sessionId}`);
      assertEquals(report.status, 200);
      const stored = await store.getSession(sessionId);
      assertEquals(stored.endState, 'finished', '到报告页就是完成');
      assert(stored.finishedAt, 'finishedAt 必须落库（续做与放弃判定都读它）');

      const after = await call(base, '/api/session/resume', { headers: { 'x-test-token': me.token } });
      assertEquals(after.status, 200);
      assertEquals(after.json?.session, null, '完成了就不该再劝他"继续刚才那道题"');
    });
  });

  it('有多条未完成会话时取最近一条；隔多久都还回来（不看时间差）', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const me = await signIn(store);
      const old = uid('old');
      const recent = uid('recent');
      /** 三天前那条：只要没有 finishedAt，就必须还能续做（设计稿 §5.5） */
      await store.putSession(recordFor({ id: old, userId: me.user.id, batchId: me.batchId, lastAt: '2026-11-06T10:00:00.000Z' }));
      await store.putSession(recordFor({ id: recent, userId: me.user.id, batchId: me.batchId, lastAt: '2026-11-09T10:00:00.000Z' }));

      const res = await call(base, '/api/session/resume', { headers: { 'x-test-token': me.token } });
      assertEquals(res.json?.session?.id, recent, '最近一条优先');

      /** 把最近那条删掉，三天前那条仍然要回来 —— 不能因为"太久"就当作没有 */
      await store.putSession({ ...recordFor({ id: recent, userId: me.user.id, batchId: me.batchId }), finishedAt: iso(), endState: 'finished' });
      const res2 = await call(base, '/api/session/resume', { headers: { 'x-test-token': me.token } });
      assertEquals(res2.json?.session?.id, old, '隔三天也照样给（阈值不许自己制造结论）');
      assert(res2.json.session.idleMinutes > 60, 'idleMinutes 要如实报出隔了多久');
    });
  });
});

// ===========================================================================
// 6. 报告快照只冻结一次（C5）
// ===========================================================================

describe('会话 · 报告快照', () => {
  it('同一对话版本报告保持不变；追加新轮次后更新报告并保留旧版本', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const sessionId = uid('freeze');
      await chat(base, { sessionId });

      const first = await call(base, `/api/report?sessionId=${sessionId}`);
      assertEquals(first.status, 200);
      const firstText = JSON.stringify(first.json.report);
      assert(firstText.length > 50, '前提：报告不该是空的');
      const same=await call(base, `/api/report?sessionId=${sessionId}`);
      assertEquals(JSON.stringify(same.json.report),firstText,'没有新证据时不重算');

      /** 中间再聊一轮：如果快照被重算，这里就会带上新的一轮 */
      await chat(base, { sessionId, utterance: '然后呢' });

      const second = await call(base, `/api/report?sessionId=${sessionId}`);
      assertEquals(second.status, 200);
      assert(JSON.stringify(second.json.report)!==firstText, '新学习轮次不能被旧报告遮住');

      const stored = await store.getSession(sessionId);
      assertEquals(JSON.stringify(stored.reportSnapshot), JSON.stringify(second.json.report));
      assertEquals(JSON.stringify(stored.reportHistory[0].reportSnapshot),firstText,'旧报告原样留档');
      assert(stored.reportBuiltAt, 'reportBuiltAt 要记下来，否则没人知道这份快照是哪一刻的');
    });
  });

  it('重置前先把这份快照压进 reportHistory，再清实时快照（C11）', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const sessionId = uid('archive');
      await chat(base, { sessionId });
      const shown = await call(base, `/api/report?sessionId=${sessionId}`);
      assertEquals(shown.status, 200);
      const shownText = JSON.stringify(shown.json.report);

      const reset = await call(base, '/api/reset', { method: 'POST', body: { sessionId } });
      assertEquals(reset.status, 200);

      const stored = await store.getSession(sessionId);
      assertEquals(stored.reportSnapshot, null, '重置后实时快照必须清掉（学生不该在新对话上看到上一轮的结论）');
      assertEquals(stored.reportBuiltAt, null);
      assert(Array.isArray(stored.reportHistory), 'reportHistory 必须是数组（导出与看板读它）');
      assertEquals(stored.reportHistory.length, 1, '重置过几次就压几条，不清空也只压这一次');
      const entry = stored.reportHistory[0];
      assertEquals(JSON.stringify(entry.reportSnapshot), shownText, '历史里留的必须是学生重置前看到的那一份');
      assertEquals(entry.reason, 'reset');
      assert(entry.reportBuiltAt, '报告是哪一刻生成的也要留住，否则历史条目没法排序');
      assert(Date.parse(entry.archivedAt), 'archivedAt 必须是服务端时间戳（客户端时钟不可信）');
    });
  });

  it('再出一份报告再重置 → history 只追加，不改写已经有那条', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const sessionId = uid('archive2');
      await chat(base, { sessionId });
      const first = await call(base, `/api/report?sessionId=${sessionId}`);
      const firstText = JSON.stringify(first.json.report);
      await call(base, '/api/reset', { method: 'POST', body: { sessionId } });

      /** 重来之后又聊出一份新报告，再重置一次 */
      await chat(base, { sessionId });
      const second = await call(base, `/api/report?sessionId=${sessionId}`);
      assertEquals(second.status, 200);
      await call(base, '/api/reset', { method: 'POST', body: { sessionId } });

      const stored = await store.getSession(sessionId);
      assert(Array.isArray(stored.reportHistory), 'reportHistory 必须是数组');
      assertEquals(stored.reportHistory.length, 2, '每重置一次追加一条');
      assertEquals(
        JSON.stringify(stored.reportHistory[0].reportSnapshot),
        firstText,
        '先压进去的那一份不许被后来的重置改写（C5 的"冻结一次不覆盖"对历史同样成立）',
      );
    });
  });
});

// ===========================================================================
// 7. 登录守卫（C1）
// ===========================================================================

describe('登录守卫 · PILOT_REQUIRE_LOGIN', () => {
  it('没配这个变量时行为不变：/api/chat 照旧可达', async () => {
    await withRouterServer({}, async ({ base }) => {
      const res = await chat(base, { sessionId: uid('noguard') });
      assertEquals(res.status, 200, '不配守卫时一个字节都不该变');
    });
  });

  it('配了且没带令牌 → 401 AUTH_REQUIRED；健康检查与登录接口不拦', async () => {
    await withRouterServer({ PILOT_REQUIRE_LOGIN: '1' }, async ({ base, store }) => {
      const blocked = await chat(base, { sessionId: uid('blocked') });
      assertEquals(blocked.status, 401);
      assertEquals(blocked.json?.error, '请先登录');
      assertEquals(blocked.json?.code, 'AUTH_REQUIRED');

      const health = await call(base, '/api/health');
      assertEquals(health.status, 200, '健康检查必须永远可达（否则监控全红）');

      /** 登录接口自己判断对错：这里要的是"没被守卫拦在前面" */
      const { issueAccounts } = await import('../src/server/auth.js');
      const [account] = await issueAccounts(store, { batchId: uid('batch'), count: 1 });
      const login = await call(base, '/api/auth/login', { method: 'POST', body: { code: account.code } });
      assertEquals(login.status, 200, `登录接口不得被守卫拦下，实际 ${login.status} ${JSON.stringify(login.json)}`);
      assert(login.json?.token, '应返回令牌');
    });
  });

  it('配了且带对令牌 → 不被 401 拦（可以因为别的理由 400/404，但不是 401）', async () => {
    await withRouterServer({ PILOT_REQUIRE_LOGIN: '1' }, async ({ base, store }) => {
      const me = await signIn(store);
      const ok = await chat(base, { sessionId: uid('allowed'), headers: { 'x-test-token': me.token } });
      assertEquals(ok.status, 200, '带了有效令牌就该放行');

      const resume = await call(base, '/api/session/resume', { headers: { 'x-test-token': me.token } });
      assertEquals(resume.status, 200, '续做接口在守卫下也应放行');
    });
  });

  it('令牌是假的 → 按未登录处理（401），不是 500', async () => {
    await withRouterServer({ PILOT_REQUIRE_LOGIN: '1' }, async ({ base }) => {
      const res = await chat(base, { sessionId: uid('badtoken'), headers: { 'x-test-token': 'not-a-real-token' } });
      assertEquals(res.status, 401);
      assertEquals(res.json?.code, 'AUTH_REQUIRED');
    });
  });
});

// ===========================================================================
// 8. 归属校验（C10）：别人的 sessionId 不能拿来读报告 / 领公式卡 / 续聊
// ===========================================================================

describe('归属校验 · 会话只能由本人使用', () => {
  it('A 的令牌 + B 的 sessionId → 三条路由一律 403 NOT_OWNER', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const a = await signIn(store);
      const b = await signIn(store);
      const bSession = uid('b-session');
      const bOk = await chat(base, { sessionId: bSession, headers: { 'x-test-token': b.token } });
      assertEquals(bOk.status, 200, '前提：B 自己的会话是好的');

      /**
       * 三条一起拦。只拦一条等于没拦 —— sessionId 是前端生成的
       * （`'ui-' + Date.now().toString(36)`），可猜；猜中就能把别人的对话与报告读走。
       */
      const asChat = await chat(base, { sessionId: bSession, headers: { 'x-test-token': a.token } });
      assertEquals(asChat.status, 403, `chat 必须拦，实际 ${asChat.status} ${JSON.stringify(asChat.json)}`);

      const asReport = await call(base, `/api/report?sessionId=${bSession}`, { headers: { 'x-test-token': a.token } });
      assertEquals(asReport.status, 403, `report 必须拦，实际 ${asReport.status} ${JSON.stringify(asReport.json)}`);
      assertEquals(asReport.json?.report, undefined, '403 不得带出任何报告内容');

      const asFormula = await call(base, '/api/formula', {
        method: 'POST',
        body: { sessionId: bSession },
        headers: { 'x-test-token': a.token },
      });
      assertEquals(asFormula.status, 403, `formula 必须拦，实际 ${asFormula.status} ${JSON.stringify(asFormula.json)}`);

      for (const [label, res] of [['chat', asChat], ['report', asReport], ['formula', asFormula]]) {
        assertEquals(res.json?.code, 'NOT_OWNER', `${label} 的错误码要是 NOT_OWNER`);
        assertEquals(res.json?.error, '这不是你的学习记录', `${label} 要给一句人话`);
      }
    });
  });

  it('A 的令牌 + A 自己的 sessionId → 三条路由都照常，不是 403', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const a = await signIn(store);
      const sessionId = uid('a-session');

      const asChat = await chat(base, { sessionId, headers: { 'x-test-token': a.token } });
      assertEquals(asChat.status, 200, '自己的会话当然能聊');

      const asReport = await call(base, `/api/report?sessionId=${sessionId}`, { headers: { 'x-test-token': a.token } });
      assertEquals(asReport.status, 200, `自己的报告当然能读，实际 ${asReport.status} ${JSON.stringify(asReport.json)}`);
      assert(asReport.json?.report, '报告内容要在');

      /**
       * 公式卡这时多半还没到 L3（409 是它的正常门禁），本条要钉的是"不是 403"：
       * 归属校验管的是"这是不是你的"，不管"你有没有资格用这张卡"。
       */
      const asFormula = await call(base, '/api/formula', {
        method: 'POST',
        body: { sessionId },
        headers: { 'x-test-token': a.token },
      });
      assert(
        asFormula.status !== 403,
        `自己的会话不该被归属校验拦下，实际 ${asFormula.status} ${JSON.stringify(asFormula.json)}`,
      );
    });
  });

  it('没有登录态时保持现状：不带令牌照旧读得到（不放宽也不收紧）', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const b = await signIn(store);
      const bSession = uid('anon-read');
      await chat(base, { sessionId: bSession, headers: { 'x-test-token': b.token } });

      /** 没配守卫、也没带令牌 ⇒ 没有"身份"，也就没有"归属"这回事 */
      const report = await call(base, `/api/report?sessionId=${bSession}`);
      assertEquals(report.status, 200, '未登录时的行为必须与加校验之前一模一样');
      assert(report.json?.report, '照旧返回报告');
    });
  });

  it('A 的令牌 + B 的 sessionId + 换一道题 → 403，B 的记录（对话 / 提示 / 快照）一个字节都没变', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const a = await signIn(store);
      const b = await signIn(store);
      const bSession = uid('b-owned');

      /** 让 B 的记录里三样东西都有：对话、提示记录、冻结的报告快照 */
      await chat(base, { sessionId: bSession, headers: { 'x-test-token': b.token } });
      await chat(base, { sessionId: bSession, headers: { 'x-test-token': b.token }, utterance: '还是不会' });
      const report = await call(base, `/api/report?sessionId=${bSession}`, { headers: { 'x-test-token': b.token } });
      assertEquals(report.status, 200, '前提：B 自己能出报告');
      const before = structuredClone(await store.getSession(bSession));
      assert(before.reportSnapshot, '前提：库里已经有冻结的快照');
      assert(before.record.hintLog.length > 0 && before.history.length > 0, '前提：历史与提示记录都在');

      /** 冷启动：内存里什么都没有，只能读库 —— 与换实例之后一模一样 */
      sessions.clear();

      /**
       * 这是评审 Important 1 的形状：换了题，旧实现里 restoreSession 会因为 `problemId`
       * 对不上而回 null，调用方于是 `getSession(...)` 现造一条 `userId: null` 的新会话，
       * notMine 对空归属放行 ⇒ 200 + 写穿 ⇒ B 的记录被整条盖掉。
       */
      const asChat = await chat(base, { sessionId: bSession, problemId: P2, headers: { 'x-test-token': a.token } });
      assertEquals(asChat.status, 403, `chat 必须拦，实际 ${asChat.status} ${JSON.stringify(asChat.json)}`);
      assertEquals(asChat.json?.code, 'NOT_OWNER');
      assertEquals(asChat.json?.error, '这不是你的学习记录');
      assertEquals(asChat.json?.hint, undefined, '403 不得带出任何提示内容');

      const after = await store.getSession(bSession);
      assertEquals(JSON.stringify(after), JSON.stringify(before), 'B 的记录必须一个字段都没变');
      assertEquals(after.userId, b.user.id, '归属不能被 A 覆盖成自己');
      assertEquals(after.reportSnapshot?.level, before.reportSnapshot?.level, '冻结的报告快照还在');
      assertEquals(after.record.hintLog.length, before.record.hintLog.length, '提示记录还在');
      assertEquals(after.history.length, before.history.length, '历史还在');
    });
  });

  it('A 的令牌 + B 的 sessionId → /api/reset 也 403，B 的记录一条都不清（热内存与冷启动两条路）', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const a = await signIn(store);
      const b = await signIn(store);
      const bSession = uid('b-reset');
      await chat(base, { sessionId: bSession, headers: { 'x-test-token': b.token } });
      const before = structuredClone(await store.getSession(bSession));
      assert(before.turns.length > 0, '前提：B 的会话里有对话');

      /** ① B 的会话还在内存表里：重置会先命中它 */
      const hot = await call(base, '/api/reset', {
        method: 'POST',
        body: { sessionId: bSession },
        headers: { 'x-test-token': a.token },
      });
      assertEquals(hot.status, 403, `reset 必须拦，实际 ${hot.status} ${JSON.stringify(hot.json)}`);
      assertEquals(hot.json?.code, 'NOT_OWNER');
      assertEquals(sessions.has(bSession), true, '403 之后内存里那条也不许被删');

      /** ② 冷启动（内存里没有）：只能读库，同样要拦 */
      sessions.clear();
      const cold = await call(base, '/api/reset', {
        method: 'POST',
        body: { sessionId: bSession },
        headers: { 'x-test-token': a.token },
      });
      assertEquals(cold.status, 403, `冷启动也要拦，实际 ${cold.status} ${JSON.stringify(cold.json)}`);
      assertEquals(cold.json?.code, 'NOT_OWNER');

      const after = await store.getSession(bSession);
      assertEquals(JSON.stringify(after), JSON.stringify(before), '重置没发生：对话 / 提示记录 / 计数都没变');
      assertEquals(after.counters.resetCount, before.counters.resetCount, 'resetCount 不该被加一');
      assertEquals(after.turns.length, before.turns.length, '对话一条都不许清');
    });
  });
});

// ===========================================================================
// 9. 访问记录（C8）
// ===========================================================================

describe('访问记录 · POST /api/visit', () => {
  it('没有登录态 → 401', async () => {
    await withRouterServer({}, async ({ base }) => {
      const res = await call(base, '/api/visit', { method: 'POST', body: {} });
      assertEquals(res.status, 401);
      assertEquals(res.json?.error, '请先登录');
    });
  });

  it('带 token → 生成 v- 开头的 visitId 并落库；同一个人打开两次就是两次 visit（不去重）', async () => {
    await withRouterServer({}, async ({ base, store }) => {
      const me = await signIn(store);
      const first = await call(base, '/api/visit', { method: 'POST', body: {}, headers: { 'x-test-token': me.token } });
      const second = await call(base, '/api/visit', { method: 'POST', body: {}, headers: { 'x-test-token': me.token } });
      assertEquals(first.status, 200);
      assert(/^v-[0-9a-z]+/.test(String(first.json?.visitId)), `visitId 形状应为 v-<时间戳36进制><随机>，实际 ${first.json?.visitId}`);
      assert(first.json.visitId !== second.json.visitId, '"一次打开"就是一次 visit，不做去重');

      const stored = await store.getVisit(first.json.visitId);
      assertEquals(stored.userId, me.user.id);
      assertEquals(stored.batchId, me.batchId);
      assertEquals(stored.sessionIds.length, 0, '刚落地的 visit 还没有会话');
      assert(Date.parse(stored.openedAt) && Date.parse(stored.lastAt), 'openedAt / lastAt 都要有');
    });
  });
});

// ===========================================================================
// 10. 存储单例的测试钩子（C7）
// ===========================================================================

describe('存储单例 · 可以被测试重置', () => {
  it('__resetStoreForTests 之后，换 STORE_DIR 能拿到新的那一份', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'bsj-sp-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'bsj-sp-b-'));
    __resetStoreForTests();
    try {
      const a = await requestEnv.run({ ...process.env, STORE: 'file', STORE_DIR: dirA }, () => getStore());
      await a.putSession({ id: 'only-in-a', userId: 'u1', batchId: 'b1', turns: [] });

      __resetStoreForTests();
      const b = await requestEnv.run({ ...process.env, STORE: 'file', STORE_DIR: dirB }, () => getStore());
      assert(a !== b, '换了目录必须拿到新 store（否则测试之间会互相污染）');
      assertEquals(await b.getSession('only-in-a'), null, 'B 目录里不该有 A 写的记录');

      __resetStoreForTests();
      const aAgain = await requestEnv.run({ ...process.env, STORE: 'file', STORE_DIR: dirA }, () => getStore());
      assertEquals((await aAgain.getSession('only-in-a'))?.id, 'only-in-a', '回到 A 目录应当又读得到');
    } finally {
      __resetStoreForTests();
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
