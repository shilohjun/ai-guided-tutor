import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPersonalFeedback } from '../src/core/report-feedback.js';
import { buildReportReview } from '../src/core/report-review.js';
import { buildReport, createSessionRecord } from '../src/core/report.js';
import { PROBLEMS } from '../src/core/problems.data.js';
const p = PROBLEMS.find(p => p.id === 'phy-emi-01');
const record = (...texts) => ({ turns: texts.map(text => ({ role: 'student', text })) });
const get = (...texts) => buildPersonalFeedback(p, record(...texts), buildReportReview(p));

test('vague responses, questions without a concrete concept and inferred misconceptions do not become errors', () => {
  assert.equal(get('不知道','1','不','我的方向对吗','懂了').items.length,0);
  const r = record(); r.hintLog = [{ misconceptionIds: ['m-forget-r'], utterance: '不知道' }];
  assert.equal(buildPersonalFeedback(p,r,buildReportReview(p)).items.length,0);
});
test('a concrete difficulty gives one action and exact student evidence, not a generic label', () => {
  const f = get('有效长度怎么判断？');
  assert.equal(f.items.length,1); assert.equal(f.items[0].knowledgeKey,'cutting');
  assert.equal(f.items[0].evidence[0].quote,'有效长度怎么判断？');
  assert.ok(f.items[0].action.includes('标出')); assert.ok(!f.items[0].title.includes('错误'));
});
test('duplicate concerns merge and no more than two feedback items are returned', () => {
  const f = get('不知道有效长度怎么判断','有效长度还是不会','I=E/R','匀速就没有力');
  assert.equal(f.items.length,2); assert.equal(new Set(f.items.map(x=>x.id)).size,2);
  assert.equal(f.items[0].id,'effective-length');
});
test('an explicit corrected relation resolves the same concern; acknowledgement does not', () => {
  const a = get('I=E/R','懂了'); assert.equal(a.items[0].status,'needs_review');
  const b = get('I=E/R','总电阻是R+r'); assert.equal(b.items[0].status,'revised');
  assert.deepEqual(b.items[0].evidence.map(e=>e.round),[1,2]);
  const c = get('有效长度怎么判断','有效长度等于导轨间距'); assert.equal(c.items[0].status,'revised');
});
test('negated or uncertain corrections are not marked resolved', () => {
  for (const answer of ['总电阻不是R+r','总电阻是R+r吗？','总电阻不应该是R+r']) {
    assert.equal(get('I=E/R',answer).items.find(x=>x.id==='total-resistance').status,'needs_review');
  }
});
test('new difficulty is prioritized above earlier correction, and a concern can reopen', () => {
  const f=get('I=E/R','总电阻是R+r','有效长度怎么判断？');
  assert.equal(f.items[0].status,'needs_review'); assert.equal(f.items[1].status,'revised');
  assert.equal(get('I=E/R','总电阻是R+r','分母还是不确定').items[0].status,'needs_review');
});
test('correct material is not falsely diagnosed because a later clause expresses confusion', () => {
  assert.equal(get('有效长度等于导轨间距，但是下一步不会').items.length,0);
  assert.equal(get('匀速不代表不受力').items.length,0);
  assert.equal(get('匀速不是没有力，合力为零').items.length,0);
  assert.equal(get('你说I=E/R').items.length,0);
});
test('rules stay within known problem conditions; capacitor or unknown problems do not inherit a resistor check', () => {
  for (const problem of [{id:'uploaded',subject:'physics'},PROBLEMS.find(p=>p.id==='phy-emi-05')]) {
    assert.equal(buildPersonalFeedback(problem,record('I=E/R'),buildReportReview(problem)).items.length,0);
  }
});
test('feedback never includes private solution data or claims long-term mastery', () => {
  const problem={id:'phy-emi-01',subject:'physics'};
  Object.defineProperty(problem,'referenceAnswer',{get(){throw Error('Do not read solutions')}});
  const f=buildPersonalFeedback(problem,record('I=E/R'),buildReportReview(problem));
  assert.ok(!JSON.stringify(f).includes('referenceAnswer'));
  assert.ok(!JSON.stringify(f).includes('已经掌握'));
});
test('report includes feedback and independent knowledge cards as separate fields', () => {
  const r=createSessionRecord(p.id);r.turns=record('有效长度怎么判断？').turns;
  const result=buildReport(p,r,{engine:'offline-stub'});
  assert.equal(result.personalFeedback.items[0].knowledgeKey,'cutting');
  assert.equal(result.review.knowledge[0].formulaKey,'cutting');
  assert.equal(result.personalFeedback.questionCount,1);
});

test('a brief confused reply inherits the actual preceding question, with both pieces of evidence', () => {
  const r={turns:[{role:'ai',text:'这里的有效切割长度应该怎样选？'},{role:'student',text:'不知道'}]};
  const f=buildPersonalFeedback(p,r,buildReportReview(p));
  assert.equal(f.items[0].id,'effective-length');
  assert.equal(f.items[0].evidence[0].question,r.turns[0].text);
  r.turns.push({role:'ai',text:'你认为有效长度是哪一段？'},{role:'student',text:'导轨间距'});
  assert.equal(buildPersonalFeedback(p,r,buildReportReview(p)).items[0].status,'revised');
  assert.equal(get('导轨间距').items.length,0);
});
