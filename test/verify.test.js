/**
 * 答案判定测试。
 *
 * 这个套件守的是一个**不对称**的设计：
 *   说对了 ⇒ 确认（全部答完还要弹庆祝界面）
 *   说错了 ⇒ 什么都不说，走原来的引导路径
 *
 * 而"确认"这条路里最贵的错误是**假庆祝** ——
 * 学生只是提了一个中间量（比如"总时间 2 秒"），系统却宣布"你做完了"。
 * 那比不庆祝伤得多：学生立刻知道这个系统在瞎说，而"看懂你"正是这个产品唯一的立足点。
 *
 * 所以这里用例的重心不在"能不能识别正确答案"，而在**能不能忍住不乱认**。
 */

import { describe, it, assert, assertEquals, assertIncludes } from './runner.js';
import { verifyAnswer, expectedAnswers, findUnstatedAnswers } from '../src/core/verify.js';
import { getProblem, PROBLEMS } from '../src/core/problems.data.js';
import { createEngine } from '../src/core/engine.js';
import { createOfflineAdapter } from '../src/core/llm.js';
import { composeConfirmation } from '../src/core/prompt.js';
import { createSessionRecord, appendTurn, buildReport } from '../src/core/report.js';

const P1 = getProblem('phy-emi-01');
const P3 = getProblem('phy-emi-03');
const MATH = PROBLEMS.find((p) => p.subject === 'math');

describe('答案判定 · 标准答案的抽取', () => {
  it('每个待求量都挂上了它自己的答案（不是把所有数值一锅端）', () => {
    const { items } = expectedAnswers(P1);
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i.values.map((v) => v.raw).join(',')]));
    assertEquals(byLabel['感应电动势 E'], '0.4 V');
    assertEquals(byLabel['感应电流 I'], '1 A');
    assertEquals(byLabel['水平外力 F'], '0.2 N');
    assertEquals(byLabel['外力功率 P'], '0.4 W');
  });

  it('已知量与答案数值相同但单位不同时，不能把答案当成已知量排掉', () => {
    // phy-emi-01 里 B = 0.4 T，而答案是 E = 0.4 V / P = 0.4 W —— 都是 0.4
    const { values } = expectedAnswers(P1);
    assert(
      values.some((v) => v.value === '0.4' && v.unit === 'V'),
      `按数值排除会把真答案误伤掉，实际答案集：${JSON.stringify(values)}`,
    );
  });

  it('等号右边的符号不算"这一问"（否则 I = E/(R+r) 会把 E 的答案挂到 I 上）', () => {
    const { items } = expectedAnswers(P1);
    const e = items.find((i) => i.label === '感应电动势 E');
    assertEquals(e.values.map((v) => v.raw).join(','), '0.4 V', 'E 这一问只能拿到 0.4 V，不能把 1 A 也算进来');
  });

  it('没有数值答案的题（数学证明）不会硬造出答案', () => {
    const { values } = expectedAnswers(MATH);
    assertEquals(values.length, 0, `证明题不该抽出数值答案，实际：${JSON.stringify(values)}`);
  });
});

describe('答案判定 · 完成与部分完成', () => {
  it('答对一问：确认这一问，但**不**宣布完成', () => {
    const v = verifyAnswer(P1, '我算出来 E=0.4V');
    assertEquals(v.matched.length, 1);
    assertEquals(v.complete, false, '四问只答对一问不是"做完了"');
    assertEquals(v.answeredCount, 1);
    assertEquals(v.expectedCount, 4);
    assertEquals(v.remaining.length, 3);
  });

  it('四问全答对才算完成', () => {
    const v = verifyAnswer(P1, 'E=0.4V，I=1A，F=0.2N，P=0.4W 都出来了');
    assertEquals(v.complete, true);
    assertEquals(v.remaining.length, 0);
  });

  it('带不带空格、全角半角都能认出来', () => {
    for (const u of ['E = 0.4 V', 'E=0.4V', 'Ｅ＝０.４Ｖ', 'e = 0.4 v']) {
      const v = verifyAnswer(P1, u);
      assert(v.matched.length >= 1, `"${u}" 应该被认出来`);
    }
  });

  it('答错时什么都不说（判定器不做判卷）', () => {
    const v = verifyAnswer(P1, '我算出来 E=0.5V');
    assertEquals(v.matched.length, 0, '错的答案不该被"确认"');
    assertEquals(v.complete, false);
  });

  it('【关键】说出中间量不算答对', () => {
    // 自由落体题：参考答案里有"总时间 t = 2 s"，但那是中间量，不是任何一问的答案
    const freefall = {
      ...P1,
      id: 'test-freefall',
      asked: ['落地速度 v', '落地前 1 s 内下落的高度'],
      givens: ['h = 20 m', 'g = 10 m/s²', 'm = 0.5 kg'],
      referenceAnswer: '由 h=½gt² 得总时间 t = 2 s，故 v = gt = 20 m/s；落地前 1 s 内下落高度 Δh = 15 m。',
      answerFingerprints: [],
    };
    const v1 = verifyAnswer(freefall, '总时间算出来是 2 s');
    assertEquals(v1.matched.length, 0, '"总时间 2 s"是中间量，不该被当成答对');
    assertEquals(v1.complete, false, '更不能因此宣布完成');

    const v2 = verifyAnswer(freefall, '落地速度 v = 20 m/s');
    assertEquals(v2.matched.length, 1);
    assertEquals(v2.complete, false, '两问只答一问');

    const v3 = verifyAnswer(freefall, 'v = 20 m/s，Δh = 15 m');
    assertEquals(v3.complete, true, '两问都答了才算完成');
  });

  it('只讲思路、没给结果时不会误判', () => {
    for (const u of ['我用欧姆定律算电流', '我觉得应该先求电动势', '还是不会']) {
      const v = verifyAnswer(P1, u);
      assertEquals(v.matched.length, 0, `"${u}" 不该被判定为答对`);
    }
  });
});

describe('答案判定 · 确认文本不许引入学生没说过的答案', () => {
  it('部分答对时，确认语里不能出现还没答出的那些值', () => {
    const v = verifyAnswer(P1, 'I=1A');
    const text = composeConfirmation({ verdict: v, problem: P1 });
    const leaked = findUnstatedAnswers(text, P1, v);
    assertEquals(leaked.length, 0, `确认语泄漏了未说出的答案：${leaked.join('、')}（原文：${text}）`);
  });

  it('完成时也一样（虽然这时没有 remaining，仍要过一遍）', () => {
    const v = verifyAnswer(P1, 'E=0.4V，I=1A，F=0.2N，P=0.4W');
    const text = composeConfirmation({ verdict: v, problem: P1 });
    assertEquals(findUnstatedAnswers(text, P1, v).length, 0);
    assertIncludes(text, '正确');
  });

  it('检查器本身有效：故意把未说出的答案塞进文本要能被抓出来', () => {
    const v = verifyAnswer(P1, 'I=1A');
    const bad = '对，1A 是对的；顺便说一下 0.4 V 和 0.2 N 也是答案。';
    const hits = findUnstatedAnswers(bad, P1, v);
    assert(hits.length >= 1, '检查器必须能抓出"带着单位说未答出的答案"');
  });
});

describe('答案判定 · 与引擎的联调', () => {
  const engine = () => createEngine({ adapter: createOfflineAdapter(), problem: P1 });

  it('确认轮不走提示路径：form=confirm，且没有层级提示文案', async () => {
    const res = await engine().handleTurn({
      problemId: P1.id,
      utterance: '我算出来 E=0.4V',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assertEquals(res.hint.form, 'confirm');
    assertEquals(res.completion.complete, false);
    assertEquals(res.completion.matched.length, 1);
    assert(res.message.length > 4, '要有话说，不能沉默');
    // 确认轮不该出现"你想对的地方是"这种诊断复述 —— 学生刚给了结果，复述是啰嗦
    assert(!res.message.includes('我理解你的意思是'), '确认轮不该再复述一遍');
  });

  it('全部答对：completion.complete=true，且 strengths 记录了他自己算出来的结果', async () => {
    const res = await engine().handleTurn({
      problemId: P1.id,
      utterance: '四个都出来了：E=0.4V，I=1A，F=0.2N，P=0.4W',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assertEquals(res.completion.complete, true);
    assertEquals(res.completion.expectedCount, 4);
    assert(
      res.diagnosis.strengths.some((s) => s.includes('自己算出了')),
      `strengths 应记录结果性肯定，实际：${JSON.stringify(res.diagnosis.strengths)}`,
    );
    assertEquals(res.diagnosis.stuckKind, 'finished');
  });

  it('确认文本通过引擎的出口断言（比守卫更紧的那一条）', async () => {
    const res = await engine().handleTurn({
      problemId: P1.id,
      utterance: 'I=1A',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    const leaked = findUnstatedAnswers(res.message, P1, {
      remaining: verifyAnswer(P1, 'I=1A').remaining,
    });
    assertEquals(leaked.length, 0, `引擎出口泄漏：${leaked.join('、')}`);
  });

  it('答复里出现的每个数值，学生原话里都有', async () => {
    const utterance = '我算出来 E=0.4V';
    const res = await engine().handleTurn({
      problemId: P1.id,
      utterance,
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    const nums = res.message.match(/\d+(?:\.\d+)?/g) ?? [];
    const said = new Set(utterance.match(/\d+(?:\.\d+)?/g) ?? []);
    // "3 个待求量"这类计数是允许的（它不是答案值），所以要排除小的整数计数
    const suspicious = nums.filter((n) => Number(n) >= 10 || n.includes('.'));
    for (const n of suspicious) {
      assert(said.has(n), `确认语里出现了学生没说过、且不可能是计数的数值：${n}（原文：${res.message}）`);
    }
  });

  it('答错时不进入确认路径（走普通引导）', async () => {
    const res = await engine().handleTurn({
      problemId: P1.id,
      utterance: '我觉得 E=0.5V',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assertEquals(res.completion, undefined, '答错不该产生 completion');
    assert(res.hint.form !== 'confirm', '答错走引导路径，不做判卷');
  });

  it('另一道题（电磁感应 ③）同样生效：判定不绑死在单题上', () => {
    const v = verifyAnswer(P3, '答案是 0.6 m');
    void v; // 只要求不崩且形状正确
    const shape = verifyAnswer(P3, '随便说点什么');
    assertEquals(typeof shape.complete, 'boolean');
    assertEquals(Array.isArray(shape.matched), true);
  });
});

describe('答案判定 · 不许污染教学统计', () => {
  /**
   * 同一个 bug 踩了两次，所以固化成断言：
   *   第一次：层级分布里混进了确认轮（"L0 澄清 N 次"里掺着"学生答对了"）
   *   第二次：卡点清单里冒出了"第 8 步 · 引导 1 轮 · 已接近完成"这种条目
   * 确认轮的学生可见语义是"你答对了"，它不该出现在任何"卡在哪 / 帮了多少"的统计里。
   */
  it('确认轮不进层级分布，也不进卡点清单', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const record = createSessionRecord(P1.id);
    const history = [];

    for (const utterance of ['我用欧姆定律算电流，电阻只有R', '四个都出来了：E=0.4V，I=1A，F=0.2N，P=0.4W']) {
      const response = await engine.handleTurn({
        problemId: P1.id,
        utterance,
        history,
        mode: 'ai_companion',
        explicitHelpSeeking: true,
      });
      appendTurn(record, { utterance, response, problem: P1 });
      history.push({ role: 'student', text: utterance, at: '' });
      history.push({ role: 'ai', text: response.hint.text, at: '', level: response.hint.level });
    }

    const report = buildReport(P1, record, { engine: 'offline-stub' });

    assertEquals(report.hintStats.total, 1, '引导轮次只应算那一轮真正的提示');
    assertEquals(report.hintStats.confirmed, 1, '确认轮应单独统计');
    assertEquals(report.hintStats.confirmedComplete, 1, '其中一次是整题完成');

    const levels = Object.values(report.hintStats.byLevel).reduce((a, b) => a + b, 0);
    assertEquals(levels, report.hintStats.total, '层级分布的总数应与引导轮次一致');

    for (const sp of report.stuckPoints) {
      assert(
        sp.stepTitle !== '代入数值并给出结论',
        `确认轮不该出现在卡点清单里：${JSON.stringify(sp)}`,
      );
    }
  });
});