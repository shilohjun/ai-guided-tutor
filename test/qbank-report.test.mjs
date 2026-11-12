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

test('old question identities and knowledge paths survive source reordering',()=>{
  const legacy=JSON.parse(readFileSync(new URL('./fixtures/qbank-legacy-ids.json',import.meta.url),'utf8'));
  const byId=new Map(QBANK_SOURCE.map(q=>[q.i,q]));
  for (const old of legacy.questions) assert.equal(byId.get(old.i)?.code,old.code,`legacy question ${old.i}`);
  const paths=new Map(QBANK_GRAPHS.knowledge.flatMap(m=>m.children.flatMap(c=>c.children.map(l=>[l.id,[m.name,c.name,l.name]]))));
  for (const old of legacy.knowledge) assert.deepEqual(paths.get(old.id),old.path,`legacy knowledge ${old.id}`);
});

test('expanded picker, embedded map and report registry share all 861 identities',()=>{
  const data=JSON.parse(readFileSync(new URL('../public/qbank/data.json',import.meta.url),'utf8'));
  const map=readFileSync(new URL('../public/qbank/map.html',import.meta.url),'utf8');
  const embedded=JSON.parse(map.match(/<script type="application\/json" id="qdata">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(embedded,data);
  assert.equal(data.qs.length,861);
  assert.deepEqual(data.qs.map(q=>q.i),QBANK_SOURCE.map(q=>q.i));
  const source=new Map(QBANK_SOURCE.map(q=>[q.i,q]));
  for (const q of data.qs) {
    const raw=source.get(q.i);
    assert.ok(q.m && q.k && q.l && q.t && q.t2 && q.s && q.stem);
    assert.ok([2,3,4].includes(q.d));
    assert.deepEqual(q.knowledgeIds,raw.knowledgeIds);
    assert.deepEqual(q.methodIds,raw.methodIds);
    assert.equal(q.stem,raw.stemText);
    assert.ok(!('answerHtml' in q) && !('analysisHtml' in q));
  }
  for (const code of ['TJ-2025-09','TJ-2024-09','HN-2024-14']) {
    const same=QBANK_SOURCE.filter(q=>q.code===code);
    assert.equal(same.length,2);
    assert.equal(new Set(same.map(q=>q.i)).size,2);
  }
});

test('chapter-only source labels remain explicitly unspecialized in reports',()=>{
  const source=QBANK_SOURCE.filter(q=>q.knowledgeIds.some(id=>id.startsWith('chapter-review-')));
  assert.ok(source.length>0);
  for (const q of source) {
    const report=buildReport(getQbankProblem(`qbank-${q.i}`),createSessionRecord(`qbank-${q.i}`),{engine:'offline-stub'});
    assert.ok(report.review.knowledge.some(k=>k.title.includes('未细分')));
    assert.ok(!report.assessment.knowledge.some(k=>k.status==='mastered'));
  }
});

test('all 861 source questions retain answers, full images and every knowledge/method association',()=>{
  assert.equal(QBANK_IDS.length,861);
  assert.equal(QBANK_GRAPHS.knowledge.flatMap(m=>m.children.flatMap(c=>c.children)).length,97);
  assert.equal(QBANK_GRAPHS.methods.flatMap(m=>m.children).length,29);
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
    for (const [,image] of pub.stemHtml.matchAll(/(<img\b[^>]*>)/g)) {
      assert.match(image,/src="data:image\//,source.code);
      assert.ok(!/\son\w+\s*=/.test(image));
    }
    const student=toStudentProblem(getQbankProblem(`qbank-${source.i}`));
    for (const key of ['referenceSource','referenceAnswer','reportReview','answerFingerprints']) assert.ok(!(key in student));
  }
});

test('knowledge is selected by stable source ID and does not mutate another question',()=>{
  const first=getQbankProblem('qbank-1'), second=getQbankProblem('qbank-2');
  assert.ok(first.reportReview.knowledge.some(k=>k.title==='光电效应'));
  assert.ok(second.reportReview.knowledge.some(k=>/折射/.test(k.title)));
  assert.equal(getQbankProblem('qbank-862'),null);
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
    const invalid=await fetch(`${base}/api/report?sessionId=missing&problemId=qbank-862`);
    assert.equal(invalid.status,404);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
