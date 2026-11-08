import { QBANK_SOURCE } from './qbank-source.data.js';
import { buildQbankReview } from './qbank-review.js';
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
  const problem={...skeleton,id,source:'qbank',qbId:q.i,subject:'physics',
    difficulty:{'易':2,'中':3,'难':4}[q.d] || 3,stem,
    topics:[...new Set([q.chap,...review.knowledge.map(k=>k.title)])],
    referenceAnswer:answerText,answerFingerprints,reportReview:review,
    // Lossless answer/analysis/formula image assets remain server-only.
    referenceSource:{code:q.code,answerHtml:q.answerHtml,analysisHtml:q.analysisHtml,
      knowledgeIds:[...q.knowledgeIds],methodIds:[...q.methodIds]},
    graphQuality:'source-tags-with-generic-tutoring-skeleton',
  };
  cache.set(id,problem);
  return problem;
}
export const QBANK_IDS=Object.freeze([...records.keys()]);
