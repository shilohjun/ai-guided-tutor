/** Report-only study cards. No model call and no access to reference solutions. */
const K = {
  cutting: { title: '导体棒切割磁感线', formula: 'E = BLv', meaning: 'L 是有效切割长度，v 是棒相对磁场的速度。', condition: '匀强磁场、直棒有效长度方向与速度、磁场两两垂直。存在夹角时需重新核对几何关系。' },
  circuit: { title: '闭合电路欧姆定律', formula: 'I = E / (R + r)', meaning: '电流由电动势与全回路总电阻共同决定，应计入棒的电阻。', condition: '仅适用于这里的闭合串联电阻回路；有并联支路、电容充电时需重新分析电路。' },
  ampere: { title: '安培力与运动状态', formula: 'F安 = BIL；ΣF = ma', meaning: '先判断受力方向，再根据是否有加速度列关系。', condition: 'BIL 用于直导体电流垂直匀强磁场；匀速直线运动才可令合力为零。' },
  flux: { title: '磁通量与电动势', formula: 'Φ = BS；|E平均| = n|ΔΦ/Δt|', meaning: '磁通量取决于磁场与有效面积；电动势取决于它的变化率。', condition: 'Φ=BS 要求匀强磁场垂直平面；B、S 或夹角变化都可能产生电磁感应。' },
  charge: { title: '电荷量与焦耳定律', formula: 'q = It；Q = I²Rt（恒流）', meaning: '恒定电流时，可直接计算一段时间内的电荷量与焦耳热。', condition: '电流变化时需按过程累计，不能直接套恒流公式。热量不能一般地用平均电流的平方计算。' },
  momentum: { title: '动量定理', formula: 'Δp = ∫F合 dt', meaning: '合外力的冲量等于动量变化，适用于变力过程。', condition: '先选研究对象和正方向；恒力才可将对应冲量直接写成 Ft，变力需累计。' },
  energy: { title: '能量收支', formula: 'W外 = ΔEk + Q', meaning: '本题外力做功分给动能变化和整个回路的焦耳热。', condition: '这里限于光滑导轨、无其他能量输入且忽略电路储能变化；不是机械能守恒。' },
  power: { title: '功率的对象', formula: 'P外 = Fv；PR = I²R', meaning: '分别看外力输入和电阻 R 的发热，不能混用对象。', condition: 'Fv 简式要求力与速度同向；全回路热功率还要计入其他电阻。' },
  capacitor: { title: '电容器与分流', formula: 'qC = CU；I棒 = IR + IC', meaning: '电容器充电时有支路电流，棒的电流不一定等于电阻支路电流。', condition: 'qC=CU 对应给定电容；只有电压不再变化时，理想电容器支路才无持续充电电流。' },
};
// Classification reference: user-supplied 高中物理高考真题题库.html, KG / TH.
// This uses its organization, not its answers or any executable scripts.
const M = {
  chain: { title: '物理过程串联分析', family: '正向递推 · 链式多步顺推',
    principle: '将相互关联的物理过程按因果顺序组织，利用前一步得到的物理量建立下一步关系，避免孤立选择公式。',
    use: '先根据棒的运动分析感应电动势，再结合完整回路求电流；随后分析安培力，并利用运动状态确定外力，最后联系功率。',
    when: '适用于导体棒、线框等电磁与力学耦合题，尤其是多个待求量具有明确依赖关系的情况。',
    boundary: '各环节应分别检查几何条件、回路结构和运动状态。断路、并联或加速运动时，相关关系需要重新建立。' },
  balance: { title: '受力分析与运动约束', family: '平衡与约束 · 牛顿定律方程组',
    principle: '以明确的物体为研究对象，分析实际作用力，再通过牛顿第二定律把受力与运动状态联系起来。',
    use: '以导体棒为对象，标出重力、支持力、外力和安培力，分别判断方向；本题为匀速直线运动，因此沿水平方向列平衡关系。',
    when: '适用于静止、匀速直线运动以及求外力、支持力或摩擦力的题；加速问题也可受力分析，但需保留加速度项。',
    boundary: '合力为零不表示各力消失。速度大小不变也不必然平衡，例如匀速圆周运动还存在向心加速度。' },
  change: { title: '磁通量变化分析', family: '正向递推 · 法拉第定律应用',
    principle: '感应电动势取决于磁通量变化率。分析时应区分磁场强度、有效面积和磁场与平面的夹角，先确认变化来源。',
    use: '本题线框不运动，面积与夹角保持不变，变化来自磁感应强度；先表达磁通量的变化，再联系电动势、电流与后续过程量。',
    when: '适用于随时间变化的磁场、线框进出磁场、线圈转动等电磁感应题。',
    boundary: '空间中磁场均匀不等于随时间不变。平均电动势与瞬时电动势须区分；变化率恒定不代表磁通量不变。' },
  accumulate: { title: '恒量判定与过程量分析', family: '正向递推 · 过程量计算',
    principle: '电荷量和热量描述一段过程。先判断电流是否恒定，才能决定能否直接用恒流公式，避免把某一时刻的瞬时量当作全程不变量。',
    use: '本题磁场随时间均匀变化，线框面积、方向和电阻不变；先判断感应电动势与电流的时间特征，再求电荷量和热量。',
    when: '适用于给定一段时间、需要求电荷量、热量或平均功率的问题；高中阶段可先从分段恒定或图像可处理的情况理解。',
    boundary: '若电流随时间变化，应分段累计或结合图像分析。平均电流可以关联总电荷，但其平方通常不能代替电流平方的平均值。' },
  impulse: { title: '冲量与动量定理', family: '过程分析 · 动量定理应用',
    principle: '合外力在一段时间内的冲量等于动量变化。该定理适用于变力过程，无须先求出每一时刻的加速度。',
    use: '选定正方向，对导体棒从初态到末态列冲量关系；在磁场、有效长度及方向关系不变时，将安培力冲量与通过回路的电荷量联系起来。',
    when: '适用于给出时间和初末速度，而电流、安培力随运动变化的导体棒问题。',
    boundary: '动量定理不等于动量守恒。恒定外拉力不代表合力恒定，不能据此认定匀加速；应计入所有外力的冲量。' },
  account: { title: '功能关系与能量收支', family: '守恒思想 · 能量守恒',
    principle: '确定系统边界，列出外界输入和各类能量变化，用完整的收支关系连接过程初末状态。',
    use: '本题导轨光滑且忽略回路储能变化，将外力做功分配给导体棒的动能变化与整个回路的焦耳热；计算总热量时应计入棒的电阻。',
    when: '适用于电磁感应中涉及做功、速度变化、总热量或功率的综合问题。',
    boundary: '有摩擦、电容或不可忽略的自感时，应加入相应能量项。能量守恒不等于机械能守恒，不能遗漏电能与内能的转化。' },
  limit: { title: '极限状态分析', family: '分类讨论·临界 · 电磁临界',
    principle: '先分析物理量随过程如何变化，再利用极限状态所满足的约束求解，而不是把极限条件应用于整个过程。',
    use: '本题恒力拉动导体棒，速度增大使感应电流和安培阻力增大，加速度随之减小；以加速度趋于零的状态建立收尾速度约束。',
    when: '适用于恒力启动的导体棒、收尾速度、极限功率，以及出现“最大”“恰好”等条件的相关题目。',
    boundary: '极限状态与一般时刻应区分。不能将收尾状态的平衡关系用于全部加速阶段；还需确认该极限在给定条件下确实可趋近。' },
  branches: { title: '支路分析与动力学联立', family: '平衡与约束 · 电路方程组',
    principle: '利用节点电流关系和并联支路电压关系描述电路，再将棒中电流引起的安培力与运动方程联系。',
    use: '先区分棒、电阻和电容器支路的电流，明确电容器电压是否变化；再结合感应电动势和棒的受力关系判断运动，不能先假设运动类型。',
    when: '适用于电容器或多个支路参与的电磁感应题，需要同时分析电路状态与机械运动时。',
    boundary: '未确认稳态前，不能把电容器直接视为断路；棒中电流与电阻支路电流一般不同，应按所选方向建立节点关系。' },
};
const GRAPH_PATHS = {
  cutting: ['电磁学', '电磁感应', '导体棒切割'],
  circuit: ['电磁学', '恒定电流', '闭合电路欧姆定律'],
  ampere: ['电磁学', '磁场', '安培力与磁场'],
  flux: ['电磁学', '电磁感应', '法拉第电磁感应定律'],
  charge: ['电磁学', '恒定电流', '电功率与焦耳定律'],
  momentum: ['力学', '动量', '动量定理'],
  energy: ['力学', '功和能', '功能关系与能量守恒'],
  power: ['力学', '功和能', '功与功率'],
  capacitor: ['电磁学', '静电场', '电容器'],
};
const PROFILES = {
  'phy-emi-01': { knowledge: ['cutting', 'circuit', 'ampere'], methods: ['chain', 'balance'] },
  'phy-emi-02': { knowledge: ['flux', 'charge'], methods: ['change', 'accumulate'] },
  'phy-emi-03': { knowledge: ['cutting', 'momentum', 'energy'], methods: ['impulse', 'account'] },
  'phy-emi-04': { knowledge: ['cutting', 'ampere', 'power'], methods: ['limit', 'chain'] },
  'phy-emi-05': { knowledge: ['cutting', 'capacitor', 'ampere'], methods: ['branches', 'chain'] },
};

export function buildReportReview(problem) {
  const profile = PROFILES[problem.id];
  if (problem.subject === 'physics' && profile) {
    return { source: 'topic-cards', status: 'available',
      knowledge: profile.knowledge.map(id => ({ ...K[id], formulaKey: id, graphPath: [...GRAPH_PATHS[id]] })),
      methods: profile.methods.map(id => ({ ...M[id] })),
      note: '仅复盘本题涉及的知识和方法，不代表已经掌握。' };
  }
  if (problem.id === 'math-proof-01' && problem.subject === 'math') {
    return { source: 'topic-cards', status: 'available', knowledge: [
      { title: '有理数与最简分数', formula: '', meaning: '有理数可以表示为整数之比，讨论前要明确分母非零。', condition: '涉及最简表示时要确认分子、分母互质，而不是只说“可以写成分数”。' },
      { title: '互质与奇偶性', formula: '', meaning: '检查整数的奇偶性，并核对它与互质条件是否相容。', condition: '证明每一步都要有依据，不能仅凭例子概括所有整数。' },
    ], methods: [
      { title: '反证法', principle: '暂时假设命题的反面成立，检查它是否导致矛盾。', use: '明确假设与前提，再逐步检验推理是否与已知条件相容。', when: '直接证明困难，反面假设却能形成可用关系时。', boundary: '必须指出矛盾的具体依据；不能把待证结论当作前提。' },
    ], note: '知识和方法用于复盘，不替代完整证明。' };
  }
  // Do not prescribe a physics formula from a broad subject label or untrusted title.
  return { source: 'topic-cards', status: 'pending', knowledge: [], methods: [],
    note: '这道题暂未配置配套知识与方法卡，先保留本次对话小结；不自动套用其他题的公式。' };
}
