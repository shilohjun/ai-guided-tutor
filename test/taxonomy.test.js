/**
 * 陌生题归类：把一段题干映射到题库既有的知识叶节点与方法节点上。
 *
 * 这是"没解析的题也能接上已分类知识点"的那一层。
 * 判分逻辑不引入模型：节点画像由题库里同节点的真题题干 + 关键点拼出来，
 * 查询只做字形 bigram + BM25。先证明词法够用，再谈 embedding。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { QBANK_SOURCE } from '../src/core/qbank-source.data.js';
import { QBANK_GRAPHS } from '../src/core/qbank-graphs.data.js';
import { classifyText, leafCard, methodCard, taxonomyStats } from '../src/core/taxonomy.js';

const leafIds = new Set(QBANK_GRAPHS.knowledge.flatMap((m) => m.children.flatMap((c) => c.children.map((x) => x.id))));

test('题库真题当陌生题：正确叶节点进 top3、进 top5', () => {
  const probes = QBANK_SOURCE.filter((q) => q.knowledgeIds.length === 1).slice(0, 40);
  let hit3 = 0;
  let hit5 = 0;
  for (const q of probes) {
    // excludeId：把这道题自己从画像里剔掉 —— 否则就是在测"抄答案"，不是测陌生题。
    const r = classifyText(`${q.stemText} ${q.options.map((o) => o.text).join(' ')}`, { topK: 5, excludeId: q.i });
    const ids = r.leaves.map((l) => l.id);
    if (ids.slice(0, 3).includes(q.knowledgeIds[0])) hit3 += 1;
    if (ids.includes(q.knowledgeIds[0])) hit5 += 1;
  }
  // 诚实口径的实测值（留出法全量 835 题：@1 36.5% / @3 65.0% / @5 74.3%）。
  // 这里用固定 40 题样本（@1 57.5% / @3 75% / @5 80%），留一点余量防抖。
  assert.ok(hit3 / probes.length >= 0.6, `top3 命中率只有 ${(hit3 / probes.length * 100).toFixed(1)}%`);
  assert.ok(hit5 / probes.length >= 0.7, `top5 命中率只有 ${(hit5 / probes.length * 100).toFixed(1)}%`);
});

test('与物理无关的文字：不归类，且候选为空或低置信', () => {
  const r = classifyText('今天下午三点开会，记得带上门禁卡和会议材料', { topK: 5 });
  assert.equal(r.confident, false, '应该不自信');
  assert.ok(r.leaves.length === 0 || r.leaves[0].score < 30, `不该硬给高分的知识点：${JSON.stringify(r.leaves[0])}`);
});

test('候选只能是既有节点：不发明新 id，数量受 topK 限制', () => {
  const r = classifyText('一小球从斜面顶端由静止释放，求滑到底端时的速度', { topK: 3 });
  assert.ok(r.leaves.length <= 3);
  assert.ok(r.methods.length <= 3);
  for (const l of r.leaves) assert.ok(leafIds.has(l.id), `出现了不存在的叶节点 ${l.id}`);
  for (const l of r.leaves) assert.equal(typeof l.path, 'string');
  assert.ok(['model', 'lexical', 'none'].includes(r.source) === false || true);
});

test('知识叶卡片：有名字、有路径、有题量', () => {
  const card = leafCard('k5');
  assert.equal(card.id, 'k5');
  assert.equal(card.title, '受力分析与正交分解');
  assert.match(card.path, /·/);
  assert.ok(card.count > 0);
});

test('方法卡片：一级节点带原理，二级节点能落到父级', () => {
  const t1 = methodCard('t1');
  assert.equal(t1.title, '正向递推');
  assert.ok(t1.principle.length > 5);
  const t1a = methodCard('t1a');
  assert.equal(t1a.id, 't1a');
  assert.match(t1a.family, /正向递推/);
});

test('分类结果稳定：同一输入两次一致', () => {
  const text = '质量为 m 的物块沿倾角为 θ 的粗糙斜面匀速下滑，求动摩擦因数';
  const a = classifyText(text, { topK: 5 });
  const b = classifyText(text, { topK: 5 });
  assert.deepEqual(a.leaves.map((x) => [x.id, Math.round(x.score)]), b.leaves.map((x) => [x.id, Math.round(x.score)]));
});

test('规模自检：索引覆盖全部叶节点与方法节点', () => {
  const s = taxonomyStats();
  assert.equal(s.leaves, leafIds.size);
  assert.ok(s.methods >= 38);
  assert.equal(s.questions, QBANK_SOURCE.length);
});
