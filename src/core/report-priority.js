/** Current performance and historical difficulty are separate projections.
 * Correcting this answer is not an independent transfer check.
 */
export function buildLearningSummary({knowledge=[],feedback=[]}) {
  const weaknesses=[];
  const pool=[...knowledge];
  for(const f of feedback) {
    const errors=(f.evidence??[]).filter(e=>e.result==='incorrect');
    if(!errors.length||pool.some(k=>k.id===f.id||k.evidence?.some(e=>e.result==='incorrect'&&errors.some(x=>x.quote===e.quote))))continue;
    pool.push({id:f.id,title:f.title,evidence:f.evidence,corrected:f.status==='corrected',transferTask:f.action});
  }
  for(const k of pool) {
    const errors=(k.evidence??[]).filter(e=>e.result==='incorrect');
    if(!errors.length)continue; // Help requests and missing evidence are not weaknesses.
    const latest=k.evidence.at(-1);
    const corrected=Boolean(k.corrected||latest?.result==='correct');
    const state=corrected?'corrected_pending_independent_check':latest?.result==='unverified'?'pending_verification':'unresolved';
    const detail=corrected?'曾出错，本题已修正，尚待独立验证'
      :state==='pending_verification'?'曾出错，当前表达待核验，尚未独立验证':'有明确错误，当前尚未修正';
    const card=feedback.find(f=>f.id===k.id);
    weaknesses.push({id:k.id,title:k.title.replace(/（[^）]*）$/,''),state,corrected,
      independentValidation:'not_recorded',detail,
      action:k.transferTask||card?.action||'不看提示，独立解释这一步的依据，再完成一道同类题。',
      errorRounds:new Set(errors.map(e=>e.turn??e.messageIndex)).size,
      evidence:[errors[0],...(latest!==errors[0]?[latest]:[])]});
  }
  const rank=w=>w.state==='unresolved'?0:w.state==='pending_verification'?1:2;
  weaknesses.sort((a,b)=>rank(a)-rank(b)||b.errorRounds-a.errorRounds||
    (a.evidence[0].turn??0)-(b.evidence[0].turn??0));
  const primary=weaknesses[0];
  let priorityFocus=primary?{id:primary.id,title:primary.title,kind:'observed-difficulty',
    reason:primary.detail,action:primary.action,evidence:primary.evidence}:null;
  if(!priorityFocus) {
    const assisted=knowledge.find(k=>k.state==='completed_after_demonstration')||
      knowledge.find(k=>k.state==='completed_with_hint')||
      knowledge.find(k=>k.status==='consolidate'&&k.evidence?.some(e=>e.result==='correct'));
    if(assisted)priorityFocus={id:assisted.id,title:assisted.title.replace(/（[^）]*）$/,''),kind:'needs-consolidation',
      reason:assisted.detail||'本题已有作答证据，仍需独立说明依据。',
      action:assisted.transferTask||'不看提示，重新完成这一步并解释所用依据。',evidence:assisted.evidence.slice(-1)};
  }
  if(!priorityFocus) {
    const request=feedback.find(f=>f.kind==='process'&&f.status==='pending');
    if(request)priorityFocus={id:request.id,title:request.title,kind:'support-request',
      reason:'学生在此处求助，尚不能确认具体错误。',action:request.action,evidence:request.evidence};
  }
  return {weaknesses,priorityFocus,focusMessage:knowledge.some(k=>k.status==='mastered')
    ?'暂无突出卡点，可独立验证':'先补充解题依据，再确定重点'};
}
