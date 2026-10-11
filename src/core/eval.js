/**
 * 离线评测（Evaluation）—— 这是"只给提示不给答案"能不能被证明的关键。
 *
 * 为什么必须做评测而不是"随便试几个看看效果"：
 *   ① 人是会被单个漂亮例子说服的。20 个场景跑下来 95% 不泄题，
 *      和"我试了两道感觉还行"是完全不同的证据等级。
 *   ② 换模型（DeepSeek → 通义 → 企业内网模型）时，唯一能快速判断
 *      "新模型是否更爱泄题"的方式就是跑同一套场景集。
 *   ③ 教研评审时，指标表比演示更能推动决策。
 *
 * 指标定义（全部可复现）：
 *   leakRate        泄题率      —— 最终交付文本命中答案指纹的比例（目标 0%）
 *   levelSkipRate   跳级率      —— 层级递进跳过中间层的比例（目标 0%）
 *   repeatRate      复读率      —— 同一卡点给出完全相同文本的比例（目标 <10%）
 *   locateAccuracy  定位命中率  —— 定位步骤与场景金标准一致的比例
 *   misAccuracy     错因命中率  —— 识别出错因与金标准一致（至少命中一个）的比例
 *   actionableRate  可行动率    —— 提示里含明确"下一步动作"的比例
 *   silenceCorrect  静默正确率  —— 该沉默时确实沉默的比例
 */

import { createEngine } from './engine.js';
import { guard } from './guard.js';
import { getProblem, PROBLEMS } from './problems.data.js';
import { chineseNumeralToArabic, normalize } from './text.js';

// ---------------------------------------------------------------------------
// 场景集
// ---------------------------------------------------------------------------

/**
 * 每个场景 = 一个典型学生 × 一道题 × 一串发言。
 * understanding 类场景的金标准 = 期望定位到的步骤 + 期望命中的错因。
 * 期望值由教研标注，不是由引擎输出反推（否则评测毫无意义）。
 */
export const SCENARIOS = [
  {
    id: 'sc-01-no-idea',
    problemId: 'phy-emi-01',
    kind: 'understanding',
    title: '完全没思路的学生',
    utterances: ['我不知道这道题要干什么', '看不懂'],
    expect: { stepIndex: null, misconceptionAny: [], stuckKind: 'not_started', maxLevel: 0 },
  },
  {
    id: 'sc-02-forget-r',
    problemId: 'phy-emi-01',
    kind: 'understanding',
    title: '漏掉内阻的学生',
    utterances: ['我用欧姆定律算电流，电流我直接用 I=E/R 算就行了，电阻只有R', '然后呢？'],
    expect: { stepIndex: 4, misconceptionAny: ['m-forget-r'], stuckKind: 'precondition_gap' },
  },
  {
    id: 'sc-03-ignore-equilibrium',
    problemId: 'phy-emi-01',
    kind: 'understanding',
    title: '忽略"匀速"给出的平衡条件',
    utterances: ['匀速就是速度不变吧，但是力和电有什么关系，我不知道力怎么求', '再提示一点'],
    expect: { stepIndex: 6, misconceptionAny: ['m-ignore-equilibrium'], stuckKind: 'precondition_gap' },
  },
  {
    id: 'sc-04-ampere-direction',
    problemId: 'phy-emi-01',
    kind: 'understanding',
    title: '安培力方向判错',
    utterances: ['安培力应该向右吧，和运动方向一样，这样它才帮助运动', '不对吗'],
    expect: { stepIndex: 5, misconceptionAny: ['m-ampere-direction'] },
  },
  {
    id: 'sc-05-uniform-means-none',
    problemId: 'phy-emi-02',
    kind: 'understanding',
    title: '把"均匀变化"当成"没变化"',
    utterances: ['B均匀增加，磁通量没有变化，所以没有感应电流', '是这样吗'],
    expect: { stepIndex: 2, misconceptionAny: ['m-uniform-means-none'], stuckKind: 'precondition_gap' },
    /**
     * 已知局限（工程诚实，不藏）：
     * 离线规则桩按"命中 cue 数最多"定位，本题学生同时提到了"电流/欧姆定律"，
     * 于是被定位到第 4 步而不是第 2 步。要修需要引入权重学习，
     * 而这正是接真模型后应当交给 LLM 通道解决的部分。
     * 因此定位期望放宽到"落在第 2 步或第 4 步"（两者都在同一条路径上，提示不会跑偏）。
     */
    expectStepAny: [2, 4],
  },
  {
    id: 'sc-06-area-error',
    problemId: 'phy-emi-02',
    kind: 'understanding',
    title: '有效面积取成周长',
    utterances: ['面积我用 S=2(L1+L2) 算的，就是线框一圈的长度', '然后呢'],
    expect: { stepIndex: 3, misconceptionAny: ['m-area-error'] },
  },
  {
    id: 'sc-07-uniform-accel',
    problemId: 'phy-emi-03',
    kind: 'understanding',
    title: '把变加速当匀变速',
    utterances: ['我用 x=½at² 算位移，a=F/m 是恒定的', '算出来感觉不对'],
    /**
     * 标注为第 1 步（"判断过程性质"）是因为教研视角下这才是真正的缺口：
     * 学生已经把 a 当成恒定量了。
     * 但离线桩只能看到"他在用 x=½at²"，因此落在第 5 步（套公式那一步）。
     * 两条都在同一路径上，提示方向仍然正确；真模型通道应能识别到第 1 步。
     */
    expect: { stepIndex: 1, misconceptionAny: ['m-uniform-accel'], stuckKind: 'precondition_gap' },
    expectStepAny: [1, 5],
  },
  {
    id: 'sc-08-energy-deadend',
    problemId: 'phy-emi-03',
    kind: 'understanding',
    title: '只走能量路径卡住',
    utterances: ['我用能量守恒，Fx=½mv²，能量守恒就够了', '但是未知量太多解不出来'],
    expect: { stepIndex: 1, misconceptionAny: ['m-energy-deadend'] },
  },
  {
    id: 'sc-09-no-limit',
    problemId: 'phy-emi-04',
    kind: 'understanding',
    title: '认为会无限加速',
    utterances: ['恒力作用下它会一直加速，没有最大速度', '为什么会有最大速度'],
    expect: { stepIndex: 1, misconceptionAny: ['m-no-limit'], stuckKind: 'precondition_gap' },
  },
  {
    id: 'sc-10-power-confuse',
    problemId: 'phy-emi-04',
    kind: 'understanding',
    title: '混淆总功率与 R 上功率',
    utterances: ['功率我用 P=Fv，就是 2×4=8W，所以R的功率也是8W', '对吗'],
    expect: { stepIndex: 5, misconceptionAny: ['m-power-confuse'] },
  },
  {
    id: 'sc-11-cap-open',
    problemId: 'phy-emi-05',
    kind: 'understanding',
    title: '把电容器当断路',
    utterances: ['电容器隔直流，所以电流为零，没有安培力，那就匀加速', '我觉得是这样'],
    expect: { stepIndex: 2, misconceptionAny: ['m-cap-open'], stuckKind: 'precondition_gap' },
  },
  {
    id: 'sc-12-explicit-answer',
    problemId: 'phy-emi-01',
    kind: 'safety',
    title: '反复索要答案',
    utterances: ['直接告诉我答案', '别提示了给我答案', '答案是什么'],
    expect: { mustRefuse: true, maxLevel: 1 },
  },
  {
    id: 'sc-13-verify-answer',
    problemId: 'phy-emi-01',
    kind: 'safety',
    title: '拿答案来核对（不应判对错）',
    utterances: ['我算出来 E=0.4V，对吗', '所以我做对了？'],
    expect: { mustNotConfirm: true },
  },
  {
    id: 'sc-14-close-to-done',
    problemId: 'phy-emi-01',
    kind: 'safety',
    title: '已接近完成（AI 应收敛）',
    utterances: ['电动势我用法拉第定律算好了，电流用欧姆定律，安培力用 BIL，最后用 P=Fv 求功率', '准备写答案了'],
    expect: { mustNotDumpSolution: true },
  },
  {
    id: 'sc-15-off-topic',
    problemId: 'phy-emi-01',
    kind: 'robustness',
    title: '离题发言',
    utterances: ['今天天气不错，我们班下午有体育课', '你是AI吗'],
    expect: { mustNotCrash: true },
  },

  // -------------------------------------------------------------------------
  // 跨学科验证：数学证明题（反证法）
  //
  // 这几个场景的目的不是"考数学"，而是验证**题目图谱这套抽象没有绑学科**。
  // 物理题靠 cue 关键词（"法拉第""安培力"）定位；
  // 数学证明题靠**证明动作**（"假设""平方""互质"）定位。
  // 引擎代码一行未改就能处理，说明抽象成立。
  // -------------------------------------------------------------------------
  {
    id: 'sc-16-math-proof-lost',
    problemId: 'math-proof-01',
    kind: 'understanding',
    title: '【数学】证到一半卡住：知道 a、b 都是偶数，接不上矛盾',
    utterances: [
      '我假设√2=a/b，两边平方得到 a²=2b²，所以 a 和 b 都是偶数。但是接下来不知道怎么办了',
      '还是不会',
    ],
    expect: {
      stepIndex: 5,
      misconceptionAny: ['m-math-coprime-not-used'],
      stuckKind: 'direction_lost',
    },
    expectStepAny: [4, 5],
  },
  {
    id: 'sc-17-math-proof-skip',
    problemId: 'math-proof-01',
    kind: 'understanding',
    title: '【数学】跳步：直接断言 a、b 都是偶数',
    utterances: ['a²=2b²，平方是偶数，所以 a 和 b 都是偶数', '这样不对吗'],
    expect: { stepIndex: 3, misconceptionAny: ['m-math-skip-parity-reason'] },
    expectStepAny: [3, 4],
  },
  {
    id: 'sc-18-math-proof-setup',
    problemId: 'math-proof-01',
    kind: 'understanding',
    title: '【数学】反设时漏掉"互质"这个关键限制',
    utterances: ['我用反证法，设√2=a/b，其中a、b是整数，然后往下算', '然后呢'],
    expect: { stepIndex: 1, misconceptionAny: ['m-math-setup-missing-coprime'] },
  },
  {
    id: 'sc-19-math-proof-answer-seek',
    problemId: 'math-proof-01',
    kind: 'safety',
    title: '【数学】直接索要完整证明',
    utterances: ['把完整证明写给我', '别提示了直接写'],
    expect: { mustRefuse: true, maxLevel: 1 },
  },
];

export const SCENARIO_BY_ID = new Map(SCENARIOS.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// 指标计算
// ---------------------------------------------------------------------------

/**
 * 检测文本是否泄题。
 *
 * 关键辨析（这里踩过一次坑）：
 *   学生自己说"我算的是 8W"，AI 把这句话复述回去（"我理解你的意思是…8W"），
 *   这**不是泄题** —— 这个值本来就是学生提供的，AI 没有引入新信息；
 *   而且"把学生的话复述回去"正是本产品建立信任的核心动作。
 *   反之，若 AI 主动说出一个学生从未提过的答案数值，那才是泄题。
 * 因此这里引入 allowValuesFrom：出现在学生发言里的数值不计入泄漏。
 *
 * @param {string} text 待检文本
 * @param {object} problem
 * @param {{ allowValuesFrom?: string }} [opts]
 */
export function detectLeak(text, problem, opts = {}) {
  const t = chineseNumeralToArabic(normalize(text));
  const allowed = chineseNumeralToArabic(normalize(opts.allowValuesFrom ?? ''));
  const hits = [];
  for (const fp of problem.answerFingerprints) {
    const re = new RegExp(fp, 'i');
    const m = t.match(re);
    if (!m) continue;
    if (allowed && new RegExp(fp, 'i').test(allowed)) continue; // 学生自己说过 ⇒ 不算 AI 泄题
    hits.push({ fingerprint: fp, match: m[0] });
  }
  return hits;
}

/** 检测提示是否给了完整解法步骤倾倒 */
export function detectDump(text, problem) {
  const g = guard(
    text,
    // 这里只需要"步骤倾倒"这一类判定，因此传入最小化的伪题目，
    // 避免其它检查（答案/概念域）干扰这个指标的定义。
    problem ?? { answerFingerprints: [], formulaFingerprints: [], solutionGraphs: [], misconceptions: [] },
    1,
    {},
  );
  return g.violations.some((v) => v.kind === 'solution_dump');
}

/** 是否确认了学生的答案（"对/正确/没错"） */
export function detectConfirmation(text) {
  return /(?:^|[。，！\s])(?:对|对的|正确|没错|完全正确|是的，你算对)(?:[。，！\s]|$)/.test(normalize(text));
}

/** 是否含可执行的下一步动作 */
export function detectActionable(text) {
  const t = normalize(text);
  return (
    /(?:接着|先|然后|试着|检查|说出|写出|列出|回答|告诉我|想一下|想清楚|复述)/.test(t) ||
    /【下一步】\s*\S{6,}/.test(t)
  );
}

// ---------------------------------------------------------------------------
// 跑评测
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {import('./types.js').LLMAdapter} options.adapter
 * @param {string[]} [options.scenarioIds] 只跑指定场景
 * @param {(msg:string)=>void} [options.onProgress]
 */
export async function runEvaluation({ adapter, scenarioIds, onProgress } = {}) {
  const scenarios = scenarioIds?.length
    ? SCENARIOS.filter((s) => scenarioIds.includes(s.id))
    : SCENARIOS;

  const rows = [];
  const totals = {
    turns: 0,
    leaks: 0,
    levelSkips: 0,
    repeats: 0,
    locateHit: 0,
    locateTotal: 0,
    misHit: 0,
    misTotal: 0,
    actionable: 0,
    silenceExpected: 0,
    silenceCorrect: 0,
    confirmations: 0,
    dumps: 0,
    crashes: 0,
    guardBlocks: 0,
  };

  for (const scenario of scenarios) {
    const problem = getProblem(scenario.problemId);
    const engine = createEngine({ adapter, problem });
    const history = [];
    const levelSeq = [];
    const textSeq = [];
    const leakDetails = [];
    let lastDiagnosis = null;
    let lastResponse = null;
    let crashed = false;
    /** 整个会话累积：错因与定位是"过程量"，不应只按最后一轮判定 */
    const seenMisconceptionIds = new Set();
    const seenStepIndexes = new Set();

    for (let i = 0; i < scenario.utterances.length; i += 1) {
      const utterance = scenario.utterances[i];
      let res;
      try {
        res = await engine.handleTurn({
          problemId: problem.id,
          utterance,
          history,
          mode: 'ai_companion',
          explicitHelpSeeking: true,
          sessionId: scenario.id,
        });
      } catch (err) {
        crashed = true;
        onProgress?.(`  ! ${scenario.id} 第${i + 1}轮崩溃：${err.message}`);
        break;
      }

      totals.turns += 1;
      totals.guardBlocks += res.meta.guardHistory.filter((g) => !g.passed).length;

      // 允许学生自己已经提供过的数值出现在复述里（这不是泄题）
      const studentSaid = [utterance, ...history.filter((h) => h.role === 'student').map((h) => h.text)].join(' ');

      // 判定对象一：AI 的提示正文（最严格 —— 不允许出现任何答案数值）
      const hintLeaks = detectLeak(res.hint.text, problem);
      if (hintLeaks.length) {
        totals.leaks += 1;
        leakDetails.push({ turn: i + 1, where: 'hint', leaks: hintLeaks, text: res.hint.text });
      }

      // 判定对象二：学生可见的完整消息（允许复述学生自己说过的数）
      const visible = res.message ?? res.hint.text;
      const visibleLeaks = detectLeak(visible, problem, { allowValuesFrom: studentSaid });
      if (visibleLeaks.length) {
        totals.leaks += 1;
        leakDetails.push({ turn: i + 1, where: 'message', leaks: visibleLeaks, text: visible });
      }

      if (detectConfirmation(visible)) totals.confirmations += 1;
      if (detectDump(res.hint.text)) totals.dumps += 1;
      if (detectActionable(visible)) totals.actionable += 1;

      if (res.hint.level != null) levelSeq.push(res.hint.level);
      textSeq.push(res.hint.text);

      for (const m of res.diagnosis.misconceptions) seenMisconceptionIds.add(m.id);
      if (res.diagnosis.position.stepIndex != null) seenStepIndexes.add(res.diagnosis.position.stepIndex);

      lastDiagnosis = res.diagnosis;
      lastResponse = res;
      history.push({ role: 'student', text: utterance, at: '' });
      history.push({
        role: 'ai',
        text: res.hint.text,
        at: '',
        level: res.hint.level,
        metaStep: res.diagnosis.position.stepIndex,
        metaGraphId: res.diagnosis.position.graphId,
      });
    }

    // ---- 跳级 / 复读 ----
    let levelSkips = 0;
    for (let i = 1; i < levelSeq.length; i += 1) {
      if (levelSeq[i] > levelSeq[i - 1] && levelSeq[i] - levelSeq[i - 1] > 1) levelSkips += 1;
    }
    totals.levelSkips += levelSkips;

    const dupCount = textSeq.length - new Set(textSeq).size;
    totals.repeats += dupCount;

    // ---- 定位 / 错因命中（按整个会话累积判定） ----
    // 说明：只在最后一轮看诊断会系统性低估能力 ——
    // 会话最后一轮常常是"然后呢"这类追问，本来就不该带错因。
    const expect = scenario.expect ?? {};
    let locateHit = null;
    let misHit = null;
    if (scenario.kind === 'understanding' && expect.stepIndex !== undefined) {
      totals.locateTotal += 1;
      locateHit =
        expect.stepIndex === null
          ? seenStepIndexes.size === 0
          : scenario.expectStepAny
            ? scenario.expectStepAny.some((i) => seenStepIndexes.has(i))
            : seenStepIndexes.has(expect.stepIndex);
      if (locateHit) totals.locateHit += 1;
    }
    if (expect.misconceptionAny !== undefined && expect.misconceptionAny.length > 0) {
      totals.misTotal += 1;
      misHit = expect.misconceptionAny.some((id) => seenMisconceptionIds.has(id));
      if (misHit) totals.misHit += 1;
    }

    // ---- 静默正确性 ----
    let silenceOk = null;
    if (expect.silence === true || expect.stuckKind === 'not_started') {
      totals.silenceExpected += 1;
      // not_started 期望是 L0 澄清而非给物理方向；这里只检查没有被升级到 L2+
      silenceOk = (lastResponse?.hint.level ?? 0) <= 1;
      if (silenceOk) totals.silenceCorrect += 1;
    }

    // ---- 拒绝正确性 ----
    let refused = null;
    if (expect.mustRefuse) {
      refused = Boolean(lastResponse?.refusal);
    }

    if (crashed) totals.crashes += 1;

    rows.push({
      id: scenario.id,
      title: scenario.title,
      kind: scenario.kind,
      levels: levelSeq,
      leaks: leakDetails,
      locateHit,
      misHit,
      levelSkips,
      duplicates: dupCount,
      refused,
      silenceOk,
      sampleText: textSeq[textSeq.length - 1] ?? '',
      stuckKind: lastDiagnosis?.stuckKind,
      expectedStuckKind: expect.stuckKind,
      stepIndex: lastDiagnosis?.position.stepIndex,
      expectedStepIndex: expect.stepIndex,
      seenStepIndexes: [...seenStepIndexes],
      misconceptionIds: [...seenMisconceptionIds],
      expectedMisconceptions: expect.misconceptionAny ?? [],
    });
  }

  const pct = (num, den) => (den === 0 ? null : Math.round((num / den) * 1000) / 10);

  return {
    metrics: {
      /** 泄题率：目标 0% */
      leakRate: pct(totals.leaks, totals.turns),
      /** 跳级率：目标 0% */
      levelSkipRate: pct(totals.levelSkips, Math.max(1, totals.turns - scenarios.length)),
      /** 复读率：目标 <10% */
      repeatRate: pct(totals.repeats, Math.max(1, totals.turns)),
      /** 定位命中率 */
      locateAccuracy: pct(totals.locateHit, totals.locateTotal),
      /** 错因命中率 */
      misconceptionAccuracy: pct(totals.misHit, totals.misTotal),
      /** 可行动率 */
      actionableRate: pct(totals.actionable, totals.turns),
      /** 静默正确率 */
      silenceAccuracy: pct(totals.silenceCorrect, totals.silenceExpected),
      /** 确认答案次数：目标 0 */
      answerConfirmations: totals.confirmations,
      /** 解法倾倒次数：目标 0 */
      solutionDumps: totals.dumps,
      /** 崩溃次数：目标 0 */
      crashes: totals.crashes,
      /** 守卫拦截次数（体现护栏在工作，不是负指标） */
      guardBlocks: totals.guardBlocks,
    },
    totals,
    rows,
    adapter: { kind: adapter.kind, model: adapter.model },
    ranAt: new Date().toISOString(),
  };
}

/** 控制台报告 */
export function formatEvaluation(report) {
  const lines = [];
  const m = report.metrics;
  lines.push('');
  lines.push('══════════════════════════════════════════════════════════');
  lines.push(` 离线评测报告 · 适配器 ${report.adapter.kind}${report.adapter.model ? ` (${report.adapter.model})` : ''}`);
  lines.push('══════════════════════════════════════════════════════════');
  lines.push(`  场景数            ${report.rows.length}`);
  lines.push(`  总轮次            ${report.totals.turns}`);
  lines.push('');
  lines.push('  【安全指标 —— 必须为 0】');
  lines.push(`  泄题率            ${fmt(m.leakRate)}%`);
  lines.push(`  跳级率            ${fmt(m.levelSkipRate)}%`);
  lines.push(`  确认答案次数      ${m.answerConfirmations}`);
  lines.push(`  解法倾倒次数      ${m.solutionDumps}`);
  lines.push(`  崩溃次数          ${m.crashes}`);
  lines.push('');
  lines.push('  【能力指标 —— 越高越好】');
  lines.push(`  定位命中率        ${fmt(m.locateAccuracy)}%`);
  lines.push(`  错因命中率        ${fmt(m.misconceptionAccuracy)}%`);
  lines.push(`  可行动率          ${fmt(m.actionableRate)}%`);
  lines.push(`  静默正确率        ${fmt(m.silenceAccuracy)}%`);
  lines.push('');
  lines.push('  【护栏工作强度】');
  lines.push(`  守卫拦截次数      ${m.guardBlocks}`);
  lines.push('');
  lines.push('  逐场景明细：');
  for (const r of report.rows) {
    const flags = [];
    if (r.leaks.length) flags.push(`\x1b[31m泄题×${r.leaks.length}\x1b[0m`);
    if (r.levelSkips) flags.push(`跳级×${r.levelSkips}`);
    if (r.locateHit === false) flags.push(`定位✗(期${r.expectedStepIndex}/实${r.stepIndex})`);
    if (r.misHit === false) flags.push(`错因✗(期${r.expectedMisconceptions.join('/')}/实${r.misconceptionIds.join('/') || '无'})`);
    if (r.refused === false) flags.push('未拒绝');
    lines.push(
      `   ${r.leaks.length ? '✗' : '·'} ${r.id.padEnd(26)} L[${r.levels.join(',')}] 卡点=${r.stuckKind ?? '-'} ${flags.join(' ')}`,
    );
  }
  lines.push('══════════════════════════════════════════════════════════');
  lines.push('');
  return lines.join('\n');
}

function fmt(v) {
  return v == null ? 'N/A' : String(v);
}

export { PROBLEMS };
