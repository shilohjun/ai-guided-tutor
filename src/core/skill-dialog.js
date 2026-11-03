/**
 * 最新对话 skill 的离线落地（2026-11 版）。
 *
 * 这一层解决的正是旧模板最刺眼的问题：
 *   学生说"我不知道这道题要干什么"，旧模板还在问"你能用一句话说说这道题给了哪些条件"；
 *   学生答"是电功率"，旧模板直接静默成"我在旁边看着"。
 * 新规范（/languages/00、20、30）要求：先探进度 → 只给方向或肯定 → 留白；
 *   方向之后不追加动作指令；学生答错时针对具体位置排障，而不是沉默或换话题。
 *
 * 这里的输出刻意**不含**"你去找/你试着/你把…列出来"这类指令。
 * 需要学生继续时，只保留一个探进度或澄清的问题；不需要提问就一句方向收住。
 * 人格措辞由 src/core/personas.js 在可见投影层叠加，这里只写中性的教学内容。
 */

/**
 * 每一步的教学方向。
 *
 * base = 第 1 类：只给方向，一句话收住；
 * mid  = 第 2 类：补一个条件/关系，仍不写公式；
 * deep = 第 3 类：解释这一步为什么成立，允许说到关键关系（L3 才用）。
 *
 * 所有文案都经过 guard 在 L0–L3 的逐级校验：不含最终数值、不含完整结果式。
 */
const STEP_HINTS = [
  {
    test: /切割磁感线|法拉第电磁感应定律/,
    base: [
      '这一问用切割磁感线的电动势规律，它由磁感应强度、导体长度、速度共同决定。',
      '这一问用切割磁感线的电动势规律；先把 B、L、v 三个量对应到题目里。',
    ],
    mid: [
      '切割式只适用于 B、L、v 两两垂直的情况；题目里的磁场和导体棒运动方向满足这个前提。',
      '切割式的前提是 B、L、v 两两垂直；题目里磁场竖直、导体棒水平运动，这个前提是满足的。',
    ],
    deep: [
      '把这一步拆开：导体棒切割磁感线，电动势由 B、L、v 三者共同决定；先只看大小这一条。',
      '切割式的三个量是 B、L、v；题目里磁场竖直、导体棒水平运动，三者两两垂直。',
      '切割式里 B、L、v 三个量分别对应磁感应强度、导体长度和速度，先只看大小这一条。',
    ],
  },
  {
    test: /闭合电路欧姆定律|含内阻电路/,
    base: [
      '这一问用闭合电路欧姆定律，它管的是整个回路。',
      '这一问用闭合电路欧姆定律；回路里的总电阻不只外电路那一段。',
    ],
    mid: [
      '闭合电路欧姆定律管的是整个回路，不只是外电路那一段。',
      '闭合电路欧姆定律管的是整个回路，外电路只是其中一段。',
    ],
    deep: [
      '闭合电路欧姆定律的分母是总电阻：外电阻 R 和导体棒自身电阻 r 都要算进去。',
      '换一种说法：先把回路的每一段电阻标出来，外电阻 R 和导体棒自身电阻 r 都在里面，再算总电阻。',
      '如果只把外电阻 R 放进分母，电流会偏大；导体棒自身的电阻也要算进去。',
    ],
  },
  {
    test: /安培力|左手定则|楞次定律/,
    base: [
      '这一问要判断安培力，方向由左手定则决定。',
      '这一问要判断安培力的方向，先用左手定则看电流和磁场。',
    ],
    mid: [
      '安培力的方向由左手定则判断，它总是阻碍导体棒的运动。',
      '先用左手定则判断电流和磁场的方向，再判断安培力的方向。',
    ],
    deep: [
      '安培力方向用左手定则：磁场竖直向上，电流方向确定后，安培力水平向左，阻碍导体棒向右运动。',
      '安培力方向用左手定则：磁场竖直向上，电流方向确定后，安培力水平向左。',
      '楞次定律也能判断：感应电流的磁场总要阻碍导体棒的运动。',
    ],
  },
  {
    test: /受力平衡|匀速直线运动/,
    base: ['这一问要用题目里的匀速条件。', '这一问要用题目里的匀速条件；匀速不是一句废话。'],
    mid: [
      '题目特意说了匀速，这个条件在受力分析里很关键。',
      '题目里的匀速不是一句废话，它直接给出一个受力条件。',
    ],
    deep: [
      '匀速说明速度不变，合力为零；外力要和安培力平衡。',
      '把导体棒受到的力按方向列出来：外力向右，安培力向左；匀速时这两个力大小相等。',
      '如果合力不为零，速度就会变，这和题目说的匀速矛盾。',
    ],
  },
  {
    test: /功率|能量守恒/,
    base: ['这一问求的是外力做功的功率。', '这一问求的是外力做功的功率，不是电功率。'],
    mid: [
      '这一问的外力功率等于外力乘速度，速度是题目给的恒定速度。',
      '外力做功的功率，和回路里消耗的电功率，是从两个角度描述同一件事。',
    ],
    deep: [
      '外力做功的功率等于外力乘速度，也等于回路消耗的电功率。',
      '功率可以按外力乘速度算，也可以按回路消耗的电功率算；两条路应该得到同一个数。',
      '先看题目问的是外力做功的功率，不是电功率；再把力和速度对应上。',
    ],
  },
  {
    test: /切割式成立前提|有效长度/,
    base: [
      '这一问要检查切割式的前提：B、L、v 是不是两两垂直。',
      '这一问要看 B、L、v 三个方向之间的关系。',
    ],
    mid: [
      '切割式要求 B、L、v 两两垂直；题目里的磁场竖直、导体棒水平运动，这三个方向正好两两垂直。',
      '切割式要求 B、L、v 两两垂直；题目里磁场竖直、导体棒水平运动，这个前提是满足的。',
    ],
    deep: [
      '切割式成立要求 B、L、v 两两垂直；题目里磁场竖直、导体棒水平运动，三者正好两两垂直。',
      '先确认三个方向：磁场竖直向上，导体棒水平向右运动，导体长度方向与两者都垂直。',
    ],
  },
  {
    test: /回路构成|电源与内阻/,
    base: [
      '先把回路看清楚：导体棒在切割磁感线，导轨和电阻组成回路。',
      '先把回路看清楚：导体棒、导轨和电阻连成一圈。',
    ],
    mid: [
      '回路里导体棒在切割磁感线，导轨和电阻组成外电路。',
      '回路里导体棒在切割磁感线，它自身和导轨、电阻都在回路里。',
    ],
    deep: [
      '导体棒在这里相当于电源，它自身有电阻；导轨和电阻是外电路。',
      '把回路分成两部分看：导体棒在磁场里产生电动势，导轨和电阻是外电路。',
    ],
  },
];

/** 学生说出具体错因时，只问那一个位置，不泛泛地说"再想想"。 */
const MISCONCEPTION_QUESTIONS = {
  'm-forget-r': '你写的式子里，闭合电路欧姆定律的分母只有外电阻 R。回路里还有没有别的电阻？',
  'm-ignore-equilibrium': '题目特意说了匀速。匀速在受力上意味着什么？',
  'm-ampere-direction': '安培力是帮助导体棒运动，还是阻碍它？',
};

function askedList(problem) {
  const asked = (problem?.asked ?? []).filter(Boolean).slice(0, 4);
  return asked.length ? asked.join('、') : '题目要求的量';
}

function hasAny(text, res) {
  return res.some((re) => re.test(text));
}

/**
 * 学生点名要算哪个量时，把"电动势 / 电流 / 安培力 / 外力 / 功率"映射回图谱步骤。
 *
 * 为什么不能只信 diagnosis：离线观察对"我想先算电动势"这种短句只命中不到 cues，
 * 上一轮的定位会沿用下来 —— 学生明明换了量，AI 还在讲上一个量。
 * 这里只做"学生明确点名"的覆盖，不改诊断本身。
 */
const QUANTITY_RULES = [
  { test: /电动势/, concept: /切割磁感线|法拉第|电磁感应/ },
  { test: /电流/, concept: /闭合电路欧姆定律|欧姆定律/ },
  { test: /安培力/, concept: /安培力|左手定则/ },
  { test: /外力功率|功率/, concept: /功率|能量守恒/ },
  { test: /外力|拉力/, concept: /受力平衡|匀速直线运动/ },
];

function stepForQuantity(problem, text, fallback) {
  // “电功率”在只求外力功率的题里是错量，不能当成学生选中的步骤。
  const asked = problem?.asked ?? [];
  if (/电功率/.test(text) && asked.some((a) => a.includes('外力功率')) && !asked.some((a) => a.includes('电功率'))) {
    return fallback;
  }
  const hit = QUANTITY_RULES.find((r) => r.test.test(text));
  if (!hit) return fallback;
  for (const g of problem?.solutionGraphs ?? []) {
    for (const s of g.steps ?? []) {
      if ((s.concepts ?? []).some((c) => hit.concept.test(c))) return s;
    }
  }
  return fallback;
}

function directionFor({ step, allowedConcepts, level, turnCount = 0 }) {
  const concepts = [...(step?.concepts ?? []), ...(allowedConcepts ?? [])];
  const joined = concepts.join('|');
  const hit = STEP_HINTS.find((x) => x.test.test(joined));
  const concept = step?.concepts?.[0] ?? allowedConcepts?.[0] ?? '这一步';
  const pick = (arr) => (arr?.length ? arr[turnCount % arr.length] : '');
  if (hit) {
    const pool = level >= 3 ? hit.deep : level === 2 ? hit.mid : hit.base;
    const text = pick(pool);
    if (text) return text;
  }
  const generic = {
    base: [`这一问用${concept}。`, `这一问用${concept}，先把它和题目里的量对上。`],
    mid: [`这一问用${concept}，把这一问和题目里的条件对上。`, `这一问用${concept}，先看它在这道题里对应哪一段过程。`],
    deep: [
      `这一问用${concept}，先看单位，再看结果和题目问的量是否一致。`,
      `这一问用${concept}，把这一步的物理意义说清楚，再代数值。`,
    ],
  };
  return pick(generic[level >= 3 ? 'deep' : level === 2 ? 'mid' : 'base']);
}

/**
 * 生成一句符合最新 skill 的学生可见文本。
 *
 * 返回形状与真模型一致：{ text, nextAsk, concepts }。
 * nextAsk 固定为 null —— 新规范里"留白"就是真的停住，不再挂一个"试一试"的动作。
 */
export function composeSkillDraft({
  problem,
  diagnosis,
  level = 1,
  allowedConcepts = [],
  history = [],
  utterance = '',
  step = null,
}) {
  const text = String(utterance ?? '').trim();
  const asked = askedList(problem);
  // 物理题有依赖顺序：任何时候都只把学生带到"最早未完成的那一步"，不让他自选入手点。
  const firstAsked = (problem?.asked ?? [])[0] ?? '第一问';
  const firstStep =
    stepForQuantity(problem, firstAsked, null) ??
    (problem?.solutionGraphs?.[0]?.steps ?? [])[0] ??
    step;
  // 学生点名了某个量，就以那个量对应的步骤为准（诊断的上一轮位置可能还没更新）。
  const pickedStep = stepForQuantity(problem, text, null);
  // 这一轮没有点名时，沿用最近一次点名过的量，不要被上一轮的定位带回别的步骤。
  const lastNamed = [...history].reverse().find(
    (t) => t.role === 'student' && stepForQuantity(problem, t.text, null),
  );
  let chosenStep = pickedStep || (lastNamed ? stepForQuantity(problem, lastNamed.text, step) : step);
  // 没有点名、诊断却落在后面的步骤：先拉回最早未完成的那一步，避免"学生没做前面的题，AI 却讲后面的量"。
  if (!pickedStep && !lastNamed && chosenStep && firstStep && chosenStep.index > firstStep.index) {
    chosenStep = firstStep;
  }
  const concepts = (chosenStep?.concepts ?? allowedConcepts ?? []).slice(0, 2);
  const turnCount = history.filter((t) => t.role === 'ai').length;
  const firstDirection = () => directionFor({ step: firstStep, allowedConcepts, level, turnCount });
  const reply = (value) => ({ text: value, nextAsk: null, concepts });

  // 1. 学生明确说"我先算/让我想"：留白，不追着讲。
  if (/[？?]/.test(text) === false && /(我先|我试试|让我想|我先算|我先写|等等|我在算)/.test(text)) {
    return reply('好，你先写；卡住了再叫我。');
  }

  // 1.5 学生自己发现这条路走不通：引导换工具，不顺着原路继续算。
  if (diagnosis?.stuckKind === 'dead_end_path') {
    const variants = [
      '这条路走不通，说明缺的不是计算，而是另一个能建立新关系的工具。先想想：这一步还缺哪一种关系？',
      '现在这条路的未知量靠现有规律定不下来，需要换一种能建立新关系的工具。',
      '换一种工具：这一步的未知量太多，缺的是另一条能建立新关系的定理，不是算术。',
    ];
    return reply(variants[turnCount % variants.length]);
  }

  // 2. 学生把待求量搞错（本题最常见：把"外力功率"说成"电功率"）。
  if (/电功率/.test(text) && /外力功率/.test(asked)) {
    return reply('这里问的是外力做功的功率，不是电功率。功率是最后一步，要用到前面的电动势、电流和外力。你现在做到哪一步了？');
  }

  // 3. 学生说"不知道这道题要干什么/求什么"：把依赖顺序摆出来，从第一问开始带。
  if (/(不知道|不清楚).*(这道题|题目).*(干什么|求什么|问什么|要做什么)|这道题.*(干什么|求什么|问什么)/.test(text)) {
    return reply(`这道题要依次求${asked}。先从第一问${firstAsked}开始：${firstDirection()}`);
  }

  const givesResult = /[=＝]|算(出|得)|结果是|应该是/.test(text);

  // 3.5 还没定位到具体步骤：先问进度，不让学生自选一个量。
  if (!chosenStep) {
    if (givesResult) return reply('这个结果对应哪一问？先说一个量，我再帮你看。');
    return reply('你现在做到哪一步了？');
  }

  // 4. 学生给结果/式子：先问这个结果怎么来的；有具体错因时只问那一个位置。
  if (givesResult) {
    const mis = diagnosis?.misconceptions?.[0];
    const targeted = mis ? MISCONCEPTION_QUESTIONS[mis.id] : null;
    if (targeted) return reply(targeted);
    return reply('这个结果先别急着定。它是怎么得到的？');
  }

  // 学生点名了要算哪个量：如果它在第一问之后，先说明依赖关系，把他带回第一问。
  if (pickedStep) {
    const firstIndex = firstStep?.index ?? 1;
    if (pickedStep.index > firstIndex) {
      return reply(`这一步要用到前面的结果。先从第一问${firstAsked}开始：${firstDirection()}`);
    }
    const q = (text.match(/电动势|电流|安培力|外力功率|外力|功率/) || [])[0] || '这一问';
    const alsoAsks = hasAny(text, [/哪(条|个)规律/, /怎么/, /不会/, /不懂/, /没思路/, /用什么/, /怎么求/, /为什么/, /如何/]);
    if (!alsoAsks) return reply(`好，先看${q}这一问。`);
    return reply(`好，先看${q}这一问。${directionFor({ step: pickedStep, allowedConcepts, level, turnCount })}`);
  }

  // 5. 学生问"用哪条规律/怎么想"或直接说不会：只给当前这一步的方向。
  const asksDirection = hasAny(text, [
    /哪(条|个)规律/, /用什么规律/, /该用哪/, /用什么公式/, /哪个公式/,
    /怎么求/, /怎么做/, /从哪/, /没思路/, /不会/, /不懂/, /不明白/, /看不懂/, /没想法/,
  ]);
  if (asksDirection || !text) {
    return reply(directionFor({ step: chosenStep, allowedConcepts, level, turnCount }));
  }

  // 6. 其它情况（闲聊、应声、没听懂的短句）：给当前步骤的方向，不抢话。
  return reply(directionFor({ step: chosenStep, allowedConcepts, level, turnCount }));
}
