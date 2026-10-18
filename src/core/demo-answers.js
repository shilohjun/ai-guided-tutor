/**
 * 演示模式的最终答案（只给 demo 用的结果卡，不是学生 API）。
 *
 * 这里只放最终值，不放推导；给 /api/demo/answer 在演示者点击后才返回。
 */
export const DEMO_ANSWERS = {
  'phy-emi-01': {
    values: ['0.4 V', '1 A', '0.2 N', '0.4 W'],
    answer: 'E=0.4 V，I=1 A，F安=0.2 N，P=0.4 W',
  },
  'phy-emi-02': {
    values: ['0.4 V', '0.8 A', '0.08 C', '0.032 J'],
    answer: 'E=0.4 V，I=0.8 A，q=0.08 C，Q=0.032 J',
  },
  'phy-emi-03': {
    values: ['q=1 C', 'x=1 m', 'Q=1 J'],
    answer: 'q=1 C，x=1 m，Q=1 J',
  },
  'phy-emi-04': {
    values: ['v_max=4 m/s', 'I=2 A', 'P_R=3.2 W'],
    answer: 'v_max=4 m/s，I=2 A，P_R=3.2 W',
  },
};

export function demoAnswerFor(problemId) {
  return DEMO_ANSWERS[problemId] ?? null;
}
