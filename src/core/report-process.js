/** Describe observed requests for help, never infer a misconception from a question. */
const GROUPS=[
  {id:'direction',title:'方向判断待核对',match:/方向|左手定则|右手定则/,
    action:'先明确要判断的物理量及其参照方向，标出题目已给方向，再说明所用定则或关系的适用条件。'},
  {id:'condition',title:'规律适用条件待核对',match:/前提|适用|成立|漏.*条件|条件.*(?:满足|遗漏|漏掉|能用)|为什么.*能用/,
    action:'写出当前使用的关系式，逐项对照题干检查模型、方向和过程条件；明确哪一个条件尚未确认。'},
  {id:'law',title:'规律选择待说明依据',match:/规律|定律|公式|入手|思路|用哪|怎么开始/,
    action:'先写清题目中的物理过程、变化的量和待求量，再选能联系它们的规律，并说明选用依据。'},
  {id:'calculation',title:'计算与单位待核对',match:/单位|计算|算不出|代入|运算|怎么算/,
    action:'保留当前列式，逐行检查代入值、单位和运算；指出从哪一行开始无法继续。'},
  {id:'diagram',title:'图示与研究对象待核对',match:/受力图|画图|示意图|电路图/,
    action:'先说明研究对象，再列出图中每个箭头或连接的物理含义；标出你不确定的位置，并核对题目条件。'},
  {id:'goal',title:'题意与待求量待明确',match:/要干什么|求什么|问什么|题意|看不懂题|已知条件/,
    action:'把题目要求与已知条件分开列出，说明哪一个待求量或哪一句题意还不理解。'},
];
const CONFUSED=/不知道|不会|不懂|没懂|不明白|不理解|忘了|没思路|卡住|卡在|看不懂|想不出|不确定|还是不|仍然不/;
const HELP=/[?？]|吗|怎么|如何|为什么|哪条|哪个|能否|请.*(?:提示|解释)|给.*提示/;
const OFFTOPIC=/人生|游戏|电影|天气|笑话|旅游|吃什么|股票/;
const QUOTED=/举例|比如|老师说|老师问|AI说|参考答案/;

export function processFeedback(logs,{knownFeedback=[],resolved=[],checkpoints=[]}={}) {
  const groups=new Map();
  let previous=null,previousTurn=null;
  for (let turn=0;turn<logs.length;turn++) {
    const log=logs[turn],text=String(log.utterance ?? '').trim();
    if (!text || OFFTOPIC.test(text) || QUOTED.test(text)) continue;
    if (!CONFUSED.test(text) && !HELP.test(text)) continue;
    const direct=GROUPS.find(g=>g.match.test(text));
    // A short follow-up may inherit a request's focus, never an arbitrary AI diagnosis.
    const group=direct || (CONFUSED.test(text) && text.length<=24 ? previous : null);
    if (!group) continue;
    previous=group;if(direct)previousTurn=turn;
    if (knownFeedback.some(f=>f.evidence?.some(e=>e.quote===text))) continue;
    let item=groups.get(group.id);
    if (!item) {item={group,events:[]};groups.set(group.id,item);}
    item.events.push({result:'help_requested',quote:text.slice(0,160),turn,focusTurn:previousTurn,
      messageIndex:log.studentMessageIndex ?? turn*2,graphId:log.graphId,stepIndex:log.stepIndex});
  }
  return [...groups.values()].map(({group,events})=>{
    const matches=(r,e)=>r.turn>e.turn && (r.requestTurns?.includes(e.turn)||r.requestTurns?.includes(e.focusTurn)||r.helpTurns?.includes(e.turn)||r.helpTurns?.includes(e.focusTurn)||
      (r.refs.includes(`${e.graphId}:${e.stepIndex}`) && (group.id==='direction' ? /direction/.test(r.id) : group.id==='condition' ? /circuit|cutting|equilibrium|flux/.test(r.id) : false)));
    const resolutions=events.map(e=>{
      const targets=checkpoints.filter(k=>k.requestTurns?.includes(e.turn)||k.requestTurns?.includes(e.focusTurn)||k.helpTurns?.includes(e.turn));
      if(targets.length){const proofs=targets.map(k=>resolved.find(r=>r.id===k.id&&matches(r,e)));return proofs.every(Boolean)?proofs:null;}
      const proof=resolved.find(r=>matches(r,e));return proof?[proof]:null;
    });
    const fixed=resolutions.every(Boolean);
    const proofs=[...new Set(resolutions.flatMap(r=>r||[]))];
    const rounds=events.map(e=>e.turn+1).join('、');
    return {id:`process-${group.id}`,kind:'process',title:fixed?group.title.replace(/待.*$/,'')+'求助已得到回应':group.title,status:fixed?'corrected':'pending',
      finding:`第${rounds}轮围绕${group.title.replace(/待.*$/,'')}求助，共${events.length}次。`+
        (fixed?'之后已有对应步骤的正确作答证据，独立迁移仍待验证。':'这些记录说明需要支持，尚不足以认定已经答错或已掌握。'),
      action:fixed?(proofs.find(r=>r.transferTask)?.transferTask||'不看提示，再独立解释这一步的依据。'):group.action,
      evidence:[...events,...proofs.filter(r=>r.quote).map(r=>({result:'correct',quote:r.quote,turn:r.turn,messageIndex:r.messageIndex}))],helpRounds:events.length,
      priority:group.id==='goal'?2:1};
  }).sort((a,b)=>a.priority-b.priority || b.helpRounds-a.helpRounds || a.evidence[0].turn-b.evidence[0].turn);
}
