/**
 * 公式卡（学生侧的工具卡，不是模型输出）。
 *
 * 只在同一步已经给过 L3 之后，由 /api/formula 按知识点取一张；
 * 内容只放教材级规律 + 适用条件，不放本题的代入式或结果。
 * 题目属于哪个知识点，就取哪一张；取不到就不发卡。
 */
export const FORMULA_CARDS = {
  电磁感应: {
    topic: '电磁感应',
    formula: 'E = B L v（B、L、v 三者互相垂直）',
    note: '适用条件：导体棒切割磁感线；B 均匀；L 是有效切割长度；v 与 B、L 都垂直。',
  },
  法拉第电磁感应定律: {
    topic: '法拉第电磁感应定律',
    formula: 'E = n · ΔΦ / Δt',
    note: '适用条件：磁通量发生变化；n 是线圈匝数；ΔΦ/Δt 是磁通量的平均变化率。',
  },
  牛顿第二定律: {
    topic: '牛顿第二定律',
    formula: 'F合 = m · a',
    note: '适用条件：惯性参考系；质量不变；F合 是物体所受的合外力。',
  },
  匀变速直线运动: {
    topic: '匀变速直线运动',
    formula: 'x = v₀t + ½ a t²',
    note: '适用条件：加速度恒定；x、v₀、a 取同一正方向。',
  },
  机械能守恒: {
    topic: '机械能守恒',
    formula: 'Ek + Ep = 常量',
    note: '适用条件：只有重力或弹力做功，其他力不做功，或做功之和为零。',
  },
  二次函数: {
    topic: '二次函数',
    formula: 'y = a(x − h)² + k',
    note: '顶点式：顶点为 (h, k)，a ≠ 0；只给形式，不代入本题系数。',
  },
  反证法: {
    topic: '反证法',
    formula: '假设结论不成立 → 推出矛盾 → 原结论成立',
    note: '适用条件：结论的否定要能推出与已知、定义或公理矛盾；矛盾必须由推理得到。',
  },
};

export function formulaCardFor(problem) {
  const topics = Array.isArray(problem?.topics) ? problem.topics : [];
  for (const topic of topics) {
    if (FORMULA_CARDS[topic]) return FORMULA_CARDS[topic];
  }
  return null;
}
