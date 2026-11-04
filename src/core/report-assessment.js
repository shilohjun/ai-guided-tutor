/** Evidence-only report assessment. Never use absence of errors as mastery.
 * Rubric coverage is intentionally conservative; unverified language stays unknown.
 * This module changes reports only, not the tutor's prompts or replies.
 */
import { expectedAnswers } from './verify.js';
import { canonicalize } from './text.js';
import { unitAlternatives } from './guard.js';

const compact = s => canonicalize(String(s ?? '')).replace(/\s+/g, '');
const escRE = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const QUESTION = /[?？]|是不是|是否|对不对|可以吗|对吗|为什么|怎么|如何|能否/;
const CONFUSION = /不知道|不知|不会|不懂|没懂|不明白|不理解|忘了|记不清|没思路|卡住|卡在|看不懂|想不出|不确定/;
const ACK = /^(?:我)?(?:懂了|明白了|知道了|会了|好的|好|嗯|谢谢|收到)[。.!！\s]*$/;
const REASON = /因为|由于|所以|因此|故|根据|依据|由题|题中|两两垂直|串联|合力为零/;
const NEGATED = /并非|不是|不应|不能|不该|错误|错的|不用|不成立|不等于|≠/;
const NON_ASSERTION = /如果|假如|假设|参考答案|老师说|AI说|提示说|举例/;
const EXPLANATIONS = {
  cutting:/两两垂直|互相垂直|均匀磁场|有效长度/,
  circuit:/内阻|自身电阻|串联/,
  equilibrium:/匀速|加速度(?:为零|=0)/,
  flux:/垂直|面积.*不变|夹角/,
  area:/矩形|长.*宽|面积量纲/,
  acceleration:/安培力.*变化|安培力.*增大|合力.*减小/,
  'ampere-direction':/左手定则|楞次定律/,
  'changing-field':/变化率|磁场.*增加/,
  'limiting-state':/安培力|合力|加速度/,
  'resistor-power':/支路|外电阻|内阻|电阻R/,
  'capacitor-branches':/节点|电荷守恒|支路/,
};

// Each rubric is limited to reviewed fixtures, with an explicit correction and scope.
const RUBRICS = [
  { id:'cutting', title:'切割磁感线', ids:[1,3,4,5], steps:[2,3], correct:/E=BLv(?![A-Za-z/])/,
    action:'先检查磁场、导体和速度的方向，再确定公式中的有效长度。' },
  { id:'circuit', title:'闭合电路欧姆定律', ids:[1,4], steps:[4],
    correct:/I=E\/\(R\+r\)|总电阻(?:为|是|=)R\+r/,
    wrong:/I=E\/R(?![A-Za-z+(])|电阻只有R|内阻不计|内阻不算/,
    finding:'计算回路电流时遗漏导体棒自身电阻。',
    action:'先标出电源内阻与外电阻，检查闭合回路中的总电阻。' },
  { id:'equilibrium', title:'受力平衡', ids:[1], steps:[6],
    correct:/合力(?:为|是|=)零|合力=0|F外=F安/,
    wrong:/匀速.*合力不为零/,
    finding:'匀速运动与合力条件的对应关系存在错误。',
    action:'依据牛顿定律，把题目的运动状态转化为合力条件。' },
  { id:'flux', title:'磁通量与感应电动势', ids:[2], steps:[2,3,4],
    correct:/[Φφ]=BS|[Φφ]=B(?:L1L2|L₁L₂)/,
    action:'先辨别磁场、面积和夹角中哪些量变化，再分析磁通量变化。' },
  { id:'area', title:'线框面积', ids:[2], steps:[3], correct:/S=L1(?:\*|×)?L2|S=L₁(?:\*|×)?L₂/,
    wrong:/S=2\(L1\+L2\)|面积是周长/,
    finding:'计算磁通量时混淆线框面积与周长。',
    action:'先根据线框形状求面积，并检查量纲是否为面积。' },
  { id:'acceleration', title:'变加速运动分析', ids:[3,4], steps:[],
    correct:/加速度(?:随|会随).*速度.*变化|安培力.*增大.*加速度.*减小/,
    wrong:/加速度恒定|加速度是恒定的|a=F\/m恒定/,
    finding:'忽略安培力随速度变化，把过程视为匀加速。',
    action:'比较不同时刻的感应电流、安培力与合力，检查加速度是否恒定。' },
  { id:'ampere-direction', title:'安培力方向', ids:[1], steps:[5],
    correct:/安培力(?:方向)?(?:向左|与速度反向)|安培力.*阻碍.*运动/,
    wrong:/安培力(?:方向)?(?:向右|与速度同向)/,
    finding:'安培力方向与当前运动情境不符。',
    action:'先确定感应电流方向，再用左手定则核对安培力方向。' },
  { id:'changing-field', title:'均匀变化的磁场', ids:[2], steps:[2,4],
    correct:/磁场.*(?:变化率|变化快慢).*恒定|磁通量.*(?:均匀变化|变化率恒定)/,
    wrong:/均匀增加.*(?:没有变化|不产生感应电动势)|磁通量(?:不变|没有变化)/,
    finding:'混淆“均匀变化”与“不发生变化”。',
    action:'区分物理量本身与变化率；结合磁场变化判断磁通量是否变化。' },
  { id:'limiting-state', title:'极限状态分析', ids:[4], steps:[],
    correct:/最大速度.*合力(?:为零|=0)|加速度(?:为零|=0).*最大速度/,
    wrong:/速度会无限增大|没有最大速度/,
    finding:'未考虑安培力增大后对加速过程的限制。',
    action:'分析速度增大时安培力和加速度的变化，再寻找极限状态。' },
  { id:'resistor-power', title:'电阻功率与总功率', ids:[4], steps:[],
    correct:/P(?:R|_R|ᵣ)=I²R|电阻R.*功率.*I²R/,
    wrong:/电阻R.*功率.*Fv|P(?:R|_R|ᵣ)=Fv/,
    finding:'混淆外力功率与外电阻消耗的功率。',
    action:'先明确求哪一部分的功率，再分别列出总电路和电阻的功率关系。' },
  { id:'capacitor-branches', title:'含电容支路的电流关系', ids:[5], steps:[],
    correct:/I棒=IR\+IC|I(?:总|棒)=I(?:R|_R)\+I(?:C|_C)|总电流.*电阻支路.*电容支路.*之和/,
    wrong:/电容器隔直.*(?:回路电流为零|没有安培力)|电容可以忽略|电容器不影响运动/,
    finding:'把电容器的稳态性质直接用于整个变化过程。',
    action:'区分暂态与稳态，分别分析各支路电流及其对导体棒受力的影响。' },
];

function rubricsFor(problem) {
  const n = /^phy-emi-0([1-5])$/.exec(problem.id)?.[1];
  return RUBRICS.filter(r => r.ids.includes(Number(n))).map(r => ({...r,
    // Use each path's actual concept/fork mapping rather than carrying step numbers across problems.
    refs:(problem.solutionGraphs ?? []).flatMap(g => g.steps.filter(s =>
      (problem.id === 'phy-emi-01' && r.steps.includes(s.index)) ||
      (r.id === 'circuit' && s.concepts?.some(c => /欧姆|内阻/.test(c))) ||
      (r.id === 'acceleration' && s.forks?.some(f => /uniform-accel|no-limit/.test(f.misconceptionId))) ||
      (r.id === 'limiting-state' && s.forks?.some(f => /no-limit/.test(f.misconceptionId))) ||
      (r.id === 'resistor-power' && s.forks?.some(f => /power-confuse/.test(f.misconceptionId))) ||
      (r.id === 'capacitor-branches' && s.forks?.some(f => /cap-open/.test(f.misconceptionId))) ||
      (problem.id === 'phy-emi-02' && r.steps.includes(s.index)) ||
      (r.id === 'cutting' && s.concepts?.some(c => /切割/.test(c)))
    ).map(s => `${g.id}:${s.index}`)),
  }));
}

function hasConcreteHelp(log, refs) {
  return !log.suppressed && !['confirm','refusal','fallback'].includes(log.form)
    && log.guardPassed !== false && log.deliveredLevel >= 2
    && refs.includes(`${log.graphId}:${log.stepIndex}`);
}

/** Numeric first attempts require an explicit asked-quantity label AND a value with unit.
 * A bare number, question, formula, copied acknowledgement or ambiguous item is excluded.
 * No answer from the reference is returned to the student.
 */
function numericAttempts(problem, logs) {
  const items = expectedAnswers(problem).items;
  const first = new Map();
  const latest = new Map();
  let helpSeen = false;
  for (let turn=0;turn<logs.length;turn++) {
    const log=logs[turn];
    const turnCandidates=[];
    for (const clause of String(log.utterance ?? '').split(/[，,；;。\n]/)) {
      if (QUESTION.test(clause) || CONFUSION.test(clause) || NEGATED.test(clause) || NON_ASSERTION.test(clause)) continue;
      const text = canonicalize(clause);
      if (logs.slice(0,turn).some(l => compact(l.hintText).includes(compact(clause)) && compact(clause).length >= 6)) continue;
      const candidates = [];
      items.forEach((it, i) => {
        if (!it.values.length) return;
        const symbol = it.label.match(/([A-Za-zΔ][A-Za-z0-9_]*)\s*$/)?.[1];
        const name = it.label.replace(/[A-Za-z0-9_Δ\s]/g, '');
        const lhs = symbol ? `(?:${escRE(symbol)}|${escRE(name)})` : escRE(name);
        const units = [...new Set(it.values.map(v => unitAlternatives(v.unit)))].join('|');
        const re = new RegExp(`(?<![A-Za-z])${lhs}\\s*(?:=|＝|为|是)\\s*(-?\\d+(?:\\.\\d+)?)\\s*(${units})(?![A-Za-z/²])`, 'g');
        const matches = [...text.matchAll(re)];
        if (matches.length !== 1) return;
        const match = matches[0];
        if (/[+*/×÷=]|还是|或者|或是/.test(text.slice(match.index + match[0].length))) return;
        const correct = it.values.some(v => Number(v.value) === Number(match[1]) && new RegExp(`^(?:${unitAlternatives(v.unit)})$`).test(match[2]));
        candidates.push({i, correct, quote:clause.trim().slice(0,120)});
      });
      turnCandidates.push(...candidates);
    }
    for (const a of turnCandidates) {
      const own=turnCandidates.filter(b => b.i===a.i);
      if (own.some(b => b.correct !== a.correct)) continue;
      latest.set(a.i,a);
      if (!first.has(a.i)) first.set(a.i,{...a,independent:!helpSeen});
    }
    // Without a reviewed hint-to-subquestion mapping, any concrete help makes later
    // first attempts ineligible. Prefer fewer data to falsely inflated accuracy.
    if (hasConcreteHelp(log, [`${log.graphId}:${log.stepIndex}`])) helpSeen = true;
  }
  const eligible = [...first.values()].filter(a => a.independent);
  const correct = eligible.filter(a => a.correct).length;
  return {accuracy:{correct, total:eligible.length, percent:eligible.length ? Math.round(correct / eligible.length * 100) : null},
    feedback:[...first.values()].filter(a => !a.correct).map(a => {
      const end = latest.get(a.i);
      const fixed = end.correct;
      return {id:`answer-${a.i}`,title:`第 ${a.i+1} 小问作答`,status:fixed ? 'corrected' : 'pending',
        finding:fixed ? '后续结果已修正；首次作答记录仍保留。' : '已提交的数值与本题可核验结果不一致，具体错因尚待定位。',
        action:'重新检查列式、代入值和单位，再独立核算这一个小问。',
        evidence:[{result:'incorrect',quote:a.quote}, ...(fixed ? [{result:'correct',quote:end.quote}] : [])],
        priority:fixed ? 2 : 1};
    })};
}

export function assessLearning(problem, record) {
  const logs = record.hintLog ?? [];
  const states = rubricsFor(problem).map(r => ({r, events:[], help:false, errorTurns:new Set()}));
  for (let turn=0; turn<logs.length; turn++) {
    const log = logs[turn];
    const raw = String(log.utterance ?? '');
    for (const state of states) {
      const {r} = state;
      let evaluated = false;
      for (const clause of raw.split(/[。；;\n]/).filter(Boolean)) {
        const current = clause.split(/现在改为|现在应为|改正为|更正为/).at(-1);
        const text = compact(current);
        if (ACK.test(current) || QUESTION.test(current) || CONFUSION.test(current) || NON_ASSERTION.test(current)) continue;
        const priorWrong = state.events.some(e => e.result === 'incorrect');
        const contradicted = r.wrong?.test(text) && !NEGATED.test(current);
        const corrected = r.correct.test(text) && !NEGATED.test(current) && !contradicted;
        if (!contradicted && !corrected) continue;
        // Exact repetition of an earlier assistant reply is not independent evidence.
        const copied = logs.slice(0,turn).some(l => compact(l.hintText).includes(text) && text.length >= 6);
        if (copied) continue;
        const result = contradicted ? 'incorrect' : 'correct';
        if (contradicted && state.help) state.errorTurns.add(turn);
        state.events.push({result, quote:clause.trim().slice(0,120), turn,
          independent:!state.help && !priorWrong,
          explained:REASON.test(current) && Boolean(EXPLANATIONS[r.id]?.test(current))});
        evaluated = true;
      }
      const currentEvents=state.events.filter(e => e.turn===turn);
      if (currentEvents.some(e => e.result==='incorrect') && currentEvents.some(e => e.result==='correct')) {
        state.events=state.events.filter(e => e.turn!==turn);
        state.errorTurns.delete(turn);
      }
      const located = r.refs.includes(`${log.graphId}:${log.stepIndex}`);
      if (!evaluated && CONFUSION.test(raw) && located) state.events.push({result:'confused', quote:raw.slice(0,120), turn});
      if (hasConcreteHelp(log,r.refs)) state.help = true;
    }
  }
  const knowledge = [], feedback = [];
  for (const {r,events,errorTurns} of states) {
    const latest = events.at(-1);
    const lastVerdict = events.filter(e => e.result !== 'confused').at(-1);
    let status = 'unknown';
    if (latest?.result === 'correct') status = latest.independent && latest.explained ? 'mastered' : 'consolidate';
    else if (latest?.result === 'incorrect') status = errorTurns.size >= 2 ? 'weak' : 'consolidate';
    knowledge.push({id:r.id,title:r.title,status,evidence:events.slice(-2)});
    const difficulty = events.some(e => ['incorrect','confused'].includes(e.result));
    if (!difficulty) continue;
    const resolved = latest?.result === 'correct';
    feedback.push({id:r.id,title:r.title,status:resolved ? 'corrected' : 'pending',
      finding:resolved ? (events.some(e => e.result === 'incorrect') ? (r.finding || '该步骤曾出现作答错误。') : '该步骤曾表达困惑。') + '本题已修正，仍需独立验证。'
        : lastVerdict?.result === 'incorrect' ? r.finding || '该步骤的作答仍需核对。'
        : '已表达困惑，尚无足够作答证据判断是否理解。',
      action:resolved ? '不看提示，重新说明这一步的依据并独立完成。' : r.action,
      evidence:events.filter(e => e.result !== 'correct' || resolved).slice(-2),
      priority:resolved ? 2 : status === 'weak' ? 0 : 1});
  }
  const numeric = numericAttempts(problem,logs);
  // Deduplicate the SAME utterance only; an unrelated resolved concept must not hide
  // a still-incorrect numeric answer in a different subquestion.
  feedback.push(...numeric.feedback.filter(n => !feedback.some(f =>
    f.evidence.some(e => e.result === 'incorrect' && n.evidence.some(ne => ne.quote === e.quote)))));
  // No rubric match: keep genuine help requests visible, without inventing a concept/error.
  if (!feedback.length) {
    const request = logs.find(l => CONFUSION.test(l.utterance ?? '') && !ACK.test(l.utterance ?? ''));
    if (request) feedback.push({id:'unlocated', title:'解题思路待明确',status:'pending',
      finding:'已表达困难，暂无法可靠定位到具体知识点。',
      action:'补充当前列式或不理解的步骤，以便进一步定位。',
      evidence:[{result:'confused',quote:String(request.utterance).slice(0,120)}],priority:1});
  }
  return {version:'evidence-v1',scope:'本题表现，不代表长期掌握',knowledge,
    accuracy:numeric.accuracy,
    feedback:feedback.sort((a,b) => a.priority-b.priority).slice(0,3)};
}
