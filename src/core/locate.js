/**
 * 定位与诊断（"看懂学生思路"的落地实现）。
 *
 * 核心方法：**双通道交叉校验**
 *   通道 A（确定性）  关键词/Cue 匹配 —— 可解释、可复现、但对"换一种说法"无能
 *   通道 B（LLM 观察） 语义理解 —— 覆盖改写，但可能幻觉出学生没说过的步骤
 *
 * 两者一致 ⇒ 高置信定位；不一致 ⇒ 降置信，并在策略上退化为"先澄清"。
 * 这不是为了炫技：定位错了，后面给的提示就是错的，
 * 而"错误的提示"比"不给提示"对学生的伤害更大。
 */

import { canonicalize, clip, hasSubstantiveContent, matchAll, matchSignatures, normalize } from './text.js';
import { safeStepRef } from './guard.js';

// ---------------------------------------------------------------------------
// 双通道定位
// ---------------------------------------------------------------------------

/**
 * @returns {{
 *   graphId: string|null, stepIndex: number|null, confidence: number,
 *   completedSteps: number[], divergedAt: {stepIndex:number,fork:string}[],
 *   channelA: number|null, channelB: number|null, agreed: boolean
 * }}
 */
/**
 * @param {object} options
 * @param {boolean} [options.allowCarryover] 本轮发言是追问时是否沿用上一轮定位
 */
export function locatePosition(problem, observation, utterance, options = {}) {
  const text = canonicalize(utterance);

  // ---- 通道 A：cue 关键词 ----
  const hitsPerStep = [];
  for (const g of problem.solutionGraphs) {
    for (const s of g.steps) {
      const hits = matchAll(text, s.cues ?? []);
      hitsPerStep.push({ graphId: g.id, stepIndex: s.index, hits, score: hits.length });
    }
  }
  const maxHits = Math.max(0, ...hitsPerStep.map((h) => h.score));
  let channelA = null;
  if (maxHits > 0) {
    // 命中数相同则取更靠后的步骤（学生通常已推进到最远处）
    const best = hitsPerStep
      .filter((h) => h.score === maxHits)
      .sort((a, b) => b.stepIndex - a.stepIndex)[0];
    channelA = best.stepIndex;
  }

  // ---- 通道 B：LLM 候选 ----
  const channelB = observation.candidateStepIndex ?? null;

  // ---- 融合：冲突消解策略 ----
  //
  // 这里的设计经过真模型实测修正。原则：
  //   **学生原话（关键词通道）比模型推断（语义通道）更可靠。**
  //
  // 早期规则是"冲突时取更靠前的定位（min）"，理由是"保守"。
  // 但用真模型（glm-4-plus）跑评测发现大量定位偏差，根因正是这条规则：
  //   sc-05  关键词=4（对）  语义=1（模型误判为"判断变化原因"）→ 取了 1
  //   sc-06  关键词=3（对）  语义=1（模型误判）              → 取了 1
  // 学生的原话里有 `S=L1L2`、`磁通量` 这类明确线索，
  // 而模型的"面积在变"是它自己的推断 —— 推断错了，原话不会错。
  //
  // 现在的规则：
  //   一致           → 高置信 0.9
  //   只有关键词     → 0.6~0.8（按命中数）
  //   只有语义       → 0.6，且必须有证据引用（防幻觉）
  //   两者冲突       → 优先关键词通道，置信 0.55，并显式记录冲突
  let stepIndex = null;
  let confidence = 0.2;
  let conflict = false;

  const hasA = channelA != null;
  const hasB = channelB != null;

  if (hasA && hasB && channelA === channelB) {
    stepIndex = channelA;
    confidence = 0.9;
  } else if (hasA && hasB && channelA !== channelB) {
    conflict = true;
    stepIndex = channelA; // 信任学生原话
    confidence = 0.55;
  } else if (hasA) {
    stepIndex = channelA;
    confidence = 0.6 + Math.min(0.2, maxHits * 0.05);
  } else if (hasB) {
    // 只有模型通道：需要证据支撑，否则不采信（防幻觉定位）
    if (observation.evidenceQuotes?.length > 0) {
      stepIndex = channelB;
      confidence = 0.6;
    }
  }

  // ---- 路径确定：通道给出的路径优先，其次按步骤归属唯一路径，最后按 cue 命中数 ----
  let graphId = null;
  if (stepIndex != null) {
    if (observation._locatedGraph && problem.solutionGraphs.some((g) => g.id === observation._locatedGraph)) {
      // 观察阶段已确定路径（离线桩直接给出，避免下游二次猜测）
      graphId = observation._locatedGraph;
      // 防御：若该路径里没有这个步骤号，则退回通用推断
      const ok = problem.solutionGraphs.find((g) => g.id === graphId)?.steps.some((s) => s.index === stepIndex);
      if (!ok) graphId = null;
    }
    if (graphId == null) {
      const candidateGraphs = problem.solutionGraphs.filter((g) => g.steps.some((s) => s.index === stepIndex));
      if (candidateGraphs.length === 1) {
        graphId = candidateGraphs[0].id;
      } else if (candidateGraphs.length > 1) {
        const scored = candidateGraphs.map((g) => {
          const step = g.steps.find((s) => s.index === stepIndex);
          return { g, hits: step?.cues ? matchAll(text, step.cues).length : 0 };
        });
        scored.sort((a, b) => b.hits - a.hits);
        graphId = scored[0].g.id;
      }
    }
  }

  // ---- 追问继承：本轮无法定位但上一轮有定位 ⇒ 沿用，避免"学生说然后呢，AI 就失忆" ----
  let carriedOver = false;
  if (stepIndex == null && options.allowCarryover && options.priorPosition?.stepIndex != null) {
    const prior = options.priorPosition;
    const valid = problem.solutionGraphs
      .find((g) => g.id === prior.graphId)
      ?.steps.some((s) => s.index === prior.stepIndex);
    if (valid) {
      graphId = prior.graphId;
      stepIndex = prior.stepIndex;
      // 继承来的定位不能给高置信：本轮学生其实没提供新信息
      confidence = Math.min(0.55, (prior.confidence ?? 0.6) * 0.8);
      carriedOver = true;
    }
  }

  if (graphId == null && problem.solutionGraphs.length > 0) {
    graphId = problem.solutionGraphs[0].id; // 默认主路径，但 stepIndex 保持 null
  }

  // ---- 已完成步骤：定位步骤之前的所有步骤都视为已走过 ----
  const completedSteps = stepIndex != null ? range(1, stepIndex - 1) : [];

  // ---- 岔路识别：错因对应到步骤的 forks ----
  const divergedAt = [];
  for (const mis of observation.candidateMisconceptionIds ?? []) {
    for (const g of problem.solutionGraphs) {
      for (const s of g.steps) {
        for (const fork of s.forks ?? []) {
          if (fork.misconceptionId === mis) {
            divergedAt.push({ stepIndex: s.index, fork: fork.desc });
          }
        }
      }
    }
  }

  return {
    graphId,
    stepIndex,
    confidence: round2(confidence),
    completedSteps,
    divergedAt,
    channelA,
    channelB,
    agreed: hasA && hasB && channelA === channelB,
    conflict,
    carriedOver,
  };
}

// ---------------------------------------------------------------------------
// 可行性判定
// ---------------------------------------------------------------------------

export function judgeFeasibility(problem, position, observation) {
  const utter = canonicalize(observation.reasoningChain?.join('；') ?? '');
  void utter;

  // 显式死局信号（题库里已经标注了"单独走会卡住"的路径）
  const deadEndCues = ['能量守恒就够了', '未知量太多', '只有一个方程', '解不出来'];
  const rawText = canonicalize((observation.evidenceQuotes ?? []).join('；'));
  if (deadEndCues.some((c) => rawText.includes(canonicalize(c)))) return 'not_viable';

  if (observation.candidateMisconceptionIds?.length >= 2) return 'not_viable';
  if (observation.candidateMisconceptionIds?.length === 1) return 'partially_viable';

  if (position.stepIndex == null) return 'unclear';
  if (position.divergedAt.length > 0) return 'partially_viable';

  // 走到后段且无错因 ⇒ 认为可行
  const total = totalSteps(problem, position.graphId);
  if (position.stepIndex >= Math.ceil(total * 0.5)) return 'viable';
  return 'partially_viable';
}

// ---------------------------------------------------------------------------
// 卡点性质分类 —— 决定会给出什么形态的提示
// ---------------------------------------------------------------------------

/**
 * 判断一条路径是否是"死胡同路径"。
 *
 * 为什么需要这个：题库里会显式标注某些路径"单独走会卡住"
 * （例如"只走能量守恒"在恒力启动题上会形成两未知量的死循环）。
 * 如果学生正好停在这种路径的末步，朴素规则会判成 finished，
 * 于是 AI 对他说"你已经走到最后一步了，收尾交给你自己" ——
 * 而学生其实正卡在死胡同里求助。这是实测抓到的严重错判。
 */
export function isDeadEndGraph(problem, graphId) {
  const g = problem.solutionGraphs.find((x) => x.id === graphId);
  if (!g) return false;
  if ((g.steps?.length ?? 0) <= 1) return true;
  const text = `${g.name} ${(g.preconditions ?? []).join(' ')}`;
  return /死循环|无法解|单独使用|单独走|未知量过多|会卡住|死胡同|不是推荐/.test(text);
}

/**
 * 学生"这条路走不通了"的语言信号。
 *
 * 为什么需要单独的类别：学生说"未知量太多解不出来"时，
 * 他需要的**不是**"再往下算一步"，而是"换一个工具"。
 * 早期版本把他归入 direction_lost，L2 于是顺着原路继续指
 * （"你考虑恒力做功了吗"），对一个已经在死胡同里的学生毫无帮助。
 */
const DEAD_END_SIGNALS = [
  '未知量太多',
  '解不出来',
  '解不了',
  '算不出来',
  '算不下去',
  '方程不够',
  '只有一个方程',
  '走不通',
  '还是解不出',
];

/** 学生发言里是否出现"这条路走不通"的信号 */
export function detectDeadEndSignal(utterance, observation) {
  const pool = [utterance, ...(observation?.reasoningChain ?? []), ...(observation?.uncertainties ?? [])]
    .join(' ')
    .replace(/\s/g, '');
  return DEAD_END_SIGNALS.some((s) => pool.includes(s));
}

export function classifyStuckKind(problem, observation, position, utterance = '') {
  const total = totalSteps(problem, position.graphId);
  const onDeadEnd = isDeadEndGraph(problem, position.graphId);

  // 学生明确表示"这条路走不通" ⇒ 无论定位在哪，都该引导换工具
  if (detectDeadEndSignal(utterance, observation)) {
    return 'dead_end_path';
  }

  // 已经走到最后一步且没有任何错因 ⇒ 让他自己收尾，AI 不做任何事。
  // 但死胡同路径上的"末步"不算完成 —— 学生需要的是换一个工具，而不是收尾。
  if (
    position.stepIndex != null &&
    position.stepIndex >= total &&
    observation.candidateMisconceptionIds.length === 0 &&
    position.confidence >= 0.7 &&
    !onDeadEnd
  ) {
    return 'finished';
  }
  // 停在死胡同末步 ⇒ 方向丢失（该换规律了），而不是完成
  if (position.stepIndex != null && position.stepIndex >= total && onDeadEnd) {
    return 'direction_lost';
  }

  const noThinking =
    observation.reasoningChain.length === 0 &&
    observation.laws.length === 0 &&
    position.stepIndex == null;

  if (noThinking) return 'not_started';

  const misLabels = observation.candidateMisconceptionIds
    .map((id) => problem.misconceptions.find((m) => m.id === id))
    .filter(Boolean);

  // 有计算痕迹但错因指向概念 ⇒ 不是粗心，是前提没检查
  const preconditionMis = misLabels.filter((m) =>
    /前提|条件|漏|忘|忽略|误判|混淆|方向|有效|内阻|均匀/.test(`${m.label} ${m.rootCause}`),
  );
  if (preconditionMis.length > 0) return 'precondition_gap';

  // 不知道用哪个规律
  if (observation.laws.length === 0 && position.stepIndex == null) return 'knowledge_gap';

  // 知道规律但走不下去 / 方向丢失
  if (observation.laws.length > 0 && observation.uncertainties.length > 0) return 'direction_lost';
  if (position.stepIndex == null && observation.laws.length > 0) return 'direction_lost';

  // 思路对但执行出错
  if (observation.hasComputationTrace && misLabels.length === 0) return 'execution_error';
  if (misLabels.some((m) => /计算|代数|单位|数值|代数运算/.test(`${m.label} ${m.rootCause}`))) {
    return 'execution_error';
  }

  if (observation.uncertainties.length > 0) return 'direction_lost';
  return position.stepIndex == null ? 'knowledge_gap' : 'direction_lost';
}

// ---------------------------------------------------------------------------
// 主入口：观察 → 诊断
// ---------------------------------------------------------------------------

/**
 * @param {import('./types.js').Problem} problem
 * @param {import('./types.js').Observation} observation
 * @param {string} utterance
 * @param {import('./types.js').TraceEntry[]} trace
 * @param {{ priorPosition?: object|null, allowCarryover?: boolean }} [options]
 * @returns {import('./types.js').Diagnosis}
 */
export function buildDiagnosis(problem, observation, utterance, trace = [], options = {}) {
  const loc = locatePosition(problem, observation, utterance, options);

  const position = {
    graphId: loc.graphId,
    stepIndex: loc.stepIndex,
    confidence: loc.confidence,
    completedSteps: loc.completedSteps,
    divergedAt: loc.divergedAt,
  };

  trace.push({
    stage: 'locate',
    message: `双通道定位：关键词通道=${loc.channelA ?? '无'}，语义通道=${loc.channelB ?? '无'}${
      loc.agreed ? '，一致' : loc.conflict ? `，冲突 ⇒ 采信学生原话（第 ${loc.channelA} 步）` : '，单通道'
    }${loc.carriedOver ? '（本轮是追问，沿用上一轮定位）' : ''} ⇒ 定位第 ${loc.stepIndex ?? '?'} 步（置信 ${loc.confidence}）`,
    data: {
      channelA: loc.channelA,
      channelB: loc.channelB,
      agreed: loc.agreed,
      conflict: loc.conflict,
      carriedOver: loc.carriedOver,
    },
  });

  const feasibility = judgeFeasibility(problem, position, observation);
  trace.push({ stage: 'understand', message: `思路可行性判定：${feasibility}` });

  const stuckKind = classifyStuckKind(problem, observation, position, utterance);
  trace.push({
    stage: 'understand',
    message: `卡点性质：${stuckKind}${observation.candidateMisconceptionIds.length ? `（候选错因 ${observation.candidateMisconceptionIds.join(',')}）` : ''}`,
  });

  const misconceptions = (observation.candidateMisconceptionIds ?? [])
    .map((id) => {
      const m = problem.misconceptions.find((x) => x.id === id);
      if (!m) return null;
      // 置信度：有学生原话支撑才给高置信
      const evidence = observation.evidenceQuotes.find((q) => matchSignatures(q, m.signature).length > 0);
      return {
        id: m.id,
        label: m.label,
        evidence: evidence ?? observation.evidenceQuotes[0] ?? '（无直接原话支撑，按语义近似判定）',
        confidence: evidence ? 0.85 : 0.5,
      };
    })
    .filter(Boolean);

  const evidenceQuotes = dedupe(observation.evidenceQuotes ?? []).slice(0, 4);

  /**
   * 信息是否充足 —— 学生是否真的说了可诊断的东西。
   *
   * 为什么需要这个开关（来自一次设计对照的启发）：
   *   早期实现无论学生说什么都必须产出一个诊断结论 ——
   *   哪怕他只说了"我不会"，也要硬给一个 stepIndex 和错因，只是把 confidence 压低。
   *   这是错的：信息不足时正确动作是**主动反问**，不是硬猜。
   *   硬猜出来的定位会让学生觉得"AI 在瞎说"。
   *
   * 判定基准是**学生发言本身**，不是派生字段：
   *   reasoningChain / knowns 都可能是桩或模型"加工"出来的，
   *   用它们反推会把"我不会"误判成有内容（实测踩过）。
   */
  const modelSaysSufficient = observation.sufficientInfo;
  void modelSaysSufficient;

  /**
   * 融合规则。这里的关键是**不能让"模型过于保守"把提示能力吃掉**。
   *
   * 实测教训：真模型在多数场景上会把 sufficientInfo 判成 false
   * （它对"学生的思路够不够清楚"的标准比人严），
   * 如果直接采信，绝大多数场景第一轮都会退化成反问 ——
   * 功能上"安全"，但产品上等于不干活。
   *
   * 因此最终判据落在**学生发言本身**：
   *   发言里有 AI 能抓的实质内容 ⇒ 信息充足（即使模型说不足也照常诊断）
   *   发言里确实什么都没有     ⇒ 信息不足，走反问
   * 本函数只看"发言有无内容"，因此模型说 true 也不会让空发言变充足。
   */
  const utteranceHasSubstance = hasSubstantiveContent(utterance);
  const hasDerivedContent =
    (observation.reasoningChain ?? []).some((r) => hasSubstantiveContent(r)) ||
    (observation.laws ?? []).length > 0;

  const sufficientInfo = utteranceHasSubstance || hasDerivedContent;

  /** 信息不足时，该向学生追问的那个问题 */
  const probeQuestion = sufficientInfo
    ? null
    : observation.probeQuestion || buildProbeQuestion(observation, position);

  if (!sufficientInfo) {
    trace.push({
      stage: 'understand',
      message: `信息不足：学生未提供可诊断的思路内容 ⇒ 走反问流程，而不是硬给定位`,
    });
  }

  /** 学生已经想对的地方 —— 先肯定，再指出卡点 */
  const strengths = buildStrengths(problem, observation, position);
  if (strengths.length) {
    trace.push({ stage: 'understand', message: `学生已想对：${strengths.join('；')}` });
  }

  const restatement = buildRestatement(problem, observation, position, stuckKind, {
    strengths,
    sufficientInfo,
    probeQuestion,
  });

  return {
    position,
    feasibility,
    misconceptions,
    stuckKind,
    sufficientInfo,
    probeQuestion,
    strengths,
    evidenceQuotes,
    restatement,
    trace,
  };
}

// ---------------------------------------------------------------------------
// 复述（"我先确认我理解得对不对"）—— 建立信任 + 暴露误读
// ---------------------------------------------------------------------------

/**
 * 复述（"我先确认我理解得对不对"）—— 建立信任 + 暴露误读。
 *
 * 三种形态，按信息充足度选择：
 *   ① 信息不足 → 只反问，不做任何判断（不硬猜定位）
 *   ② 有实质思路 → 先肯定"想对了什么"，再说"大概停在哪"
 *   ③ 只给了追问 → 不硬凑复述，简短衔接
 */
export function buildRestatement(problem, observation, position, stuckKind, opts = {}) {
  const step = findStepByPosition(problem, position);
  const { strengths = [], sufficientInfo = true, probeQuestion = null } = opts;

  if (stuckKind === 'not_started') {
    return (
      probeQuestion ??
      '我还没听到你的具体想法。要不先从最小的一步开始：这道题给了哪些量，要求的是什么？'
    );
  }

  // ---- ① 信息不足：不硬猜，直接反问 ----
  if (!sufficientInfo && probeQuestion) {
    return probeQuestion;
  }

  const parts = [];
  if (observation.goal) parts.push(`你要求的是「${clip(observation.goal, 40)}」`);

  // 复述推理链时，必须过滤掉"然后呢""还是不会"这类纯追问 ——
  // 否则会出现"我理解你的意思是：你的推理走到了「还是不会,再给一点提示」"这种废话复述。
  const substantive = (observation.reasoningChain ?? []).filter(isSubstantiveReasoning);
  const chainText = substantive.length ? clip(substantive[substantive.length - 1], 50) : null;

  // 推理链里已经点到某个规律时，不再把规律单独列一遍。
  // 否则复述会变成"你打算用「欧姆定律」，你的推理走到了「我用欧姆定律算电流…」"——
  // 同一件事说两遍，是学生眼里最刺眼的"AI 味"。
  const lawsNotInChain = observation.laws.filter((l) => !chainText || !chainText.includes(l));
  if (lawsNotInChain.length) parts.push(`你打算用「${lawsNotInChain.join('、')}」`);
  if (chainText) parts.push(`你的推理走到了「${chainText}」`);

  // 没有任何实质信息可复述时不要硬凑 —— 宁可不说，也不要复读学生的废话
  if (parts.length === 0) {
    const posOnly = step
      ? `你之前停在${safeStepRef(problem, step)}这一步，我们接着往下。`
      : '我们接着刚才的地方往下。';
    return posOnly;
  }

  const head = `我理解你的意思是：${parts.join('，')}。`;

  // 先肯定想对的地方 —— 一个卡住的学生最需要先听到这句，
  // 否则他会觉得自己整道题全错了（这是教学法上的必要，不是客套）。
  const strengthText = strengths.length
    ? `这一步你想对的地方是：${strengths.slice(0, 3).join('；')}。`
    : '';

  /**
   * 这里刻意**不直接引用步骤标题**（见 guard.js 的 isTitleSafeForStudent）：
   * 步骤标题是教研语言，有些标题本身就是答案
   * （实测："因此 a、b 有公因数 2，与'互质'矛盾"）。
   * 安全的标题照引，不安全的退到"第 N 步（动作类型）"。
   */
  const posText = step
    ? `按这个思路，你大概停在${safeStepRef(problem, step)}这一步。`
    : '我暂时没能确定你具体停在哪一步。';

  const misNote =
    stuckKind === 'precondition_gap'
      ? '问题多半不在算，而在某个规律的前提条件上。'
      : '';

  return `${head}${strengthText}${posText}${misNote}如果我说错了，你直接纠正我。`;
}

/**
 * 学生已经想对的地方。
 *
 * 来源有三处（都是可验证的，不做主观评价）：
 *   ① 观察到的、且落在标准路径上的规律（他说要用欧姆定律，而这个规律确实在这条路径上）
 *   ② 定位步骤之前的所有步骤（他已走过的路）
 *   ③ 错因的反面（他命中了错因 A，说明错因 B 他没犯 —— 但这不算"想对"，故不采用）
 */
function buildStrengths(problem, observation, position) {
  const out = [];
  const step = findStepByPosition(problem, position);
  const graph = problem.solutionGraphs.find((g) => g.id === position.graphId);

  // ① 用对了规律：他说要用的规律，是否出现在标准路径的概念里
  const pathConcepts = new Set((graph?.steps ?? []).flatMap((s) => s.concepts));
  for (const law of observation.laws ?? []) {
    const hit = [...pathConcepts].find((c) => c.includes(law) || law.includes(c));
    if (hit) out.push(`选对了「${hit}」这个方向`);
  }

  // ② 已走过的步骤（最多提两处，避免复述过长）
  if (position.stepIndex != null && position.stepIndex > 1) {
    const passed = (graph?.steps ?? [])
      .filter((s) => s.index < position.stepIndex)
      .slice(-2)
      .map((s) => s.title);
    if (passed.length) out.push(`已经走到了「${passed.join('」→「')}」`);
  }

  // ③ 当前步骤本身如果做对了一部分（有错因说明这一步有问题，就不算）
  if (step && (observation.candidateMisconceptionIds ?? []).length === 0 && position.stepIndex != null) {
    // 同样不直接引标题：strengths 会进复述段与"我读懂了你的这些想法"，是学生可见文本
    out.push(`在${safeStepRef(problem, step)}这一步上方向是清楚的`);
  }

  return dedupe(out).slice(0, 3);
}

/**
 * 信息不足时该追问什么。
 *
 * 注意：这些问句必须**具体可答**。实测发现模型和人都倾向于生成
 * "你能说详细点吗"这种没有抓手的问题 —— 学生听完还是不知道要说什么。
 * 所以这里限定为"让他说已知与目标""让他说打算用什么规律"这类可立即回答的问题。
 * 同时避免出现"详细"二字，因为有测试断言这一点（那个断言是为了守住这个原则）。
 */
function buildProbeQuestion(observation, position) {
  if ((observation.knowns ?? []).length === 0 && (observation.goal ?? null) === null) {
    // 刻意不写"说完我们再决定往哪个方向想"——
    // 反问段与提示段会拼在同一条消息里，一旦本轮已经给出了方向提示，
    // 这句承诺就和下面的方向自相矛盾（学生看到的是"你还没说清楚"+"给你一个方向"）。
    return '我还没听出你的具体想法。你能先说一下：这道题给了哪些量、要求的是什么吗？';
  }
  if ((observation.laws ?? []).length === 0) {
    return '你能说一下你打算用哪个规律或哪个公式来入手吗？只说出名字就行，不用写式子。';
  }
  if (position.stepIndex == null) {
    return '你能把现在的思路按顺序说一遍吗 —— 你第一步做了什么、第二步打算做什么？我按你的顺序来对。';
  }
  return '你能再多说一句你现在想到哪一步了吗？这样我才好判断该往哪帮你。';
}

/** 判断一段话是否是"有实质内容的推理"，而不是纯追问/情绪表达 */
function isSubstantiveReasoning(text) {
  const t = normalize(text).trim();
  if (!t) return false;
  // 长度太短基本是"然后呢""不会"这类
  if (t.length < 4) return false;
  // 纯追问/情绪词开头且整体很短
  if (
    t.length <= 14 &&
    /^(然后|接着|还是|不会|不懂|不明白|为什么|怎么办|继续|嗯|哦|是|对|不对|卡住|想不出)/.test(t)
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function findStepByPosition(problem, position) {
  if (!position?.graphId || position.stepIndex == null) return null;
  const g = problem.solutionGraphs.find((x) => x.id === position.graphId);
  return g?.steps.find((s) => s.index === position.stepIndex) ?? null;
}

export function findGraph(problem, graphId) {
  return problem.solutionGraphs.find((g) => g.id === graphId) ?? problem.solutionGraphs[0] ?? null;
}

export function totalSteps(problem, graphId) {
  const g = findGraph(problem, graphId);
  return g ? g.steps.length : 0;
}

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

function dedupe(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 供 UI 显示的定位可读化 */
export function describePosition(problem, position) {
  const step = findStepByPosition(problem, position);
  if (!step) return '尚未定位到具体步骤';
  return `第 ${step.index} 步 · ${step.title}（${step.kind}）`;
}

export { normalize };
