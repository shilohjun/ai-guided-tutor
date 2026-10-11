/**
 * 理科符号输入辅助。
 *
 * ============================================================================
 * 它解决什么
 * ============================================================================
 * 学生反馈："一些物理的表达式很难写上去。"
 *
 * 这是实情：`²` `₀` `μ` `Ω` `√` `≈` 这些字符在普通键盘上打不出来，
 * 要么装专门输入法，要么从别处复制。而学生要在对话里写公式 ——
 * 写不出来，他就只能用文字绕，思路的表达精度直接下降。
 *
 * 两层机制：
 *   ① **符号面板**（点击插入）—— 零学习成本，看得见就能用
 *   ② **自动替换**（打字即得）—— `v^2` → `v²`、`mu` → `μ`、`>=` → `≥`
 *
 * ============================================================================
 * 自动替换只认"显式约定"，不猜
 * ============================================================================
 * 这一条是刻意的，因为猜错比不替换更烦人：
 *
 *   ✅ 替换 `^2` → `²`     —— `^` 本来就是"幂"的显式写法，无歧义
 *   ✅ 替换 `_0` → `₀`     —— `_` 是显式的下标写法
 *   ✅ 替换 `sqrt` → `√`   —— 整词
 *   ✅ 替换 `>=` → `≥`     —— 两个字符的组合键，不可能是别的东西
 *   ❌ 替换 `v0` → `v₀`    —— **不做**。看起来很方便，但 `sin53` 会变成 `sin₅₃`，
 *                             `m1m2` 这类写法也说不清。省下的两个键不值这个风险。
 *
 * 换句话说：**能用"约定"判断的才替换，需要"猜"的一律交给面板。**
 *
 * ============================================================================
 * 为什么单独成一个模块
 * ============================================================================
 * 这段逻辑是一堆容易写错的字符串规则（边界、大小写、多字符运算符），
 * 放在 app.js 里就没法单测（app.js 一 import 就要摸 DOM）。
 * 拆成纯函数之后，`test/mathinput.test.js` 可以直接拿各种奇怪输入去砸它。
 * 浏览器和 Node 都能 import 同一个文件，规则不会漂移成两份。
 */

/** 上标映射 */
export const SUPERSCRIPTS = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
  '-': '⁻', '+': '⁺',
};

/** 下标映射 */
export const SUBSCRIPTS = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
  '-': '₋', '+': '₊',
};

/**
 * 希腊字母表。
 *
 * 大小写敏感是刻意的：`Omega` → `Ω`、`omega` → `ω` 是两个不同的量
 * （电阻与角速度），不能混。所以这里按"输入即所得"列出，不做大小写折叠。
 */
export const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ',
  epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', Theta: 'Θ',
  kappa: 'κ', lambda: 'λ', Lambda: 'Λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', pi: 'π', Pi: 'Π', rho: 'ρ', sigma: 'σ', Sigma: 'Σ',
  tau: 'τ', phi: 'φ', Phi: 'Φ', psi: 'ψ', omega: 'ω', Omega: 'Ω',
  ohm: 'Ω',
};

/** 多字符运算符（键入手势 → 符号） */
export const OPERATORS = [
  ['>=', '≥'],
  ['<=', '≤'],
  ['!=', '≠'],
  ['~=', '≈'],
  ['->', '→'],
  ['=>', '⇒'],
];

let ruleCache = null;

/** 把一串 ASCII 数字/符号转成上标 */
export function toSuperscript(digits) {
  return [...String(digits)].map((c) => SUPERSCRIPTS[c] ?? c).join('');
}

/** 把一串 ASCII 数字/符号转成下标 */
export function toSubscript(digits) {
  return [...String(digits)].map((c) => SUBSCRIPTS[c] ?? c).join('');
}

/**
 * 规则表。每条规则只负责**匹配"刚打完的那个片段"**，
 * 匹配锚定在字符串末尾 —— 因为调用方传进来的就是"光标之前的文本"。
 *
 * ============================================================================
 * 为什么希腊字母要"等一个边界"，上下标不用
 * ============================================================================
 * 自动替换是**逐字触发**的：每敲一个字符都会跑一遍。
 * 于是有个绕不开的问题 —— 敲到 `pi` 的瞬间，输入框不知道你接下来要打什么：
 *
 *   `pi`   → 想打 π            ⇒ 该替换
 *   `pilot` → 想打英文单词      ⇒ 到了 `pi` 那一瞬间看起来一模一样
 *
 * 上下标没有这个问题：`^` 和 `_` 本身就是"我要打幂/下标"的显式声明，
 * 见到就可以换。
 *
 * 所以希腊字母（和 `sqrt`）采用**延迟替换**：等后面出现一个非字母字符
 * （空格、标点、数字、中文都算）才动手。
 *   `pi` + 空格 → `π `      `pilot` → 打到 `l` 时规则就不成立了
 * 另外在失焦与提交前做一次 flush，把"行尾就是这个符号名"的情况收掉。
 *
 * 数字紧跟其后时顺带转成下标：`theta2` → `θ₂`（这是学生最可能的意图）。
 * 而 `sin53` 不受影响 —— `sin` 不是希腊字母名。
 */
function rules() {
  if (ruleCache) return ruleCache;
  const greekNames = Object.keys(GREEK)
    // 长的先匹配：`phi` 必须先于 `pi` 尝试，否则 `phi` 会变成 "πh"
    .sort((a, b) => b.length - a.length)
    .join('|');
  ruleCache = [
    {
      id: 'superscript',
      re: /\^([+-]?\d{1,2})$/,
      build: (m) => ({ replacement: toSuperscript(m[1]) }),
    },
    {
      id: 'superscript-n',
      re: /\^n$/,
      build: () => ({ replacement: 'ⁿ' }),
    },
    {
      id: 'subscript',
      re: /_([+-]?\d{1,2})$/,
      build: (m) => ({ replacement: toSubscript(m[1]) }),
    },
    {
      id: 'greek-digit',
      re: new RegExp(`\\b(${greekNames})(\\d)$`),
      build: (m) => ({ replacement: GREEK[m[1]] + toSubscript(m[2]) }),
    },
    {
      id: 'greek-boundary',
      re: new RegExp(`\\b(${greekNames})([^A-Za-z0-9])$`),
      build: (m) => ({ replacement: GREEK[m[1]] + m[2] }),
    },
    {
      id: 'greek-flush',
      re: new RegExp(`\\b(${greekNames})$`),
      flushOnly: true,
      build: (m) => ({ replacement: GREEK[m[1]] }),
    },
    {
      id: 'sqrt-boundary',
      // 数字算边界：`sqrt2` → `√2`
      re: /\bsqrt([^A-Za-z])$/i,
      build: (m) => ({ replacement: `√${m[1]}` }),
    },
    {
      id: 'sqrt-flush',
      re: /\bsqrt$/i,
      flushOnly: true,
      build: () => ({ replacement: '√' }),
    },
    {
      /**
       * 多字符运算符。必须排在最后：`~=` 与 `=>` 都由普通字符组成，
       * 先让更具体的规则（上下标、希腊字母）有机会命中。
       */
      id: 'operator',
      re: new RegExp(`(${OPERATORS.map(([k]) => escapeRe(k)).join('|')})$`),
      build: (m) => ({ replacement: OPERATORS.find(([k]) => k === m[1])[1] }),
    },
  ];
  return ruleCache;
}

/**
 * 判断"刚打完的这段文本"要不要替换。
 *
 * @param {string} before 光标之前的全部文本
 * @param {{ flush?: boolean }} [opts] flush=true 表示"一句话说完了"
 *        （失焦、点发送），此时允许把行尾的符号名也收掉
 * @returns {{ start:number, end:number, replacement:string, rule:string } | null}
 *          start/end 是**相对于 before 的区间**，调用方据此做定点替换
 *          （不要重写整个输入框 —— 那会把光标顶到末尾）
 */
export function applyShortcut(before, { flush = false } = {}) {
  const text = String(before ?? '');
  if (!text) return null;

  for (const rule of rules()) {
    if (rule.flushOnly && !flush) continue;
    const m = text.match(rule.re);
    if (!m) continue;
    const { replacement } = rule.build(m);
    if (!replacement || replacement === m[0]) continue;
    return {
      start: text.length - m[0].length,
      end: text.length,
      replacement,
      rule: rule.id,
    };
  }
  return null;
}

/** 把一条替换结果应用到完整文本上（浏览器里只需要替换"光标之前"那一段，这里是给测试与 flush 用的整串版本） */
export function applyShortcutToText(text, opts) {
  const hit = applyShortcut(text, opts);
  if (!hit) return text;
  return text.slice(0, hit.start) + hit.replacement + text.slice(hit.end);
}

/**
 * 面板按钮 → 插入内容。分组顺序按"学生实际用到的频率"排，
 * 而不是按符号表顺序 —— 上标与下标用得最多（单位里到处是 m/s²、v₀）。
 */
export const PALETTE = [
  { group: '上标', items: ['²', '³', '⁻¹', '⁻²', '⁻³', '⁴', 'ⁿ'] },
  { group: '下标', items: ['₀', '₁', '₂', '₃', '₄', 'ₙ'] },
  { group: '希腊', items: ['μ', 'θ', 'Ω', 'Δ', 'Φ', 'ρ', 'λ', 'ω', 'α', 'β', 'π', 'ε', 'Σ'] },
  { group: '运算', items: ['√', '≈', '≤', '≥', '≠', '±', '×', '÷', '·', '∞', '∝'] },
  { group: '其它', items: ['°', '′', '→', '⇀', '½', '⅓', '¼', '∫', '∑', 'Δ', '∴', '∵'] },
];

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
