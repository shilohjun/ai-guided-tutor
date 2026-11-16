import { QBANK_SOURCE } from './qbank-source.data.js';
import { QBANK_KEYSTEPS } from './qbank-keysteps.data.js';
import { buildQbankReview } from './qbank-review.js';
import { keystepsToGraphs } from './keysteps.js';
import { heuristicSkeleton, deriveAnswerFingerprints } from './intake.js';

// Stable registration: selecting a bank question never loses its original identity.
const cache=new Map();
const records=new Map(QBANK_SOURCE.map(q=>[`qbank-${q.i}`,q]));
export function getQbankProblem(id) {
  if (cache.has(id)) return cache.get(id);
  const q=records.get(id);
  if (!q) return null;
  const stem=q.stemText+'\n'+q.options.map(o=>`${o.l}. ${o.text}`).join('\n');
  const skeleton=heuristicSkeleton(stem,'physics');
  const review=buildQbankReview(q);
  const answerText=[q.answerText,q.analysisText].filter(Boolean).join('\n');
  const choice=q.answerText.trim().replace(/[^A-D]/g,'');
  const answerFingerprints=deriveAnswerFingerprints(answerText,skeleton.givens,stem);
  if (/^[A-D]{1,4}$/.test(choice)) answerFingerprints.push(`(?:答案|选项|选择|故选)[为是：:\\s]*${choice}(?![A-Za-z])`);
  // 真题的解题路径来自官方解析编译出的关键点链（scripts/build-qbank-keysteps.mjs）。
  // 没有编译结果的题才退回通用六步骨架 —— 那时候 graphQuality 会如实自认骨架。
  const keysteps=QBANK_KEYSTEPS[q.i];
  const problem={...skeleton,id,source:'qbank',qbId:q.i,subject:'physics',
    difficulty:{'易':2,'中':3,'难':4}[q.d] || 3,stem,
    // 骨架的 summary 带头写着"（通用骨架）"，而这条路已经不是骨架了 ——
    // 换成题目自己的定位，报告页与读题卡片都能用上。
    summary:keysteps ? `${q.chap}·${q.leaf}：${q.stemText.replace(/\s+/g,' ').slice(0,50)}` : skeleton.summary,
    topics:[...new Set([q.chap,...review.knowledge.map(k=>k.title)])],
    referenceAnswer:answerText,answerFingerprints,reportReview:review,
    // Keep the original question's figures/formula images with the session, not just text placeholders.
    questionAssets:{stemHtml:q.stemHtml,options:structuredClone(q.options)},
    // Lossless answer/analysis/formula image assets remain server-only.
    referenceSource:{code:q.code,answerHtml:q.answerHtml,analysisHtml:q.analysisHtml,
      knowledgeIds:[...q.knowledgeIds],methodIds:[...q.methodIds]},
    solutionGraphs:keysteps ? keystepsToGraphs(keysteps,{id:'g-main',name:'本题关键点'}) : skeleton.solutionGraphs,
    graphQuality:keysteps ? 'source-analysis-keypoints' : 'source-tags-with-generic-tutoring-skeleton',
  };
  cache.set(id,problem);
  return problem;
}
export const QBANK_IDS=Object.freeze([...records.keys()]);
