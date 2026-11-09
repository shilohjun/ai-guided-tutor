/**
 * 看板页（`public/admin.html`）的静态契约。
 *
 * ============================================================================
 * 为什么这个页面需要一套自己的契约测试
 * ============================================================================
 * 它是**唯一一个服务端闸不住的页面**：文件由静态托管直出，`handleApi` 收不到它，
 * CloudBase 的静态托管也不会鉴权。所以这个文件里不能有任何数据 ——
 * 一旦有人 "顺手把上次那批的 id 写进去，方便打开"，全班数据就挂在了公网上，
 * 而这件事不会有任何报错。
 *
 * 其余几条守的是同一类 "只在浏览器里才会炸、而且炸得很安静" 的问题：
 *
 *   ① **五根柱子**。产品只有四页（`PAGES = ['题目','方式','解题','报告']`）。
 *      多画一根不会报错，只会让每个看过看板的人都记住一个错的产品形状。
 *   ② **点了没反应**。脚本 `$('#xxx')` 引用的 id 若在页面里不存在，
 *      JS 只会抛一个没人看的 TypeError，界面就是死的。
 *   ③ **空批次把看板画成一排 0 柱**。"这批没人用" 和 "数据没读到" 长得一模一样，
 *      而它们要做的决定正好相反 —— 所以空态必须是一句话，不是四根空柱子。
 *   ④ **样本不足还给百分比**。一个人的样本算出来的转化率是假结论，
 *      而它看起来和真结论完全一样。
 *   ⑤ **口令进链接**。`?code=` 会进浏览器历史、进代理日志、进别人发来的截图。
 *
 * 手法与 `test/ui.test.js` 相同：只读文件、只做静态断言，不起浏览器。
 */

import { readFileSync } from 'node:fs';
import { describe, it, assert, assertEquals, assertIncludes, assertNotIncludes } from './runner.js';

const PATH = new URL('../public/admin.html', import.meta.url);

/** 页面全文。文件不存在时这里抛 ENOENT —— 那正是这一步该有的红。 */
const html = () => readFileSync(PATH, 'utf8');

/** 唯一一段内联脚本（单文件页，不引任何外部脚本） */
const script = () => (html().match(/<script>([\s\S]*?)<\/script>/) || [null, ''])[1];

/** 唯一一段内联样式 */
const style = () => (html().match(/<style>([\s\S]*?)<\/style>/) || [null, ''])[1];

/** 四页的名字是产品事实，任何地方都不许出现第五页 */
const PAGE_LABELS = ['题目', '方式', '解题', '报告'];

describe('看板 · 静态契约（首屏结构）', () => {
  it('漏斗是四根柱，不是五根', () => {
    const s = html();
    for (const n of [1, 2, 3, 4]) assertIncludes(s, `data-stage="${n}"`);
    assert(!s.includes('data-stage="5"'), '第五根柱子在代码里不存在');
    assertEquals(s.split('data-stage="').length - 1, 4, '柱子只能有四根（多一根就是错的产品形状）');
  });

  it('四个 KPI 与用量行都在', () => {
    const s = html();
    for (const k of ['visits', 'sessions', 'finished', 'turnFailure']) assertIncludes(s, `data-kpi="${k}"`);
    assertIncludes(s, 'data-usage');
    // 用量行只许有一处：两个就能互相打架，而肉眼很难发现
    assertEquals(s.split('data-usage').length - 1, 1, '用量行只该有一个（data-usage 只出现一次）');
    assertEquals(s.split('data-kpi="').length - 1, 4, 'KPI 只能有四个');
  });

  it('四根柱子的标签就是四页，且没有第五页的任何写法', () => {
    const s = html();
    const labels = [...s.matchAll(/class="bar-label">([^<]+)</g)].map((m) => m[1].trim());
    assertEquals(labels.join('/'), PAGE_LABELS.join('/'), '四根柱子要按四页命名（题目 / 方式 / 解题 / 报告）');
    assertNotIncludes(s, '第 5 页');
    assertNotIncludes(s, '第5页');
    assertNotIncludes(s, '五页');
  });

  it('页脚写明这批数据回答的是"会不会用"', () => {
    const s = html();
    assertIncludes(s, '会不会用');
    assertIncludes(s, '不回答有没有效果');
  });

  it('看板不出现答案相关字样', () => {
    const s = html();
    assertNotIncludes(s, '参考答案');
    assertNotIncludes(s, '答案');
  });
});

describe('看板 · 静态契约（闸门与空态）', () => {
  it('口令只在请求头里：bsj-admin 键名 + x-admin-code 头，不进查询串', () => {
    const s = html();
    assertIncludes(s, "'bsj-admin'");
    assertIncludes(s, 'x-admin-code');
    assertIncludes(s, 'location.search');
    assert(!/[?&]code=/i.test(s), '口令不能进查询串（会进历史、日志、截图）');
    assert(!/adminCode=|admin_code=/i.test(s), '口令不能进查询串');
  });

  it('文件里没有写死的批次号（它是壳，批次只能来自链接或输入框）', () => {
    const s = html();
    const hard = s.match(/[?&]batch(?:Id)?=[A-Za-z0-9_-]{2,}/g) || [];
    assertEquals(hard.length, 0, '批次号只能从 ?batch= 或输入框来，不能写死在文件里：' + hard.join('、'));
  });

  it('载入失败按状态说人话，不是状态码或英文栈', () => {
    const s = html();
    assertIncludes(s, '这个部署没开看板');
    assertIncludes(s, '口令不对');
    assertIncludes(s, '读取失败，请刷新重试');
    assert(!/\.stack\b/.test(s), '页面不该把堆栈当文案');
  });

  it('样本不足时只说一句话，不给百分比', () => {
    const s = html();
    assertIncludes(s, '样本太少');
    assertIncludes(s, 'sampleTooSmall');
  });

  it('空批次是空态一句话，不画四根空柱子', () => {
    const s = html();
    assertIncludes(s, '还没有人打开');
    assertIncludes(s, "('bars').hidden", '空批次要把整组柱子收起来，而不是画一排 0');
    assertIncludes(s, "('funnelEmpty').hidden");
  });
});

describe('看板 · 静态契约（单文件与令牌）', () => {
  it('零依赖：没有外链脚本、外链样式、import 或构建产物', () => {
    const s = html();
    const js = script();
    assert(!/<script[^>]+src=/i.test(s), '不许引外部脚本（单文件、无构建）');
    assert(!/<link\b/i.test(s), '不许引外部样式或字体');
    assert(!/https?:\/\//i.test(s), '文件里不该出现任何外链地址');
    assert(!/^\s*import\b/m.test(js), '不许用 import（浏览器直接打开也要能跑）');
    assert(!/\brequire\(/.test(js), '不许用 require');
  });

  it('字号只有三档（11 / 13 / 18），间距只用令牌表', () => {
    const css = style();
    const tokens = [...css.matchAll(/--fs-([a-z]+):\s*(\d+)px/g)].map((m) => Number(m[2]));
    assertEquals([...new Set(tokens)].sort((a, b) => a - b).join('/'), '11/13/18', '字号三档必须是 11 / 13 / 18');

    const raw = [...css.matchAll(/font-size:\s*([^;}]+)/g)]
      .map((m) => m[1].trim())
      .filter((value) => !/^var\(--fs-[sml]\)$/.test(value));
    assert(raw.length === 0, 'font-size 只能引用三档变量：' + raw.join(' | '));

    const allowed = new Set(['0', '2', '4', '6', '8', '12', '16', '24', '32']);
    const bad = [];
    const spacingRe =
      /(?:^|[;{\s])(padding|margin|gap|row-gap|column-gap|padding-(?:top|right|bottom|left)|margin-(?:top|right|bottom|left)):\s*([^;}]+)/g;
    for (const m of css.matchAll(spacingRe)) {
      for (const part of m[2].trim().split(/\s+/)) {
        const value = part.replace(/px$/, '');
        if (!/^[0-9.]+$/.test(value)) continue; // auto / var() / % / calc()
        if (!allowed.has(value)) bad.push(m[1] + ': ' + part);
      }
    }
    assert(bad.length === 0, '间距只能用 2/4/6/8/12/16/24/32：' + bad.join(' | '));
  });

  it('内联脚本能编译、只有一个网络入口、首屏不自动取数', () => {
    const js = script();
    assert(js.trim().length > 800, '内联脚本不该是空的');

    let syntax = null;
    try {
      // 只编译不执行：语法错会在这里炸，而不是等到现场演示时
      new Function(js);
    } catch (err) {
      syntax = err.message;
    }
    assertEquals(syntax, null, '内联脚本语法不通过');

    assertEquals(js.split('fetch(').length - 1, 1, '整个页面只许有一个网络入口（一处加口令、一处兜错）');
    assert(
      !/^\s{0,2}(?:load|request|compare|download)\(/m.test(js),
      '首屏不许自动取数：网络调用只能由「载入」/「导出」触发',
    );
  });

  it('脚本引用的每个 id 都在页面里（防止点了没反应）', () => {
    const s = html();
    const declared = new Set([...s.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const refs = [...new Set([...script().matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
    assert(refs.length >= 10, '脚本应当通过 $() 拿若干元素，实际只有 ' + refs.length + ' 个');
    const missing = refs.filter((id) => !declared.has(id));
    assert(missing.length === 0, '脚本引用了页面上不存在的 id（运行时会静默失效）：' + missing.join('、'));
  });

  it('顶部注释写明：没配 ADMIN_CODE 的部署不要发布这个文件', () => {
    const s = html();
    const styleAt = s.indexOf('<style');
    assert(styleAt > 0, '页面应当有内联样式');
    const head = s.slice(0, styleAt);
    assertIncludes(head, '<!--', '文件顶部要有一段 HTML 注释');
    assertIncludes(head, '没有配置 ADMIN_CODE 的部署不要发布这个文件');
    assertIncludes(head, '但会告诉别人有看板');
  });
});

describe('看板 · 静态契约（导出）', () => {
  it('导出走 Blob + 本地下载，非 200 先读 error 那句再说话', () => {
    const s = html();
    assertIncludes(s, 'createObjectURL');
    assertIncludes(s, 'revokeObjectURL');
    assertIncludes(s, '.blob()');
    assertIncludes(s, '.download');
    assertIncludes(s, 'body.error', '非 200 时要把 JSON 里的那句人话显示出来，而不是下载一个空文件');
  });
});
