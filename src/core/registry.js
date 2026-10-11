/**
 * 题目注册表 —— 题库（教研手写）与导入题目（现场读题生成）的统一入口。
 *
 * 为什么要单独一层，而不是让 router 直接查两道 Map：
 *   导入题目与题库题目的生命周期完全不同：
 *     题库题：进程启动即存在，永久有效，图谱经过教研审核
 *     导入题：运行时产生，需要 TTL 回收，图谱是模型生成的（质量未知）
 *   如果把这套回收逻辑写在 router 里，serverless（每次请求都可能换实例）
 *   和本地服务器就会各写一份，最后"线上能导入、本地导不进"。
 *
 * 刻意不引持久化：
 *   与既有架构一致（会话也在内存里）。代价是 serverless 冷启动会丢导入题目，
 *   因此**同一个题干的内容哈希做 id** —— 丢了就用同样的 id 重新生成一次，
 *   前端不需要知道发生过回收。这是 id 用哈希而不是随机串的第二个理由。
 */

import { PROBLEMS, PROBLEM_BY_ID } from './problems.data.js';
import { buildProblemAnalysis } from './analysis.js';

/** 导入题目的存活时间：超过即回收，避免内存无限增长 */
export const IMPORT_TTL_MS = 6 * 60 * 60 * 1000;
/** 导入题目数量上限（防内存被打满） */
export const MAX_IMPORTED = 200;

/** @type {Map<string, {problem: object, analysis: object, warnings: string[], modelRaw: object|null, createdAt: number}>} */
const imported = new Map();

/**
 * 解析缓存：题目 id → buildProblemAnalysis 的产物。
 *
 * 为什么要缓存：解析（关键变量 / 关键条件 / 知识图谱）对题库题是**按需派生**的，
 * 而 `/api/problem` 每次请求都会调它。派生本身是纯字符串运算、很便宜，
 * 但知识图谱的对象结构每次都要重建，前端会看到"同一道题的图谱对象每次都不同"，
 * 不利于以后做 diff 或快照测试。缓存一份，行为就确定了。
 */
const analyses = new Map();

function sweep(now = Date.now()) {
  for (const [id, entry] of imported) {
    if (now - entry.createdAt > IMPORT_TTL_MS) {
      imported.delete(id);
      analyses.delete(id);
    }
  }
  // 超上限时按最旧优先淘汰（Map 保持插入顺序）
  while (imported.size > MAX_IMPORTED) {
    const oldest = imported.keys().next().value;
    imported.delete(oldest);
    analyses.delete(oldest);
  }
}

/**
 * 登记一道导入题目。
 * 同一个 id（同一道题）重复导入时覆盖旧的 —— 图谱质量可能因为重试而变好。
 *
 * @param {object} problem
 * @param {object} analysis  读题元信息（路径概览 / 关键关节 / 告警）
 * @param {string[]} warnings
 * @param {object|null} modelRaw 模型读题的原始输出（解析要用它里的关键条件与知识图谱）
 */
export function registerImportedProblem(problem, analysis, warnings = [], modelRaw = null) {
  sweep();
  imported.delete(problem.id);
  analyses.delete(problem.id);
  imported.set(problem.id, {
    problem,
    analysis,
    warnings: [...warnings],
    modelRaw,
    createdAt: Date.now(),
  });
  return problem;
}

/** 取题目：题库优先，其次导入题目；都没有则返回 null */
export function getProblemById(id) {
  if (!id) return null;
  if (PROBLEM_BY_ID.has(id)) return PROBLEM_BY_ID.get(id);
  sweep();
  return imported.get(id)?.problem ?? null;
}

/** 导入题目的分析元数据（教师视图用：路径概览、关键关节、生成告警） */
export function getImportMeta(id) {
  sweep();
  const entry = imported.get(id);
  if (!entry) return null;
  return {
    analysis: entry.analysis,
    warnings: entry.warnings,
    createdAt: new Date(entry.createdAt).toISOString(),
  };
}

/**
 * 取一道题的解析（关键变量 / 关键条件 / 知识图谱）。
 *
 * 题库题与导入题目走**同一条代码路径**：
 *   题库题没有模型给的解析 ⇒ 全部按题干与图谱派生；
 *   导入题目有模型给的 ⇒ 优先用模型的，封闭表只负责补齐它漏的。
 * 这样"解析面板"对任何题目都成立，不会变成只有导入题目才有的功能。
 *
 * @param {import('./types.js').Problem} problem
 */
export function getProblemAnalysis(problem) {
  if (!problem) return null;
  const cached = analyses.get(problem.id);
  if (cached) return cached;
  const entry = imported.get(problem.id);
  const built = buildProblemAnalysis(problem, { modelAnalysis: entry?.modelRaw ?? null });
  analyses.set(problem.id, built);
  return built;
}

/** 题目清单（题库 + 导入），按"题库在前、导入在后（新→旧）"排序 */
export function listProblems() {
  const lib = PROBLEMS.map((p) => ({
    id: p.id,
    source: 'library',
    subject: p.subject,
    difficulty: p.difficulty,
    topics: p.topics,
    stemPreview: `${p.stem.slice(0, 60)}…`,
  }));

  sweep();
  const imp = [...imported.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((e) => ({
      id: e.problem.id,
      source: 'imported',
      subject: e.problem.subject,
      difficulty: e.problem.difficulty,
      topics: e.problem.topics,
      stemPreview: `${e.problem.stem.slice(0, 60)}…`,
      /** 导入题必须显式暴露"图谱是模型生成的"这件事，否则教研会误判质量 */
      graphConfidence: e.problem.answerFingerprints?.length ? 'model' : 'degraded',
    }));

  return [...lib, ...imp];
}

/** 仅统计，用于 /api/health 的可观测性 */
export function registryStats() {
  sweep();
  return {
    library: PROBLEMS.length,
    imported: imported.size,
    importTtlHours: Math.round(IMPORT_TTL_MS / 3600000),
    maxImported: MAX_IMPORTED,
  };
}

/** 测试与运维用：清空导入题目 */
export function clearImported() {
  imported.clear();
}

export { PROBLEMS };
