/** Report-only practice matching. Never use a broad topic as an error diagnosis. */
import { QBANK_SOURCE } from './qbank-source.data.js';
import { QBANK_KEYSTEPS } from './qbank-keysteps.data.js';
import { QBANK_GRAPHS } from './qbank-graphs.data.js';
import { keypointOverlap } from './similarity.js';

const difficulty = q => ({'易':2,'中':3,'难':4}[q.d] || 3);
const leaves = QBANK_GRAPHS.knowledge.flatMap(m => m.children.flatMap(c => c.children));
const KNOWLEDGE = {cutting:'导体棒切割',circuit:'闭合电路欧姆定律',ampere:'安培力与磁场',flux:'法拉第电磁感应定律',charge:'电功率与焦耳定律',momentum:'动量定理',energy:'功能关系与能量守恒',power:'功与功率',capacitor:'电容器'};
const METHODS = {chain:'t1b',balance:'t3b',change:'t1b',accumulate:'t1b',account:'t2c',limit:'t6c',branches:'t3b'};

// Explicit source review, not AI similarity or a claim of teacher certification.
// GZ-2026-10 requires the resistance of the length of rod currently in the circuit.
// HN-2026-05 concerns battery groups instead and must NOT substitute for this error.
export const REVIEWED_GAP_PRACTICE = Object.freeze([
  Object.freeze({gapId:'circuit',problemIds:['phy-emi-01','phy-emi-04'],code:'GZ-2026-10',
    target:'列电流关系前，明确接入回路的导体棒电阻。',
    reason:'该题给出导体棒单位长度电阻，需要将接入回路的棒电阻计入电流关系。'}),
]);

/**
 * 陌生题没有预编译的关键点链，就用它的解题路径现场拼一份。
 *
 * 类型是粗映射（precondition 当"前提判断"，其余当"关系建立"）——
 * 只影响"和哪道题库题更像"的排序，不影响对错；拼错了顶多排序不理想。
 */
function pseudoKeys(problem) {
  const steps = problem.solutionGraphs?.[0]?.steps ?? [];
  return steps.map((s, i) => ({
    index: i + 1,
    title: s.title,
    type: s.kind === 'precondition' ? '前提判断' : '关系建立',
    judge: s.intent ?? '',
    why: s.why ?? '',
    // 概念必须带出来：sameJudgment 判"同一个判断"要类型一致 **且** 概念有交集（或标题近似），
    // 只给标题时几乎撞不上，陌生题的推荐理由就会永远是"题库知识标签：…"这一句。
    concepts: Array.isArray(s.concepts) ? s.concepts : [],
  }));
}

export function buildReportPractice(problem, assessment, review, {excludeIds=[]}={}) {
  const excluded = new Set([problem.id,...excludeIds]);
  const ceiling = Number.isFinite(problem.difficulty) ? problem.difficulty : 3;
  const currentKeys = QBANK_KEYSTEPS[problem.qbId] ?? pseudoKeys(problem);
  // 同样是"标签命中"，但先说更细的一层：这道题和本题共用哪个关键判断。
  // 没共享判断的候选仍然可以被选，只是排在后面 —— 标签命中本身就是有效信息。
  const select = (filter, reason, target, {annotate=false}={}) => QBANK_SOURCE
    .filter(q => !excluded.has(`qbank-${q.i}`) && difficulty(q) <= ceiling && filter(q))
    .map(q => ({q, over: keypointOverlap(currentKeys, QBANK_KEYSTEPS[q.i] ?? [])}))
    .sort((a,b) => b.over.score-a.over.score || difficulty(a.q)-difficulty(b.q) || a.q.i-b.q.i)
    .map(({q,over}) => ({bankId:q.i,problemId:`qbank-${q.i}`,code:q.code,
      difficulty:difficulty(q),type:q.ty,province:q.p,preview:q.stemText.replace(/\s+/g,' ').slice(0,110),
      reason:annotate && over.shared.length ? `${reason}这道题同样要作出「${over.shared[0]}」这个判断。` : reason,
      target}));
  return {
    version:'reviewed-practice-v1',
    knowledge:(review.knowledge || []).map(k => {
      // Bank cards already carry exact leaf IDs; fixture aliases are reviewed mappings.
      const id = k.id || leaves.find(x=>x.name===KNOWLEDGE[k.formulaKey])?.id;
      const exists = leaves.some(x=>x.id===id);
      return {items:exists ? select(q=>q.knowledgeIds.includes(id),
        `题库知识标签：${k.title}。`,`结合题目条件运用${k.title}。`,{annotate:true}) : []};
    }),
    // 方法桶的理由只讲方法：这里要学生"练这一招"，把另一个判断塞进来说不通。
    // 排序仍然用关键点重合度 —— 同一招里，先给判断结构更像的那道。
    methods:(review.methods || []).map(m => {
      const id = METHODS[m.id] || (/^t\d+[a-z]?$/.test(m.id || '') ? m.id : null);
      return {items:id ? select(q=>q.methodIds.includes(id),
        `题库方法标签：${m.title}。`,`独立选择并说明${m.title}的应用依据。`) : []};
    }),
    gaps:(assessment.feedback || []).map(f => {
      const evidence = (f.evidence || []).some(e=>e.result==='incorrect');
      const rules = evidence ? REVIEWED_GAP_PRACTICE.filter(r=>r.gapId===f.id && r.problemIds.includes(problem.id)) : [];
      const items=rules.flatMap(r=>select(q=>q.code===r.code,r.reason,r.target));
      return {id:f.id,items,emptyReason:'暂无已核验且难度合适的匹配题，可先按改进建议重做本题。'};
    }),
  };
}
