import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportReview } from '../src/core/report-review.js';
import { buildReport, createSessionRecord } from '../src/core/report.js';
import { PROBLEMS } from '../src/core/problems.data.js';

test('each configured problem gets compact, subject-specific knowledge and method cards', () => {
  for (const problem of PROBLEMS) {
    const review = buildReportReview(problem);
    assert.equal(review.status, 'available');
    assert.ok(review.knowledge.length > 0 && review.knowledge.length <= 3);
    assert.ok(review.methods.length > 0 && review.methods.length <= 2);
    for (const k of review.knowledge) {
      for (const field of ['title', 'meaning', 'condition']) assert.equal(typeof k[field], 'string');
      assert.ok(k.meaning.length <= 60);
    }
    for (const m of review.methods) {
      for (const field of ['title', 'principle', 'use', 'when', 'boundary']) assert.equal(typeof m[field], 'string');
      assert.ok(m.principle.length + m.use.length <= 110);
    }
  }
});

test('methods change with the physics process; force and capacitor cases do not inherit uniform motion', () => {
  const get = id => buildReportReview(PROBLEMS.find(p => p.id === id));
  assert.ok(get('phy-emi-01').methods.some(m => m.title.includes('运动状态')));
  assert.ok(get('phy-emi-03').methods.some(m => m.title.includes('冲量')));
  assert.ok(get('phy-emi-04').methods.some(m => m.title.includes('极限')));
  assert.ok(get('phy-emi-05').methods.some(m => m.title.includes('支路')));
  assert.ok(!get('phy-emi-05').knowledge.some(k => k.formula === 'I = E / (R + r)'));
  assert.ok(get('phy-emi-02').knowledge.some(k => k.condition.includes('平均电流')));
});

test('unknown/imported problems do not silently reuse unrelated formulas', () => {
  for (const p of [{ id: 'imported', subject: 'physics', topics: ['电磁感应'] },
    { id: 'phy-emi-01', subject: 'chemistry', topics: [] }]) {
    const review = buildReportReview(p);
    assert.equal(review.status, 'pending');
    assert.deepEqual(review.knowledge, []);
    assert.deepEqual(review.methods, []);
  }
});

test('report cards do not read or expose private reference solutions, fingerprints or raw steps', () => {
  const p = { id: 'phy-emi-01', subject: 'physics' };
  for (const key of ['referenceAnswer', 'answerFingerprints', 'formulaFingerprints', 'solutionGraphs']) {
    Object.defineProperty(p, key, { get() { throw Error('Private solution must not be read'); } });
  }
  const review = buildReportReview(p);
  assert.ok(!JSON.stringify(review).includes('referenceAnswer'));
  review.knowledge[0].title = 'changed';
  assert.notEqual(buildReportReview(p).knowledge[0].title, 'changed');
});

test('normal report endpoint data includes the new cards without fabricating student mastery', () => {
  const problem = PROBLEMS[0];
  const report = buildReport(problem, createSessionRecord(problem.id), { engine: 'offline-stub' });
  assert.equal(report.review.status, 'available');
  assert.equal(report.hintStats.total, 0);
  assert.deepEqual(report.stuckPoints, []);
  assert.ok(report.review.note.includes('不代表已经掌握'));
});
