import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROBLEMS } from '../src/core/problems.data.js';
import { numericAttempts } from '../src/core/learning-evidence.js';
import { buildReport,createSessionRecord } from '../src/core/report.js';
import { captureProblem } from '../src/server/problem-snapshot.js';
import { registerImportedProblem } from '../src/core/registry.js';
import { getQbankProblem } from '../src/core/qbank.js';
import { processFeedback } from '../src/core/report-process.js';
import vm from 'node:vm';
import { handleApi,requestEnv,sessions,getStore,__resetStoreForTests } from '../src/server/router.js';
import { createLiveSession,snapshotSession } from '../src/server/session-store.js';
const p=PROBLEMS.find(p=>p.id==='phy-emi-01');
const log=(utterance,more={})=>({utterance,form:'confirm',deliveredLevel:0,guardPassed:true,
  graphId:p.solutionGraphs[0].id,stepIndex:4,...more});

test('verified subquestions accumulate across turns and never count matching bare numbers',()=>{
  const a=numericAttempts(p,[log('E=0.4 V'),log('I=1 A'),log('F=0.2 N'),log('P=0.4 W')]);
  assert.equal(a.completion.complete,true);
  assert.equal(a.completion.completed,4);
  assert.equal(numericAttempts(p,[log('0.4 V，1 A')]).completion.completed,0);
  for(const text of ['E=0.4 V？','老师说E=0.4 V','如果E=0.4 V','E=0.4 V或0.3 V']) {
    assert.equal(numericAttempts(p,[log(text)]).completion.completed,0,text);
  }
  assert.equal(numericAttempts(p,[log('E=0.4 A')]).subquestions[0].state,'still_incorrect');
  assert.equal(numericAttempts(p,[log('E=4e-1 V')]).completion.completed,1);
});

test('a later wrong answer reopens the same question and retains its earlier correct evidence',()=>{
  const a=numericAttempts(p,[log('E=0.4 V'),log('E=0.3 V')]);
  assert.equal(a.subquestions[0].state,'still_incorrect');
  assert.equal(a.completion.completed,0);
  assert.equal(a.accuracy.percent,100,'first-attempt accuracy and final completion are distinct');
  assert.equal(a.feedback[0].status,'pending');
});

test('five states preserve help strength and corrected errors, without inventing mastery',()=>{
  for(const [level,state] of [[2,'completed_with_hint'],[3,'completed_after_demonstration']]) {
    const a=numericAttempts(p,[log('E=0.3 V'),log('请提示',{form:'direction',deliveredLevel:level}),log('E=0.4 V')]);
    assert.equal(a.subquestions[0].state,state);
    assert.equal(a.subquestions[0].everIncorrect,true);
    assert.equal(a.subquestions[0].corrected,true);
    assert.equal(a.feedback[0].status,'corrected');
    assert.equal(a.accuracy.percent,0);
    assert.equal(a.subquestions[1].state,'insufficient_evidence');
  }
});

test('choice evidence requires a complete explicit selection; uncertainty is not an answer',()=>{
  const choice={...p,source:'qbank',asked:[],referenceAnswer:'AC\n参考解析'};
  for(const text of ['我选AC','选择A、C','答案是A,C']) {
    assert.equal(numericAttempts(choice,[log(text)]).completion.complete,true,text);
  }
  for(const text of ['我选A还是C','是不是选AC？','参考答案AC','不选AC']) {
    assert.equal(numericAttempts(choice,[log(text)]).completion.completed,0,text);
  }
  const a=numericAttempts(choice,[log('选B'),log('我选AC')]);
  assert.equal(a.subquestions[0].corrected,true);
  assert.equal(a.accuracy.percent,0);
  assert.ok(!JSON.stringify(numericAttempts(choice,[])).includes('参考解析'));
});

test('unreviewed model-generated reference answers remain pending; visiting steps is not completion',()=>{
  const unknown={...p,id:'imported-unreviewed',source:'imported',reportReview:{knowledge:[],methods:[]}};
  const a=buildReport(unknown,{hintLog:[log('E=0.4 V')],turns:[]},{engine:'offline-stub'});
  assert.equal(a.assessment.accuracy.percent,null);
  assert.equal(a.assessment.completion.completed,0);
  assert.equal(a.independence.completedSteps,0);
  assert.ok(a.assessment.knowledge.every(k=>k.status!=='mastered'));
  const b=buildReport(p,{hintLog:[log('不知道',{stepIndex:6,form:'direction',deliveredLevel:2})]},{engine:'offline-stub'});
  assert.equal(b.independence.score,0);
});

test('missing tags, recommendations and legacy transcript still produce a bounded process report',()=>{
  const unknown={id:'lost',source:'session-only',topics:null,solutionGraphs:null,misconceptions:null};
  const r=buildReport(unknown,{turns:[{role:'student',text:'这一步不明白'}]},{engine:'unknown'});
  assert.ok(r.assessment.feedback.some(f=>f.evidence.some(e=>e.quote.includes('不明白'))));
  assert.equal(r.assessment.accuracy.percent,null);
  assert.equal(r.assessment.completion.percent,null);
  assert.ok(r.nextActions.length);
  const legacy=buildReport({...p,source:'qbank'},{turns:[{role:'ai',text:'先看提示'},
    {role:'student',text:'E=0.4 V'}]},{engine:'unknown'});
  assert.equal(legacy.assessment.accuracy.percent,null,'缺提示记录不能假定为首次独立作答');
  assert.equal(legacy.assessment.completion.completed,1);
  assert.ok(!legacy.assessment.knowledge.some(k=>k.status==='mastered'));
});

async function withServer(fn) {
  const dir=mkdtempSync(join(tmpdir(),'report-evidence-'));
  const env={STORE:'file',STORE_DIR:dir,LLM_API_KEY:'',OPENAI_API_KEY:'',PILOT_REQUIRE_LOGIN:'0'};
  __resetStoreForTests();sessions.clear();
  const server=createServer((req,res)=>{
    if (req.headers['x-evidence-user']) req.__user={user:{id:req.headers['x-evidence-user']},batchId:null};
    return requestEnv.run(env,()=>handleApi(req,res,new URL(req.url,'http://localhost')))
    .catch(e=>{res.statusCode=500;res.end(JSON.stringify({error:e.message}));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,body,headers={})=>{
    const res=await fetch(base+path,body===undefined?{headers}:{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
    return {status:res.status,...await res.json()};
  };
  const store=await requestEnv.run(env,()=>getStore());
  try {await fn({call,store});}
  finally {server.closeAllConnections();await new Promise(r=>server.close(r));sessions.clear();__resetStoreForTests();rmSync(dir,{recursive:true,force:true});}
}

test('confirmation saves context before first chat, ignores client grading material, and survives a cold load',async()=>{
  await withServer(async({call,store})=>{
    const start=await call('/api/session/start',{sessionId:'confirmed',problemId:p.id,originalStem:'原始OCR文字',referenceAnswer:'恶意答案',image:'data:image/png;base64,AA=='});
    assert.equal(start.status,200);assert.equal(start.durable,true);
    assert.ok(!JSON.stringify(start).includes(p.referenceAnswer));
    const saved=await store.getSession('confirmed');
    assert.equal(saved.record.turns.length,0);
    assert.equal(saved.progress.maxPage,2,'确认题目不伪装成已经进入解题页');
    assert.equal(saved.problemSnapshot.originalStem,'原始OCR文字');
    assert.equal(saved.problemSnapshot.confirmedStem,p.stem);
    assert.equal(saved.problemSnapshot.problem.referenceAnswer,p.referenceAnswer);
    sessions.clear();
    const report=await call('/api/report?sessionId=confirmed');
    assert.equal(report.status,200);
    assert.equal(report.report.meta.problemContextMissing,false);
    assert.equal(report.report.assessment.accuracy.percent,null);
  });
});

test('saved imported context takes priority over registry revisions and can resume without registry entry',async()=>{
  await withServer(async({call,store})=>{
    const original={...structuredClone(p),id:'imported-evidence-snapshot',source:'imported',referenceVerified:true};
    registerImportedProblem(original,{});
    assert.equal((await call('/api/session/start',{sessionId:'revision',problemId:original.id})).status,200);
    registerImportedProblem({...original,referenceAnswer:'E=100 V',stem:'更新后的另一份题面'},{});
    sessions.clear();
    const r=await call('/api/chat',{sessionId:'revision',problemId:original.id,utterance:'E=0.4 V',mode:'self_training'});
    assert.equal(r.status,200);assert.equal(r.completion.answeredCount,1);
    const saved=await store.getSession('revision');
    saved.problemId='imported-gone-but-snapshotted';
    saved.problemSnapshot.problem.id=saved.problemId;
    saved.record.problemId=saved.problemId;saved.id='gone';
    await store.putSession(saved);sessions.clear();
    const report=await call('/api/report?sessionId=gone');
    assert.equal(report.status,200);assert.equal(report.report.meta.problemContextMissing,false);
    assert.equal(report.report.assessment.completion.completed,1);
  });
});

test('live completion equals report completion across turns; new learning archives an old report',async()=>{
  await withServer(async({call,store})=>{
    const first=await call('/api/chat',{sessionId:'live',problemId:p.id,utterance:'E=0.4 V',mode:'self_training'});
    assert.equal(first.status,200);assert.equal(first.completion.answeredCount,1);
    const a=await call('/api/report?sessionId=live');
    assert.equal(a.report.assessment.completion.completed,first.completion.answeredCount);
    const second=await call('/api/chat',{sessionId:'live',problemId:p.id,utterance:'I=1 A',mode:'self_training'});
    const b=await call('/api/report?sessionId=live');
    assert.equal(second.status,200);assert.equal(second.completion.answeredCount,2);
    assert.equal(b.report.assessment.completion.completed,2);
    const saved=await store.getSession('live');
    assert.deepEqual(saved.reportHistory[0].reportSnapshot,a.report);
    assert.equal(second.hint.form,'confirm');
    await call('/api/chat',{sessionId:'live',problemId:p.id,utterance:'F=0.2 N',mode:'self_training'});
    const last=await call('/api/chat',{sessionId:'live',problemId:p.id,utterance:'P=0.4 W',mode:'self_training'});
    assert.equal(last.completion.complete,true);
    assert.equal(last.hint.form,'confirm');
    assert.ok(!/全程独立|从头到尾是你自己|关键关节都是你自己/.test(last.hint.text));
  });
});

test('failed model calls preserve input but do not fabricate accuracy or answer evidence',async()=>{
  await withServer(async({call,store})=>{
    await call('/api/session/start',{sessionId:'failed',problemId:p.id});
    sessions.get('failed').engine={handleTurn:async()=>{throw Object.assign(new Error('模拟调用失败'),{code:'REPLY_UNAVAILABLE'});}};
    const turn=await call('/api/chat',{sessionId:'failed',problemId:p.id,utterance:'E=0.4 V'});
    assert.equal(turn.status,503);
    const saved=await store.getSession('failed');
    assert.equal(saved.inputLog[0].utterance,'E=0.4 V');assert.equal(saved.inputLog[0].status,'failed');
    const report=await call('/api/report?sessionId=failed');
    assert.equal(report.report.meta.unprocessedInputs,1);
    assert.equal(report.report.assessment.accuracy.percent,null);
  });
});

test('new session endpoint cannot overwrite or read a different owner’s snapshot',async()=>{
  await withServer(async({call,store})=>{
    const s=createLiveSession({id:'owned',problemId:p.id});s.userId='another-student';s.problemSnapshot=captureProblem(p);
    await store.putSession(snapshotSession(s));
    const r=await call('/api/session/start',{sessionId:'owned',problemId:p.id},{'x-evidence-user':'different-student'});
    assert.equal(r.status,403);
    assert.equal((await store.getSession('owned')).userId,'another-student');
  });
});

test('report structure and CSS stay unchanged; client uses server completion instead of a number union',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.ok(html.includes('entry.matched = r.completion.answeredCount'));
  assert.ok(!html.includes("entry.seen[m.value + '|' + m.unit]"));
  assert.ok(html.includes("'/api/session/start'"));
  for(const id of ['mCount','mAcc','mWeak','lvOk','lvWarn','lvBad','wrongList']) assert.ok(html.includes(`id="${id}"`));
});

test('real eight-turn support pattern retains direction, law and condition requests without inventing mistakes',async()=>{
  await withServer(async({call})=>{
    const utterances=['我不知道这道题要干什么','这一步该用哪条规律','电流','我的方向判断对吗',
      '这个式子里的前提成立吗','我的方向判断对吗','这一步该用哪条规律','r=1'];
    for(const utterance of utterances) {
      const r=await call('/api/chat',{sessionId:'real-pattern',problemId:'qbank-344',utterance,mode:'self_training'});
      assert.equal(r.status,200);
    }
    const {report}=await call('/api/report?sessionId=real-pattern');
    for(const id of ['process-law','process-direction','process-condition']) assert.ok(report.assessment.feedback.some(f=>f.id===id),id);
    const law=report.assessment.feedback.find(f=>f.id==='process-law');
    assert.equal(law.helpRounds,2);
    assert.deepEqual(law.evidence.map(e=>e.turn),[1,6]);
    assert.ok(!report.assessment.feedback.some(f=>f.id==='unlocated'));
    assert.ok(!report.assessment.knowledge.some(k=>k.status==='mastered' || k.status==='weak'));
    assert.equal(report.assessment.accuracy.percent,null);
    assert.ok(!report.assessment.feedback.flatMap(f=>f.evidence).some(e=>e.result==='incorrect'));
  });
});

test('short repeated confusion inherits the last explicit request; acknowledgements and unrelated chat do not resolve it',()=>{
  const feedback=processFeedback(['我的方向判断对吗','还是不会','没懂','好的','我想玩游戏','人生方向怎么选']
    .map(utterance=>log(utterance)));
  assert.equal(feedback.length,1);
  assert.equal(feedback[0].helpRounds,3);
  assert.equal(feedback[0].status,'pending');
  assert.ok(feedback[0].evidence.every(e=>e.result==='help_requested'));
  assert.equal(processFeedback([log('老师问：我的方向判断对吗')]).length,0);
});

test('diagram and missing-condition requests get actions tied to their actual wording',()=>{
  for(const [text,id] of [['我画的受力图对吗','diagram'],['我漏掉了哪个条件','condition'],['这个公式为什么能用','condition']]) {
    const f=processFeedback([log(text)])[0];
    assert.equal(f.id,`process-${id}`);
    assert.equal(f.evidence[0].quote,text);
    assert.ok(f.action.length>10);
  }
});

test('plain and explained selections are verified in the actual chat/report path; correction keeps the first error',async()=>{
  await withServer(async({call})=>{
    const problem=getQbankProblem('qbank-1'),answer=problem.referenceAnswer.split('\n')[0].trim();
    const wrong=answer==='A'?'B':'A';
    await call('/api/chat',{sessionId:'explained-choice',problemId:problem.id,utterance:`我选${wrong}`,mode:'self_training'});
    const old=await call('/api/report?sessionId=explained-choice');
    assert.equal(old.report.assessment.accuracy.percent,0);
    const turn=await call('/api/chat',{sessionId:'explained-choice',problemId:problem.id,
      utterance:`我选${answer}，因为要结合题目中的物理条件判断`,mode:'self_training'});
    assert.equal(turn.completion.complete,true);
    assert.equal(turn.hint.form,'confirm');
    const current=await call('/api/report?sessionId=explained-choice');
    assert.equal(current.report.assessment.subquestions[0].corrected,true);
    assert.equal(current.report.assessment.accuracy.percent,0);
    assert.equal(current.report.assessment.feedback.find(f=>f.id==='answer-0').status,'corrected');
    assert.equal(numericAttempts(problem,[log(answer)]).completion.complete,true);
    for(const utterance of [`我觉得是${answer}`,`应该选${answer}`,`答案${answer}`]) {
      assert.equal(numericAttempts(problem,[log(utterance)]).completion.complete,true,utterance);
    }
    for(const utterance of [`我选${answer}还是${wrong}`,`老师说选${answer}`,`我不知道选${answer}对不对`]) {
      assert.equal(numericAttempts(problem,[log(utterance)]).completion.completed,0,utterance);
    }
  });
});

test('a correct option alone cannot erase unresolved reasoning requests or establish knowledge mastery',()=>{
  const problem=getQbankProblem('qbank-1'),answer=problem.referenceAnswer.split('\n')[0].trim();
  const report=buildReport(problem,{hintLog:[log('我的方向判断对吗'),log(`我选${answer}`)]},{engine:'offline-stub'});
  assert.equal(report.assessment.completion.complete,true);
  assert.equal(report.assessment.feedback.find(f=>f.id==='process-direction').status,'pending');
  assert.ok(!report.assessment.knowledge.some(k=>k.status==='mastered'));
});

test('unknown report labels do not repeat the pending-verification suffix',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const begin=html.indexOf('  function levelBuckets(rep)'),end=html.indexOf('  /** 仅渲染预定义公式',begin);
  const c=vm.createContext({});vm.runInContext(html.slice(begin,end),c);
  const labels=c.levelBuckets({assessment:{knowledge:[{title:'选择题作答（尚未作答或待核验）',status:'unknown'},
    {title:'方向判断（求助记录，待核验）',status:'unknown'}]}}).warn;
  for(const label of labels) assert.equal((label.match(/待核验/g)||[]).length,1);
});

test('opening a cached v2 report upgrades its analysis once while retaining the original report',async()=>{
  await withServer(async({call,store})=>{
    const q=getQbankProblem('qbank-344');
    const session=createLiveSession({id:'cached-v2',problemId:q.id});
    session.problemSnapshot=captureProblem(q);
    session.record.hintLog=[log('我的方向判断对吗'),log('这一步该用哪条规律')];
    const old={problemId:q.id,assessment:{feedback:[],knowledge:[]},meta:{schemaVersion:'session-evidence-v2'}};
    session.reportSnapshot=old;
    await store.putSession(snapshotSession(session));
    const fresh=await call('/api/report?sessionId=cached-v2');
    assert.equal(fresh.report.meta.schemaVersion,'session-evidence-v3');
    assert.ok(fresh.report.assessment.feedback.some(f=>f.id==='process-direction'));
    let stored=await store.getSession('cached-v2');
    assert.deepEqual(stored.reportHistory[0].reportSnapshot,old);
    const repeat=await call('/api/report?sessionId=cached-v2');
    assert.deepEqual(repeat.report,fresh.report);
    stored=await store.getSession('cached-v2');
    assert.equal(stored.reportHistory.length,1);
  });
});
