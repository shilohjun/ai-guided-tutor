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
import { handleCloudbaseEvent } from '../src/server/cloudbase-handler.js';

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

  it('默认形态（无凭据）→ 离线桩 + 教师视图锁死', async () => {
    const res = await call(get('/api/health'));
    assertEquals(res.json.demoGate, 'off', '没配口令门时应报 off');
    assertEquals(res.json.engine, 'offline-stub', '没凭据必须走离线桩');
    assertEquals(res.json.teacherView, 'off', '公网必须锁死教师视图');
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
      mode: 'ai_companion',
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
    assertEquals(res.json.teacherView, 'off', '口令门不放行教师视图');
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
