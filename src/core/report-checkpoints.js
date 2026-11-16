/** Reviewed, topic-scoped checkpoints. AI praise and topic tags are never evidence.
 * Imported answers remain unverified; conceptual evidence can still be checked.
 */
import {conceptText,conceptStatements,checkpointFormula} from './report-claims.js';
const normalize=conceptText;
const EXTERNAL=/老师说|AI说|参考答案|举例|假如|假设|如果/;
const UNCERTAIN=/不知道|不会|不懂|不明白|不确定|忘了|还是不/;
export const CHECKPOINTS=[
  {id:'work-net',title:'合力做功与单个力做功',scope:/功与|功和能|功和功率|动能定理|做的?功/,
    focus:/合力.*做功|单个力.*做功|匀速.*(?:做功|功)/,
    support:/匀速.*合力.*零.*(?:拉力|单个力|各个力)|合力.*(?:不代表|不等于).*(?:各力|单个力|拉力)/,
    wrong:/匀速.*(?:拉力|每个力|各个力|所有力|各力)(?:也|就|都|的)?(?:做功|功)(?:是|为|=|也|都|所以)*(?:零|0)|匀速.*(?:拉力|每个力|各个力|所有力|各力)(?:就|都|也)?不做功/,
    correct:/匀速.*合力.*(?:功.*(?:零|0)|为零).*但.*(?:拉力|单个力|各力).*(?:正功|做功|不为零)|合力做功(?:为零|=0|是零).*不(?:代表|等于|意味着).*(?:单个力|各力|拉力).*不做功/,
    reason:/匀速|动能不变|动能定理/,
    finding:'把匀速时合力做功为零，误认为拉力或各个力都不做功。',
    action:'分别写出合力和拉力的功，说明为什么一个为零、另一个可以不为零。',
    transfer:'换成匀速上升的物体，分别判断合力、拉力与重力做功。'},
  {id:'work-angle',title:'根据力与位移判断功的正负',scope:/功与|功和能|功和功率|做的?功|动能定理/,
    focus:/功.*(?:正负|方向)|力.*位移.*(?:夹角|方向)/,
    support:/(?:力|拉力).*位移.*(?:同向|反向|垂直).*(?:正功|负功|功.*零|不做功)/,
    correct:/(?:力|拉力).*位移.*同向.*(?:正功|功为正)|(?:力|拉力).*位移.*反向.*(?:负功|功为负)|(?:力|拉力).*位移.*垂直.*(?:不做功|功为零)/,
    wrong:/(?:力|拉力).*位移.*垂直.*做正功|(?:力|拉力).*位移.*同向.*做负功/,
    reason:/因为|所以|夹角|方向|同向|垂直|反向/,
    finding:'力与位移的方向关系和功的正负判断不一致。',
    action:'标出所研究的力与位移方向，用两者夹角解释功的正负。',
    transfer:'只改变力的方向，比较同向、反向、垂直三种情况下的功。'},
  {id:'work-formula',title:'恒力做功的列式与条件',scope:/功与|功和能|功和功率|做的?功/,
    focus:/做功|功的公式|功怎么算|W=|力乘位移/,
    support:/(?:力|拉力)(?:的大小)?(?:乘以|乘|×|\*|和位移相乘)位移|同向.*恒力.*(?:功|力乘)|功.*(?:力乘位移|力与位移的乘积)|做功.*(?:看|取决于).*力.*(?:沿力方向|同向).*位移/,
    correct:/W=F(?:\*|·|×)?s(?:cos[θα])?(?![A-Za-z0-9²³/^])/i,
    reason:/(?:力|拉力|恒力).*位移.*同向|恒力.*同向|同向.*恒力|沿力方向|夹角.*cos|cos.*夹角/,
    finding:'恒力做功的列式或力与位移的方向条件存在错误。',
    action:'说明力是否恒定、位移是否沿力方向，再列功的关系式。',
    transfer:'将拉力改为与位移成角度，说明列式需要怎样调整。'},
  {id:'power-average',title:'平均功率的含义',scope:/功率|功和能/,
    focus:/功率|P=|功与时间|功和时间/,
    support:/功.*(?:除以?|摊到|分摊到).*(?:时间|秒|\ds)|(?:平均功率|功率).*功.*时间.*(?:比|商)|功率.*单位时间.*(?:做功|功)/,
    correct:/P=W\/(?:t|Δt)(?![A-Za-z0-9²³/^])|平均功率.*(?:功与时间.*比|功除以.*时间)/,
    reason:/平均|这段时间|总功|时间内|功.*时间.*比/,
    finding:'平均功率应使用功与对应时间的比值，当前关系式或解释有误。',
    action:'指出计算的是哪段时间的功，再用功与对应时间的比值求平均功率。',
    transfer:'若同样的功用两倍时间完成，解释平均功率如何变化。'},
  {id:'photo-threshold',title:'光电效应发生的条件',scope:/光电效应/,
    focus:/光电效应|逸出功|截止频率|光子能量/,
    support:/光子.*能量.*(?:比较|大于|不小于|逸出功)|逸出功.*(?:门槛|光子)/,
    correct:/(?:光电效应|发生条件|发生光电).*(?:光子能量|hν).*(?:不小于|大于等于|≥|>=).*(?:逸出功|W0|W₀)|hν(?:≥|>=)(?:W0|W₀)/,
    wrong:/只要.*(?:光强|强度).*大.*(?:能发生光电|产生光电子)|频率.*低于.*截止频率.*(?:仍能|也能).*光电/,
    reason:/比较|因为|所以|条件|门槛|能量/,
    finding:'把光强与是否发生光电效应的能量门槛混淆。',
    action:'分别比较入射光子能量与每种金属的逸出功，不以光强代替能量门槛。',
    transfer:'光的频率低于截止频率时，只增大光强能否产生光电子？说明原因。'},
  {id:'induction-change',title:'磁通量变化与变化率',scope:/电磁感应|磁通量|感应电动势/,
    focus:/磁通量|变化率|感应电动势/,
    support:/磁通量.*变化率|磁场.*均匀.*(?:变化|增加).*变化率/,
    correct:/磁通量.*均匀变化.*(?:电动势.*恒定|变化率.*恒定)|磁场.*均匀增加.*(?:变化率.*恒定|磁通量.*变化)/,
    wrong:/均匀增加.*(?:没有变化|不产生感应电动势)|磁通量.*不变.*(?:仍产生|也产生).*感应电动势/,
    reason:/变化率|均匀|面积|角度/,
    finding:'混淆物理量不变和物理量的变化率不变。',
    action:'分别检查磁场、面积、夹角及其变化，再说明磁通量的变化率。',
    transfer:'比较磁场恒定与磁场均匀增加时的磁通量变化。'},
];

/** Count delivered semantic scaffolding even if the tutor labelled it L0/L1.
 * Never count mere praise, silence, rejected outputs or general encouragement. */
export function checkpointSupport(r,log) {
  if(log.suppressed||log.guardPassed===false||['confirm','silent','refusal','unverified'].includes(log.form))return false;
  const text=normalize(log.hintText);
  return Boolean(text&&(r.correct.test(text)||r.support?.test(text)));
}

export function checkpointAssessment(problem,record) {
  const scope=[...(problem.topics??[]),problem.stem??''].join(' ');
  const logs=record.hintLog??[],knowledge=[],feedback=[];
  const supported=CHECKPOINTS.filter(r=>r.scope.test(scope));
  for(const r of supported) {
    const events=[],helpTurns=[],requestTurns=[];let help=Boolean(record.historyIncomplete),demonstrated=false;
    for(let turn=0;turn<logs.length;turn++) {
      const l=logs[turn],raw=String(l.utterance??'');
      if(!EXTERNAL.test(raw)&&r.focus?.test(raw)&&(/[?？]|吗|哪|怎么|如何/.test(raw)||UNCERTAIN.test(raw)))requestTurns.push(turn);
      if((record.formulaCards??[]).some(c=>!c.at||!l.at||c.at<=l.at)) help=true;
      for(const statement of conceptStatements(raw)) {
      if(!EXTERNAL.test(statement)&&!UNCERTAIN.test(statement)) {
        // Keep a student's asserted reasoning even when followed by “对吗”.
        const text=normalize(statement.replace(/(?:对吗|对不对|是不是这样)[?？。\s]*$/,''));
        const formula=checkpointFormula(r.id,statement);
        const wrong=formula ? formula.result==='incorrect' : r.wrong?.test(text)&&!/不是|并非|不能说|不意味着|不代表/.test(statement);
        const correct=formula ? formula.result==='correct' : r.correct.test(text)&&!/不能用|不应使用|不适用|公式.*错|公式.*不对/.test(statement);
        if(Boolean(wrong)!==Boolean(correct)||formula?.result==='unverified') {
          const copied=logs.slice(0,turn).some(x=>x.form!=='confirm'&&normalize(x.hintText).includes(text)&&text.length>=8);
          const substantive=!/为什么|怎么|如何|能否|是否/.test(text)&&
            (!/[?？]|吗/.test(statement)||/因为|所以|我认为|我觉得|我的理解/.test(statement));
          if(substantive) events.push({result:wrong?'incorrect':correct?'correct':'unverified',quote:statement.slice(0,240),turn,
            messageIndex:l.studentMessageIndex??turn*2,assisted:help||copied,demonstrated,
            independent:!help&&!copied&&!record.historyIncomplete,explained:r.reason.test(text)});
        }
      }
      }
      const thisTurn=events.filter(e=>e.turn===turn);
      if(thisTurn.some(e=>e.result==='correct')&&thisTurn.some(e=>e.result==='incorrect')&&
        !/改正为|更正为|现在应为|现在改为|而是/.test(raw)) {
        while(events.at(-1)?.turn===turn)events.pop();
        events.push({result:'unverified',quote:raw.slice(0,240),turn,messageIndex:l.studentMessageIndex??turn*2,
          independent:false,assisted:help,explained:false});
      }
      // Only topical help: unrelated hints must not demote this concept.
      const delivered=checkpointSupport(r,l);
      const topical=delivered||r.wrong?.test(normalize(l.hintText))||
        (l.evidenceQuotes??[]).some(q=>raw.includes(q)&&(r.correct.test(normalize(q))||r.wrong?.test(normalize(q))));
      if(topical&&!l.suppressed&&l.guardPassed!==false&&!['confirm','silent','refusal','unverified'].includes(l.form)&&(delivered||l.deliveredLevel>=2)) {
        help=true;helpTurns.push(turn);if(l.deliveredLevel>=3)demonstrated=true;
      }
    }
    const last=events.at(-1),errors=events.filter(e=>e.result==='incorrect'),corrected=last?.result==='correct'&&errors.length>0;
    const status=!last||last.result==='unverified'?'unknown':last.result==='incorrect'?'weak':last.independent&&last.explained&&!corrected?'mastered':'consolidate';
    const detail=!last?'尚无作答证据':last.result==='unverified'
      ? events.slice(0,-1).some(e=>e.result==='correct')?'后续表达已改变，先前判断失效，当前待核验':'当前公式尚未核验，暂不判断掌握'
      :last.result==='incorrect'?'有明确错误，尚未修正':corrected?'曾有错误，本题已修正':last.demonstrated?'示范后完成，需独立验证':last.assisted?'提示后完成，需独立验证':last.explained?'本题能说明依据':'能列式，适用依据仍待说明';
    knowledge.push({id:r.id,title:r.title,status,detail,everIncorrect:errors.length>0,corrected,
      state:!last||last.result==='unverified'?'insufficient_evidence':last.result==='incorrect'?'still_incorrect':last.demonstrated?'completed_after_demonstration':last.assisted?'completed_with_hint':'independently_completed',
      evidence:events,helpTurns,requestTurns,transferTask:r.transfer});
    if(errors.length) feedback.push({id:r.id,title:r.title,status:corrected?'corrected':'pending',
      finding:r.finding+(corrected?'后续已给出正确解释；原有卡点保留，不视为长期掌握。':'当前仍缺少对应的正确解释。'),
      action:corrected?r.transfer:r.action,evidence:[errors[0],...(corrected?[last]:[])],priority:corrected?2:0});
  }
  return {knowledge,feedback,coverage:{supported:supported.map(r=>({id:r.id,title:r.title})),
    observed:knowledge.filter(k=>k.evidence.length).length,note:'仅判断已配置且有学生原话支持的检查点；未覆盖部分不推测。'}};
}
