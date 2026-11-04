import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { QBANK_SOURCE } from '../src/core/qbank-source.data.js';
import { QBANK_GRAPHS } from '../src/core/qbank-graphs.data.js';
import { getQbankProblem,QBANK_IDS } from '../src/core/qbank.js';
import { getProblemById } from '../src/core/registry.js';
import { buildReport,createSessionRecord } from '../src/core/report.js';
import { toStudentProblem,handleApi } from '../src/server/router.js';

test('all 152 source questions retain answers, full images and every knowledge/method association',()=>{
  assert.equal(QBANK_IDS.length,152);
  assert.equal(QBANK_GRAPHS.knowledge.flatMap(m=>m.children.flatMap(c=>c.children)).length,75);
  assert.equal(QBANK_GRAPHS.methods.flatMap(m=>m.children).length,28);
  for (const source of QBANK_SOURCE) {
    const p=getProblemById(`qbank-${source.i}`);
    assert.ok(p,p?.id);
    assert.equal(p.qbId,source.i);
    assert.equal(p.referenceSource.answerHtml,source.answerHtml);
    assert.equal(p.referenceSource.analysisHtml,source.analysisHtml);
    assert.ok(p.referenceAnswer.length>0);
    const r=buildReport(p,createSessionRecord(p.id),{engine:'offline-stub'});
    assert.equal(r.review.status,'available',p.id);
    assert.equal(r.review.questionCode,source.code);
    assert.deepEqual(r.review.knowledge.map(k=>k.id),source.knowledgeIds,p.id);
    assert.deepEqual(r.review.methods.map(m=>m.id),source.methodIds,p.id);
    for (const k of r.review.knowledge) {
      assert.equal(k.graphPath.length,3);
      assert.ok(k.meaning && k.condition);
    }
    for (const m of r.review.methods) assert.ok(m.principle && m.use && m.when && m.boundary);
    assert.equal(r.assessment.accuracy.percent,null);
    assert.ok(!r.assessment.knowledge.some(k=>k.status==='mastered'));
  }
});

test('public questions and problem API projections exclude reference answers and analysis',()=>{
  for (const source of QBANK_SOURCE) {
    const pub=JSON.parse(readFileSync(new URL(`../public/qbank/q/${source.i}.json`,import.meta.url),'utf8'));
    for (const key of ['answerText','answerHtml','analysisText','analysisHtml']) assert.ok(!(key in pub));
    assert.equal(pub.stemHtml,source.stemHtml);
    assert.deepEqual(pub.options,source.options);
    const student=toStudentProblem(getQbankProblem(`qbank-${source.i}`));
    for (const key of ['referenceSource','referenceAnswer','reportReview','answerFingerprints']) assert.ok(!(key in student));
  }
});

test('knowledge is selected by stable source ID and does not mutate another question',()=>{
  const first=getQbankProblem('qbank-1'), second=getQbankProblem('qbank-2');
  assert.ok(first.reportReview.knowledge.some(k=>k.title==='光电效应'));
  assert.ok(second.reportReview.knowledge.some(k=>/折射/.test(k.title)));
  assert.equal(getQbankProblem('qbank-153'),null);
  const r=buildReport(first,createSessionRecord(first.id),{engine:'offline-stub'});
  r.review.knowledge[0].title='mutated';
  assert.ok(!first.reportReview.knowledge.some(k=>k.title==='mutated'));
});

test('both selection paths use registered IDs; report renderer preserves all cards and compiles',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.ok(html.includes("S.pickedBank ? API.problem('qbank-' + S.pickedBank)"));
  assert.ok(html.includes("return API.problem('qbank-' + q.bankId)"));
  assert.ok(html.includes('展开其余知识点'));
  assert.ok(html.includes('展开其余方法'));
  for (const [,body] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(body);
  const start=html.indexOf('  function renderReportReview(rep)');
  const end=html.indexOf('  /** 步骤标题',start);
  const host={innerHTML:''};
  const c=vm.createContext({practiceButton:()=>'', $:()=>host,esc:s=>String(s).replaceAll('<','&lt;'),reportFormula:k=>k.formula});
  vm.runInContext(html.slice(start,end),c);
  const example=QBANK_SOURCE.find(q=>q.knowledgeIds.length>3 && q.methodIds.length>2);
  assert.ok(example);
  c.renderReportReview({review:getQbankProblem(`qbank-${example.i}`).reportReview});
  assert.equal((host.innerHTML.match(/class="review-item"/g)||[]).length,example.knowledgeIds.length);
  assert.equal((host.innerHTML.match(/class="review-method"/g)||[]).length,example.methodIds.length);
  assert.equal((host.innerHTML.match(/<details/g)||[]).length,(host.innerHTML.match(/<\/details>/g)||[]).length);
});

test('every bank question has an API report even before the first chat turn',async()=>{
  const {createServer}=await import('node:http');
  const server=createServer((req,res)=>handleApi(req,res,new URL(req.url,'http://localhost')).catch(e=>{
    res.statusCode=500;res.end(String(e));
  }));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    for (const id of QBANK_IDS) {
      const response=await fetch(`${base}/api/report?sessionId=coverage-${id}&problemId=${id}`);
      assert.equal(response.status,200,id);
      const {report,turns}=await response.json();
      assert.equal(report.problemId,id);
      assert.equal(report.review.status,'available');
      assert.ok(report.review.knowledge.length && report.review.methods.length);
      assert.equal(report.meta.recordMissing,true);
      assert.deepEqual(turns,[]);
    }
    const invalid=await fetch(`${base}/api/report?sessionId=missing&problemId=qbank-153`);
    assert.equal(invalid.status,404);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
