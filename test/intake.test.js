/**
 * 题目导入（intake）测试。
 *
 * 这个套件守的是"任意新题目"这条路的三条红线：
 *   ① 题干原文必须原样保留（模型不许改写学生看到的题）
 *   ② 答案指纹必须**只在答案位置**命中（否则守卫会疯狂误拦正常提示）
 *   ③ 没有模型时也能降级跑通，且降级是显式可见的（warnings 不为空）
 *
 * ② 的用例来自一次真实事故：模型把题干里的"落地前 1 s"写进了 answerFingerprints，
 * 结果引擎连题目里的那 1 秒都不许说，所有提示被拦成兜底模板。
 * 这类 bug 不会报错，只会让产品变得又笨又啰嗦 —— 所以必须固化成断言。
 */

import { describe, it, assert, assertEquals, assertIncludes } from './runner.js';
import {
  understandProblem,
  normalizeIntake,
  heuristicSkeleton,
  fingerprintProblemId,
  deriveAnswerFingerprints,
  dropFingerprintsMatchingStem,
  sanitizeFingerprints,
  inferSubject,
  extractGivens,
  extractAsked,
} from '../src/core/intake.js';
import { guard } from '../src/core/guard.js';
import { createEngine } from '../src/core/engine.js';
import { createOfflineAdapter } from '../src/core/llm.js';

const STEM = `质量为 0.5 kg 的小球从高 h = 20 m 处由静止开始自由下落，不计空气阻力，g 取 10 m/s²。
求：(1) 小球落地时的速度大小；(2) 小球在落地前 1 s 内下落的高度。`;

/** 模拟一次"模型读题"的输出（结构完整、但故意埋了两个坑） */
function modelOutput(overrides = {}) {
  return {
    subject: 'physics',
    topics: ['自由落体运动', '匀变速直线运动'],
    difficulty: 2,
    summary: '求自由落体的落地速度与最后 1 s 内的高度',
    givens: ['m = 0.5 kg', 'h = 20 m', 'g = 10 m/s²'],
    asked: ['落地速度 v', '落地前 1 s 内下落的高度'],
    referenceAnswer: '由 h=½gt² 得总时间 t = 2 s，故 v = gt = 20 m/s；落地前 1 s 内下落高度 Δh = 15 m。',
    solutionGraphs: [
      {
        id: 'g1',
        name: '自由落体公式路径',
        preconditions: ['初速度为零', '只受重力'],
        steps: [
          {
            index: 1,
            title: '明确已知条件与待求量',
            kind: 'setup',
            intent: '分清给了什么、要求什么',
            concepts: ['已知条件'],
            cues: ['已知', '条件', '要求'],
          },
          {
            index: 2,
            title: '由总高度求落地总时间',
            kind: 'apply',
            intent: 'h = ½gt² 解出 t',
            concepts: ['自由落体运动'],
            cues: ['总时间', 'h=½gt²', '下落时间'],
          },
          {
            index: 3,
            title: '由总时间求落地速度',
            kind: 'apply',
            intent: 'v = gt',
            concepts: ['速度与时间关系'],
            cues: ['落地速度', 'v=gt'],
          },
          {
            index: 4,
            title: '求落地前 1 s 内的高度',
            kind: 'derive',
            intent: '用前后高度作差',
            concepts: ['时间区间'],
            cues: ['落地前', '作差', '时间段'],
          },
          {
            index: 5,
            title: '得出结果并检查单位',
            kind: 'conclude',
            intent: '给出 v 与 Δh',
            concepts: ['结果检查'],
          },
        ],
      },
    ],
    misconceptions: [
      {
        id: 'm-last-second',
        label: '把"落地前 1 s 内"当成"总的 1 s"',
        signature: ['直接用1s算', '前1秒就是总共1秒'],
        rootCause: '没有把时间区间和总时间区分开',
        hintSeeds: ['这 1 秒是从哪一时刻开始的？'],
      },
    ],
    // 坑 1：把题干里的 1 s 当成了答案指纹
    answerFingerprints: ['1\\s*s', '20\\s*m/s', '15\\s*m'],
    formulaFingerprints: ['h\\s*=\\s*1/2\\s*g\\s*t'],
    solutionInsights: ['作差', '两个时刻之间'],
    ...overrides,
  };
}

describe('读题 · 结构化归一', () => {
  it('题干原样保留，不被模型改写（学生看到的必须是他自己贴的那段）', () => {
    const { problem } = normalizeIntake(modelOutput({ stem: '模型擅自改写的题干' }), STEM);
    assertEquals(problem.stem, STEM.trim(), '题干必须是原文');
  });

  it('步骤号被重排为 1..n 连续，且末步强制为 conclude', () => {
    const out = modelOutput();
    // 模型常见的两种坏输出：0 起编号、末步忘了写 conclude
    out.solutionGraphs[0].steps.forEach((s, i) => {
      s.index = i;
    });
    out.solutionGraphs[0].steps[3].kind = 'apply';
    const { problem } = normalizeIntake(out, STEM);
    const steps = problem.solutionGraphs[0].steps;
    assertEquals(steps.map((s) => s.index).join(','), '1,2,3,4,5', '步骤号必须连续从 1 开始');
    assertEquals(steps[steps.length - 1].kind, 'conclude', '末步必须是 conclude，否则引擎永远不认为学生接近完成');
  });

  it('非法 kind 被替换为 apply，不会让 route 的按步派发失效', () => {
    const out = modelOutput();
    out.solutionGraphs[0].steps[0].kind = 'thinking';
    const { problem } = normalizeIntake(out, STEM);
    assertEquals(problem.solutionGraphs[0].steps[0].kind, 'apply');
  });

  it('缺失 cues 时自动补齐（否则关键词定位通道对这一步永久失效）', () => {
    const out = modelOutput();
    out.solutionGraphs[0].steps[1].cues = [];
    const { problem } = normalizeIntake(out, STEM);
    assert(problem.solutionGraphs[0].steps[1].cues.length >= 1, 'cues 必须兜底补齐');
  });

  it('题目 id 由题干内容哈希决定：同一道题两次导入得到同一个 id', () => {
    const a = fingerprintProblemId(STEM);
    const b = fingerprintProblemId(`  ${STEM}  `);
    const c = fingerprintProblemId(`${STEM}（改一个条件）`);
    assertEquals(a, b, '首尾空白不应改变 id');
    assert(a !== c, '不同题目应有不同 id');
    assert(a.startsWith('imp-'), 'id 应带 imp- 前缀以示来源');
  });

  it('学科推断：物理 / 数学 / 化学各能判对', () => {
    assertEquals(inferSubject('小球沿斜面下滑，摩擦力做功'), 'physics');
    assertEquals(inferSubject('证明 √2 是无理数，设它为互质的两个整数之比'), 'math');
    assertEquals(inferSubject('求 0.1 mol/L 盐酸溶液的 pH 与氢离子浓度'), 'chemistry');
  });

  it('抽已知量与待求量：模型没给时用规则兜底', () => {
    const givens = extractGivens(STEM);
    assert(givens.some((g) => g.includes('20')), `应抽出 h = 20 m，实际：${JSON.stringify(givens)}`);
    const asked = extractAsked(STEM);
    assert(asked.length > 0, '应抽出待求量');
  });
});

describe('读题 · 答案指纹（守卫的比对基准）', () => {
  it('能把题干里已有的数值从答案指纹里剔掉（真实事故的固化）', () => {
    const dropped = dropFingerprintsMatchingStem(['1\\s*s', '20\\s*m/s', '15\\s*m'], STEM);
    assertEquals(dropped.join('|'), '20\\s*m/s|15\\s*m', '题干里的 "1 s" 必须被剔除，20 m/s 与 15 m 保留');
  });

  it('从参考答案反推指纹时，也排除题干出现过的数值', () => {
    const fps = deriveAnswerFingerprints(
      '总时间 t = 2 s，落地速度 v = 20 m/s，最后 1 s 内下落 15 m。',
      ['h = 20 m'],
      STEM,
    );
    const joined = fps.join(' | ');
    // 题干里没有出现过的"2 s"是模型算出来的中间量 ⇒ 保留（L3 也不该直接报出来）
    assert(joined.includes('2'), `应保留参考答案里题干未出现的中间量，实际：${joined}`);
    // 题干里的 20 m 与 1 s ⇒ 已知量，不得作为答案指纹
    assert(!fps.some((f) => f.startsWith('20')), `题干里的 20 不应成为答案指纹，实际：${joined}`);
    assert(!fps.some((f) => f.startsWith('1\\s')), `题干里的 1 s 不应成为答案指纹，实际：${joined}`);
    // 真正的答案（15 m）必须留下
    assert(fps.some((f) => f.startsWith('15')), `真正的答案 15 m 必须留下，实际：${joined}`);
  });

  it('过泛的指纹被丢弃（否则会误伤每一句正常提示）', () => {
    const warnings = [];
    const kept = sanitizeFingerprints(['20\\s*m/s', '\\d', '.*', 'a'], warnings, 'test');
    assertEquals(kept.join('|'), '20\\s*m/s', '只有具名的指纹应该留下');
    assert(warnings.length > 0, '丢弃过泛指纹时必须记 warning，不能静默');
  });

  it('缺参考答案 + 缺指纹时会显式告警，而不是假装安全', () => {
    const warnings = [];
    const out = modelOutput({ referenceAnswer: '', answerFingerprints: [] });
    const { problem } = normalizeIntake(out, STEM, { warnings });
    assertEquals(problem.answerFingerprints.length, 0);
    assert(
      warnings.some((w) => w.includes('答案指纹')),
      `必须告警"数值防泄题对本失效"，实际告警：${JSON.stringify(warnings)}`,
    );
  });
});

describe('读题 · 降级路径', () => {
  it('没有读题能力时返回通用骨架，并明确告警（不假装读懂了）', async () => {
    const res = await understandProblem(STEM, {});
    assertEquals(res.usedModel, false);
    assert(res.warnings.length > 0, '降级必须留下可审计的告警');
    assert(res.problem.solutionGraphs[0].steps.length >= 4, '骨架也要有可用的步骤');
    assertEquals(res.problem.source, 'imported');
    assertEquals(res.problem.topics.length > 0, true, '至少要有一个知识点标签');
  });

  it('模型抛错时同样降级，且把错误原因写进告警', async () => {
    const failing = {
      kind: 'llm',
      async understandProblem() {
        throw new Error('模拟读题超时');
      },
    };
    const res = await understandProblem(STEM, { adapter: failing });
    assertEquals(res.usedModel, false);
    assertIncludes(res.warnings.join('\n'), '模拟读题超时', '告警里要能看到真实原因');
  });

  it('题干太短直接拒绝，不做无意义的读题', async () => {
    let threw = false;
    try {
      await understandProblem('求 v', {});
    } catch {
      threw = true;
    }
    assert(threw, '过短的输入应该抛错');
  });

  it('启发式骨架的末步也是 conclude（report 依赖这个不变量）', () => {
    const sk = heuristicSkeleton(STEM, null);
    const steps = sk.solutionGraphs[0].steps;
    assertEquals(steps[steps.length - 1].kind, 'conclude');
  });
});

describe('读题 · 与守卫/引擎的联调', () => {
  it('导入题目的答案仍会被守卫拦住', async () => {
    const { problem } = normalizeIntake(modelOutput(), STEM);
    const leaked = guard('这道题落地速度是 20 m/s，最后 1 s 内下落 15 m。', problem, 1, {});
    assert(!leaked.passed, '导出题目的答案必须被拦住');
    assert(
      leaked.violations.some((v) => v.kind === 'answer_in_text'),
      `应命中 answer_in_text，实际：${JSON.stringify(leaked.violations.map((v) => v.kind))}`,
    );
  });

  it('引用题干的已知量不算泄题（守卫不能被训练成"什么都不许说"）', () => {
    const { problem } = normalizeIntake(modelOutput(), STEM);
    const ok = guard('题目给了 h = 20 m 和 g = 10 m/s²，你先看这两个量能求出什么？', problem, 1, {});
    assert(ok.passed, `引用题干已知量不应被拦，实际违规：${JSON.stringify(ok.violations)}`);
  });

  it('导入题目走完整引擎链路：不崩、不泄题、且给出层级', async () => {
    const { problem } = normalizeIntake(modelOutput(), STEM);
    const engine = createEngine({ adapter: createOfflineAdapter(), problem });
    const res = await engine.handleTurn({
      problemId: problem.id,
      utterance: '我用 h=½gt² 算出总时间 2 s，再用 v=gt 求落地速度',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assert(res.hint.level >= 1, '应给出一个层级');
    assert(res.meta.guard.passed, '出口必须通过守卫');
    assert(!res.message.includes('20 m/s'), '给学生的话里不能出现答案');
    assert(!res.message.includes('15 m'), '给学生的话里不能出现答案');
    assertEquals(res.diagnosis.trace.length > 0, true, '必须留下可解释的 trace');
  });

  it('导入题目的学生版判断链路带"读题"一步，且不含任何内部字段', async () => {
    const { problem } = normalizeIntake(modelOutput(), STEM);
    const engine = createEngine({ adapter: createOfflineAdapter(), problem });
    const res = await engine.handleTurn({
      problemId: problem.id,
      utterance: '我不会',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    const text = JSON.stringify(res.enginePath);
    assertIncludes(text, '读题', '导入题应显示读题这一步');
    for (const forbidden of ['precondition_gap', 'confidence', '错因', '守卫', '指纹']) {
      assert(!text.includes(forbidden), `学生版判断链路不应出现内部字段「${forbidden}」：${text}`);
    }
  });

  it('自主训练模式下不主动介入（学生没求助时静默）', async () => {
    const { problem } = normalizeIntake(modelOutput(), STEM);
    const engine = createEngine({ adapter: createOfflineAdapter(), problem });
    const res = await engine.handleTurn({
      problemId: problem.id,
      utterance: '我先想想，用自由落体公式应该可以',
      history: [],
      mode: 'self_training',
      explicitHelpSeeking: false,
    });
    assertEquals(res.suppressed, true, '自主训练模式下没有求助就不应主动给提示');
    assert(!res.message.includes('20'), '静默回复也不许带答案');
  });
});
