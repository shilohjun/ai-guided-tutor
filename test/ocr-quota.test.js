/**
 * 拍照识题的两道闸 —— 批内额度与当日额度。
 *
 * ============================================================================
 * 为什么这两道闸值得单独一个套件
 * ============================================================================
 * OCR 是**按成功调用次数**计费的（约 0.083 元/次），而且是这套系统里唯一一个
 * "学生自己点一下就会花钱"的入口。所以闸门只有两个要求，都必须是硬的：
 *
 *   ① **拦在调用之前**。拦在调用之后（先花钱再回 503）等于没拦。
 *   ② **键名与看板逐字节一致**。看板那两格读的是 `ocr:batch:<batchId>` 与
 *      `ocr:daily:<YYYY-MM-DD>`（见 admin.js 的 usageOf）。这里写错一个字符，
 *      症状不是报错，而是**看板永远是 0**、且没有任何人会收到"这是假的"的信号 ——
 *      比挂掉难查得多。所以路由级用例最后会去调一次 `/api/admin/overview`，
 *      让看板自己把那个数读出来：那才是"没有写错"的证明。
 *
 * "上游一次都没被调用"的证明方式：**计数桩**。
 * `recognizeProblemImage` 的每一次网络调用都经过 `globalThis.fetch`（它不注入别的通道），
 * 所以这里换掉一个只认伪地址的 fetch 并记录命中次数。命中 0 次 = 真的没发请求，
 * 而不是"看起来像没发"。
 */

import { describe, it, assert, assertEquals, assertIncludes } from './runner.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import {
  ocrQuotaState,
  handleApi,
  getStore,
  requestEnv,
  __resetStoreForTests,
} from '../src/server/router.js';
import { issueAccounts, login } from '../src/server/auth.js';

/** 一张最小的合法 dataURL（内容真假不重要，这里只验证调用与计数） */
const IMG = `data:image/jpeg;base64,${'A'.repeat(80)}`;
const APPCODE = 'TEST_APPCODE_QUOTA_DO_NOT_LEAK';
/**
 * 伪上游地址：**.invalid 是保留域名，永远不会真的解析出去**。
 * 它出现在请求里就说明拦截已经失效了 —— 那时网络会直接失败，而不是悄悄花掉一次钱。
 */
const UPSTREAM = 'http://ocr-stub.invalid/ocrservice/mathQuestion';
const ADMIN_CODE = 'admin-code-quota';

/** UTC 日（与 admin.js 的用量行同一口径：一律 UTC，不用本地时区） */
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// 一、纯函数：两道闸的判定
// ---------------------------------------------------------------------------

describe('OCR · 两道闸', () => {
  const batch = { id: 'b1', ocrCap: 2 };

  it('批内用量到顶就拒', () => {
    assertEquals(ocrQuotaState({ batchUsed: 2, batch, dailyUsed: 0, dailyCap: 200 }).blocked, true);
  });

  it('日用量到顶也拒', () => {
    assertEquals(ocrQuotaState({ batchUsed: 0, batch, dailyUsed: 200, dailyCap: 200 }).blocked, true);
  });

  it('都没到顶就放行，并给出剩余量', () => {
    const r = ocrQuotaState({ batchUsed: 1, batch, dailyUsed: 5, dailyCap: 200 });
    assertEquals(r.blocked, false);
    assertEquals(r.remaining, 1, '批内还剩 1 次');
  });

  it('没配上限时不拦（本地开发不受影响）', () => {
    assertEquals(ocrQuotaState({ batchUsed: 99, batch: {}, dailyUsed: 0, dailyCap: 0 }).blocked, false);
  });

  it('取两道闸里更紧的那一个剩余量（剩余量不是"批内剩余"）', () => {
    const r = ocrQuotaState({ batchUsed: 0, batch: { ocrCap: 100 }, dailyUsed: 199, dailyCap: 200 });
    assertEquals(r.blocked, false);
    assertEquals(r.remaining, 1, '当日只剩 1 次时，剩余量就是 1');
  });

  it('拦下时说清是哪一道闸', () => {
    assertEquals(ocrQuotaState({ batchUsed: 2, batch, dailyUsed: 0, dailyCap: 200 }).reason, 'batch');
    assertEquals(ocrQuotaState({ batchUsed: 0, batch, dailyUsed: 200, dailyCap: 200 }).reason, 'daily');
    assertEquals(ocrQuotaState({ batchUsed: 0, batch, dailyUsed: 0, dailyCap: 200 }).reason, null);
  });

  it('没配上限时剩余量是 null（不限，而不是 0 次）', () => {
    assertEquals(ocrQuotaState({ batchUsed: 99, batch: {}, dailyUsed: 5, dailyCap: 0 }).remaining, null);
  });
});

// ---------------------------------------------------------------------------
// 二、路由级：真的调一次、只计一次、到顶就不发请求
// ---------------------------------------------------------------------------

/**
 * 起一台真服务 + 一个计数桩。
 *
 * 配置按请求注入（`requestEnv`），与 admin-api / pilot-ui / session-persist 同一套做法；
 * 必须显式摘掉进程里的凭据与 Key：开发者的 `.env` 里带着真的 AppCode，
 * 不摘就会打真的识别服务 —— 又慢、又要花钱，而且结果不可复现。
 */
async function withOcrServer(envPatch, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bsj-ocr-quota-'));
  const env = { ...process.env, STORE: 'file', STORE_DIR: dir };
  for (const key of [
    'LLM_API_KEY',
    'OPENAI_API_KEY',
    'PILOT_REQUIRE_LOGIN',
    'PILOT_DEV_CODE',
    'ADMIN_CODE',
    'OCR_DAILY_CAP',
    'ALIYUN_OCR_APPCODE',
    'ALIYUN_OCR_ENDPOINT',
    'ALIYUN_OCR_IMAGE_FIELD',
    'ALIYUN_OCR_PROVIDER',
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

  /**
   * 计数桩：只接管伪上游，其余请求原样交给真 fetch（服务本身还要靠它来聊）。
   * 命中次数就是"这次到底有没有花钱"的唯一证据。
   */
  const realFetch = globalThis.fetch;
  const upstreamCalls = [];
  globalThis.fetch = async (input, init) => {
    const target = typeof input === 'string' ? input : String(input?.url ?? '');
    if (target.startsWith('http://ocr-stub.invalid')) {
      upstreamCalls.push({ target, body: init?.body });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ content: '一段用于测试的题干文字，长度足够。' }),
      };
    }
    return realFetch(input, init);
  };

  try {
    return await fn({ base, store, env, upstreamCalls, dir });
  } finally {
    globalThis.fetch = realFetch;
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

/** 配好凭据的一套 env：AppCode 是假的，地址指向伪上游 */
const OCR_ENV = {
  ALIYUN_OCR_APPCODE: APPCODE,
  ALIYUN_OCR_ENDPOINT: UPSTREAM,
  ALIYUN_OCR_IMAGE_FIELD: 'img',
};

/** 发一笔识图请求 */
const ocr = (base, headers = {}) => call(base, '/api/ocr', { method: 'POST', body: { image: IMG }, headers });

describe('OCR · 路由级：真的调一次、只计一次、到顶就不发请求', () => {
  it('日额度设 0 视为不限：连调两次都成功，两个计数器各加 2', async () => {
    await withOcrServer({ ...OCR_ENV, OCR_DAILY_CAP: '0' }, async ({ base, store, upstreamCalls }) => {
      const first = await ocr(base);
      assertEquals(first.status, 200, `第一次应当识别成功：${JSON.stringify(first.json)}`);
      assertEquals(upstreamCalls.length, 1, '成功一次 = 上游被调用一次');

      const second = await ocr(base);
      assertEquals(second.status, 200, '上限 0 = 不限，第二次照样放行');
      assertEquals(upstreamCalls.length, 2);

      /**
       * 计数器的键名与 admin.js 的用量行**逐字节一致**（`ocr:daily:<UTC 日>`）。
       * 没有批次（未登录）时批内那一格不动 —— 它不是一个真实批次。
       */
      assertEquals(await store.getCounter(`ocr:daily:${today()}`), 2, '当日累计应当是 2');
      assertEquals(await store.getCounter(`ocr:batch:dev`), 0, '未登录的调用不该写进任何批次的抽屉');
    });
  });

  it('日额度设 1：第二次 503 OCR_QUOTA，上游没有被再调用，计数器停在 1', async () => {
    await withOcrServer({ ...OCR_ENV, OCR_DAILY_CAP: '1' }, async ({ base, store, upstreamCalls }) => {
      const first = await ocr(base);
      assertEquals(first.status, 200);

      const second = await ocr(base);
      assertEquals(second.status, 503, '到顶必须拦');
      assertEquals(second.json.code, 'OCR_QUOTA', '前端靠这个码把话说到位');
      assertIncludes(second.json.error, '今日的拍照识题额度用完了', '文案要说清是哪一件事');
      assertIncludes(second.json.error, '粘贴题目文字', '必须给出仍然可用的那条路');

      assertEquals(upstreamCalls.length, 1, '**被拦下的那一次一次请求都不许发** —— 那才是省钱的那一半');
      assertEquals(await store.getCounter(`ocr:daily:${today()}`), 1, '被拦下的调用不计数');
    });
  });

  it('失败不上账（供应商按成功调用计费，我们也只计成功的那一次）', async () => {
    await withOcrServer({ ...OCR_ENV, OCR_DAILY_CAP: '2' }, async ({ base, store, upstreamCalls }) => {
      /**
       * 让上游返回一个"业务失败"：HTTP 200 但没有可用的文本。
       * 这模拟的是"钱可能已经花了、但学生没拿到题干"的那种失败 ——
       * 它按产品的口径仍然算一次失败（不占学生的额度）。
       */
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const target = typeof input === 'string' ? input : String(input?.url ?? '');
        if (target.startsWith('http://ocr-stub.invalid')) {
          upstreamCalls.push({ target });
          return { ok: true, status: 200, text: async () => JSON.stringify({ error_code: 2001, error_msg: '识别失败' }) };
        }
        return realFetch(input, init);
      };
      try {
        const res = await ocr(base);
        assertEquals(res.status, 502, '没拿到题干就是失败');
      } finally {
        globalThis.fetch = realFetch;
      }
      assertEquals(upstreamCalls.length, 1);
      assertEquals(await store.getCounter(`ocr:daily:${today()}`), 0, '失败不占额度');
    });
  });

  it('批内额度到顶同样拦：读的是这名学生所在批次', async () => {
    await withOcrServer(OCR_ENV, async ({ base, store, upstreamCalls }) => {
      await store.putBatch({ id: 'b1', label: '一班', ocrCap: 1 });
      const [issued] = await issueAccounts(store, { batchId: 'b1', count: 1 });
      const token = (await login(store, issued.code, '10.9.0.1', Date.now(), {})).token;

      const first = await ocr(base, { 'x-test-token': token });
      assertEquals(first.status, 200, `第一次应当成功：${JSON.stringify(first.json)}`);
      assertEquals(await store.getCounter('ocr:batch:b1'), 1, '批内累计记在这名学生所在的批次上');

      const second = await ocr(base, { 'x-test-token': token });
      assertEquals(second.status, 503);
      assertEquals(second.json.code, 'OCR_QUOTA');
      assertEquals(upstreamCalls.length, 1, '批内额度到顶之后一次请求都不许发');
      assertEquals(await store.getCounter('ocr:batch:b1'), 1);
    });
  });

  it('成功一次之后，看板那两格不是 0（键名与看板逐字节一致）', async () => {
    /**
     * 这是本套件里最重要的一条：**不读 counter 字面量，而是让看板自己读**。
     * 前几条用例里的 `getCounter('ocr:batch:b1')` 是测试自己拼的键，
     * 万一 admin.js 那份也一起写错了，两边会一起错、测试照样绿。
     * 走一次 `/api/admin/overview` 之后，读的是看板真正用的那个表达式。
     */
    await withOcrServer({ ...OCR_ENV, ADMIN_CODE, OCR_DAILY_CAP: '5' }, async ({ base, store }) => {
      await store.putBatch({ id: 'b1', label: '一班', ocrCap: 5 });
      const [issued] = await issueAccounts(store, { batchId: 'b1', count: 1 });
      const token = (await login(store, issued.code, '10.9.0.2', Date.now(), {})).token;

      const res = await ocr(base, { 'x-test-token': token });
      assertEquals(res.status, 200);

      const board = await call(base, '/api/admin/overview?batchId=b1', { headers: { 'x-admin-code': ADMIN_CODE } });
      assertEquals(board.status, 200, `看板应当能打开：${JSON.stringify(board.json)}`);
      assertEquals(board.json.usage.ocrBatch, 1, '看板「本批识图」那一格必须是 1，不是 0');
      assertEquals(board.json.usage.ocrDaily, 1, '看板「今日识图」那一格必须是 1，不是 0');
      assertEquals(board.json.usage.ocrCap, 5);
      assertEquals(board.json.usage.dailyCap, 5);
    });
  });
});

// ---------------------------------------------------------------------------
// 三、健康检查把用量透出来（L2：让调试条读得到，而不是编一个数）
// ---------------------------------------------------------------------------

describe('OCR · 用量透出', () => {
  it('/api/health 的 ocr 里带 usedToday / dailyCap / configured', async () => {
    await withOcrServer({ ...OCR_ENV, OCR_DAILY_CAP: '7' }, async ({ base }) => {
      const before = await call(base, '/api/health');
      assertEquals(before.status, 200);
      assertEquals(before.json.ocr.configured, true);
      assertEquals(before.json.ocr.dailyCap, 7, '日上限要报出来，前端才知道剩余怎么说');
      assertEquals(before.json.ocr.usedToday, 0, '还没用过就是 0 —— 0 是真的，不是"没实现"');

      await ocr(base);

      const after = await call(base, '/api/health');
      assertEquals(after.json.ocr.usedToday, 1, '用掉一次之后要变成 1');
    });
  });

  it('没配凭据时 usedToday 仍然是数（用量与"能不能用"是两件事）', async () => {
    await withOcrServer({}, async ({ base }) => {
      const res = await call(base, '/api/health');
      assertEquals(res.json.ocr.configured, false);
      assertEquals(res.json.ocr.usedToday, 0);
      assertEquals(res.json.ocr.dailyCap, 0, '0 = 没配 = 不限');
    });
  });
});
