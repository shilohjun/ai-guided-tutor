import test from 'node:test';
import assert from 'node:assert/strict';
import {assessLearning} from '../src/core/report-assessment.js';
import {numericAttempts} from '../src/core/learning-evidence.js';
import {buildReport,reportEvidenceRevision} from '../src/core/report.js';
import {getQbankProblem} from '../src/core/qbank.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {buildLearningSummary} from '../src/core/report-priority.js';
const problem={id:'import-work',source:'imported',subject:'physics',topics:['功与功率'],
  stem:'物体匀速向右运动，水平向右的恒力10 N，3 s内位移6 m。求拉力的功与功率。',
  asked:['拉力做的功','拉力的功率'],givens:[],solutionGraphs:[],misconceptions:[],referenceAnswer:'W=60 J；P=20 W'};
const log=(utterance,more={})=>({utterance,form:'confirm',deliveredLevel:0,guardPassed:true,...more});
const analyze=(...hintLog)=>assessLearning(problem,{hintLog});

test('corrected weaknesses stay visible as history pending independent validation',()=>{
  const a=analyze(log('匀速所以拉力不做功',{form:'direction',deliveredLevel:2,hintText:'合力为零不代表拉力不做功。'}),
    log('匀速说明合力做功为零，但拉力做正功'));
  const w=a.weaknesses.find(w=>w.id==='work-net');
  assert.equal(w.state,'corrected_pending_independent_check');assert.equal(w.independentValidation,'not_recorded');
  assert.equal(a.knowledge.find(k=>k.id==='work-net').status,'consolidate','current performance remains distinct from historical difficulty');
  assert.equal(a.priorityFocus.id,'work-net');assert.ok(!a.priorityFocus.title.includes('已修正'));
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const start=html.indexOf('  function levelBuckets(rep)'),end=html.indexOf('  /** 仅渲染预定义公式',start);
  const ctx=vm.createContext({});vm.runInContext(html.slice(start,end),ctx);
  const buckets=ctx.levelBuckets({assessment:a});
  assert.equal(buckets.bad.length,1);assert.match(buckets.bad[0],/已修正.*独立验证/);
  assert.ok(!buckets.warn.some(x=>x.includes('合力做功与单个力做功')),'a historical weakness is not duplicated in two rows');
  assert.equal(buckets.ok.length,0);
});

test('top focus prefers an unresolved mistake over a corrected historical weakness',()=>{
  const summary=buildLearningSummary({knowledge:[
    {id:'fixed',title:'已修正概念',corrected:true,status:'consolidate',evidence:[{result:'incorrect',quote:'旧错误',turn:0},{result:'correct',quote:'新解释',turn:2}]},
    {id:'open',title:'当前错误概念',status:'weak',evidence:[{result:'incorrect',quote:'当前错误',turn:3}]}
  ]});
  assert.equal(summary.priorityFocus.id,'open');assert.equal(summary.weaknesses.length,2);
});

test('help alone cannot invent a historical weakness and unsupported mastery stays empty',()=>{
  const a=analyze(log('这一步用哪个公式？',{form:'direction',deliveredLevel:2,hintText:'恒力同向时W=Fs'}),log('因为恒力与位移同向，所以W=Fs'));
  assert.equal(a.weaknesses.length,0);assert.equal(a.priorityFocus.id,'work-formula');
  assert.ok(!a.knowledge.some(k=>k.status==='mastered'));
  const b=analyze(log('不知道'));
  assert.equal(b.weaknesses.length,0);assert.ok(!b.knowledge.some(k=>k.status==='mastered'));
});

test('answer errors remain in historical weaknesses even when concept evidence is also present',()=>{
  const p={...problem,referenceVerified:true};
  const a=assessLearning(p,{hintLog:[log('W=0 J'),log('因为恒力与位移同向，所以W=Fs=60 J')]});
  assert.ok(a.weaknesses.some(w=>w.id==='answer-0'&&w.corrected));
});

test('the report keeps its layout while the headline and empty messages are explicit',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.ok(html.includes('本次最需巩固'));assert.ok(!html.includes('<span>薄弱知识点</span>'));
  for(const text of ['本次尚无独立掌握证据','本次未记录明确错误'])assert.ok(html.includes(text));
  for(const id of ['mWeak','lvOk','lvWarn','lvBad','wrongList'])assert.ok(html.includes(`id="${id}"`));
});

test('real oral hints demote later explanations and close the corresponding help request',()=>{
  const a=analyze(
    log('匀速运动，所以拉力做功是0 J，功率也是0 W，对吗？',{form:'direction',deliveredLevel:1,
      hintText:'匀速说的是合力为零，可拉力本身的功要看方向。'}),
    log('我还是不会，这一步应该用哪个公式？',{form:'direction',deliveredLevel:1,
      hintText:'拉力和位移都向右，同向的恒力做功，用力乘位移这个关系就够。'}),
    log('还是不懂，能再具体一点吗？',{form:'direction',deliveredLevel:1,
      hintText:'拉力10 N一直向右，物体向右走了6 m。功率只是把这个功摊到3 s里看快慢。'}),
    log('因为拉力是恒力且与位移同向，所以W=Fs=10×6=60 J。平均功率是这段时间内功与时间的比值，P=W/t=60/3=20 W。匀速说明合力做功为零，但拉力做正功，其他力做负功。'));
  assert.equal(a.knowledge.find(k=>k.id==='work-formula').state,'completed_with_hint');
  assert.equal(a.knowledge.find(k=>k.id==='power-average').state,'completed_with_hint');
  assert.ok(!a.knowledge.some(k=>k.status==='mastered'));
  assert.equal(a.feedback.find(f=>f.id==='process-law').status,'corrected');
  assert.ok(a.feedback.find(f=>f.id==='process-law').evidence.some(e=>e.result==='correct'));
  assert.ok(!a.knowledge.find(k=>k.id==='process-law').title.includes('待核验'));
});

test('general encouragement and another topic hint do not demote formula mastery',()=>{
  const a=analyze(log('不会',{form:'direction',deliveredLevel:1,hintText:'别着急，慢慢想。'}),
    log('因为恒力与位移同向，所以W=Fs'));
  assert.equal(a.knowledge.find(k=>k.id==='work-formula').status,'mastered');
});

test('describing force and displacement conditions orally also counts as substantive support',()=>{
  const a=analyze(log('我不会公式',{form:'direction',deliveredLevel:1,hintText:'做功看的是力和沿力方向的位移；平均功率就是这段功除以所用时间。'}),
    log('因为拉力是恒力且与位移同向，所以W=Fs。平均功率是功与时间的比值，所以P=W/t'));
  assert.equal(a.knowledge.find(k=>k.id==='work-formula').state,'completed_with_hint');
  assert.equal(a.knowledge.find(k=>k.id==='power-average').state,'completed_with_hint');
  assert.equal(a.feedback.find(f=>f.id==='process-law').status,'corrected');
});

test('power oral paraphrases consistently count as help without depending on connecting words',()=>{
  for(const hintText of ['平均功率就是功跟所用时间的比值','功率是功和对应时间的商','平均功率看单位时间做功多少']) {
    const a=analyze(log('不会功率公式',{form:'direction',deliveredLevel:1,hintText}),log('平均功率是功与时间的比值，所以P=W/t'));
    assert.equal(a.knowledge.find(k=>k.id==='power-average').state,'completed_with_hint',hintText);
  }
});

test('an early clarification request closes when later evidence explains its explicitly named concept',()=>{
  const a=analyze(log('做功和平均功率两问分别用什么公式？',{form:'clarify',hintText:'你是分不清它们各自跟哪些量有关吗？'}),
    log('对，我不知道怎么联系这些量，请给具体公式关系和适用条件',{form:'direction',deliveredLevel:2,hintText:'功看力和沿力方向的位移，平均功率是功除以对应时间，W=Fscosθ，P=W/t。'}),
    log('因为恒力与位移同向，所以W=Fs。平均功率是功与时间的比值，P=W/t'));
  assert.equal(a.feedback.find(f=>f.id==='process-law').status,'corrected');
  assert.equal(a.feedback.find(f=>f.id==='process-condition').status,'corrected');
});

test('explaining only work does not clear a request that also explicitly asks about power',()=>{
  const a=analyze(log('做功和平均功率两问分别用什么公式？',{form:'clarify',hintText:'你先说说自己的想法。'}),
    log('因为恒力与位移同向，所以W=Fs'));
  assert.equal(a.feedback.find(f=>f.id==='process-law').status,'pending');
});

test('unverified answers display submitted counts rather than a misleading zero completion score',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const begin=html.indexOf('  function reportCompletionSummary(c)'),end=html.indexOf('  /** 仅渲染预定义公式',begin);
  const ctx=vm.createContext({});vm.runInContext(html.slice(begin,end),ctx);
  const s=ctx.reportCompletionSummary({total:2,completed:0,answered:2,verifiable:0,pendingVerification:2});
  assert.equal(s.value,'2 / 2');assert.equal(s.unit,'问已作答');assert.match(s.detail,/待核验 2 问/);
  const verified=ctx.reportCompletionSummary({total:2,completed:1,answered:2,verifiable:2,independent:0,assisted:1});
  assert.equal(verified.value,'1 / 2');assert.equal(verified.unit,'问已核验完成');
});

test('explicit misconception in a verification question is recorded and later corrected',()=>{
  const first=log('匀速运动，所以拉力做功是0 J，功率也是0 W，对吗？');
  const a=analyze(first);
  assert.equal(a.knowledge.find(k=>k.id==='work-net').status,'weak');
  assert.match(a.feedback.find(f=>f.id==='work-net').finding,/合力/);
  const b=analyze(first,log('匀速说明合力做功为零，但拉力做正功，其他力总共做负功。'));
  const k=b.knowledge.find(k=>k.id==='work-net');
  assert.equal(k.status,'consolidate');assert.equal(k.corrected,true);
  const f=b.feedback.find(f=>f.id==='work-net');
  assert.equal(f.status,'corrected');assert.equal(f.evidence.length,2);
  assert.match(f.action,/匀速上升/);
});

test('a correct formula without conditions is consolidation, not mastery',()=>{
  const a=analyze(log('W=Fs'));
  assert.equal(a.knowledge.find(k=>k.id==='work-formula').status,'consolidate');
  const b=analyze(log('因为拉力是恒力且与位移同向，所以W=Fs'));
  assert.equal(b.knowledge.find(k=>k.id==='work-formula').status,'mastered');
});

test('formula suffixes, negated statements and a pure verification question do not become mastery or mistakes',()=>{
  for(const text of ['这个公式不适用，不能用W=Fs','匀速时拉力不做功吗？']) {
    const a=analyze(log(text));
    assert.ok(!a.knowledge.some(k=>k.status==='mastered'||k.status==='weak'),text);
  }
  for(const text of ['恒力同向，所以W=Fs²','平均功率P=W/t²'])assert.ok(!analyze(log(text)).knowledge.some(k=>k.status==='mastered'));
});

test('negation and replacement cannot turn a rejected formula into mastery',()=>{
  const a=analyze(log('平均功率不是P=W/t，而是P=Wt'));
  assert.equal(a.knowledge.find(k=>k.id==='power-average').status,'weak');
  assert.ok(a.feedback.some(f=>f.id==='power-average'));
  for(const text of ['P=W/t这个公式不对','平均功率并非P=W/t','功率不能用P=W/t'])
    assert.ok(!analyze(log(text)).knowledge.some(k=>k.status==='mastered'),text);
  assert.equal(analyze(log('因为拉力与位移并不同向，所以W=Fs')).knowledge.find(k=>k.id==='work-formula').status,'weak');
});

test('latest incorrect or unknown formula reopens prior mastery and keeps its history',()=>{
  const first=log('因为恒力与位移同向，所以W=Fs');
  const a=analyze(first,log('我改成W=F/s，因为应该用力除以位移'));
  assert.equal(a.knowledge.find(k=>k.id==='work-formula').status,'weak');
  assert.equal(a.feedback.find(f=>f.id==='work-formula').status,'pending');
  const b=analyze(first,log('我改成W=F+s/v'));
  assert.equal(b.knowledge.find(k=>k.id==='work-formula').status,'unknown');
  assert.equal(b.knowledge.find(k=>k.id==='work-formula').evidence.length,2);
  const c=analyze(first,log('我改成W=F/s'),log('因为恒力与位移同向，所以W=Fs'));
  assert.equal(c.feedback.find(f=>f.id==='work-formula').status,'corrected');
  const ambiguous=analyze(first,log('W=F/s；W=Fs'));
  assert.equal(ambiguous.knowledge.find(k=>k.id==='work-formula').status,'unknown');
});

test('a separate uncertain subquestion does not erase a valid work explanation',()=>{
  for(const text of ['因为恒力与位移同向，所以W=Fs；但我不确定功率怎么求',
    '因为恒力与位移同向，所以W=Fs，但我不确定功率怎么求']) {
    const a=analyze(log(text));
    assert.equal(a.knowledge.find(k=>k.id==='work-formula').status,'mastered',text);
    assert.ok(!a.knowledge.some(k=>k.id==='power-average'&&k.status==='mastered'));
  }
});

test('physics synonyms are recognized while the original evidence quote is retained',()=>{
  const quote='匀速说明合外力做功为零，但牵引力做正功';
  const a=analyze(log(quote)),k=a.knowledge.find(k=>k.id==='work-net');
  assert.equal(k.status,'mastered');assert.equal(k.evidence[0].quote,quote);
});

test('adjacent quantities and ordinary Chinese results keep their own answer binding',()=>{
  const p={...problem,referenceVerified:true};
  for(const text of ['W=60 J P=20 W','W=Fs=10×6=60 J P=W/t=60/3=20 W',
    '拉力做了60焦耳的功，平均功率是20瓦']) {
    const a=numericAttempts(p,[log(text)]);
    assert.equal(a.completion.completed,2,text);
    assert.equal(a.feedback.length,0,text);
  }
  const wrong=numericAttempts(p,[log('W=60 J P=30 W')]);
  assert.equal(wrong.subquestions[0].completed,true);
  assert.equal(wrong.subquestions[1].state,'still_incorrect');
});

test('help is counted before later evidence, not before the student statement in the same turn',()=>{
  const hint=log('不会算功',{form:'direction',deliveredLevel:2,hintText:'同向恒力做功W=Fs'});
  const a=analyze(hint,log('因为拉力恒定且与位移同向，所以W=Fs'));
  assert.equal(a.knowledge.find(k=>k.id==='work-formula').status,'consolidate');
  assert.equal(a.knowledge.find(k=>k.id==='work-formula').state,'completed_with_hint');
});

test('questions, quoted mistakes, vague confusion and absent evidence never invent weakness',()=>{
  for(const text of ['不知道','为什么匀速时拉力做功是0？','老师说匀速时拉力不做功','匀速时拉力做功不是0','匀速时拉力做功不为零']) {
    const a=analyze(log(text));
    assert.ok(!a.knowledge.some(k=>k.status==='weak'),text);
  }
  assert.ok(!analyze(log('不知道')).knowledge.some(k=>k.status==='mastered'));
});

test('unknown imported reference keeps explicit work and power attempts without grading them',()=>{
  const a=numericAttempts(problem,[log('拉力做功W=Fs=10×6=60 J；拉力功率P=W/t=60/3=20 W')]);
  assert.equal(a.completion.answered,2);assert.equal(a.completion.pendingVerification,2);
  assert.equal(a.completion.percent,null);assert.equal(a.completion.completed,0);
  assert.ok(a.subquestions.every(q=>q.answered&&!q.verifiable));
  assert.equal(a.feedback.length,0);
});

test('verified chained calculations update completion and preserve the first error',()=>{
  const p={...problem,referenceVerified:true};
  const a=numericAttempts(p,[log('W=0 J'),log('W=Fs=10×6=60 J；P=W/t=60/3=20 W')]);
  assert.equal(a.completion.completed,2);assert.equal(a.completion.percent,100);
  assert.equal(a.subquestions[0].corrected,true);
});

test('real photoelectric fixture is B; changing a selection does not endorse a wrong answer',()=>{
  const p=getQbankProblem('qbank-1');
  assert.equal(p.referenceAnswer.split('\n')[0],'B');
  const wrong=numericAttempts(p,[log('我选A'),log('我改选C，因为两种都发生光电效应')]);
  assert.equal(wrong.completion.completed,0);
  for(const text of ['我改选B','我现在改为B，因为只有铟符合条件','最终改成B']) {
    const a=numericAttempts(p,[log('我选A'),log(text)]);
    assert.equal(a.completion.completed,1,text);assert.equal(a.subquestions[0].corrected,true);
    assert.equal(a.accuracy.percent,0);
  }
});

test('copying AI praise or merely asserting both metals qualify is not concept mastery',()=>{
  const a=assessLearning(getQbankProblem('qbank-1'),{hintLog:[log('我改选C，因为光子能量大于锡和铟的逸出功，两种金属都能发生光电效应')]});
  assert.ok(!a.knowledge.some(k=>k.status==='mastered'));
});

test('report stores a deterministic evidence revision and never stores expected answers in assessment',()=>{
  const record={hintLog:[log('W=60 J')],turns:[],formulaCards:[]};
  const rep=buildReport(problem,record,{engine:'offline-stub'});
  assert.equal(rep.meta.evidenceRevision,reportEvidenceRevision(record));
  assert.notEqual(rep.meta.evidenceRevision,reportEvidenceRevision({...record,hintLog:[...record.hintLog,log('P=20 W')]}));
  assert.ok(!JSON.stringify(rep.assessment).includes(problem.referenceAnswer));
});
