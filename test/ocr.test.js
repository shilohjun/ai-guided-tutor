/**
 * 拍照识题（图像 → 题干）测试。
 *
 * ============================================================================
 * 这个套件真正要守住的三件事
 * ============================================================================
 * ① **不会为了"重试"而重复计费。**
 *    识别按成功调用次数计费，所以"什么时候可以再试一次"是产品行为，
 *    不是实现细节：网络层失败（没到服务端）可以换候选，业务失败不可以。
 *    这条写错的表现是"账单比预期高"，而不是测试失败 —— 所以必须固化成断言。
 *
 * ② **凭据永远不出网、不进日志、不落到前端。**
 *    AppCode 在请求头里，服务端持有；任何返回体、健康检查、错误消息里都不能出现它。
 *
 * ③ **两层状态码分开判。**
 *    这类接口的系统码为 0 只代表"请求通了"，业务码才是成败。
 *    混为一谈会得到"提示识别成功、输入框里是空的"——不报错，只是静默失效。
 */

import { describe, it, assert, assertEquals, assertIncludes, assertNotIncludes } from './runner.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnvFile } from '../src/core/env.js';
import {
  readOcrConfig,
  ocrStatus,
  resolveCallShape,
  parseOcrResponse,
  normalizeImage,
  sortByReadingOrder,
  recognizeProblemImage,
  buildRequestBody,
  BUSINESS_ERRORS,
} from '../src/core/ocr.js';

/** 一张最小的合法 dataURL（内容真假不重要，这里只验证传参形状） */
const IMG = `data:image/jpeg;base64,${'A'.repeat(80)}`;
const APPCODE = 'TEST_APPCODE_DO_NOT_LEAK';

/** 造一个"只回一次"的假 fetch，并记录它实际收到的请求 */
function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = typeof responder === 'function' ? responder(url, init, calls.length) : responder;
    const status = r.status ?? 200;
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

const successBody = (text) => ({
  showapi_res_code: 0,
  showapi_res_body: { ret_code: 0, content: text },
});

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

describe('拍照识题 · 配置读取', () => {
  it('没配 AppCode 时 available=false，且给出可操作提示（而不是抛错）', () => {
    const c = readOcrConfig({});
    assertEquals(c.available, false, '没配凭据就不该判为可用');
    const s = ocrStatus({});
    assertEquals(s.configured, false);
    assertIncludes(s.hint, 'ALIYUN_OCR_APPCODE', '提示里要写清楚缺哪个变量');
  });

  it('配了 AppCode 就可用，且默认通道是云市场', () => {
    const c = readOcrConfig({ ALIYUN_OCR_APPCODE: APPCODE });
    assertEquals(c.available, true);
    assertEquals(c.provider, 'marketplace');
    assertEquals(c.retries, 0, '默认重试必须是 0 —— 按次计费，重试就是再花钱');
  });

  it('健康检查只报形态，绝不回传 AppCode', () => {
    const s = ocrStatus({ ALIYUN_OCR_APPCODE: APPCODE });
    const dumped = JSON.stringify(s);
    assertNotIncludes(dumped, APPCODE, '状态里不能出现凭据本身');
    assertEquals(s.configured, true);
  });

  it('官方通道尚未实现时要显式说明，而不是静默变成"未配置"', () => {
    const s = ocrStatus({ ALIYUN_OCR_APPCODE: APPCODE, ALIYUN_OCR_PROVIDER: 'official' });
    assertEquals(s.configured, false);
    assertIncludes(s.hint, '签名', '未实现的通道要说清原因');
  });
});

// ---------------------------------------------------------------------------
// 调用形状
// ---------------------------------------------------------------------------

describe('拍照识题 · 调用形状', () => {
  it('第一次调用按候选顺序取第一个形状', () => {
    const c = readOcrConfig({ ALIYUN_OCR_APPCODE: APPCODE });
    const shape = resolveCallShape(c, 0);
    assert(shape.url.startsWith('https://'), '必须是 https —— AppCode 是明文传输');
    assert(Boolean(shape.imageField), '必须有传图字段名');
  });

  it('配置了确切地址时，候选表退化成单元素（行为等同写死）', () => {
    const c = readOcrConfig({
      ALIYUN_OCR_APPCODE: APPCODE,
      ALIYUN_OCR_ENDPOINT: 'https://example.com/fixed/path',
      ALIYUN_OCR_IMAGE_FIELD: 'pic',
    });
    const a = resolveCallShape(c, 0);
    const b = resolveCallShape(c, 5); // 越界的 attempt 也必须落在同一个地址上
    assertEquals(a.url, 'https://example.com/fixed/path');
    assertEquals(b.url, 'https://example.com/fixed/path');
    assertEquals(a.imageField, 'pic');
    assertEquals(b.imageField, 'pic');
  });

  it('带进来已验证的 shape 时，优先用它（这是省钱的关键）', () => {
    const c = readOcrConfig({ ALIYUN_OCR_APPCODE: APPCODE });
    const cached = { url: 'https://verified.example.com/x', imageField: 'img' };
    const shape = resolveCallShape({ ...c, shape: cached }, 0);
    assertEquals(shape.url, cached.url, '命中过就必须复用，否则每张图都要多试一次');
    assertEquals(shape.imageField, cached.imageField);
  });

  /**
   * 这一组断言守着"契约不是猜的"。
   *
   * 这三条都是**实测踩过或必然踩到**的坑：商品页给出的契约与云市场多数接口相反，
   * 谁要是"照惯例"改回表单或加上 dataURL 前缀，都会得到一个参数错误的响应 ——
   * 而那次调用可能已经计费。所以把它们固化成断言，而不是留在注释里。
   */
  it('契约：调用地址是题目识别专用域名与路径', () => {
    const c = readOcrConfig({ ALIYUN_OCR_APPCODE: APPCODE });
    const shape = resolveCallShape(c, 0);
    assertEquals(shape.url, 'https://mquestion.market.alicloudapi.com/ocrservice/mathQuestion');
  });

  it('契约：图片字段名是 img，且值必须是纯 base64（不带 dataURL 前缀）', () => {
    const c = readOcrConfig({ ALIYUN_OCR_APPCODE: APPCODE });
    const shape = resolveCallShape(c, 0);
    assertEquals(shape.imageField, 'img');
    const value = normalizeImage(`data:image/jpeg;base64,${'E'.repeat(60)}`, shape.spec);
    assertEquals(value, 'E'.repeat(60), '带上 data: 前缀会被判为非法图片数据');
  });

  it('契约：请求体是 JSON（不是表单），并带上 prob/rotate', () => {
    const spec = readOcrConfig({ ALIYUN_OCR_APPCODE: APPCODE }).providerSpec;
    const { body, contentType } = buildRequestBody('img', 'AAAA', spec);
    assertIncludes(contentType, 'application/json', '这个接口是 JSON —— 用表单会直接参数错误');
    const parsed = JSON.parse(body);
    assertEquals(parsed.img, 'AAAA');
    assertEquals(parsed.prob, false, 'prob 显式传 false');
    assertEquals(parsed.rotate, false, 'rotate 显式传 false（前端已按 EXIF 解码过）');
  });

  it('契约：表单格式的通道仍然可用（另一种云市场接口是表单）', () => {
    const formSpec = { bodyFormat: 'form', dataUrlPrefix: true, extraParams: {} };
    const { body, contentType } = buildRequestBody('img_base64', 'BBBB', formSpec);
    assertIncludes(contentType, 'x-www-form-urlencoded');
    assertIncludes(body, 'img_base64=BBBB');
  });
});

// ---------------------------------------------------------------------------
// 返回解析
// ---------------------------------------------------------------------------

describe('拍照识题 · 返回解析（两层状态码必须分开判）', () => {
  /**
   * 这一组用的是**实测拿到的真实响应结构**（1 次真实调用换来的）：
   *   成功 → { content, figure:[{type,x,y,w,h,box:{angle},points}] }
   *   失败 → { error_code, error_msg, requestId }
   * 原先按云市场通用形态（showapi_res_code / ret_code）预设的解析，
   * 第一次真机测试就被纠正了 —— 所以这里同时守住两种结构，防止回归。
   */
  it('实测结构：扁平 content + figure → 取到文本与配图', () => {
    const r = parseOcrResponse({
      content: '如图所示，水平放置的两条光滑平行金属导轨间距为 L=0.5m',
      figure: [{ type: 'subject_table', x: 40, y: 827, w: 462, h: 90, box: { angle: -90 }, points: [] }],
    });
    assertEquals(r.ok, true);
    assertIncludes(r.rawText, '导轨间距');
    assertEquals(r.figures.length, 1, '配图坐标要带出来，用于提示"题干可能缺图形信息"');
  });

  it('实测结构：error_code + error_msg → 判失败并说清原因', () => {
    const r = parseOcrResponse({
      error_code: 400,
      error_msg: 'img和url参数不能同时为空',
      requestId: 'CEEA8706-1F80-4CC7-8EBC-5DE6E952A738',
    });
    assertEquals(r.ok, false);
    assertIncludes(r.message, 'img和url', '服务端的原话要带出来，那是最有用的排查线索');
    assertEquals(r.code, 400);
  });

  it('实测结构：error_code 非 0 就不会被当成有内容（哪怕同时带了 content）', () => {
    const r = parseOcrResponse({ error_code: 2001, error_msg: '识别失败', content: '' });
    assertEquals(r.ok, false);
    assertEquals(r.reason, 'business');
  });

  it('ShowAPI 风格的两层信封仍然兼容（多通道共用一个解析器）', () => {
    const ok = parseOcrResponse({ showapi_res_code: 0, showapi_res_body: { ret_code: 0, content: '题干文字' } });
    assertEquals(ok.ok, true);
    assertEquals(ok.rawText, '题干文字');
  });

  it('系统码 0 + 业务码 0 → 取到文本', () => {
    const r = parseOcrResponse(successBody('质量为 0.5 kg 的小球从高处下落'));
    assertEquals(r.ok, true);
    assertIncludes(r.rawText, '小球');
  });

  it('系统码 0 但业务码非 0 → 必须判失败（最经典的坑）', () => {
    const r = parseOcrResponse({ showapi_res_code: 0, showapi_res_body: { ret_code: 70, remark: 'no text' } });
    assertEquals(r.ok, false, '系统码 0 只代表请求通了，不代表识别成功');
    assertEquals(r.reason, 'business');
    assertIncludes(r.message, '没有识别到', '错误码要翻成人话，而不是抛一个数字');
  });

  it('每个业务错误码都有人话说法（不能漏档）', () => {
    for (const code of [10, 20, 30, 40, 50, 60, 70, 80, 90]) {
      assert(Boolean(BUSINESS_ERRORS[code]), `错误码 ${code} 缺人话说明`);
      const r = parseOcrResponse({ showapi_res_body: { ret_code: code } });
      assertEquals(r.message, BUSINESS_ERRORS[code]);
    }
  });

  it('网关层错误（系统码非 0）单独归类', () => {
    const r = parseOcrResponse({ showapi_res_code: 400, showapi_res_error: 'Invalid AppCode' });
    assertEquals(r.ok, false);
    assertEquals(r.reason, 'gateway');
  });

  it('成功但文本为空 → 判失败，不返回空题干', () => {
    const r = parseOcrResponse({ showapi_res_body: { ret_code: 0, content: '   ' } });
    assertEquals(r.ok, false, '空文本必须当失败 —— 否则输入框被清空还没提示');
    assertEquals(r.reason, 'empty');
  });

  it('只有逐行结果（list）时按坐标拼回阅读顺序', () => {
    const r = parseOcrResponse({
      showapi_res_body: {
        ret_code: 0,
        list: [
          // 故意乱序：右栏先给，下行的先给 —— 直接按数组顺序拼会得到错乱题干
          { text: '第二行右侧', text_region: [[300, 120], [400, 120], [400, 140], [300, 140]] },
          { text: '第一行', text_region: [[10, 10], [200, 10], [200, 30], [10, 30]] },
          { text: '第二行左侧', text_region: [[10, 122], [200, 122], [200, 142], [10, 142]] },
        ],
      },
    });
    assertEquals(r.ok, true);
    assertEquals(r.rawText, '第一行\n第二行左侧\n第二行右侧', '必须按"先上后下、同行先左后右"排序');
  });

  it('配图坐标会被带出来（用于提醒学生题干可能缺图形信息）', () => {
    const r = parseOcrResponse({
      showapi_res_body: { ret_code: 0, content: '如图，导体棒匀速运动', figure: [{ x: 1, y: 2, w: 3, h: 4 }] },
    });
    assertEquals(r.ok, true);
    assertEquals(r.figures.length, 1);
  });

  it('完全不是 JSON 对象时也不会抛错', () => {
    for (const bad of [null, undefined, 'text', 42, []]) {
      const r = parseOcrResponse(bad);
      assert(r.ok !== true, `输入 ${JSON.stringify(bad)} 不该判成功`);
    }
  });
});

describe('拍照识题 · 阅读顺序排序', () => {
  it('没有坐标的数据保持原顺序（不做半吊子排序）', () => {
    const lines = [{ text: 'a', box: null }, { text: 'b', box: [[0, 0], [1, 0], [1, 1], [0, 1]] }];
    assertEquals(sortByReadingOrder(lines), lines, '坐标不全时排序会更乱，宁可不排');
  });
});

// ---------------------------------------------------------------------------
// 图片归一化
// ---------------------------------------------------------------------------

describe('拍照识题 · 图片值归一化（前缀这件事两派相反，必须按契约来）', () => {
  it('默认（题目识别契约）：剥掉 dataURL 前缀，只留纯 base64', () => {
    const out = normalizeImage(`data:image/png;base64,${'B'.repeat(60)}`);
    assertEquals(out, 'B'.repeat(60), '这个接口的 img 字段不接受 data: 前缀');
  });

  it('裸 base64 原样保留', () => {
    assertEquals(normalizeImage('C'.repeat(60)), 'C'.repeat(60));
  });

  it('要求带前缀的通道（dataUrlPrefix=true）会补上前缀', () => {
    const spec = { dataUrlPrefix: true };
    assert(
      normalizeImage(`data:image/png;base64,${'D'.repeat(60)}`, spec).startsWith('data:image/png;base64,'),
      '另一派接口反而要求带前缀 —— 所以这一项必须来自契约表',
    );
    assert(
      normalizeImage('E'.repeat(60), spec).startsWith('data:image/jpeg;base64,'),
      '裸 base64 要补默认前缀',
    );
  });

  it('空值与明显非法值返回 null', () => {
    for (const bad of ['', '   ', null, undefined, 'short', 'data:image/jpeg;base64,!!!@@@###$$$%%%^^^&&&***((()))___+++===']) {
      assertEquals(normalizeImage(bad), null, `${JSON.stringify(bad)} 应当被判为无效`);
    }
  });
});

// ---------------------------------------------------------------------------
// 端到端（全用假 fetch，零真实调用）
// ---------------------------------------------------------------------------

describe('拍照识题 · 端到端（假 fetch，不产生任何计费）', () => {
  it('成功：表单提交 + Authorization: APPCODE xxx + 取回文本', async () => {
    const fetchImpl = fakeFetch({ body: successBody('小球落地速度') });
    const res = await recognizeProblemImage(IMG, {
      config: readOcrConfig({ ALIYUN_OCR_APPCODE: APPCODE }),
      fetchImpl,
    });

    assertEquals(res.ok, true);
    assertEquals(res.rawText, '小球落地速度');
    assertEquals(res.charged, true);
    assertEquals(res.attempts, 1, '一次命中就该只用一次调用');

    const { init } = fetchImpl.calls[0];
    assertEquals(init.headers.Authorization, `APPCODE ${APPCODE}`, 'AppCode 认证格式必须是 APPCODE + 空格 + 值');
    assertIncludes(init.headers['Content-Type'], 'application/json', '这个接口要 JSON，不是表单');
    const sent = JSON.parse(String(init.body));
    assert(typeof sent.img === 'string' && sent.img.length > 0, '图片必须放在 img 字段里');
    assert(!sent.img.startsWith('data:'), 'img 必须是纯 base64，不能带 dataURL 前缀');
  });

  it('没配凭据时直接返回 not_configured，且**一次请求都不发**', async () => {
    const fetchImpl = fakeFetch({ body: successBody('x') });
    const res = await recognizeProblemImage(IMG, { config: readOcrConfig({}), fetchImpl });
    assertEquals(res.ok, false);
    assertEquals(res.reason, 'not_configured');
    assertEquals(fetchImpl.calls.length, 0, '没凭据就不该发请求');
    assertEquals(res.charged, false);
  });

  it('网络层失败（没到服务端）→ 不得抛错，且明确告知未计费', async () => {
    const fetchImpl = fakeFetch(() => {
      const err = new Error('getaddrinfo ENOTFOUND');
      throw err;
    });
    const res = await recognizeProblemImage(IMG, {
      config: readOcrConfig({ ALIYUN_OCR_APPCODE: APPCODE }),
      fetchImpl,
    });
    assertEquals(res.ok, false);
    assertEquals(res.reason, 'network');
    assertEquals(res.charged, false, '没到达服务端 ⇒ 未计费，可以放心重试');
  });

  it('业务码 10（参数错误）→ 契约已确定时不再换候选（没有第二个候选可试）', async () => {
    const fetchImpl = fakeFetch({ body: { showapi_res_body: { ret_code: 10, remark: 'param error' } } });
    const res = await recognizeProblemImage(IMG, {
      config: readOcrConfig({ ALIYUN_OCR_APPCODE: APPCODE }),
      fetchImpl,
    });
    assertEquals(res.ok, false);
    assertEquals(res.code, 10);
    assertIncludes(res.message, '参数', '要把"参数错误"如实说出来，而不是含糊的"识别失败"');
  });

  it('业务码 70（识别失败）→ 换字段名没用，必须立刻停手（停手就是省钱）', async () => {
    const fetchImpl = fakeFetch({ body: { showapi_res_body: { ret_code: 70, remark: 'no text' } } });
    const res = await recognizeProblemImage(IMG, {
      config: readOcrConfig({ ALIYUN_OCR_APPCODE: APPCODE }),
      fetchImpl,
    });
    assertEquals(res.ok, false);
    assertEquals(res.code, 70);
    assertEquals(fetchImpl.calls.length, 1, '图片本身识别不出来时，重试只是重复花钱');
  });

  it('HTTP 403（凭据无效）→ 只报一次，不反复敲', async () => {
    const fetchImpl = fakeFetch({ status: 403, body: 'Forbidden' });
    const res = await recognizeProblemImage(IMG, {
      config: readOcrConfig({ ALIYUN_OCR_APPCODE: APPCODE }),
      fetchImpl,
    });
    assertEquals(res.ok, false);
    assertEquals(res.reason, 'http');
    assertIncludes(res.message, '凭据');
    assertEquals(fetchImpl.calls.length, 1);
  });

  it('已命中过的形状会被复用：第二次调用不再走候选', async () => {
    const config = readOcrConfig({ ALIYUN_OCR_APPCODE: APPCODE });
    const first = fakeFetch({ body: successBody('第一次') });
    const r1 = await recognizeProblemImage(IMG, { config, fetchImpl: first });
    assertEquals(r1.ok, true);

    const second = fakeFetch({ body: successBody('第二次') });
    const r2 = await recognizeProblemImage(IMG, {
      config: { ...config, shape: r1.shape },
      fetchImpl: second,
    });
    assertEquals(r2.ok, true);
    assertEquals(second.calls.length, 1, '复用已验证形状后，一次调用就该成功');
    assertEquals(second.calls[0].url, first.calls[0].url);
  });

  it('任何返回里都不含 AppCode（凭据不出网）', async () => {
    const config = readOcrConfig({ ALIYUN_OCR_APPCODE: APPCODE });
    const ok = await recognizeProblemImage(IMG, { config, fetchImpl: fakeFetch({ body: successBody('题') }) });
    const bad = await recognizeProblemImage(IMG, {
      config,
      fetchImpl: fakeFetch({ body: { showapi_res_body: { ret_code: 70 } } }),
    });
    for (const r of [ok, bad]) {
      assertNotIncludes(JSON.stringify(r), APPCODE, '返回结构里绝不能带凭据');
    }
  });

  it('图片无效时直接返回，不发请求（不给必然失败的调用付费）', async () => {
    const fetchImpl = fakeFetch({ body: successBody('x') });
    const res = await recognizeProblemImage('not-an-image', {
      config: readOcrConfig({ ALIYUN_OCR_APPCODE: APPCODE }),
      fetchImpl,
    });
    assertEquals(res.reason, 'bad_image');
    assertEquals(fetchImpl.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 路由与前端契约（静态断言，不需要起服务）
// ---------------------------------------------------------------------------

describe('拍照识题 · 路由契约', () => {
  const router = readFileSync(join(ROOT, 'src/server/router.js'), 'utf8');
  const appJs = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  const html = readFileSync(join(ROOT, 'public/classic.html'), 'utf8');

  it('路由存在，且在调用前先挡掉过大的图片', () => {
    assertIncludes(router, "'/api/ocr'", '缺少 /api/ocr 路由');
    assert(/approxBytes\s*>\s*1_500_000/.test(router), '缺少前置体积校验 —— 过大的图会变成一次白花的计费调用');
  });

  it('识别结果只回填、不自动导入（这条是省钱也是防错）', () => {
    assertIncludes(router, 'edit_then_import', '服务端要显式告诉前端"这一步还没导入"');
    assertIncludes(appJs, 'stem-input', '识别结果要填进题干输入框');
    // 反例：识别成功后直接调导入接口就是"一键直通"，那是设计上明确否掉的
    const ocrFn = appJs.slice(appJs.indexOf('async function runOcr'), appJs.indexOf('function resetOcrPick'));
    assertNotIncludes(ocrFn, '/api/problem/import', '识别流程里不能顺手导入题目');
  });

  it('失败提示要区分"是否已计费"（两种情况的正确动作相反）', () => {
    assertIncludes(appJs, 'charged', '前端必须拿到计费状态');
    assertIncludes(appJs, '未计费', '要说清未计费可以放心重试');
  });

  it('凭据只在服务端：前端文件里不出现任何 OCR 凭据变量名', () => {
    for (const [name, text] of [['app.js', appJs], ['classic.html', html]]) {
      assertNotIncludes(text, 'ALIYUN_OCR_APPCODE', `${name} 里不该出现服务端凭据变量`);
      assertNotIncludes(text, 'APPCODE', `${name} 里不该出现 AppCode 认证头`);
    }
  });

  it('前端不再声称"这一环还没接"（文案必须与实现一致）', () => {
    assertNotIncludes(html, '这一环还没接', '已经接上了，就不能再写未接');
    assertNotIncludes(appJs, '图像 → 题干 的补法', '旧的"怎么补"文案应被真实实现说明取代');
    assertNotIncludes(html, '未接图像识别', '首页那句"本 Demo 未接图像识别"已经不成立，必须删掉');
  });

  /**
   * 这组断言来自一次真实的产品失误：
   * 拍照入口被放在二级卡片的 `<details>` 折叠块里，而折叠块默认收起 ——
   * 结果使用者"看不到拍照上传的页面"。
   *
   * 一个入口藏起来就等于没有。所以把"可见性"钉成断言，
   * 而不是靠以后记得"别再塞回折叠里"。
   */
  it('拍照入口必须直接可见：不能放在默认收起的折叠块里', () => {
    const dz = html.indexOf('id="dropzone"');
    assert(dz > 0, '找不到 dropzone');

    /**
     * 判据：拍照入口必须出现在**文字入口那个折叠块之前**，且在它所在的卡片内
     * 没有被别的折叠块包住。
     *
     * 为什么不用"向前找最近的 <details>"：页面上方还有别的折叠块（如"开始之前"），
     * 那样判断会把它们误伤成"包住了" —— 断言本身写错比没有断言更糟。
     */
    const foldIdx = html.indexOf('id="text-entry-fold"');
    assert(foldIdx > 0, '找不到文字入口折叠块');
    assert(dz < foldIdx, '拍照入口必须排在文字入口之前（它是第一入口，不该在折叠块后面）');

    // 卡片范围内不应有未闭合的 <details>
    const cardStart = html.lastIndexOf('<!-- 交题目', dz);
    assert(cardStart > 0, '找不到拍照所在卡片的注释标记');
    const segment = html.slice(cardStart, dz);
    assert(
      (segment.match(/<details/g) ?? []).length === (segment.match(/<\/details>/g) ?? []).length,
      '拍照入口上方有未闭合的折叠块 —— 它会被折起来，使用者就看不到了',
    );
  });

  it('识别结果的落点必须跟着展开（否则等于没填）', () => {
    assertIncludes(appJs, 'text-entry-fold', '回填时要展开文字入口');
    assertIncludes(appJs, 'fold.open = true', '折叠状态下的填充等于没填 —— 学生看不到识别结果');
  });

  it('卡片右上角有可读的可用性标签（一眼看出这条路通不通）', () => {
    assertIncludes(html, 'id="ocr-pill"', '缺可用性标签');
    assertIncludes(appJs, '识别可用', '可用时要有明确的正面标签');
    assertIncludes(appJs, '未启用', '不可用时也要如实说');
  });

  it('公网部署默认关闭拍照识题（否则等于把额度挂在公开链接上）', () => {
    const api = readFileSync(join(ROOT, 'api/index.js'), 'utf8');
    assertIncludes(api, 'PUBLIC_DEMO_ALLOW_OCR', '需要一个显式的开关，而不是靠部署时"记得别配"');
    assert(/delete process\.env\.ALIYUN_OCR_APPCODE/.test(api), '默认必须清除凭据');
  });

  it('仓库里的示例配置不含真实凭据', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    assert(/ALIYUN_OCR_APPCODE=\s*$/m.test(example), '.env.example 里的 AppCode 必须留空');
  });

  it('源码里没有硬编码的凭据与密钥', () => {
    /**
     * ⚠️ 这里曾经犯过一个很难发现的错误，值得写下来：
     *
     * 最初的写法是 `assertNotIncludes(ocrSrc, '<AppSecret 原文>')` ——
     * 也就是说，**为了检查"密钥不该出现在源码里"，我把密钥写进了源码**。
     * 检查逻辑本身是对的，但它把自己排除在扫描范围之外（只查 ocr.js），
     * 于是那串密钥就静静躺在 test/ocr.test.js 里等着被提交。
     *
     * 现在改成**运行时从 .env 取值来比对**：断言里不再出现任何真实字面量，
     * 也就不会再有"检查动作本身制造泄露"这种事。
     * （横跨全仓库的扫描在 test/ui.test.js 的「密钥与口令不外泄」里。）
     */
    loadEnvFile();
    const ocrSrc = readFileSync(join(ROOT, 'src/core/ocr.js'), 'utf8');
    const secrets = [
      ['LLM_API_KEY', String(process.env.LLM_API_KEY ?? '').trim()],
      ['ALIYUN_OCR_APPCODE', String(process.env.ALIYUN_OCR_APPCODE ?? '').trim()],
    ].filter(([, v]) => v.length > 8);

    for (const [name, value] of secrets) {
      assertNotIncludes(ocrSrc, value, `src/core/ocr.js 里不该出现 ${name} 的真实值`);
    }
    // 结构兜底：源码里不该有 32 位十六进制字面量（AppCode 的形态）
    const hex = ocrSrc.match(/['"][0-9a-f]{32}['"]/gi);
    assert(!hex, `源码里出现疑似凭据字面量：${hex?.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// 真实 HTTP 路由（起一个临时服务，端到端过一遍 /api/ocr）
// ---------------------------------------------------------------------------

describe('拍照识题 · 真实 HTTP 路由', () => {
  /**
   * 为什么值得起一个真服务：上面所有用例都只覆盖 core 层，
   * 而"图片太大被拦"、"没配凭据返回 503"、"错误体里带 charged 字段"
   * 这三件事**只发生在路由层**。它们恰恰是学生能感知到的那一层。
   * 用 Node 内置 http 起服务，不引任何依赖，与项目零依赖原则一致。
   */
  async function withServer(fn) {
    const { createServer } = await import('node:http');
    const { handleApi } = await import('../src/server/router.js');
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const handled = await handleApi(req, res, url);
      if (!handled) {
        res.statusCode = 404;
        res.end('{}');
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

  const post = (base, path, body) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('缺少图片 → 400，且不触达识别服务', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/api/ocr', {});
      assertEquals(res.status, 400);
      const json = await res.json();
      assertIncludes(json.error, '图片');
    });
  });

  it('图片过大 → 413，并且**在调用之前**就被拦下（这是省钱的关键一环）', async () => {
    await withServer(async (base) => {
      // 约 2.2MB 的伪 base64：足以越过 1.5MB 的业务阈值
      const huge = `data:image/jpeg;base64,${'A'.repeat(3_000_000)}`;
      const res = await post(base, '/api/ocr', { image: huge });
      assertEquals(res.status, 413, '过大的图必须在调用前拦掉');
      const json = await res.json();
      /**
       * 两道闸门任一拦下都算对，而且都要能回到客户端：
       *   · 读体守卫（更早，连 JSON 都不解析）
       *   · 业务前置校验（按 base64 反推原图体积）
       * 这条断言真正守的是"**学生能看到 413 而不是连接被重置**" ——
       * 见 router.js 里 destroy/pause 两个坑的说明。
       */
      assert(
        /超过识别上限|图片太大/.test(json.error ?? ''),
        `错误信息应当说清是图片太大，实际：${json.error}`,
      );
    });
  });

  it('未配置凭据 → 503 且提示可操作（不是 500，也不假装成功）', async () => {
    const saved = process.env.ALIYUN_OCR_APPCODE;
    delete process.env.ALIYUN_OCR_APPCODE;
    try {
      await withServer(async (base) => {
        const res = await post(base, '/api/ocr', { image: `data:image/jpeg;base64,${'A'.repeat(80)}` });
        assertEquals(res.status, 503);
        const json = await res.json();
        assertIncludes(json.hint, '粘贴题目文字', '要明确指向仍然可用的那条链路');
      });
    } finally {
      if (saved !== undefined) process.env.ALIYUN_OCR_APPCODE = saved;
    }
  });

  it('健康检查报告拍照识题状态，且不回传凭据', async () => {
    const saved = process.env.ALIYUN_OCR_APPCODE;
    process.env.ALIYUN_OCR_APPCODE = APPCODE;
    try {
      await withServer(async (base) => {
        const res = await fetch(`${base}/api/health`);
        const text = await res.text();
        assertEquals(res.status, 200);
        assertNotIncludes(text, APPCODE, '健康检查绝不能回传凭据');
        const json = JSON.parse(text);
        assertEquals(json.capabilities.ocr, true, '配了凭据就要报可用');
        assertEquals(json.ocr.configured, true);
      });
    } finally {
      if (saved !== undefined) process.env.ALIYUN_OCR_APPCODE = saved;
      else delete process.env.ALIYUN_OCR_APPCODE;
    }
  });

  it('健康检查在未配置时如实报 false（前端据此决定是否显示可用文案）', async () => {
    const saved = process.env.ALIYUN_OCR_APPCODE;
    delete process.env.ALIYUN_OCR_APPCODE;
    try {
      await withServer(async (base) => {
        const json = await (await fetch(`${base}/api/health`)).json();
        assertEquals(json.capabilities.ocr, false);
        assertEquals(json.ocr.configured, false);
      });
    } finally {
      if (saved !== undefined) process.env.ALIYUN_OCR_APPCODE = saved;
    }
  });
});
