/**
 * 一轮 `/api/chat` 的超时口径 —— 由**我们自己**返回 TURN_SLOW，并留下一条 chat_error。
 *
 * ============================================================================
 * 为什么这一条必须起真服务来验
 * ============================================================================
 * "云函数被网关第 30 秒砍掉"这个场景在进程里**复现不了**：那时函数里的代码一行都不跑。
 * 所以这里验的不是网关，而是**网关之前的那一公里**：
 *
 *   TURN_DEADLINE_MS 一到 → 我们的代码自己认出"没时间了" → 503 TURN_SLOW
 *                        → 并且已经写下了 chat_error
 *
 * 两者缺一不可。少了 503，学生看到的是一个转圈到死的页面；
 * 少了 chat_error，"有 chat_send 无 chat_reply 的一轮"在指标上**不存在** ——
 * 而那个失败率正是换平台的触发条件（brief L3 的那一段）。
 *
 * 另外三条同源的要求：
 *   ① 预算是我们自己的：截止时间已经过去时，**一次模型调用都不许发**。
 *      这条用计数桩证明（伪上游被命中 0 次），不是靠"看起来没调"。
 *   ② 客户端不发 `chat_error`（L4）。客户端只发它算得出来的那九种，
 *      `chat_error` 的 `code`/`status` 只有服务端知道；客户端也发一份的话，
 *      一次失败会被记成两条，失败率就翻倍了。
 *   ③ 不设 `TURN_DEADLINE_MS` 时一切照旧（默认 22 秒预算不改变正常一轮的行为）。
 */

import { describe, it, assert, assertEquals, assertIncludes, assertNotIncludes } from './runner.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { ROOT } from '../src/core/env.js';
import { handleApi, getStore, requestEnv, __resetStoreForTests } from '../src/server/router.js';
import { summarizeSessions } from '../src/server/metrics.js';

const SID = 'turn-1';
const PROBLEM = 'phy-emi-01';
const UTTERANCE = '我想用安培力，但是我不知道力的大小怎么求，只知道有安培力';

/** 学生端能看到的超时话术 —— 只有这一句，前端只负责照抄显示 */
const TURN_SLOW_TEXT = '这一轮没等到回复，再发一次就好。';

/**
 * 假模型服务：只数命中次数。
 *
 * 存在的唯一理由：确认"预算是我们自己的"这句话是真的。
 * 它故意回 500 —— 万一哪天预算逻辑漏了、调用真的发出去了，
 * 这条用例会先因为 hits>0 失败，而不是悄悄变成一次真的模型调用。
 */
async function withCountingLlm(fn) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: '这个假模型不该被调用' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, hits: () => hits.length });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** 起一台真服务，配置按请求注入（与 pilot-ui / admin-api 同一套） */
async function withTurnServer(envPatch, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bsj-chat-turn-'));
  const env = { ...process.env, STORE: 'file', STORE_DIR: dir };
  for (const key of [
    'LLM_API_KEY',
    'OPENAI_API_KEY',
    'LLM_BASE_URL',
    'LLM_MODEL',
    'PILOT_REQUIRE_LOGIN',
    'PILOT_DEV_CODE',
    'ADMIN_CODE',
    'TURN_DEADLINE_MS',
  ]) {
    delete env[key];
  }
  Object.assign(env, envPatch);
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];

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
    return await fn({ base, store, env });
  } finally {
    await new Promise((r) => server.close(r));
    __resetStoreForTests();
    rmSync(dir, { recursive: true, force: true });
  }
}

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

/** 客户端那一半：真客户端的 `chat_send` 在请求发出前就落库（这里照做） */
const sendChatSend = (base, sid = SID) =>
  call(base, '/api/events', {
    method: 'POST',
    body: { events: [{ type: 'chat_send', sessionId: sid, payload: { len: 12, copiedStem: false } }] },
  });

const chat = (base, body) => call(base, '/api/chat', { method: 'POST', body });

describe('一轮对话 · 超时由我们自己返回并留下 chat_error', () => {
  it('TURN_DEADLINE_MS=1：503 TURN_SLOW + 一条 chat_error，且模型一次都没被调用', async () => {
    await withCountingLlm(async (llm) => {
      await withTurnServer(
        {
          TURN_DEADLINE_MS: '1',
          /** 配一副假凭据：一旦预算没拦住，请求就会打到上面那台计数桩上 */
          LLM_API_KEY: 'test-key-not-real',
          LLM_BASE_URL: `${llm.base}/v1`,
          LLM_MODEL: 'test-model',
        },
        async ({ base, store }) => {
          const sent = await sendChatSend(base);
          assertEquals(sent.json?.accepted, 1, '客户端那条 chat_send 要先落库');

          const res = await chat(base, { sessionId: SID, problemId: PROBLEM, utterance: UTTERANCE });

          assertEquals(res.status, 503, `没等到回复时必须是 503：${JSON.stringify(res.json)}`);
          assertEquals(res.json.code, 'TURN_SLOW', '前端靠这个码把话说到位（L6）');
          assertEquals(res.json.retryable, true);
          assertEquals(res.json.error, TURN_SLOW_TEXT, '话术只有一句，前端只负责显示');

          assertEquals(llm.hits(), 0, '截止时间已经过去 —— 一次模型调用都不许发出去');

          /**
           * 事件表：一条 send、一条 error、**没有 reply**。
           * `error` 那一行是**唯一**能说出"这一轮是我们超时了"的地方 ——
           * 没有它，同一份数据只能被读成"学生自己关了页面"，看不出是我们的问题，
           * 也就没有任何理由去换平台。
           */
          const events = await store.listEventsBySession(SID);
          assertEquals(
            events.map((e) => e.type).join(','),
            'chat_send,chat_error',
            `事件表应当正好是 send + error，实际：${events.map((e) => e.type).join(',')}`,
          );
          const error = events[1];
          assertEquals(error.payload.code, 'TURN_SLOW');
          assertEquals(error.payload.status, 503);
          assertEquals(
            Object.keys(error.payload).sort().join(','),
            'code,status',
            'payload 形状钉死为 { code, status }：多一个字段以后就没人能解释它是什么',
          );
        },
      );
    });
  });

  it('上游报错（不是超时）→ chat_error 用 UPSTREAM，而不是 TURN_SLOW', async () => {
    /**
     * 两个码必须分开：TURN_SLOW 是"我们没时间了"（想办法提速），
     * UPSTREAM 是"对方坏了"（等一会儿再试）。混成一个，看板上就分不出该修哪里。
     */
    await withCountingLlm(async (llm) => {
      await withTurnServer(
        { LLM_API_KEY: 'test-key-not-real', LLM_BASE_URL: `${llm.base}/v1`, LLM_MODEL: 'test-model' },
        async ({ base, store }) => {
          const res = await chat(base, { sessionId: SID, problemId: PROBLEM, utterance: UTTERANCE });

          assertEquals(res.status, 503);
          assertEquals(res.json.code, undefined, '上游坏的 503 不带 TURN_SLOW —— 学生看到的是另一句话');
          assertEquals(llm.hits(), 1, '这一次模型确实被调用了');

          const events = await store.listEventsBySession(SID);
          assertEquals(events.length, 1);
          assertEquals(events[0].type, 'chat_error');
          assertEquals(events[0].payload.code, 'UPSTREAM');
          assertEquals(events[0].payload.status, 503);
        },
      );
    });
  });

  it('不设 TURN_DEADLINE_MS：默认预算下这一轮照常 200，只有 chat_reply', async () => {
    /** 反面：加截止时间不许把正常的一轮也弄坏（没配 LLM Key，走离线桩，秒回） */
    await withTurnServer({}, async ({ base, store }) => {
      const res = await chat(base, { sessionId: SID, problemId: PROBLEM, utterance: UTTERANCE });

      assertEquals(res.status, 200, `正常一轮必须照旧：${JSON.stringify(res.json)}`);
      assert(typeof res.json.message === 'string' && res.json.message.length > 0, '学生必须拿到那句话');

      const events = await store.listEventsBySession(SID);
      assertEquals(events.map((e) => e.type).join(','), 'chat_reply');
      assertEquals(events[0].payload.engine, 'offline-stub');
    });
  });
});

describe('一轮对话 · chat_error 只由服务端发', () => {
  it('试点壳里没有任何一处发 chat_error（只在界面层给一句提示）', () => {
    const html = readFileSync(join(ROOT, 'public/pilot.html'), 'utf8');
    assertNotIncludes(html, "send('chat_error'", '客户端不许发 chat_error：一次失败会被记成两条，失败率翻倍');
    assertNotIncludes(html, "type: 'chat_error'");
    /** 提示本身要有（L6：不加按钮，只在壳上显示一句） */
    assertIncludes(html, TURN_SLOW_TEXT, '壳上要显示同一句话');
  });

  it('服务端只在 /api/chat 里写 chat_error（别处不许顺手发一条）', () => {
    const src = readFileSync(join(ROOT, 'src/server/router.js'), 'utf8');
    const occurrences = src.split("type: 'chat_error'").length - 1;
    assertEquals(occurrences, 1, `chat_error 的写入点必须收敛在一处（实际 ${occurrences} 处）`);
    /** 只有 TURN_SLOW 与 UPSTREAM 两个码（brief L3 的第二句） */
    assertIncludes(src, "'TURN_SLOW'");
    assertIncludes(src, "'UPSTREAM'");
  });
});

// ---------------------------------------------------------------------------
// 四、那个数现在真的会动
// ---------------------------------------------------------------------------

describe('一轮对话 · 一轮失败率（换平台的触发条件）真的会动', () => {
  /**
   * 这几条是整条任务链的**终点**：`metrics.js` 早就会把
   * "出现 chat_error 且 code ∈ {TURN_SLOW, UPSTREAM}" 的一轮算成失败，
   * 只是一直没有人写那条事件，于是这个数只可能反映"学生没等到就关了页面"，
   * 反映不了"我们自己超时了"。
   *
   * 这里不重算指标，直接调看板用的那个函数 —— 断言的是**看板上那个数**。
   *
   * 关键设计（否则这条用例是空的）：超时之后再补一条 `chat_reply`
   * （同一次 send 之内，模拟学生按提示又发了一次、这一次成功回来）。
   * 没有 `chat_error` 时，这一轮是"send + reply" ⇒ 失败率 0；
   * 有了它才是 1。也就是说：**这个断言只可能因为 chat_error 而成立。**
   */
  const summarize = (sid, events) =>
    summarizeSessions([{ id: sid, problemId: PROBLEM, events }], {}, Date.now());

  const replyEvent = (sid) => ({
    type: 'chat_reply',
    sessionId: sid,
    payload: { ms: 120, level: 1, stuckKind: 'precondition_unchecked', suppressed: false, engine: 'offline-stub' },
  });

  it('超时的一轮即使后来补上了回复，仍然算失败（从 0 变成 1）', async () => {
    const SID_RATE = 'rate-slow';
    await withCountingLlm(async (llm) => {
      await withTurnServer(
        {
          TURN_DEADLINE_MS: '1',
          LLM_API_KEY: 'test-key-not-real',
          LLM_BASE_URL: `${llm.base}/v1`,
          LLM_MODEL: 'test-model',
        },
        async ({ base, store }) => {
          await sendChatSend(base, SID_RATE);
          const res = await chat(base, { sessionId: SID_RATE, problemId: PROBLEM, utterance: UTTERANCE });
          assertEquals(res.status, 503);

          /** 学生按提示又发了一次，这一次回来了 —— 但那条 send 已经记在同一个轮里 */
          await call(base, '/api/events', { method: 'POST', body: { events: [replyEvent(SID_RATE)] } });

          const events = await store.listEventsBySession(SID_RATE);
          assertEquals(
            events.map((e) => e.type).join(','),
            'chat_send,chat_error,chat_reply',
            '顺序即事实：超时发生在回复之前',
          );
          assertEquals(summarize(SID_RATE, events).turnFailureRate, 1, '这一轮失败过：失败率必须是 1');
        },
      );
    });
  });

  it('正常的一轮不算失败（同一个口径下是 0）', async () => {
    const SID_RATE = 'rate-ok';
    await withTurnServer({}, async ({ base, store }) => {
      await sendChatSend(base, SID_RATE);
      const res = await chat(base, { sessionId: SID_RATE, problemId: PROBLEM, utterance: UTTERANCE });
      assertEquals(res.status, 200);

      const summary = summarize(SID_RATE, await store.listEventsBySession(SID_RATE));
      assertEquals(summary.turnFailureRate, 0, '收到了回复的一轮不该被算成失败');
    });
  });
});
