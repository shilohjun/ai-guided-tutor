/**
 * 腾讯云 CloudBase 适配层的行为契约。
 *
 * 为什么单独写这一组：
 *
 *   1. **它是"到国内网络"的最后一跳。** 前两个入口（Vercel / Workers）都因 DNS 投毒
 *      在国内打不开，这一段能不能跑通，决定用户到底能不能用。
 *      而它跑不通时的表现很隐蔽：路由活着、健康检查 200，但拍照识题悄悄失灵。
 *
 *   2. **event 的形状与另外两平台都不同。** 网关可能把 `/api` 前缀吃掉，
 *      也可能 base64 编码 body —— 这两件事只要错一件，就是"本地全绿、线上全错"。
 *      所以把三种可能都在本地钉死。
 *
 *   3. **判定必须与另外两端同源。** 口令门与凭据裁剪来自 demo-gate.js，
 *      这里用同样的输入断言同样的结果；若有人给 CloudBase 单独写一套，这里会红。
 */

import { describe, it, assertEquals, assert, assertIncludes } from './runner.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleCloudbaseEvent } from '../src/server/cloudbase-handler.js';
import { getStore, requestEnv, __resetStoreForTests } from '../src/server/router.js';

/** 发一次"云函数调用" */
async function call(event, source = {}) {
  const result = await handleCloudbaseEvent(event, source);
  let json = null;
  try {
    json = JSON.parse(result.body);
  } catch {}
  return { ...result, json };
}

function get(path, extra = {}) {
  return { httpMethod: 'GET', path, headers: {}, ...extra };
}

describe('CloudBase 适配层 · 基本形状', () => {
  it('返回云函数认识的四个字段', async () => {
    const res = await call(get('/api/health'));
    assertEquals(res.statusCode, 200, '健康检查应 200');
    assertEquals(typeof res.body, 'string', 'body 必须是字符串');
    assertEquals(res.isBase64Encoded, false, '不压缩的响应要显式声明');
    assertIncludes(res.headers['content-type'] ?? '', 'application/json', '响应应是 JSON');
  });

  it('默认形态（无凭据）→ 离线桩', async () => {
    const res = await call(get('/api/health'));
    assertEquals(res.json.demoGate, 'off', '没配口令门时应报 off');
    assertEquals(res.json.engine, 'offline-stub', '没凭据必须走离线桩');
    assertEquals(res.json.ocr.configured, false, '没凭据时 OCR 必须关闭');
  });

  it('未知接口返回 404 的 JSON，而不是空响应', async () => {
    const res = await call(get('/api/nope'));
    assertEquals(res.statusCode, 404, '未知接口应 404');
    assert(typeof res.json?.error === 'string', '应带 error 字段');
  });
});

describe('CloudBase 适配层 · 网关的形状差异', () => {
  it('网关吃掉 /api 前缀时，仍能落到对应接口', async () => {
    const res = await call(get('/health'));
    assertEquals(res.statusCode, 200, '/health 应被补回 /api/health');
    assertEquals(res.json.ok, true, '仍应是健康检查');
  });
  it('path 里自带查询串时也能取到参数', async () => {
    const res = await call(get('/api/health?code=whatever'));
    assertEquals(res.statusCode, 200, '带查询串不应影响路由');
  });

  it('queryStringParameters 会被拼回 URL', async () => {
    const res = await call(
      get('/api/health', { queryStringParameters: { code: 'let-me-in' } }),
      { DEMO_ACCESS_CODE: 'let-me-in' },
    );
    assertEquals(res.json.demoGate, 'unlocked', 'queryStringParameters 里的口令应生效');
  });

  it('base64 编码的 body 会被解码', async () => {
    const payload = JSON.stringify({
      sessionId: `cb-b64-${Date.now()}`,
      problemId: 'phy-emi-01',
      utterance: '我觉得是安培力让杆慢下来的',
      mode: 'self_training',
    });
    const res = await call({
      httpMethod: 'POST',
      path: '/api/chat',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(payload, 'utf8').toString('base64'),
      isBase64Encoded: true,
    });
    assertEquals(res.statusCode, 200, 'base64 body 应被正确解码后处理');
    assert(typeof res.json?.hint?.text === 'string' && res.json.hint.text.length > 0, '应返回一条提示');
  });

  it('请求头大小写不敏感', async () => {
    const res = await call(
      get('/api/health', { headers: { 'X-Demo-Code': 'let-me-in' } }),
      { DEMO_ACCESS_CODE: 'let-me-in' },
    );
    assertEquals(res.json.demoGate, 'unlocked', '大写请求头也应认');
  });
});

describe('CloudBase 适配层 · 与另外两端同一份判定', () => {
  it('满血形态（KEY + 两个显式开关）→ 真模型 + OCR 可用', async () => {
    const res = await call(get('/api/health'), {
      LLM_API_KEY: 'sk-test-not-a-real-key',
      LLM_BASE_URL: 'https://example.invalid/v1',
      LLM_MODEL: 'test-model',
      ALIYUN_OCR_APPCODE: 'fake-appcode',
      PUBLIC_DEMO_FORCE_OFFLINE: '0',
      PUBLIC_DEMO_ALLOW_OCR: '1',
    });
    assertEquals(res.json.engine, 'llm', '显式放行后应走真模型');
    assertEquals(res.json.model, 'test-model', '模型名应透出');
    assertEquals(res.json.ocr.configured, true, '显式放行后 OCR 应可用');
  });

  it('配了口令门但没带 → 回到离线桩', async () => {
    const res = await call(get('/api/health'), {
      LLM_API_KEY: 'sk-test-not-a-real-key',
      LLM_BASE_URL: 'https://example.invalid/v1',
      LLM_MODEL: 'test-model',
      PUBLIC_DEMO_FORCE_OFFLINE: '0',
      DEMO_ACCESS_CODE: 'let-me-in',
    });
    assertEquals(res.json.demoGate, 'locked', '没带口令应报 locked');
    assertEquals(res.json.engine, 'offline-stub', '没带口令必须离线');
  });

  it('口令对，但连 OCR 的 AppCode 一起放行', async () => {
    const res = await call(get('/api/health?code=let-me-in'), {
      LLM_API_KEY: 'sk-test-not-a-real-key',
      LLM_BASE_URL: 'https://example.invalid/v1',
      LLM_MODEL: 'test-model',
      ALIYUN_OCR_APPCODE: 'fake-appcode',
      DEMO_ACCESS_CODE: 'let-me-in',
    });
    assertEquals(res.json.demoGate, 'unlocked', '口令对应放行');
    assertEquals(res.json.engine, 'llm', '放行后应走真模型');
    assertEquals(res.json.ocr.configured, true, '放行后 OCR 应可用');
  });
});

describe('CloudBase 适配层 · 页面也由函数出', () => {
  it('根路径返回首页 HTML', async () => {
    const res = await call(get('/'));
    assertEquals(res.statusCode, 200, '根路径应 200');
    assertIncludes(res.headers['content-type'] ?? '', 'text/html', '首页应是 HTML');
    assertIncludes(res.body, '<title>', '应真的是页面，而不是一段 JSON');
  });

  it('样式与脚本按正确的 MIME 返回', async () => {
    const css = await call(get('/shell.css'));
    assertEquals(css.statusCode, 200, 'shell.css 应 200');
    assertIncludes(css.headers['content-type'] ?? '', 'text/css', 'CSS 的 MIME 必须对，否则浏览器拒绝应用');

    const js = await call(get('/shell.js'));
    assertEquals(js.statusCode, 200, 'shell.js 应 200');
    assertIncludes(js.headers['content-type'] ?? '', 'javascript', 'JS 的 MIME 必须对，否则会被当文本');
  });

  it('静态资源不允许穿越到函数包外', async () => {
    const res = await call(get('/../package.json'));
    assert(res.statusCode === 403 || res.statusCode === 404, '目录穿越必须被挡掉');
    assert(!res.body.includes('"ai-guided-tutor'), '绝不能把 package.json 吐出去');
  });

  it('既不是页面也不是接口 → 404', async () => {
    const res = await call(get('/not-a-real-file.txt'));
    assertEquals(res.statusCode, 404, '不存在的路径应 404');
  });
});

// ---------------------------------------------------------------------------
// 二进制响应：zip 导出（B1，终审阻塞项）
// ---------------------------------------------------------------------------

/**
 * 为什么这一组非有不可：
 *
 * 本地导出一直是好的，因为真的 `node:http` response 直接吃 Buffer。
 * 而 CloudBase 的 HTTP 访问服务把函数返回值当**文本**收：`body` 是字符串、
 * `isBase64Encoded` 由我们硬写 `false`。于是 ≥0x80 的每一个字节都被换成 U+FFFD，
 * content-length 也跟着对不上 —— 老师下载到的是一个打不开的 zip，
 * 而这条链路上**没有任何一处会报错**。试点唯一的交付物就是这个文件。
 *
 * 判据取"收集到的 chunk 是不是二进制"，不取 content-type：按类型写死的话，
 * 下一个二进制响应（字体、图片、PDF）会以完全相同的方式悄悄坏掉。
 */
const ADMIN_CODE = 'cb-admin';

/** 一个装着一条会话的文件库；用完连目录一起删（file 驱动每次读盘，所以换目录就是换库） */
async function withSeededStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bsj-cb-bin-'));
  const env = { ...process.env, STORE: 'file', STORE_DIR: dir, ADMIN_CODE };
  /** 开发者本机的 .env 可能带着真口令 / 真额度 / 真守卫：一律删掉，让这一组自己说了算 */
  for (const key of ['LLM_API_KEY', 'OPENAI_API_KEY', 'ALIYUN_OCR_APPCODE', 'OCR_DAILY_CAP', 'PILOT_REQUIRE_LOGIN']) {
    delete env[key];
  }

  __resetStoreForTests();
  const store = await requestEnv.run(env, () => getStore());
  await store.putBatch({ id: 'b1', label: '第二版', abandonHours: 24, ocrCap: 10 });
  await store.putUser({ id: 'u1', displayName: 'S01', batches: ['b1'] });
  await store.putSession({
    id: 's1',
    userId: 'u1',
    batchId: 'b1',
    problemId: 'qbank-1',
    startedAt: '2026-11-09T10:00:00.000Z',
    lastAt: '2026-11-09T10:20:00.000Z',
    finishedAt: null,
    progress: { maxPage: 2, reached: { p2: '2026-11-09T10:00:00.000Z' } },
    counters: {},
    turns: [{ i: 0, at: '2026-11-09T10:01:00.000Z', role: 'student', text: '我先把力分解' }],
    reportSnapshot: null,
  });

  try {
    return await fn({ store, env });
  } finally {
    __resetStoreForTests();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 带管理员口令的一次 GET（口令只进请求头，不进查询串） */
const adminGet = (path) => ({ httpMethod: 'GET', path, headers: { 'x-admin-code': ADMIN_CODE } });

describe('CloudBase 适配层 · 二进制响应（zip 导出）', () => {
  it('导出按 base64 回传：isBase64Encoded 为 true，解回来仍是 zip', async () => {
    await withSeededStore(async ({ env }) => {
      const res = await handleCloudbaseEvent(adminGet('/api/admin/export?sessionId=s1'), env);

      assertEquals(res.statusCode, 200, '导出应当成功');
      assertEquals(res.headers['content-type'], 'application/zip');
      assertEquals(
        res.isBase64Encoded,
        true,
        '二进制响应必须声明 base64：硬写 false 时 ≥0x80 的字节会被网关换成 U+FFFD，zip 当场坏掉',
      );

      /** base64 只允许出现这些字符；被当文本收过的 body 会带 U+FFFD，那不在这个字符集里 */
      assert(/^[A-Za-z0-9+/]*={0,2}$/.test(res.body), `body 应当是纯 base64，实际开头：${String(res.body).slice(0, 40)}`);

      const zip = Buffer.from(res.body, 'base64');
      assertEquals(zip.subarray(0, 4).toString('latin1'), 'PK\x03\x04', '解回来的前 4 个字节必须是 zip 的本地文件头');
      assertEquals(zip.length, Number(res.headers['content-length']), 'content-length 必须与解回来的字节数对得上');
      assert(zip.includes('session.md'), '解回来的内容里应当有这一条的名字（顺手确认真的解出了内容）');
    });
  });

  it('普通 JSON 响应保持原文：isBase64Encoded 仍是 false，body 不是一串 base64', async () => {
    await withSeededStore(async ({ env }) => {
      const res = await handleCloudbaseEvent(adminGet('/api/admin/overview?batchId=b1'), env);

      assertEquals(res.statusCode, 200);
      assertEquals(res.isBase64Encoded, false, '文本响应不许跟着一起改成 base64');
      assertEquals(res.body.trimStart().startsWith('{'), true, 'body 应当是原文 JSON，而不是它的 base64');
      const json = JSON.parse(res.body);
      assertEquals(json.batch.id, 'b1');
    });
  });

  /**
   * 同一类缺陷的另一处：函数包里的图片 / 字体也会被 `toString('utf8')` 弄坏。
   * 放在这里是因为它和导出走的是**同一条判据**（能不能当文本）。
   */
  it('静态二进制文件（png）同样按 base64 回传：解回来还是 PNG', async () => {
    const res = await call(get('/brand.png'));
    assertEquals(res.statusCode, 200, '函数包里应当有 brand.png');
    assertEquals(res.isBase64Encoded, true, 'png 不许被当文本发出去（≥0x80 的字节会被换成 U+FFFD）');
    const png = Buffer.from(res.body, 'base64');
    assertEquals(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '解回来应当是 PNG 的魔数');
  });
});
