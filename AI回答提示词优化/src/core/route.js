/**
 * 升级决策（Routing）—— 刻意做成确定性代码，而不是交给 LLM。
 *
 * 为什么这一层必须离开 LLM：
 *   如果让模型自己决定"该给几级提示"，实测会出现两个方向的失效：
 *   ① 学生一喊难就直接给到 L3（等于变相给答案，学生只学到"会要提示"）；
 *   ② 学生已经快想通了，模型还在机械升级，反而打断他。
 *   层级是教学策略问题，不是语言问题，所以它属于规则引擎。
 *
 * 本文件实现三部曲：
 *   1. decideLevel()   —— 层级决策（带迟滞、带前置要求）
 *   2. buildStrategy() —— 层级 + 卡点性质 → 具体策略名
 *   3. buildWhitelist()—— 允许引用的概念白名单 + 必须回避的内容（闭环喂给 guard）
 */

import { findStepByPosition, findGraph } from './locate.js';

// ---------------------------------------------------------------------------
// 层级决策
// ---------------------------------------------------------------------------

/**
 * 决策表（人可读版）：
 *
 * | 情境                                   | 层级 |
 * |----------------------------------------|------|
 * | 还没形成思路（not_started）             | L0   |
 * | 首次求助 / L1 从未给过                  | L1   |
 * | 已给过 L1，学生仍卡在同一步             | L2   |
 * | 已给过 L2，学生表示仍卡住 且 在学习状态 | L3   |
 * | 学生已接近完成（finished）              | 不给 |
 * | 学生算错但思路对（execution_error）     | L3（局部示范，性价比最高） |
 *
 * 两条硬性护栏：
 *   A. 禁止跳级：L3 要求历史里出现过 L2；L2 要求出现过 L1。最多一次只升一级。
 *   B. 禁止重复：同一层级在同一卡点上不重复给（换一种问法不等于升级）。
 */

/** 学生表示"还是不会"的语言信号（用于判断是否该升级） */
const STILL_STUCK_SIGNALS = [
  '还是不会',
  '还是不懂',
  '没懂',
  '不明白',
  '不理解',
  '再给一点',
  '再提示',
  '不会做',
  '想不出来',
  '还是卡',
  '继续提示',
  '下一步呢',
  '然后呢',
  '能不能再说',
  '多一点提示',
];

/** 学生表示"我再试试"的语言信号（用于抑制升级，给他空间） */
const TRYING_SIGNALS = ['我试试', '我想想', '让我想', '等等', '我先', '我明白了', '懂了', '知道了'];

export function decideLevel({ problem, diagnosis, history, explicitHelpSeeking, mode }) {
  const reasons = [];
  if (mode === 'self_training' && !explicitHelpSeeking) {
    return { level: null, reason: '自主训练：学生未主动求助，保持静默观测', suppressed: true };
  }
  const hasPriorContext = history.some(t => t.role === 'ai' && !t.suppressed && t.metaStep != null);
  // 仅当前路径、步骤、卡点的已交付提示支撑升级；兼容旧会话缺失的元数据。
  history = history.filter(t => t.role !== 'ai' || (
    !t.suppressed && t.form !== 'confirm' && t.form !== 'refusal' && t.form !== 'fallback' &&
    (t.metaStep == null || t.metaStep === diagnosis.position.stepIndex) &&
    (t.metaGraphId == null || t.metaGraphId === diagnosis.position.graphId) &&
    (t.metaStuckKind == null || t.metaStuckKind === diagnosis.stuckKind)
  ));

  if (diagnosis.stuckKind === 'finished') {
    return {
      level: null,
      reason: '学生已推进到路径末段且无错因，不应再给提示（AI 此处应沉默或只做确认）',
      suppressed: true,
    };
  }

  /**
   * 信息不足 ⇒ 只反问，不给提示。
   *
   * 优先级高于所有其它规则，因为它是"诚实"的问题：
   * 学生只说了"我不会"时，任何关于"你卡在第几步"的判断都是编的。
   * 编出来的定位比没有定位更糟 —— 学生会立刻觉得"这个 AI 在瞎说"。
   *
   * 但有一个必须同时满足的条件：**此前没有任何可用的定位**。
   * 否则会出现这种事：学生第一轮说了完整思路（定位到第 4 步），
   * 第二轮说"还是不会" —— 本轮信息确实不足，但语境完全够，
   * 此时应该继续按原定位升级提示，而不是把他当成"一句话都没说过"从头反问。
   * 这属于"追问继承"的场景，不是"信息不足"。
   */
  if (diagnosis.sufficientInfo === false && !hasPriorContext) {
    return {
      level: 0,
      reason: '学生未提供可诊断的思路内容且无历史语境 ⇒ 只做反问（probeQuestion），不做定位判断',
      suppressed: false,
      probeOnly: true,
    };
  }

  const lastUtterance = [...history].reverse().find((t) => t.role === 'student')?.text ?? '';

  // ---- 尚未形成思路：先澄清，不算提示 ----
  if (diagnosis.stuckKind === 'not_started') {
    return { level: 0, reason: '学生还没形成可诊断的思路，先用 L0 结构化澄清', suppressed: false };
  }

  // ---- 从历史推导已给过的层级 ----
  const aiLevels = history.filter((t) => t.role === 'ai' && t.level != null).map((t) => t.level);
  const maxGiven = aiLevels.length ? Math.max(...aiLevels) : null;

  // 同一卡点是否已给过该层级
  const givenOnSameStep = (lvl) => {
    const entry = history
      .filter((t) => t.role === 'ai' && t.level === lvl)
      .map((t) => t.metaStep);
    return entry.includes(diagnosis.position.stepIndex);
  };
  void givenOnSameStep;

  const stillStuck = STILL_STUCK_SIGNALS.some((s) => lastUtterance.includes(s));
  const trying = !explicitHelpSeeking && !/[？?]|不会|不懂|怎么|如何/.test(lastUtterance) && TRYING_SIGNALS.some((s) => lastUtterance.includes(s));

  // ---- 执行错误：同样从 L1 开始，用"邀请自查"而不是直接示范 ----
  //
  // 早期版本给"思路对但算错"开了一个特例：可直接给 L3 局部示范。
  // 用真模型跑评测后改掉了，两个理由：
  //   ① L3 是产品里最强的提示。学生对一道**从未被提示过**的题直接拿到最强提示，
  //      违背"先自己想"的产品主张；
  //   ② 算术类失误本来就该由学生自己发现（"检查一下分母"比"我示范一遍"更有效）。
  // "学生说自己算错了"是一条极容易被利用的捷径 —— 只要声称算错就能拿到示范。
  // 现在统一走 L1（self_check_invitation 策略），需要升级时再按常规递进。
  if (diagnosis.stuckKind === 'execution_error' && (explicitHelpSeeking || stillStuck)) {
    reasons.push('思路正确但执行出错：先给 L1 自查邀请，而不是直接示范（示范是最强提示，应留到后面）');
  }

  // ---- 常规递进：最多一级一级升 ----
  let next;
  if (maxGiven == null) {
    next = 1;
    reasons.push('首次给出提示，从 L1 条件追问开始');
  } else if (trying && !stillStuck) {
    // 学生在尝试，先不升级，把问题问得更聚焦一点（仍算 L1 变体）
    next = Math.min(maxGiven, Math.max(1, maxGiven));
    reasons.push('学生表示正在尝试，暂不升级，改为更聚焦的条件追问');
  } else if (stillStuck || explicitHelpSeeking) {
    next = Math.min(3, maxGiven + 1);
    reasons.push(`学生仍卡住${explicitHelpSeeking ? '（显式求助）' : ''}，从 L${maxGiven} 升到 L${next}`);
  } else {
    next = Math.min(3, Math.max(1, maxGiven));
    reasons.push('无明显升级信号，维持当前层级，避免过度帮助');
  }

  // ---- 硬性护栏 A：禁止跳级（按"连续前缀"判断，而不是只看前一级） ----
  const reachable = maxReachableLevel(aiLevels);
  const beforeGuard = next;
  if (next > reachable + 1) {
    next = Math.max(1, reachable + 1);
    reasons.push(
      `护栏A：历史层级 [${aiLevels.join(',') || '空'}] 只能支撑到 L${reachable + 1}，从 L${beforeGuard} 回退到 L${next}（禁止跳级）`,
    );
  }

  // ---- 硬性护栏 B：同一卡点同一层级不重复 ----
  const sameLevelSameStepCount = history.filter(
    (t) => t.role === 'ai' && t.level === next && t.metaStep === diagnosis.position.stepIndex,
  ).length;
  if (sameLevelSameStepCount >= 2) {
    if (next < 3) {
      const from = next;
      next = next + 1;
      reasons.push(`护栏B：L${from} 在同一卡点已给过 ${sameLevelSameStepCount} 次，允许升一级以免原地打转`);
    } else {
      // 已在最高层且仍在同一卡点重复 ⇒ 不再"给提示"，改为补充当前步骤必需的前置知识并给一个更小任务
      reasons.push(
        `护栏B：L3 在同一卡点已给过 ${sameLevelSameStepCount} 次，不再继续给提示，改为补充当前步骤必需的前置知识并给一个更小任务`,
      );
    }
  }

  // ---- 低置信定位 ⇒ 降级为澄清，避免"对着错误的步骤给提示" ----
  if (diagnosis.position.confidence < 0.35 && next >= 2) {
    next = 1;
    reasons.push(`定位置信度仅 ${diagnosis.position.confidence}，先退到 L1 以确认位置`);
  }

  // ---- 最终再校验一次：护栏 B 的升一级不能反过来破坏护栏 A ----
  const finalReachable = maxReachableLevel(aiLevels);
  if (next > finalReachable + 1) {
    next = Math.max(1, finalReachable + 1);
    reasons.push(`护栏A（二次校验）：回退到 L${next}`);
  }

  // L3 重复到达时轮换示范变体，避免复读同一句话
  const l3Count = history.filter((t) => t.role === 'ai' && t.level === 3).length;

  return { level: next, reason: reasons.join('；'), suppressed: false, l3Count };
}

// ---------------------------------------------------------------------------
// 策略构造
// ---------------------------------------------------------------------------

/**
 * 卡点性质 × 层级 → 策略名。
 * 策略名会在 draft 提示词里展开成具体指令，也是教研评审的最小单位。
 */
const STRATEGY_MATRIX = {
  // 重要：not_started 在任何层级都只做澄清。
  // 学生连"已知什么/要求什么"都没说清时，给方向等于让他抄近路 —— 这不是帮助。
  not_started: {
    0: 'clarify_goal_and_knowns',
    1: 'clarify_goal_and_knowns',
    2: 'clarify_goal_and_knowns',
    3: 'clarify_goal_and_knowns',
  },
  knowledge_gap: {
    0: 'clarify_goal_and_knowns',
    1: 'condition_question',
    2: 'direction_pointing',
    3: 'worked_step_demo',
  },
  precondition_gap: {
    0: 'clarify_goal_and_knowns',
    1: 'condition_question',      // 本产品最强项：用前提追问替代给公式
    2: 'direction_pointing',
    3: 'worked_step_demo',
  },
  direction_lost: {
    0: 'clarify_goal_and_knowns',
    1: 'condition_question',
    2: 'direction_pointing',
    3: 'worked_step_demo',
  },
  // 学生自己已经发现这条路走不通 ⇒ 引导"换工具"，而不是继续往下算
  dead_end_path: {
    0: 'clarify_goal_and_knowns',
    1: 'condition_question',
    2: 'tool_switch',
    3: 'worked_step_demo',
  },
  execution_error: {
    0: 'clarify_goal_and_knowns',
    1: 'self_check_invitation',   // 让学生自己回查，而不是直接指出错在哪
    2: 'direction_pointing',
    3: 'worked_step_demo',
  },
  finished: {},
};

const STRATEGY_INSTRUCTIONS = {
  clarify_goal_and_knowns:
    '学生还没形成思路。只帮他分清"已知什么/要求什么/哪里不确定"，用开放式提问。不要给出任何物理方向。',
  condition_question:
    '学生用错了规律或漏了前提。先明确当前一步的方向或待检查的前提，再留一个小任务；明确忘记通用公式时可提醒公式及条件，不能给最终待求量结果式。',
  self_check_invitation:
    '学生思路方向正确，可能只是执行失误。邀请他自己回查关键一步（如单位、分母项、方向），不要直接指出错误位置。',
  direction_pointing:
    '学生知道该用哪个规律但走不下去。指出应该关注哪个量、哪个关系、哪个模块之间的连接，可补充尚未给过的通用关系、变量含义或适用条件，但不得给最终待求量表达式。',
  tool_switch:
    '学生自己已经发现当前这条路走不通。引导他判断"缺的是哪一类工具"（例如需要处理时间累积量的定理），但仍不点名具体公式，也不给出关系式。',
  worked_step_demo:
    '下沉到"动作级示范"：示范如何设研究对象、如何写出某一项的符号形式、如何做一步变形。只解释当前一个动作，可补充必要前置知识；不含本题最终数值或整题结果式。',
};

export function buildStrategy(stuckKind, level) {
  const perKind = STRATEGY_MATRIX[stuckKind] ?? STRATEGY_MATRIX.direction_lost;
  const key = perKind[level] ?? perKind[1] ?? 'condition_question';
  return { key, instruction: STRATEGY_INSTRUCTIONS[key] ?? STRATEGY_INSTRUCTIONS.condition_question };
}

/**
 * 校验历史层级序列的合法性，返回需要回退到的层级（null = 无需回退）。
 *
 * 为什么要有这个函数：护栏 A 原来只检查"目标层级的前一级是否出现过"，
 * 当历史里出现 [L2] 这种缺了 L1 的序列时，L2 存在 ⇒ 允许升到 L3，
 * 而 L1 从未给出 —— 学生直接拿到了最高级别的示范。这是一个真实的越级漏洞。
 * 现在改为按"连续前缀"判断：能达到的层级 = 从 L1 开始的最长连续段 + 1。
 */
export function maxReachableLevel(aiLevels) {
  let reachable = 0;
  while (aiLevels.includes(reachable + 1)) reachable += 1;
  return reachable;
}

// ---------------------------------------------------------------------------
// 概念白名单 & 禁止内容（闭环：guard 的历史违规会回流到这里）
// ---------------------------------------------------------------------------

/**
 * 白名单的构造依据（收窄顺序，越靠前越贴近学生当前处境）：
 *   1. 当前步骤的 concepts   —— 最相关
 *   2. 所命中错因的 hintSeeds 里出现的概念（从后果反推缺口）
 *   3. 下一步的 concepts      —— 允许"往前看一步"的方向提示
 *
 * 关键约束：**白名单里的每一条都必须来自题目自身的图谱**，
 * 绝不允许出现题目没有的概念。否则 draft 会写出跑题提示，
 * 而守卫的概念域检查会把它整体拦掉（两次都拦 ⇒ 直接掉到兜底模板，体验变差）。
 */
export function buildWhitelist(problem, diagnosis) {
  const step = findStepByPosition(problem, diagnosis.position);
  const graph = findGraph(problem, diagnosis.position.graphId);

  const ownConcepts = new Set(
    problem.solutionGraphs.flatMap((g) => g.steps.flatMap((s) => s.concepts)),
  );

  const ordered = [];
  const push = (c) => {
    if (c && ownConcepts.has(c) && !ordered.includes(c)) ordered.push(c);
  };

  for (const c of step?.concepts ?? []) push(c);

  // 从错因的 hintSeed 文本里反查概念（错因的本质往往就是某个概念没到位）
  for (const mis of diagnosis.misconceptions) {
    const m = problem.misconceptions.find((x) => x.id === mis.id);
    if (!m) continue;
    for (const seed of m.hintSeeds) {
      for (const c of ownConcepts) {
        if (seed.includes(c)) push(c);
      }
    }
  }

  const next = graph?.steps.find((s) => s.index === (step?.index ?? 0) + 1);
  for (const c of next?.concepts ?? []) push(c);

  // 兜底：该步没有 concepts 时，用同路径的其余概念，保证方向提示仍有素材
  if (ordered.length === 0) {
    for (const c of graph?.steps.flatMap((s) => s.concepts) ?? []) push(c);
  }
  return ordered;
}

/**
 * 必须回避的内容 —— 由题目数据 + 已发生的违规共同决定。
 * 这是 guard 与 generate 之间的闭环：
 *   guard 拦下什么，下一轮 draft 就显式回避什么。
 */
export function buildForbidden(problem, diagnosis, pastViolations = []) {
  const forbidden = [];
  if (problem.formulaFingerprints?.length) {
    forbidden.push(`解法性表达式（例如这类形式：${problem.formulaFingerprints.slice(0, 3).join(' / ')} 的完整写法）`);
  }
  forbidden.push('本题最终数值结果（包括近似值、"大约是多少"）和待求量完整结果式');
  forbidden.push('完整解题步骤清单或推导链');
  forbidden.push('"所以答案是/最终结果/因此可得"这类收口句式');

  for (const v of pastViolations) {
    forbidden.push(`上一轮被拦截：${v.kind} —— ${v.detail}`);
  }
  void diagnosis;
  return forbidden;
}

// ---------------------------------------------------------------------------
// 对外聚合
// ---------------------------------------------------------------------------

export function route({ problem, diagnosis, history, explicitHelpSeeking, mode, pastViolations = [] }) {
  const decision = decideLevel({ problem, diagnosis, history, explicitHelpSeeking, mode });
  if (decision.suppressed || decision.level == null) {
    return {
      level: null,
      strategy: null,
      allowedConcepts: [],
      forbidden: [],
      reason: decision.reason,
      suppressed: true,
    };
  }

  /**
   * 反问路径：只生成一个澄清问句，不进入常规的提示生成。
   *
   * 为什么单独走一条路：常规 draft 会拿到"策略 + 概念白名单"，
   * 模型的自然倾向是顺着白名单给方向 —— 而这里我们要的是"什么都不给，只问"。
   * 因此换成 clarify 策略，并且不带任何概念（没有概念可引用 ⇒ 无法给方向）。
   */
  if (decision.probeOnly) {
    return {
      level: 0,
      strategy: 'probe_for_information',
      strategyInstruction:
        '学生没有提供可诊断的思路内容。只问一个能帮他开口的问题（例如让他说题目给了什么、要求什么，或他打算用什么规律）。绝对不要给出任何学科方向或提示。',
      allowedConcepts: [],
      forbidden: [
        '任何学科方向、规律名或公式',
        '任何关于"他卡在哪一步"的判断',
        '本题的任何数值结果',
      ],
      reason: decision.reason,
      suppressed: false,
      probeOnly: true,
    };
  }

  const strategy = buildStrategy(diagnosis.stuckKind, decision.level);
  return {
    level: decision.level,
    strategy: strategy.key,
    strategyInstruction: strategy.instruction,
    allowedConcepts: buildWhitelist(problem, diagnosis),
    forbidden: buildForbidden(problem, diagnosis, pastViolations),
    reason: decision.reason,
    suppressed: false,
    /** L3 已给出的次数：用于轮换示范变体，避免复读 */
    l3Count: decision.l3Count ?? 0,
    probeOnly: false,
  };
}

export { STRATEGY_INSTRUCTIONS, STRATEGY_MATRIX, STILL_STUCK_SIGNALS, TRYING_SIGNALS };
export { maxReachableLevel as __maxReachableLevel };
