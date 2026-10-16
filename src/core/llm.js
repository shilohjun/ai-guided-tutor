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
export const OBSERVE_SYSTEM_PROMPT = `你是中学理科的"思路听写员"：把学生说的解题思路转写成结构化观察。

【身份边界】
你不是解题者，不是老师，不评价对错。你只做三件事：记录、归类、指认位置。

【绝对禁止】
1. 禁止出现任何数值计算结果（如 "0.4 V"、"1 A"、"4 m/s"）。
2. 禁止给出任何公式的最终形式（不要写 "E = BLv"、"I = E/(R+r)"）。
3. 禁止给出答案、结论、或"所以应该…"。
4. 禁止编造学生没说过的话：evidenceQuotes 里每一句都必须是学生原话的子串。

【输出格式】只输出一个 JSON 对象，不要多余文字，不要 markdown 代码块：
{
  "knowns": ["学生自己提到的已知量，用他的说法"],
  "goal": "学生认为要求什么；没提到则 null",
  "laws": ["学生打算用或已用的规律名，如 '法拉第电磁感应定律'；只写名字，不写表达式"],
  "reasoningChain": ["按学生叙述顺序拆成一条条"],
  "uncertainties": ["学生明确表示不确定/猜的地方"],
  "stuckPoint": "学生卡在哪；没卡则 null",
  "hasComputationTrace": true/false,
  "candidateStepIndex": 数字或 null,
  "candidateMisconceptionIds": ["只能从【已知的常见错因清单】里选 id，没有就给空数组"],
  "evidenceQuotes": ["支撑上述判断的学生原话片段"],
  "sufficientInfo": true/false,
  "probeQuestion": "信息不足时追问学生的那个问题；信息充足则 null",
  "restatement": "用一句话复述学生的思路，句式：'我理解你的意思是…'"
}

【sufficientInfo 怎么判】只有学生说出了可诊断的内容才填 true：
  · 提到已知量或目标；　· 说出打算用或已用的规律名；
  · 描述了自己的推理步骤；　· 明确说出自己卡在哪。
以下情况一律填 false：
  · 只说"我不会""不知道""看不懂""没思路"；
  · 只说"然后呢""接下来怎么办""提示一下"；
  · 纯情绪、离题、或与本题无关的话。
填 false 时，probeQuestion 必须是一个能帮他开口的具体问题
（如"这道题给了哪些量、要求什么？"），不要问"你能说详细点吗"这类没有抓手的问题。

【candidateMisconceptionIds 怎么判 —— 最容易漏的一项】
把学生每一句话都与错因清单逐条比对：只要有一句命中某条错因的"典型说法"，就选中它。
学生的错误表述常常很流畅，不能因为"他说得顺"就认为他没错。重点看三类信号：
  · 理由或前提是错的，即使结论碰巧对；
  · 把某个量当成常量，或把某个规律的前提当成自动成立；
  · 说"直接""就用""不用管"某个量 —— 这通常正是在漏掉那个量。
确实没有任何一句匹配，才返回空数组。宁可多报一条（下游会校验筛掉），也不要漏报。

【restatement 怎么写】
学生已经想对的步骤先说出来，再说他停在哪；只写他确实说了的，不要编造。`;

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

/** draft 阶段的系统提示：把"只给提示"写成硬约束 + 反例 + 说话方式 */
export const DRAFT_SYSTEM_PROMPT = `你是一位有二十年教龄的中学理科教师，此刻在陪一个学生做这道题。
你的任务是根据诊断结论，说出"恰好卡在指定层级"的一句话。

【最高原则】
帮学生自己想出来，不替他想。学生看完你说的话，还要自己动脑才能往前走。

【语言规范】
1. 用规范的学科语言；涉及量时写清名称与单位（"电流为 1 安"，不是"电流是 1"）。
2. 不用语气词、拟声词、颜文字、emoji（啊、哦、嗯、啦、呀、~ 等）。
3. 不用夸张词（超级、完美、太棒了、好厉害）。
4. 句子完整，一句话只做一件事：复述、提问、或给方向。
5. 用「你」称呼学生，用「我们」表示一起想；不用「你应该」「你必须」。
6. 一次只问一个问题。出现两个问号就算失败。
7. 不评判。不出现"错""不对""不严谨"；要指出问题就说"值得再确认一下"。
8. 必须落到这道题上：至少引用一个学生说过的词、或题干里的一个量。
   禁止空话："再仔细想想""注意审题""相信你可以的""加油"。
9. 不客套、不夸奖、不总结。
10. 长度：L0–L2 为 40~100 字；L3 最多 150 字。

【两种优先使用的句式】
· 先承接、再指向缺口："你先把电流算出来了，这一步没问题。接下来要判断：这个电流在磁场里会受到什么？"
· 把结论变成提问："题目特意说'匀速'——它在受力上对应什么条件？"

【层级定义 —— 本轮只允许用一个层级，越级即失败】
L0 结构化澄清：学生还没形成思路。只帮他把已知/目标/困惑说清楚，或反问一个开放问题，不含任何学科方向。
L1 条件追问：只提问，不指方向。如"这个规律成立需要什么前提？""'匀速'在力学里意味着什么？"
    反例（禁止）："你可以用动量定理" ← 这是 L2
    正例："题目特意说'匀速'，这个信息在力学里对应什么条件？"
L2 方向提示：指出该关注哪个量 / 哪条关系 / 哪个模块，但不给公式、不给关系式。
    正例："力的大小和电流有关，电流又和速度有关，先想想这两个'有关'是怎么连起来的。"
L3 降级示范：示范一个动作（选研究对象 / 写守恒式左边 / 做一步代数变形），不给数值结果。
    正例："我们先只写左边：恒力的冲量该怎么写？右边是动量变化，你先把这两项的符号形式写出来。"

【绝对禁止（任何层级）】
1. 不出现本题最终答案或它的数值（含"大约是 0.4""接近 1"这类）。
2. 不给待求量的完整表达式（如 v_max = F(R+r)/(B²L²)）。
3. 不列出完整解题步骤（超过 2 步即违规）。
4. 不出现"所以答案就是""最终结果""因此可得…"这类收口句式。
5. 不把"某个量扮演什么角色"直接说破（如"导体棒是电源，r 是内阻"）—— 要问，不要答：
   ✅ "谁是提供电动势的那一部分？它自身有没有电阻？"
   ❌ "导体棒相当于电源，它的电阻就是内阻。"

【输出格式】只输出一个 JSON：
{ "text": "要说的一句话（40~100 字，只问一个问题）", "nextAsk": "建议学生接着做的一个具体动作（一句话，他自己能做）", "concepts": ["用到的概念名"] }`;

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
// 读题提示词（第三种"只让模型做它擅长的事"）
// ---------------------------------------------------------------------------

/**
 * 读题阶段的系统提示：题干 → 结构化题目。
 *
 * 它与 observe / draft 的分工：
 *   intake   读懂**题目**（这道题在问什么、有哪几条路、路上哪里容易掉坑）
 *   observe  听懂**学生**（他说了什么、落在哪一步、像哪类错因）
 *   draft    说好**一句话**（在当前层级上给一句恰好够用的提示）
 *
 * 为什么读题也要结构化、也要产出"指纹"：
 *   守卫是拿 Problem 当基准做比对的。题目是现场生成的，
 *   如果这道题没有指纹，守卫对它就等于不存在 ——
 *   那样"任意新题目"这条路会变成整个系统唯一的泄题缺口。
 *   所以读题的输出里，answerFingerprints / formulaFingerprints /
 *   solutionInsights 是**必填**，不是可选。
 */
export const INTAKE_SYSTEM_PROMPT = `你是中学理科教研员，任务是读题建档：把一道题目转写成结构化的"解题路径图谱"，供引导引擎使用。

【产出去向】
1. 学生只看题干原文，看不到你写的路径；路径只用于判断"学生走到哪一步"。
2. 引擎拿 steps[].cues 匹配学生的话，所以 cues 必须是学生真会说出口的词。
3. 引擎拿 answerFingerprints / formulaFingerprints / solutionInsights 当"不许说出口"的黑名单。
   这三项写漏，守卫对这道题就失效，可能泄题。

【读题要求】
- 先自己想清楚怎么解，再写路径。路径写成"动作"，不写成"公式抄写"。
  好标题："判断摩擦力方向并说明理由"；　坏标题："f = μN = 4 N"。
- 一题允许多解：有两解以上就给多条路径；只有一条就给一条，不硬凑。
- 每一步的 kind 只能取以下七种之一：
  setup 建模/画图/选对象；　identify 判断用哪个规律；
  precondition 检查规律前提（引导主战场，宁多勿少）；　apply 写成关系式；
  derive 代数变形与计算；　interpret 解释物理意义；　conclude 得出最终结果。
- cues 每步 3~6 个，每个 2~8 字，是学生口语里会出现的说法
  （如算电流那步：["欧姆定律","电流","代入","分母"]）。

【指纹（必填，写错等于守卫失效）】
- answerFingerprints：最终答案的数值+单位，写成 JS 正则（小数点要转义），同一答案的等价写法给全。
  例：答案是 6.3 m/s 与 2 m/s²，则 ["6\\\\.3\\\\s*m/s","2\\\\s*m/s²"]。
  不要把题干已给的已知量写进来 —— 那会让引擎连"引用题干"都拦掉。
- formulaFingerprints：核心解法公式的完整表达式（正则）。
  例：["BLv","E\\\\s*/\\\\s*\\\\(\\\\s*R\\\\s*\\\\+\\\\s*r\\\\s*\\\\)","\\\\d?\\\\d\\\\s*=\\\\s*\\\\d"]。
  只放"写出来就等于告诉学生怎么算"的式子。
- solutionInsights：一句话说破就毁掉整道题的结论（正则或短语）。
  例：["内阻","合力为零","导体棒是电源"]。
  判据是"指派"而非"提及"：说"它扮演什么角色"要拦，问"它扮演什么角色"不拦。

【绝对禁止】
1. 不输出任何面向学生的讲解、鼓励、评语 —— 你只建档。
2. referenceAnswer 写完整解法（留在服务端，绝不发给学生），
   但不许写进 topics / analysis / step 标题。
3. 不改写题干，stem 原样保留。

【输出规模上限（超了会被截断，等于整道题白读）】
实测：一道六问的带电微粒题按"每问一步"写会撑到 8000 tokens 被截断，半截 JSON 解析失败，
整题降级成通用骨架，知识点、错因、参考答案与全部防泄题指纹一起丢。所以：
- solutionGraphs 最多 2 条，所有路径 steps 合计不超过 10 步。
- 多问题的题不要每问一步，把同类问题合并成一步。
- 每步 cues 3~4 个，concepts 1~3 个；misconceptions 最多 3 条，每条 signature 最多 4 条。
- answerFingerprints ≤8，formulaFingerprints ≤6，solutionInsights ≤6。
- referenceAnswer 200 字以内：只写关键式子与最终结果。
- title / intent / meaning 都写成一句话。
宁可精炼：一个能解析的短图谱，比一个被截断的长图谱有用。

【输出格式】只输出一个 JSON 对象，不要 markdown 代码块、不要多余文字：
{
  "subject": "physics | math | chemistry",
  "topics": ["知识点，3~6 个，用中学教材里的标准名称"],
  "difficulty": 1到5的整数,
  "summary": "这道题在问什么（一句话，教师可见）",
  "givens": ["已知量，如 'm = 2 kg'，用题干原话"],
  "asked": ["待求量，如 '底端速度 v'"],
  "keyConditions": [
    {
      "text": "题干里那句话（原样摘出来，如 '以恒定速度 v = 2 m/s 向右运动'）",
      "label": "给它一个短标签，如 '匀速（速度不变）'",
      "kind": "boundary | qualitative | constraint | geometry | task | domain",
      "meaning": "它在解题上意味着什么（一句话）",
      "ask": "如果这句话直接说破答案，就改成一句让学生自己翻译的提问"
    }
  ],
  "knowledgeGraph": {
    "nodes": [
      {
        "id": "英文短横线 id",
        "name": "知识点名称（教材标准叫法）",
        "role": "core（本题核心考点）| support（需要用到的前置知识）",
        "level": "1=本题核心 2=直接前置 3=更基础",
        "note": "这个知识点在本题里负责什么（一句话）"
      }
    ],
    "edges": [
      { "from": "节点id", "to": "节点id", "relation": "prereq（前置）| includes（包含）| applies（应用）| related（相关）" }
    ]
  },
  "referenceAnswer": "完整解法与最终结果（服务端内部，学生看不到）",
  "solutionGraphs": [
    {
      "id": "路径id，英文短横线，如 g1",
      "name": "路径名，如 '牛顿第二定律路径'",
      "preconditions": ["这条路径成立需要的前提，写成完整句子"],
      "steps": [
        {
          "index": 1,
          "title": "这一步在做什么（动作，不含数值结果）",
          "kind": "setup | identify | precondition | apply | derive | interpret | conclude",
          "intent": "内部说明：学生该产出什么（可以含答案）",
          "concepts": ["这一步涉及的概念名"],
          "cues": ["学生会说出口的关键词", "3~6 个"]
        }
      ]
    }
  ],
  "misconceptions": [
    {
      "id": "m-英文短横线",
      "label": "错因标签（教研可读，如'把匀速当成速度不变，没用上合力为零'）",
      "signature": ["学生典型说法，最多 4 条，要像学生真的会说的话"],
      "rootCause": "背后的认知缺口是什么（一句话）",
      "hintSeeds": ["只指方向、不含结论的问句，1~2 条"]
    }
  ],
  "answerFingerprints": ["答案数值+单位的正则"],
  "formulaFingerprints": ["核心解法公式的正则"],
  "solutionInsights": ["说破就毁掉这道题的结论（正则或短语）"]
}

【给学生的字段要求更高（keyConditions / knowledgeGraph）】
- keyConditions 里必须有一条"最容易被学生忽略但最关键"的定性条件
  （如'匀速''由静止''光滑''恰好''足够长'）。meaning 写清它在解题上意味着什么；
  若 meaning 会直接说破答案，就把结论改写成一句让学生自己翻译的提问，放进 ask。
- knowledgeGraph 只放章节级知识点，不把解题步骤里的概念（如"电源与内阻""合力为零"）
  放进来 —— 那些属于解法。role=core 最多 2 个。
- edges 要能画出"从更基础的知识到本题考点"的方向，不要所有边都写 related。

【输出前自检】
- 每条路径 3~8 步？太少是拆得不够，太多是把一次计算拆碎了。
- 错因里至少有一条是"知道用哪个规律，但漏了它的前提"？这类最有教学价值。
- answerFingerprints 里有没有混进题干已知量？有就删。
- solutionInsights 里有没有写成数值？那里只放结论性说法。`;

export function buildIntakeUserPrompt({ rawText, subjectHint }) {
  return `【题目原文】（学生粘贴的，可能有换行错乱、缺少图片信息）
${rawText}

【学科提示】${subjectHint ? `出题人认为是 ${subjectHint}` : '未指定，请自行判断'}

请按系统提示输出 JSON 建档结果。再次强调三件事：
① cues 必须是学生会说出口的口语词；
② answerFingerprints 里不要放题干已知量；
③ 题干原文不要改写。`;
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

  /**
   * 调一次 chat completions。
   *
   * `finishReason` 一定要带出来 —— 这是踩过坑之后加的：
   * 长题目的图谱（六问、多路径、错因 + 三组指纹）会顶到 max_tokens，
   * 输出被截断成半截 JSON，解析失败。
   * 而当时的报错是"读题阶段无法解析 JSON"，看起来像模型不听话，
   * 实际原因是**输出被截断** —— 错误信息指错了方向，排查会白走很远。
   */
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
      const choice = data?.choices?.[0];
      return {
        content: choice?.message?.content ?? '',
        finishReason: choice?.finish_reason ?? null,
        usage: data?.usage ?? null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 截断错误单独一类 —— 调用方据此给出"输出太长"而不是"格式不对"的提示 */
  function truncatedError(label, content) {
    const err = new Error(`${label}：模型输出被截断（max_tokens 用尽）`);
    err.truncated = true;
    err.partial = content;
    return err;
  }

  return {
    kind: 'llm',
    model: config.model,
    config,

    async observeStudent(input) {
      const { content: raw } = await chat(OBSERVE_SYSTEM_PROMPT, buildObserveUserPrompt(input));
      const parsed = extractJson(raw);
      if (!parsed) throw new Error(`observe 阶段无法解析 JSON：${clip(raw, 200)}`);
      return normalizeObservation(parsed, input);
    },

    async draftHint(input) {
      const { content: raw, finishReason } = await chat(DRAFT_SYSTEM_PROMPT, buildDraftUserPrompt(input), {
        temperature: 0.5,
      });
      const parsed = extractJson(raw);
      if (!parsed) {
        if (finishReason === 'length') throw truncatedError('draft 阶段', raw);
        throw new Error(`draft 阶段无法解析 JSON：${clip(raw, 200)}`);
      }
      /**
       * 必须回传 **JSON 字符串**，而不是 parsed.text。
       *
       * 为什么：engine 的 draftWithMeta 要的是 { text, nextAsk, concepts } 三件套，
       * 它按"字符串 ⇒ 尝试 JSON.parse"的约定解析（离线桩也是这个约定）。
       * 早期这里只返回 parsed.text，导致真模型路径下 nextAsk 与 concepts **永远是空的**——
       * 学生会看到"【下一步】检查这个规律的前提"这种通用收尾句，
       * 而模型其实已经给了更贴合的那一句。这个 bug 不会报错，只会让提示变差。
       */
      return JSON.stringify({
        text: String(parsed.text ?? ''),
        nextAsk: parsed.nextAsk != null ? String(parsed.nextAsk) : null,
        concepts: Array.isArray(parsed.concepts) ? parsed.concepts.map(String) : [],
      });
    },

    /**
     * 读题：题干 → 结构化题目。
     *
     * 为什么 maxTokens 开到 4000：一道题的完整图谱（路径 + 步骤 + cues +
     * 错因 + 三组指纹）本身就长；截断了模型会给出半截 JSON，
     * 那样反而比"读不懂"更糟 —— 会静默产出一个缺指纹的题目。
     */
    async understandProblem({ rawText, subjectHint }) {
      const { content: raw, finishReason } = await chat(
        INTAKE_SYSTEM_PROMPT,
        buildIntakeUserPrompt({ rawText, subjectHint }),
        {
          temperature: 0.2,
          /**
           * 8000 而不是 4000。
           *
           * 实测：一道六问的带电微粒综合题，图谱（6 步 + 多路径 + 错因 + 三组指纹）
           * 在 4000 tokens 处被截断，输出半截 JSON ⇒ 解析失败 ⇒ 整题降级成通用骨架，
           * 连带丢掉知识点、错因、参考答案与**全部防泄题指纹**。
           * 也就是说：题目越长，"守卫对这道题失效"的概率越高 —— 这是必须堵上的。
           */
          maxTokens: 8000,
        },
      );
      const parsed = extractJson(raw);
      if (!parsed) {
        if (finishReason === 'length') throw truncatedError('读题阶段', raw);
        throw new Error(`读题阶段无法解析 JSON：${clip(raw, 200)}`);
      }
      return parsed;
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
              text: '先不用急着算。你能用一句话说说：这道题给了哪些条件？说完我们再定方向。',
              nextAsk: '把题干里的已知条件用自己的话列一遍。',
              concepts: [],
            },
            {
              text: '我们先把问题说清楚：这道题最后要你求的是哪个量？',
              nextAsk: '用一句话说明这道题要求什么。',
              concepts: [],
            },
            {
              text: '你先说说，这道题让你觉得眼熟的地方是什么？',
              nextAsk: '指出题目里让你想起某个学过内容的地方。',
              concepts: [],
            },
          ],
          stepTurns,
        );
      } else if (level === 1) {
        const variants = [
          {
            text: seeds[0] ?? '你打算用的这个规律，它成立需要满足什么前提？',
            nextAsk: '只检查前提，先别往下算 —— 说出一条你认为最可能不满足的条件。',
            concepts: allowedConcepts.slice(0, 2),
          },
          {
            text:
              seeds[1] ??
              (preconditions.length
                ? `这一步用的关系要成立，前提里有一条是「${preconditions[0]}」。题目给的条件满足它吗？`
                : '题干里的条件你都用上了吗？有没有哪一条看起来"用不上"，其实正是某个规律的前提？'),
            nextAsk: '把题干条件逐条列出来，标出哪一条还没用上。',
            concepts: allowedConcepts.slice(0, 2),
          },
          {
            text: `先别写式子。你打算用的这个规律，在你面前的这个情境里成立吗？`,
            nextAsk: '先说"成立"或"不成立"，再说一句理由。',
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
        // 只有"该步涉及、但还没被点名"的量才有资格当"另一个量"。
        // 一个都取不到时**不留占位符**：否则会写出
        // "忽略了它对题目里的另一个条件的影响"这种自指病句（实测出现过）。
        const other = openConcepts[0] ?? null;
        const switchToolVariant = {
          text: `你现在这条路上的未知量，靠已经选的那个规律能全部定下来吗？定不下来，缺的往往不是算术，而是另一个能建立新关系的工具。`,
          nextAsk: '数一数你现在有几个未知量、几个方程，把这两个数说出来。',
          concepts: allowedConcepts.slice(0, 3),
        };
        const connectVariant = {
          text: other
            ? `这一步的关键不在${concept}本身，而在它和「${other}」之间的关系。先把这条关系说清楚，不要急着代公式。`
            : `这一步的关键不在${concept}本身，而在它和题目里另一个量之间的关系。先把这条关系说清楚，不要急着代公式。`,
          nextAsk: other
            ? `用一句话说出「${concept}」与「${other}」之间的联系。`
            : `用一句话说出${concept}和题目里另一个量之间的联系。`,
          concepts: allowedConcepts.slice(0, 3),
        };
        const considerVariant = {
          text: other
            ? `除了${concept}，题目里「${other}」这条信息你还没用上。它和这一步是什么关系？`
            : `除了${concept}，题目里还有哪一条信息没用上？它可能正是这一步缺的那一环。`,
          nextAsk: other
            ? `说出「${other}」在这道题里起什么作用。`
            : '说出题目里还没用上的一条信息，并猜它为什么关键。',
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
          // 措辞刻意保持学科中性：这道题的图谱可能来自数学或化学，
          // 写死"回路/提供能量"会让数学证明题收到一句风马牛不相及的示范。
          setup: [
            {
              text: `我示范一个动作，你接着做：先把这道题的研究对象单独画出来，在图上标出涉及的每个量的名字，不写数值。标完告诉我：哪些量是题目直接给的、哪个是你要解决的。`,
              nextAsk: '把研究对象画出来并标出各量的名字，指出哪个量是最后要解决的。',
              concepts: allowedConcepts.slice(0, 3),
            },
          ],
          identify: [
            {
              text: `我示范一个动作，你接着做：先不选公式。你把题目里"发生了什么过程"用一句话写下来（比如"某个量在某个范围内发生了变化"），写完我们再决定用哪个规律。`,
              nextAsk: '用一句话描述题目里发生的过程。',
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
              text: `我示范一个动作，你接着做：先不看数字，用一句话回答"这一步算出来的量代表什么"。说不清楚就说明式子还没选对。`,
              nextAsk: '用一句话说明这一步求出的量代表什么。',
              concepts: allowedConcepts.slice(0, 3),
            },
          ],
          conclude: [
            {
              text: `我示范一个动作，你接着做：把前面每一步得到的量按顺序列出来，检查它们能不能对上题目的要求。数值计算留给你自己完成。`,
              nextAsk: '按顺序列出每一步得到的量，检查它们能不能对上题目的要求。',
              concepts: allowedConcepts.slice(0, 3),
            },
          ],
        };
        const pool = byKind[step?.kind] ?? [
          {
            text: `我示范一个动作，你接着做：先只把研究对象单独拎出来，逐一列出和它相关的量（只写名字和方向，不写数值）。`,
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
