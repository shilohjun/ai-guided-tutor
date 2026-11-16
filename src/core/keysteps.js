/**
 * 关键点链（keysteps）—— 题库官方解析 → 结构化解题路径。
 *
 * ============================================================================
 * 它替换掉的是什么
 * ============================================================================
 * 题库 835 题的辅导路径过去是 `heuristicSkeleton(stem, 'physics')`
 * （intake.js:494）：跟题目无关的通用六步 —— 读条件 / 选规律 / 查前提 /
 * 写关系式 / 代入运算 / 作答。学生拿到的提示因此也是通用的：
 * 提示词里写着"判断该用哪个规律"，可这道题其实该判断的是
 * "小车和桶砂要不要取整体"。
 *
 * 这里改成用**官方解析**反推关键点：这道题解完一共要作出几个关键判断、
 * 每个判断卡在哪、依据是什么、式子长什么样。2 步的题就是 2 步，
 * 8 步的题就是 8 步 —— 步数由题目自己决定，不由骨架决定。
 *
 * ============================================================================
 * 三条硬约束
 * ============================================================================
 * ① 末步必须是 conclude/interpret。route 与 report 都依赖
 *    "最后一步 = 收尾"这个不变量（见 intake.js:281 的注释）。
 *    关键点经常以"取近似"或"联立求解"结尾，直接搬会把这个不变量弄坏，
 *    所以末步不是收尾时补一个收尾步。
 * ② cues 是关键词定位通道的唯一输入（locate.js:38）。
 *    它的规则必须跟读题链路完全一致，所以复用 intake 的 ensureCues，
 *    不在这里另写一份 —— 两份规则一旦漂移，定位会静默变钝。
 * ③ 校验失败要抛错，不要补空串。离线编译 835 题时，
 *    一条坏输出必须能被识别出来重跑，而不是变成一道"看起来有路径"的题。
 */

import { ensureCues } from './intake.js';

/** 模型给的"关键点类型"是中文短语，引擎只认这七个 kind（intake.js:41）。 */
const TYPE_TO_KIND = new Map([
  ['模型选择', 'identify'],
  ['对象选择', 'identify'],
  ['规律选择', 'identify'],
  ['关系判断', 'identify'],
  ['前提判断', 'precondition'],
  ['条件判断', 'precondition'],
  ['临界条件', 'precondition'],
  ['近似条件', 'precondition'],
  ['适用条件', 'precondition'],
  ['实验操作', 'setup'],
  ['实验设计', 'setup'],
  ['器材选择', 'setup'],
  ['关系建立', 'apply'],
  ['公式应用', 'apply'],
  ['规律应用', 'apply'],
  ['几何关系', 'derive'],
  ['数学处理', 'derive'],
  ['联立求解', 'derive'],
  ['代入计算', 'derive'],
  ['数据处理', 'derive'],
  ['图像读取', 'interpret'],
  ['图像分析', 'interpret'],
  ['数据分析', 'interpret'],
  ['误差分析', 'interpret'],
  ['结果检验', 'interpret'],
  ['单位检验', 'interpret'],
  ['结论整理', 'conclude'],
  ['答案组织', 'conclude'],
]);

/** 这些类型的关键点是"整条路走不走得通"的条件，会抬成 graph.preconditions。 */
const PREMISE_TYPES = new Set(['前提判断', '条件判断', '近似条件', '临界条件', '适用条件']);

/** 收尾步：关键点链末尾不是收尾时补上。 */function concludeStep(index) {
  return {
    index,
    title: '整理结论',
    kind: 'conclude',
    intent: '把每一步得到的结论串成完整答案',
    concepts: [],
    cues: ['算出结果', '检验单位', '写下答案', '结论'],
    forks: [],
    why: '零散的中间结果不算答完，答案要能被人读懂',
    do: '按题意作答，标清单位与方向',
    expr: '',
  };
}

function stringList(value, { max = 4, minLen = 2, maxLen = 10 } = {}) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = String(item ?? '').trim();
    if (text.length >= minLen && text.length <= maxLen && !out.includes(text)) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 校验并归一化模型给出的关键点。
 *
 * 只做"结构和字段"的校验（能重跑的那种），不做物理对错判断 ——
 * 一道题的关键点对不对，只能靠人看，或者靠下游评测发现。
 */
export function normalizeKeysteps(raw) {
  if (!Array.isArray(raw)) throw new Error('keysteps 必须是数组');
  if (raw.length < 2) throw new Error(`关键点至少 2 个（一道题至少两道坎），实际 ${raw.length} 个`);

  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`keysteps[${i}] 不是对象`);

    const title = String(item.title ?? '').trim();
    if (!title) throw new Error(`keysteps[${i}].title 不能为空`);

    const judge = String(item.judge ?? '').trim();
    if (!judge) throw new Error(`keysteps[${i}].judge 不能为空：这一步要学生作出什么判断`);

    const why = String(item.why ?? '').trim();
    if (!why) throw new Error(`keysteps[${i}].why 不能为空：判断依据是什么`);

    const type = String(item.type ?? '').trim();
    const concepts = stringList(item.concepts);
    const rawCues = Array.isArray(item.cues) ? item.cues.map((c) => String(c ?? '')) : [];

    return {
      index: i + 1,
      title,
      type,
      judge,
      why,
      do: String(item.do ?? '').trim(),
      expr: String(item.expr ?? '').trim(),
      concepts,
      // 与读题链路同一套兜底规则：cue 必须是 2~10 字、最多 6 个，
      // 不够两个就从标题与概念里派生。
      cues: ensureCues(rawCues, title, concepts),
    };
  });
}

/**
 * 关键点链 → `solutionGraphs`（形状对齐 intake.normalizeGraphs 的产物）。
 */
export function keystepsToGraphs(keysteps, { id = 'g-main', name = '关键点链' } = {}) {
  const normalized = normalizeKeysteps(keysteps);

  const steps = normalized.map((k) => ({
    index: k.index,
    title: k.title,
    kind: TYPE_TO_KIND.get(k.type) ?? 'apply',
    intent: k.judge,
    concepts: k.concepts,
    cues: k.cues,
    forks: [],
    // 下面三个字段是提示词生成的原料（why=为什么这么判、do=具体做什么、
    // expr=关系式）。observe 提示只读 index/kind/title/intent，
    // 不会把它们塞进模型上下文；图谱本身也从不发给学生。
    why: k.why,
    do: k.do,
    expr: k.expr,
  }));

  // 末步必须是收尾 —— 否则引擎永远不认为学生"接近完成"，
  // 报告页也拿不到可复盘的完整链条。
  const last = steps[steps.length - 1];
  if (last.kind !== 'conclude' && last.kind !== 'interpret') {
    steps.push(concludeStep(steps.length + 1));
  }

  // 路径前提：关键点里"前提/近似/临界"这类判断本来就是整条路走不走得通的条件，
  // 抬到 graph.preconditions 上，读题提示与报告页都能一眼看到。
  const preconditions = normalized
    .filter((k) => PREMISE_TYPES.has(k.type))
    .map((k) => k.judge)
    .slice(0, 3);

  return [{ id, name, preconditions, steps }];
}
