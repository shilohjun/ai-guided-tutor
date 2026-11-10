/**
 * 试点入口 · 一扇门，三把钥匙（Task 10 重做版）。
 *
 * ============================================================================
 * 这个套件守什么
 * ============================================================================
 * 产品页 `public/index.html` 是成品，一个字节都不许改（已回滚到 `5ef9948`）。
 * 所以试点层不是"改产品页"，而是**另起一页**：`public/pilot.html` ——
 * 一扇门，三把钥匙：
 *
 *   ① **学生钥匙** —— 口令命中 `test_user.codeHash` → 签发令牌；
 *   ② **开发钥匙** —— 命中 `PILOT_DEV_CODE` → 签发令牌，但身份是 `dev-<6 位>`
 *      且批次是 `dev`，**绝不进任何真实批次**；
 *   ③ **管理员钥匙** —— 命中 `ADMIN_CODE` → **不发令牌**（管理员用 `x-admin-code`，
 *      两把钥匙不许互相开锁）。
 *
 * 判定顺序固定为「学生 → 开发 → 管理员」。任何一档都不在响应里透露
 * "命中了哪一档但另一档失败" —— 那等于给枚举脚本一个免费的提示。
 *
 * ============================================================================
 * 为什么分三层测
 * ============================================================================
 *   ① **静态契约**（读 HTML 源码）：本项目零运行时依赖，没有 jsdom。
 *      能静态钉住的是"注入点只有一个"、"没有第五页"、"没有把开场说明/题单条/
 *      续做条偷偷加回来"这类**结构性**事实 —— 它们一旦漂移，症状是"埋点悄悄少了一半"，
 *      而页面照常能用，没人会发现。
 *   ② **login() 纯函数层**：三档的返回形状、判定顺序、开发档不落 `test_user`。
 *   ③ **真实 HTTP**：401/429 的文案与状态码、"管理员不发 token"、限速对三档都生效、
 *      以及开发档的数据进 `dev` 批次且真实批次的导出里一个字都不含它。
 *      这几件事只发生在路由层，直接调 `login()` 证明不了。
 *
 * ============================================================================
 * 刻意没有的东西
 * ============================================================================
 * 开场说明（`intro`）、题单条（`question-list`）、续做条（`resume-bar`）——
 * 上一版做进产品页的三块，产品负责人看过之后明确不要了。这里用"不含"断言钉住，
 * 免得下一次改动顺手把它们加回来。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, assert, assertEquals, assertIncludes, assertNotIncludes } from './runner.js';
import { ROOT } from '../src/core/env.js';
import { openStore } from '../src/server/store/index.js';
import {
  CODE_MAX_FAILURES,
  IP_MAX_FAILURES,
  hashCode,
  issueAccounts,
  login,
  resetLoginRateLimits,
  resolveToken,
} from '../src/server/auth.js';
import { exportBatch } from '../src/server/export.js';

/** 题库里真实存在的一道题：/api/chat 要求 problemId 能查到题 */
const P1 = 'phy-emi-01';

/**
 * 两把"不是 6 位数字"的钥匙。
 *
 * 故意带连字符与字母：学生口令是 6 位数字，而开发/管理员口令可以是任意串。
 * 若哪天有人把输入框限制成"只能输数字"，这两个套件会第一个发现。
 */
const DEV_CODE = 'dev-code-7f3a';
const ADMIN_CODE = 'admin-code-9c2b';

const pilotHtml = () => readFileSync(join(ROOT, 'public/pilot.html'), 'utf8');
const indexHtml = () => readFileSync(join(ROOT, 'public/index.html'), 'utf8');

/** 一个子串在文本里出现的次数（"注入点只有一个"用它钉） */
const countOf = (text, needle) => String(text).split(needle).length - 1;

/** 每档一个干净的临时库：共用一个库会让"哪些号已经发过"互相污染 */
async function setup() {
  return openStore({ STORE: 'file', STORE_DIR: mkdtempSync(join(tmpdir(), 'bsj-pilot-')) });
}

// ===========================================================================
// 一、入口页的静态契约
// ===========================================================================

describe('试点入口 · 独立成页，不寄生在成品页里', () => {
  it('public/pilot.html 存在，且是一份完整的页面（不是片段）', () => {
    /**
     * 这条是 RED 的起点：文件不存在时 `readFileSync` 直接抛，
     * 报错就是"没有这个文件"——那正是"还没建"的正确形状。
     */
    const s = pilotHtml();
    assert(s.length > 2000, `试点入口应当是一份完整页面，实际只有 ${s.length} 个字符`);
    assertIncludes(s, '<iframe', '试点层要靠同源 iframe 载入成品页');
    assertIncludes(s, 'src="/index.html"', 'iframe 必须同源、且指向成品页');
  });

  it('成品页里没有试点层（谁把登录屏塞回 index.html，这条会红）', () => {
    const s = indexHtml();
    assertNotIncludes(s, 'data-testid=', 'index.html 是成品页，不该出现试点层的 data-testid');
    assertNotIncludes(s, 'x-test-token', 'index.html 不该自己带令牌注入');
  });

  it('登录屏在，且四个被砍掉的老块一个都不在', () => {
    const s = pilotHtml();
    assertIncludes(s, 'data-testid="login"', '登录屏必须有稳定的测试锚点');
    for (const gone of ['data-testid="intro"', 'data-testid="question-list"', 'data-testid="resume-bar"']) {
      assertNotIncludes(s, gone, `产品负责人已经砍掉这一块：${gone}`);
    }
  });

  it('没有"第 5 页"这种写法（产品只有四页）', () => {
    assertNotIncludes(pilotHtml(), '第 5 页');
  });

  it('令牌请求头只在一个地方写（多写一处就是两套身份）', () => {
    const s = pilotHtml();
    assertEquals(
      countOf(s, 'x-test-token'),
      1,
      '令牌头的字面量应当只出现一次：注入 iframe 与页面自己的请求都走同一个函数，'
        + '两处各写一份迟早会出现"某个接口带了、另一个没带"',
    );
  });

  it('埋点走 /api/events，且用 keepalive 保证关标签页也能送出去', () => {
    const s = pilotHtml();
    assertIncludes(s, '/api/events');
    assertIncludes(s, 'keepalive');
  });

  it('iframe 里的翻页靠 MutationObserver 观察 data-page，不是靠轮询', () => {
    const s = pilotHtml();
    assertIncludes(s, 'MutationObserver');
    assertIncludes(s, 'data-page');
  });

  it('管理员那把钥匙落在 bsj-admin 并跳看板（看板已经在读这个键）', () => {
    const s = pilotHtml();
    assertIncludes(s, "'bsj-admin'");
    assertIncludes(s, '/admin.html');
  });

  it('客户端只发它算得出来的那九种事件，不发 chat_reply', () => {
    /**
     * `chat_send` 只有客户端知道"首条消息多长、是不是复制了题干"，
     * `chat_reply` 只有服务端知道"耗时多少、有没有被抑制"。
     * 两边各发一半，"有 send 无 reply"的一轮失败率才是有意义的数；
     * 客户端也发 chat_reply（或服务端也发 chat_send）会让分母翻倍。
     */
    const s = pilotHtml();
    for (const type of [
      'login',
      'visit_open',
      'page_enter',
      'page_exit',
      'intake_choose',
      'ocr_call',
      'ocr_result',
      'import_result',
      'chat_send',
    ]) {
      assertIncludes(s, `'${type}'`, `客户端应当发 ${type}`);
    }
    assertNotIncludes(s, "type: 'chat_reply'", 'chat_reply 只能由服务端发');
    assertNotIncludes(s, "type: 'chat_send'", 'chat_send 只由客户端发，且只该有一处');
  });

  it('不用 innerHTML 拼数据（拼错一个引号就是把学生输入当代码执行）', () => {
    assertNotIncludes(pilotHtml(), 'innerHTML');
  });

  it('页面自带全部资源，不引 CDN、不引外部脚本', () => {
    const s = pilotHtml();
    assert(!/<script[^>]+\ssrc=/i.test(s), '试点入口不应引外部脚本（试点网络环境里 CDN 常常不可达）');
    assert(!/<link[^>]+\shref=["']https?:/i.test(s), '试点入口不应引外部样式表');
  });

  it('文案是中文，且登录屏不暗示还有别的钥匙', () => {
    const s = pilotHtml();
    assertIncludes(s, '口令', '登录屏至少要说清输入的是什么');
    assertNotIncludes(s, '调试口令', '登录屏不该出现"调试"字样，那等于告诉学生有第二把钥匙');
    assertNotIncludes(s, '管理员口令', '同理：登录屏不该出现"管理员"');
  });
});

// ===========================================================================
// 二、三档判定（login 纯函数）
// ===========================================================================

describe('三把钥匙 · 判定与返回形状', () => {
  it('学生口令 → role:student，令牌能解回同一个人', async () => {
    const s = await setup();
    const [{ code, displayName }] = await issueAccounts(s, { batchId: 'b1', count: 1 });
    const r = await login(s, code, '10.1.0.1', Date.now(), { PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE });

    assertEquals(r?.role, 'student', '命中 test_user 的就是学生');
    assert(r.token, '学生要拿到令牌');
    assertEquals(r.user.displayName, displayName);
    assertEquals(r.batchId, 'b1');
    const back = await resolveToken(s, r.token);
    assertEquals(back.user.id, r.user.id, '令牌必须能解回同一个人');
  });

  it('PILOT_DEV_CODE → role:dev，displayName 是「调试」，batchId 是 dev', async () => {
    const s = await setup();
    const r = await login(s, DEV_CODE, '10.1.0.2', Date.now(), { PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE });

    assertEquals(r?.role, 'dev');
    assertEquals(r.user.displayName, '调试');
    assertEquals(r.batchId, 'dev', '开发档的批次必须写死成 dev —— 那是"不污染真实批次"的唯一开关');
    assert(r.token, '开发档也要令牌，否则 iframe 里的每个接口都会 401');
    assert(/^dev-[0-9a-f]{6}$/.test(r.user.id), `开发身份应是 dev-<6 位随机>，实际：${r.user.id}`);
  });

  it('开发档不在 test_user 里建账号（真实批次的名单永远不会多出一个人）', async () => {
    /**
     * 这是 K3 的原话：「不要在 `test_user` 里建开发账号」。
     * 若开发档也 putUser 一条 `batches:['dev']` 的记录，
     * 任何"按批次列人"的地方都会多出一个"调试"，而它不属于任何一份名单。
     * 开发身份由**令牌本身**承载（见 resolveToken），不进名单。
     */
    const s = await setup();
    const r = await login(s, DEV_CODE, '10.1.0.3', Date.now(), { PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE });
    assert(r?.token);

    assertEquals((await s.listUsers('dev')).length, 0, 'dev 批次里不该有"人"');
    assertEquals(await s.getUser(hashCode(DEV_CODE)), null, '开发口令不该在 test_user 里留下任何记录');
  });

  it('开发档的令牌解出来仍是 batchId=dev（没有 user 记录也要能解）', async () => {
    const s = await setup();
    const r = await login(s, DEV_CODE, '10.1.0.4', Date.now(), { PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE });
    const back = await resolveToken(s, r.token);
    assert(back, '开发令牌必须解得出来，否则 iframe 里第一步就 401');
    assertEquals(back.batchId, 'dev');
    assertEquals(back.user.id, r.user.id);
    assertEquals(back.user.displayName, '调试');
  });

  it('ADMIN_CODE → role:admin，且**没有** token（管理员不冒充学生）', async () => {
    const s = await setup();
    const r = await login(s, ADMIN_CODE, '10.1.0.5', Date.now(), { PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE });

    assertEquals(r?.role, 'admin');
    assertEquals(r.token, undefined, '管理员不该拿到学生令牌 —— 两把钥匙不许互相开锁');
    assertEquals(r.batchId, undefined, '管理员没有批次');
  });

  it('三把都不中的口令 → null（不区分"没这个人"与"口令不对"）', async () => {
    const s = await setup();
    assertEquals(await login(s, 'not-a-code', '10.1.0.6', Date.now(), { PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE }), null);
  });

  it('顺序固定：学生 → 开发 → 管理员（同一个串命中多档时，靠前的赢）', async () => {
    const s = await setup();
    const [{ code }] = await issueAccounts(s, { batchId: 'b1', count: 1 });

    /** 学生口令同时是 ADMIN_CODE：必须仍是学生，否则发号撞上一个管理员口令就变成了管理员 */
    const asAdminToo = await login(s, code, '10.1.0.7', Date.now(), { PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE: code });
    assertEquals(asAdminToo?.role, 'student', '学生档排在管理员档之前');

    /** 开发口令同时是 ADMIN_CODE：开发档排在管理员档之前 */
    const devAsAdmin = await login(s, DEV_CODE, '10.1.0.8', Date.now(), { PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE: DEV_CODE });
    assertEquals(devAsAdmin?.role, 'dev');
  });

  it('没配的钥匙永远打不开门（空串不能等于任何一个口令）', async () => {
    const s = await setup();
    /** 配成空白等同于没配 —— 与 admin.js 的 adminEnabled 同一口径 */
    assertEquals(await login(s, '', '10.1.0.9', Date.now(), { PILOT_DEV_CODE: '', ADMIN_CODE: '' }), null);
    assertEquals(await login(s, '   ', '10.1.0.10', Date.now(), { PILOT_DEV_CODE: '  ', ADMIN_CODE: '  ' }), null);
    assertEquals(
      await login(s, ADMIN_CODE, '10.1.0.11', Date.now(), { PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE: '' }),
      null,
      '没配 ADMIN_CODE 的部署不该有管理员入口',
    );
  });

  it('两把钥匙两边的空白都容忍（部署脚本里多一个空格不该让整班进不来）', async () => {
    const s = await setup();
    const r = await login(s, ` ${DEV_CODE} `, '10.1.0.12', Date.now(), { PILOT_DEV_CODE: ` ${DEV_CODE} `, ADMIN_CODE: ' ' });
    assertEquals(r?.role, 'dev');
  });

  it('开发/管理员口令不必是数字（输入框不许限制成只能输数字）', async () => {
    const s = await setup();
    const cn = '开发-口令-中文';
    const r = await login(s, cn, '10.1.0.13', Date.now(), { PILOT_DEV_CODE: cn, ADMIN_CODE: '看板-口令' });
    assertEquals(r?.role, 'dev');
    const a = await login(s, '看板-口令', '10.1.0.14', Date.now(), { PILOT_DEV_CODE: cn, ADMIN_CODE: '看板-口令' });
    assertEquals(a?.role, 'admin');
  });
});

// ===========================================================================
// 三、真实 HTTP：状态码、文案与三档限速
// ===========================================================================

/**
 * 起一个真服务，配置按请求注入（`requestEnv`）—— 与 admin-api / session-persist 同一套做法。
 *
 * 必须显式摘掉 LLM Key：开发者的 `.env` 里带着真 Key，不摘就会打真模型
 * （又慢又不可复现，还会花钱）。
 *
 * 回调里拿到的 `env` 是**同一个对象**，请求时逐次读它 —— 所以用例可以在中途
 * 改一个变量来模拟"部署脚本刚配上钥匙"，不必再起一台服务。
 */
async function withPilotServer(envPatch, fn) {
  const { createServer } = await import('node:http');
  const { handleApi, getStore, __resetStoreForTests, requestEnv } = await import('../src/server/router.js');
  const dir = mkdtempSync(join(tmpdir(), 'bsj-pilot-http-'));
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

/** 真实 HTTP 调用：返回 { status, json, headers } */
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
  return { status: res.status, json, headers: res.headers };
}

const postLogin = (base, code, headers = {}) =>
  call(base, '/api/auth/login', { method: 'POST', body: { code }, headers });

describe('登录接口 · 三档分流（真实 HTTP）', () => {
  it('学生 → 200，带 role/token/displayName/batchId/expiresAt，不回显口令', async () => {
    await withPilotServer({ PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE }, async ({ base, store }) => {
      const [{ code, displayName }] = await issueAccounts(store, { batchId: 'route-b1', count: 1 });
      const r = await postLogin(base, code, { 'x-forwarded-for': '198.18.0.1' });

      assertEquals(r.status, 200);
      assertEquals(r.json.role, 'student');
      assert(/^[0-9a-f]{64}$/.test(r.json.token ?? ''), '学生要拿到真令牌');
      assertEquals(r.json.displayName, displayName);
      assertEquals(r.json.batchId, 'route-b1');
      assert(!Number.isNaN(Date.parse(r.json.expiresAt)));
      assertEquals(r.json.code, undefined, '响应里不得回显口令');
    });
  });

  it('开发档 → 200，role:dev + batchId:dev + displayName:调试', async () => {
    await withPilotServer({ PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE }, async ({ base }) => {
      const r = await postLogin(base, DEV_CODE, { 'x-forwarded-for': '198.18.0.2' });
      assertEquals(r.status, 200);
      assertEquals(r.json.role, 'dev');
      assertEquals(r.json.batchId, 'dev');
      assertEquals(r.json.displayName, '调试');
      assert(/^[0-9a-f]{64}$/.test(r.json.token ?? ''), '开发档要拿到令牌');
    });
  });

  it('管理员档 → 200 {role:admin}，响应体里**一个 token 字段都没有**', async () => {
    await withPilotServer({ PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE }, async ({ base }) => {
      const r = await postLogin(base, ADMIN_CODE, { 'x-forwarded-for': '198.18.0.3' });
      assertEquals(r.status, 200);
      assertEquals(JSON.stringify(r.json), JSON.stringify({ role: 'admin' }), '管理员只回一个角色：不发令牌、不给批次');
    });
  });

  it('三档都不中 → 401「口令不对」，且不透露命中过哪一档', async () => {
    await withPilotServer({ PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE }, async ({ base }) => {
      const r = await postLogin(base, 'zzz-nope', { 'x-forwarded-for': '198.18.0.4' });
      assertEquals(r.status, 401);
      assertEquals(r.json.error, '口令不对');
      assertEquals(r.json.role, undefined, '401 里不该带角色');
    });
  });

  it('同一个口令连错 5 次 → 429（文案与上一版一致，学生知道下一步做什么）', async () => {
    resetLoginRateLimits();
    await withPilotServer({ PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE }, async ({ base }) => {
      const ip = { 'x-forwarded-for': '198.18.2.1' };
      for (let i = 1; i <= CODE_MAX_FAILURES; i += 1) {
        const r = await postLogin(base, 'definitely-wrong', ip);
        assertEquals(r.status, 401, `第 ${i} 次应是 401`);
      }
      const blocked = await postLogin(base, 'definitely-wrong', ip);
      assertEquals(blocked.status, 429, '同一对 (来源, 口令) 第 6 次必须拒绝');
      assertEquals(blocked.headers.get('retry-after'), '900');
    });
    resetLoginRateLimits();
  });

  it('开发档也被限速：先按错口令攒满 5 次，配上钥匙之后仍然 429，换来源照常进', async () => {
    /**
     * "每档都要计"的做法：限速在**判定之前**，键是 (来源, 口令)。
     * 先把这个串当"错口令"打 5 次（此时还没配钥匙 → 真失败、真记账），
     * 再把它配上 —— 若开发档绕过了限速，第 6 次会直接放行。
     */
    resetLoginRateLimits();
    await withPilotServer({ ADMIN_CODE }, async ({ base, env }) => {
      const ip = { 'x-forwarded-for': '198.18.1.1' };
      for (let i = 1; i <= CODE_MAX_FAILURES; i += 1) {
        const r = await postLogin(base, DEV_CODE, ip);
        assertEquals(r.status, 401, `第 ${i} 次应是正常的口令不对`);
      }
      env.PILOT_DEV_CODE = DEV_CODE;
      const blocked = await postLogin(base, DEV_CODE, ip);
      assertEquals(blocked.status, 429, '这一对已经满了，配上钥匙也不能插队');
      const other = await postLogin(base, DEV_CODE, { 'x-forwarded-for': '198.18.1.9' });
      assertEquals(other.status, 200, '换一个来源照常能进（锁的是这一对，不是整扇门）');
    });
    resetLoginRateLimits();
  });

  it('管理员档也被限速（同一套判据，不因为它是管理员就放行）', async () => {
    resetLoginRateLimits();
    await withPilotServer({ PILOT_DEV_CODE: DEV_CODE }, async ({ base, env }) => {
      const ip = { 'x-forwarded-for': '198.18.1.5' };
      for (let i = 1; i <= CODE_MAX_FAILURES; i += 1) {
        const r = await postLogin(base, ADMIN_CODE, ip);
        assertEquals(r.status, 401, `第 ${i} 次应是正常的口令不对`);
      }
      env.ADMIN_CODE = ADMIN_CODE;
      const blocked = await postLogin(base, ADMIN_CODE, ip);
      assertEquals(blocked.status, 429, '管理员钥匙同样在限速之后');
      assertEquals(blocked.json.error.startsWith('这个口令试错太多次了'), true, '文案要说清是这一对锁了');
    });
    resetLoginRateLimits();
  });

  it(`来源总量跨口令累计 ${IP_MAX_FAILURES} 次失败 → 429：正确的开发钥匙也进不来`, async () => {
    /**
     * 枚举脚本换着口令试，单口令维度一次也拦不住它 —— 只有来源总量能拦。
     * 这一条同时证明三档的失败都记在**同一个来源账**上。
     */
    resetLoginRateLimits();
    await withPilotServer({ PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE }, async ({ base }) => {
      const ip = { 'x-forwarded-for': '198.18.3.1' };
      for (let i = 0; i < IP_MAX_FAILURES; i += 1) {
        const r = await postLogin(base, `wrong-${100000 + i}`, ip);
        assertEquals(r.status, 401, `第 ${i + 1} 次应是正常的口令不对`);
      }
      const blocked = await postLogin(base, DEV_CODE, ip);
      assertEquals(blocked.status, 429, '这个来源的失败总量到顶了，正确的开发钥匙也不行');
      assertEquals(blocked.json.error, '这个网络试错的次数太多了，请稍后再试');
      const other = await postLogin(base, DEV_CODE, { 'x-forwarded-for': '198.18.3.9' });
      assertEquals(other.status, 200, '另一个来源不受牵连');
    });
    resetLoginRateLimits();
  });
});

// ===========================================================================
// 四、隔离：开发档的数据只进 dev 批次
// ===========================================================================

describe('隔离 · 开发档的数据不许落进真实批次', () => {
  it('开发档的会话 batchId=dev，且真实批次的整批导出逐字节不变', async () => {
    const NOW = '2026-11-09T12:00:00.000Z';
    await withPilotServer(
      { PILOT_DEV_CODE: DEV_CODE, ADMIN_CODE, PILOT_REQUIRE_LOGIN: '1' },
      async ({ base, store }) => {
        /** 一个真实批次 + 一个真实学生（导出要有东西可导，比对才有意义） */
        await store.putBatch({ id: 'real-b1', label: '第一轮', questionIds: [P1], abandonHours: 24 });
        const [{ code }] = await issueAccounts(store, { batchId: 'real-b1', count: 1 });
        const student = await postLogin(base, code, { 'x-forwarded-for': '198.19.0.1' });
        assertEquals(student.status, 200);
        assertEquals(student.json.role, 'student');
        const before = await exportBatch(store, 'real-b1', { now: NOW });

        /** 开发档登录 → 拿到令牌 → 开一次访问 → 聊一轮 */
        const dev = await postLogin(base, DEV_CODE, { 'x-forwarded-for': '198.19.0.2' });
        assertEquals(dev.status, 200);
        const auth = { 'x-test-token': dev.json.token };

        const visit = await call(base, '/api/visit', { method: 'POST', body: {}, headers: auth });
        assertEquals(visit.status, 200, '开发档也要能开访问记录（否则页 1–2 的事件没有归属）');

        const chat = await call(base, '/api/chat', {
          method: 'POST',
          headers: auth,
          body: {
            sessionId: 'dev-session-1',
            problemId: P1,
            utterance: '我想用安培力，但不知道力怎么求',
            mode: 'self_training',
            explicitHelpSeeking: true,
            visitId: visit.json.visitId,
          },
        });
        assertEquals(chat.status, 200, '开发档要能真的聊起来（否则调试功能等于没有）');

        /** ① 会话落在 dev 批次，身份是 dev-<6 位> */
        const devSessions = await store.listSessionsByBatch('dev');
        const mine = devSessions.find((x) => x.id === 'dev-session-1');
        assert(mine, '开发会话必须落在 dev 批次里');
        assertEquals(mine.batchId, 'dev');
        assert(
          /^dev-[0-9a-f]{6}$/.test(String(mine.userId)),
          `开发会话的 userId 应是 dev-<6 位>，实际：${mine.userId}`,
        );

        /** ② 真实批次一条都没多，dev 批次里也没有"人" */
        assertEquals((await store.listSessionsByBatch('real-b1')).length, 0, '真实批次里不该有开发档的会话');
        assertEquals((await store.listUsers('dev')).length, 0, 'dev 批次里不该有"人"');

        /** ③ 整批导出逐字节不变：开发档的数据一个字都没漏进去 */
        const after = await exportBatch(store, 'real-b1', { now: NOW });
        assert(
          Buffer.compare(before, after) === 0,
          '开发档聊过之后，真实批次的导出应当逐字节相同（多出一条会话/事件就说明隔离破了）',
        );
      },
    );
  });
});

// ===========================================================================
// 五、配了登录守卫的部署里，/api/eval 不存在（F3）
// ===========================================================================

/**
 * 为什么这一条属于"试点安全"而不是"评测功能"：
 *
 * `/api/eval` 一次能跑几十轮模型调用（`scenarioIds` 由请求体指定），
 * 而它只需要一个学生令牌就能打。配了 `PILOT_REQUIRE_LOGIN=1` 的部署里，
 * 每个学生手里都有那个令牌 —— 留着它等于给每个学生一个"烧钱按钮"，
 * 而它跟这个产品要做的任何一件事都没有关系。
 *
 * 回 404 而不是 403：403 等于承认"这里有东西，只是你不能用"。
 * 在这个部署里它本来就该像不存在一样。
 */
describe('隔离 · 配了登录守卫时 /api/eval 不存在', () => {
  it('带令牌的学生调用也 404「没有这个接口」', async () => {
    await withPilotServer({ PILOT_DEV_CODE: DEV_CODE, PILOT_REQUIRE_LOGIN: '1' }, async ({ base }) => {
      const dev = await postLogin(base, DEV_CODE, { 'x-forwarded-for': '198.21.0.1' });
      assertEquals(dev.status, 200, '先拿到一个有效的学生令牌');

      const res = await call(base, '/api/eval', {
        method: 'POST',
        body: {},
        headers: { 'x-test-token': dev.json.token },
      });
      assertEquals(res.status, 404, '守卫开着的部署里这个接口不该存在');
      assertEquals(res.json.error, '没有这个接口');
    });
  });

  it('没配守卫的部署行为不变（本地 / 离线演示仍然可评测）', async () => {
    await withPilotServer({}, async ({ base }) => {
      const res = await call(base, '/api/eval', { method: 'POST', body: {} });
      assertEquals(res.status, 200, '不配守卫时这条分支根本不存在');
      assert(res.json && res.json.metrics, '离线规则桩的评测结果仍然要回来');
    });
  });
});
