/**
 * 设置面板（主题三选 + 字号三档）的前端契约测试。
 *
 * ============================================================================
 * 为什么单独一个套件
 * ============================================================================
 * 这套东西有一个很讨厌的性质：**写错了不会报错，只会不生效**。
 *
 *   - 首屏脚本在 <style> 之后跑 → 底色会先白一下再变黑（闪一帧）；
 *   - 忘了白名单 → localStorage 里一个脏值就把 `data-theme` 写成 `undefined`，
 *     整套深色 token 全不命中，页面变成"白底白字"；
 *   - 首屏那次也往 localStorage 里写 → 用户只是点开 `?theme=dark` 看一眼，
 *     偏好就被永久改成了深色，连「跟随系统」都会被吞掉；
 *   - 小屏抽屉规则写在基础规则**前面** → 被 288px 的桌面宽度覆盖回去，
 *     手机上是"半个面板飘在角落"（这个坑我们真踩过一次，所以钉在这里）。
 *
 * 这些都是纯静态就能查的：断言字符串与规则顺序，比在浏览器里点一遍快，也不会漏。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, assert, assertIncludes, assertNotIncludes } from './runner.js';
import { ROOT } from '../src/core/env.js';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const html = read('public/index.html');

/** 所有内联脚本拼起来 —— 设置面板的行为都在这里 */
const appJs = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
/** 首屏那段（head 里、<style> 之前）—— 它只负责"第一帧就别闪" */
const bootJs = [...html.slice(0, html.indexOf('<style')).matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');
const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];

/** 取某个选择器块的声明体（只认块内首层，够用） */
function block(selectorPattern) {
  const m = style.match(new RegExp(selectorPattern + '\\{([\\s\\S]*?)\\n\\}'));
  return m ? m[1] : '';
}

/** 把声明体解析成 { '--fs-body': '13px', ... } */
function decls(body) {
  const out = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const px = (v) => (/(\d+)px/.test(String(v)) ? Number(/(\d+)px/.exec(String(v))[1]) : NaN);

describe('设置 · 入口与面板结构', () => {
  it('齿轮顶替了原来的月亮按钮，并且带齐展开态语义', () => {
    const btn = (html.match(/<button[^>]*id="setBtn"[^>]*>/) || [''])[0];
    assert(btn, '顶栏里应当有一个 id="setBtn" 的按钮');
    assertIncludes(btn, 'aria-label="设置"', '设置按钮需要有可读名称');
    assertIncludes(btn, 'aria-haspopup="dialog"', '点了会弹面板，得告诉辅助技术');
    assertIncludes(btn, 'aria-controls="setPop"', '要指出它控制哪个元素');
    assertIncludes(btn, 'aria-expanded="false"', '初始是收起的');
    assertNotIncludes(html, 'id="themeBtn"', '旧的浅/深切换按钮应当已被齿轮取代');
  });

  it('面板是 dialog，主题是三选一的 radiogroup', () => {
    assertIncludes(html, 'id="setPop"', '面板容器应当存在');
    const pop = (html.match(/<div[^>]*id="setPop"[^>]*>/) || [''])[0];
    assertIncludes(pop, 'role="dialog"', '面板应当声明为 dialog');
    assertIncludes(pop, 'aria-label="设置"', '面板要有名称');
    assertIncludes(pop, 'hidden', '面板默认收起');

    const seg = (html.match(/<div[^>]*id="themeSeg"[^>]*>/) || [''])[0];
    assertIncludes(seg, 'role="radiogroup"', '主题是单选组，不是一组独立开关');
    const values = [...html.matchAll(/data-theme-set="([a-z]+)"/g)].map((m) => m[1]);
    assert(values.length === 3, `主题应当是 3 个选项，实际 ${values.length} 个：${values.join(', ')}`);
    for (const v of ['light', 'dark', 'system']) {
      assert(values.includes(v), `主题选项里缺 ${v}`);
    }
    const radios = [...html.matchAll(/<button[^>]*data-theme-set="[a-z]+"[^>]*>/g)].map((m) => m[0]);
    for (const r of radios) {
      assertIncludes(r, 'role="radio"', '每个选项都要声明 role=radio');
      assertIncludes(r, 'aria-checked=', '每个选项都要有选中态，否则读屏看不出选了哪个');
    }
  });

  it('字号是原生 range，三档吸附（min=0 max=2 step=1），只写小/中/大', () => {
    const range = (html.match(/<input[^>]*id="uxRange"[^>]*>/) || [''])[0];
    assert(range, '字号控件应当是一个 input');
    assertIncludes(range, 'type="range"', '要的是可拖的滑条');
    assertIncludes(range, 'min="0"', '三档：0 起');
    assertIncludes(range, 'max="2"', '三档：到 2 为止');
    assertIncludes(range, 'step="1"', '必须整数步进 —— 否则能停在半档上');
    assertIncludes(range, 'value="1"', '默认落在中间那档');
    assertIncludes(range, 'aria-valuetext="中"', '拖到哪一档要能被念出来（"中"而不是"1"）');

    const ticks = [...html.matchAll(/<span[^>]*>(小|中|大)<\/span>/g)].map((m) => m[1]);
    assert(ticks.length >= 3, `滑条下应当有三个刻度文字，实际 ${ticks.length} 个`);
  });
});

describe('设置 · 首屏与落盘', () => {
  it('首屏脚本必须在 <style> 之前跑，否则会先白闪一下', () => {
    const firstScript = html.indexOf('<script');
    const firstStyle = html.indexOf('<style>');
    assert(firstScript >= 0 && firstStyle > firstScript, '上色脚本应当排在样式之前');
  });

  it('首屏只认三主题 + 三档这两组白名单，且不往 localStorage 里写', () => {
    assert(bootJs, 'head 里应当有一段首屏脚本');
    for (const token of ["'light'", "'dark'", "'system'"]) {
      assertIncludes(bootJs, token, `首屏脚本应当认识主题值 ${token}`);
    }
    assert(/['"]s['"]/.test(bootJs) && /['"]m['"]/.test(bootJs) && /['"]l['"]/.test(bootJs),
      '首屏脚本应当认识字号三档 s/m/l');
    assertNotIncludes(bootJs, 'setItem', '首屏只还原、不落盘：看一眼 ?theme= 不该改掉人的偏好');
    assertIncludes(bootJs, 'bsj-theme', '主题偏好的键沿用 bsj-theme');
    assertIncludes(bootJs, 'bsj-ux', '字号偏好的键是 bsj-ux');
  });

  it('只有人点选才写偏好 —— 首屏那次调用要显式传 persist=false', () => {
    assertIncludes(appJs, 'paintTheme(themePref(), false)', '首屏还原主题时不该落盘');
    assertIncludes(appJs, 'paintUx(', '字号也要有还原路径');
    assert(/paintTheme\s*:\s*function|function paintTheme\(pref, persist\)/.test(appJs) ||
      /function paintTheme\(pref, persist\)/.test(appJs), 'paintTheme 应当接受 persist 开关');
    assert(/if\s*\(persist\s*!==\s*false\)/.test(appJs), '写 localStorage 要被 persist 开关挡住');
  });

  it('偏好与生效值分开存：data-theme 只可能是 light / dark', () => {
    assertIncludes(appJs, "setAttribute('data-theme-pref'", '偏好要单独记，才能表达"跟随系统"');
    assertIncludes(appJs, "setAttribute('data-theme'", '生效值另存一个属性');
    assert(/var dark = pref === 'dark' \|\| \(pref === 'system'/.test(appJs),
      'system 应当被解析成 light/dark —— 否则深色那 20 多条选择器都得跟着改');
  });
});

describe('设置 · 字号三档', () => {
  const mid = decls(block(':root'));
  const small = decls(block('html\\[data-ux="s"\\]'));
  const large = decls(block('html\\[data-ux="l"\\]'));

  it('三档都定义了同一套 token（少一个就会在那一档掉回默认值）', () => {
    const keys = Object.keys(mid).filter((k) => /^--(fs|topbar|ctl|input-h|ico|av|pane-head)/.test(k));
    assert(keys.length >= 12, `中档应当定义十几个字号与尺寸 token，实际 ${keys.length} 个`);
    for (const k of keys) {
      assert(k in small, `小档缺 ${k} —— 那一档会掉回中档的值，缩放就不成比例了`);
      assert(k in large, `大档缺 ${k}`);
    }
  });

  it('每一档都是整数 px，且小 < 中 < 大', () => {
    for (const k of Object.keys(mid)) {
      if (!/^--(fs|topbar|ctl|input-h|ico|av|pane-head)/.test(k)) continue;
      const [s, m, l] = [px(small[k]), px(mid[k]), px(large[k])];
      assert(![s, m, l].some(Number.isNaN), `${k} 必须是整数 px（小 ${small[k]} / 中 ${mid[k]} / 大 ${large[k]}）`);
      assert(s < m && m < l, `${k} 三档应当递增：小 ${s} < 中 ${m} < 大 ${l}`);
    }
  });

  it('中档就是改动前的原值（默认设置下界面一个像素都不该动）', () => {
    assert(px(mid['--fs-body']) === 13, '中档题干字号应当还是 13');
    assert(px(mid['--fs-sub']) === 15, '中档小标题应当还是 15');
    assert(px(mid['--fs-title']) === 18, '中档标题应当还是 18');
    assert(px(mid['--topbar']) === 52, '中档顶栏应当还是 52');
    assert(px(mid['--ctl']) === 32, '中档圆钮应当还是 32');
    assert(px(mid['--input-h']) === 48, '中档输入框应当还是 48');
  });

  it('小屏抽屉规则必须排在基础规则之后（否则被 288px 覆盖回去）', () => {
    const base = style.indexOf('.set{\n  position:fixed');
    assert(base > 0, '应当有 .set 的基础定位规则');
    const mobile = style.indexOf('.set{\n    top:auto');
    assert(mobile > base, '小屏抽屉的覆盖必须写在基础规则之后 —— 顺序写反就会失效');
    assert(/@media \(max-width:760px\)\{[\s\S]*top:auto[\s\S]*bottom:0/.test(style),
      '小屏应当改成贴底整宽');
  });
});

describe('设置 · 深浅两套不能互相丢', () => {
  it('深色主题的整套 token 还在（加设置不该把它弄丢）', () => {
    const dark = decls(block('html\\[data-theme="dark"\\]'));
    for (const k of ['--paper', '--surface', '--ink', '--brand']) {
      assert(k in dark, `深色主题缺少 ${k}`);
    }
  });

  it('面板的选中态浅色与深色各有一套', () => {
    assertIncludes(style, '.set-seg button[aria-checked="true"]', '浅色下选中态要有自己的背景');
    assertIncludes(style, 'html[data-theme="dark"] .set-seg button[aria-checked="true"]',
      '深色下药丸得更亮一点，否则糊在面板上');
  });
});
