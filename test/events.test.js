/**
 * 事件层：字典、校验、落库。
 *
 * ============================================================================
 * 为什么这一层的测试值得写这么细
 * ============================================================================
 * 漏斗、看板、导出三个功能都只读事件表 —— 它们自己不做任何清洗。
 * 也就是说，**一条脏事件会一路流到给校长看的那张表里**，而那里没有任何东西
 * 会报错。所以校验必须发生在写入口，而且拒绝理由要能被计数：
 * "这周有多少条埋点被丢了"是我们要能回答的问题，否则埋点坏了没人会知道。
 *
 * 四个拒绝理由的顺序被钉死，原因见 `validateEvent`：一条事件可能同时犯多个错，
 * 先报哪一个决定了前端拿到的是哪一句可操作的话。
 */

import { describe, it, assertEquals, assert } from './runner.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/server/store/index.js';
import { EVENT_TYPES, validateEvent, recordEvent } from '../src/server/events.js';

describe('事件 · 字典', () => {
  it('正好 13 种，且包含 chat_send 与 resume 之外的全部设计项', () => {
    assertEquals(EVENT_TYPES.length, 13, '事件种类必须被钉在 13');
    for (const t of ['chat_send', 'chat_reply', 'chat_error', 'page_enter', 'ocr_call']) {
      assert(EVENT_TYPES.includes(t), `缺事件 ${t}`);
    }
  });
  it('13 种与设计稿 §5.3 的表格逐条一致（数量对不等于内容对）', () => {
    /**
     * 只断言"有 13 个"挡不住"拿掉一个、换上一个"—— 那不是笔误，是语义变了，
     * 而下游（漏斗、看板、导出）会静默地少一整列。所以把整张表钉在这里。
     */
    assertEquals(
      EVENT_TYPES.join(','),
      'login,visit_open,batch_open,page_enter,page_exit,intake_choose,ocr_call,ocr_result,import_result,chat_send,chat_reply,chat_error,session_reset',
      '事件字典必须与设计稿 §5.3 逐条一致（顺序也照抄，便于人工对表）',
    );
  });
  it('同时犯多个错时，按 unknown_type → missing_at → payload_too_big → missing_owner 的顺序报', () => {
    /**
     * 顺序是契约：一条埋点可能同时犯几个错，先报哪一个决定了调用方拿到哪句
     * 可操作的话（是"换个 type"，还是"把请求发完整再试"）。
     */
    // ① 类型不认识压过一切
    assertEquals(validateEvent({}).reason, 'unknown_type');
    assertEquals(validateEvent({ type: 'nope', payload: { s: 'x'.repeat(3000) } }).reason, 'unknown_type');
    // ② 有类型、没时间：先报时间，而不是先报体积或缺归属
    assertEquals(validateEvent({ type: 'page_enter', payload: { s: 'x'.repeat(3000) } }).reason, 'missing_at');
    // ③ 时间有了、体积超标、还没有归属：先报体积
    assertEquals(
      validateEvent({ type: 'page_enter', at: '2026-11-09T10:00:00.000Z', payload: { s: 'x'.repeat(3000) } }).reason,
      'payload_too_big',
    );
  });
  it('未知 type 被拒，且原因可读', () => {
    assertEquals(validateEvent({ type: 'click_anything', at: '2026-11-09T10:00:00.000Z', userId: 'u1' }).reason, 'unknown_type');
  });
  it('没有 at 的事件被拒（时间必须服务端盖）', () => {
    assertEquals(validateEvent({ type: 'page_enter', userId: 'u1' }).reason, 'missing_at');
  });
  it('payload 超过 2KB 被拒', () => {
    const big = { type: 'page_enter', at: '2026-11-09T10:00:00.000Z', userId: 'u1', payload: { s: 'x'.repeat(3000) } };
    assertEquals(validateEvent(big).reason, 'payload_too_big');
  });
  it('既没有 sessionId 也没有 visitId 的事件被拒（第 1 页用的是 visitId）', () => {
    assertEquals(validateEvent({ type: 'visit_open', at: '2026-11-09T10:00:00.000Z', userId: 'u1' }).reason, 'missing_owner');
  });
  it('只带 visitId 的事件合法（拍照与选课都发生在第 1 页，那时还没有 session）', () => {
    assert(validateEvent({ type: 'ocr_call', at: '2026-11-09T10:00:00.000Z', userId: 'u1', visitId: 'v1' }).ok);
  });
  it('login 是唯一允许没有归属的事件（设计稿 §5.3“挂在哪”是 —）', () => {
    assert(
      validateEvent({ type: 'login', at: '2026-11-09T10:00:00.000Z' }).ok,
      '登录发生在任何 visit/session 之前，不带归属也必须合法',
    );
    /**
     * 例外只有一个：其余 12 种照旧必须有归属。
     * 一条挂不上人的事件落库后没有任何查询能解释它 —— 那正是 missing_owner 要拦的。
     */
    for (const type of EVENT_TYPES.filter((t) => t !== 'login')) {
      assertEquals(
        validateEvent({ type, at: '2026-11-09T10:00:00.000Z' }).reason,
        'missing_owner',
        `${type} 没有归属必须被拒`,
      );
    }
    /** 未知 type 且没有归属时仍先报 unknown_type：豁免只放宽归属这一条，不动检查顺序 */
    assertEquals(
      validateEvent({ type: 'click_anything' }).reason,
      'unknown_type',
      '未知 type 应当先报类型，而不是缺归属',
    );
  });
});

describe('事件 · 落库', () => {
  it('写入后可按 session 取回', async () => {
    const s = await openStore({ STORE: 'file', STORE_DIR: mkdtempSync(join(tmpdir(), 'bsj-ev-')) });
    await recordEvent(s, { type: 'chat_send', at: '2026-11-09T10:00:00.000Z', userId: 'u1', sessionId: 's1' });
    const list = await s.listEventsBySession('s1');
    assertEquals(list.length, 1);
  });
  it('at 由服务端盖：客户端带的时间一律被丢掉（客户端时钟不可信）', async () => {
    const s = await openStore({});
    const before = Date.now();
    await recordEvent(s, { type: 'page_enter', at: '2020-01-01T00:00:00.000Z', userId: 'u1', sessionId: 's-at' });
    const [stored] = await s.listEventsBySession('s-at');
    assert(stored.at !== '2020-01-01T00:00:00.000Z', '客户端传的 at 不得被采纳');
    const at = Date.parse(stored.at);
    assert(Number.isFinite(at) && at >= before - 2000, `at 应是这次调用的服务端时间，实际 ${stored.at}`);
  });
  it('无归属的 login 两个驱动都收得下，且只能按 batchId 查到（B7 的豁免要真的进得了库）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsj-ev-login-'));
    const drivers = [
      ['memory', await openStore({})],
      ['file', await openStore({ STORE: 'file', STORE_DIR: dir })],
    ];
    try {
      for (const [name, s] of drivers) {
        await recordEvent(s, {
          type: 'login',
          at: '2026-11-09T10:00:00.000Z',
          userId: 'u-login',
          batchId: 'b-login',
          payload: { displayName: 'S01' },
        });
        assertEquals(
          (await s.listEventsByBatch('b-login')).map((e) => e.type).join(','),
          'login',
          `${name}: 无归属的 login 只能按 batchId 找到`,
        );
        assertEquals((await s.listEventsBySession('u-login')).length, 0, `${name}: 它不属于任何会话/访问`);
        /**
         * 存储层也守住同一个例外：别的 type 没有归属仍然写不进去。
         * 校验之外再拦一道，是因为 appendEvent 是端口原语，脚本可以绕过 validateEvent 直接调。
         */
        let threw = false;
        try {
          await s.appendEvent({ type: 'page_enter', at: '2026-11-09T10:00:00.000Z' });
        } catch {
          threw = true;
        }
        assert(threw, `${name}: 除 login 外，无归属事件在存储层也必须被拒`);
      }
    } finally {
      for (const [, s] of drivers) await s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 真实 HTTP：POST /api/events
// ---------------------------------------------------------------------------

/**
 * 为什么这几条必须走真服务而不是直接调 validateEvent/recordEvent：
 *
 * 这一层唯一的硬承诺是 **"埋点坏了不能影响主流程"** —— 半截 JSON、超大 body、
 * 存储写失败，全都只能以 `200 { accepted, rejected }` 收场。
 * 而"不 5xx"是**路由层**的性质：core 层全绿也说明不了它，
 * 一条忘了 catch 的 await 就会把一个坏埋点变成学生页面上的"内部错误"。
 */
describe('事件 · 上报接口（真实 HTTP）', () => {
  /** 每个用例用自己的 id：路由层用的是进程级单例存储，别的用例的数据也躺在里面 */
  const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

  async function withServer(fn) {
    const { createServer } = await import('node:http');
    const { handleApi } = await import('../src/server/router.js');
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const handled = await handleApi(req, res, url);
      if (!handled) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'not handled' }));
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      return await fn(base);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  /** 路由层用的存储单例 —— 断言要看的就是它真正写进去的那一份 */
  async function routeStore() {
    const { getStore } = await import('../src/server/router.js');
    return getStore();
  }

  const post = (base, body, headers = {}) =>
    fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  /**
   * 两个计数要断言到**值**，不是"是数字"。
   * 只断言类型的话，整个分支消失（比如非对象条目的计数）也照样绿 ——
   * 而这正是评审点名的那条（`rejected` 是对外的唯一故障信号，它错了没人能发现）。
   */
  function assertCounts(json, accepted, rejected) {
    assertEquals(json.accepted, accepted, `accepted 应为 ${accepted}`);
    assertEquals(json.rejected, rejected, `rejected 应为 ${rejected}`);
  }

  it('正常一批：逐条校验，合法的写入、不合法的只跳过那一条', async () => {
    await withServer(async (base) => {
      const sessionId = uid('sess');
      const visitId = uid('visit');
      const res = await post(base, {
        events: [
          { type: 'page_enter', at: '2026-11-09T10:00:00.000Z', sessionId, payload: { page: 2 } },
          /** 类型不认识 → 只丢这一条 */
          { type: 'click_anything', at: '2026-11-09T10:00:00.000Z', sessionId },
          /** 第 1 页：只有 visitId，没有 session（B1 的形状） */
          { type: 'ocr_call', at: '2026-11-09T10:00:00.000Z', visitId, payload: { bytes: 850 } },
        ],
      });
      assertEquals(res.status, 200, '埋点接口不该因为一条坏事件返回非 200');
      const json = await res.json();
      assertEquals(json.accepted, 2, '两条合法事件都要写进去');
      assertEquals(json.rejected, 1, '被跳过的那条要计数，否则埋点坏了没人知道');

      const store = await routeStore();
      assertEquals((await store.listEventsBySession(sessionId)).length, 1);
      assertEquals(
        (await store.listEventsBySession(visitId)).map((e) => e.type).join(','),
        'ocr_call',
        '只带 visitId 的事件必须按归属键取得到（两个驱动同一规则）',
      );
    });
  });

  it('请求体不是 JSON → 200 {accepted:0, rejected:0}（半截请求不得影响主流程）', async () => {
    await withServer(async (base) => {
      const res = await post(base, '这不是 JSON');
      assertEquals(res.status, 200, '学生端断网发出的半截请求不能变成 4xx/5xx');
      const json = await res.json();
      assertEquals(json.accepted, 0);
      assertEquals(json.rejected, 0, '一条都解析不出来时没有"被拒绝的事件"可计数');
    });
  });

  it('events 不是数组 / 缺字段 → 200，不 5xx，且计数精确', async () => {
    await withServer(async (base) => {
      /**
       * 第三组是**非对象条目**那条分支（`null` / 数字 / 字符串 / 数组混在数组里，
       * 前端拼接出错时就是这样）：它们连 `validateEvent` 的入参都不该是，
       * 必须逐条计入 rejected。只断言"是数字"的话，这条分支整个删掉测试也不会红 ——
       * 所以把 4 这个数钉在这里。
       */
      const cases = [
        [{ events: 'nope' }, 0, 0],
        [{}, 0, 0],
        [{ events: [null, 42, 'x', []] }, 0, 4],
      ];
      for (const [body, accepted, rejected] of cases) {
        const res = await post(base, body);
        assertEquals(res.status, 200, `body=${JSON.stringify(body)} 不该 5xx`);
        assertCounts(await res.json(), accepted, rejected);
      }
    });
  });

  it('payload 超过 2KB 的那条被拒，同一批里的其它条照收', async () => {
    await withServer(async (base) => {
      const sessionId = uid('sess');
      const before = (await (await routeStore()).listEventsBySession(sessionId)).length;
      const res = await post(base, {
        events: [
          { type: 'page_enter', at: '2026-11-09T10:00:00.000Z', sessionId, payload: { s: 'x'.repeat(3000) } },
          { type: 'page_exit', at: '2026-11-09T10:00:00.000Z', sessionId, payload: { page: 2, via: 'next' } },
        ],
      });
      const json = await res.json();
      assertEquals(json.accepted, 1);
      assertEquals(json.rejected, 1);
      const stored = await (await routeStore()).listEventsBySession(sessionId);
      assertEquals(stored.length - before, 1, '超标的 payload 不得落库');
    });
  });

  it('超过 1MB 的请求体 → 200，而不是 413/500（埋点不许把主流程带下水）', async () => {
    await withServer(async (base) => {
      /**
       * 走的是 `readJson` 的体积上限（1MB，只有 /api/ocr 放宽到 2.6MB）。
       * 断言的是**学生能拿到响应**，而不是连接被重置 —— 见 router.js 里
       * destroy/pause 两个坑的说明：埋点接口尤其不能在这里掐 socket，
       * 因为前端会把它当成"网络不好"而无限重试。
       */
      const res = await post(base, {
        events: [{ type: 'page_enter', at: '2026-11-09T10:00:00.000Z', sessionId: uid('sess'), payload: { s: 'x'.repeat(1_100_000) } }],
      });
      assertEquals(res.status, 200);
      const json = await res.json();
      assertEquals(json.accepted, 0);
    });
  });

  it('带 token 时：userId 与 batchId 由服务端从令牌填，body 里的同名字段不可信', async () => {
    await withServer(async (base) => {
      const { issueAccounts, login } = await import('../src/server/auth.js');
      const store = await routeStore();
      const batchId = uid('batch');
      const [{ code }] = await issueAccounts(store, { batchId, count: 1 });
      const session = await login(store, code);
      assert(session?.token, '发号后应当能登录拿到令牌');

      const sessionId = uid('sess');
      const res = await post(
        base,
        {
          userId: 'spoofed-user',
          batchId: 'spoofed-batch',
          events: [
            {
              type: 'page_enter',
              at: '2020-01-01T00:00:00.000Z',
              userId: 'spoofed-user',
              batchId: 'spoofed-batch',
              sessionId,
            },
          ],
        },
        { authorization: `Bearer ${session.token}` },
      );
      assertEquals(res.status, 200);
      assertEquals((await res.json()).accepted, 1);

      const [stored] = await store.listEventsBySession(sessionId);
      assertEquals(stored.userId, session.user.id, 'userId 必须来自令牌，不信 body');
      assertEquals(stored.batchId, batchId, 'batchId 必须来自令牌里的当前批次');
      assert(
        Number.isFinite(Date.parse(stored.at)) && Math.abs(Date.now() - Date.parse(stored.at)) < 60_000,
        `at 应是服务端时间（客户端写的 2020 年必须被丢掉），实际 ${stored.at}`,
      );
      assertEquals(
        (await store.listEventsByBatch(batchId)).map((e) => e.type).join(','),
        'page_enter',
        '事件自带 batchId，所以按批次直接查得到（B2）',
      );
    });
  });

  it('存储写失败时也不 5xx：故障注入证明路由兜住了（B4）', async () => {
    await withServer(async (base) => {
      const store = await routeStore();
      /**
       * 故障注入而不是"换一个坏驱动"：`getStore()` 是进程级单例，
       * 没法在中间替换；而"存储抛错"这条路径只有真让它抛才验得到。
       * 顺序执行（runner 是一个用例一个用例 await 的），restore 在 finally 里。
       */
      const original = store.appendEvent;
      store.appendEvent = async () => {
        throw new Error('磁盘满了（故障注入）');
      };
      const sessionId = uid('sess');
      try {
        const res = await post(base, { events: [{ type: 'page_enter', at: '2026-11-09T10:00:00.000Z', sessionId }] });
        assertEquals(res.status, 200, '存储故障不得变成 5xx');
        const json = await res.json();
        assertEquals(json.accepted, 0);
        assertEquals(json.rejected, 1, '写不进去的那条要计入 rejected');
        assertEquals((await store.listEventsBySession(sessionId)).length, 0);
      } finally {
        store.appendEvent = original;
      }
    });
  });

  it('没带 at 的事件也收下：路由在校验之前就盖了服务端时间（B7）', async () => {
    await withServer(async (base) => {
      const visitId = uid('visit');
      const res = await post(base, { events: [{ type: 'page_enter', visitId }] });
      assertEquals(res.status, 200);
      const json = await res.json();
      assertEquals(json.accepted, 1, '客户端漏发 at 不得丢掉这条埋点');
      assertEquals(json.rejected, 0);
      const [stored] = await (await routeStore()).listEventsBySession(visitId);
      assertEquals(stored.type, 'page_enter');
      assert(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(stored.at),
        `at 应是服务端生成的 ISO 字符串（24 字符、带毫秒与 Z），实际 ${stored.at}`,
      );
      assert(
        Number.isFinite(Date.parse(stored.at)) && Math.abs(Date.now() - Date.parse(stored.at)) < 60_000,
        `at 应是这次请求的服务端时间，实际 ${stored.at}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 可读性：收下的事件必须至少能被一条查询路径读出来
  // -------------------------------------------------------------------------

  /**
   * 这条规则为什么必须存在（评审点名）：
   *
   * `{ type: 'login' }` 这条**裸 login** 过了 `validateEvent`（`login` 允许没有归属，B7-1），
   * 但落库之后 `listEventsBySession` 看不到它（没有归属键）、
   * `listEventsByBatch` 也看不到它（`batchId` 为空）—— 它被写进磁盘、计入 `accepted`，
   * 然后对漏斗 / 看板 / 导出**永久不可见**，而这三个功能正是只读事件表的。
   * 于是 `accepted` 变成了谎话，而且没有任何东西能区分"收下了一条好的"和"丢了一条"。
   *
   * 裁定：**能被至少一条查询路径读出来，才叫收下**。
   * 这是**路由层的可读性判断**，不是校验规则 —— `validateEvent` 不认识 `batchId`，
   * 它继续放行无归属的 `login`（那是纯函数契约），拦截发生在归属键与 batchId 都解析完之后。
   *
   * 现实路径不受影响：登录之后客户端就握着令牌了，路由会从令牌解出用户、
   * 再把批次补进 `batchId`，那条 `login` 于是既可查、也被收下（下一条用例钉住它）。
   */
  it('既没有归属也没有 batchId 的事件被拒，且一条都没写进去（收了也永远查不出来）', async () => {
    await withServer(async (base) => {
      const store = await routeStore();
      const seqBefore = await store.getCounter('seq:event');

      const res = await post(base, { events: [{ type: 'login' }] });
      assertEquals(res.status, 200, '拒一条不等于 5xx —— 埋点接口永远 200（B4）');
      assertCounts(await res.json(), 0, 1);

      /**
       * "什么都没写"要真的看一眼存储，而不是只看 accepted：
       * `recordEvent` 落库前会领一个 `seq`，所以计数器没动就证明了**一条都没写进去**
       * （也说明拒在领号之前，没白占一个序号）。
       */
      assertEquals(await store.getCounter('seq:event'), seqBefore, '被拒的事件不得占用 seq，更不得落库');
    });
  });

  it('带令牌时同一个裸 login 被收下，且 batchId 由服务端补齐（登录后的真实路径）', async () => {
    await withServer(async (base) => {
      const { issueAccounts, login } = await import('../src/server/auth.js');
      const store = await routeStore();
      const batchId = uid('batch');
      const [{ code }] = await issueAccounts(store, { batchId, count: 1 });
      const session = await login(store, code);
      assert(session?.token, '发号后应当能登录拿到令牌');

      /** body 里什么身份都不带 —— 全部来自令牌，这才是登录之后客户端的真实形状 */
      const res = await post(base, { events: [{ type: 'login' }] }, { authorization: `Bearer ${session.token}` });
      assertEquals(res.status, 200);
      assertCounts(await res.json(), 1, 0);

      const [stored] = await store.listEventsByBatch(batchId);
      assertEquals(stored.type, 'login', '无归属的 login 只能按 batchId 查到');
      assertEquals(stored.batchId, batchId, 'batchId 必须由服务端从令牌补上 —— 那是它唯一的查询路径');
      assertEquals(stored.userId, session.user.id, 'userId 也必须来自令牌');
    });
  });

  it('混批：无主无批的那条被拒，同批的合法事件照收（一条坏事件不牵连整批）', async () => {
    await withServer(async (base) => {
      const visitId = uid('visit');
      const res = await post(base, { events: [{ type: 'login' }, { type: 'page_enter', visitId }] });
      assertEquals(res.status, 200);
      assertCounts(await res.json(), 1, 1);
      assertEquals(
        (await (await routeStore()).listEventsBySession(visitId)).map((e) => e.type).join(','),
        'page_enter',
        '同批里的合法事件必须照旧落库（B6：能收几条收几条）',
      );
    });
  });
});
