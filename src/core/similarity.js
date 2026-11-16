/**
 * 两道题"像不像"的本地判断 —— 只看结构，不看数值。
 *
 * 为什么不用向量：题库只有 835 题、每道题的关键点链也只有 2–7 个，
 * 比"这个判断和那个判断是不是同一类"这种结构化比较，向量反而更糊。
 * 而且这是要跑在请求路径上的（报告页点开就要排好序），
 * 一次 835×5×5 的字符串比较比加载一个模型便宜得多。
 *
 * 用在两处：
 *   ① 报告页的"巩固这一知识点/这一方法"—— 同样是标签命中，但先说共同关键点；
 *   ② 以后检索层的词法兜底 —— 关键点重合度是可解释的召回信号。
 */

const PUNCT = /[\s，。、；：""''（）()《》〈〉·,.;:!?—\-…]/g;

function norm(value) {
  return String(value ?? '').replace(PUNCT, '');
}

/** 字二元组 Dice 系数：用于标题这种短文本的近似判断。 */
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i += 1) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g);
    if (n) {
      hit += 1;
      grams.set(g, n - 1);
    }
  }
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

/**
 * 两个关键点是不是"同一个判断"。
 * 类型必须一致 —— "选模型"和"算几何"再像也不是同一件事；
 * 在此之上，概念有交集、或标题近似，就算命中。
 */
function sameJudgment(a, b) {
  if (!a || !b) return false;
  if (norm(a.type) !== norm(b.type)) return false;
  const ca = new Set((a.concepts ?? []).map(norm).filter(Boolean));
  if (ca.size && (b.concepts ?? []).some((c) => ca.has(norm(c)))) return true;
  return dice(norm(a.title), norm(b.title)) >= 0.5;
}

/**
 * @returns {{score:number, shared:string[]}} score 是重合比例（0–1），shared 是共用的判断标题。
 */
export function keypointOverlap(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (!left.length || !right.length) return { score: 0, shared: [] };
  const used = new Set();
  const shared = [];
  for (const x of left) {
    for (let j = 0; j < right.length; j += 1) {
      if (used.has(j)) continue;
      if (sameJudgment(x, right[j])) {
        used.add(j);
        shared.push(x.title);
        break;
      }
    }
  }
  return { score: shared.length / Math.max(left.length, right.length), shared };
}
