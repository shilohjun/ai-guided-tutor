/**
 * 陌生题归类接线测试。
 *
 * 守的是"新题能落到既有知识树"这条路的三件事：
 *   ① 闭集：模型只能在检索候选里选，候选外的一律丢弃（不许发明树上没有的节点）
 *   ② 兜底：模型不说话时，用检索 top1；检索也不自信就留空，不硬塞
 *   ③ 可见：报告页拿到的是"位置卡"，只标位置，不编讲解
 *
 * 为什么"留空"要专门测：错的知识点会把学生带到错的地图上找路，
 * 比"不知道这题属于哪一章"坏得多。
 */

import { describe, it, assert, assertEquals, assertIncludes } from './runner.js';
import { normalizeIntake, understandProblem } from '../src/core/intake.js';
import { buildReportReview } from '../src/core/report-review.js';
import { QBANK_SOURCE } from '../src/core/qbank-source.data.js';

const STEM = '质量 m = 2 kg 的物块静止在水平面上，与地面间动摩擦因数 0.2，现用水平恒力 F = 10 N 拉物块，求 2 s 末速度。';

const CANDIDATES = {
  confident: true,
  methodConfident: true,
  leaves: [
    { id: 'k5', name: '受力分析与正交分解', path: '力学 · 相互作用 · 受力分析', count: 68, score: 42 },
    { id: 'k9', name: '牛顿运动定律的应用', path: '力学 · 牛顿运动定律 · 应用', count: 55, score: 31 },
  ],
  methods: [
    { id: 't1', name: '正向递推', family: '递推', score: 22 },
  ],
};

function modelSource(extra) {
  return {
    subject: 'physics',
    topics: ['牛顿第二定律'],
    solutionGraphs: [],
    referenceAnswer: '3 m/s',
    ...extra,
  };
}

describe('人工归一化：闭集归类', () => {
  it('模型在候选里选中的知识点会被采纳', () => {
    const { problem } = normalizeIntake(modelSource({ leafId: 'k9', methodIds: ['t1'] }), STEM, { candidates: CANDIDATES });
    assertEquals(problem.leafId, 'k9');
    assertEquals(problem.methodIds.join(','), 't1');
    assertEquals(problem.taxonomySource, 'model');
  });

  it('模型给出候选外的知识点会被丢弃并告警', () => {
    const warnings = [];
    const { problem } = normalizeIntake(modelSource({ leafId: 'k999' }), STEM, { candidates: CANDIDATES, warnings });
    assertEquals(problem.leafId, 'k5'); // 退回检索 top1
    assertEquals(problem.taxonomySource, 'lexical');
    assert(warnings.some((w) => w.includes('不在候选里')), warnings.join(' | '));
  });

  it('模型不说话时用检索 top1', () => {
    const { problem } = normalizeIntake(modelSource({}), STEM, { candidates: CANDIDATES });
    assertEquals(problem.leafId, 'k5');
    assertEquals(problem.methodIds.join(','), 't1');
    assertEquals(problem.taxonomySource, 'lexical');
  });

  it('检索不自信、模型也不说话时留空，不硬塞', () => {
    const warnings = [];
    const { problem } = normalizeIntake(modelSource({}), STEM, {
      candidates: { confident: false, methodConfident: false, leaves: [], methods: [] },
      warnings,
    });
    assertEquals(problem.leafId, null);
    assertEquals(problem.methodIds.length, 0);
    assertEquals(problem.taxonomySource, 'none');
    assert(warnings.some((w) => w.includes('没能归到既有知识树')), warnings.join(' | '));
  });

  it('没有候选（归类模块没加载出来）时照常建档', () => {
    const { problem } = normalizeIntake(modelSource({}), STEM, { candidates: null });
    assertEquals(problem.leafId, null);
    assertEquals(problem.taxonomySource, 'none');
    assert(problem.solutionGraphs.length > 0);
  });
});

describe('读题链路自动带上候选', () => {
  it('没有模型时也能用题干自动归类（懒加载可以跑通）', async () => {
    const q = QBANK_SOURCE.find((x) => x.knowledgeIds.length === 1 && x.stemText.length > 60);
    const res = await understandProblem(q.stemText, {});
    assertEquals(res.problem.leafId, q.knowledgeIds[0]);
    assertEquals(res.problem.taxonomySource, 'lexical');
  });

  it('模型收到的提示里带着候选清单', async () => {
    let seen = null;
    const adapter = {
      async understandProblem({ candidates }) {
        seen = candidates;
        // 模型照候选里第一个挑（这正是我们期望它在闭集内做选择的样子）
        return modelSource({ leafId: candidates.leaves[0].id });
      },
    };
    const res = await understandProblem(STEM, { adapter });
    assert(seen && seen.leaves.length > 0, '模型没收到候选');
    assertEquals(res.problem.leafId, seen.leaves[0].id);
  });
});

describe('报告页位置卡', () => {
  it('有 leafId 的陌生题返回 available 的知识/方法卡，但明确写着只定位不讲解', () => {
    const { problem } = normalizeIntake(modelSource({ leafId: 'k5', methodIds: ['t1'] }), STEM, { candidates: CANDIDATES });
    const review = buildReportReview(problem);
    assertEquals(review.status, 'available');
    assertEquals(review.knowledge[0].title, '受力分析与正交分解');
    assertIncludes(review.knowledge[0].meaning, '牛顿运动定律');
    assertIncludes(review.note, '不含讲解');
    assertEquals(review.methods[0].title, '正向递推');
    assert(review.methods[0].principle.length > 0, '方法卡缺原理');
  });

  it('没归类的陌生题仍是 pending，不编卡', () => {
    const review = buildReportReview({ id: 'imp-x', source: 'imported', subject: 'physics', leafId: null });
    assertEquals(review.status, 'pending');
    assertEquals(review.knowledge.length, 0);
  });
});

describe('陌生题的"巩固练习"能落到题库', () => {
  it('位置卡带 id，练习推荐就能按知识点捞题', async () => {
    const { buildReportPractice } = await import('../src/core/report-practice.js');
    const { problem } = normalizeIntake(modelSource({ leafId: 'k5', methodIds: ['t1'] }), STEM, { candidates: CANDIDATES });
    const review = buildReportReview(problem);
    const practice = buildReportPractice(problem, { feedback: [] }, review, {});
    const items = practice.knowledge.flatMap((b) => b.items);
    assert(items.length > 0, '背诵这一知识点的题一道都没捞到');
    assert(items.every((it) => typeof it.bankId === 'number'), '推荐项缺 bankId');
    assert(items[0].reason.includes('受力分析与正交分解') || items[0].reason.includes('知识标签'), items[0].reason);
  });
});

describe('读题卡住时必须能脱身', () => {
  it('模型不回包时按超时降级，而不是把请求挂死', async () => {
    const stuck = { understandProblem: () => new Promise(() => {}) };
    const startedAt = Date.now();
    const res = await understandProblem(STEM, { adapter: stuck, timeoutMs: 80 });
    assert(Date.now() - startedAt < 2000, '读题没有被超时切断');
    assert(res.warnings.some((w) => w.includes('超时')), res.warnings.join(' | '));
    assert(!res.usedModel, '超时了还说用了模型');
    assert(res.problem.solutionGraphs.length > 0, '超时后没有退回骨架');
  });
});
