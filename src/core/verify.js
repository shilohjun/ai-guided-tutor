/**
 * 答案判定（completion / verification）。
 *
 * ============================================================================
 * 它补的是哪个洞
 * ============================================================================
 * 原来的引擎有一个刻意的设计：**学生给出候选答案时，不判对错**
 * （见 engine.js 的 classifyRequest.askVerify 分支）。
 * 理由是"判对错"很容易变成对学生的评价，而这个产品的立场是先肯定、再指卡点。
 *
 * 但那个设计有一个真实的副作用，是试用时被指出来的：
 *
 *   > 我直接把正确答案说出来了，它还在引导我。
 *
 * 这不对。学生自己走通了一步，最该发生的动作是**确认**：
 *   "对，这一问就是这个值。剩下 I、F、P 你继续。"
 * 然后再谈引导 —— 学生已经做对的部分不需要再被追问。
 *
 * ============================================================================
 * 三条设计红线
 * ============================================================================
 * ① **只确认对的，绝不指出错的。**
 *    说对了 ⇒ 确认；说错了 ⇒ 什么也不说，走原来的引导路径。
 *    这个不对称是刻意的：这个产品不做判卷，只做"陪你想"。
 *
 * ② **确认文本里不许出现学生没说过的数值。**
 *    这是比守卫更强的约束。守卫拦的是"AI 主动给答案"；
 *    而确认场景下学生会疑惑"它是不是把答案告诉我了"——
 *    所以这里的判据是"引擎能不能引入一个学生原话里没有的数"，
 *    答案必须是不能。由 test/verify.test.js 逐 token 断言。
 *
 * ③ **不假装算得准。**
 *    判定基于"答案指纹 + 参考答案里的数值"，对多解题、纯文字答案、
 *    以及"学生用另一种写法表达同一个结果"都可能漏判。
 *    漏判的后果是"继续引导"（可接受），误判的后果是"错误地宣布做对了"（不可接受）。
 *    所以宁可漏判：数值必须同时匹配**值与单位**，且要求**所有待求量都齐了**才宣布完成。
 */

import { canonicalize, stripEnumerators } from './text.js';
import { extractValueUnits, fingerprintMatches, unitAlternatives } from './guard.js';

/**
 * 这道题的"标准答案集合"——按**待求量**逐个挂上它对应的答案值。
 *
 * ============================================================================
 * 为什么不能直接"把参考答案里所有数值都当答案"
 * ============================================================================
 * 实测踩到的假阳性：自由落体题的参考答案是
 *   "由 h=½gt² 得总时间 t = 2 s，故 v = gt = 20 m/s；落地前 1 s 内下落高度 Δh = 15 m。"
 * 朴素的抽取会把 `2 s`（总时间）也当成答案 ——
 * 于是学生只要提到"总时间 2 秒"就会被判定成"答对了"，弹出庆祝界面。
 * **假庆祝比不庆祝更伤**：学生立刻知道这个系统在瞎说。
 *
 * ============================================================================
 * 解法：先把参考答案切成分句，再把每个分句挂到它提到的待求量上
 * ============================================================================
 *   "故 v = gt = 20 m/s"        → 提到 v → 属于待求量「落地速度 v」    ⇒ 20 m/s 是答案
 *   "由 h=½gt² 得总时间 t = 2 s" → 没提到任何待求量                    ⇒ 2 s 是中间量，丢弃
 *
 * 这个映射是机械的（符号匹配 + 中文三元组匹配），但它是**可审计**的：
 * 教研看一眼就知道某个值为什么被算成答案、或为什么没算。
 *
 * 映射不出来时宁可**不算答案**（漏判的后果是"继续引导"，可接受；
 * 误判的后果是"错误地宣布做对了"，不可接受）。
 *
 * @returns {{ items: {label:string, values:{value:string,unit:string,raw:string}[]}[], values: {...}[] }}
 */
export function expectedAnswers(problem) {
  const asked = (problem.asked ?? []).filter(Boolean);
  const reference = String(problem.referenceAnswer ?? '');
  /**
   * 分句要连**中文逗号**一起切。
   *
   * 实测踩到：参考答案常写成
   *   "由 h=½gt² 得总时间 t = 2 s，故 v = gt = 20 m/s"
   * 只按 `；` 切的话，`t = 2 s`（中间量）和 `v = 20 m/s`（真答案）落在同一个分句里，
   * 而这个分句的等号左边是 `h`，谁都匹配不上 ——
   * 结果真答案 20 m/s 被整句丢掉，学生答对了也等不到确认。
   * 按 `，` 切开之后，"故 v = gt = 20 m/s" 左边就是 `v`，归属正确。
   */
  const clauses = reference.split(/[；;。\n，,]/).map((s) => s.trim()).filter(Boolean);

  /**
   * "题干已经给了"的判定必须**带上单位**，不能只比数值。
   *
   * 实测踩到：phy-emi-01 的已知量里有 `B = 0.4 T`，
   * 而它的两个答案是 `E = 0.4 V` 与 `P = 0.4 W` —— 数值都是 0.4。
   * 如果按数值排除，这两个真正的答案会被当成"题干已给"而被丢掉，
   * 结果是学生答对了也永远等不到确认。
   *
   * 另外，这里的宽松方向与守卫相反，是刻意的：
   *   守卫（checkAnswerLeak）宁可宽松 —— 引用题干不该被拦，所以只比数值；
   *   判定器宁可严格 —— 错误地宣布"做对了"比漏判更伤，所以必须同值同单位。
   */
  const knownPairs = new Set();
  for (const src of [problem.stem ?? '', ...(problem.givens ?? []), ...asked]) {
    for (const pair of extractValueUnits(src)) {
      knownPairs.add(`${String(Number(pair.value))}|${pair.unit.toLowerCase()}`);
    }
  }

  const items = asked.map((label) => {
    const matcher = askedMatcher(label);
    const own = clauses.filter((c) => clauseMentions(c, matcher));
    const values = [];
    const seen = new Set();
    for (const c of own) {
      for (const pair of extractValueUnits(c)) {
        const value = String(Number(pair.value));
        if (knownPairs.has(`${value}|${pair.unit.toLowerCase()}`)) continue; // 题干给的（同值同单位）不是答案
        const key = `${value}|${pair.unit}`;
        if (seen.has(key)) continue;
        seen.add(key);
        values.push({ value, unit: pair.unit, raw: `${pair.value} ${pair.unit}` });
      }
    }
    return { label, values };
  });

  // 扁平化去重（同一个值可能同时是两问的答案，例如 E 与 P 都是 0.4）
  const values = [];
  const seen = new Set();
  for (const it of items) {
    for (const v of it.values) {
      const key = `${v.value}|${v.unit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      values.push(v);
    }
  }

  return { items, values, clauses };
}

/** 把一条待求量变成匹配器：优先用尾部符号（E / I / Δh），否则用中文三元组 */
function askedMatcher(label) {
  const sym = (label.match(/([A-Za-zα-ωΑ-ΩΔ][A-Za-z0-9_]{0,3})\s*$/) ?? [])[1] ?? null;
  const chinese = label.replace(/[（(].*?[)）]/g, '').replace(/[A-Za-z0-9\s=＝/²³.]+/g, '');
  const grams = [];
  for (let i = 0; i + 3 <= chinese.length; i += 1) grams.push(chinese.slice(i, i + 3));
  return { sym, grams };
}

/**
 * 一个分句在说哪个待求量。
 *
 * **只在等号左边找符号**，这一点很关键。
 * 实测：参考答案里 `I = E/(R+r) = 1 A` 这个分句，
 * 若在整个分句里找符号 `E`，会因为右边的 `E/(R+r)` 命中，
 * 于是把 `1 A` 也算成"感应电动势 E 的答案" —— 一个值挂到了两问上。
 * 取等号左边之后，这个分句只属于 `I`。
 */
function clauseMentions(clause, matcher) {
  const eq = clause.search(/[=＝]/);
  const lhs = eq > 0 ? clause.slice(0, eq) : clause;
  if (matcher.sym) {
    const re = new RegExp(`(?<![A-Za-z])${escapeRe(matcher.sym)}(?![A-Za-z0-9])`);
    if (re.test(lhs)) return true;
  }
  /**
   * 中文匹配同样**只看等号左边**。
   * 允许在全句里找的话，"落地前 1 s 内下落高度"这类描述会误命中别的分句，
   * 把不属于它的值挂过来 —— 而误挂的后果是"错误地宣布答对了"。
   */
  return matcher.grams.some((g) => lhs.includes(g));
}

/**
 * 判定学生这一轮说了什么。
 *
 * @param {import('./types.js').Problem} problem
 * @param {string} utterance
 * @returns {{
 *   numeric: boolean,
 *   expectedCount: number,
 *   matched: {value:string, unit:string, raw:string, quote:string}[],
 *   remaining: {value:string, unit:string, raw:string}[],
 *   conclusions: string[],
 *   complete: boolean,
 * }}
 */
export function verifyAnswer(problem, utterance) {
  const text = canonicalize(utterance);

  // ---- ① 数值型答案：按待求量逐项判定 ----
  const { items, values: expected } = expectedAnswers(problem);
  const matched = [];
  const answeredItems = new Set();

  for (const e of expected) {
    const re = new RegExp(`${escapeRe(e.value)}\\s*(?:${unitAlternatives(e.unit)})`, 'i');
    const m = text.match(re);
    if (!m) continue;
    matched.push({ ...e, quote: quoteAround(utterance, m[0]) });
    for (const it of items) {
      if (it.values.some((v) => v.value === e.value && v.unit === e.unit)) answeredItems.add(it.label);
    }
  }
  const matchedKeys = new Set(matched.map((m) => `${m.value}|${m.unit}`));
  const remaining = expected.filter((e) => !matchedKeys.has(`${e.value}|${e.unit}`));

  // ---- ② 结论型答案（证明题这类没有数值的题）----
  const conclusions = [];
  for (const fp of problem.answerFingerprints ?? []) {
    if (fingerprintMatches(fp, text)) conclusions.push(fp);
  }

  /**
   * 完成判定 —— 这里必须诚实，因为它的后果是弹出一个庆祝界面。
   *
   *   数值型题目：**每一问都有答案了**才算完成。
   *              这道题有四问，学生只答对一问，那不是"做完了"，
   *              那是"做对了四分之一" —— 给假庆祝比不庆祝更伤。
   *              判定按**待求量覆盖**而不是"数值个数"，所以中间量（如总时间）
   *              即使被说出来也不会推进完成度（见 expectedAnswers 的说明）。
   *   结论型题目：命中一条结论指纹即可。
   */
  const numeric = items.some((it) => it.values.length > 0);
  const answeredCount = numeric ? answeredItems.size : 0;
  const askedCount = items.length;
  const complete = numeric ? askedCount > 0 && answeredCount >= askedCount : conclusions.length > 0;

  return {
    numeric,
    expectedCount: numeric ? askedCount : (problem.answerFingerprints ?? []).length,
    answeredCount,
    matched,
    remaining,
    conclusions,
    complete,
  };
}

/**
 * 划出该数值在原话里的那一小段，用作"你自己说的"回显。
 *
 * 为什么要回显学生原话而不是由引擎拼一个数值：
 *   这是红线 ② 的落地方式 —— 界面上出现的数字全部来自学生本人，
 *   引擎只是"把他说的那一句拿过来放大"。
 */
function quoteAround(utterance, needle) {
  const text = String(utterance ?? '');
  const i = text.indexOf(needle);
  if (i < 0) {
    // canonicalize 过的串可能和原文对不上（全角/空格），退化成整句截断
    return text.trim().slice(0, 40);
  }
  const start = Math.max(0, i - 8);
  const end = Math.min(text.length, i + needle.length + 8);
  const head = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return `${head}${text.slice(start, end).trim()}${tail}`;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 检查一段文本里有没有出现**学生还没说出来的答案**。
 *
 * 这是确认路径的红线 ② 的执行器，也是它比守卫更强的地方：
 *   守卫拦的是"AI 主动给答案"（任何人都不许说）；
 *   而确认场景下学生会怀疑"它是不是把答案告诉我了" ——
 *   所以判据必须更紧：**引擎能不能引入一个学生原话里没有的数？**
 *   答案必须是不能。
 *
 * 只查 `remaining`（学生还没说的），已经说出来的当然可以回显。
 *
 * 关于"裸数字"的取舍：
 *   小于 10 的整数不单独查 —— 否则"还剩 2 个待求量"这种句子会被误判成泄漏。
 *   带小数点的、或者 ≥10 的值则连裸数字一起查（0.4 / 20 / 15 这类不可能是计数）。
 *
 * @returns {string[]} 命中的答案描述（空数组 = 干净）
 */
export function findUnstatedAnswers(text, problem, verdict) {
  const t = canonicalize(text);
  const hits = [];
  for (const r of verdict?.remaining ?? []) {
    const withUnit = new RegExp(`${escapeRe(r.value)}\\s*(?:${unitAlternatives(r.unit)})`, 'i');
    if (withUnit.test(t)) {
      hits.push(`${r.raw}（带了单位）`);
      continue;
    }
    const n = Number(r.value);
    if ((Math.abs(n) >= 10 || r.value.includes('.')) && new RegExp(`(?<![\\d.])${escapeRe(r.value)}(?![\\d])`).test(t)) {
      hits.push(`${r.value}（裸数值）`);
    }
  }
  return hits;
}
