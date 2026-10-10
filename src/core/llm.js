/**
 * LLM 适配层。
 *
 * 两条实现，同一接口（types.js 的 LLMAdapter）：
 *   - createOfflineAdapter()  规则桩：不联网、可复现、用于跑通与评测
 *   - createOpenAIAdapter()   OpenAI 兼容协议：DeepSeek / 通义 / 智谱 / 内网 vLLM 均可
 *
 * 选型理由写在这里，方便后续换模型：
 *   LLM 在本架构里只做两件事 —— ①把学生自由表述解析成结构化观察；
 *   ②在受限上下文下起草提示候选。它不决定层级、不决定是否放行。
 *   因此换模型的风险被限制在"观察准确率"，而不是"会不会泄题"。
 */

import { canonicalize, clip, containsAny, matchAll, matchSignatures, normalize } from './text.js';

// ---------------------------------------------------------------------------
// 观测提示词（Prompt 规范的可执行版本，见 docs/03-prompt-spec.md）
// ---------------------------------------------------------------------------

/**
 * observe 阶段的系统提示。
 * 关键约束：只输出 JSON、禁止出现任何数值结论、evidenceQuotes 必须来自学生原话。
 */
export const OBSERVE_SYSTEM_PROMPT = `你是物理教研助手的"思路听写员"。你的唯一任务是把学生说的解题思路转写成结构化观察。

【你的身份边界】
你不是解题者，不是老师，不评价对错。你只做三件事：记录、归类、指认位置。

【绝对禁止】
1. 禁止出现任何数值计算结果（如 "0.4 V"、"1 A"、"4 m/s"）。
2. 禁止给出任何公式的最终形式（不要写 "E = BLv"、"I = E/(R+r)"）。
3. 禁止给出答案、结论、或"所以应该…"。
4. 禁止编造学生没说过的话。evidenceQuotes 里的每一句必须是学生原话的子串。

【输出格式】只输出一个 JSON 对象，不要多余文字、不要 markdown 代码块：
{
  "knowns": ["学生自己提到的已知量，用他的说法"],
  "goal": "学生认为要求什么；没提到则 null",
  "laws": ["学生打算用或已经用的规律/公式的名字，如 '法拉第电磁感应定律'；只写名字不写表达式"],
  "reasoningChain": ["按学生叙述顺序，把他的推理拆成一条条"],
  "uncertainties": ["学生明确表示不确定/猜的地方"],
  "stuckPoint": "学生卡在哪；没卡则 null",
  "hasComputationTrace": true/false,
  "candidateStepIndex": 数字或 null,
  "candidateMisconceptionIds": ["从给定错因清单里选，没有就给空数组"],
  "evidenceQuotes": ["支撑上述判断的学生原话片段"],
  "sufficientInfo": true/false,
  "probeQuestion": "信息不足时你想向学生追问的那一个问题；信息充足则 null",
  "restatement": "用一句话复述学生的思路，句式：'我理解你的意思是…'"
}

【sufficientInfo 怎么判 —— 宁可说"不足"，不要硬猜】
只有在学生**真的说出了可诊断的内容**时才填 true，例如：
  · 他提到的已知量 / 目标
  · 他打算用或已经用的规律名
  · 他描述了自己的推理步骤
  · 他明确指出了自己卡在哪里
以下情况必须填 **false**：
  · 只说"我不会""不知道""看不懂""没思路"
  · 只说"然后呢""接下来怎么办""提示一下"
  · 纯情绪表达、离题发言、或与本题无关的话
填 false 时，probeQuestion 必须是**一个**能帮他开口的具体问题
（例如"这道题给了哪些量、要求的是什么？"或"你打算用哪个规律入手？"），
不要问"你能说详细点吗"这种没有抓手的问题。

【candidateMisconceptionIds 的判定要求 —— 最容易漏的一项】
把学生的每一句话都与错因清单逐条比对，**只要有一句符合某条错因的"典型说法"，就选中它**。
学生的错误表述往往很自然，不要因为"他说得挺流畅"就认为他没错。
特别留意这三类信号：
  · 他给出的理由/前提是错的，即使结论碰巧对
  · 他把某个量当成了常量、或把某个规律的前提当成了自动成立
  · 他说"直接""就用""不用管"某个量 —— 这通常正是在漏掉那个量
如果确实没有任何一句话匹配清单，才返回空数组。宁可多报一条（会被后续校验筛掉），也不要漏报。

【restatement 的要求】
复述学生的思路时，如果他已经想对了某一步，先指出"他想对了什么"，再说他停在哪。
一个卡住的学生最需要先知道自己哪里是对的。但不要编造 —— 只写他确实说了的。`;

/** 逐题拼装的 observe 用户提示（把图谱与错因清单喂进去，让定位有据可依） */
export function buildObserveUserPrompt({ problem, utterance, history }) {
  const graphOutline = problem.solutionGraphs
    .map(
      (g) => `路径【${g.name}】(id=${g.id})
  前提: ${g.preconditions.join(' / ')}
  步骤:
${g.steps.map((s) => `    ${s.index}. [${s.kind}] ${s.title} —— ${s.intent}`).join('\n')}`,
    )
    .join('\n');

  const misconceptionList = problem.misconceptions
    .map((m) => `  - id=${m.id} | ${m.label} | 学生典型说法: ${m.signature.join('、')}`)
    .join('\n');

  const historyText =
    history.length === 0
      ? '(本轮是学生第一次发言)'
      : history
          .map((t) => `${t.role === 'student' ? '学生' : 'AI'}${t.level != null ? `(L${t.level})` : ''}: ${t.text}`)
          .join('\n');

  return `【题目】${problem.stem}

【标准解题路径图谱（仅供你对齐位置，不要抄给学生）】
${graphOutline}

【已知的常见错因清单（只能从这里选 id）】
${misconceptionList}

【本轮之前的对话】
${historyText}

【学生本轮的原话】
${utterance}

请输出 JSON 观察结果。再次强调：不要出现任何数值结果和公式表达式。`;
}

/** draft 阶段的系统提示：把"只给提示"写成硬约束 + 反例 */
export const DRAFT_SYSTEM_PROMPT = `你是中学物理的引导型老师。你的任务是根据诊断结论，写出"恰好卡在指定层级"的一句提示。

【最高原则】
你是在帮学生自己想出来，不是替他想。学生看完你的话，必须还需要自己动脑才能往前走。

【层级定义 —— 你本轮被指定了唯一层级，越级即失败】
L0 结构化澄清：学生还没形成思路。你只能帮他把已知/目标/困惑说清楚，或反问一个开放式问题。不得含任何物理方向。
L1 条件追问：只提问，不指方向。问"某个规律的前提条件是什么""这个信息在力学里意味着什么"。
    反面例子（禁止）："你可以用动量定理" ← 这是 L2
    正面例子："题目特意说'匀速'，这个信息在力学里对应什么条件？"
L2 方向提示：指出该关注哪个量/哪个关系/哪个模块，但仍不给公式、不给量之间的关系式。
    正面例子："力的大小和电流有关，而电流又和速度有关，先想想这两个'有关'是怎么连起来的。"
L3 降级示范：示范一个"动作"——选研究对象、写守恒式左边、做一步代数变形。仍不得给出数值结果。
    正面例子："我们先只写左边：恒力的冲量该怎么写？右边是动量变化，你先写出这两项的符号形式。"

【绝对禁止（任何层级都不许出现）】
1. 不许出现本题的最终答案或其数值（包括"大约是0.4""接近1"这类）。
2. 不许给出待求量的完整表达式（如 v_max = F(R+r)/(B²L²)）。
3. 不许列出完整解题步骤序列（超过 2 步就违规）。
4. 不许出现"所以答案就是""最终结果""因此可得…"这类收口句式。

【输出格式】只输出一个 JSON：
{ "text": "提示正文（1~2 句，口语化，用'你'称呼学生）", "nextAsk": "建议学生接着做什么（一句话，必须是让他自己做的动作）", "concepts": ["用到的概念名"] }`;

export function buildDraftUserPrompt({ problem, diagnosis, level, allowedConcepts, forbidden, strategy }) {
  const step = findStep(problem, diagnosis.position);
  const prevTurns = diagnosis.trace.length;
  return `【题目】${problem.stem}

【学生当前状态（内部信息，不要复述给学生）】
- 已定位到：${step ? `路径「${diagnosis.position.graphId}」第 ${step.index} 步 —— ${step.title}` : '尚未定位到具体步骤'}
- 定位置信度：${diagnosis.position.confidence.toFixed(2)}
- 卡点性质：${diagnosis.stuckKind}
- 判定错因：${diagnosis.misconceptions.map((m) => m.label).join('；') || '（无明确错因，属于尚未想到）'}
- 学生不确定处：${diagnosis.evidenceQuotes.map((q) => clip(q, 60)).join(' / ') || '（无）'}

【本轮指定层级】L${level}
【本轮策略】${strategy}
【可以引用的概念白名单】${allowedConcepts.join('、') || '（无，请只做澄清）'}
【必须回避的内容】${forbidden.join('；') || '（无）'}
【该步的知识位置提示】这一步的"动作类型"是 ${step?.kind ?? 'unknown'}，涉及概念：${step?.concepts.join('、') ?? '无'}

（内部校验码 ${prevTurns}，不要写入输出）

请输出 JSON。`;
}

function findStep(problem, position) {
  if (!position.graphId || position.stepIndex == null) return null;
  const g = problem.solutionGraphs.find((x) => x.id === position.graphId);
  return g?.steps.find((s) => s.index === position.stepIndex) ?? null;
}

// ---------------------------------------------------------------------------
// 真模型适配器（OpenAI 兼容）
// ---------------------------------------------------------------------------

/** 从环境变量读配置；支持 .env 手动注入。 */
export function readLLMConfig(env = process.env) {
  const apiKey = env.LLM_API_KEY || env.OPENAI_API_KEY || '';
  const baseUrl = (env.LLM_BASE_URL || env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const model = env.LLM_MODEL || env.OPENAI_MODEL || 'deepseek-chat';
  const timeoutMs = Number(env.LLM_TIMEOUT_MS || 45000);
  return { apiKey, baseUrl, model, timeoutMs, available: Boolean(apiKey) };
}

/**
 * JSON 提取：模型偶尔会裹 markdown 代码块或加解释文字。
 * 这里做三级容错：直接 parse → 去代码块 → 括号配平截取。
 */
export function extractJson(raw) {
  const text = String(raw ?? '').trim();
  const attempts = [];
  attempts.push(text);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1].trim());
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) attempts.push(text.slice(firstBrace, lastBrace + 1));

  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      /* 继续尝试 */
    }
  }
  return null;
}

export function createOpenAIAdapter(config = readLLMConfig()) {
  if (!config.available) {
    throw new Error('createOpenAIAdapter 需要 apiKey；无 Key 时请使用 createOfflineAdapter()');
  }

  async function chat(system, user, { temperature = 0.2, maxTokens = 900 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          temperature,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`LLM 请求失败 ${res.status}: ${clip(body, 300)}`);
      }
      const data = await res.json();
      return data?.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kind: 'llm',
    model: config.model,
    config,

    async observeStudent(input) {
      const raw = await chat(OBSERVE_SYSTEM_PROMPT, buildObserveUserPrompt(input));
      const parsed = extractJson(raw);
      if (!parsed) throw new Error(`observe 阶段无法解析 JSON：${clip(raw, 200)}`);
      return normalizeObservation(parsed, input);
    },

    async draftHint(input) {
      const raw = await chat(DRAFT_SYSTEM_PROMPT, buildDraftUserPrompt(input), { temperature: 0.5 });
      const parsed = extractJson(raw);
      if (!parsed) throw new Error(`draft 阶段无法解析 JSON：${clip(raw, 200)}`);
      return typeof parsed === 'string' ? parsed : String(parsed.text ?? '');
    },
  };
}

/**
 * 观察结果归一化 —— 对抗模型的三类常见越界：
 *   ① 字段类型不对（数组给了字符串）② 编造 evidenceQuotes ③ 把答案写进 restatement
 */
export function normalizeObservation(parsed, input) {
  const asArray = (v) => {
    if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
    if (v == null || v === '') return [];
    return [String(v)];
  };
  const utterance = normalize(input.utterance);
  const quotes = asArray(parsed.evidenceQuotes).filter((q) => {
    // 强校验：证据必须能在学生原话里找到（允许归一化后匹配）
    const q2 = normalize(q);
    if (!q2) return false;
    if (utterance.includes(q2)) return true;
    // 容忍模型做了轻微改写：取前 6 个字做包含判断
    return q2.length >= 6 && utterance.includes(q2.slice(0, 6));
  });

  const stepIndexRaw = parsed.candidateStepIndex;
  const candidateStepIndex =
    stepIndexRaw == null || stepIndexRaw === '' || Number.isNaN(Number(stepIndexRaw))
      ? null
      : Number(stepIndexRaw);

  return {
    knowns: asArray(parsed.knowns),
    goal: parsed.goal ? String(parsed.goal) : null,
    laws: asArray(parsed.laws),
    reasoningChain: asArray(parsed.reasoningChain),
    uncertainties: asArray(parsed.uncertainties),
    stuckPoint: parsed.stuckPoint ? String(parsed.stuckPoint) : null,
    hasComputationTrace: Boolean(parsed.hasComputationTrace),
    candidateStepIndex,
    candidateMisconceptionIds: asArray(parsed.candidateMisconceptionIds).filter((id) =>
      input.problem.misconceptions.some((m) => m.id === id),
    ),
    evidenceQuotes: quotes,
    restatement: parsed.restatement ? String(parsed.restatement) : undefined,
    /**
     * 信息是否充足。真模型给什么就是什么；它没给时按"有没有实质内容"兜底推断。
     * 兜底逻辑必须保守：宁可判"不足"（走反问），也不要硬给一个编造的定位。
     */
    sufficientInfo:
      typeof parsed.sufficientInfo === 'boolean'
        ? parsed.sufficientInfo
        : Boolean(
            asArray(parsed.reasoningChain).length > 0 ||
              asArray(parsed.laws).length > 0 ||
              asArray(parsed.knowns).length > 0 ||
              (parsed.stuckPoint != null && String(parsed.stuckPoint).trim() !== ''),
          ),
    probeQuestion: parsed.probeQuestion ? String(parsed.probeQuestion) : null,
    /** 真模型不返回路径 id，保持 null；离线桩会填上，下游优先采信 */
    _locatedGraph: null,
  };
}

// ---------------------------------------------------------------------------
// 离线规则桩
// ---------------------------------------------------------------------------

/**
 * 离线桩的定位策略：两遍扫描。
 *   第一遍：按标准步骤的 cues 做关键词命中，取命中且序号最大的那一步（学生通常推进到最远处）。
 *   第二遍：用错因 signature 做匹配，归类错因。
 * 它还负责产出 evidenceQuotes —— 从学生原话里摘取命中的片段。
 *
 * 已知局限（写在文档里，避免误导）：
 *   规则桩无法处理"学生用完全不同的话表达了同一个意思"，
 *   这正是接真模型后要提升的部分。所以离线模式的价值是"验证护栏与流程"，
 *   而不是"验证理解能力"。
 */
export function createOfflineAdapter() {
  return {
    kind: 'offline-stub',
    model: undefined,

    async observeStudent({ problem, utterance, history }) {
      const text = canonicalize(utterance);
      const raw = normalize(utterance);
      /** 命中的路径（由定位通道直接给出，避免下游再猜） */
      let locatedGraph = null;

      // ---- 定位：关键词通道 ----
      let candidateStepIndex = null;
      let bestScore = 0;
      const stepHits = [];
      for (const g of problem.solutionGraphs) {
        for (const s of g.steps) {
          const hits = matchAll(text, s.cues ?? []);
          stepHits.push({ graphId: g.id, stepIndex: s.index, hits });
          // 打分原则：命中数绝对优先，步骤序号只做"极小权重"的平局打破。
          // 早期版本写成 `hits*100 + stepIndex`，导致"1 个命中但步骤号大"会压过
          // "1 个命中但步骤号小"（差 4 分），把学生定位到错误的步骤上。
          const score = hits.length * 100 + s.index * 0.01;
          if (hits.length > 0 && score > bestScore) {
            bestScore = score;
            candidateStepIndex = s.index;
            locatedGraph = g.id;
          }
        }
      }

      // ---- 错因归类 ----
      // 注意：这里必须用 matchSignatures（允许修饰语隔开的共现匹配），
      // 不能用朴素的连续子串匹配 —— 中文里"安培力应该向右"匹配不上"安培力向右"。
      const candidateMisconceptionIds = [];
      const evidenceQuotes = [];
      for (const m of problem.misconceptions) {
        const hits = matchSignatures(text, m.signature);
        if (hits.length > 0) {
          candidateMisconceptionIds.push(m.id);
          evidenceQuotes.push(...hits.slice(0, 2));
        }
      }

      // ---- 不确定性 / 卡点识别 ----
      const uncertaintyCues = ['不知道', '不确定', '猜', '可能', '好像', '是不是', '搞不清', '忘了', '不会'];
      const uncertainties = matchAll(raw, uncertaintyCues);
      const stuckCues = ['卡住', '卡在', '做不下去', '停在这', '然后呢', '接下来不会', '想不出来'];
      const stuckHits = matchAll(raw, stuckCues);

      // ---- 推理链切分：按连接词与句子边界粗切 ----
      const reasoningChain = raw
        .split(/[。；;\n]|然后|接着|所以|因此|之后/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2)
        .slice(0, 8);

      // ---- 已知 / 目标 / 规律 ----
      const knowns = problem.givens.filter((g) => containsAny(text, [g.split(' ')[0]]));
      const goalCues = problem.asked.filter((a) => containsAny(text, [a.replace(/[（(].*?[)）]/g, '').trim()]));
      const lawVocab = [
        '法拉第',
        '欧姆定律',
        '安培力',
        '楞次',
        '牛顿第二定律',
        '动量定理',
        '能量守恒',
        '动能定理',
        '焦耳定律',
        '左手定则',
        '基尔霍夫',
        '受力平衡',
        '平衡',
        '右手定则',
      ];
      const laws = matchAll(text, lawVocab);

      const hasComputationTrace = /[0-9]\s*[×x*+\-/=＝]|[=＝]\s*[0-9]/.test(raw);

      const quotePool = [...new Set([...evidenceQuotes, ...uncertainties, ...stuckHits, ...laws])].filter(Boolean);

      return {
        knowns,
        goal: goalCues.length ? goalCues.join('、') : null,
        laws,
        reasoningChain,
        uncertainties: uncertainties.length ? uncertainties : [],
        stuckPoint: stuckHits.length ? stuckHits[0] : null,
        hasComputationTrace,
        candidateStepIndex,
        candidateMisconceptionIds,
        evidenceQuotes: quotePool.length ? quotePool.slice(0, 5) : [],
        restatement: undefined,
        _locatedGraph: locatedGraph,
        _stepHits: stepHits,
      };
    },

    /**
     * 离线起草：不"写话"，而是从**当前步骤自身的概念与前提**里派生提示。
     *
     * 为什么必须"从步骤派生"而不能用一套通用话术：
     *   早期版本 L2 硬编码了"缺一个能跨时间累积的量，想想哪个定理"。
     *   结果在"漏内阻"这道题上，AI 对着一个电路问题聊起了动量定理 ——
     *   学生一眼就能看出 AI 没看懂题，产品可信度直接归零。
     *   这是实测抓到的真实事故，已固化为断言（见 test/engine.test.js 的"话题相关性"）。
     *
     * 返回形状必须与真模型一致：**JSON 字符串**。
     */
    async draftHint({ problem, diagnosis, level, allowedConcepts, history = [], l3Count = 0 }) {
      const step = findStep(problem, diagnosis.position);
      const graph = problem.solutionGraphs.find((g) => g.id === diagnosis.position.graphId);
      const concept = allowedConcepts[0] ?? step?.concepts[0] ?? '这一步';
      const seedMis = problem.misconceptions.find((m) =>
        diagnosis.misconceptions.some((x) => x.id === m.id),
      );
      const seeds = seedMis?.hintSeeds ?? [];
      /** 该步涉及、但当前未被点名的量：方向提示的天然素材 */
      const openConcepts = (step?.concepts ?? []).filter((c) => c !== concept);
      const preconditions = graph?.preconditions ?? [];

      // 变量选择：以"该步骤上已给出的 AI 轮次"为轮换依据
      const priorAiTurns = history.filter((t) => t.role === 'ai').length;
      const stepTurns = history.filter(
        (t) => t.role === 'ai' && t.metaStep === diagnosis.position.stepIndex,
      ).length;
      const rotate = (arr, idx) => arr[(idx + arr.length) % arr.length];

      let payload;
      if (level === 0) {
        payload = rotate(
          [
            {
              text: '我先确认一下：你现在手上有哪些已知条件？要求的是什么？把这两点说出来，我们就知道该往哪想了。',
              nextAsk: '把题目给的已知量和你要求的目标各说一遍。',
              concepts: [],
            },
            {
              text: '不用急着算。你先用一句话告诉我：这道题在问什么？你觉得它和哪个物理过程有关？',
              nextAsk: '用一句话说明这道题在问什么。',
              concepts: [],
            },
          ],
          stepTurns,
        );
      } else if (level === 1) {
        const variants = [
          {
            text: seeds[0] ?? '你说的这个规律，它成立需要满足什么前提？题目里的条件都满足了吗？',
            nextAsk: '检查一下这个规律的前提条件，然后告诉我哪一条最值得怀疑。',
            concepts: allowedConcepts.slice(0, 2),
          },
          {
            text:
              seeds[1] ??
              (preconditions.length
                ? `这一步用的关系要成立，前提里有一条是「${preconditions[0]}」。题目给的条件满足它吗？`
                : '题目里给的条件，你都用上了吗？有没有哪一条看起来"用不上"、其实正好是某个规律的前提？'),
            nextAsk: '把题干条件逐条列出，标出哪一条还没用上。',
            concepts: allowedConcepts.slice(0, 2),
          },
          {
            text: `你先别写式子。你打算用的这个规律，在这个题目的情境里，它成立吗？先说"成立"或"不成立"，再说理由。`,
            nextAsk: '判断这个规律在本题是否成立，并给出理由。',
            concepts: allowedConcepts.slice(0, 2),
          },
        ];
        payload = rotate(variants, priorAiTurns);
      } else if (level === 2) {
        /**
         * 方向提示：只指出"该关注哪两个量之间的关系"，绝不给出关系式。
         *
         * 两个变体的分工：
         *   变体1 顺着学生当前的规律往下指（他快通了，只差一个连接）
         *   变体2 提示"换个工具"（他当前这条路走不通了）
         * 用 step.kind 决定优先给哪个 —— 停在 precondition/identify 这类
         * "选择工具"的步骤上时，换工具的提示更有用。
         */
        const other = openConcepts[0] ?? '题目里的另一个条件';
        const switchToolVariant = {
          text: `换个角度看：你现在这条路上的未知量，靠你已经选的那个规律能全部定下来吗？如果定不下来，说明缺的是一个"能建立新关系"的工具，而不是算术。想想哪个定理天生适合处理"一段时间内累积的量"。`,
          nextAsk: '判断当前规律能否定下所有未知量；不能的话，说出缺的是哪一类工具。',
          concepts: allowedConcepts.slice(0, 3),
        };
        const connectVariant = {
          text: `方向给你一点：这一步的关键不在${concept}本身，而在${concept}和「${other}」之间是怎么互相影响的。先把这条影响链说清楚，不要急着代公式。`,
          nextAsk: `用一句话说出「${concept}」与「${other}」之间的联系。`,
          concepts: allowedConcepts.slice(0, 3),
        };
        const considerVariant = {
          text: `换个角度看：你把「${other}」也一起考虑进来了吗？这一步之所以卡住，往往是因为只盯着${concept}，而忽略了它对${other}的影响。`,
          nextAsk: `说明「${other}」在这一步起了什么作用。`,
          concepts: allowedConcepts.slice(0, 3),
        };
        // 在"选择规律/检查前提"类步骤上，或学生已明确表示这条路走不通时，
        // 优先给"换工具"的方向 —— 对一个已经在死胡同里的学生，
        // 顺着原路继续指（"你考虑恒力做功了吗"）是无效帮助。
        const preferSwitch =
          ['identify', 'precondition', 'setup'].includes(step?.kind) || diagnosis.stuckKind === 'dead_end_path';
        payload = rotate(
          preferSwitch ? [switchToolVariant, connectVariant, considerVariant] : [connectVariant, considerVariant, switchToolVariant],
          stepTurns,
        );
      } else {
        /**
         * L3 降级示范：只示范一个"动作"，不含任何数值。
         *
         * 关键：示范的动作必须匹配**这一步在做什么**（step.kind），否则会出现
         * "学生在算电流，AI 却让他列受力"这种明显错位。
         * 这是第二次踩同一个坑（第一次是 L2 硬编码动量定理话术），
         * 所以这里按 kind 分派，而不是用一套固定话术。
         */
        const other = openConcepts[0] ?? '相关的量';
        const byKind = {
          // 建模 / 识别规律：示范"怎么把研究对象和条件摆出来"
          setup: [
            {
              text: `我示范一个动作，你接着做：先把这道题的回路（或研究对象）画出来，在图上标出每个量的名字，不写数值。标完告诉我：哪一部分是提供能量的、哪一部分是消耗能量的。`,
              nextAsk: '把回路/研究对象画出来并标出各量的名字，指出能量从哪里来到哪里去。',
              concepts: allowedConcepts.slice(0, 3),
            },
          ],
          identify: [
            {
              text: `我示范一个动作，你接着做：先不选公式。你把题目里"发生了什么过程"用一句话写下来（比如"某个量在某个范围内发生了变化"），写完我们再决定用哪个规律。`,
              nextAsk: '用一句话描述题目里的物理过程。',
              concepts: allowedConcepts.slice(0, 3),
            },
          ],
          // 前提检查：示范"把前提逐条写出来再对照条件"
          precondition: [
            {
              text: `我示范一个动作，你接着做：把你要用的这条关系成立所需要的条件，逐条写成清单（只写条件，不写公式），然后再把题干的每个条件对上去，看哪一条没对上。`,
              nextAsk: '写出该关系成立的条件清单，并逐条对照题干条件。',
              concepts: allowedConcepts.slice(0, 3),
            },
          ],
          // 套用公式：示范"只写式子左边，右边留空"
          apply: [
            {
              text: `我示范一个动作，你接着做：把这一步要用的关系式的左边先写出来，右边留空。只写左边这一个动作，写完告诉我右边应该放哪个量。`,
              nextAsk: '只写出关系式的左边，并说明右边应该放哪个量。',
              concepts: allowedConcepts.slice(0, 3),
            },
            {
              text: `我示范一个动作，你接着做：先把你手上已有的量列成两列——"题目给的"和"我要用的"。列完之后圈出还缺的那一个，那才是这一步真正要解决的。`,
              nextAsk: '列出"已知的量"和"要用的量"两列，圈出还缺的那个。',
              concepts: allowedConcepts.slice(0, 3),
            },
          ],
          // 代数推导：示范"把符号关系写成一条链"
          derive: [
            {
              text: `我示范一个动作，你接着做：先不代数值，只用文字写出「${concept} → ${other} → 结果」这条影响链，写三步就够。`,
              nextAsk: '用文字写出三步影响链（谁变 → 影响谁 → 再影响谁）。',
              concepts: allowedConcepts.slice(0, 3),
            },
          ],
          interpret: [
            {
              text: `我示范一个动作，你接着做：先不看数字，用一句话回答"这一步算出来的量在物理上代表什么"。说不清楚就说明式子还没选对。`,
              nextAsk: '用一句话说明这一步求出的量在物理上的含义。',
              concepts: allowedConcepts.slice(0, 3),
            },
          ],
          conclude: [
            {
              text: `我示范一个动作，你接着做：把前面每一步得到的量按顺序列出来，检查单位对不对。数值计算留给你自己完成。`,
              nextAsk: '按顺序列出每一步得到的量并检查单位。',
              concepts: allowedConcepts.slice(0, 3),
            },
          ],
        };
        const pool = byKind[step?.kind] ?? [
          {
            text: `我示范一个动作，你接着做：先只把研究对象单独拎出来，按方向逐一列出它受到的各个力或参与的量（只写方向和名字，不写数值）。`,
            nextAsk: '列出研究对象涉及的量（只写名字和方向）。',
            concepts: allowedConcepts.slice(0, 3),
          },
        ];
        payload = rotate(pool, l3Count);
      }
      return JSON.stringify(payload);
    },
  };
}

/** 工厂：按环境自动选择适配器（无 Key 静默降级，保证 Demo 永远能开） */
export function createAdapter(env = process.env) {
  const config = readLLMConfig(env);
  if (config.available) {
    try {
      return createOpenAIAdapter(config);
    } catch (err) {
      console.warn(`[llm] 真模型初始化失败，降级到离线桩：${err.message}`);
    }
  }
  return createOfflineAdapter();
}
