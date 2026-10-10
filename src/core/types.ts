/**
 * 核心类型契约 —— 提示引擎的公共接口。
 *
 * 设计原则（重要，决定了本 PoC 的可靠性）：
 *   1. 所有"事实"来自题目图谱（Problem.solutionGraph），不来自 LLM 记忆。
 *   2. LLM 只输出"观察"（学生说了什么、落在哪一步、像哪类错因），
 *      由确定性代码 decide 层级与提示文本的骨架。
 *   3. 提示文本必须过 guard（防泄题守卫）才能出给学生，被拦则降级重写。
 *
 * 这样做的好处：把"绝不出现答案"从"祈祷模型听话"变成"可测试的工程约束"。
 */

// ---------------------------------------------------------------------------
// 题目与标准解题路径（"基准"）
// ---------------------------------------------------------------------------

/** 一条标准解题路径。重难题允许多解，因此是数组。 */
export interface SolutionGraph {
  id: string;
  /** 路径名，如"能量守恒路径"、"动量定理路径" */
  name: string;
  /** 该路径的适用前提（若学生条件不满足，应引导换路径而非硬走） */
  preconditions: string[];
  steps: SolutionStep[];
}

export interface SolutionStep {
  /** 步骤序号，1 起 */
  index: number;
  /** 这一步在做什么（短标题，给学生看时也要用学生语言） */
  title: string;
  /**
   * 这一步的"动作类型"。route 用它决定提示的性质：
   *  - setup        建立模型/画图/选系统
   *  - identify     识别适用规律（"用哪个定律"）
   *  - precondition 检查规律的前提条件  ← 条件追问的主战场
   *  - apply        套用公式
   *  - derive       代数/微分运算
   *  - interpret    物理意义解释、讨论
   *  - conclude     得出最终结果  ← 只有这一层才可能触及答案
   */
  kind: StepKind;
  /** 学生应该产出的东西（内部用，不下发） */
  intent: string;
  /** 该步涉及的核心量/公式的"名字"，用于提示引用（不下发公式结果） */
  concepts: string[];
  /**
   * 检测学生是否走到这一步的关键词/正则。
   * 用途：离线模式与真模型结果的交叉校验（双通道校验，降低误判）。
   */
  cues?: string[];
  /** 该步之后学生常见的岔路（用于"分叉"识别） */
  forks?: Fork[];
}

export type StepKind =
  | 'setup'
  | 'identify'
  | 'precondition'
  | 'apply'
  | 'derive'
  | 'interpret'
  | 'conclude';

export interface Fork {
  /** 岔路描述："误用平均速度求瞬时电流" */
  desc: string;
  /** 该岔路对应的错因标签 id */
  misconceptionId?: string;
}

/** 题目 */
export interface Problem {
  id: string;
  subject: 'physics' | 'math' | 'chemistry';
  /** 知识点标签，用于知识图谱映射（proposal 里需要企业知识库对齐） */
  topics: string[];
  difficulty: 1 | 2 | 3 | 4 | 5;
  /** 题干 */
  stem: string;
  /** 已知量（结构化，便于提示时引用而不算结果） */
  givens: string[];
  /** 待求量 */
  asked: string[];
  /** 可选的配图描述（PoC 不做真 OCR，用文本占位） */
  figure?: string;
  /** 标准解 */
  solutionGraphs: SolutionGraph[];
  /** 本题常见错因库（带"提示种子"，但不含答案） */
  misconceptions: Misconception[];
  /**
   * 答案指纹 —— 防泄题守卫的第一道比对基准。
   * 只放"数值型最终答案"，不放公式。
   * 只要提示文本命中其中任何一条，即判为泄题并拦截（任何层级都不许出现）。
   */
  answerFingerprints: string[];
  /**
   * 解法性公式指纹 —— 第二道比对基准，按层级差异化生效：
   *   L0/L1/L2 命中即拦；L3 允许写"半边"（如只写 F·t 项），命中完整表达式仍拦。
   * 与 answerFingerprints 分开的原因：把"给出答案"和"给出解法"的拦截强度解耦，
   * 否则守卫会被迫过度激进，连"列一下受力"都拦掉。
   */
  formulaFingerprints?: string[];
  /** 参考答案（仅服务端内部持有，绝不下发前端；guard 用它做二次比对） */
  referenceAnswer: string;
}

/** 错因（诊断的原子单位） */
export interface Misconception {
  id: string;
  /** 错因标签，面向老师/教研可读 */
  label: string;
  /** 典型的学生说法（用于离线匹配与提示词 few-shot） */
  signature: string[];
  /** 错误背后的认知缺口（用于选提示方向） */
  rootCause: string;
  /**
   * 提示种子：只给"往哪想"，不给"是什么"。
   * 例："这个规律的前提里，有没有一个量你没检查？"
   */
  hintSeeds: string[];
  /** 该错因最容易被"顺手说出答案"，标记为高危 */
  highLeakRisk?: boolean;
}

// ---------------------------------------------------------------------------
// 学生思路的结构化表示（"看懂思路"的产物）
// ---------------------------------------------------------------------------

export interface StudentState {
  /** 学生自己声称的已知 */
  knowns: string[];
  /** 学生自己声称的目标 */
  goal: string | null;
  /** 学生打算使用 / 已经使用的规律或公式的"名字"（不是数值结果） */
  laws: string[];
  /** 学生的推理链，按他说的顺序 */
  reasoningChain: string[];
  /** 学生自述的不确定处 */
  uncertainties: string[];
  /** 学生自述的卡点 */
  stuckPoint: string | null;
  /** 是否有明显计算/推导痕迹（区分"想不出来"和"算错了"） */
  hasComputationTrace: boolean;
  /** 原始输入留档，报告里要回放 */
  rawUtterance: string;
}

/** 学生当前所处的解题位置 */
export interface Position {
  /** 落到哪条标准路径（null = 还没进入任何一条） */
  graphId: string | null;
  /** 落到第几步（null = 无法定位） */
  stepIndex: number | null;
  /** 定位置信度 0~1；低置信时 route 会倾向于先"结构化澄清"而不是给方向 */
  confidence: number;
  /** 学生已正确完成的步骤 */
  completedSteps: number[];
  /** 走岔的步骤（含岔路描述） */
  divergedAt: { stepIndex: number; fork: string }[];
}

export type Feasibility = 'viable' | 'partially_viable' | 'not_viable' | 'unclear';

/** 诊断结论 */
export interface Diagnosis {
  position: Position;
  feasibility: Feasibility;
  /** 判定的错因（可为空——学生只是"还没想到"，不是"错了"） */
  misconceptions: { id: string; label: string; evidence: string; confidence: number }[];
  /**
   * 卡点的"性质"——决定提示的形态：
   *  - knowledge_gap   不知道用哪个规律     → 条件追问 / 定向追问
   *  - precondition_gap 知道规律但漏了前提   → 条件追问（最强项）
   *  - direction_lost  知道规律但走不下去   → 方向提示
   *  - execution_error 思路对了算错了       → 局部示范（只示范算法不示范答案）
   *  - not_started     还没想             → 结构化澄清，先问不给提示
   */
  stuckKind: StuckKind;
  /**
   * 学生是否提供了足以诊断的信息。
   *
   * 为 false 时引擎**不做定位判断**，改为主动反问（probeQuestion）。
   * 为什么需要这个开关：早期实现无论学生说什么都必须给一个结论，
   * 哪怕他只说"我不会"，也要硬给一个步骤和错因 —— 那只是把置信度压低而已。
   * 正确动作是反问：硬猜出来的定位会让学生认为"AI 在瞎说"。
   */
  sufficientInfo: boolean;
  /** 信息不足时，该向学生追问的那一个问题 */
  probeQuestion: string | null;
  /** 学生已经想对的地方（先肯定，再指出卡点） */
  strengths: string[];
  /** 证据引用：诊断必须能指回学生的原话，避免"幻觉式读心" */
  evidenceQuotes: string[];
  /** 给学生的一句话复述（"我先确认一下我理解得对不对"） */
  restatement: string;
  /** 运行日志，用于可解释性与后续评测 */
  trace: TraceEntry[];
}

export type StuckKind =
  | 'not_started'
  | 'knowledge_gap'
  | 'precondition_gap'
  | 'direction_lost'
  | 'execution_error'
  /** 学生自己已发现当前这条路走不通（"未知量太多"），该换工具而不是继续算 */
  | 'dead_end_path'
  | 'finished';

export interface TraceEntry {
  stage: 'understand' | 'locate' | 'route' | 'generate' | 'guard' | 'report';
  message: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 分层提示
// ---------------------------------------------------------------------------

/**
 * 三层递进引导（对齐 proposal 表 ④）：
 *   L1 条件追问   —— 只问，不指方向。问"这个规律的前提是什么"
 *   L2 方向提示   —— 指出该看哪个量/哪个关系，但仍不给表达式
 *   L3 降级示范   —— 示范一步"动作"（选系统/列哪个守恒/做哪步变形），不给数值结果
 * 另有 L0 = 结构化澄清（还没想时先帮他把话说清楚，不算提示）
 */
export type HintLevel = 0 | 1 | 2 | 3;

export interface Hint {
  level: HintLevel;
  /** 提示形态 */
  form: 'clarify' | 'condition_question' | 'direction' | 'worked_step';
  /** 面向学生的提示正文（已过守卫） */
  text: string;
  /** 本轮引用的概念（让 UI 可以高亮知识点） */
  concepts: string[];
  /** 是否触及最终答案（守卫强制 false，作为断言用） */
  touchesFinalAnswer: false;
  /** 生成依据，供教研复盘 */
  rationale: string;
  /** 建议学生接下来做什么（引导"再想一步"，而不是"抄下去"） */
  nextAsk: string;
}

/** 守卫检查结果 */
export interface GuardResult {
  passed: boolean;
  /** 命中的违规类型 */
  violations: GuardViolation[];
  /** 若被拦，重写后的文本（降级策略产物） */
  repairedText?: string;
  /** 重写用了哪套策略 */
  repairStrategy?: string;
}

export interface GuardViolation {
  kind:
    | 'answer_in_text'      // 出现了最终答案或其等价数值
    | 'level_overflow'      // 提示内容超出所声明的层级（如 L1 里给了公式）
    | 'formula_leak'        // 直接给出待求量的表达式
    | 'solution_dump'       // 一口气给出完整步骤序列
    | 'final_conclusion'    // 直接下了结论
    | 'concept_out_of_domain' // 跑题：提示引用了本题不存在的物理概念
    | 'solution_insight';   // 直接说出了解题核心结论（如"r 是内阻"）
  detail: string;
  /** 命中的片段 */
  match?: string;
}

// ---------------------------------------------------------------------------
// 引擎输入输出
// ---------------------------------------------------------------------------

export interface Turn {
  role: 'student' | 'ai';
  text: string;
  at: string;
  /** AI 轮次的层级 */
  level?: HintLevel;
  /**
   * AI 轮次给出时学生所处的步骤与路径。
   * 用途：① 护栏 B（"同一卡点同一层级不重复给"）需要按步骤聚合历史；
   *      ② 学生说"然后呢"这类追问时，定位可以沿用上一轮（否则 AI 会失忆）。
   * 只看 level 无法区分"在第一步给了 L1"和"在第三步给了 L1"。
   */
  metaStep?: number | null;
  metaGraphId?: string | null;
}

export interface HintRequest {
  problemId: string;
  /** 本轮学生输入 */
  utterance: string;
  /** 历史（含之前给过的提示，用于防重复与升级判定） */
  history: Turn[];
  /** 陪伴模式：自主训练 = 只在求助时介入；AI陪伴 = 观察后主动介入 */
  mode: 'self_training' | 'ai_companion';
  /** 学生是否显式求助 */
  explicitHelpSeeking?: boolean;
}

export interface HintResponse {
  diagnosis: Diagnosis;
  /** 本轮给学生的回复（可能不含提示，例如先澄清身份/复述） */
  hint: Hint;
  /** 下一轮可用的升级建议（给 UI 提示"再想想可继续要提示"） */
  allowedNextLevel: HintLevel;
  /** 引擎元信息 */
  meta: {
    engine: 'offline-stub' | 'llm';
    model?: string;
    latencyMs: number;
    guard: GuardResult;
    /** 若真模型结果被守卫拦下并重写，记录拦截历史 */
    guardHistory: GuardResult[];
  };
}

/** 会话级累计状态（报告页要用） */
export interface SessionRecord {
  problemId: string;
  turns: Turn[];
  /** 每次提示的层级与是否被守卫拦截 */
  hintLog: {
    at: string;
    requestedLevel: HintLevel;
    deliveredLevel: HintLevel;
    stuckKind: StuckKind;
    misconceptionIds: string[];
    guardPassed: boolean;
    violationKinds: string[];
  }[];
  startedAt: string;
  endedAt?: string;
  /** 独立完成度：0~1，未被降级示范且自行推进的步骤占比 */
  independence?: number;
}

// ---------------------------------------------------------------------------
// LLM 适配层契约
// ---------------------------------------------------------------------------

/**
 * 关键：LLM 的职责被限制为"观察员"，不允许它直接产出学生可见文本。
 * 真模型与离线桩实现同一接口 —— 这是"没 Key 也能跑全套测试"的根据。
 */
export interface LLMAdapter {
  readonly kind: 'offline-stub' | 'llm';
  readonly model?: string;
  /** 把学生的自由表述解析成结构化观察（不含决策） */
  observeStudent(input: ObserveInput): Promise<Observation>;
  /** 在受限上下文下生成提示候选文本（受 template 约束） */
  draftHint(input: DraftInput): Promise<string>;
}

export interface ObserveInput {
  problem: Problem;
  utterance: string;
  history: Turn[];
}

/** LLM 输出的"观察"，刻意不包含决策字段 */
export interface Observation {
  knowns: string[];
  goal: string | null;
  laws: string[];
  reasoningChain: string[];
  uncertainties: string[];
  stuckPoint: string | null;
  hasComputationTrace: boolean;
  /** 候选步骤定位（引擎会与关键词通道交叉校验） */
  candidateStepIndex: number | null;
  /** 候选错因 id */
  candidateMisconceptionIds: string[];
  /** 支撑定位的原话片段 —— 强制要求，否则定位不被采信 */
  evidenceQuotes: string[];
  /** 学生的一句话复述素材 */
  restatement?: string;
}

export interface DraftInput {
  problem: Problem;
  diagnosis: Diagnosis;
  level: HintLevel;
  /** 允许使用的概念白名单（防越界） */
  allowedConcepts: string[];
  /** 明确禁止的内容（由 guard 反推注入，形成闭环） */
  forbidden: string[];
  /** 学生卡点性质的提示策略骨架 */
  strategy: string;
}

// ---------------------------------------------------------------------------
// 学习报告
// ---------------------------------------------------------------------------

export interface Report {
  problemId: string;
  problemTitle: string;
  /** 卡点清单 */
  stuckPoints: {
    stepIndex: number | null;
    stepTitle: string;
    kind: StuckKind;
    misconceptionLabels: string[];
    /** 该卡点被引导了几轮，层级爬到几级 */
    hintRounds: number;
    maxLevel: HintLevel;
  }[];
  /** 引导轮次统计 */
  hintStats: {
    total: number;
    byLevel: Record<HintLevel, number>;
    guardBlocked: number;
  };
  /** 独立完成度 */
  independence: { score: number; completedSteps: number; totalSteps: number; note: string };
  /** 深层问题（跨卡点归纳的认知缺口） */
  deeperIssues: string[];
  /** 举一反三建议（只给定点，不代做） */
  recommendations: { topic: string; reason: string; drill: string }[];
  /** 下一步行动 */
  nextActions: string[];
  /** 报告生成模式 */
  meta: { engine: string; model?: string; generatedAt: string };
}
