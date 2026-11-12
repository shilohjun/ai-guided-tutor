import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {buildReportPractice} from '../src/core/report-practice.js';
import {buildReportReview} from '../src/core/report-review.js';
import {assessLearning} from '../src/core/report-assessment.js';
import {getProblemById} from '../src/core/registry.js';
import {QBANK_SOURCE} from '../src/core/qbank-source.data.js';

function setup(id='phy-emi-04',utterance='I=E/R') {
  const p=getProblemById(id),review=buildReportReview(p);
  const assessment=assessLearning(p,{hintLog:[{utterance,form:'confirm',deliveredLevel:0,guardPassed:true,graphId:p.solutionGraphs[0].id,stepIndex:4}]});
  return {p,review,assessment,practice:buildReportPractice(p,assessment,review)};
}
test('a concrete rod-resistance error recommends only the source-reviewed rod question',()=>{
  const {practice,assessment}=setup();
  const idx=assessment.feedback.findIndex(x=>x.id==='circuit');
  assert.ok(idx>=0);
  assert.deepEqual(practice.gaps[idx].items.map(x=>x.code),['GZ-2026-10']);
  assert.ok(!practice.gaps[idx].items.some(x=>x.code==='HN-2026-05'));
});
test('confusion, an unlocated error and numeric mistakes do not fall back to broad tags',()=>{
  for(const utterance of ['不知道','I=E/R 对吗？','磁通量不知道怎么求']) {
    const {practice}=setup('phy-emi-04',utterance);
    assert.ok(practice.gaps.every(x=>x.items.length===0));
  }
  const {p,review}=setup();
  const practice=buildReportPractice(p,{feedback:[{id:'answer-0',evidence:[{result:'incorrect'}]},{id:'unlocated',evidence:[{result:'incorrect'}]}]},review);
  assert.ok(practice.gaps.every(x=>x.items.length===0));
});
test('difficulty and exclusions suppress a reviewed candidate instead of substituting another circuit',()=>{
  const easy=setup('phy-emi-01');
  assert.ok(easy.practice.gaps.every(x=>!x.items.length));
  const {p,review,assessment}=setup();
  const r=buildReportPractice(p,assessment,review,{excludeIds:['qbank-133']});
  assert.ok(r.gaps.every(x=>!x.items.length));
});
test('all bank cards match exact full source labels, exclude the current question, and respect difficulty',()=>{
  for(const source of QBANK_SOURCE) {
    const p=getProblemById(`qbank-${source.i}`),review=buildReportReview(p);
    const r=buildReportPractice(p,{feedback:[]},review);
    for(const [kind,keys] of [['knowledge','knowledgeIds'],['methods','methodIds']]) {
      r[kind].forEach((entry,i)=>{
        assert.ok(entry.items.length<=QBANK_SOURCE.length);
        for(const item of entry.items) {
          const q=QBANK_SOURCE.find(q=>q.i===item.bankId);
          assert.ok(q[keys].includes(review[kind][i].id));
          assert.notEqual(item.problemId,p.id);
          assert.ok(item.difficulty<=p.difficulty);
          assert.deepEqual(Object.keys(item).sort(),['bankId','problemId','code','difficulty','type','province','preview','reason','target'].sort());
        }
      });
    }
  }
});
test('unconfigured physics and math cards do not invent source mappings',()=>{
  for(const p of [{id:'new',subject:'physics',difficulty:3},getProblemById('math-proof-01')]) {
    const r=buildReportPractice(p,{feedback:[]},buildReportReview(p));
    assert.ok([...r.knowledge,...r.methods,...r.gaps].every(x=>!x.items.length));
  }
});

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
test('four-step report toolbar is outside scrolling content; no duplicate fifth page',()=>{
  assert.ok(html.includes("var PAGES = ['题目', '方式', '解题', '报告'];"));
  assert.ok(!html.includes('data-page="5"'));
  assert.ok(!html.includes('id="go5"'));
  const toolbar=html.indexOf('class="report-toolbar"');
  const scroll=html.indexOf('id="reportScroll"');
  assert.ok(toolbar>0 && toolbar<scroll);
  for(const id of ['reportRedo','reportFinish','reportReturnBtn']) assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1);
});
test('report practice excludes already attempted questions and hides unavailable gap buttons',()=>{
  const c=vm.createContext({S:{problem:{id:'qbank-1'},ledger:[{problemId:'qbank-2'}]}});
  vm.runInContext(html.slice(html.indexOf('  function availablePractice('),html.indexOf('  function renderReportReview(')),c);
  const entry={items:[1,2,3,4,5,6].map(n=>({problemId:`qbank-${n}`}))};
  assert.deepEqual(JSON.parse(JSON.stringify(c.availablePractice(entry))).map(x=>x.problemId),['qbank-3','qbank-4','qbank-5']);
  assert.ok(!c.practiceButton({items:[]},'gaps',0).includes('<button'));
  assert.ok(c.practiceButton(entry,'knowledge',0).includes('data-practice="knowledge"'));
});
test('targeted drawer never widens into generic candidates even with an empty match',()=>{
  const c=vm.createContext({REL:{target:{items:[]}},S:{bank:[{id:'qbank-27'}]}});
  vm.runInContext(html.slice(html.indexOf('  function relCandidates('),html.indexOf('  function syncRelUi(')),c);
  assert.equal(c.relCandidates().length,0);
});
test('returning from practice restores the original report session and scroll position',()=>{
  const nodes=new Map();const $=key=>{
    if(!nodes.has(key))nodes.set(key,{scrollTop:key==='#reportScroll'?180:0,addEventListener(type,fn){this[type]=fn;}});
    return nodes.get(key);
  };
  const S={page:4,problem:{id:'old'},sessionId:'old-session',report:{problemId:'old'},turns:[{text:'original'}],reportTurns:[],ledger:[]};
  const c=vm.createContext({$,S,renderReport(){},setPage(n){S.page=n;}});
  vm.runInContext(html.slice(html.indexOf('  var REPORT_ORIGIN = null;'),html.indexOf("  $('#readingRetry')")),c);
  c.rememberReport();
  S.problem={id:'new'};S.sessionId='new-session';S.turns=[];S.report=null;S.page=3;
  $('#reportReturnBtn').click();
  assert.equal(S.sessionId,'old-session');assert.equal(S.problem.id,'old');
  assert.equal(S.report.problemId,'old');assert.equal(S.turns[0].text,'original');
  assert.equal($('#reportScroll').scrollTop,180);assert.equal(S.page,4);
});


// Preview loading and confirmation must never silently replace the active report.
function previewHarness(fetchImpl, apiImpl) {
  const nodes=new Map();
  const $=key=>{
    if(!nodes.has(key))nodes.set(key,{open:false,isConnected:true,hidden:false,disabled:false,
      handlers:{},setAttribute(k,v){this[k]=v;},addEventListener(type,fn){this.handlers[type]=fn;},
      showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();},focus(){this.focused=true;}});
    return nodes.get(key);
  };
  const S={page:4,problem:{id:'original'},sessionId:'original-session',report:{problemId:'original'}};
  const calls={starts:0,remembered:0,api:0};
  const c=vm.createContext({$,S,REL:{open:true},fetch:fetchImpl,
    API:{problem(id){calls.api++;return apiImpl ? apiImpl(id) : Promise.resolve({problem:{id,stem:'题干'}});}},
    REPORT_ORIGIN:null,rememberReport(){calls.remembered++;},startSession(){calls.starts++;},
    closeRelDrawer(){c.REL.open=false;},setPage(n){S.page=n;},esc:s=>String(s),
  });
  const a=html.indexOf('  /* Full question preview:');
  vm.runInContext(html.slice(a,html.indexOf('  /* ---------------- 初始化',a)),c);
  c.fullBankQuestionHtml=det=>det.stemHtml;
  return {c,$,S,calls};
}
const settlePreview=()=>new Promise(resolve=>setImmediate(resolve));
const publicDetail=i=>({i,code:'TEST-'+i,src:'测试题',ty:'单选',d:'中',stemText:'完整题干',stemHtml:'<p>完整题干</p>',options:[{l:'A',html:'选项A',text:'选项A'}]});

test('preview renders the full public stem and all options without reading answer fields',()=>{
  const c=vm.createContext({safeBankHtml:s=>s,esc:s=>String(s)});
  vm.runInContext(html.slice(html.indexOf('  function fullBankQuestionHtml('),html.indexOf('  function openRelPreview(')),c);
  for(const id of [27,133]) {
    const det=JSON.parse(readFileSync(new URL(`../public/qbank/q/${id}.json`,import.meta.url),'utf8'));
    Object.defineProperty(det,'answerHtml',{get(){throw Error('Answer must never be read');}});
    Object.defineProperty(det,'analysisHtml',{get(){throw Error('Analysis must never be read');}});
    const output=c.fullBankQuestionHtml(det);
    assert.ok(output.includes(det.stemHtml));
    for(const o of det.options)assert.ok(output.includes(o.html));
    assert.equal((output.match(/<li>/g)||[]).length,4);
  }
  assert.ok(!c.fullBankQuestionHtml({...publicDetail(1),options:[]}).includes('rel-preview-options'));
});
test('clicking a recommendation opens preview and loads assets without starting a session',async()=>{
  const {c,$,S,calls}=previewHarness(async()=>({ok:true,json:async()=>publicDetail(27)}));
  c.openRelPreview({bankId:27,code:'TEST-27'},{});
  assert.equal($('#relPreview').open,true);assert.equal($('#relPreviewStart').disabled,true);
  await settlePreview();
  assert.equal($('#relPreviewStart').disabled,false);
  assert.equal(S.problem.id,'original');assert.equal(S.sessionId,'original-session');
  assert.equal(calls.starts,0);assert.equal(calls.api,0);
});
test('late preview responses cannot overwrite a newer selected question',async()=>{
  const pending=[];
  const {c,$}=previewHarness(()=>new Promise(resolve=>pending.push(resolve)));
  c.openRelPreview({bankId:27,code:'TEST-27'},{});
  c.closeRelPreview();
  c.openRelPreview({bankId:133,code:'TEST-133'},{});
  pending[1]({ok:true,json:async()=>publicDetail(133)});await settlePreview();
  pending[0]({ok:true,json:async()=>publicDetail(27)});await settlePreview();
  assert.equal($('#relPreviewTitle').textContent,'TEST-133 · 完整题目');
  assert.equal(c.REL_PREVIEW.detail.i,133);
});
test('failed or mismatched question detail leaves the original report intact and start disabled',async()=>{
  for(const response of [{ok:false},{ok:true,json:async()=>publicDetail(133)}]) {
    const {c,$,S,calls}=previewHarness(async()=>response);
    c.openRelPreview({bankId:27},{});await settlePreview();
    assert.equal($('#relPreviewStart').disabled,true);
    assert.equal($('#relPreviewError').hidden,false);
    assert.equal(S.report.problemId,'original');assert.equal(calls.starts,0);
  }
});
test('confirm uses the previewed assets and keeps start failures inside the popup',async()=>{
  const {c,$,S,calls}=previewHarness(async()=>({ok:true,json:async()=>publicDetail(27)}),async()=>{throw Error('测试连接失败');});
  c.openRelPreview({bankId:27},{});await settlePreview();
  const state=c.REL_PREVIEW;
  await c.startBankPractice(state.question,$('#relPreviewStart'),state);
  assert.equal(S.problem.id,'original');assert.equal(S.sessionId,'original-session');
  assert.equal(calls.remembered,0);assert.equal(calls.starts,0);
  assert.ok($('#relPreviewError').textContent.includes('测试连接失败'));
  assert.equal($('#relPreview').open,true);assert.equal($('#relPreviewStart').disabled,false);
});
test('closing during confirmation prevents a late request from starting another question',async()=>{
  let resolveAPI;
  const {c,$,S,calls}=previewHarness(async()=>({ok:true,json:async()=>publicDetail(27)}),()=>new Promise(resolve=>{resolveAPI=resolve;}));
  c.openRelPreview({bankId:27},{});await settlePreview();
  const state=c.REL_PREVIEW;
  const started=c.startBankPractice(state.question,$('#relPreviewStart'),state);
  await settlePreview();c.closeRelPreview();
  resolveAPI({problem:{id:'qbank-27',stem:'题干'}});await started;
  assert.equal(S.problem.id,'original');assert.equal(S.sessionId,'original-session');
  assert.equal(calls.starts,0);assert.equal(calls.remembered,0);
});
