/**
 * 关键点链 → solutionGraphs。
 *
 * 为什么单独一个模块：题库题的辅导路径过去是 heuristicSkeleton 写死的通用六步
 * （intake.js:494），跟题目无关。这里改成 "官方解析 → 关键点链 → 图谱"，
 * 步数由题目自己决定（2~6）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKeysteps, keystepsToGraphs } from '../src/core/keysteps.js';

const OK = [
  { title: '取整体避开绳拉力', type: '模型选择', judge: '把小车和桶砂取整体', why: '整体法消去绳的内力', do: '对整体列牛顿第二定律', expr: 'a=\\frac{mg}{M+m}', cues: ['整体', '一起看', '当成一个'] },
  { title: '求绳的拉力', type: '关系建立', judge: '小车实际受的拉力不等于桶砂重力', why: '桶砂有向下加速度，处于失重', do: '隔离桶砂列方程解 T', expr: 'T=\\frac{M}{M+m}mg', cues: ['拉力', '绳的力'] },
  { title: '取近似条件', type: '近似条件', judge: '只有 m 远小于 M 才能把 T 近似成 mg', why: 'M 远大于 m 时系数趋近 1', do: '对 T 的表达式取极限', expr: 'm\\ll M', cues: ['远小于', '近似', '忽略质量'] },
];

test('normalizeKeysteps 保留题目给的顺序，并把 index 编成从 1 开始', () => {
  const steps = normalizeKeysteps(OK);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((s) => s.index), [1, 2, 3]);
  assert.equal(steps[0].title, '取整体避开绳拉力');
  assert.equal(steps[0].why, '整体法消去绳的内力');
  assert.equal(steps[0].expr, 'a=\\frac{mg}{M+m}');
});

test('normalizeKeysteps 拒绝少于两个关键点：一道题至少两道坎', () => {
  assert.throws(() => normalizeKeysteps([OK[0]]), /至少/);
  assert.throws(() => normalizeKeysteps([]), /至少/);
});

test('normalizeKeysteps 拒绝缺少判断依据的条目，而不是静默补空串', () => {
  assert.throws(() => normalizeKeysteps([OK[0], { ...OK[1], judge: '' }]), /judge/);
  assert.throws(() => normalizeKeysteps([OK[0], { ...OK[1], why: '   ' }]), /why/);
});

test('normalizeKeysteps 剔除过短过长的 cue，好的 cue 原样保留', () => {
  const dirty = normalizeKeysteps([
    { ...OK[0], cues: ['太', '这个cue明显超过了十个字的上限所以必须被丢掉'] },
    OK[1],
  ]);
  assert.ok(dirty[0].cues.length >= 1, JSON.stringify(dirty[0].cues));
  for (const c of dirty[0].cues) assert.ok(c.length >= 2 && c.length <= 10, c);

  const clean = normalizeKeysteps(OK);
  assert.deepEqual(clean[0].cues, ['整体', '一起看', '当成一个']);
  assert.ok(clean[0].cues.length <= 6);
});

test('keystepsToGraphs 把中文关键点类型映射成引擎认识的 kind', () => {
  const [graph] = keystepsToGraphs(OK);
  assert.deepEqual(graph.steps.map((s) => s.kind), ['identify', 'apply', 'precondition', 'conclude']);
  assert.deepEqual(graph.steps.map((s) => s.index), [1, 2, 3, 4]);
  assert.equal(graph.steps[0].intent, '把小车和桶砂取整体');
});

test('keystepsToGraphs 在末步不是收尾时补一个收尾步，且末步必须是 conclude', () => {
  const [graph] = keystepsToGraphs(OK);
  assert.equal(graph.steps.length, 4);
  assert.equal(graph.steps.at(-1).kind, 'conclude');
  assert.ok(graph.steps.at(-1).cues.length >= 2);
});

test('keystepsToGraphs 末步已经是收尾时不重复追加', () => {
  const [graph] = keystepsToGraphs([OK[0], { ...OK[1], type: '数学处理' }, { ...OK[2], type: '结论整理' }]);
  assert.equal(graph.steps.length, 3);
  assert.equal(graph.steps.at(-1).kind, 'conclude');
});

test('keystepsToGraphs 把"前提类"关键点抬成路径前提，给读题提示用', () => {
  const [graph] = keystepsToGraphs([
    { ...OK[0], type: '前提判断', judge: '先判断棒是否已经进入磁场' },
    OK[1],
  ]);
  assert.deepEqual(graph.preconditions, ['先判断棒是否已经进入磁场']);
});

test('keystepsToGraphs 认不出的类型退化成 apply，不丢这一步', () => {
  const [graph] = keystepsToGraphs([{ ...OK[0], type: '火星文' }, OK[1]]);
  assert.equal(graph.steps[0].kind, 'apply');
  assert.equal(graph.steps.length, 3);
});

// ---------------------------------------------------------------------------
// 关键点抽取的提示词与回复解析
//
// 835 题要跑一遍，模型回复的脏数据必须在这一层挡住：
// 它会给围栏、会换 key 名（实测把 keysteps 写成"关键点链"）、也会在 JSON 前后写解释。
// ---------------------------------------------------------------------------

import { buildKeystepsPrompt, parseKeystepsReply } from '../src/core/keysteps-prompt.js';

const Q = {
  code: 'CQ-2024-13',
  ty: '计算',
  difficulty: 2,
  stem: '如图，金属棒 PQ 在导轨上匀速下滑……⟨式⟩',
  opt: '',
  analysis: '【详解】P 匀速下降说明整体加速度为零，取 P、Q 整体可避开导线拉力……',
};

test('parseKeystepsReply 认得裸 JSON', () => {
  const list = parseKeystepsReply('{"keysteps":[{"title":"取整体"}]}');
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '取整体');
});

test('parseKeystepsReply 扒得掉 markdown 围栏与前后解释', () => {
  const text = '好的，分析如下：\n```json\n{"keysteps":[{"title":"A"},{"title":"B"}]}\n```\n以上。';
  assert.deepEqual(parseKeystepsReply(text).map((k) => k.title), ['A', 'B']);
});

test('parseKeystepsReply 容忍模型自造的 key 名和裸数组', () => {
  assert.equal(parseKeystepsReply('{"关键点链":[{"title":"A"}]}').length, 1);
  assert.equal(parseKeystepsReply('[{"title":"A"},{"title":"B"}]').length, 2);
});

test('parseKeystepsReply 解析不出就报错，不静默返回空数组', () => {
  assert.throws(() => parseKeystepsReply('这道题的关键点有三个：'), /JSON/);
  assert.throws(() => parseKeystepsReply('{"keysteps":[]}'), /空/);
});

test('三种题型不是一套提示词通吃', () => {
  const calc = buildKeystepsPrompt({ ...Q, ty: '计算' });
  const choice = buildKeystepsPrompt({ ...Q, ty: '单选' });
  const lab = buildKeystepsPrompt({ ...Q, ty: '实验' });
  assert.notEqual(calc, choice);
  assert.notEqual(choice, lab);
  for (const p of [calc, choice, lab]) {
    assert.ok(p.includes(Q.stem), '题干要原样带上');
    assert.ok(p.includes(Q.analysis), '解析要原样带上');
  }
  // 实测踩过的坑：选择题被抽成"逐选项判断"，与计算题的推导链不同构
  assert.ok(choice.includes('选项'));
  assert.ok(calc.includes('推导'));
});

// ---------------------------------------------------------------------------
// 接进题库：题库题不该再用"通用六步骨架"糊弄
// ---------------------------------------------------------------------------

test('题库题用真实关键点链，graphQuality 不再自认骨架', async () => {
  const { QBANK_KEYSTEPS } = await import('../src/core/qbank-keysteps.data.js');
  const { getQbankProblem } = await import('../src/core/qbank.js');
  // 挑一道关键点 ≥3 的题来验"链条真的被接上"；
  // 2 个关键点也是合法链（末步本身就是收尾时不补步），别拿它当反例。
  const { QBANK_SOURCE } = await import('../src/core/qbank-source.data.js');
  // 还要题干里带公式占位：下面那条断言验的是"数值事实仍来自题干抽取"。
  const qbId = QBANK_SOURCE
    .filter((q) => (QBANK_KEYSTEPS[q.i] || []).length >= 3 && q.stemText.includes('〔式〕'))
    .map((q) => String(q.i))[0];
  assert.ok(qbId, '全库至少该有一道三个关键点以上、且带公式的题');
  const problem = getQbankProblem(`qbank-${qbId}`);

  assert.ok(problem, '题库题应该能造出来');
  assert.equal(problem.graphQuality, 'source-analysis-keypoints');
  const graph = problem.solutionGraphs[0];
  assert.ok(graph.steps.length >= QBANK_KEYSTEPS[qbId].length, '每个关键点都要变成一步');
  assert.equal(graph.steps.at(-1).kind, 'conclude', '末步必须是收尾');
  assert.ok(graph.steps[0].why, '每步要带"为什么这样做"');
  assert.ok(graph.steps[0].intent, 'intent 承接关键点判断');
  assert.ok(graph.steps[0].cues.length >= 2, 'cues 是定位通道的输入，不能空');
  assert.notEqual(graph.id, 'g-general', '不能还是通用骨架的 id');
  // 数值事实仍然来自题干抽取，不能被模型的关键点覆盖掉
  assert.equal(problem.stem.includes('〔式〕'), true);
});
