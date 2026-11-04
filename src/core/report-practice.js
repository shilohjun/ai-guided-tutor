/** Report-only practice matching. Never use a broad topic as an error diagnosis. */
import { QBANK_SOURCE } from './qbank-source.data.js';
import { QBANK_GRAPHS } from './qbank-graphs.data.js';

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

export function buildReportPractice(problem, assessment, review, {excludeIds=[]}={}) {
  const excluded = new Set([problem.id,...excludeIds]);
  const ceiling = Number.isFinite(problem.difficulty) ? problem.difficulty : 3;
  const select = (filter, reason, target) => QBANK_SOURCE
    .filter(q => !excluded.has(`qbank-${q.i}`) && difficulty(q) <= ceiling && filter(q))
    .sort((a,b) => difficulty(a)-difficulty(b) || a.i-b.i)
    .map(q => ({bankId:q.i,problemId:`qbank-${q.i}`,code:q.code,
      difficulty:difficulty(q),type:q.ty,province:q.p,preview:q.stemText.replace(/\s+/g,' ').slice(0,110),reason,target}));
  return {
    version:'reviewed-practice-v1',
    knowledge:(review.knowledge || []).map(k => {
      // Bank cards already carry exact leaf IDs; fixture aliases are reviewed mappings.
      const id = k.id || leaves.find(x=>x.name===KNOWLEDGE[k.formulaKey])?.id;
      const exists = leaves.some(x=>x.id===id);
      return {items:exists ? select(q=>q.knowledgeIds.includes(id),
        `题库知识标签：${k.title}。`,`结合题目条件运用${k.title}。`) : []};
    }),
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
