/**
 * 题目解析（analysis）—— "原题" 与 "解析后的题目" 之间那层东西。
 *
 * ============================================================================
 * 它要产出什么
 * ============================================================================
 *   ① 关键变量：已知量（符号 / 值 / 单位 / 它在题里扮演什么）与待求量
 *   ② 关键条件：题干里那些"一句话改变整道题"的说法（由静止 / 光滑 / 匀速 / 恰好…）
 *               每条都带"它为什么重要"
 *   ③ 知识图谱：本题涉及的知识点、它们之间的先后关系、哪些是本题核心
 *
 * ============================================================================
 * 最重要的一条设计：同一份解析，两个投影
 * ============================================================================
 * 知识点与已知量是**学习信息**，给学生是应该的（教材目录也是这么标的）。
 * 但"解题路径"不是 —— 而两者的边界很细，一不小心就漏：
 *
 *   实测踩到的一次：我早期把 steps[].concepts 汇总成 conceptTags 发给学生。
 *   那道题的 concepts 里有「电源与内阻」和「匀速直线运动合力为零」——
 *   这两个恰好就是本题的两个 solutionInsights，**等于把答案印在题目下面**。
 *
 * 所以这里把图谱分成两层，而不是"一张图打码"：
 *
 *   学生图谱  只放 topics（章节级知识点，如"电磁感应""闭合电路欧姆定律"）
 *             节点之间是"前置/相关"关系，边不带步骤信息
 *   教师图谱  topics + steps 里的 concepts，每个 concept 挂到它所属的步骤上
 *             —— 这张图才回答"这道题的解法用到了哪些知识、在哪一步用"
 *
 * 另一个细节：关键条件里的"含义"可能直接说破答案
 * （"匀速 ⇒ 合力为零"就是本题的 solutionInsight）。
 * 所以每条条件都算一个 `reveals` 标记：
 *   不剧透 → 学生直接看到含义
 *   会剧透 → 学生看到的是一句提问（"这个条件在力学上对应什么？"），
 *            把翻译动作留给他自己做 —— 而这恰恰是最有价值的那个动作。
 */

import { canonicalize, clip, normalize, safeRegex } from './text.js';

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 为一道题构建完整解析（教师版）。
 * 对题库题目与导入题目走**同一条代码路径** —— 题库题没有模型给的解析时全部靠派生。
 *
 * @param {import('./types.js').Problem} problem
 * @param {{ modelAnalysis?: object }} [opts] 读题阶段模型给出的原始字段
 */
export function buildProblemAnalysis(problem, opts = {}) {
  const model = opts.modelAnalysis ?? {};

  const variables = buildVariables(problem, model);
  const keyConditions = buildKeyConditions(problem, model);
  const knowledgeGraph = buildKnowledgeGraph(problem, model);

  return {
    summary: String(model.summary ?? '').trim() || defaultSummary(problem),
    variables,
    keyConditions,
    knowledgeGraph,
  };
}

/**
 * 学生投影：只留下学习信息，去掉一切与解法路径相关的东西。
 *
 * 白名单式投影（不是打码）：这里列出的字段就是要发出去的字段，
 * 以后往 analysis 里加新字段时，只要不显式加进来，学生就永远拿不到。
 */
export function toStudentAnalysis(analysis, problem) {
  if (!analysis) return null;
  return {
    summary: analysis.summary,
    variables: analysis.variables,
    keyConditions: analysis.keyConditions.map((c) => ({
      text: c.text,
      kind: c.kind,
      label: c.label,
      /**
       * 会剧透的条件只给学生一句提问。
       * 注意这里不是"删掉" —— 删掉学生就不知道这条条件重要；
       * 给提问，学生知道"这里有事"，但还得自己翻译。
       */
      meaning: c.reveals ? null : c.meaning,
      question: c.reveals ? c.ask : null,
      /** 明确告诉他这条为什么值得停下来想，但不告诉他答案 */
      revealsInsight: Boolean(c.reveals),
    })),
    /** 学生图谱：只有章节级知识点，没有步骤、没有 cues */
    knowledgeGraph: analysis.knowledgeGraph.student,
    /** 题干的"结构"信息，便于前端渲染分问 */
    asked: problem?.asked ?? [],
  };
}

/** 教师投影：完整解析 + 知识点↔步骤的双向对应 */
export function toTeacherAnalysis(analysis) {
  if (!analysis) return null;
  return {
    summary: analysis.summary,
    variables: analysis.variables,
    keyConditions: analysis.keyConditions,
    knowledgeGraph: analysis.knowledgeGraph.teacher,
  };
}

// ---------------------------------------------------------------------------
// ① 关键变量
// ---------------------------------------------------------------------------

/**
 * 从 "L = 0.5 m" 这类字符串里拆出符号 / 值 / 单位。
 * 拆不出来也照样保留原文（宁可信息少一点，也不要丢条件）。
 */
export function parseVariable(raw, kind = 'given', index = 0) {
  const text = String(raw ?? '').trim();
  const id = `v${index}`;

  const m = normalize(text).match(
    /^([A-Za-zα-ωΑ-ΩΔ][A-Za-z0-9_]{0,3})\s*[=＝]\s*(-?\d+(?:\.\d+)?(?:\s*[×x]\s*10\s*\^?-?\d+)?)\s*([A-Za-zΩμ°²³/·]+)?/,
  );
  if (m) {
    return {
      id,
      kind,
      raw: text,
      symbol: m[1],
      value: m[2],
      unit: m[3] ?? '',
      /** 一句话说明它是什么 —— 由"名词化"规则派生，取不到就留空 */
      note: describeSymbol(m[1]),
    };
  }

  // 待求量常见形态："感应电动势 E" / "底端速度 v" / "落地前 1 s 内下落的高度"
  const tail = text.match(/([A-Za-zα-ωΑ-ΩΔ][A-Za-z0-9_]{0,3})\s*$/);
  const name = text.replace(/[（(].*?[)）]/g, '').trim();
  return {
    id,
    kind,
    raw: text,
    symbol: tail ? tail[1] : '',
    value: null,
    unit: '',
    /**
     * 说明只在"与原文相同"时留空 —— **但只对已知量**。
     *
     * 已知量里的定性条件（"匀速运动""不计摩擦"）没有符号也没有数值，
     * 回退分支会把原文同时当成 raw 和 note，UI 上就出现"匀速运动 匀速运动"。
     * 而待求量恰恰相反：中文名就是它唯一的信息（"感应电动势 E" 的符号是 E，
     * 但学生需要看到"感应电动势"这四个字），所以必须保留。
     */
    note: kind === 'asked' ? name : name === text ? '' : name,
  };
}

function buildVariables(problem, model) {
  const modelGiven = Array.isArray(model.variables?.given) ? model.variables.given : null;
  const givenSource = modelGiven?.length
    ? modelGiven.map((v) => (typeof v === 'string' ? v : v.raw ?? v.text ?? ''))
    : (problem.givens ?? []);

  const modelAsked = Array.isArray(model.variables?.asked) ? model.variables.asked : null;
  const askedSource = modelAsked?.length
    ? modelAsked.map((v) => (typeof v === 'string' ? v : v.raw ?? v.text ?? ''))
    : (problem.asked ?? []);

  return {
    given: givenSource.filter(Boolean).map((raw, i) => parseVariable(raw, 'given', i)),
    asked: askedSource.filter(Boolean).map((raw, i) => parseVariable(raw, 'asked', i)),
    /** 哪些量是"结构性条件"而不是数值（如"匀速运动"）——UI 上分开显示更好读 */
    qualitative: (problem.givens ?? []).filter((g) => !/[-=＝]\s*\d/.test(g)),
  };
}

/** 符号 → 中文说明（中学理科常用符号的封闭表，取不到返回空串） */
const SYMBOL_NOTES = {
  m: '质量',
  v: '速度',
  v0: '初速度',
  a: '加速度',
  t: '时间',
  h: '高度 / 下落距离',
  L: '长度 / 距离',
  l: '长度',
  x: '位移',
  s: '路程 / 位移',
  g: '重力加速度',
  F: '力',
  f: '摩擦力',
  N: '支持力 / 压力',
  G: '重力',
  μ: '动摩擦因数',
  θ: '倾角',
  B: '磁感应强度',
  E: '电动势 / 能量',
  I: '电流',
  U: '电压',
  R: '外电阻',
  r: '内阻',
  P: '功率',
  W: '功',
  Q: '热量 / 电荷量',
  q: '电荷量',
  Φ: '磁通量',
  C: '电容 / 浓度',
  T: '周期 / 温度',
  n: '物质的量 / 匝数',
  k: '劲度系数 / 常数',
  p: '动量 / 压强',
  Δ: '变化量',
  n0: '初始数量',
};

function describeSymbol(symbol) {
  if (!symbol) return '';
  return SYMBOL_NOTES[symbol] ?? SYMBOL_NOTES[symbol.replace(/[0-9_]/g, '')] ?? '';
}

// ---------------------------------------------------------------------------
// ② 关键条件
// ---------------------------------------------------------------------------

/**
 * 条件标记表（封闭表，可扩展）。
 *
 * 为什么用封闭表而不是让模型自由发挥：
 *   "哪些词算关键条件"是一个**可审计**的判断，交给模型就变成了随机。
 *   教研看到这张表就能说"这条应该加""这条不该算"，改起来没有歧义。
 *
 * 每条包含：
 *   re      触发说法
 *   label   条件名（给学生看的短标签）
 *   kind    条件类型（boundary/qualitative/constraint/geometry/task/domain）
 *   meaning **它在解题上意味着什么**（可能剧透，会再过一道 reveals 检查）
 *   ask     不剧透版本：把它变成一句让学生自己翻译的提问
 */
export const CONDITION_MARKERS = [
  // ---- 力学 / 运动学 ----
  {
    re: /由静止|从静止|初速度为零|初速为零/,
    label: '初速度为零',
    kind: 'boundary',
    meaning: '初始状态被指定了，运动学的几个关系式可以直接用，不必再设未知初速度。',
    ask: '"从静止开始"这句话，直接给了你哪一个量的值？',
  },
  {
    re: /光滑|不计摩擦|忽略一切摩擦|摩擦不计|无摩擦/,
    label: '接触面光滑',
    kind: 'qualitative',
    meaning: '摩擦力为零，沿接触面方向上只有重力分量与外力参与，不需要再引入摩擦系数。',
    ask: '"光滑"这两个字，消掉了哪一个力？',
  },
  {
    re: /不计空气阻力|忽略空气阻力|空气阻力不计/,
    label: '不计空气阻力',
    kind: 'qualitative',
    meaning: '只受重力，机械能守恒成立，能量关系可以直接用。',
    ask: '去掉空气阻力之后，物体受到的力只剩什么？',
  },
  {
    re: /匀速|恒定速度|速度不变|匀速直线/,
    label: '匀速（速度不变）',
    kind: 'constraint',
    meaning: '速度不变 ⇒ 加速度为零 ⇒ 该方向上合力为零。这类题里它通常就是把"力"与"电/热"接起来的那个关节。',
    ask: '"匀速"在力学上等价于什么条件？先把这句话翻译出来。',
  },
  {
    re: /匀强磁场|匀强电场|均匀磁场|均匀变化|均匀增加|均匀减小/,
    label: '场/变化是均匀的',
    kind: 'constraint',
    meaning: '均匀意味着"平均"等于"瞬时"，可以直接用乘积式或线性关系，不需要积分。',
    ask: '"均匀"这个前提，允许你用哪一种简化？',
  },
  {
    re: /恰好|刚好|至少|最多|最大|最小|不超过|不脱离/,
    label: '临界 / 极值条件',
    kind: 'constraint',
    meaning: '这类词通常对应某个不等式取等号，或者某个量取到极值 —— 是多问里最容易漏掉的一步。',
    ask: '"恰好 / 最大"这类词，说的是哪一个量到了边界？',
  },
  {
    re: /足够长|足够大|很长/,
    label: '足够长 / 足够大',
    kind: 'constraint',
    meaning: '这是"过程会一直进行到某个稳态"的意思 —— 通常指向终端状态，而不是初始状态。',
    ask: '"足够长"意味着这个过程会一直持续到什么状态？',
  },
  {
    re: /轻质|轻绳|轻杆|不计质量|质量不计/,
    label: '轻质（不计自身质量）',
    kind: 'qualitative',
    meaning: '该物体的质量为零，写它的牛顿第二定律会直接得到"两端张力相等"这类结论。',
    ask: '既然它没有质量，对它用牛顿第二定律会得到什么？',
  },
  {
    re: /缓慢|慢慢|徐徐/,
    label: '缓慢过程',
    kind: 'qualitative',
    meaning: '"缓慢"表示每一时刻都近似处于平衡态，可以按准静态处理（动能变化忽略）。',
    ask: '"缓慢"这个描述，允许你把过程当成什么状态来处理？',
  },
  {
    re: /竖直向上|竖直向下|水平放置|平行金属|沿斜面|垂直于|水平面/,
    label: '方向 / 几何关系',
    kind: 'geometry',
    meaning: '方向关系决定了哪些量之间的乘积有效（例如切割式要求 B、L、v 两两垂直）。',
    ask: '题干里的方向关系，决定了哪个乘积式可以直接用？',
  },
  {
    re: /绝缘|不导电/,
    label: '绝缘（不导电）',
    kind: 'qualitative',
    meaning: '该处没有电流通过，对应的回路要么断开、要么可以按无电流处理。',
    ask: '"绝缘"说明这条路径上有没有电流？',
  },
  {
    re: /恒定的?外力|恒力|恒定的?拉力|恒定的?推力/,
    label: '恒定外力',
    kind: 'constraint',
    meaning: '力不随时间变化，加速度恒定，可以叠加使用匀变速关系；同时也常用冲量式。',
    ask: '"恒力"这个前提，让你可以用哪一种运动模型？',
  },
  // ---- 电路 / 电磁 ----
  {
    re: /导轨电阻不计|导线电阻不计|电阻不计|内阻不计/,
    label: '部分电阻不计',
    kind: 'qualitative',
    meaning: '这一部分不消耗电能，列电功率或能量方程时可以整项去掉。',
    ask: '哪一部分的电阻被免掉了？这会影响你列的哪个方程？',
  },
  {
    re: /电容器|电容/,
    label: '含电容器',
    kind: 'qualitative',
    meaning: '电容支路在稳态下不通过电流，但它两端有电压 —— 这是最容易误判成"断路所以没影响"的地方。',
    ask: '电容器所在的支路，稳态下有电流吗？它两端有没有电压？',
  },
  // ---- 数学 ----
  {
    re: /证明|求证|试证/,
    label: '这是一道证明题',
    kind: 'task',
    meaning: '目标不是求数值，而是从已知推出结论；每一步都必须能被前一步支撑，不能跳。',
    ask: '这道题要你推出的结论，具体是什么形式？',
  },
  {
    re: /正整数|整数|偶数|奇数|质数|素数|互质|互素|有理数/,
    label: '数域 / 整除条件',
    kind: 'domain',
    meaning: '整数的整除性质是证明题最常用的抓手，反证法里通常就是靠它构造出矛盾。',
    ask: '这些整数条件，在推理里能给你提供什么抓手？',
  },
  {
    re: /单调|极值|最值|最大值|最小值|导数|切线|导函数/,
    label: '单调性与极值',
    kind: 'domain',
    meaning: '先看导数的符号，再看区间端点 —— 闭区间上的最值必须把端点一起比较。',
    ask: '闭区间上找最值，除了极值点还要比哪些位置？',
  },
];

/**
 * 提取关键条件。
 *
 * 模型给了就用模型的（它读题更懂语义），并按同一套规则算 reveals；
 * 模型没给（题库题 / 离线降级）就用封闭表从题干里扫。
 */
export function buildKeyConditions(problem, model) {
  const modelConds = Array.isArray(model.keyConditions) ? model.keyConditions : null;
  const out = [];

  if (modelConds?.length) {
    modelConds.forEach((c, i) => {
      const text = String(c.text ?? c.raw ?? '').trim();
      if (!text) return;
      const label = String(c.label ?? c.name ?? `关键条件 ${i + 1}`).trim();
      const meaning = String(c.meaning ?? '').trim();
      const ask = String(c.ask ?? c.question ?? '').trim() || '这条条件在解题上起什么作用？先自己翻译一遍。';
      out.push(finalizeCondition({ text, label, kind: String(c.kind ?? 'qualitative'), meaning, ask }, problem));
    });
  }

  // 封闭表扫描（补齐模型漏掉的，或完全替代模型）
  const stem = normalize(problem.stem ?? '');
  for (const marker of CONDITION_MARKERS) {
    const m = stem.match(marker.re);
    if (!m) continue;
    if (out.some((c) => c.label === marker.label)) continue;
    out.push(
      finalizeCondition(
        { text: m[0], label: marker.label, kind: marker.kind, meaning: marker.meaning, ask: marker.ask },
        problem,
      ),
    );
  }

  return out.slice(0, 6);
}

/**
 * 收尾一条条件：抽"原话所在的小句" + 判定它会不会剧透。
 *
 * reveals 的判据直接复用守门用的那两组指纹（solutionInsights / formulaFingerprints）：
 *   "这条解释如果发给学生，守卫会不会拦？"
 * 会拦 ⇒ 说明它确实是在说破结论 ⇒ 学生版改成提问。
 *
 * 这样做的好处是**判定基准与守卫完全一致**：
 * 不会出现"解析里能说、提示里不能说"这种自相矛盾的口径。
 */
function finalizeCondition(cond, problem) {
  const quote = extractQuote(problem.stem ?? '', cond.text);
  const reveals = doesReveal(cond.meaning, problem);
  return {
    text: quote || cond.text,
    label: cond.label,
    kind: cond.kind,
    meaning: cond.meaning,
    ask: cond.ask,
    reveals,
  };
}

/**
 * 判定一条条件的"含义"会不会把答案说漏。
 *
 * 两条判据，缺一不可 —— 它们抓的是两类不同的泄漏：
 *
 * ① **结论型**：命中 solutionInsights / formulaFingerprints。
 *    例："匀速 ⇒ 合力为零"（"合力为零"就是本题的 solutionInsight）。
 *    判据与守卫用的指纹**完全一致**，所以不会出现"解析里能说、提示里不能说"的口径矛盾。
 *
 * ② **前提型**：命中了**只存在于解题步骤里的说法**（步骤标题 / 定位关键词 / 路径前提）。
 *    例：几何条件那条解释里写了"切割式要求 B、L、v 两两垂直"，
 *    而"两两垂直"正是第 3 步「检查 E = BLv 的使用前提」的定位关键词 ——
 *    这等于把"要检查什么前提"直接告诉学生。
 *
 *    这条判据是**测试逼出来的**：一开始只做了 ①，
 *    结果 test/analysis.test.js 的反向断言（学生载荷里不许出现步骤 cues）当场失败。
 *    只测 ① 会漏掉整整一类泄漏，而它比结论型更隐蔽 ——
 *    说破"结论"容易被发现，说破"该检查什么"看起来只像是在讲课。
 *
 * 判定基准里的"合法可见文本"（题干 / 知识点 / 已知 / 待求）要排除掉：
 * 一个词如果本来就印在题目上，它出现在解释里不算泄漏。
 */
function doesReveal(text, problem) {
  if (!text) return false;
  const t = canonicalize(text);

  // ---- ① 结论型：与守卫同一套指纹 ----
  const patterns = [...(problem.solutionInsights ?? []), ...(problem.formulaFingerprints ?? [])];
  for (const p of patterns) {
    let hit = false;
    try {
      hit = safeRegex(p, 'i').test(t);
    } catch {
      hit = false;
    }
    if (hit) return true;
  }

  // ---- ② 前提型：命中了只存在于解法里的说法 ----
  const legit = [problem.stem, ...(problem.topics ?? []), ...(problem.givens ?? []), ...(problem.asked ?? [])]
    .join(' ');

  for (const g of problem.solutionGraphs ?? []) {
    for (const s of g.steps ?? []) {
      if (s.title && s.title.length >= 4 && !legit.includes(s.title) && t.includes(canonicalize(s.title))) {
        return true;
      }
      for (const cue of s.cues ?? []) {
        if (cue.length >= 3 && !legit.includes(cue) && t.includes(canonicalize(cue))) return true;
      }
    }
    for (const pre of g.preconditions ?? []) {
      // 前提往往是长句，整句不会原样出现在解释里；抓它的后半段关键词
      if (pre.length >= 6 && !legit.includes(pre) && t.includes(canonicalize(pre))) return true;
    }
  }

  return false;
}

/**
 * 在题干里找到含该关键词的那段原话。
 *
 * 取的是关键词**前后各 12 个字**，而不是"关键词所在的整个小句"。
 * 原因：长句里一个小句可能长到 40 字，而一道题里好几条条件都落在同一个小句上
 * （实测："水平放置的两条光滑平行金属导轨间距为 L = 0.5 m" 同时命中了
 *  "光滑""水平放置""间距" 三条），于是三条条件的引用完全一样 ——
 * 学生看到的是重复三遍的同一句话，反而看不出每条条件到底指哪几个字。
 */
function extractQuote(stem, keyword) {
  const text = String(stem ?? '');
  if (!keyword) return '';
  const i = text.indexOf(keyword);
  if (i < 0) return keyword;
  const start = Math.max(0, i - 12);
  const end = Math.min(text.length, i + keyword.length + 12);
  const head = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return `${head}${text.slice(start, end).trim()}${tail}`;
}

// ---------------------------------------------------------------------------
// ③ 知识图谱
// ---------------------------------------------------------------------------

/**
 * 知识图谱 **学生版**：节点只有章节级知识点（problem.topics）。
 *
 * 为什么刻意不含 steps[].concepts：
 *   那些概念（"电源与内阻""匀速直线运动合力为零"）就是解法本身，
 *   印在题目下面等于把答案给了。这条不是理论担忧 —— 是实测漏过一次。
 *
 * 关系从哪来：
 *   模型给（读题时能判断"哪个是前置、哪个是核心"）→ 优先
 *   模型没给 → 按"文本包含 + 同题共现"派生，并标注 source='derived'，
 *              让 UI 能如实告诉用户"这张关系图是派生的，不是教研标注的"
 */
export function buildKnowledgeGraph(problem, model) {
  const topics = (problem.topics ?? []).filter(Boolean);
  const modelNodes = Array.isArray(model.knowledgeGraph?.nodes) ? model.knowledgeGraph.nodes : null;
  const modelEdges = Array.isArray(model.knowledgeGraph?.edges) ? model.knowledgeGraph.edges : null;

  // ---- 学生节点 ----
  const studentNodes = [];
  if (modelNodes?.length) {
    modelNodes.forEach((n, i) => {
      const name = String(n.name ?? '').trim();
      if (!name) return;
      studentNodes.push({
        id: slugId(n.id ?? name, `k${i + 1}`),
        name,
        role: n.role === 'support' ? 'support' : 'core',
        level: clampLevel(n.level, n.role),
        note: String(n.note ?? '').trim(),
      });
    });
  }
  // 模型没给 / 给漏的 topics，补成节点
  for (const t of topics) {
    if (studentNodes.some((n) => n.name === t)) continue;
    studentNodes.push({
      id: slugId(t, `k${studentNodes.length + 1}`),
      name: t,
      role: studentNodes.length === 0 ? 'core' : 'support',
      level: studentNodes.length === 0 ? 1 : 2,
      note: '',
    });
  }

  // ---- 学生边 ----
  let studentEdges = [];
  let edgeSource = 'model';
  if (modelEdges?.length) {
    studentEdges = modelEdges
      .map((e) => {
        const from = findNodeId(studentNodes, e.from);
        const to = findNodeId(studentNodes, e.to);
        if (!from || !to || from === to) return null;
        return { from, to, relation: normalizeRelation(e.relation), label: relationLabel(e.relation) };
      })
      .filter(Boolean);
  }
  if (!studentEdges.length) {
    edgeSource = 'derived';
    studentEdges = deriveEdges(studentNodes);
  }

  // ---- 教师节点：学生节点 + 步骤里的概念，并把概念挂到步骤上 ----
  const teacherNodes = studentNodes.map((n) => ({ ...n, kind: 'topic', steps: [] }));
  const teacherEdges = [...studentEdges];
  const conceptIndex = new Map();

  for (const g of problem.solutionGraphs ?? []) {
    for (const s of g.steps ?? []) {
      for (const c of s.concepts ?? []) {
        const name = String(c ?? '').trim();
        if (!name) continue;
        if (!conceptIndex.has(name)) {
          const id = slugId(`concept-${name}`, `c${conceptIndex.size + 1}`);
          conceptIndex.set(name, id);
          teacherNodes.push({
            id,
            name,
            role: 'concept',
            level: 3,
            note: '',
            kind: 'concept',
            steps: [],
          });
        }
        const id = conceptIndex.get(name);
        const node = teacherNodes.find((n) => n.id === id);
        if (node && !node.steps.includes(s.index)) node.steps.push(s.index);
      }
    }
  }

  return {
    student: {
      nodes: studentNodes,
      edges: studentEdges,
      /** 关系来源：model = 模型读题时判断的；derived = 按文本关系派生的 */
      edgeSource,
      /** 如实告诉 UI：学生图里没有步骤信息，这是设计而不是缺失 */
      scope: 'topics-only',
    },
    teacher: {
      nodes: teacherNodes,
      edges: teacherEdges,
      edgeSource,
      scope: 'topics+concepts+steps',
    },
  };
}

function deriveEdges(nodes) {
  const edges = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      // 包含关系 ⇒ 前置
      if (a.name.includes(b.name) || b.name.includes(a.name)) {
        const [from, to] = a.name.includes(b.name) ? [b, a] : [a, b];
        edges.push({ from: from.id, to: to.id, relation: 'prereq', label: '前置' });
        continue;
      }
      // 层级差 ⇒ 基础 → 核心
      if (a.level !== b.level) {
        const [from, to] = a.level > b.level ? [a, b] : [b, a];
        edges.push({ from: from.id, to: to.id, relation: 'prereq', label: '前置' });
      } else {
        edges.push({ from: a.id, to: b.id, relation: 'related', label: '相关' });
      }
    }
  }
  // 避免一张糊成一团的图：最多留 2n 条边
  return edges.slice(0, Math.max(4, nodes.length * 2));
}

function normalizeRelation(r) {
  const s = String(r ?? '').toLowerCase();
  if (/prereq|基础|前置|require/.test(s)) return 'prereq';
  if (/include|包含|属于/.test(s)) return 'includes';
  if (/appl|应用|use/.test(s)) return 'applies';
  return 'related';
}

function relationLabel(r) {
  return { prereq: '前置', includes: '包含', applies: '应用', related: '相关' }[normalizeRelation(r)];
}

function findNodeId(nodes, ref) {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  const byId = nodes.find((n) => n.id === s);
  if (byId) return byId.id;
  const byName = nodes.find((n) => n.name === s || n.name.includes(s) || s.includes(n.name));
  return byName?.id ?? null;
}

function clampLevel(level, role) {
  const n = Number(level);
  if (Number.isFinite(n) && n >= 1 && n <= 3) return Math.round(n);
  return role === 'support' ? 2 : 1;
}

function slugId(v, fallback) {
  const s = String(v)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

function defaultSummary(problem) {
  const t = (problem.topics ?? []).slice(0, 2).join('、');
  const subject = { physics: '物理', math: '数学', chemistry: '化学' }[problem.subject] ?? '本题';
  return `${subject}题${t ? `，考点集中在${t}` : ''}：${clip(canonicalize(problem.stem ?? ''), 40)}`;
}
