/**
 * 陌生题归类：把一段题干映射到题库**既有**的知识叶节点与方法节点上。
 *
 * 为什么要这一层：
 *   学生粘贴的是题库里没有的题。以前它读出来只有一串自由文本 topics，
 *   跟 94 个叶节点、38 个方法节点没有任何绑定 —— 报告页只能说"暂未配置",
 *   提示也只能靠通用骨架。有了这一层，陌生题至少知道"自己在知识树的哪儿"。
 *
 * 为什么不先上 embedding：
 *   节点画像 = 该节点下所有真题的题干 + 关键点标题/判断/概念，本质是词面问题。
 *   词法能到多少是量出来的（留一法：叶节点 @3 95.7%、@5 98.8%），
 *   先用手上这条能解释、能测、零依赖的，等它不够再换。
 *
 * 关键约定：**只从既有节点里选，不发明新节点**。候选之外一律不认。
 */
import { QBANK_SOURCE } from './qbank-source.data.js';
import { QBANK_KEYSTEPS } from './qbank-keysteps.data.js';
import { QBANK_GRAPHS } from './qbank-graphs.data.js';

const K1 = 1.2;
// 画像由几十道题的文本拼成，比单篇长得多，b 取小值，否则长度会把分数压死。
const B = 0.35;
// 画像长度基准：题库题的平均画像规模，让 dl/基准 落在 1 附近。
const DL_BASE = 400;
/**
 * 低于这个分就不给结论：宁可说"没归类"，也不要硬塞一个错的知识点。
 *
 * 标定依据（.tmp-rag/calib.mjs）：与物理无关的句子 top1 只有 0.2~2.1 分，
 * 真题 top1 的 p10 是 13.7、最低 7.7。取 8 落在两者之间的空白带里。
 */
const MIN_LEAF_SCORE = 8;
const MIN_METHOD_SCORE = 6;

function clean(s) {
  return String(s ?? '')
    .replace(/〔[^〕]*〕/g, ' ')
    .replace(/⟨[^⟩]*⟩/g, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, ' ');
}

function grams(s) {
  const t = clean(s).replace(/\s+/g, '');
  const m = new Map();
  for (let i = 0; i < t.length - 1; i += 1) {
    const g = t.slice(i, i + 2);
    if (/^\d\d$/.test(g)) continue;
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

function addTo(map, g, w = 1) {
  for (const [k, v] of g) map.set(k, (map.get(k) || 0) + v * w);
}

function sumLen(map) {
  let n = 0;
  for (const v of map.values()) n += v;
  return n;
}

/** 题目可检索的那部分文本：题干 + 选项 + 关键点（关键点是"这题在考什么"的结构化描述）。 */
function docText(q) {
  const ks = QBANK_KEYSTEPS[q.i] || [];
  const extra = ks.map((k) => `${k.title} ${k.judge} ${(k.concepts ?? []).join(' ')}`).join(' ');
  return `${q.stemText} ${q.options.map((o) => o.text).join(' ')} ${extra}`;
}

let cache = null;

function buildIndex() {
  if (cache) return cache;

  const leaves = [];
  const leafById = new Map();
  for (const mod of QBANK_GRAPHS.knowledge) {
    for (const chap of mod.children) {
      for (const leaf of chap.children) {
        const node = { id: leaf.id, name: leaf.name, count: leaf.count, module: mod.name, chapter: chap.name, path: `${mod.name} · ${chap.name}` };
        leaves.push(node);
        leafById.set(node.id, node);
      }
    }
  }

  const methods = [];
  const methodById = new Map();
  for (const top of QBANK_GRAPHS.methods) {
    const t1 = { id: top.id, name: top.name, family: top.sub ?? '', desc: top.desc ?? '', count: top.count, parent: null, path: top.name };
    methods.push(t1);
    methodById.set(t1.id, t1);
    for (const child of top.children ?? []) {
      const t2 = { id: child.id, name: child.name, family: top.name, desc: top.desc ?? '', count: child.count, parent: top.id, path: `${top.name} · ${child.name}` };
      methods.push(t2);
      methodById.set(t2.id, t2);
    }
  }

  // 每道题只算一次词频；画像、排除自身、长度都从这份缓存派生。
  const docs = [];
  const docByI = new Map();
  for (const q of QBANK_SOURCE) {
    const g = grams(docText(q));
    const doc = { i: q.i, q, g, len: sumLen(g) };
    docs.push(doc);
    docByI.set(q.i, doc);
  }

  const buildProfiles = (idOf) => {
    const prof = new Map();
    for (const d of docs) {
      for (const id of idOf(d.q)) {
        const node = leafById.has(id) || methodById.has(id) ? true : false;
        if (!node) continue;
        if (!prof.has(id)) prof.set(id, { tf: new Map(), len: 0, members: [] });
        const p = prof.get(id);
        addTo(p.tf, d.g);
        p.len += d.len;
        p.members.push(d.i);
      }
    }
    return prof;
  };

  const leafProf = buildProfiles((q) => q.knowledgeIds ?? []);
  const methodProf = buildProfiles((q) => q.methodIds ?? []);

  cache = { leaves, leafById, methods, methodById, docs, docByI, leafProf, methodProf };
  return cache;
}

/**
 * 打分：BM25 的骨架，但不乘 idf。
 *
 * 为什么不要 idf：画像之间共享的正是"这道题属于这个知识点"的证据词，
 * 而 df 是在**题目**维度上统计的，不是节点维度 —— 拿它压权重会同时压掉真实信号。
 * 这一版先用最简单的形式，好坏由留一法数字说话。
 */
function scoreProfile(queryGrams, profEntry, excludeDoc) {
  let score = 0;
  let tf = profEntry.tf;
  let len = profEntry.len;
  if (excludeDoc && profEntry.members.includes(excludeDoc.i)) {
    tf = new Map(profEntry.tf);
    for (const [g, v] of excludeDoc.g) {
      const left = (tf.get(g) ?? 0) - v;
      if (left > 0) tf.set(g, left); else tf.delete(g);
    }
    len = Math.max(0, len - excludeDoc.len);
  }
  for (const [g, qtf] of queryGrams) {
    const f = tf.get(g);
    if (!f) continue;
    score += qtf * f / (f + K1 * (1 - B + B * len / DL_BASE));
  }
  return score;
}

function rank(queryGrams, prof, nodeById, excludeDoc, topK) {
  const out = [];
  for (const [id, entry] of prof) {
    const node = nodeById.get(id);
    if (!node) continue;
    out.push({ node, score: scoreProfile(queryGrams, entry, excludeDoc) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topK).map(({ node, score }) => ({
    id: node.id,
    name: node.name,
    path: node.path,
    count: node.count,
    score: Number(score.toFixed(2)),
  }));
}

/**
 * 题干 → 候选知识叶 + 候选方法。
 *
 * @param {string} text 题目原文（题干即可，带选项更好）
 * @param {{topK?: number, excludeId?: number}} [opts]
 *        excludeId：把某道题库题从画像里剔掉，用来模拟"这道题是陌生的"。
 */
export function classifyText(text, opts = {}) {
  const topK = Math.max(1, Math.min(10, opts.topK ?? 5));
  const idx = buildIndex();
  const qGrams = grams(text);
  if (qGrams.size === 0) {
    return { leaves: [], methods: [], confident: false, topScore: 0, source: 'lexical' };
  }
  const excludeDoc = opts.excludeId != null ? idx.docByI.get(opts.excludeId) : null;
  const leaves = rank(qGrams, idx.leafProf, idx.leafById, excludeDoc, topK);
  const methods = rank(qGrams, idx.methodProf, idx.methodById, excludeDoc, topK);
  const topLeaf = leaves[0]?.score ?? 0;
  const topMethod = methods[0]?.score ?? 0;
  return {
    leaves,
    methods,
    // 两个口径分开判：知识点能定就定；方法不够像就留空，别硬贴标签。
    confident: topLeaf >= MIN_LEAF_SCORE,
    methodConfident: topMethod >= MIN_METHOD_SCORE,
    topScore: topLeaf,
    source: 'lexical',
  };
}

/** 报告页用：一个叶节点的位置卡。只描述"在树上的哪儿"，不编讲解。 */
export function leafCard(id) {
  const idx = buildIndex();
  const node = idx.leafById.get(id);
  if (!node) return null;
  return {
    id: node.id,
    title: node.name,
    path: node.path,
    module: node.module,
    chapter: node.chapter,
    count: node.count,
  };
}

/** 报告页用：一个方法节点的卡。desc 是题库自带的，不用我编。 */
export function methodCard(id) {
  const idx = buildIndex();
  const node = idx.methodById.get(id);
  if (!node) return null;
  return {
    id: node.id,
    title: node.name,
    family: node.family,
    principle: node.desc,
    path: node.path,
    count: node.count,
    parent: node.parent,
  };
}

/** 与一段题干最像的题库真题（给检索注入用；不含答案与解析）。 */
export function similarQuestions(text, opts = {}) {
  const k = Math.max(1, Math.min(10, opts.k ?? 3));
  const idx = buildIndex();
  const qGrams = grams(text);
  const scored = [];
  for (const d of idx.docs) {
    if (opts.excludeId != null && d.i === opts.excludeId) continue;
    let s = 0;
    for (const [g, qtf] of qGrams) {
      const f = d.g.get(g);
      if (f) s += qtf * f / (f + K1 * (1 - B + B * d.len / DL_BASE));
    }
    if (s > 0) scored.push({ d, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, k).map(({ d, s }) => ({
    bankId: d.i,
    code: d.q.code,
    leaf: d.q.leaf,
    chapter: d.q.chap,
    difficulty: d.q.d,
    stem: String(d.q.stemText).replace(/\s+/g, ' ').slice(0, 120),
    score: Number(s.toFixed(2)),
  }));
}

export function taxonomyStats() {
  const idx = buildIndex();
  return {
    leaves: idx.leaves.length,
    methods: idx.methods.length,
    questions: idx.docs.length,
    leafProfiles: idx.leafProf.size,
    methodProfiles: idx.methodProf.size,
  };
}

/** 清缓存：只给测试与热更新用。 */
export function resetTaxonomyCache() {
  cache = null;
}
