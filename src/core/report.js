/**
 * 学习报告生成（proposal 阶段 ⑥ 的落地）。
 *
 * 报告的设计原则："报告不是给分的，是给下一步的"。
 * 因此每一条卡点都必须带三样东西：
 *   ① 具体位置（第几步、那一步在做什么）
 *   ② 认知缺口（不是"你算错了"，而是"你把均匀变化当成了无变化"）
 *   ③ 可执行的下一步（去检查哪个前提、去做哪类变式题）
 *
 * 独立完成度（independence）刻意不用"对了几步"来算，而是用
 * **"有多少步是学生自己走过去的、没有靠降级示范"** 来算 ——
 * 这更贴合产品主张（关注"怎么走到这一步"而不是"答对没有"）。
 */

import { findStepByPosition, findGraph, totalSteps } from './locate.js';

/** 从引擎响应累积一条会话记录（服务端维护） */
export function appendTurn(record, { utterance, response }) {
  const now = new Date().toISOString();
  record.turns.push({ role: 'student', text: utterance, at: now });
  record.turns.push({
    role: 'ai',
    text: response.hint.text,
    at: now,
    level: response.hint.level,
    metaStep: response.diagnosis.position.stepIndex,
    metaGraphId: response.diagnosis.position.graphId,
  });

  record.hintLog.push({
    at: now,
    requestedLevel: response.hint.level,
    deliveredLevel: response.hint.level,
    stuckKind: response.diagnosis.stuckKind,
    misconceptionIds: response.diagnosis.misconceptions.map((m) => m.id),
    guardPassed: response.meta.guard.passed,
    violationKinds: (response.meta.guardHistory ?? []).flatMap((g) => g.violations.map((v) => v.kind)),
    stepIndex: response.diagnosis.position.stepIndex,
    graphId: response.diagnosis.position.graphId,
  });
  return record;
}

export function createSessionRecord(problemId) {
  return {
    problemId,
    turns: [],
    hintLog: [],
    startedAt: new Date().toISOString(),
  };
}

/**
 * @param {import('./types.js').Problem} problem
 * @param {import('./types.js').SessionRecord} record
 * @param {{ engine: string, model?: string }} meta
 * @returns {import('./types.js').Report}
 */
export function buildReport(problem, record, meta) {
  const graph = findGraph(problem, record.hintLog[0]?.graphId ?? problem.solutionGraphs[0]?.id);
  const stepTotal = totalSteps(problem, graph?.id);

  // ---- 1. 卡点聚合：按 (步骤, 卡点性质) 归并 ----
  const stuckMap = new Map();
  for (const log of record.hintLog) {
    const key = `${log.stepIndex ?? 'na'}::${log.stuckKind}`;
    if (!stuckMap.has(key)) {
      stuckMap.set(key, {
        stepIndex: log.stepIndex,
        stepTitle: stepTitle(problem, log.graphId, log.stepIndex),
        kind: log.stuckKind,
        misconceptionLabels: [],
        hintRounds: 0,
        maxLevel: 0,
        guardBlocked: 0,
      });
    }
    const entry = stuckMap.get(key);
    entry.hintRounds += 1;
    entry.maxLevel = Math.max(entry.maxLevel, log.deliveredLevel);
    if (!log.guardPassed) entry.guardBlocked += 1;
    for (const id of log.misconceptionIds) {
      const label = problem.misconceptions.find((m) => m.id === id)?.label;
      if (label && !entry.misconceptionLabels.includes(label)) entry.misconceptionLabels.push(label);
    }
  }
  const stuckPoints = [...stuckMap.values()].sort((a, b) => (a.stepIndex ?? 99) - (b.stepIndex ?? 99));

  // ---- 2. 引导轮次统计 ----
  const byLevel = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const log of record.hintLog) byLevel[log.deliveredLevel] = (byLevel[log.deliveredLevel] ?? 0) + 1;
  const hintStats = {
    total: record.hintLog.length,
    byLevel,
    guardBlocked: record.hintLog.filter((l) => !l.guardPassed).length,
  };

  // ---- 3. 独立完成度 ----
  const independence = computeIndependence(record, stepTotal);

  // ---- 4. 深层问题：把零散错因归纳成认知缺口 ----
  const deeperIssues = inferDeeperIssues(problem, record);

  // ---- 5. 举一反三建议 ----
  const recommendations = buildRecommendations(problem, stuckPoints, deeperIssues);

  // ---- 6. 下一步行动 ----
  const nextActions = buildNextActions(stuckPoints, independence, deeperIssues);

  return {
    problemId: problem.id,
    problemTitle: `${problem.subject === 'physics' ? '物理' : ''} · ${problem.topics.slice(0, 2).join('/')}（难度 ${problem.difficulty}/5）`,
    stuckPoints,
    hintStats,
    independence,
    deeperIssues,
    recommendations,
    nextActions,
    meta: {
      engine: meta.engine,
      model: meta.model,
      generatedAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------

function stepTitle(problem, graphId, stepIndex) {
  if (stepIndex == null) return '尚未定位到具体步骤';
  const step = findStepByPosition(problem, { graphId, stepIndex });
  return step?.title ?? `第 ${stepIndex} 步`;
}

/**
 * 独立完成度算法（可解释版）：
 *   基础分 = 学生自己走过的步骤数 / 总步骤数
 *   扣分项 = 每获得一次 L3 降级示范，扣 0.1（最多扣 0.4）
 *   加分项 = 被守卫拦下的次数体现"护栏在工作"，不计入学生表现
 *
 * 注意：这里衡量的是"帮助强度"，不是"学生水平"。
 * 报告文案必须避免把它表述成分数评价。
 */
function computeIndependence(record, stepTotal) {
  const touchedSteps = new Set(
    record.hintLog.map((l) => l.stepIndex).filter((i) => typeof i === 'number'),
  );
  const completedSteps = touchedSteps.size;
  const total = Math.max(stepTotal, completedSteps, 1);

  const l3Count = record.hintLog.filter((l) => l.deliveredLevel === 3).length;
  const l2Count = record.hintLog.filter((l) => l.deliveredLevel === 2).length;
  const penalty = Math.min(0.4, l3Count * 0.1 + l2Count * 0.04);

  let raw = completedSteps / total - penalty;
  raw = Math.max(0, Math.min(1, raw));

  const noteParts = [`你独立走过了 ${completedSteps} / ${total} 个关键步骤`];
  if (l3Count > 0) noteParts.push(`其中 ${l3Count} 次用到了"示范一步"`);
  if (l2Count > 0) noteParts.push(`${l2Count} 次用到了方向提示`);
  if (l3Count === 0 && l2Count === 0 && record.hintLog.length > 0) {
    noteParts.push('全程只用到条件追问，说明你自己完成得很扎实');
  }

  return {
    score: Math.round(raw * 100) / 100,
    completedSteps,
    totalSteps: total,
    note: noteParts.join('，') + '。',
  };
}

/**
 * 深层问题推断：把错因的 rootCause 做聚类。
 * 这里刻意用"模式表"而不是聚类算法 ——
 * 教研能读懂、能改、能跟知识点图谱对齐，比算法高级更重要。
 */
const DEEPER_PATTERNS = [
  {
    id: 'precondition-habit',
    test: (labels) => labels.some((l) => /前提|条件|漏|忘|忽略|误判|混淆|均匀/.test(l)),
    issue: '规律的使用前提没有形成检查习惯。你会在"知道用什么"之后就急着代公式，导致前提不满足时仍然硬算。',
    drill: '每写下一个公式前，先在旁边写一行"这个公式要求什么"，写完再代。',
  },
  {
    id: 'cross-module-translation',
    test: (labels, kinds) =>
      kinds.includes('precondition_gap') && labels.some((l) => /平衡|匀速|受力|运动/.test(l)),
    issue: '运动学信息向动力学条件的翻译还不熟练（例如"匀速"没有立刻翻译成"合力为零"）。',
    drill: '练习"信息翻译"：拿到题先把每个形容词翻译成物理条件，写成一列。',
  },
  {
    id: 'tool-selection',
    test: (labels) => labels.some((l) => /动量|能量|变加速|匀变速|工具|方程/.test(l)),
    issue: '在"过程量"和"状态量"之间选择工具的直觉还没建立，容易只盯一个定理走到死路。',
    drill: '遇到过程量（时间内的电量、冲量、热量）优先试动量/冲量思路。',
  },
  {
    id: 'energy-accounting',
    test: (labels) => labels.some((l) => /做功|能量|热量|焦耳|功率/.test(l)),
    issue: '能量收支的账没记全：某一部分能量"去哪了"说不清楚，导致能量方程写不完整。',
    drill: '每做完一道题，补一句"能量从哪来、到哪去、各是多少"。',
  },
  {
    id: 'circuit-modeling',
    test: (labels) => labels.some((l) => /内阻|回路|电源|并联|隔直|电容/.test(l)),
    issue: '电路建模不够稳：谁是电源、谁是外电路、内阻算不算，这几个判断容易跳步。',
    drill: '画电路时先把导体棒圈成"电源"、标出内阻，再写欧姆定律。',
  },
];

function inferDeeperIssues(problem, record) {
  const labels = record.hintLog.flatMap((l) =>
    l.misconceptionIds.map((id) => problem.misconceptions.find((m) => m.id === id)?.label ?? ''),
  );
  const rootCauses = record.hintLog.flatMap((l) =>
    l.misconceptionIds.map((id) => problem.misconceptions.find((m) => m.id === id)?.rootCause ?? ''),
  );
  const kinds = record.hintLog.map((l) => l.stuckKind);
  const pool = [...labels, ...rootCauses];

  const issues = [];
  for (const p of DEEPER_PATTERNS) {
    if (p.test(pool, kinds) && !issues.some((i) => i.id === p.id)) {
      issues.push({ id: p.id, text: p.issue, drill: p.drill });
    }
  }

  if (issues.length === 0 && record.hintLog.length > 0) {
    issues.push({
      id: 'no-systemic',
      text: '本轮没有暴露出系统性缺口，卡点更像是"单点没想起"，属于正常波动。',
      drill: '保持当前习惯即可；若要提分，把本题的方法用一句话写进笔记。',
    });
  }

  return issues.map((i) => i.text);
}

function buildRecommendations(problem, stuckPoints, deeperIssues) {
  const recs = [];
  const topics = new Set(problem.topics);

  for (const sp of stuckPoints) {
    if (sp.misconceptionLabels.length === 0) continue;
    recs.push({
      topic: sp.stepTitle,
      reason: `在「${sp.stepTitle}」这一步，${sp.misconceptionLabels.join('、')}——共引导 ${sp.hintRounds} 轮。`,
      drill:
        sp.maxLevel >= 3
          ? '建议做 2 道同类"只需要列式、不需要算完"的题，专门练这一步的判断。'
          : '建议直接做 2 道同结构变式题，检验这一步是否已内化。',
    });
  }

  if (topics.has('电磁感应') && deeperIssues.length > 0) {
    recs.push({
      topic: '条件判断题组',
      reason: '本轮卡点集中在"规律前提是否满足"上。',
      drill: '收集 5 道电磁感应题，只做一件事：写出每个公式的适用前提，不做计算。',
    });
  }

  if (recs.length === 0) {
    recs.push({
      topic: problem.topics[0] ?? '本题知识点',
      reason: '本轮进展顺利，未出现明显卡点。',
      drill: '尝试把本题改一个条件（例如把匀速改成匀加速），看方法是否还成立。',
    });
  }

  return recs.slice(0, 4);
}

function buildNextActions(stuckPoints, independence, deeperIssues) {
  const actions = [];
  if (stuckPoints.some((s) => s.maxLevel >= 3)) {
    actions.push('把用到"示范一步"的那一步，合上答案自己重做一遍，确认是否真的会了。');
  }
  if (stuckPoints.some((s) => s.kind === 'precondition_gap')) {
    actions.push('整理一张"公式—前提"对照卡，把本轮涉及规律的适用条件写全。');
  }
  if (independence.score >= 0.7) {
    actions.push('独立完成度较高，可以挑战一道多过程综合题（如恒力启动 + 后续匀速）。');
  } else {
    actions.push('先做一道结构完全相同的变式题，目标是不借助提示走完前三步。');
  }
  if (deeperIssues.length > 0) {
    actions.push('把报告里的"深层问题"读一遍，用自己的话复述给同学听——能讲清楚才算真懂。');
  }
  return actions.slice(0, 4);
}
