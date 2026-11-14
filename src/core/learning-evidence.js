/** Shared, deterministic answer evidence. No model verdict or reference answer is returned. */
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

export function hasConcreteHelp(log, refs) {
  return !log.suppressed && !['confirm','refusal','silent','unverified'].includes(log.form)
    && log.guardPassed !== false && log.deliveredLevel >= 2
    && refs.includes(`${log.graphId}:${log.stepIndex}`);
}


export function numericAttempts(problem, logs, {formulaCards=[],historyIncomplete=false}={}) {
  const items = expectedAnswers(problem).items.map(it=>problem.source==='imported' && problem.referenceVerified!==true
    ? {...it,values:[]} : it);
  const choice = String(problem.referenceAnswer ?? '').split('\n')[0].trim();
  // Choice grading requires an exact standalone answer, never letters extracted from an explanation.
  const choiceKey = /^(?!.*([A-D]).*\1)[A-D]{1,4}$/.test(choice) && problem.source === 'qbank'
    ? [...choice].sort().join('') : null;
  const targets = choiceKey ? [{label:'选择题作答',values:[]}] : items;
  const events = targets.map(()=>[]);
  const first = new Map();
  const latest = new Map();
  let helpSeen = historyIncomplete, demonstrationSeen = false;
  for (let turn=0;turn<logs.length;turn++) {
    const log=logs[turn];
    if (formulaCards.some(card=>!card.at || !log.at || card.at<=log.at)) helpSeen=true;
    const turnCandidates=[];
    const raw=String(log.utterance ?? '');
    if (choiceKey && !QUESTION.test(raw) && !CONFUSION.test(raw) && !NON_ASSERTION.test(raw)) {
      const pick=canonicalize(raw).match(/^(?:(?:我)?(?:认为|觉得)?(?:(?:应该|应当|应)?选(?:择)?|是|答案(?:为|是|选|=|：|:)?))?\s*([A-D](?:[、,，和及\s]*[A-D]){0,3})(?:[，,；;。\s]*(?:因为|理由(?:是)?|依据)[\s\S]*)?[。！!\s]*$/i);
      if (pick) turnCandidates.push({i:0,correct:[...new Set(pick[1].toUpperCase().match(/[A-D]/g))].sort().join('')===choiceKey,quote:raw.trim().slice(0,120)});
    }
    for (const clause of choiceKey ? [] : raw.split(/[，,；;。\n]/)) {
      if (QUESTION.test(clause) || CONFUSION.test(clause) || NEGATED.test(clause) || NON_ASSERTION.test(clause)) continue;
      const text = canonicalize(clause);
      const copied=logs.slice(0,turn).some(l => l.form!=='confirm' && compact(l.hintText).includes(compact(clause)) && compact(clause).length >= 6);
      const candidates = [];
      items.forEach((it, i) => {
        if (!it.values.length) return;
        const symbol = it.label.match(/([A-Za-zΔ][A-Za-z0-9_]*)\s*$/)?.[1];
        const name = it.label.replace(/[A-Za-z0-9_Δ\s]/g, '');
        const lhs = symbol ? `(?:${escRE(symbol)}|${escRE(name)})` : escRE(name);
        const units = [...new Set(it.values.map(v => unitAlternatives(v.unit)))].join('|');
        const recognizableUnits=`${units}|m/s²|m/s|kg|Hz|Pa|Ω|V|A|W|T|N|J|C|s|m`;
        const re = new RegExp(`(?<![A-Za-z])${lhs}\\s*(?:=|＝|为|是)\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\s*(${recognizableUnits})(?![A-Za-z/²])`, 'g');
        const matches = [...text.matchAll(re)];
        if (matches.length !== 1) return;
        const match = matches[0];
        if (/[+*/×÷=或]|还是/.test(text.slice(match.index + match[0].length))) return;
        const correct = it.values.some(v => Number(v.value) === Number(match[1]) && new RegExp(`^(?:${unitAlternatives(v.unit)})$`).test(match[2]));
        candidates.push({i, correct, copied,quote:clause.trim().slice(0,120)});
      });
      turnCandidates.push(...candidates);
    }
    for (const a of turnCandidates) {
      const own=turnCandidates.filter(b => b.i===a.i);
      if (own.some(b => b.correct !== a.correct)) continue;
      const event={...a,turn,messageIndex:log.studentMessageIndex ?? turn*2,result:a.correct?'correct':'incorrect',
        independent:!helpSeen && !a.copied, assisted:helpSeen || Boolean(a.copied), demonstrated:demonstrationSeen,
        graphId:log.graphId,stepIndex:log.stepIndex};
      events[a.i]?.push(event);
      latest.set(a.i,event);
      if (!first.has(a.i)) first.set(a.i,event);
    }
    // Without a reviewed hint-to-subquestion mapping, any concrete help makes later
    // first attempts ineligible. Prefer fewer data to falsely inflated accuracy.
    if (hasConcreteHelp(log, [`${log.graphId}:${log.stepIndex}`])) helpSeen = true;
    if (!log.suppressed && log.guardPassed !== false && log.form !== 'confirm' && log.deliveredLevel >= 3) demonstrationSeen = true;
  }
  const eligible = [...first.values()].filter(a => a.independent);
  const correct = eligible.filter(a => a.correct).length;
  const subquestions=targets.map((it,i)=>{
    const last=latest.get(i), own=events[i];
    const verifiable=Boolean(choiceKey || it.values.length);
    const state=!last ? 'insufficient_evidence' : !last.correct ? 'still_incorrect'
      : historyIncomplete ? 'insufficient_evidence'
      : last.demonstrated ? 'completed_after_demonstration' : last.assisted ? 'completed_with_hint' : 'independently_completed';
    return {id:`answer-${i}`,title:it.label,state,verifiable,answered:Boolean(last),
      completed:Boolean(last?.correct),everIncorrect:own.some(e=>!e.correct),
      corrected:Boolean(last?.correct && own.some(e=>!e.correct)),evidence:own};
  });
  const done=subquestions.filter(q=>q.completed).length;
  return {subquestions,completion:{completed:done,total:targets.length,
      percent:targets.length && subquestions.every(q=>q.verifiable) ? Math.round(done/targets.length*100) : null,
      complete:targets.length>0 && done===targets.length,
      verifiable:subquestions.filter(q=>q.verifiable).length},
    accuracy:{correct, total:eligible.length, percent:eligible.length ? Math.round(correct / eligible.length * 100) : null},
    feedback:subquestions.filter(q=>q.everIncorrect).map(q => {
      const a=q.evidence.find(e=>!e.correct);
      const end = latest.get(a.i);
      const fixed = end.correct;
      return {id:`answer-${a.i}`,title:`第 ${a.i+1} 小问作答`,status:fixed ? 'corrected' : 'pending',
        finding:fixed ? '后续结果已修正；曾经的作答错误仍保留。' : '已提交的作答与本题可核验结果不一致，具体错因尚待定位。',
        action:choiceKey ? '重新检查选项的成立条件，并独立说明选择依据。' : '重新检查列式、代入值和单位，再独立核算这一个小问。',
        evidence:[{result:'incorrect',quote:a.quote}, ...(fixed ? [{result:'correct',quote:end.quote}] : [])],
        priority:fixed ? 2 : 1};
    })};
}
