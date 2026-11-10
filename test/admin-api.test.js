/**
 * 管理接口与 `ADMIN_CODE` 闸门（Task 8）。
 *
 * ============================================================================
 * 这个套件钉的是"看板拿到的数字是真的"，不是"函数返回了 200"
 * ============================================================================
 * 看板是这批试点**唯一**的输出：老师看到的是四根柱子、四个数、一张人的列表。
 * 它们出错的方式全都不会报错，而且全都看起来很正常：
 *
 * ① **页 1–2 的停留永远是 0**（G3）。设计稿 §5.2 约定页 1–2 的事件挂在 `visit.id`
 *    上，页 3–4 的才挂在 `session.id` 上。组装 overview 时若只把事件拼进 session，
 *    看板上"第 1 页没人停留"会是个**结构性**的结论 —— 而它其实是"没读那个字段"。
 *    前两轮评审各抓到一次，所以这里有一条用例专门钉它：一个批次的 visit 带页 1、
 *    session 带页 3，两页的停留都必须非 0。
 * ② **没配 `ADMIN_CODE` 时接口还在**。那等于把全班数据挂在公网上 —— 而且不会有任何
 *    报错，只是"多了一个能打开的网址"。
 * ③ **导出件是 JSON 而不是 zip**。它照样 200、照样有内容，只是老师打不开。
 * ④ **看板自己写事件**（G5）。事件表一旦被当成访问日志，漏斗的分母就被看板自己污染，
 *    而且污染是**单向累积**的：越常看越脏。
 *
 * ============================================================================
 * 为什么用 `await import(...).catch()`
 * ============================================================================
 * 静态 import 一个还不存在的模块，会让整个套件在**加载阶段**就挂掉：一条用例都跑不起来，
 * RED 只能证明"文件不存在"，证明不了行为不对（同 `test/export-batch.test.js`）。
 * 这里把加载失败记下来交给第一条用例报出来，其余用例各自在调用处失败。
 */

import { describe, it, assert, assertEquals, assertIncludes, assertNotIncludes } from './runner.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleApi, getStore, requestEnv, __resetStoreForTests } from '../src/server/router.js';
import { renderSessionsCsv } from '../src/server/export.js';

/** 模块还不存在时不要炸掉整个套件（见文件头） */
const loadErrors = [];
const adminModule = await import('../src/server/admin.js').catch((err) => {
  loadErrors.push(err);
  return {};
});
const { adminEnabled, checkAdmin, stitchEvents, handleAdminApi } = adminModule;

// ---------------------------------------------------------------------------
// 公共小工具
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 3_600_000;

/**
 * 夹具的"现在"。
 *
 * 放弃判定（`batch.abandonHours`）与"今天"的 OCR 计数都跟真实时间有关，
 * 所以夹具一律用**相对当前时刻**的偏移构造 —— 写死日期的话，这个套件会在某一天
 * 自己变红，而那时没人知道它为什么红。
 */
const T0 = Date.now();
const at = (msAgo) => new Date(T0 - msAgo).toISOString();

const ADMIN_CODE = 'k-8';

/** 一次管理请求的、够用的 req */
function reqOf({ method = 'GET', headers = {} } = {}) {
  return { method, headers };
}

/** 假 res：只实现处理函数真的会用到的那几个方法 */
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}

/** 直接调处理函数（不走 HTTP）：用来精确构造"库读不出来"这类端到端难以复现的情形 */
async function callAdmin(store, path, options = {}) {
  const { method = 'GET', headers = { 'x-admin-code': ADMIN_CODE }, env = { ADMIN_CODE, OCR_DAILY_CAP: '40' } } = options;
  const res = fakeRes();
  const url = new URL(`http://127.0.0.1${path}`);
  const handled = await handleAdminApi(reqOf({ method, headers }), res, url, { store, env });
  const raw = res.body;
  const text = raw === undefined ? '' : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { handled, status: res.statusCode, headers: res.headers, raw, text, json };
}

/** 假 store：默认"什么都没有"，但每个用例可以覆盖任意一个方法 */
function stubStore(patch = {}) {
  const calls = [];
  const record = (name) => async () => {
    calls.push(name);
    return null;
  };
  const base = {
    kind: 'file',
    calls,
    getBatch: async (id) => {
      calls.push(`getBatch:${id}`);
      return { id, label: '第二版', abandonHours: 24 };
    },
    listMembers: async () => {
      calls.push('listMembers');
      return [];
    },
    getUserById: async (id) => {
      calls.push(`getUserById:${id}`);
      return null;
    },
    listSessionsByBatch: async () => {
      calls.push('listSessionsByBatch');
      return [];
    },
    listEventsByBatch: async () => {
      calls.push('listEventsByBatch');
      return [];
    },
    getVisit: record('getVisit'),
    getSession: record('getSession'),
    getCounter: async (key) => {
      calls.push(`getCounter:${key}`);
      return 0;
    },
  };
  return { ...base, ...patch, calls };
}

// ---------------------------------------------------------------------------
// 夹具：一个像样的批次（两人作答、一人只打开没选题、一人已从名单里删掉）
// ---------------------------------------------------------------------------

/**
 * 数据形状刻意做成"最容易被读漏"的那一种：
 *   · `v2`（u2 的第一次打开）只有页 1 的两个事件、**没有会话之外的东西**；
 *   · `s9`（u9）的 `visitId` 指向一条**库里不存在**的 visit（历史数据缺件）；
 *   · 用户的 `displayName` 与 `id` 顺序相反（按 displayName 排就必须重排）；
 *   · 事件按 seq 乱序写进去（顺序由驱动/排序决定，不靠"恰好写对了"）。
 */
function fixture() {
  const batch = {
    id: 'b8',
    label: '第二版',
    versionSha: 'sha-8',
    questionIds: ['qbank-1', 'qbank-2'],
    startsAt: at(200 * HOUR),
    endsAt: null,
    ocrCap: 200,
    dailyCap: 40,
    idleMinutes: 30,
    abandonHours: 24,
    allowPhoto: true,
    createdAt: at(200 * HOUR),
  };

  const users = [
    { id: 'u1', displayName: 'S02', batches: ['b8'], firstSeenAt: at(100 * MIN), lastSeenAt: at(9 * MIN) },
    { id: 'u2', displayName: 'S01', batches: ['b8'], firstSeenAt: at(41 * HOUR), lastSeenAt: at(30 * HOUR) },
    /** 一次都没打开：列表里必须留着这一行，否则"没人来"这件事看不出来 */
    { id: 'u3', displayName: 'S03', batches: ['b8'], firstSeenAt: at(20 * HOUR), lastSeenAt: at(20 * HOUR) },
  ];

  const members = ['u1', 'u2', 'u3'];

  const visits = [
    { id: 'v1', userId: 'u1', batchId: 'b8', openedAt: at(1000e3), lastAt: at(910e3), sessionIds: ['s1'] },
    /** 打开之后一道题都没选：只有页 1 的事件，没有会话 */
    { id: 'v2', userId: 'u2', batchId: 'b8', openedAt: at(41 * HOUR), lastAt: at(41 * HOUR - 20e3), sessionIds: [] },
  ];

  const sessions = [
    {
      id: 's1',
      visitId: 'v1',
      userId: 'u1',
      batchId: 'b8',
      problemId: 'qbank-1',
      questionIndex: 0,
      startedAt: at(600e3),
      lastAt: at(540e3),
      finishedAt: at(540e3),
      endState: 'finished',
      progress: { maxPage: 4, reached: { p2: at(940e3), p3: at(600e3), p4: at(500e3) }, backtracks: 0 },
      counters: { resetCount: 0, chatTurns: 2, hintLevels: [1] },
      turns: [{ i: 0, at: at(590e3), role: 'student', text: '先把力分解' }],
      reportSnapshot: { independence: 0.6 },
    },
    {
      id: 's2',
      visitId: 'v2',
      userId: 'u2',
      batchId: 'b8',
      problemId: 'qbank-2',
      questionIndex: 1,
      startedAt: at(41 * HOUR),
      lastAt: at(30 * HOUR),
      finishedAt: null,
      endState: 'in_progress',
      progress: { maxPage: 2, reached: { p2: at(41 * HOUR) }, backtracks: 0 },
      counters: { resetCount: 0, chatTurns: 1, hintLevels: [] },
      turns: [],
    },
    {
      /** u9 已经不在名单里（人删了、记录还在）；它的 visit 也不在库里 */
      id: 's9',
      visitId: 'v9',
      userId: 'u9',
      batchId: 'b8',
      problemId: 'qbank-2',
      questionIndex: 2,
      startedAt: at(5 * HOUR),
      lastAt: at(4 * HOUR),
      finishedAt: null,
      endState: 'in_progress',
      progress: { maxPage: 1, reached: {}, backtracks: 0 },
      counters: { chatTurns: 0, hintLevels: [] },
      turns: [],
    },
  ];

  /** 一条事件的唯一写法：归属字段按 G3 的约定分（页 1–2 挂 visit，页 3–4 挂 session） */
  const ev = (seq, type, atIso, owner, payload) => ({
    seq,
    type,
    at: atIso,
    userId: owner.userId ?? null,
    batchId: 'b8',
    sessionId: owner.sessionId ?? null,
    visitId: owner.visitId ?? null,
    payload,
  });

  const events = [
    ev(1, 'page_enter', at(1000e3), { visitId: 'v1' }, { page: 1 }),
    ev(2, 'page_exit', at(940e3), { visitId: 'v1' }, { page: 1 }),
    ev(3, 'page_enter', at(940e3), { visitId: 'v1' }, { page: 2 }),
    ev(4, 'page_exit', at(910e3), { visitId: 'v1' }, { page: 2 }),
    ev(5, 'page_enter', at(600e3), { sessionId: 's1', visitId: 'v1' }, { page: 3 }),
    ev(6, 'page_exit', at(540e3), { sessionId: 's1', visitId: 'v1' }, { page: 3 }),
    ev(7, 'page_enter', at(500e3), { sessionId: 's1', visitId: 'v1' }, { page: 4 }),
    ev(8, 'page_exit', at(470e3), { sessionId: 's1', visitId: 'v1' }, { page: 4 }),
    ev(9, 'chat_send', at(490e3), { sessionId: 's1', visitId: 'v1' }, { len: 12 }),
    ev(10, 'chat_error', at(489e3), { sessionId: 's1', visitId: 'v1' }, { code: 'TURN_SLOW' }),
    ev(11, 'chat_send', at(40 * HOUR), { sessionId: 's2', visitId: 'v2' }, { len: 3 }),
    ev(12, 'chat_reply', at(40 * HOUR - 1000), { sessionId: 's2', visitId: 'v2' }, {}),
    ev(13, 'page_enter', at(41 * HOUR), { visitId: 'v2' }, { page: 1 }),
    ev(14, 'page_exit', at(41 * HOUR - 20e3), { visitId: 'v2' }, { page: 1 }),
  ];

  return { batch, users, members, visits, sessions, events };
}

/** 把夹具写进库（走存储端口，不绕过它） */
async function seed(store, data = fixture()) {
  await store.putBatch(data.batch);
  for (const user of data.users) await store.putUser(user);
  for (const userId of data.members) await store.addMember(data.batch.id, userId);
  for (const visit of data.visits) await store.putVisit(visit);
  for (const session of data.sessions) await store.putSession(session);
  /** 乱序写入：读取顺序由驱动的 seq 排序决定，不靠"恰好按顺序写了" */
  for (const event of [...data.events].reverse()) await store.appendEvent(event);
  await store.incrCounter(`ocr:batch:${data.batch.id}`, 7);
  return data;
}

/**
 * 起一个真 HTTP 服务，STORE 指到临时目录。
 *
 * 为什么走真服务：zip 的 content-type / 附件头、404/401 的状态码与响应体、
 * "挂载点在登录守卫之前" —— 这几件事只发生在路由层，直接调处理函数证明不了。
 *
 * 为什么要把 ADMIN_CODE / OCR_DAILY_CAP 从继承来的环境里删掉：开发者的 `.env`
 * 可能带着真口令（`loadEnvFile` 在 router 被 import 时就跑过了）。带着它，
 * "没配口令就该 404"这条用例会永远绿，而线上恰恰是那个样子。
 */
async function withAdminServer(envPatch, fn) {
  const { createServer } = await import('node:http');
  const dir = mkdtempSync(join(tmpdir(), 'bsj-admin-'));
  const env = { ...process.env, STORE: 'file', STORE_DIR: dir, ADMIN_CODE };
  delete env.LLM_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.PILOT_REQUIRE_LOGIN;
  delete env.OCR_DAILY_CAP;
  Object.assign(env, envPatch ?? {});
  /** `undefined` 表示"这个变量不存在"，不能留在 env 里当字符串 */
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];

  __resetStoreForTests();
  const store = await requestEnv.run(env, () => getStore());

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const handled = await requestEnv.run(env, () => handleApi(req, res, url));
    if (!handled) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: `未知接口 ${url.pathname}` }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    return await fn({ base, store, dir, env });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    __resetStoreForTests();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 真实 HTTP 调用：JSON 与二进制都返回（看板要的两种响应形状） */
async function call(base, path, { method = 'GET', headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers });
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  let json = null;
  if (type.includes('application/json')) {
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {
      json = null;
    }
  }
  return { status: res.status, headers: res.headers, buf, type, json };
}

const withCode = (extra = {}) => ({ 'x-admin-code': ADMIN_CODE, ...extra });

/**
 * 深比较。
 *
 * `runner.js` 的 `assertEquals` 是 `!==`：拿它比数组时，值明明一样也会失败
 * （报出来是"期望与实参长得一样"的假失败）。数组/对象一律用这一条。
 */
function assertDeep(actual, expected, msg = '') {
  assertEquals(JSON.stringify(actual), JSON.stringify(expected), msg);
}

// ===========================================================================
// 一、闸门（纯函数）
// ===========================================================================

describe('管理接口 · 闸门', () => {
  it('admin.js 能加载（加载失败时这一条会指出真正的原因）', () => {
    assertEquals(loadErrors.length, 0, `admin.js 加载失败：${loadErrors[0]?.message ?? ''}`);
  });

  it('没配 ADMIN_CODE → disabled（页面与接口都应当 404）', () => {
    assertEquals(adminEnabled({}), false);
    assertEquals(checkAdmin(reqOf({ headers: {} }), {}), 'disabled');
  });

  it('ADMIN_CODE 只有空白也算没配（否则"配了个空格"会让闸门形同虚设）', () => {
    assertEquals(adminEnabled({ ADMIN_CODE: '   ' }), false);
    assertEquals(checkAdmin(reqOf({ headers: { 'x-admin-code': '   ' } }), { ADMIN_CODE: '  ' }), 'disabled');
  });

  it('配了但没带 → locked', () => {
    assertEquals(checkAdmin(reqOf({ headers: {} }), { ADMIN_CODE: 'k' }), 'locked');
  });

  it('带对 → ok；带错 → locked', () => {
    assertEquals(checkAdmin(reqOf({ headers: { 'x-admin-code': 'k' } }), { ADMIN_CODE: 'k' }), 'ok');
    assertEquals(checkAdmin(reqOf({ headers: { 'x-admin-code': 'k2' } }), { ADMIN_CODE: 'k' }), 'locked');
  });

  it('学生 token 不能当管理员口令用（两把钥匙不能互相开锁）', () => {
    assertEquals(checkAdmin(reqOf({ headers: { 'x-test-token': 'abc' } }), { ADMIN_CODE: 'k' }), 'locked');
    assertEquals(
      checkAdmin(reqOf({ headers: { authorization: 'Bearer abc' } }), { ADMIN_CODE: 'abc' }),
      'locked',
      'Bearer 头也不该被当成管理员口令',
    );
  });

  it('Fetch 形状的 Headers 实例也取得到（Workers / Vercel 用的就是它）', () => {
    const headers = new Headers({ 'x-admin-code': 'k' });
    assertEquals(checkAdmin(reqOf({ headers }), { ADMIN_CODE: 'k' }), 'ok');
  });
});

// ===========================================================================
// 二、404 与 401：没配就"没有这个接口"，配了才"需要口令"
// ===========================================================================

describe('管理接口 · 三道门（真实 HTTP）', () => {
  const ADMIN_PATHS = ['/api/admin/overview?batchId=b8', '/api/admin/users?batchId=b8', '/api/admin/export?batchId=b8', '/api/admin/nope', '/api/admin/'];

  it('没配 ADMIN_CODE：五条管理路径一律 404，且响应体一字不差（不承认这是管理员接口）', async () => {
    await withAdminServer({ ADMIN_CODE: undefined }, async ({ base, store }) => {
      await seed(store);
      for (const path of ADMIN_PATHS) {
        const res = await call(base, path, { headers: withCode() });
        assertEquals(res.status, 404, `${path} 应当是 404`);
        assertEquals(res.buf.toString('utf8'), JSON.stringify({ error: '没有这个接口' }), `${path} 的响应体不该透露任何东西`);
        assertNotIncludes(res.buf.toString('utf8'), '管理', `${path} 的响应体不该出现"管理"`);
      }
    });
  });

  it('配了但没带口令 → 401 需要管理员口令；带错也是 401', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      for (const headers of [{}, { 'x-admin-code': 'wrong' }, { 'x-test-token': 'abc' }]) {
        const res = await call(base, '/api/admin/overview?batchId=b8', { headers });
        assertEquals(res.status, 401, `headers=${JSON.stringify(headers)} 应当 401`);
        assertEquals(res.json.error, '需要管理员口令');
      }
    });
  });

  it('STORE 是内存时（Vercel / Workers 上就是这样）即便口令对也 404', async () => {
    await withAdminServer({ STORE: undefined, STORE_DIR: undefined }, async ({ base, store }) => {
      /** 库里确实有这个批次：404 只能来自"这个部署没有库"，不能来自"查不到批次" */
      await seed(store);
      assertEquals(await store.getBatch('b8') === null, false, '夹具应当真的写进了内存库');
      for (const path of ADMIN_PATHS) {
        const res = await call(base, path, { headers: withCode() });
        assertEquals(res.status, 404, `${path} 在内存库上应当 404`);
        assertEquals(res.buf.toString('utf8'), JSON.stringify({ error: '没有这个接口' }));
      }
    });
  });

  it('PILOT_REQUIRE_LOGIN=1 时管理接口不吃 401（它挂在登录守卫之前）', async () => {
    await withAdminServer({ PILOT_REQUIRE_LOGIN: '1' }, async ({ base, store }) => {
      await seed(store);
      const res = await call(base, '/api/admin/overview?batchId=b8', { headers: withCode() });
      assertEquals(res.status, 200, '管理员口令与学生登录是两件事');
      /** 反过来：学生端那条路仍然被守卫挡着（挂载点没有把它一起放开） */
      const guarded = await call(base, '/api/problems');
      assertEquals(guarded.status, 401);
    });
  });

  it('未知路径 404；非 GET 405（两个都在口令之后判，没口令的人看不到区别）', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      const unknown = await call(base, '/api/admin/whatever', { headers: withCode() });
      assertEquals(unknown.status, 404);
      assertEquals(unknown.json.error, '没有这个接口');

      const posted = await call(base, '/api/admin/overview?batchId=b8', { method: 'POST', headers: withCode() });
      assertEquals(posted.status, 405);
      assertEquals(posted.json.error, '只支持 GET');

      const lockedPost = await call(base, '/api/admin/overview?batchId=b8', { method: 'POST' });
      assertEquals(lockedPost.status, 401, '没口令时先说口令，再说方法');
    });
  });
});

// ===========================================================================
// 三、overview：G3 的页 1–2 停留必须真的读 visit
// ===========================================================================

describe('管理接口 · overview', () => {
  it('缺 batchId → 400 需要 batchId（不是 404，也不是空数据）', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      for (const path of ['/api/admin/overview', '/api/admin/users']) {
        const res = await call(base, path, { headers: withCode() });
        assertEquals(res.status, 400, `${path} 缺参数应当 400`);
        assertEquals(res.json.error, '需要 batchId');
      }
    });
  });

  it('批次不存在 → 404 这个批次不存在', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      for (const path of ['/api/admin/overview?batchId=nope', '/api/admin/users?batchId=nope']) {
        const res = await call(base, path, { headers: withCode() });
        assertEquals(res.status, 404);
        assertEquals(res.json.error, '这个批次不存在');
      }
    });
  });

  it('形状：batch / funnel / summary / usage / generatedAt，generatedAt 是服务端时间', async () => {
    await withAdminServer({ OCR_DAILY_CAP: '40' }, async ({ base, store }) => {
      const data = await seed(store);
      const res = await call(base, '/api/admin/overview?batchId=b8', { headers: withCode() });
      assertEquals(res.status, 200);
      const body = res.json;

      assertEquals(body.batch.id, data.batch.id);
      assertEquals(body.batch.label, data.batch.label);
      assertEquals(body.funnel.p1, 2, 'p1 是打开次数（v1 + v2）');
      assertEquals(body.funnel.p2, 2);
      assertEquals(body.funnel.p3, 1);
      assertEquals(body.funnel.p4, 1);
      assertEquals(body.funnel.conversion.p2_p3, 0.5);
      assertEquals(body.funnel.dropOffPage, 3);
      assertEquals(body.summary.sessionCount, 3);
      assertEquals(body.summary.userCount, 3);
      assertEquals(body.summary.abandonCount, 1, 's2 隔了 30 小时没动且没做完');
      assertEquals(body.summary.avgMaxPage, 2.3333);
      assertEquals(body.summary.turnFailureRate, 0.5);

      /** 用量那一行：Task 11 会填真值，这里先按计数器的键读出来 */
      assertEquals(body.usage.ocrBatch, 7);
      assertEquals(body.usage.ocrDaily, 0, '今天还没人用过 OCR，0 是对的');
      assertEquals(body.usage.ocrCap, 200);
      assertEquals(body.usage.dailyCap, 40);
      assertEquals(body.usage.chatTurns, 3);
      assertEquals(body.usage.turnFailureRate, 0.5);

      assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(body.generatedAt), 'generatedAt 应是服务端盖的 ISO 时间');
      assert(Math.abs(Date.parse(body.generatedAt) - Date.now()) < 60_000, 'generatedAt 应当是"现在"');
    });
  });

  it('G3：visit 带页 1、session 带页 3 时，两页的停留都必须非 0', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      const res = await call(base, '/api/admin/overview?batchId=b8', { headers: withCode() });
      const perPage = res.json.funnel.perPage;

      /**
       * 这一条就是那份欠账的守卫：只把事件拼进 session 时，
       * 页 1 与页 2 的停留会**结构性**地永远是 0（会话是进第 3 页才造的）。
       */
      assertEquals(perPage[0].page, 1);
      assertEquals(perPage[0].visitors, 2);
      assertEquals(perPage[0].avgDwellMs, 40000, '页 1：v1 停了 60 秒、v2 停了 20 秒，两人平均 40 秒');
      assertEquals(perPage[1].avgDwellMs, 15000, '页 2：只有到过第 2 页的人算分母（v1 的 30 秒 / 2 人）');
      assertEquals(perPage[2].avgDwellMs, 60000, '页 3 读 session 的事件');
      assertEquals(perPage[3].avgDwellMs, 30000, '页 4 读 session 的事件');

      assert(perPage[0].avgDwellMs !== 0, '页 1 停留不许是 0（只拼 session 就是这个症状）');
      assert(perPage[2].avgDwellMs !== 0, '页 3 停留不许是 0（只拼 visit 就是这个症状）');
      assert(perPage[1].avgDwellMs !== 0, '页 2 停留不许是 0');
    });
  });

  it('G3：一次"打开但没选题"也算一次 p1 —— 否则 p1 与 p2 永远是同一个数', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      const { json } = await call(base, '/api/admin/overview?batchId=b8', { headers: withCode() });
      /**
       * v2 没有会话，只在事件里以 `visitId` 出现。只按"会话涉及的 visitId"取打开记录时
       * 它会被漏掉，p1 于是退化成"有作答的人数"，第一根柱子不再回答"多少人打开了链接"。
       */
      assertEquals(json.funnel.p1, 2);
      assertEquals(json.funnel.perPage[0].visitors, 2);
    });
  });

  it('库里没有 visit 记录时不凭空造一次打开（s9 的 v9 不存在）', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      const { json } = await call(base, '/api/admin/overview?batchId=b8', { headers: withCode() });
      assertEquals(json.funnel.p1, 2, 'v9 没有记录，不算一次打开');
    });
  });

  it('会话上没有 visitId 时，靠事件里的 visitId 也能取到打开记录（今天的真实形状就是这种）', async () => {
    /**
     * `visit.sessionIds` 与 `session.visitId` 都还没有写入方（Task 10 才回填），
     * 所以真实数据里"会话 → 打开记录"这条链是断的。只按会话的 visitId 取 visit 时，
     * p1 会是 0，整个漏斗跟着全 0 —— 而它看起来跟"这批没人用"一模一样。
     * 事件上的 visitId 是页 1–2 自己带的，它才是今天唯一可靠的线索。
     */
    const store = stubStore({
      listSessionsByBatch: async () => [
        { id: 's1', userId: 'u1', batchId: 'b8', lastAt: at(540e3), progress: { maxPage: 3, reached: { p3: at(600e3) } }, counters: {} },
      ],
      listEventsByBatch: async () => [
        { seq: 1, type: 'page_enter', at: at(600e3), visitId: 'v1', sessionId: null, batchId: 'b8', payload: { page: 1 } },
        { seq: 2, type: 'page_exit', at: at(540e3), visitId: 'v1', sessionId: null, batchId: 'b8', payload: { page: 1 } },
      ],
      getVisit: async (id) => (id === 'v1' ? { id: 'v1', userId: 'u1', batchId: 'b8' } : null),
    });

    const res = await callAdmin(store, '/api/admin/overview?batchId=b8');
    assertEquals(res.status, 200);
    assertEquals(res.json.funnel.p1, 1, '这一次打开必须被数到');
    assertEquals(res.json.funnel.perPage[0].avgDwellMs, 60000, '页 1 的 60 秒停留也必须算出来');
  });

  it('打开记录是**并发**取的（Promise.all），不是一条一条串行', async () => {
    /**
     * 这一条守的是"一次看板要等多久"：打开记录只能按 id 取（存储端口没有
     * `listVisitsByBatch`），串行时库调用是 1 + 2N 次、每次一个网络往返。
     * 试点班 40 人量级还能忍，一个学期之后就是看板转圈的直接原因。
     * 用"同时在飞的请求数"来验：串行时峰值恒为 1。
     */
    let inFlight = 0;
    let peak = 0;
    const store = stubStore({
      listSessionsByBatch: async () => [
        { id: 's1', visitId: 'v1', userId: 'u1', batchId: 'b8', lastAt: at(500e3), progress: { maxPage: 2, reached: { p2: at(600e3) } }, counters: {} },
        { id: 's2', visitId: 'v2', userId: 'u2', batchId: 'b8', lastAt: at(400e3), progress: { maxPage: 2, reached: { p2: at(500e3) } }, counters: {} },
        { id: 's3', visitId: 'v3', userId: 'u3', batchId: 'b8', lastAt: at(300e3), progress: { maxPage: 2, reached: { p2: at(400e3) } }, counters: {} },
      ],
      getVisit: async (id) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { id, userId: 'u1', batchId: 'b8' };
      },
    });

    const res = await callAdmin(store, '/api/admin/overview?batchId=b8');
    assertEquals(res.status, 200);
    assertEquals(peak, 3, `三份打开记录应当同时在取，实际并发峰值 ${peak}（1 = 仍然是串行）`);
    assertEquals(res.json.funnel.p1, 3, '并发不许把结果弄丢');
  });

  it('usage 按约定的计数器键读：ocr:batch:<batchId> 与 ocr:daily:<YYYY-MM-DD>', async () => {
    const store = stubStore();
    const res = await callAdmin(store, '/api/admin/overview?batchId=b8');
    assertEquals(res.status, 200);
    const keys = store.calls.filter((call) => call.startsWith('getCounter:'));
    assert(keys.includes('getCounter:ocr:batch:b8'), `应当读 ocr:batch:b8，实际：${keys.join(', ')}`);
    assert(
      keys.some((key) => /^getCounter:ocr:daily:\d{4}-\d{2}-\d{2}$/.test(key)),
      `应当读 ocr:daily:<YYYY-MM-DD>，实际：${keys.join(', ')}`,
    );
  });
});

// ===========================================================================
// 四、users：人的列表（看板第三屏）
// ===========================================================================

describe('管理接口 · users', () => {
  it('按 displayName 字典序；lastPage 取该人所有会话里的最大页；finished 数得对', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      const res = await call(base, '/api/admin/users?batchId=b8', { headers: withCode() });
      assertEquals(res.status, 200);
      const rows = res.json;

      assertEquals(rows.map((row) => row.displayName).join(','), 'S01,S02,S03,未知', '字典序，且已删号的人排在最后');
      assertEquals(rows.map((row) => row.userId).join(','), 'u2,u1,u3,u9');

      const byId = Object.fromEntries(rows.map((row) => [row.userId, row]));
      assertEquals(byId.u1.sessions, 1);
      assertEquals(byId.u1.finished, 1);
      assertEquals(byId.u1.lastPage, 4);
      assertEquals(byId.u1.lastAt, at(540e3));
      assertEquals(byId.u1.abandoned, false, '已经做完了，不是放弃');

      assertEquals(byId.u2.sessions, 1);
      assertEquals(byId.u2.finished, 0);
      assertEquals(byId.u2.lastPage, 2);
      assertEquals(byId.u2.abandoned, true, '30 小时没动且没做完 —— 这就是放弃');

      /** 一次都没打开的人也要在列表里：这正是"没人来"唯一的可见形式 */
      assertEquals(byId.u3.sessions, 0);
      assertEquals(byId.u3.finished, 0);
      assertEquals(byId.u3.lastPage, 0);
      assertEquals(byId.u3.lastAt, null);
      assertEquals(byId.u3.abandoned, false);

      /** 人删了但记录还在：行不能丢，代号写"未知"（与导出件的降级一致） */
      assertEquals(byId.u9.displayName, '未知');
      assertEquals(byId.u9.sessions, 1);
      assertEquals(byId.u9.lastPage, 1);
    });
  });

  it('每行只有这八个字段（看板不该收到 codeHash 之类的内部字段）', async () => {
    const store = stubStore({
      listMembers: async () => [{ batchId: 'b8', userId: 'u1' }],
      getUserById: async () => ({ id: 'u1', displayName: 'S01', codeHash: 'deadbeef', disabled: false }),
    });
    const res = await callAdmin(store, '/api/admin/users?batchId=b8');
    assertEquals(res.status, 200);
    assertEquals(
      Object.keys(res.json[0]).sort().join(','),
      'abandoned,displayName,finished,lastAt,lastPage,sessionList,sessions,userId',
    );
    assertNotIncludes(res.text, 'deadbeef');
  });
});

// ===========================================================================
// 五、导出：二进制、附件头、错误码映射
// ===========================================================================

describe('管理接口 · 导出', () => {
  it('单条：application/zip 二进制 + ASCII 附件名（不走 sendJson）', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      const res = await call(base, '/api/admin/export?sessionId=s1', { headers: withCode() });
      assertEquals(res.status, 200);
      assertEquals(res.type, 'application/zip');
      assertEquals(res.headers.get('content-disposition'), 'attachment; filename="bubujie-export.zip"');
      assertEquals(res.buf.subarray(0, 2).toString('latin1'), 'PK', 'zip 必须以 PK 开头（JSON 会从 { 开头）');
      assert(res.buf.length > 200, 'zip 不该是个空壳');
    });
  });

  it('整批：同样是 zip（README/CSV/JSONL 都在里面）', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      const res = await call(base, '/api/admin/export?batchId=b8', { headers: withCode() });
      assertEquals(res.status, 200);
      assertEquals(res.type, 'application/zip');
      assertEquals(res.buf.subarray(0, 2).toString('latin1'), 'PK');
      /** 条目名是明文写在 zip 里的：顺手确认这批导出真的带了 README 与事件流 */
      const text = res.buf.toString('latin1');
      assert(text.includes('README.md'), '整批导出应当带 README.md');
      assert(text.includes('events.jsonl'), '整批导出应当带 events.jsonl');
    });
  });

  it('两个参数都没带 → 400（不猜"导哪一份"）', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      const res = await call(base, '/api/admin/export', { headers: withCode() });
      assertEquals(res.status, 400);
      assertEquals(res.json.error, '需要 sessionId 或 batchId');
    });
  });

  it('记录不存在 → 404 这条学习记录不存在；批次不存在 → 404 这个批次不存在', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      const missingSession = await call(base, '/api/admin/export?sessionId=nope', { headers: withCode() });
      assertEquals(missingSession.status, 404);
      assertEquals(missingSession.json.error, '这条学习记录不存在');

      const missingBatch = await call(base, '/api/admin/export?batchId=nope', { headers: withCode() });
      assertEquals(missingBatch.status, 404);
      assertEquals(missingBatch.json.error, '这个批次不存在');
    });
  });

  it('读记录失败 → 503 且带 retryable（不是 404：那份记录其实还在）', async () => {
    const store = stubStore({
      getSession: async () => {
        throw new Error('cloudbase: request timeout');
      },
    });
    const res = await callAdmin(store, '/api/admin/export?sessionId=s1');
    assertEquals(res.status, 503);
    assertEquals(res.json.error, '读取学习记录失败，请刷新页面重试。');
    assertEquals(res.json.retryable, true);
  });

  it('导出失败时不把 err.message 回给前端（里面可能有内部路径）', async () => {
    const store = stubStore({
      getBatch: async () => {
        throw new Error('ENOENT: C:\\secret\\bubujie\\db\\batch.json');
      },
    });
    const res = await callAdmin(store, '/api/admin/export?batchId=b8');
    assertEquals(res.status, 503);
    assertEquals(res.json.retryable, true);
    assertNotIncludes(res.text, 'secret', '错误详情不能出现在响应体里');
    assertNotIncludes(res.text, 'ENOENT');
  });
});

// ===========================================================================
// 六、只读：管理接口不写任何东西（G5）
// ===========================================================================

describe('管理接口 · 只读', () => {
  it('看一眼板不发事件、不动计数器（事件表不是访问日志）', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      const before = {
        events: (await store.listEventsByBatch('b8')).length,
        seq: await store.getCounter('seq:event'),
      };

      for (const path of ['/api/admin/overview?batchId=b8', '/api/admin/users?batchId=b8', '/api/admin/export?batchId=b8']) {
        const res = await call(base, path, { headers: withCode() });
        assertEquals(res.status, 200, `${path} 应当 200`);
      }

      assertEquals((await store.listEventsByBatch('b8')).length, before.events, '看板不得追加事件');
      assertEquals(await store.getCounter('seq:event'), before.seq, '序号计数器也不该被看板推动');
    });
  });
});

// ===========================================================================
// 七、读库失败的公共处理
// ===========================================================================

describe('管理接口 · 读不出来', () => {
  it('overview 读会话失败 → 503 + retryable，且不泄露 err.message', async () => {
    const store = stubStore({
      listSessionsByBatch: async () => {
        throw new Error('read ECONNRESET C:\\secret\\db');
      },
    });
    const res = await callAdmin(store, '/api/admin/overview?batchId=b8');
    assertEquals(res.status, 503);
    assertEquals(res.json.retryable, true);
    assertNotIncludes(res.text, 'ECONNRESET');
    assertNotIncludes(res.text, 'secret');
  });

  it('users 读成员失败 → 同样 503（不把内部错误当 500 抛出去）', async () => {
    const store = stubStore({
      listMembers: async () => {
        throw new Error('boom');
      },
    });
    const res = await callAdmin(store, '/api/admin/users?batchId=b8');
    assertEquals(res.status, 503);
    assertEquals(res.json.retryable, true);
  });

  it('store 为 null（例如云驱动还没装好）→ 404 而不是 500', async () => {
    const res = await callAdmin(null, '/api/admin/overview?batchId=b8');
    assertEquals(res.status, 404);
    assertEquals(res.json.error, '没有这个接口');
  });

  it('内存驱动同样 404（处理函数第一行就判）', async () => {
    const res = await callAdmin(stubStore({ kind: 'memory' }), '/api/admin/overview?batchId=b8');
    assertEquals(res.status, 404);
    assertEquals(res.json.error, '没有这个接口');
  });
});

// ===========================================================================
// 八、stitchEvents：G3 的那一步单独钉一遍
// ===========================================================================

describe('管理接口 · stitchEvents', () => {
  const sessions = [{ id: 's1', visitId: 'v1', userId: 'u1' }];
  const visits = [
    { id: 'v1', userId: 'u1' },
    { id: 'v2', userId: 'u2' },
  ];
  const events = [
    { seq: 1, type: 'page_enter', visitId: 'v1', sessionId: null, payload: { page: 1 } },
    { seq: 2, type: 'page_enter', visitId: 'v1', sessionId: 's1', payload: { page: 3 } },
    { seq: 3, type: 'page_enter', visitId: 'v2', sessionId: null, payload: { page: 1 } },
  ];

  it('按归属键分组，且会话连自己那次打开的事件一起拿到（B2）', () => {
    const stitched = stitchEvents(events, sessions, visits);
    assertDeep(
      stitched.sessions[0].events.map((event) => event.seq),
      [1, 2],
      '会话 s1 属于打开 v1：页 1 的事件只带 visitId，但它就是这条会话的',
    );
    assertDeep(stitched.visits[0].events.map((event) => event.seq), [1], 'visit 那一侧仍然只有它自己的事件');
    assertDeep(stitched.visits[1].events.map((event) => event.seq), [3]);
  });

  it('没有事件的记录给空数组（metrics 的约定：没拼进来就是没有）', () => {
    const stitched = stitchEvents([], sessions, visits);
    assertDeep(stitched.sessions[0].events, []);
    assertDeep(stitched.visits[0].events, []);
  });

  it('不改入参（拼进来的是副本，调用方手上那份还在）', () => {
    const rawSessions = [{ id: 's1' }];
    const rawVisits = [{ id: 'v1' }];
    stitchEvents(events, rawSessions, rawVisits);
    assert(!('events' in rawSessions[0]), '会话对象不该被就地改动');
    assert(!('events' in rawVisits[0]), '打开记录不该被就地改动');
  });

  it('一条事件只挂一处（sessionId 优先），不会两边都算一遍停留', () => {
    const stitched = stitchEvents([{ seq: 1, visitId: 'v1', sessionId: 's1', type: 'page_enter', payload: { page: 3 } }], sessions, visits);
    assertEquals(stitched.sessions[0].events.length, 1);
    assertEquals(stitched.visits[0].events.length, 0, '两边都挂会把同一段时间算两遍');
  });
});

// ===========================================================================
// 九、单人页：人的每一行带他自己的会话，外加"读一段对话"的接口
// ===========================================================================

/**
 * 设计稿 §5.6 的第三屏是"点一个人，看他的会话与对话"。漏斗只说**在哪掉**，
 * 读完一段对话才知道**为什么掉**。而这两件事原本都没有接口：
 *   · `/api/admin/users` 只回聚合，没有 sessionId，页面点不下去；
 *   · `/api/admin/export` 回的是 zip，页面读不了。
 *
 * 这一节钉的是"补上之后不会顺手把教师字段漏出去"：
 *   · `hintLog` 里有 `rationale` / `evidenceQuotes` / `guardViolations`，
 *     它们是给教研复盘的，不是给学生看的；整条 `session` 直接 JSON 回去就会带出去，
 *     而这种泄漏**不会报错**——页面只显示对话，没人会发现多出来的字段。
 *   · `turns` 上的 `metaStep` / `metaGraphId` 是同类的漏点：它们指向解题路径。
 */
describe('管理接口 · 单人页', () => {
  /** 一条会话的最小形状：只写 sessionList 与 readSessionRecord 真的会读的那几个字段 */
  const sessionOf = (over = {}) => ({
    id: 's-x',
    userId: 'u1',
    batchId: 'b8',
    problemId: 'qbank-1',
    questionIndex: 0,
    startedAt: at(60 * MIN),
    lastAt: at(50 * MIN),
    finishedAt: null,
    endState: 'in_progress',
    progress: { maxPage: 3, reached: { p3: at(55 * MIN) }, backtracks: 0 },
    counters: { chatTurns: 1, hintLevels: [] },
    turns: [],
    ...over,
  });

  /** 只有一个人的库：会话由每条用例自己给 */
  const oneUserStore = (sessions, patch = {}) =>
    stubStore({
      listMembers: async () => [{ batchId: 'b8', userId: 'u1' }],
      getUserById: async () => ({ id: 'u1', displayName: 'S01' }),
      listSessionsByBatch: async () => sessions,
      ...patch,
    });

  it('每行带 sessionList：字段固定，按 startedAt 降序、同值按 id 升序', async () => {
    const store = oneUserStore([
      sessionOf({ id: 's-mid', startedAt: at(30 * MIN), lastAt: at(25 * MIN) }),
      sessionOf({ id: 's-old', startedAt: at(90 * MIN), lastAt: at(80 * MIN) }),
      sessionOf({ id: 's-new', startedAt: at(10 * MIN), lastAt: at(5 * MIN), finishedAt: at(6 * MIN) }),
      /** 同一毫秒创建的两条：靠 id 码位升序定序，两次刷新必须给出同一个顺序 */
      sessionOf({ id: 's-tie-b', startedAt: at(30 * MIN), lastAt: at(25 * MIN) }),
      sessionOf({ id: 's-tie-a', startedAt: at(30 * MIN), lastAt: at(25 * MIN) }),
      /** 30 小时没动且没做完：这一条要标"已放弃" */
      sessionOf({ id: 's-gone', startedAt: at(40 * HOUR), lastAt: at(30 * HOUR) }),
    ]);

    const res = await callAdmin(store, '/api/admin/users?batchId=b8');
    assertEquals(res.status, 200);
    const row = res.json[0];

    assertEquals(
      row.sessionList.map((item) => item.id).join(','),
      's-new,s-mid,s-tie-a,s-tie-b,s-old,s-gone',
      '最近的排最前；同一时刻按 id 升序',
    );
    assertEquals(row.sessions, 6, 'sessions 仍然是条数（既有字段不改名、不改含义）');
    assertEquals(row.sessionList.length, row.sessions, '没到 50 条时一条都不许少');

    /** 形状：多一个字段就是"某个内部字段被顺手带出去了" */
    assertEquals(
      Object.keys(row.sessionList[0]).sort().join(','),
      'abandoned,finished,id,lastAt,page,problemId,questionIndex,startedAt',
    );

    const byId = Object.fromEntries(row.sessionList.map((item) => [item.id, item]));
    assertEquals(byId['s-new'].finished, true);
    assertEquals(byId['s-new'].abandoned, false, '做完了的永远不算放弃');
    assertEquals(byId['s-mid'].finished, false);
    assertEquals(byId['s-mid'].abandoned, false, '才 25 分钟没动，不算放弃');
    assertEquals(byId['s-mid'].page, 3, 'page 是该条会话自己走到过的最靠后那一页');
    assertEquals(byId['s-gone'].abandoned, true, '30 小时没动且没做完 —— 这就是放弃');
    assertEquals(byId['s-mid'].problemId, 'qbank-1');
    assertEquals(byId['s-mid'].startedAt, at(30 * MIN));
  });

  it('每人最多 50 条；超出时带 sessionListTruncated，不静默截断', async () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      sessionOf({ id: 's' + String(i).padStart(3, '0'), startedAt: at(i * MIN), lastAt: at(i * MIN) }),
    );
    const res = await callAdmin(oneUserStore(many), '/api/admin/users?batchId=b8');
    assertEquals(res.status, 200);

    const row = res.json[0];
    assertEquals(row.sessions, 51, '数字仍然是全部条数：截断只发生在列表上');
    assertEquals(row.sessionList.length, 50);
    assertEquals(row.sessionList[0].id, 's000', '切掉的是最旧的那一条，不是最新的');
    assertEquals(row.sessionList[49].id, 's049');
    assertEquals(row.sessionListTruncated, true, '截断必须说出来，否则"只有 50 条"会被读成"他只做了 50 道"');
    assertNotIncludes(res.text, 's050', '第 51 条不该出现在响应里');
  });

  it('正好 50 条时没有 sessionListTruncated（别把刚好够也标成截断）', async () => {
    const exact = Array.from({ length: 50 }, (_, i) =>
      sessionOf({ id: 's' + String(i).padStart(3, '0'), startedAt: at(i * MIN), lastAt: at(i * MIN) }),
    );
    const res = await callAdmin(oneUserStore(exact), '/api/admin/users?batchId=b8');
    assertEquals(res.json[0].sessionList.length, 50);
    assertEquals('sessionListTruncated' in res.json[0], false);
  });

  it('GET /api/admin/session 200：只回 meta / turns / reportSnapshot', async () => {
    const store = stubStore({
      getUserById: async () => ({ id: 'u1', displayName: 'S01' }),
      getSession: async (id) =>
        id === 's1'
          ? sessionOf({
              id: 's1',
              record: {
                problemId: 'qbank-1',
                turns: [
                  { role: 'student', text: '先把力分解', at: at(590e3) },
                  { role: 'ai', text: '先看合力方向\n再看加速度', at: at(589e3), level: 2, metaStep: 3, metaGraphId: 'g-9' },
                ],
                hintLog: [],
                formulaCards: [],
              },
              reportSnapshot: { independence: 0.6 },
            })
          : null,
    });

    const res = await callAdmin(store, '/api/admin/session?sessionId=s1');
    assertEquals(res.status, 200);
    assertEquals(Object.keys(res.json).sort().join(','), 'meta,reportSnapshot,turns');

    const meta = res.json.meta;
    assertEquals(
      Object.keys(meta).sort().join(','),
      'batchId,displayName,finished,id,lastAt,page,problemId,startedAt,userId',
    );
    assertEquals(meta.id, 's1');
    assertEquals(meta.displayName, 'S01');
    assertEquals(meta.problemId, 'qbank-1');
    assertEquals(meta.batchId, 'b8');
    assertEquals(meta.startedAt, at(60 * MIN));
    assertEquals(meta.finished, false);
    assertEquals(meta.page, 3);

    /** turns 按数组顺序，且只保留看对话真的要用的五档（第 1 条没有 level 就不带这个键） */
    assertEquals(res.json.turns.length, 2);
    assertEquals(Object.keys(res.json.turns[0]).sort().join(','), 'at,i,role,text');
    assertEquals(res.json.turns[0].i, 0);
    assertEquals(res.json.turns[0].role, 'student');
    assertEquals(res.json.turns[0].text, '先把力分解');
    assertEquals(res.json.turns[1].i, 1);
    assertEquals(res.json.turns[1].role, 'ai');
    assertEquals(res.json.turns[1].level, 2);
    assertIncludes(res.json.turns[1].text, '\n', '换行要原样带回来（页面用 pre-wrap 保住它）');

    assertDeep(res.json.reportSnapshot, { independence: 0.6 });

    /** 指向解题路径的两个字段不进响应：页面不显示它们，漏出去也没人会发现 */
    assertNotIncludes(res.text, 'metaStep');
    assertNotIncludes(res.text, 'metaGraphId');
    assertNotIncludes(res.text, 'g-9');
  });

  it('教师字段一条都不许漏：hintLog / rationale / evidenceQuotes / guardViolations / answerFingerprints / solutionGraphs', async () => {
    const store = stubStore({
      getSession: async () =>
        sessionOf({
          id: 's1',
          /** 会话顶层若真有这两样（题目侧的内部字段），整条 JSON 回去就会带出去 */
          answerFingerprints: ['af-secret'],
          solutionGraphs: ['sg-secret'],
          record: {
            problemId: 'qbank-1',
            turns: [{ role: 'student', text: '说点什么', at: at(590e3) }],
            hintLog: [
              {
                rationale: '不该给学生的推理',
                evidenceQuotes: ['题干里的原句'],
                guardViolations: [{ kind: 'leak', text: '被拦下的原话' }],
              },
            ],
            formulaCards: [],
          },
          reportSnapshot: { independence: 0.5 },
        }),
    });

    const res = await callAdmin(store, '/api/admin/session?sessionId=s1');
    assertEquals(res.status, 200);
    for (const needle of [
      'hintLog',
      'rationale',
      'evidenceQuotes',
      'guardViolations',
      'answerFingerprints',
      'solutionGraphs',
      /** 连值也不许出现：只挡键名的话，换个字段名就漏了 */
      '不该给学生的推理',
      '题干里的原句',
      '被拦下的原话',
      'af-secret',
      'sg-secret',
    ]) {
      assertNotIncludes(res.text, needle, `响应里出现了 ${needle}：整条 session 被 JSON 回去了`);
    }
  });

  it('缺 sessionId → 400；不存在 → 404；读不出来 → 503（三种不许混成一个答案）', async () => {
    const store = stubStore({
      getSession: async (id) => {
        if (id === 'boom') throw new Error('cloudbase: request timeout');
        return null;
      },
    });

    for (const path of ['/api/admin/session', '/api/admin/session?sessionId=']) {
      const missing = await callAdmin(store, path);
      assertEquals(missing.status, 400, `${path} 缺参数应当 400`);
      assertEquals(missing.json.error, '需要 sessionId');
    }

    const notFound = await callAdmin(store, '/api/admin/session?sessionId=nope');
    assertEquals(notFound.status, 404);
    assertEquals(notFound.json.error, '这条学习记录不存在');

    const failed = await callAdmin(store, '/api/admin/session?sessionId=boom');
    assertEquals(failed.status, 503);
    assertEquals(failed.json.error, '读取学习记录失败，请刷新页面重试。');
    assertEquals(failed.json.retryable, true);
    assertNotIncludes(failed.text, 'timeout', '读失败的详情进日志，不进响应体');
  });

  it('真 HTTP：这条路由由 handleAdminApi 处理（router.js 没有新增路由）', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      const res = await call(base, '/api/admin/session?sessionId=s1', { headers: withCode() });
      assertEquals(res.status, 200);
      assertEquals(res.json.meta.id, 's1');
      assertEquals(res.json.meta.displayName, 'S02', '代号来自 getUserById，与人的列表同源');
      assertEquals(res.json.meta.finished, true);
      assertEquals(res.json.meta.page, 4);
      assertEquals(res.json.turns.length, 1);
      assertEquals(res.json.turns[0].role, 'student');
      assertDeep(res.json.reportSnapshot, { independence: 0.6 });

      const missing = await call(base, '/api/admin/session?sessionId=nope', { headers: withCode() });
      assertEquals(missing.status, 404);
      assertEquals(missing.json.error, '这条学习记录不存在');

      /** 没有口令就是 401：同一个闸门，不因为路径是新的就绕过去 */
      const locked = await call(base, '/api/admin/session?sessionId=s1');
      assertEquals(locked.status, 401);
    });
  });
});

// ===========================================================================
// 十、页事件挂到会话（B2，终审阻塞项）
// ===========================================================================

/**
 * ============================================================================
 * 为什么会话必须拿到"自己那次打开"的事件
 * ============================================================================
 * 设计稿 §5.2：页 1–2 的事件挂在 `visit.id` 上（会话要到进第 3 页才创建），
 * 之后的才同时带 `sessionId` 与 `visitId`。而漏斗的页 3–4 与导出的
 * 「退回次数 / 报告次数 / 改入场次数」读的都是 **`session.events`**。
 *
 * 只按 `sessionId` 分组时，这几列在真实数据上**恒为 0** —— 而且是"确定的 0"：
 * `hasEvents` 为真（会话自己有 chat_send），于是连 counters 兜底也不会走。
 * 一个恒为 0 的操作列，比一个空列更难发现：0 看起来像"学生没做"。
 *
 * 页 1–2 的停留仍只从 `visit.events` 读（metrics 的约定），所以两边都拼**不会**重复计。
 */
describe('管理接口 · 页事件挂到会话', () => {
  const T = Date.parse('2026-11-10T09:00:00.000Z');
  const iso = (offset) => new Date(T + offset).toISOString();

  const VISIT = { id: 'v1', userId: 'u1', batchId: 'b8', openedAt: iso(0), lastAt: iso(60_000) };

  /**
   * 真实形状：页 3 / 页 2 的事件**只带 `visitId`**（会话那时还不存在），
   * 会话自己只有那条 `chat_send`。
   */
  const pageEvents = () => [
    { seq: 1, type: 'page_enter', at: iso(0), batchId: 'b8', userId: 'u1', visitId: 'v1', sessionId: null, payload: { page: 3 } },
    { seq: 2, type: 'page_enter', at: iso(30_000), batchId: 'b8', userId: 'u1', visitId: 'v1', sessionId: null, payload: { page: 2 } },
    { seq: 3, type: 'page_exit', at: iso(60_000), batchId: 'b8', userId: 'u1', visitId: 'v1', sessionId: null, payload: { page: 2 } },
    { seq: 4, type: 'chat_send', at: iso(90_000), batchId: 'b8', userId: 'u1', visitId: 'v1', sessionId: 's1', payload: { len: 8 } },
  ];

  const SESSION = {
    id: 's1',
    visitId: 'v1',
    userId: 'u1',
    batchId: 'b8',
    problemId: 'qbank-1',
    questionIndex: 0,
    startedAt: iso(0),
    lastAt: iso(90_000),
    finishedAt: null,
    progress: { maxPage: 3, reached: { p2: iso(30_000), p3: iso(0) } },
    counters: {},
    turns: [],
  };

  /** CSV 的第一条数据行（表头当键）。导出件的形状在 export-batch.test.js 里另有整组用例。 */
  function firstCsvRow(csv) {
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    const headers = lines[0].split(',');
    const cells = lines[1].split(',');
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  }

  it('overview 的页 3 停留不再是 0（事件只挂 visit 时它是结构性的 0）', async () => {
    const store = stubStore({
      listSessionsByBatch: async () => [SESSION],
      listEventsByBatch: async () => pageEvents(),
      getVisit: async () => VISIT,
    });

    const res = await callAdmin(store, '/api/admin/overview?batchId=b8');
    assertEquals(res.status, 200);

    const page3 = res.json.funnel.perPage.find((row) => row.page === 3);
    assertEquals(page3.visitors, 1, '这一页应当有一个到过的人');
    assert(page3.avgDwellMs > 0, `页 3 停留必须是正数，实际 ${page3.avgDwellMs}（0 就是"会话没拿到 visit 的事件"）`);
  });

  it('renderSessionsCsv 的「退回次数」是 1（3→2），不是硬 0', () => {
    const stitched = stitchEvents(pageEvents(), [SESSION], [VISIT]);
    const row = firstCsvRow(
      renderSessionsCsv(stitched.sessions, { batch: { id: 'b8', abandonHours: 24 }, now: iso(90_000) }),
    );

    assertEquals(row['会话id'], 's1');
    assertEquals(row['退回次数'], '1', '3→2 是"从 n 页退到 n−1 页"的一步；写 0 说明会话没拿到 visit 的事件');
    /** 反过来也要成立：页事件不能把会话自己的事件挤掉 */
    assertEquals(row['对话轮数'], '1', '会话自己的 chat_send 仍在');
  });

  it('会话自己的事件与 visit 的事件按 seq 合并（不是"先自己的、再 visit 的"）', () => {
    const stitched = stitchEvents(pageEvents(), [SESSION], [VISIT]);
    assertEquals(
      stitched.sessions[0].events.map((event) => event.seq).join(','),
      '1,2,3,4',
      'deriveDwell 读的是数组顺序，不是 seq：合并成 4,1,2,3 会让"下一条事件"变成更早的时刻',
    );
  });

  it('一次打开下的每条会话都拿到这次打开的事件（同一份数据，不重复挂同一个会话）', () => {
    const second = { ...SESSION, id: 's2', problemId: 'qbank-2' };
    const stitched = stitchEvents(pageEvents(), [SESSION, second], [VISIT]);
    const byId = Object.fromEntries(stitched.sessions.map((session) => [session.id, session.events.map((event) => event.seq).join(',')]));

    assertEquals(byId.s1, '1,2,3,4', '两条会话都在 v1 里：页 1–2 的事件两边都要拿到');
    assertEquals(byId.s2, '1,2,3', '带 sessionId 的 chat_send 只属于 s1，不挂给 s2');
    /** 一条带 sessionId 的事件只挂它自己那条会话：两边都挂会把同一段时间算两遍 */
    assertEquals(stitched.visits[0].events.map((event) => event.seq).join(','), '1,2,3', 'visit 那一侧仍然只有它自己的事件');
  });
});

// ===========================================================================
// 十一、系统失败轮次（B3，终审阻塞项）
// ===========================================================================

/**
 * ============================================================================
 * 为什么要有这个数：一个"全失败"的批次和"没人来"的批次，在页面上长得一模一样
 * ============================================================================
 * `TURN_SLOW` / `UPSTREAM` 在会话落库之前就返回了（那一轮没写成学习记录），
 * 于是这一批只剩客户端发的 `chat_send`，一条会话行都没有。看板于是显示
 * 「0 会话 · 0.0% 一轮失败率」，而 `p1 > 0` 又让空态不触发 ——
 * 这个数正是决定"要不要换平台"的那一屏，它现在把系统性失败读成"学生没来"。
 *
 * 口径：**有 `chat_send`、但这一批里没有任何会话认领它**的轮数。
 * 会话行的归属键（`sessionId` / `visitId`）都不在会话表里，就说明那一轮
 * 没写进学习记录 —— 要么是模型 Key 不对，要么是超时。
 */
describe('管理接口 · 系统失败轮次（orphanTurns）', () => {
  const T = Date.parse('2026-11-10T09:00:00.000Z');
  const iso = (offset) => new Date(T + offset).toISOString();

  /** 三条客户端发的 chat_send：会话 id 是前端造的，服务端从来没有落成一条会话行 */
  const orphanSends = () => [0, 1, 2].map((i) => ({
    seq: i + 1,
    type: 'chat_send',
    at: iso(i * 1000),
    batchId: 'b8',
    userId: 'u1',
    sessionId: `lost-${i}`,
    visitId: null,
    payload: { len: 3 },
  }));

  it('三条 chat_send、没有会话行 → usage.orphanTurns 是 3', async () => {
    const store = stubStore({ listEventsByBatch: async () => orphanSends() });
    const res = await callAdmin(store, '/api/admin/overview?batchId=b8');

    assertEquals(res.status, 200);
    assertEquals(res.json.summary.sessionCount, 0, '这一批确实没有一条会话（失败发生在落库之前）');
    assertEquals(res.json.usage.orphanTurns, 3, '三条 chat_send 没有任何会话认领');
  });

  it('有会话认领其中一条 → orphanTurns 变成 2', async () => {
    const store = stubStore({
      listSessionsByBatch: async () => [
        { id: 'lost-0', batchId: 'b8', userId: 'u1', startedAt: iso(0), lastAt: iso(500), progress: {}, counters: {}, turns: [] },
      ],
      listEventsByBatch: async () => orphanSends(),
    });
    const res = await callAdmin(store, '/api/admin/overview?batchId=b8');

    assertEquals(res.status, 200);
    assertEquals(res.json.summary.sessionCount, 1);
    assertEquals(res.json.usage.orphanTurns, 2, '被会话认领的那条不算孤儿');
  });

  it('正常批次是 0（看板据此不显示这一项，不留一行恒为 0 的噪音）', async () => {
    await withAdminServer({}, async ({ base, store }) => {
      await seed(store);
      const res = await call(base, '/api/admin/overview?batchId=b8', { headers: withCode() });
      assertEquals(res.status, 200);
      assertEquals(res.json.usage.orphanTurns, 0, '夹具里的每条 chat_send 都属于某条会话');
    });
  });
});
