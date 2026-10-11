/**
 * 符号输入辅助的测试。
 *
 * 这段逻辑是一堆字符串规则，最容易出的错不是"没替换"，而是**替错了**——
 * 学生打 `sin53` 变成 `sin₅₃`、打 `phi` 变成 `π` 加个 h，那比不支持符号更糟：
 * 他会以为输入框坏了，然后放弃写公式。
 *
 * 所以用例的重心是"**不该动的绝不动**"。
 */

import { describe, it, assert, assertEquals } from './runner.js';
import {
  applyShortcut,
  applyShortcutToText,
  toSuperscript,
  toSubscript,
  GREEK,
  PALETTE,
} from '../public/mathinput.js';

/**
 * 模拟**真实的逐字输入**。
 *
 * 这一点很关键：`applyShortcut` 是在每次 input 事件上跑的，
 * 每次只看"光标之前"的一小段。拿一整串去测只能覆盖最后一个符号，
 * 而且会漏掉"打到一半时规则成不成立"这类真正的问题
 * （`pilot` 会在敲到 `pi` 的瞬间被替换掉 —— 就是靠逐字测试才发现的）。
 */
function typed(sequence, { flush = true } = {}) {
  let text = '';
  for (const ch of sequence) {
    text += ch;
    const hit = applyShortcut(text);
    if (hit) text = text.slice(0, hit.start) + hit.replacement + text.slice(hit.end);
  }
  // 失焦 / 点发送前会做一次 flush，把行尾的符号名也收掉
  if (flush) text = applyShortcutToText(text, { flush: true });
  return text;
}

describe('符号输入 · 上标与下标', () => {
  it('^2 → ²，^-1 → ⁻¹（`^` 是显式的幂写法，可以放心替换）', () => {
    assertEquals(typed('v^2'), 'v²');
    assertEquals(typed('10^-3'), '10⁻³');
    assertEquals(typed('m/s^2'), 'm/s²');
    assertEquals(typed('(R+r)^2'), '(R+r)²');
  });

  it('_0 → ₀（`_` 是显式的下标写法）', () => {
    assertEquals(typed('v_0'), 'v₀');
    assertEquals(typed('B_1'), 'B₁');
    assertEquals(typed('a_1+b_2'), 'a₁+b₂');
  });

  it('替换区间只覆盖刚打完的那一段，不动前面的正文', () => {
    const before = '我算出 v^2';
    const hit = applyShortcut(before);
    // "我算出 v^2" → 我(0) 算(1) 出(2) 空格(3) v(4) ^(5) 2(6)，所以 `^` 在下标 5
    assertEquals(hit.start, 5, 'start 应指向 `^`');
    assertEquals(hit.end, before.length);
    assertEquals(hit.replacement, '²');
    assertEquals(typed(before), '我算出 v²');
  });
});

describe('符号输入 · 希腊字母', () => {
  it('拼音名 → 字母', () => {
    assertEquals(typed('mu'), 'μ');
    assertEquals(typed('theta'), 'θ');
    assertEquals(typed('rho'), 'ρ');
    assertEquals(typed('Omega'), 'Ω');
    assertEquals(typed('omega'), 'ω');
    assertEquals(typed('ohm'), 'Ω');
  });

  it('大小写是两个不同的量，不能折叠', () => {
    assertEquals(typed('omega'), 'ω', '小写是角速度');
    assertEquals(typed('Omega'), 'Ω', '大写是电阻');
  });

  it('【关键】不会吃掉更长单词的一部分', () => {
    // `pi` 是 `phi` 的前缀，规则排序错了就会把 phi 变成 "πh"
    assertEquals(typed('phi'), 'φ');
    assertEquals(typed('Phi'), 'Φ');
    // 词中间不该触发
    assertEquals(typed('mum'), 'mum');
    assertEquals(typed('pilot'), 'pilot');
    assertEquals(typed('theta2'), 'θ₂', '紧跟的数字顺带转成下标 —— 这是学生最可能的意图');
  });
});

describe('符号输入 · 运算符与根号', () => {
  it('两个字符的组合键 → 数学符号', () => {
    assertEquals(typed('5>=3'), '5≥3');
    assertEquals(typed('5<=3'), '5≤3');
    assertEquals(typed('a!=b'), 'a≠b');
    assertEquals(typed('x~=y'), 'x≈y');
    assertEquals(typed('A->B'), 'A→B');
  });

  it('sqrt → √（整词）', () => {
    assertEquals(typed('sqrt'), '√');
    assertEquals(typed('sqrt2'), '√2');
  });

  it('单个 `=`、`>`、`<` 绝不动（那是方程本身）', () => {
    for (const s of ['E=BLv', 'a>b', 'x<y', 'v=gt=20m/s']) {
      assertEquals(typed(s), s, `"${s}" 不该被改写`);
    }
  });
});

describe('符号输入 · 不该猜的地方不猜', () => {
  /**
   * 这一组是本套件存在的主要理由。
   *
   * "自动把 v0 变成 v₀"看起来很贴心，但 `sin53` 会变成 `sin₅₃` ——
   * 而 `sin53°` 是这道题里真实存在的写法。
   * 省下两个按键，换来一个会悄悄改坏公式的输入框，不划算。
   */
  it('【关键】裸数字不当下标：sin53 不能变成 sin₅₃', () => {
    assertEquals(typed('sin53'), 'sin53');
    assertEquals(typed('sin53°'), 'sin53°');
    assertEquals(typed('cos53'), 'cos53');
    assertEquals(typed('g=10m/s2'), 'g=10m/s2', 'm/s2 也不猜 —— 单位该用面板或 ^2');
  });

  it('普通中文与英文原样通过', () => {
    for (const s of ['我先求电动势', 'I use Ohm law', '回路里除了 R 还有 r', 'v=gt']) {
      assertEquals(typed(s), s);
    }
  });

  it('已经打好符号的文本不会被二次改写', () => {
    for (const s of ['v²', 'v₀', 'μ', '√2', 'F_安']) {
      assertEquals(typed(s), s, `"${s}" 应原样保留`);
    }
  });
});

describe('符号输入 · 面板与工具', () => {
  it('上下标转换器与映射一致', () => {
    assertEquals(toSuperscript('2'), '²');
    assertEquals(toSuperscript('-1'), '⁻¹');
    assertEquals(toSubscript('03'), '₀₃');
  });

  it('面板按"学生实际用到的频率"分组，上标与下标排在最前', () => {
    assertEquals(PALETTE[0].group, '上标');
    assertEquals(PALETTE[1].group, '下标');
    assert(PALETTE.length >= 4, '面板至少要覆盖上标/下标/希腊/运算');
  });

  it('面板里没有重复项会让人困惑（`Δ` 同时属于希腊与其它是有意的，检查其余不重复）', () => {
    const counts = new Map();
    for (const g of PALETTE) for (const it of g.items) counts.set(it, (counts.get(it) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([k, v]) => v > 1 && k !== 'Δ').map(([k]) => k);
    assertEquals(dupes.join(','), '', `面板有重复符号：${dupes.join(',')}`);
  });

  it('希腊字母表覆盖物理常用量（电阻 Ω、角速度 ω、磁通 Φ、密度 ρ、波长 λ）', () => {
    for (const name of ['Omega', 'omega', 'Phi', 'rho', 'lambda', 'mu', 'theta', 'Delta']) {
      assert(GREEK[name], `缺 ${name}`);
    }
  });

  it('空输入与空白输入不崩', () => {
    assertEquals(applyShortcut(''), null);
    assertEquals(applyShortcut(null), null);
    assertEquals(applyShortcut(undefined), null);
  });
});
