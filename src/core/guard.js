/**
 * 防泄题守卫（Guard）—— 本 PoC 最核心的可靠性资产。
 *
 * 设计立场：
 *   "不给答案"不能靠 Prompt 里写一句"请不要给答案"来保证。
 *   模型会用 100 种方式绕过：换个说法、给近似值、给公式让学生自动算出、
 *   或者干脆把中间步骤全列出来让学生抄。
 *   因此这里做成**确定性检查器**：提示文本必须在出口通过 5 类检查。
 *
 * 5 类检查（对应 types.js 的 GuardViolation）：
 *   1. answer_in_text   命中数值答案（含中文数字说法，如"一库仑"）
 *   2. formula_leak     给出解法性公式的完整表达式
 *   3. level_overflow   内容超出声明层级（L1 出现公式、L2 出现数值结果…）
 *   4. solution_dump    一口气列出过多步骤（>2 个编号/箭头结构）
 *   5. final_conclusion 收口句式（"所以答案是""最终结果为""因此可得…"）
 *
 * 拦截后的处理不是简单丢弃，而是**降级重写**：
 *   guard 会把命中的违规反推成"必须回避的内容"，交回 generate 重试一次；
 *   若两次都失败，就用"安全兜底模板"直接产出（保证永不泄题优先于文采）。
 */

import { canonicalize, chineseNumeralToArabic, clip, normalize, safeRegex } from './text.js';

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------

/** 收口句式：一旦出现，说明 AI 在替学生收尾 */
const CONCLUSION_PATTERNS = [
  /所以(?:答案|结果|正确)?(?:就)?是/,
  /最终(?:答案|结果|结)\s*(?:为|是|就)/,
  /因此(?:可得|得到|可以得出|答案)/,
  /答案\s*(?:是|为|就是)/,
  /结论\s*(?:是|为)/,
  /正确结果\s*(?:是|为)/,
  /(?:就)?算出(?:来)?(?:了)?\s*(?:是|为)/,
  /结果(?:是|为)\s*[0-9]/,
];

/** 通用"完整表达式"探测：等号两侧都有字母/符号，像一条公式 */
const EQUATION_PATTERN = /[A-Za-z_ΔΦΒ][A-Za-z0-9_ΔΦΒ²^·×*/().\s]{0,20}[=＝][^=＝\n]{2,40}/;

/**
 * 步骤清单探测：编号列表、箭头链。
 *
 * 三个坑都在这一行里：
 *   ① normalize() 会把"、"变成","，所以分隔符里两个都要有；
 *   ② normalize() 会把换行压成空格，所以不能只靠 ^ 或 \n 做锚点，
 *      必须允许"空格/逗号/分号"作为编号前导（否则 `1、A 2、B 3、C` 一个都抓不到）；
 *   ③ 前导分隔符要收窄到标点与空白，否则正文里的数字（"给了 3 个条件"）会误伤。
 */
const STEP_LIST_PATTERN = /(?:^|[\s;,.，；])(?:[1-9①②③④⑤]|第[一二三四五]步)\s*[、.．,，)）)]\s*\S/;
const STEP_LIST_PATTERN_G = new RegExp(STEP_LIST_PATTERN.source, 'gm');
const ARROW_CHAIN_PATTERN = /→|->|⇒|=>/;

/** 各层级允许/禁止的内容边界 */
const LEVEL_RULES = {
  0: {
    name: '结构化澄清',
    forbidEquation: true,
    forbidFormula: true,
    forbidAnswerNumber: true,
    allowNumericLiteral: true, // 允许"把已知的三个量说出来"
  },
  1: {
    name: '条件追问',
    forbidEquation: true, // L1 只提问，不出现公式
    forbidFormula: true,
    forbidAnswerNumber: true,
    allowNumericLiteral: true, // 允许引用题干已给的数（如"0.4 T 这个条件"）—— 见下方白名单
  },
  2: {
    name: '方向提示',
    forbidEquation: true, // L2 指方向，不给关系式
    forbidFormula: true,
    forbidAnswerNumber: true,
    allowNumericLiteral: true,
  },
  3: {
    name: '降级示范',
    forbidEquation: false, // L3 允许写"半边"或符号形式
    forbidFormula: true, // 但仍不许给完整解法表达式
    forbidAnswerNumber: true,
    allowNumericLiteral: true,
  },
};

// ---------------------------------------------------------------------------
// 单条检查
// ---------------------------------------------------------------------------

/**
 * 检查 1：数值答案泄漏。
 * 双通道：
 *   a) 命中题库的 answerFingerprints（教研手工维护，精度高）
 *   b) 从 referenceAnswer 里抽出所有"数值+单位"组合做兜底（召回高）
 * 通道 b 的存在是为了防"教研漏写指纹"这类人为疏漏。
 */
export function checkAnswerLeak(text, problem) {
  const violations = [];
  const t = chineseNumeralToArabic(normalize(text));

  for (const fp of problem.answerFingerprints ?? []) {
    const m = t.match(safeRegex(fp, 'i'));
    if (m) {
      violations.push({
        kind: 'answer_in_text',
        detail: `命中答案指纹 /${fp}/`,
        match: clip(m[0], 40),
      });
    }
  }

  // 通道 b：从参考答案里抽数值-单位对
  for (const pair of extractValueUnits(problem.referenceAnswer)) {
    const { value, unit } = pair;
    // 只对"有单位的数值"做兜底，避免把题干的已知量也当成答案
    if (isGivenValue(problem, value)) continue;
    const re = new RegExp(`${escapeRe(value)}\\s*(?:${unitAlternatives(unit)})`, 'i');
    const m = t.match(re);
    if (m) {
      violations.push({
        kind: 'answer_in_text',
        detail: `参考答案数值泄漏：${value} ${unit}`,
        match: clip(m[0], 40),
      });
    }
  }

  return violations;
}

/** 检查 2：解法性公式泄漏 */
export function checkFormulaLeak(text, problem, level) {
  const rule = LEVEL_RULES[level];
  const violations = [];
  if (!rule.forbidFormula) return violations;

  const t = canonicalize(text);
  for (const fp of problem.formulaFingerprints ?? []) {
    const m = t.match(safeRegex(fp, 'i'));
    if (m) {
      violations.push({ kind: 'formula_leak', detail: `命中解法公式指纹 /${fp}/`, match: clip(m[0], 40) });
    }
  }
  return violations;
}

/**
 * 检查 7：解法要点泄漏（"说出答案"的第三种形态）。
 *
 * 与 formula_leak 的区别：
 *   公式泄漏  = 给出表达式（"用 E = BLv"）
 *   要点泄漏  = 给出"这个量扮演什么角色"（"导体棒是电源，r 是内阻"）
 *
 * 为什么必须单独一条 —— 实测事故（真模型 glm-4-plus）：
 *   L1 层回复"电阻 R 和导体棒自身的电阻 r 组成了外电路和内阻"。
 *   这句话没有公式、没有数值，形式上完全合规，
 *   但学生漏的正是"导体棒有内阻" —— 等于把答案递过去了。
 *
 * 只在 L0–L2 生效：L3 是"降级示范"，允许说到这个颗粒度
 * （但仍然不许给数值和完整表达式，那由检查 1、2 负责）。
 *
 * 判据是"指派"而不是"提及"：
 *   ✅ 允许："谁是提供电动势的那一部分？它自身有没有电阻？"（在问，没答）
 *   ❌ 拦截："导体棒是电源，r 是内阻"（在答）
 */
export function checkSolutionInsight(text, problem, level) {
  if (level >= 3) return [];
  const insights = problem.solutionInsights ?? [];
  if (insights.length === 0) return [];

  const t = canonicalize(text);
  const violations = [];
  for (const fp of insights) {
    const m = t.match(safeRegex(fp, 'i'));
    if (m) {
      violations.push({
        kind: 'solution_insight',
        detail: `提示直接说出了本题的核心结论（L${level} 不允许）`,
        match: clip(m[0], 40),
      });
    }
  }
  return violations;
}

/** 检查 3：层级越界（L0~L2 不得出现公式形态） */
export function checkLevelOverflow(text, problem, level) {
  const rule = LEVEL_RULES[level];
  const violations = [];
  if (!rule.forbidEquation) return violations;

  const t = normalize(text);
  const m = t.match(EQUATION_PATTERN);
  if (m) {
    // 排除"常识性写法"：仅在指代数值/比例时不算公式（如 "v = 2 m/s" 属于引用题干）
    const snippet = m[0];
    if (!isBenignEquality(snippet, problem)) {
      violations.push({
        kind: 'level_overflow',
        detail: `L${level}(${rule.name}) 不应出现公式形态`,
        match: clip(snippet, 60),
      });
    }
  }
  return violations;
}

/** 检查 4：完整步骤倾倒 */
export function checkSolutionDump(text) {
  const violations = [];
  const t = normalize(text);

  const stepMarks = t.match(STEP_LIST_PATTERN_G) ?? [];
  const arrows = t.match(new RegExp(ARROW_CHAIN_PATTERN.source, 'g')) ?? [];

  if (stepMarks.length > 2) {
    violations.push({
      kind: 'solution_dump',
      detail: `出现 ${stepMarks.length} 个编号步骤，超过 2 个即视为倾倒解法`,
      match: stepMarks.slice(0, 3).join(' | '),
    });
  }
  if (arrows.length > 2) {
    violations.push({
      kind: 'solution_dump',
      detail: `出现 ${arrows.length} 个推导箭头，疑似给出完整推导链`,
      match: '→链',
    });
  }
  return violations;
}

/** 检查 5：收口句式 */
export function checkConclusion(text) {
  const violations = [];
  const t = normalize(text);
  for (const re of CONCLUSION_PATTERNS) {
    const m = t.match(re);
    if (m) {
      violations.push({ kind: 'final_conclusion', detail: '出现替学生收尾的结论句式', match: clip(m[0], 30) });
    }
  }
  return violations;
}

/**
 * 检查 6：概念域越界（"跑题"）。
 *
 * 走过的弯路（写下来避免后人重踩）：
 *   ① 先试"单字白名单" —— 中文虚词太多，守卫自己的兜底模板都被判跑题；
 *   ② 再试"二元字组白名单" —— 由模板用语构成的白名单永远补不全，
 *      因为"先别""你先""看看"这类组合是无穷的。
 *   ③ 最终方案：**封闭词表**。只维护一张"中学物理常见概念"词表，
 *      当提示提到一个**本题领域里不存在**的词表词条时才拦。
 *      精确、可审计、零误伤教学用语。
 *
 * 这条规则抓的是最伤产品可信度的错误：
 *   对着"漏内阻"的电路题聊"动量定理" —— 学生会立刻发现 AI 没看懂题。
 */
const PHYSICS_CONCEPTS = [
  // 力学
  '动量定理', '动量守恒', '动量', '冲量', '牛顿第二定律', '牛顿第一定律', '牛顿第三定律',
  '动能定理', '机械能守恒', '能量守恒', '摩擦力', '向心力', '圆周运动', '平抛', '斜抛',
  '自由落体', '简谐振动', '万有引力', '胡克定律', '弹力', '惯性',
  // 电磁学
  '法拉第', '楞次', '安培力', '安培定则', '左手定则', '右手定则', '洛伦兹力',
  '电场强度', '电势差', '电势', '电容', '电容器', '电感', '自感', '涡流',
  '欧姆定律', '焦耳定律', '电功率', '串并联', '基尔霍夫', '磁通量', '磁感应强度',
  '感应电动势', '涡旋电场', '交变电流', '变压器', '带电粒子',
  // 热学 / 光学 / 近代
  '理想气体', '热力学第一定律', '内能', '折射', '全反射', '干涉', '衍射', '光电效应', '波粒二象性',
  // 通用工具
  '受力分析', '受力平衡', '动能', '势能', '功率', '功',
];

export function checkConceptDomain(text, problem) {
  const domainText = buildDomainText(problem);
  const t = normalize(text);

  const offending = PHYSICS_CONCEPTS.filter((term) => {
    if (!t.includes(term)) return false;
    // 该概念如果在本题目自身文本里出现过，就属于本题领域 ⇒ 放行
    return !domainText.includes(term);
  });

  if (offending.length === 0) return [];

  return [
    {
      kind: 'concept_out_of_domain',
      detail: `提示引用了本题不涉及的物理概念：${offending.join('、')}`,
      match: offending.join('、'),
    },
  ];
}

/**
 * 题目"领域文本"：把题目自身所有可读文本拼起来。
 * 用途是"这个物理概念本题有没有涉及"的判定基准 —— 刻意用整体文本包含判断，
 * 而不是分词，这样"电磁感应"能自然覆盖"感应电动势"这类子串关系。
 */
export function buildDomainText(problem) {
  if (!problem) return '';
  const parts = [
    problem.stem ?? '',
    (problem.asked ?? []).join(''),
    (problem.givens ?? []).join(''),
    problem.referenceAnswer ?? '',
  ];
  for (const g of problem.solutionGraphs ?? []) {
    parts.push(g.name ?? '', ...(g.preconditions ?? []));
    for (const s of g.steps ?? []) {
      parts.push(s.title ?? '', s.intent ?? '', ...(s.concepts ?? []), ...(s.cues ?? []));
      for (const fork of s.forks ?? []) parts.push(fork.desc ?? '');
    }
  }
  for (const m of problem.misconceptions ?? []) {
    parts.push(m.label ?? '', m.rootCause ?? '', ...(m.signature ?? []), ...(m.hintSeeds ?? []));
  }
  return parts.filter(Boolean).join(' ');
}

/** 保留旧名以兼容既有引用 */
export function buildConceptDomain(problem) {
  return buildDomainText(problem);
}

export { PHYSICS_CONCEPTS };

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * @param {string} text 待检文本
 * @param {import('./types.js').Problem} problem
 * @param {import('./types.js').HintLevel} level 声明层级
 * @param {{ conceptWhitelist?: string[] }} [opts]
 * @returns {import('./types.js').GuardResult}
 */
export function guard(text, problem, level, opts = {}) {
  const violations = [
    ...checkAnswerLeak(text, problem),
    ...checkFormulaLeak(text, problem, level),
    ...checkLevelOverflow(text, problem, level),
    ...checkSolutionDump(text),
    ...checkConclusion(text),
    ...checkConceptDomain(text, problem),
    ...checkSolutionInsight(text, problem, level),
  ];

  if (violations.length === 0) {
    return { passed: true, violations: [] };
  }

  const repaired = repairHint(text, problem, level, violations, opts);
  return {
    passed: false,
    violations,
    repairedText: repaired.text,
    repairStrategy: repaired.strategy,
  };
}

/**
 * 降级重写策略（按违规严重度排序，取最保守的一条）：
 *   answer_in_text / final_conclusion       → 整句替换为安全模板（最危险，不冒险改写）
 *   formula_leak / level_overflow           → 剥离公式片段，保留问句部分
 *   solution_dump                           → 截断到前两句
 *   concept_out_of_domain（跑题）           → 同样用安全模板。
 *     理由：跑题说明模型没理解题目，此时"局部删改"救不回来，只能整体换掉。
 */
export function repairHint(text, problem, level, violations, opts = {}) {
  const kinds = new Set(violations.map((v) => v.kind));

  if (
    kinds.has('answer_in_text') ||
    kinds.has('final_conclusion') ||
    kinds.has('concept_out_of_domain') ||
    kinds.has('solution_insight')
  ) {
    return { text: safeFallbackHint(problem, level, opts), strategy: 'safe-template' };
  }

  if (kinds.has('formula_leak') || kinds.has('level_overflow')) {
    const stripped = stripEquationFragments(text);
    // 剥离后重新校验，避免剥离不干净
    const recheck = [
      ...checkAnswerLeak(stripped, problem),
      ...checkFormulaLeak(stripped, problem, level),
      ...checkLevelOverflow(stripped, problem, level),
      ...checkSolutionDump(stripped),
      ...checkConclusion(stripped),
    ];
    if (recheck.length === 0 && stripped.trim().length >= 6) {
      return { text: stripped, strategy: 'strip-equation' };
    }
    return { text: safeFallbackHint(problem, level, opts), strategy: 'safe-template-after-strip' };
  }

  if (kinds.has('solution_dump')) {
    const truncated = truncateToTwoSentences(text);
    const recheck = [
      ...checkAnswerLeak(truncated, problem),
      ...checkFormulaLeak(truncated, problem, level),
      ...checkLevelOverflow(truncated, problem, level),
      ...checkSolutionDump(truncated),
      ...checkConclusion(truncated),
    ];
    if (recheck.length === 0 && truncated.trim().length >= 6) {
      return { text: truncated, strategy: 'truncate' };
    }
    return { text: safeFallbackHint(problem, level, opts), strategy: 'safe-template-after-truncate' };
  }

  return { text: safeFallbackHint(problem, level, opts), strategy: 'safe-template' };
}

/**
 * 安全兜底模板 —— 永不泄题的最后一道防线。
 * 只依赖层级与步骤的"动作类型"，不依赖任何题目数值。
 */
export function safeFallbackHint(problem, level, opts = {}) {
  const step = opts.step ?? null;
  const kind = step?.kind ?? 'identify';
  const concept = opts.conceptWhitelist?.[0] ?? step?.concepts?.[0] ?? '这一步';

  switch (level) {
    case 0:
      return '先别急着算。你能把"题目给了什么"和"要求什么"各说一遍吗？说完我们再决定往哪个方向想。';
    case 1:
      return `你提到的这个规律，它成立需要的前提条件，题目里的条件都满足了吗？先只检查前提，不用往下算。`;
    case 2:
      return `方向提示：这一步的关键是${concept}与运动状态之间的联系。先想清楚这个联系是怎么建立的，再考虑用什么式子。`;
    default:
      return `我示范一个动作：你先只把研究对象单独拎出来，按方向逐一列出它受到的各个力（只写方向和名字）。列完之后告诉我，哪一个力和运动状态有关。`;
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 从参考答案里提取 "数值 + 单位" 组合 */
export function extractValueUnits(referenceAnswer) {
  const text = normalize(referenceAnswer);
  const unitRe = /(-?\d+(?:\.\d+)?)\s*(V|A|N|W|J|C|m\/s|m\/s²|Ω|μF|T|m|kg|s|伏|安|牛|瓦|焦|库|米每秒|米|特斯拉|欧姆|法拉|千克|秒)/g;
  const out = [];
  let m;
  while ((m = unitRe.exec(text)) !== null) {
    out.push({ value: m[1], unit: m[2] });
  }
  return out;
}

/** 该数值是否是题干已给的已知量（是则不算泄漏） */
function isGivenValue(problem, value) {
  const target = Number(value);
  if (Number.isNaN(target)) return false;
  return problem.givens.some((g) => {
    const nums = normalize(g).match(/-?\d+(?:\.\d+)?/g) ?? [];
    return nums.some((n) => Math.abs(Number(n) - target) < 1e-9);
  });
}

/** 单位的中文/符号等价写法，用于构造宽松匹配 */
function unitAlternatives(unit) {
  const map = {
    V: 'V|伏|伏特',
    A: 'A|安|安培',
    N: 'N|牛|牛顿',
    W: 'W|瓦|瓦特',
    J: 'J|焦|焦耳',
    C: 'C|库|库仑',
    'm/s': 'm/s|米每秒|米/秒',
    'm/s²': 'm/s²|m/s\\^2|米每二次方秒',
    Ω: 'Ω|欧|欧姆',
    T: 'T|特|特斯拉',
    m: 'm|米',
    kg: 'kg|千克',
    s: 's|秒',
  };
  return map[unit] ?? escapeRe(unit);
}

/**
 * 判断一个等号片段是否"无害"（不算给公式）。
 *
 * 判定标准刻意收得很紧：**右侧必须是一个纯数值（可带单位）或问号/文字**。
 * 早期版本允许"右侧是已知量数值"就放行，结果 `I = E/(R+r)` 因为含数字而被放过 ——
 * 这正是"守卫有漏洞"的典型形态：宽松规则会同时放过善意引用和恶意给公式。
 * 现在的取舍是：宁可让模型重写一次，也不放过一条解法表达式。
 *
 * 允许：
 *   - "B = 0.4 T"      右侧纯数值 + 单位（引用题干）
 *   - "位移 x = ?"      右侧问号
 *   - "设电流为 I"      无等号
 * 禁止：
 *   - "I = E/(R+r)"   右侧含字母与运算符
 *   - "E = BLv"       右侧含字母
 */
function isBenignEquality(snippet, problem) {
  const s = normalize(snippet);
  const rhs = (s.split(/[=＝]/)[1] ?? '').trim();
  if (!rhs) return true;

  // 右侧是问号 / 文字开头 ⇒ 不是公式
  if (/^[?？]/.test(rhs)) return true;
  if (/^[\u4e00-\u9fa5]/.test(rhs)) return true;

  // 右侧必须是"数字 + 可选单位"，除此之外不能有其他符号或字母
  const numericWithUnit =
    /^-?\d+(?:\.\d+)?(?:\s*[×x]\s*10\s*\^?-?\d+)?\s*(?:[A-Za-zΩμ°/²³·]+)?$/;
  if (!numericWithUnit.test(rhs)) return false;

  // 即便是纯数值，也要确认它确实是题干给的已知量（防止 "F = 0.2 N" 这类答案赋值被放过）
  const nums = rhs.match(/-?\d+(?:\.\d+)?/g) ?? [];
  if (nums.length === 0) return true;
  return isGivenValue(problem, nums[0]);
}

/** 剥离公式片段：连公式所在的整个小句一起删掉，而不是原地留个占位符 */
function stripEquationFragments(text) {
  const sentences = normalize(text).split(/(?<=[。！？!?；;])/).filter((s) => s.trim());
  const kept = [];
  for (const s of sentences) {
    const eqMatches = s.match(new RegExp(EQUATION_PATTERN.source, 'g')) ?? [];
    if (eqMatches.length === 0) {
      kept.push(s);
      continue;
    }
    // 含公式的小句：优先只删"公式所在的那个分句"（按逗号切），保留同句的提问部分
    const clauses = s.split(/(?<=[，,])/);
    const keptClauses = clauses.filter((c) => new RegExp(EQUATION_PATTERN.source).test(c) === false);
    const rebuilt = keptClauses.join('').trim();
    // 只剩残句（太短或没有内容）就整句丢弃 —— 宁可少一句，也不要留下"你从（……）时添加一个重要条件?"这种碎句
    if (rebuilt.length >= 8 && /[\u4e00-\u9fa5]{4,}/.test(rebuilt)) {
      kept.push(rebuilt);
    }
  }
  return kept.join('').replace(/\s{2,}/g, ' ').trim();
}

function truncateToTwoSentences(text) {
  const t = normalize(text);
  const parts = t.split(/(?<=[。.!?！？])/).filter((x) => x.trim());
  const kept = parts.slice(0, 2).join('');
  // 顺带清掉编号与箭头
  return kept.replace(/(?:^|\n)\s*(?:[1-9①②③④⑤]|第[一二三四五]步)[、.）)]\s*/g, '').replace(/→|->|⇒|=>/g, '，').trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 供调试与文档使用 */
export const __internal = {
  LEVEL_RULES,
  CONCLUSION_PATTERNS,
  EQUATION_PATTERN,
  STEP_LIST_PATTERN,
  ARROW_CHAIN_PATTERN,
};
