/** Report-only feedback based on explicit student statements, not inferred mastery. */
const rodProblems = ['phy-emi-01', 'phy-emi-03', 'phy-emi-04', 'phy-emi-05'];
const resistorProblems = ['phy-emi-01', 'phy-emi-03', 'phy-emi-04'];
const normalize = s => String(s ?? '').normalize('NFKC').replace(/\s+/g, '');
const uncertainty = s => /不知道|不懂|不会|不明白|不确定|忘了|忘记|怎么|如何|为什么|是否|是什么|取什么|多少|能否|对吗|对不对|还是|[?？]/.test(s);
const quotingOther = s => /你(?:刚才|之前)?说|AI说|老师说|答案说|提示里说|按你说的/.test(s);
const onlyConfusion = s => /^(?:我)?(?:还是|完全|真的|仍然|也)?(?:不知道|不懂|不明白|不会|没看懂|没听懂|不确定|卡住了)(?:这一步|怎么做|了)?[!?？。！]*$/.test(s);

// Only concrete cases with known conditions are checked. Unknown problems stay unclassified.
const RULES = [
  {
    id: 'effective-length', key: 'cutting', problems: rodProblems,
    context: /有效(?:切割)?长度|导轨间距/,
    shortResolve: s => /^(?:两条)?导轨(?:之间的)?间距[。.!！]*$/.test(s),
    title: '有效切割长度的判断需要核对',
    action: '在题图中标出有效切割长度，并说明它与导轨间距的关系。',
    revisedTitle: '有效切割长度的取值已补充',
    revisedAction: '下次列式前，先标出有效切割部分，再核对运动和磁场方向。',
    detect: s => /有效(?:切割)?长度|导轨间距|棒的?(?:总)?长/.test(s) &&
      (uncertainty(s) || /有效(?:切割)?长度(?:是|等于|取|为)(?:棒的?总长|导轨总长|位移)/.test(s)),
    resolve: s => !uncertainty(s) && !/不是|不等于|不能|无关/.test(s) &&
      /有效(?:切割)?长度(?:应取|应该取|应是|应该是|就是|是|等于|取|为|对应)(?:两条)?导轨(?:之间的)?间距/.test(s),
  },
  {
    id: 'total-resistance', key: 'circuit', problems: resistorProblems,
    context: /总电阻|分母|回路.{0,5}电阻/,
    shortResolve: s => /^(?:R\+r|r\+R)[。.!！]*$/.test(s),
    title: '闭合回路的总电阻需要核对',
    action: '画出闭合回路，标出电流经过的全部电阻，再检查电流式的分母。',
    revisedTitle: '总电阻的取值已补充完整',
    revisedAction: '下次列电流关系前，继续核对棒与外电路的电阻是否都已计入。',
    detect: s => /I=E\/[（(]?R[)）]?(?![+a-zA-Z])/.test(s) ||
      /(?:总电阻|内阻|棒的电阻|分母|R\+r|R和r)/.test(s) && uncertainty(s) ||
      /(?:棒的电阻|内阻)(?:可以)?(?:不计|忽略)|(?:总电阻|分母)(?:只取|只用|只有|等于|是)R(?![+a-zA-Z])/.test(s),
    resolve: s => !uncertainty(s) && !/不是|不等于|不用|不能|无需|不需要|不应|不能算/.test(s) &&
      /(?:总电阻|分母)(?:应为|应该是|就是|是|取|为|等于)(?:R\+r|r\+R)|I=E\/(?:\(R\+r\)|\(r\+R\))/.test(s),
  },
  {
    id: 'force-condition', key: 'ampere', problems: ['phy-emi-01'],
    context: /匀速|合力|受力/,
    title: '匀速条件与实际受力需要区分',
    action: '画出导体棒的受力图，分别标注各力，再检查水平方向的合力。',
    revisedTitle: '合力与各个作用力已作区分',
    revisedAction: '下次遇到匀速条件，仍先列实际作用力，再检查合力。',
    detect: s => !/不(?:是|表示|代表|等于)(?:没有力|不受力|各(?:个)?力都(?:为|是)?零)/.test(s) && /(?:匀速|合力|受力)/.test(s) &&
      (/不受力|没有力|各(?:个)?力都(?:是|为)?零|安培力(?:是|为|等于)零/.test(s) || uncertainty(s)),
    resolve: s => !uncertainty(s) && /合力(?:等于|为|是)零/.test(s) &&
      /不(?:是|表示|代表|等于)(?:各(?:个)?力|没有力|不受力)|各(?:个)?力(?:不一定|并不|不)(?:为|是|等于)?零|仍(?:然)?受/.test(s),
  },
  {
    id: 'flux-change', key: 'flux', problems: ['phy-emi-02'],
    context: /磁通量|磁场.{0,6}变化|均匀/,
    title: '磁场均匀与随时间变化需要区分',
    action: '分别写出“空间上均匀”和“随时间变化”的含义，再判断磁通量是否变化。',
    revisedTitle: '磁场的空间分布与时间变化已作区分',
    revisedAction: '下次先标明磁通量变化来自磁场、面积还是夹角，再选择关系式。',
    detect: s => !/均匀(?:并)?不(?:代表|表示|意味|等于)/.test(s) && /均匀|磁通量|磁场变化/.test(s) &&
      (uncertainty(s) || /均匀.*(?:不变|不会变化|没有变化|没有感应|不产生感应)/.test(s)),
    resolve: s => !uncertainty(s) &&
      (/空间.*均匀.*时间.*(?:仍|可以|会|在|均匀)?变化/.test(s) || /均匀不(?:表示|代表|等于)(?:磁场)?(?:不变|没有变化)/.test(s)),
  },
];

export function buildPersonalFeedback(problem, record, review) {
  const rules = RULES.filter(r => r.problems.includes(problem.id) && problem.subject === 'physics');
  const items = new Map();
  const turns = (record.turns ?? []).filter(t => t.role === 'student' && typeof t.text === 'string');
  let previousAI = '', round = 0;
  for (const turn of record.turns ?? []) {
    if (turn.role === 'ai' && typeof turn.text === 'string') { previousAI = turn.text; continue; }
    if (turn.role !== 'student' || typeof turn.text !== 'string') continue;
    round++;
    const text = normalize(turn.text);
    if (!text || quotingOther(text)) continue;
    const relevantQuestion = /[?？]|怎么|如何|哪个|什么|能否|是否|请|试一试/.test(previousAI);
    // Separate the discussed concept from a later “but I cannot do the next step”.
    for (const clause of text.split(/[,，。;；]|但是|不过|只是|但/).filter(Boolean)) for (const rule of rules) {
      let item = items.get(rule.id);
      const contextualHelp = onlyConfusion(text) && relevantQuestion && rule.context.test(previousAI);
      const shortCorrection = Boolean(item && relevantQuestion && rule.context.test(previousAI) && rule.shortResolve?.(clause));
      const evidence = { round, quote: turn.text.slice(0, 240), excerpt: turn.text.length > 240 };
      if (contextualHelp || shortCorrection) {
        evidence.question = previousAI.slice(0, 240);
        evidence.questionExcerpt = previousAI.length > 240;
      }
      if (item && (rule.resolve(clause) || shortCorrection)) {
        item.status = 'revised'; item.title = rule.revisedTitle; item.action = rule.revisedAction;
        item.evidence = [item.evidence[0], evidence]; item.latestRound = round;
      } else if ((rule.detect(clause) || contextualHelp) && !rule.resolve(clause)) {
        if (!item) {
          item = { id: rule.id, knowledgeKey: rule.key, hits: 0 };
          items.set(rule.id, item);
        }
        item.status = 'needs_review'; item.title = rule.title; item.action = rule.action;
        item.evidence = [evidence]; item.hits++; item.latestRound = round;
      }
    }
  }
  const keys = new Set((review?.knowledge ?? []).map(k => k.formulaKey));
  return {
    items: [...items.values()].sort((a, b) =>
      Number(a.status === 'revised') - Number(b.status === 'revised') || b.hits - a.hits || b.latestRound - a.latestRound)
      .slice(0, 2).map(({ hits, latestRound, ...item }) => ({ ...item,
        knowledgeKey: keys.has(item.knowledgeKey) ? item.knowledgeKey : null })),
    questionCount: turns.length,
    emptyMessage: '本次记录暂不足以形成具体反馈。',
  };
}
