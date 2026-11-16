/**
 * 免口令进场 · 完成码（这一版的核心链路）
 *
 * ============================================================================
 * 这个套件守什么
 * ============================================================================
 * 学生的身份从一个"事前发的 6 位口令"换成了"事后发的 6 位完成码"，而进门
 * 变成零成本。最容易坏的不是界面，是下面这五条：
 *
 *   ① 领票是免费的，但**记录仍然要挂在某个人名下**（否则归属判定恒真）；
 *   ② 一次坐下来**只有一个码**（刷新、锁屏回来都不该变成第二次使用）；
 *   ③ 收尾是**幂等**的（点两次、断网重试都回同一个码）；
 *   ④ 码能查出**那一次**，且查不出别人的；
 *   ⑤ 老师打开看板**不写任何东西**（超时的那条只显示"已超时"，不补码）。
 *
 * 用真实 HTTP 跑，因为这几条都发生在路由层：直接调 usage.js 证明不了
 * "401 会不会漏"、"带错票会不会读到别人的码"。
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, assert, assertEquals, assertIncludes, assertNotIncludes } from './runner.js';
import { ROOT } from '../src/core/env.js';
import { openStore } from '../src/server/store/index.js';
import { mintVisitor, resolveToken } from '../src/server/auth.js';

const ADMIN_CODE = 'admin-code-usage';
const DEV_CODE = 'dev-code-usage';

const pilotHtml = () => readFileSync(join(ROOT, 'public/pilot.html'), 'utf8');
const adminHtml = () => readFileSync(join(ROOT, 'public/admin.html'), 'utf8');

/**
 * 起一个真服务，配置按请求注入（与 pilot-ui / session-persist 同一套做法）。
 * 显式摘掉 Key：开发者的 `.env` 里带着真 Key，不摘就会打真模型。
 */
async function withServer(envPatch, fn) {
  const { createServer } = await import('node:http');
  const { handleApi, getStore, __resetStoreForTests, requestEnv } = await import('../src/server/router.js');
  const dir = mkdtempSync(join(tmpdir(), 'bsj-usage-http-'));
  const env = { ...process.env, STORE: 'file', STORE_DIR: dir };
  delete env.LLM_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.PILOT_REQUIRE_LOGIN;
  delete env.PILOT_DEV_CODE;
  delete env.ADMIN_CODE;
  Object.assign(env, envPatch ?? {});
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
    return await fn({ base, store, dir, env });
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

const mint = (base, displayName) =>
  call(base, '/api/auth/visitor', { method: 'POST', body: { displayName } });

const start = (base, token) =>
  call(base, '/api/usage/start', { method: 'POST', body: {}, headers: { 'x-test-token': token } });

const current = (base, token) =>
  call(base, '/api/usage/current', { headers: { 'x-test-token': token } });

const end = (base, token, body = {}) =>
  call(base, '/api/usage/end', { method: 'POST', body, headers: { 'x-test-token': token } });

const adminGet = (base, path) =>
  call(base, path, { headers: { 'x-admin-code': ADMIN_CODE } });

/** 北京时间的那一天（与 usage.js 的 dayWindow 同口径） */
const beijingDay = (iso) => new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 10);

// ===========================================================================

describe('批次标签 · 老票也要归批', () => {
  it('票上没有批次时，按当前 PILOT_BATCH_ID 回落（否则改标签前签出去的浏览器永远不归批）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsj-batch-'));
    const store = await openStore({ STORE: 'file', STORE_DIR: dir });
    try {
      /** 模拟"改动之前发出去的票"：批次是 null */
      const issued = await mintVisitor(store, { displayName: '老票', batchId: null });

      const withoutFallback = await resolveToken(store, issued.token);
      assertEquals(withoutFallback.batchId, null);

      const withFallback = await resolveToken(store, issued.token, Date.now(), 'pilot-1');
      assertEquals(withFallback.batchId, 'pilot-1');
      assertEquals(withFallback.user.displayName, '老票');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('免口令进场 · 页面接线（静态契约）', () => {
  it('学生页默认是问候屏，口令那一屏默认藏着（?key=1 才出来）', () => {
    const s = pilotHtml();
    assertIncludes(s, 'data-testid="hello"');
    assertIncludes(s, 'id="helloGo"');
    assertIncludes(s, 'id="helloSkip"');
    assert(/id="gate"[^>]*hidden/.test(s), '口令那一屏默认必须隐藏，否则学生一进门就看到它');
    assertIncludes(s, 'key=1', '调试与看板的分流靠 ?key=1');
  });

  it('学生页真的调这三个新接口，且"结束使用"在顶栏上', () => {
    const s = pilotHtml();
    assertIncludes(s, '/api/auth/visitor');
    assertIncludes(s, '/api/usage/start');
    assertIncludes(s, '/api/usage/end');
    assertIncludes(s, '结束使用', '顶栏按钮的文案就是学生唯一要学的动作');
    assertIncludes(s, 'data-testid="done"', '收尾页必须有稳定锚点');
  });

  it('收尾页不出现"完整报告"入口（结束是终态）', () => {
    assertNotIncludes(pilotHtml(), '查看完整报告');
  });

  it('「再练一次」说明会换新码，且第二次结束后仍然可点', () => {
    const s = pilotHtml();
    assertIncludes(s, '再练一次（会换新码）', '按钮文案要说清"会换码"，否则学生会以为码该不变');
    assertIncludes(s, '会给你另一个完成码');
    /**
     * 这一条是真踩过的：按钮点下去先 disable 防连点，只有失败分支把它打开，
     * 于是"第二次结束之后，再练一次点不动了"，而且不报错。
     */
    assertIncludes(s, 'againBtn.disabled = false', '收尾页必须把按钮重新打开');
  });

  it('看板两个新入口接的是新接口，完成码不走口令那个参数', () => {
    const s = adminHtml();
    assertIncludes(s, 'id="usageCode"');
    assertIncludes(s, '/api/admin/usage?usageCode=');
    assertIncludes(s, '/api/admin/day');
    assertIncludes(s, 'id="dayInput"');
  });

  it('按码查出来的每一题都能就地展开对话（复用看板那一份渲染，不再自己拼一套）', () => {
    const s = adminHtml();
    assertIncludes(s, 'readUsageTurns');
    assertIncludes(s, '/api/admin/session?sessionId=');
    assertIncludes(s, '查看对话');
    /** 对话渲染只许有一份：两边各写一份，迟早一边把学生原话当标记渲染 */
    assertIncludes(s, 'function renderTurns');
  });
});

describe('免口令进场 · 领票', () => {
  it('不输任何口令就能拿到一张票，形状是 g- 开头，且带称呼', async () => {
    await withServer({}, async ({ base }) => {
      const r = await mint(base, '王浩');
      assertEquals(r.status, 200);
      assertEquals(r.json.role, 'visitor');
      assert(/^[0-9a-f]{64}$/.test(String(r.json.token)), '应当签发 32 字节令牌');
      assert(/^g-[0-9a-f]{16}$/.test(String(r.json.userId)), `访客 id 形状应为 g-<16hex>，实际 ${r.json.userId}`);
      assertEquals(r.json.displayName, '王浩');
      assertEquals(r.json.code, undefined, '响应里不该出现任何口令');
    });
  });

  it('称呼可以跳过（空串），也可以被截到 24 字', async () => {
    await withServer({}, async ({ base }) => {
      const blank = await mint(base, '');
      assertEquals(blank.status, 200);
      assertEquals(blank.json.displayName, '');

      const long = await mint(base, '一二三四五六七八九十一二三四五六七八九十一二三四五六');
      assertEquals([...long.json.displayName].length, 24);
    });
  });

  it('没有票 → /api/usage/current 与 /api/usage/end 都是 401（不是"空数据"）', async () => {
    await withServer({}, async ({ base }) => {
      const a = await current(base, '');
      assertEquals(a.status, 401);
      assertEquals(a.json.code, 'AUTH_REQUIRED');

      const b = await end(base, '', {});
      assertEquals(b.status, 401);
    });
  });

  it('PILOT_REQUIRE_LOGIN=1 时，领票仍然放行（否则没人进得来）', async () => {
    await withServer({ PILOT_REQUIRE_LOGIN: '1' }, async ({ base }) => {
      const r = await mint(base, '');
      assertEquals(r.status, 200);
      const started = await start(base, r.json.token);
      assertEquals(started.status, 200);
    });
  });

  it('票上带批次标签 pilot-1，批次记录会被自动建出来（否则老看板按批次查会 404）', async () => {
    await withServer({}, async ({ base, store }) => {
      const r = await mint(base, '');
      assertEquals(r.json.batchId, 'pilot-1');

      const batch = await store.getBatch('pilot-1');
      assert(batch, '批次记录应当在领票时被建出来，否则按批次查会回 404');
      assertEquals(batch.label, 'pilot-1');

      const started = await start(base, r.json.token);
      const visit = await store.getVisit(started.json.visitId);
      assertEquals(visit.batchId, 'pilot-1', 'visit 上的批次要与票一致');
    });
  });

  it('PILOT_BATCH_ID 配成空串 → 不归批，visit.batchId 是 null', async () => {
    await withServer({ PILOT_BATCH_ID: '' }, async ({ base, store }) => {
      const r = await mint(base, '');
      assertEquals(r.json.batchId, null);
      const started = await start(base, r.json.token);
      const visit = await store.getVisit(started.json.visitId);
      assertEquals(visit.batchId, null);
    });
  });
});

describe('免口令进场 · 一次使用', () => {
  it('开始 → 拿到 v- 开头的 visitId；再点一次开始是"接着用"，不是新的一次', async () => {
    await withServer({}, async ({ base }) => {
      const { json: ticket } = await mint(base, '李雷');
      const first = await start(base, ticket.token);
      assertEquals(first.status, 200);
      assert(/^v-/.test(String(first.json.visitId)), `visitId 形状应为 v-…，实际 ${first.json.visitId}`);
      assertEquals(first.json.resumed, false);

      const second = await start(base, ticket.token);
      assertEquals(second.status, 200);
      assertEquals(second.json.visitId, first.json.visitId, '两小时内回来必须还是同一次使用');
      assertEquals(second.json.resumed, true);
    });
  });

  it('两张票就是两次使用（换浏览器 = 新的人）', async () => {
    await withServer({}, async ({ base }) => {
      const a = await mint(base, 'A');
      const b = await mint(base, 'B');
      const va = await start(base, a.json.token);
      const vb = await start(base, b.json.token);
      assert(va.json.visitId !== vb.json.visitId);
    });
  });
});

describe('结束使用 · 完成码', () => {
  it('结束 → 6 位数字码；再结束一次回同一个码（幂等）', async () => {
    await withServer({}, async ({ base }) => {
      const { json: ticket } = await mint(base, '韩梅梅');
      const { json: usage } = await start(base, ticket.token);

      const done = await end(base, ticket.token, { visitId: usage.visitId });
      assertEquals(done.status, 200);
      assert(/^\d{6}$/.test(String(done.json.code)), `完成码必须是 6 位数字，实际 ${done.json.code}`);
      assertEquals(done.json.summary.sessionCount, 0, '只打开没做题也是一次合法的使用');

      /** 指针已经清掉，但请求里带着 visitId —— 必须回同一个码，不能回 409 */
      const again = await end(base, ticket.token, { visitId: usage.visitId });
      assertEquals(again.status, 200);
      assertEquals(again.json.code, done.json.code);
      assertEquals(again.json.reused, true);
    });
  });

  it('结束之后 current 是空的，而 lastEnded 带着刚才那个码（刷新也不会丢）', async () => {
    await withServer({}, async ({ base }) => {
      const { json: ticket } = await mint(base, '');
      const { json: usage } = await start(base, ticket.token);
      const done = await end(base, ticket.token, { visitId: usage.visitId });

      const cur = await current(base, ticket.token);
      assertEquals(cur.status, 200);
      assertEquals(cur.json.visit, null);
      assertEquals(cur.json.lastEnded.code, done.json.code);
      assertEquals(cur.json.lastEnded.visitId, usage.visitId);
    });
  });

  it('两次使用拿到两个不同的码', async () => {
    await withServer({}, async ({ base }) => {
      const { json: ticket } = await mint(base, '');
      const a = await start(base, ticket.token);
      const ca = await end(base, ticket.token, { visitId: a.json.visitId });
      const b = await start(base, ticket.token);
      assert(b.json.visitId !== a.json.visitId, '结束之后再开始，必须是一次新的使用');
      const cb = await end(base, ticket.token, { visitId: b.json.visitId });
      assert(ca.json.code !== cb.json.code);
    });
  });

  it('超时（两小时没动静）→ current 当场收尾，并把码交回来', async () => {
    await withServer({}, async ({ base, store }) => {
      const { json: ticket } = await mint(base, '');
      const { json: usage } = await start(base, ticket.token);

      /** 把开场时间推到三小时前：模拟"没点结束就走了" */
      const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
      const visit = await store.getVisit(usage.visitId);
      await store.putVisit({ ...visit, openedAt: old, lastAt: old });

      const cur = await current(base, ticket.token);
      assertEquals(cur.json.visit, null, '超时的不该再被当成"进行中"');
      assert(/^\d{6}$/.test(String(cur.json.lastEnded.code)), '自动收尾也要给一个码');

      const stored = await store.getVisit(usage.visitId);
      assertEquals(stored.endReason, 'idle');
      assertEquals(stored.code, cur.json.lastEnded.code);
    });
  });

  it('结束别人的使用 → 不会拿到别人那个码', async () => {
    await withServer({}, async ({ base }) => {
      const a = await mint(base, '甲');
      const b = await mint(base, '乙');
      const va = await start(base, a.json.token);
      await end(base, a.json.token, { visitId: va.json.visitId });

      const steal = await end(base, b.json.token, { visitId: va.json.visitId });
      assertEquals(steal.status, 409, '别人的 visitId 不该能收尾');
      assertEquals(steal.json.code, 'USAGE_ENDED');
    });
  });
});

describe('看板 · 按完成码 / 按日期', () => {
  it('老师用码查得到那一次使用，且查不到别的码', async () => {
    await withServer({ ADMIN_CODE }, async ({ base }) => {
      const { json: ticket } = await mint(base, '赵四');
      const { json: usage } = await start(base, ticket.token);
      const done = await end(base, ticket.token, { visitId: usage.visitId });

      const found = await adminGet(base, `/api/admin/usage?usageCode=${done.json.code}`);
      assertEquals(found.status, 200);
      assertEquals(found.json.code, done.json.code);
      assertEquals(found.json.usage.displayName, '赵四');
      assertEquals(found.json.usage.visitId, usage.visitId);
      assertEquals(found.json.usage.endedAt, done.json.endedAt);

      const missing = await adminGet(base, '/api/admin/usage?usageCode=000001');
      assertEquals(missing.status, 404);
    });
  });

  it('码的形状不对 → 400（不做模糊匹配）', async () => {
    await withServer({ ADMIN_CODE }, async ({ base }) => {
      const r = await adminGet(base, '/api/admin/usage?usageCode=123');
      assertEquals(r.status, 400);
    });
  });

  it('老的"按批次"看板仍然能用：overview?batchId=pilot-1 返回 200', async () => {
    await withServer({ ADMIN_CODE }, async ({ base }) => {
      const t = await mint(base, '批次验证');
      await start(base, t.json.token);
      const ov = await adminGet(base, '/api/admin/overview?batchId=pilot-1');
      assertEquals(ov.status, 200);
      assertEquals(ov.json.batch.id, 'pilot-1');
    });
  });

  it('看板要有口令：没带 x-admin-code → 401', async () => {
    await withServer({ ADMIN_CODE }, async ({ base }) => {
      const r = await call(base, '/api/admin/usage?usageCode=123456');
      assertEquals(r.status, 401);
    });
  });

  it('按日期能看到这一天的那一次使用，且码就在行里', async () => {
    await withServer({ ADMIN_CODE }, async ({ base, store }) => {
      const { json: ticket } = await mint(base, '钱七');
      const { json: usage } = await start(base, ticket.token);
      const done = await end(base, ticket.token, { visitId: usage.visitId });

      const visit = await store.getVisit(usage.visitId);
      const day = beijingDay(visit.openedAt);
      const r = await adminGet(base, `/api/admin/day?date=${day}`);
      assertEquals(r.status, 200);
      assertEquals(r.json.day, day);
      const row = (r.json.rows || []).find((x) => x.visitId === usage.visitId);
      assert(row, '这一天的流水里必须有刚才那一次使用');
      assertEquals(row.code, done.json.code);
      assertEquals(row.displayName, '钱七');
      assertEquals(row.endedAt, done.json.endedAt);
    });
  });

  it('看板读流水不写任何东西：超时的那一条只显示 idle，不会替它补码', async () => {
    await withServer({ ADMIN_CODE }, async ({ base, store }) => {
      const { json: ticket } = await mint(base, '孙八');
      const { json: usage } = await start(base, ticket.token);

      const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
      const visit = await store.getVisit(usage.visitId);
      await store.putVisit({ ...visit, openedAt: old, lastAt: old });

      const day = beijingDay(old);
      const r = await adminGet(base, `/api/admin/day?date=${day}`);
      const row = (r.json.rows || []).find((x) => x.visitId === usage.visitId);
      assert(row, '超时的那一次仍要出现在流水里');
      assertEquals(row.idle, true);
      assertEquals(row.code, null, '看板不该补码');

      /** 再读一次，数据一个字节都不该变 */
      const stored = await store.getVisit(usage.visitId);
      assertEquals(stored.code, null);
      assertEquals(stored.endedAt, null);
    });
  });
});

