/** Report-only study cards. No model call and no access to reference solutions. */
const K = {
  cutting: { title: '运动产生电动势', formula: 'E = BLv', meaning: 'L 是有效切割长度，v 是棒相对磁场的速度。', condition: '匀强磁场、直棒有效长度方向与速度、磁场两两垂直。存在夹角时不能照搬简式。' },
  circuit: { title: '闭合回路电流', formula: 'I = E / (R + r)', meaning: '电动势要与全回路总电阻配套，别漏掉棒的电阻。', condition: '仅适用于这里的闭合串联电阻回路；有并联支路、电容充电时需重新分析电路。' },
  ampere: { title: '安培力与运动状态', formula: 'F安 = BIL；ΣF = ma', meaning: '先判断受力方向，再根据是否有加速度列关系。', condition: 'BIL 用于直导体电流垂直匀强磁场；匀速直线运动才可令合力为零。' },
  flux: { title: '磁通量与电动势', formula: 'Φ = BS；|E平均| = n|ΔΦ/Δt|', meaning: '磁通量取决于磁场与有效面积；电动势取决于它的变化率。', condition: 'Φ=BS 要求匀强磁场垂直平面；B、S 或夹角变化都可能产生电磁感应。' },
  charge: { title: '电流、电荷与热量', formula: 'q = ∫I dt；Q = ∫I²R dt', meaning: '电流变化时，电荷量和热量要按整个过程累计。', condition: '恒定电流才能直接用 q=It、Q=I²Rt。热量不能一般地用平均电流的平方计算。' },
  momentum: { title: '动量定理', formula: 'Δp = ∫F合 dt', meaning: '合外力的冲量等于动量变化，适用于变力过程。', condition: '先选研究对象和正方向；恒力才可将对应冲量直接写成 Ft，变力需累计。' },
  energy: { title: '能量收支', formula: 'W外 = ΔEk + Q', meaning: '本题外力做功分给动能变化和整个回路的焦耳热。', condition: '这里限于光滑导轨、无其他能量输入且忽略电路储能变化；不是机械能守恒。' },
  power: { title: '功率的对象', formula: 'P外 = Fv；PR = I²R', meaning: '分别看外力输入和电阻 R 的发热，不能混用对象。', condition: 'Fv 简式要求力与速度同向；全回路热功率还要计入其他电阻。' },
  capacitor: { title: '电容器与分流', formula: 'qC = CU；I棒 = IR + IC', meaning: '电容器充电时有支路电流，棒的电流不一定等于电阻支路电流。', condition: 'qC=CU 对应给定电容；只有电压不再变化时，理想电容器支路才无持续充电电流。' },
};
const M = {
  chain: { title: '把电与力串起来', principle: '运动产生电动势，闭合回路形成电流，电流又影响受力。', use: '按“运动 → 电动势 → 电流 → 安培力”建立联系，再处理外力或功率。', when: '导体棒、线框等电磁与力学耦合题。', boundary: '每一环单独检查切割方向、回路结构和运动状态；断路不能沿用原电流分析。' },
  balance: { title: '用运动状态约束受力', principle: '匀速直线运动对应加速度为零，而不是没有力。', use: '选导体棒，先标受力方向，再沿运动方向列平衡关系。', when: '静止、匀速直线运动或求维持运动所需外力的题。', boundary: '速度大小不变不等于合力为零；加速时要改用 ΣF=ma。' },
  change: { title: '先找谁在改变磁通量', principle: '感应电动势由磁通量变化率决定，不是看磁场强不强。', use: '先分清 B、面积、夹角中谁变化，再联系电动势、电流及过程量。', when: '变化磁场、线框进出磁场或转动线圈。', boundary: '空间中磁场均匀不等于随时间不变；变化率恒定也不等于变化量为零。' },
  accumulate: { title: '区分瞬时量与过程量', principle: '电荷量累计电流，热量累计电流平方与电阻的乘积。', use: '先判断电流是否恒定，再选恒流公式或按时间累计。', when: '已知一段时间，求电荷量、热量或平均功率。', boundary: '平均电流可关联总电荷，但其平方通常不能代替电流平方的平均值。' },
  impulse: { title: '用冲量跨过变力过程', principle: '动量定理不要求加速度恒定，可以把一段过程整体联系起来。', use: '选正方向，累计合外力冲量，再把安培力冲量与通过的电荷量联系。', when: '导体棒受恒外力但安培力变化，且给出时间、初末速度的题。', boundary: '恒外力不意味着合力恒定；不能直接套匀加速运动公式。' },
  account: { title: '给能量记一笔完整账', principle: '先问能量从哪里来、到哪里去，再列收支。', use: '将外力做功与动能变化、全回路焦耳热对应；计算热量时不漏掉棒。', when: '涉及做功、速度变化、总热量或功率的综合题。', boundary: '有摩擦、电容或不可忽略的自感时，还要计入相应能量；不能直接机械能守恒。' },
  limit: { title: '用极限状态找收尾速度', principle: '速度增大使感应电流和阻力变化；收尾状态对应加速度趋于零。', use: '先分析安培力随速度的变化，再以合力趋于零建立极限约束。', when: '导体棒受恒力启动、求收尾速度或对应功率。', boundary: '这是极限状态条件，不能拿来描述整个加速过程。' },
  branches: { title: '先分支路，再联立运动', principle: '同一节点满足电流关系，同一并联支路两端电压相同。', use: '区分棒、电阻和电容器支路；结合电压变化、受力分析判断运动。', when: '电容器或多支路参与的电磁感应问题。', boundary: '未确认稳态前，不能把电容器直接当断路，也不能把棒电流当作电阻电流。' },
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
      knowledge: profile.knowledge.map(id => ({ ...K[id] })),
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
