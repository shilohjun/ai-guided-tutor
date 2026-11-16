/**
 * 符号面板的测试：清单的形状 + 插入位置的计算。
 *
 * ============================================================================
 * 为什么这几条值得单独测
 * ============================================================================
 * 面板本身是"看得见就能用"，出不了太多错。真正会坏的是**插入落点**：
 *
 *   光标在中间时插到末尾  → 学生改了三个字才发现，得重打
 *   有选区时不覆盖        → 变成插在选区前面，语义反了
 *   空框时插到 -1         → 文本直接损坏
 *   题库灌进来的题干      → textarea 从没被点过，selectionStart 默认是 0，
 *                          拿它当光标会把符号插到**开头**
 *
 * 前三种是 `spliceSymbol()` 的契约，直接测。最后一种靠调用方"这个框被碰过吗"
 * 来兜（`caretOf()`），是 DOM 层的事，这里用一条注释把它记在账上 ——
 * 这个仓库没有 DOM 环境，`ui.test.js` 也是读源码断言。
 *
 * ============================================================================
 * 为什么这份测试比原来多
 * ============================================================================
 * 面板 2026-10-28 从主界面消失时，CI 是**全绿**的：清单还在、规则还在、
 * 用例还在跑，没有任何一条断言问过"界面上还有这个入口吗"。
 * 所以这轮除了这份用例，`test/ui.test.js` 还补了一条 DOM 契约。
 */

import { describe, it, assert, assertEquals } from './runner.js';
import { PALETTE, allSymbols, spliceSymbol, panelPlacement } from '../public/symbolpanel.js';

describe('符号面板 · 清单', () => {
  it('按"学生实际用到的频率"分组，上标与下标排在最前', () => {
    assertEquals(PALETTE[0].group, '上标');
    assertEquals(PALETTE[1].group, '下标');
    assert(PALETTE.length >= 4, '面板至少要覆盖上标/下标/希腊/运算');
  });

  it('没有重复项（同一个符号出现两次，学生要多想一遍"是不是不一样"）', () => {
    const counts = new Map();
    for (const symbol of allSymbols()) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    assertEquals(dupes.join(','), '', `面板有重复符号：${dupes.join(',')}`);
  });

  it('每一项都非空、不含空白与 ASCII 字母数字', () => {
    /* 空白会让格子里看不见东西；ASCII 字母数字本来就能直接打，
       放进面板只是多一格要扫视 */
    for (const symbol of allSymbols()) {
      assert(String(symbol).length > 0, '面板里有空项');
      assert(!/\s/.test(symbol), `面板里 "${symbol}" 含空白字符`);
      assert(!/^[A-Za-z0-9]$/.test(symbol), `面板里 "${symbol}" 是 ASCII 字符，本来就能直接打`);
    }
  });

  it('覆盖物理最常用的那几个：平方、下标零、微、欧姆、根号、不等号', () => {
    const set = new Set(allSymbols());
    for (const symbol of ['²', '³', '₀', 'μ', 'Ω', '√', '≈', '≥', '≤', 'Δ']) {
      assert(set.has(symbol), `面板缺 ${symbol}`);
    }
  });
});

describe('符号面板 · 插入落点', () => {
  it('光标在末尾时追加', () => {
    const hit = spliceSymbol('F = ma', '²', 6, 6);
    assertEquals(hit.value, 'F = ma²');
    assertEquals(hit.caret, 7);
  });

  it('光标在中间时插在中间，不跳到末尾', () => {
    const hit = spliceSymbol('v = at', '₀', 1, 1);
    assertEquals(hit.value, 'v₀ = at');
    assertEquals(hit.caret, 2);
  });

  it('有选区时覆盖选区，而不是插在选区前面', () => {
    const hit = spliceSymbol('m/s2 的加速度', '²', 3, 4);
    assertEquals(hit.value, 'm/s² 的加速度');
    assertEquals(hit.caret, 4);
  });

  it('空框里插入只有符号本身', () => {
    const hit = spliceSymbol('', '√', 0, 0);
    assertEquals(hit.value, '√');
    assertEquals(hit.caret, 1);
  });

  it('连续插两次（m/s² 要连点两次）能叠加起来', () => {
    const first = spliceSymbol('a = 10 m/s', '²', 10, 10);
    assertEquals(first.value, 'a = 10 m/s²');
    assertEquals(first.caret, 11);
    const second = spliceSymbol(first.value, '⁻²', 11, 11);
    assertEquals(second.value, 'a = 10 m/s²⁻²');
    assertEquals(second.caret, 13);
  });

  it('多字符符号（⁻¹ 这类）按整体长度推进光标', () => {
    const hit = spliceSymbol('k = 5 ', '⁻¹', 6, 6);
    assertEquals(hit.value, 'k = 5 ⁻¹');
    assertEquals(hit.caret, 8);
  });

  it('光标缺省或不是数字时一律追加到末尾', () => {
    const cases = [
      [undefined, undefined],
      [null, null],
      [NaN, NaN],
      ['x', 'y'],
    ];
    for (const [start, end] of cases) {
      const hit = spliceSymbol('v²', '≈', start, end);
      assertEquals(hit.value, 'v²≈', `start=${String(start)} end=${String(end)} 应追加到末尾`);
      assertEquals(hit.caret, 3);
    }
  });

  it('整数越界时夹进 [0, 长度]（小于 0 落到开头，大于长度落到末尾）', () => {
    assertEquals(spliceSymbol('v²', '≈', 99, 99).value, 'v²≈');
    assertEquals(spliceSymbol('v²', '≈', -5, -5).value, '≈v²');
    assertEquals(spliceSymbol('v²', '≈', 2.9, 2.9).value, 'v²≈');
  });

  it('start 大于 end（选区反着拖）时正常插入，不丢字', () => {
    const hit = spliceSymbol('abcd', 'X', 3, 1);
    assertEquals(hit.value, 'aXd');
    assertEquals(hit.caret, 2);
  });

  it('value 为 null / undefined 不崩', () => {
    assertEquals(spliceSymbol(null, 'Δ').value, 'Δ');
    assertEquals(spliceSymbol(undefined, 'Δ').value, 'Δ');
  });

  it('插入只改一处，其余文本原样保留', () => {
    const text = '已知 m = 2 kg，求 a。（保留这句）';
    const hit = spliceSymbol(text, '₀', 2, 2);
    assertEquals(hit.value, '已知₀ m = 2 kg，求 a。（保留这句）');
    assertEquals(hit.value.length, text.length + 1);
  });
});

describe('符号面板 · 摆放（不许压住输入框）', () => {
  /** 面板自然尺寸：五组、480px 宽时的高度；实测 556 */
  const SIZE = { width: 480, height: 556 };
  const VIEWPORT = { width: 1568, height: 939 };

  const place = (anchor, viewport = VIEWPORT, size = SIZE) =>
    panelPlacement({
      trigger: { right: 1560, top: anchor.bottom - 40, bottom: anchor.bottom },
      anchor,
      size,
      viewport,
    });

  /** 面板真实的垂直占用：高度被 maxHeight 钳过 */
  const bottomOf = (r) => r.top + Math.min(SIZE.height, r.maxHeight);

  it('上方空间够时整块开在输入框上方，并且高度被钳到不越界', () => {
    const r = place({ top: 700, bottom: 925 });
    assertEquals(r.side, 'above');
    assertEquals(r.maxHeight, 700 - 16);
    assert(bottomOf(r) <= 700, '面板底边越过了输入框上沿');
    // 空间装得下整个面板时高度不缩，只是贴着输入框上沿往上摆
    assertEquals(r.top, 700 - SIZE.height - 8);
  });

  it('这是学生报的那个真实尺寸：视口 939 / 输入框上沿 450 / 面板自然高 556', () => {
    /* 修之前：面板 556 高、上方只有 434，落到"钳进视口"兜底 → 压在输入框上。
       修之后：高度钳到 434，正好停在输入框上沿之上。 */
    const r = place({ top: 450, bottom: 675 });
    assertEquals(r.side, 'above');
    assertEquals(r.maxHeight, 434);
    assertEquals(r.top, 8);
    assertEquals(bottomOf(r), 442);
    assert(bottomOf(r) <= 450, '面板压住了输入框');
  });

  it('上方太挤、下方有地方时翻到输入框下面', () => {
    const r = place({ top: 120, bottom: 345 }, { width: 800, height: 939 });
    assertEquals(r.side, 'below');
    assertEquals(r.top, 345 + 8);
    assert(r.maxHeight >= 160, '翻到下面也要留出能用的高度');
  });

  it('上下都挤（窗口很矮）时明确降级，不假装没问题', () => {
    const r = place({ top: 80, bottom: 120 }, { width: 800, height: 200 });
    assertEquals(r.side, 'clamped');
    assert(r.top >= 8, '面板不该被推出视口顶部');
  });

  it('只要走的是 above / below，就永不与输入框相交（扫一遍输入框位置）', () => {
    for (let top = 40; top <= 880; top += 20) {
      const anchor = { top, bottom: top + 225 };
      const r = place(anchor);
      if (r.side === 'clamped') continue; // 兜底档单独一条，见上
      const bottom = bottomOf(r);
      const overlaps = Math.max(0, Math.min(bottom, anchor.bottom) - Math.max(r.top, anchor.top));
      assertEquals(overlaps, 0, `输入框上沿 ${top} 时重叠了 ${overlaps}px`);
    }
  });

  it('横向右对齐到触发按钮；按钮贴右边时被夹回视口内', () => {
    const normal = panelPlacement({
      trigger: { right: 900, top: 0, bottom: 0 },
      anchor: { top: 700, bottom: 925 },
      size: SIZE,
      viewport: VIEWPORT,
    });
    assertEquals(normal.left, 900 - 480);

    const edge = panelPlacement({
      trigger: { right: 1560, top: 0, bottom: 0 },
      anchor: { top: 700, bottom: 925 },
      size: SIZE,
      viewport: VIEWPORT,
    });
    assertEquals(edge.left, VIEWPORT.width - 480 - 8);
    assert(edge.left + 480 <= VIEWPORT.width, '面板右侧溢出视口');
  });

  it('窄视口（手机）上面板宽度不会超过视口', () => {
    const narrow = { width: 360, height: 780 };
    const r = panelPlacement({
      trigger: { right: 350, top: 0, bottom: 0 },
      anchor: { top: 500, bottom: 700 },
      size: { width: 336, height: 700 },
      viewport: narrow,
    });
    assert(r.left >= 8, '面板被推到视口左边缘之外');
    assert(r.left + 336 <= narrow.width, '面板右侧溢出视口');
  });
});
