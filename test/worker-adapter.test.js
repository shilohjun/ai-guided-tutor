/**
 * Cloudflare Workers 适配层的行为契约。
 *
 * 为什么这组用例值得单独写：
 *
 *   1. **它跑得起来，是因为桥接层对。** router 是 Node 的事件式写法
 *      （req.on('data') / req.on('end')），Workers 是 Fetch API。
 *      两者之间的翻译只有 api/worker.js 一个地方，一旦翻错，
 *      表现是"健康检查正常、但拍照识题的体积上限失效"这种极难发现的偏差。
 *
 *   2. **两个平台必须同一套判定。** 口令门、凭据裁剪、教师视图锁死
 *      都来自 demo-gate.js。这里用与 Vercel 用例相同的输入断言相同的结果 ——
 *      只要有人把某一端改成"自己写一套"，这里就会红。
 *
 *   3. Cloudflare 部署后没法在本地随手复现线上问题，
 *      所以把能测的都测掉，减少"部署了才发现"的次数。
 */

import { describe, it, assertEquals, assert, assertIncludes } from './runner.js';
import worker from '../api/worker.js';

/** 一个只记录调用的静态资源替身 */
function makeAssets() {
  const calls = [];
  return {
    calls,
    fetch: async (request) => {
      calls.push(new URL(request.url).pathname);
      return new Response(`STATIC:${new URL(request.url).pathname}`, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  };
}

/** 造一个最小可用的 Workers env 绑定 */
function makeEnv(overrides = {}) {
  return { ASSETS: makeAssets(), ...overrides };
}

async function callWorker(env, { path = '/api/health', method = 'GET', body, headers } = {}) {
  const init = { method, headers: headers ?? {} };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'content-type': 'application/json', ...(headers ?? {}) };
  }
  const request = new Request(`https://demo.example.com${path}`, init);
  const response = await worker.fetch(request, env);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, headers: response.headers, text, json };
}

describe('Workers 适配层 · 静态资源直接放行', () => {
  it('非 /api 路径交给 ASSETS，不进函数', async () => {
    const env = makeEnv();
    const res = await callWorker(env, { path: '/' });
    assertEquals(res.status, 200, '静态资源应 200');
    assertEquals(res.text, 'STATIC:/', '应原样返回 ASSETS 的响应');
    assertEquals(env.ASSETS.calls.length, 1, '应只调用一次 ASSETS');
  });

  it('/shell.css 这类资源同样直通', async () => {
    const env = makeEnv();
    const res = await callWorker(env, { path: '/shell.css' });
    assertEquals(res.text, 'STATIC:/shell.css');
  });
});

describe('Workers 适配层 · /api 走同一份判定', () => {
  it('默认形态（无凭据）→ 离线桩 + 教师视图锁死', async () => {
    const env = makeEnv();
    const res = await callWorker(env);
    assertEquals(res.status, 200, '健康检查应 200');
    assertEquals(res.json.demoGate, 'off', '没配口令门时应报 off');
    assertEquals(res.json.engine, 'offline-stub', '没凭据必须走离线桩');
    assertEquals(res.json.teacherView, 'off', '公网必须锁死教师视图');
    assertEquals(res.json.ocr.configured, false, '没凭据时 OCR 必须关闭');
  });

  it('满血形态（KEY + 两个显式开关）→ 真模型 + OCR 可用', async () => {
    const env = makeEnv({
      LLM_API_KEY: 'sk-test-not-a-real-key',
      LLM_BASE_URL: 'https://example.invalid/v1',
      LLM_MODEL: 'test-model',
      ALIYUN_OCR_APPCODE: 'fake-appcode',
      PUBLIC_DEMO_FORCE_OFFLINE: '0',
      PUBLIC_DEMO_ALLOW_OCR: '1',
    });
    const res = await callWorker(env);
    assertEquals(res.json.engine, 'llm', '显式放行后应走真模型');
    assertEquals(res.json.model, 'test-model', '模型名应透出');
    assertEquals(res.json.ocr.configured, true, '显式放行后 OCR 应可用');
    assertEquals(res.json.teacherView, 'off', '口令门不放行教师视图');
  });

  it('配了口令门但没带 → 回到离线桩', async () => {
    const env = makeEnv({
      LLM_API_KEY: 'sk-test-not-a-real-key',
      LLM_BASE_URL: 'https://example.invalid/v1',
      LLM_MODEL: 'test-model',
      PUBLIC_DEMO_FORCE_OFFLINE: '0',
      DEMO_ACCESS_CODE: 'let-me-in',
    });
    const res = await callWorker(env);
    assertEquals(res.json.demoGate, 'locked', '没带口令应报 locked');
    assertEquals(res.json.engine, 'offline-stub', '没带口令必须离线');
  });

  it('口令对了 → 放行，且查询参数与请求头都认', async () => {
    const env = makeEnv({
      LLM_API_KEY: 'sk-test-not-a-real-key',
      LLM_BASE_URL: 'https://example.invalid/v1',
      LLM_MODEL: 'test-model',
      DEMO_ACCESS_CODE: 'let-me-in',
    });
    const byQuery = await callWorker(env, { path: '/api/health?code=let-me-in' });
    assertEquals(byQuery.json.demoGate, 'unlocked', '?code= 应放行');

    const byHeader = await callWorker(env, { headers: { 'x-demo-code': 'let-me-in' } });
    assertEquals(byHeader.json.demoGate, 'unlocked', 'x-demo-code 应放行');
  });
});

describe('Workers 适配层 · 请求体要能穿过桥', () => {
  it('POST /api/chat 的 JSON body 能被正确解析（离线桩，不联网）', async () => {
    const env = makeEnv();
    const res = await callWorker(env, {
      path: '/api/chat',
      method: 'POST',
      body: {
        sessionId: `worker-${Date.now()}`,
        problemId: 'phy-emi-01',
        utterance: '我觉得是安培力让杆慢下来的',
        mode: 'ai_companion',
      },
    });
    assertEquals(res.status, 200, '离线桩下应 200');
    assertEquals(res.json.meta.engine, 'offline-stub', '没凭据时应走离线桩');
    assert(typeof res.json.hint?.text === 'string' && res.json.hint.text.length > 0, '应返回一条提示');
    assertIncludes(res.headers.get('content-type') ?? '', 'application/json', '响应应是 JSON');
  });

  it('body 缺失时按 400 处理，而不是崩在桥里', async () => {
    const env = makeEnv();
    const res = await callWorker(env, {
      path: '/api/chat',
      method: 'POST',
      body: {},
    });
    assertEquals(res.status, 400, '缺 problemId / utterance 应 400');
    assert(res.json.error, '应给出可读的错误');
  });

  it('未知接口返回 404 JSON', async () => {
    const env = makeEnv();
    const res = await callWorker(env, { path: '/api/nope' });
    assertEquals(res.status, 404);
    assertIncludes(res.text, '未知接口');
  });
});
