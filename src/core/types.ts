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
  /**
   * 题目来源。
   *   'library'  教研维护的题库（图谱质量最高，指纹最全）
   *   'imported' 运行时导入的任意新题目（由 intake 从题干现场生成）
   *
   * 为什么要在数据里显式区分：两者的可信度不同。
   * 导入题的图谱是模型生成的，**必须**在教师视图里标出来，
   * 否则教研会把"模型猜的路径"当成"教研审过的路径"——那是排期判断失真。
   */
  source?: 'library' | 'imported';
  /** 导入时间（仅 source='imported'） */
  createdAt?: string;
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
  /**
   * 解法要点指纹 —— "说出这个量扮演什么角色"就等于把答案递过去了。
   * 与 formulaFingerprints 的区别：那是给表达式，这是给结论（如"r 是内阻"）。
   * 只在 L0–L2 生效（L3 是降级示范，允许说到这个颗粒度）。
   */
  solutionInsights?: string[];
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
  /**
   * 提示形态。
   *
   * 注意 `confirm` 不是提示 —— 它是"确认学生自己答对了"。
   * 单独列出来而不是塞进 clarify，是因为两者的**语义与约束完全不同**：
   *   提示：引擎在引导学生，绝不许出现答案（由 guard 强制）
   *   确认：引擎在回应学生已经说出来的答案，不许出现学生没说的答案
   * 把它混进提示层级里，报告统计与守卫口径都会被污染。
   */
  form: 'clarify' | 'condition_question' | 'direction' | 'worked_step' | 'confirm';
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
// 新题目导入（"任意题目文字 → 结构化题目"的契约）
// ---------------------------------------------------------------------------

/**
 * 导入阶段模型被允许做的事，被刻意限制在"读题"上：
 *   它产出 givens/asked/topics/解题路径/错因/参考答案，
 *   但**不产出任何面向学生的话术**，也不参与层级决策。
 *
 * 这样切的原因与 observe/draft 同一套逻辑：
 *   模型擅长"读懂题目"，不擅长"守住分寸"。
 * 因此导入题目的每一句话术仍然要经过 route + guard，
 * 与题库题走完全相同的出口。
 */
export interface IntakeResult {
  problem: Problem;
  /** 读题产出的分析摘要（教师视图可见，学生视图不可见） */
  analysis: {
    /** 题目在问什么（一句话） */
    summary: string;
    /** 知识点（= problem.topics，显式再列一次便于前端展示） */
    topics: string[];
    /** 解题路径概览：每条路径的名字 + 步数 */
    paths: { id: string; name: string; stepCount: number; preconditions: string[] }[];
    /** 本题的关键关节（教研视角：哪一步最容易卡） */
    keySteps: { index: number; title: string; kind: StepKind }[];
  };
  /** 生成过程中的告警（模型输出被修正/降级的地方，教师视图可见） */
  warnings: string[];
  /** 是否走了模型；false 表示已降级为通用骨架 */
  usedModel: boolean;
  latencyMs: number;
}

/** 导入请求 */
export interface IntakeRequest {
  /** 题干原文（学生粘贴的题目文字） */
  rawText: string;
  /** 可选：学生/老师指定的学科提示 */
  subjectHint?: 'physics' | 'math' | 'chemistry' | null;
}

// ---------------------------------------------------------------------------
// 题目解析（"原题 ⇄ 解析"里"解析"那一半的契约）
// ---------------------------------------------------------------------------

/**
 * 一道题的解析。学生看的和教师看得的是**两次投影**，不是同一份数据加打码。
 *
 * 这个结构里最要紧的是 `KeyCondition.reveals`：
 *   有些条件的"含义"本身就是答案（"匀速 ⇒ 合力为零"就是那道题的 solutionInsight）。
 *   所以每条条件都要先过一道判据，把"会剧透"的挑出来 ——
 *   学生看到的是提问，教师看到的是完整含义 + 剧透标记。
 */
export interface ProblemAnalysis {
  /** 这道题在问什么（一句话） */
  summary: string;
  variables: {
    /** 已知量，拆到"符号 / 值 / 单位 / 它是什么" */
    given: AnalysisVariable[];
    /** 待求量 */
    asked: AnalysisVariable[];
    /** 定性条件（"匀速运动""不计摩擦"）—— 它们不是数值，单列更好读 */
    qualitative: string[];
  };
  keyConditions: KeyCondition[];
  knowledgeGraph: KnowledgeGraphPair;
}

export interface AnalysisVariable {
  id: string;
  kind: 'given' | 'asked';
  /** 题干原话 */
  raw: string;
  /** 符号，取不到为空串 */
  symbol: string;
  /** 数值（字符串，保留题干精度），非数值量为 null */
  value: string | null;
  unit: string;
  /** 中文说明（"长度 / 距离"）；已知量里若与原文相同则为空，避免印两遍 */
  note: string;
}

export interface KeyCondition {
  /** 题干原话里的一小段（关键词前后各 12 字），不是整句 */
  text: string;
  /** 短标签："匀速（速度不变）" */
  label: string;
  kind: 'boundary' | 'qualitative' | 'constraint' | 'geometry' | 'task' | 'domain';
  /** 它在解题上意味着什么（教师可见；会剧透时学生拿不到） */
  meaning: string;
  /** 不剧透版本：把它变成一句让学生自己翻译的提问 */
  ask: string;
  /**
   * 这条条件的含义会不会说漏答案。
   *
   * 两条判据（见 analysis.js 的 doesReveal）：
   *   ① 结论型 —— 命中 solutionInsights / formulaFingerprints（与守卫同一套指纹）
   *   ② 前提型 —— 命中只存在于解题步骤里的说法（步骤标题 / 定位关键词 / 路径前提）
   *
   * ② 是测试逼出来的：只做 ① 时，"切割式要求 B、L、v 两两垂直"这种
   * "把该检查什么前提说出来"的泄漏完全抓不到。
   */
  reveals: boolean;
}

/**
 * 知识图谱的两层。
 *
 * 学生层只有 topics（章节级知识点）；教师层多一层 steps[].concepts。
 * 为什么必须分开：concepts 就是解法本身 ——
 * 实测漏过一次，把 concepts 汇总发给学生，而里面有「电源与内阻」
 * 和「匀速直线运动合力为零」，恰好是那道题的两个 solutionInsight。
 */
export interface KnowledgeGraphPair {
  student: KnowledgeGraph;
  teacher: KnowledgeGraph;
}

export interface KnowledgeGraph {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  /**
   * 关系从哪来：
   *   'model'   读题时由模型判断的（导入题目）
   *   'derived' 按"文本包含 + 同层共现"派生的（题库题目，或模型漏给时）
   * 这个字段会显示在界面上 —— 让"这张关系图不是教研标注的"这件事可见。
   */
  edgeSource: 'model' | 'derived';
  /** 图的覆盖范围，如实告诉 UI 这是设计而不是缺失 */
  scope: 'topics-only' | 'topics+concepts+steps';
}

export interface KnowledgeNode {
  id: string;
  name: string;
  /**
   * core    本题核心考点
   * support 需要用到的基础
   * concept 解法步骤里出现的概念（**只在教师图谱里**）
   */
  role: 'core' | 'support' | 'concept';
  /** 1=本题核心 2=直接前置 3=更基础；渲染时大的在上 */
  level: 1 | 2 | 3;
  note: string;
  /** 仅教师图谱：这个概念出现在解题路径的第几步 */
  steps?: number[];
}

export interface KnowledgeEdge {
  from: string;
  to: string;
  relation: 'prereq' | 'includes' | 'applies' | 'related';
  /** 边上显示的中文标签（前置 / 包含 / 应用 / 相关） */
  label: string;
}

/** 学生可见的解析：会剧透的条件只剩提问 */
export interface StudentProblemAnalysis {
  summary: string;
  variables: ProblemAnalysis['variables'];
  keyConditions: {
    text: string;
    kind: KeyCondition['kind'];
    label: string;
    /** 会剧透时为 null */
    meaning: string | null;
    /** 会剧透时才有的提问 */
    question: string | null;
    revealsInsight: boolean;
  }[];
  knowledgeGraph: KnowledgeGraph;
  asked: string[];
}

// ---------------------------------------------------------------------------
// 答案判定（"学生自己答对了"）
// ---------------------------------------------------------------------------

/**
 * 一轮发言的答案判定结果。
 *
 * 设计原点是一个试用反馈：**"我直接把正确答案说出来了，它还在引导我。"**
 *
 * 原引擎刻意"不判对错"（怕变成对学生的评价）。但学生自己走通了一步时，
 * 最该发生的动作是**确认**，然后跳过那一问继续往下 —— 而不是接着追问。
 * 于是这里做了一个**不对称**的设计：
 *   说对了 ⇒ 确认（甚至庆祝）
 *   说错了 ⇒ 什么都不说，走原来的引导路径
 * 这个不对称是刻意的：这个产品不做判卷，只做"陪你想"。
 */
export interface AnswerVerdict {
  /** 这道题有没有数值型答案（证明题这类没有） */
  numeric: boolean;
  expectedCount: number;
  /** 学生这一轮说对的那些答案（含学生原话片段，UI 直接回显） */
  matched: { value: string; unit: string; raw: string; quote: string }[];
  /** 还没答出来的（引擎**不许**把它们说出来） */
  remaining: { value: string; unit: string; raw: string }[];
  /** 结论型题目命中的结论指纹 */
  conclusions: string[];
  /** 全部待求量都齐了才算完成 —— 四问只答对一问不是"做完了" */
  complete: boolean;
}

/**
 * 学生可见的完成信息。
 *
 * `matched` 里的每一个数字都来自**学生本人这一轮的原话**，
 * 引擎只负责把它取出来放大。这条不是风格问题，是可测试的约束：
 * `findUnstatedAnswers()` 会检查确认文本里没有出现学生尚未说出的答案。
 */
export interface CompletionPayload {
  complete: boolean;
  /** 学生自己说出的答案（UI 回显"你说的"）；raw 是"值 + 单位"的展示形式 */
  matched: { value: string; unit: string; raw?: string; quote: string }[];
  remainingCount: number;
  expectedCount: number;
}

// ---------------------------------------------------------------------------
// 引擎判断链路（可视化用）
// ---------------------------------------------------------------------------

/**
 * 引擎判断链路的一步 —— 给学生看的那一版。
 *
 * 关键设计：**同一条链路的"学生版"和"教师版"是两次不同的投影，不是一次投影加打码。**
 *   学生版：只说"我做了什么判断"（读懂了你的思路 / 定位到你在哪一步 / 决定给几级提示）
 *          绝不含错因标签、置信度、守卫违规类型、答案指纹。
 *   教师版：完整 trace + 内部字段 + 教程标签（见 TeacherPayload）。
 *
 * 为什么不做"打码"：打码依赖"记得打哪里"，漏一处就是泄题。
 * 白名单投影只依赖"允许说什么"，漏一处只是少说一句话。
 */
export interface EnginePathEntry {
  /** 阶段：读题 / 理解 / 定位 / 决策 / 成文 / 把关 */
  stage: 'intake' | 'understand' | 'locate' | 'route' | 'generate' | 'guard';
  /** 面向学生的说明（已过白名单） */
  label: string;
  /** 一个可选的状态点：ok / info / hold */
  tone: 'ok' | 'info' | 'hold';
}

// ---------------------------------------------------------------------------
// 学生视图 / 教师视图载荷（服务端分流）
// ---------------------------------------------------------------------------

/** 学生在对话中能拿到的一切。注意这里没有任何教研字段。 */
export interface StudentTurnPayload {
  message: string;
  hint: {
    level: HintLevel;
    levelName: string;
    form: Hint['form'];
    text: string;
    concepts: string[];
    nextAsk: string;
    /** 面向学生的层级说明（不是 rationale —— rationale 是内部依据） */
    levelNote: string;
  };
  /** 学生在图谱里的位置 —— 只给"第几步 / 共几步"，不给步骤内容 */
  progress: {
    stepIndex: number | null;
    stepCount: number;
    graphName: string | null;
    confidenceLabel: '高' | '中' | '低';
  };
  /** 引擎判断链路（学生版投影） */
  enginePath: EnginePathEntry[];
  /** 学生已被读懂的部分（正面反馈 → 学习动机） */
  understood: string[];
  /** 学生应接着做的一个动作 */
  nextStep: string | null;
  /** 陪伴模式行为 */
  mode: 'self_training' | 'ai_companion';
  /** 本轮是否有内容被守住（学生版只显示"复习了一遍"，不显示违规类型） */
  reviewed: boolean;
}

/**
 * 教师视图载荷 —— 只在带对 TEACHER_KEY 时返回。
 * 包含：知识点、完整路径图谱、错因统计、引擎完整 trace、答案指纹命中记录。
 */
export interface TeacherPayload {
  sessionId: string;
  problem: {
    id: string;
    source: 'library' | 'imported';
    subject: string;
    topics: string[];
    difficulty: number;
    stem: string;
    givens: string[];
    asked: string[];
    /** 完整解题路径（学生视图永远拿不到） */
    solutionGraphs: SolutionGraph[];
    misconceptions: { id: string; label: string; rootCause: string; hitCount: number }[];
    /** 仅在教师视图返回：用于教研核对提示是否贴近参考答案 */
    referenceAnswer: string;
    answerFingerprints: string[];
    formulaFingerprints: string[];
    solutionInsights: string[];
  };
  /** 逐轮统计 */
  turns: {
    index: number;
    utterance: string;
    deliveredLevel: HintLevel;
    stuckKind: StuckKind;
    stepIndex: number | null;
    misconceptionIds: string[];
    guardPassed: boolean;
    violationKinds: string[];
    evidenceQuotes: string[];
  }[];
  /** 引擎完整判断链路（每一轮的 trace 合并） */
  trace: { turn: number; entries: TraceEntry[] }[];
  summary: {
    totalTurns: number;
    byLevel: Record<HintLevel, number>;
    guardBlocked: number;
    locateAccuracyNote: string;
  };
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
  /**
   * 读一道**新题目**：题干 → 结构化题目（知识点 / 解题路径 / 错因 / 参考答案）。
   *
   * 为什么把它放在适配器层而不是单独一个"导入服务"：
   *   它本质上是第三次"让模型只做它擅长的事"——
   *   observe 负责"听懂学生"，draft 负责"说一句提示"，
   *   understandProblem 负责"读懂题目"。三者共享同一套降级与容错。
   * 离线桩实现同一接口：没有 Key 时用启发式规则抽已知量/待求量，
   * 产出**单路径通用骨架**。功能弱，但保证"没 Key 也能走完整流程"。
   *
   * 声明为可选：intake 在缺失时会直接走启发式骨架，
   * 这样测试里的极简 mock 适配器（只实现 observe/draft）不必跟着改。
   */
  understandProblem?(input: IntakeRequest): Promise<unknown>;
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
