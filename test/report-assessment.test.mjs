import test from 'node:test';
import assert from 'node:assert/strict';
import { assessLearning } from '../src/core/report-assessment.js';
import { appendTurn, buildReport, createSessionRecord } from '../src/core/report.js';
import { PROBLEMS } from '../src/core/problems.data.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const p = PROBLEMS.find(x => x.id === 'phy-emi-01');
const log = (utterance, more={}) => ({utterance, graphId:p.solutionGraphs[0].id,
  stepIndex:4, deliveredLevel:0, form:'confirm', guardPassed:true, ...more});
const assess = (...hintLog) => assessLearning(p,{hintLog});
const circuit = a => a.knowledge.find(x => x.id === 'circuit');

test('untouched topics, questions, confusion and acknowledgements are not mastery or errors', () => {
  for (const utterance of ['', '不知道', '我不会', '懂了', 'I=E/R对吗？', '为什么不能用I=E/R？']) {
    const a=assess(log(utterance));
    assert.ok(a.knowledge.every(k => k.status === 'unknown'));
    assert.equal(a.accuracy.percent,null);
    assert.ok(!a.feedback.some(f => f.evidence.some(e => e.result === 'incorrect')));
  }
  assert.ok(assess(log('不知道')).feedback.length);
});

test('independent correct explanation is needed for mastery; correction demotes prior weakness', () => {
  assert.equal(circuit(assess(log('I=E/(R+r)'))).status,'consolidate');
  assert.equal(circuit(assess(log('因为导体棒电阻与R串联，所以I=E/(R+r)'))).status,'mastered');
  const help=log('I=E/R',{deliveredLevel:2,form:'direction'});
  const a=assess(help,log('I=E/R'),log('I=E/R'));
  assert.equal(circuit(a).status,'weak');
  const b=assess(help,log('I=E/R'),log('I=E/R'),log('因为内阻与外电阻串联，所以I=E/(R+r)'));
  assert.equal(circuit(b).status,'consolidate');
  assert.equal(b.feedback.find(f => f.id === 'circuit').status,'corrected');
});

test('one mistaken turn is not repeated evidence; corrections cannot clear a different concept', () => {
  const a=assess(log('先提示一下',{deliveredLevel:2,form:'direction'}),log('I=E/R；电阻只有R'));
  assert.equal(circuit(a).status,'consolidate');
  const b=assess(log('I=E/R'),log('因为匀速，所以合力为零',{stepIndex:6}));
  assert.equal(b.feedback.find(f=>f.id==='circuit').status,'pending');
});

test('first attempt accuracy keeps wrong first attempts and excludes help, questions, vague and ambiguous values', () => {
  assert.deepEqual(assess(log('E=0.3 V'),log('E=0.4 V'),log('I=1 A')).accuracy,
    {correct:1,total:2,percent:50});
  assert.equal(assess(log('E=0.4 V；E=0.4 V')).accuracy.total,1);
  assert.equal(assess(log('E=0.4 V；E=0.3 V')).accuracy.total,0);
  assert.equal(assess(log('E=0.4 V？')).accuracy.total,0);
  assert.equal(assess(log('0.4 V')).accuracy.total,0);
  assert.equal(assess(log('给提示',{deliveredLevel:2,form:'direction'}),log('E=0.4 V')).accuracy.total,0);
  const corrected=assess(log('E=0.3 V'),log('E=0.4 V'));
  assert.equal(corrected.feedback[0].status,'corrected');
  assert.equal(corrected.accuracy.percent,0);
});

test('assistant repetition is not independent evidence; unsupported problems remain unknown', () => {
  const a=assess(log('提示',{hintText:'因为串联，所以I=E/(R+r)'}),log('因为串联，所以I=E/(R+r)'));
  assert.equal(circuit(a).status,'unknown');
  const unknown=assessLearning({...p,id:'custom'},{hintLog:[log('因为串联，所以I=E/(R+r)')]});
  assert.equal(unknown.knowledge.length,0);
  assert.equal(unknown.accuracy.percent,null);
});

test('report API integration includes assessment without leaking reference answers', () => {
  const record=createSessionRecord(p.id);
  const a=buildReport(p,record,{engine:'offline-stub'});
  assert.equal(a.assessment.version,'evidence-v1');
  assert.equal(a.assessment.accuracy.total,0);
  assert.ok(!JSON.stringify(a.assessment).includes(p.referenceAnswer));
  const response={diagnosis:{position:{stepIndex:4,graphId:p.solutionGraphs[0].id},misconceptions:[],evidenceQuotes:[]},
    hint:{text:'提示',level:2,form:'direction'},meta:{guardHistory:[],guard:{passed:true}},message:'提示',suppressed:true};
  appendTurn(record,{utterance:'不知道',response,problem:p});
  assert.equal(record.hintLog[0].suppressed,true);
});

test('summary layout stays intact; frontend consumes server evidence instead of inferring mastery', () => {
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const start=html.indexOf('  function levelBuckets(rep)');
  const end=html.indexOf('  /** 仅渲染预定义公式',start);
  const c=vm.createContext({}); vm.runInContext(html.slice(start,end),c);
  assert.equal(c.levelBuckets({}).ok.length,0);
  assert.equal(c.levelBuckets({assessment:{knowledge:[{title:'电路',status:'unknown'}]}}).ok.length,0);
  assert.ok(html.includes('<h2>学习小结</h2>'));
  assert.ok(html.includes('<h2>卡点与改进</h2>'));
  for (const id of ['mCount','mAcc','mWeak','lvOk','lvWarn','lvBad']) assert.ok(html.includes(`id="${id}"`));
  const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  for (const [,body] of scripts) new vm.Script(body);
});

test('resolved concept does not hide another pending numeric answer; pending cards sort first', () => {
  const a=assess(log('I=E/R'),log('因为内阻与外电阻串联，所以I=E/(R+r)'),log('E=0.3 V'));
  assert.equal(a.feedback[0].id,'answer-0');
  assert.equal(a.feedback[0].status,'pending');
  assert.equal(a.feedback[1].status,'corrected');
});

test('hypothetical, quoted, contradictory or unexplained claims cannot become mastery', () => {
  for (const text of ['老师说I=E/R','如果I=E/R','I=E/R；I=E/(R+r)']) {
    assert.equal(circuit(assess(log(text))).status,'unknown');
  }
  assert.equal(circuit(assess(log('因为我记得，所以I=E/(R+r)'))).status,'consolidate');
  assert.equal(circuit(assess(log('I=E/R，现在改为I=E/(R+r)'))).status,'consolidate');
  assert.equal(assess(log('E=0.4 V+0.2 V')).accuracy.total,0);
});

test('rubric scope respects variable motion and capacitor circuits', () => {
  const assessOther=(id,utterance) => assessLearning(PROBLEMS.find(x => x.id===id),{hintLog:[log(utterance)]});
  assert.equal(assessOther('phy-emi-03','因为匀速，所以合力为零').knowledge.some(k=>k.status==='mastered'),false);
  assert.ok(assessOther('phy-emi-05','电容器不影响运动').feedback.some(f=>f.id==='capacitor-branches'));
  assert.equal(assessOther('phy-emi-05','I=E/(R+r)').knowledge.some(k=>k.id==='circuit'),false);
});
