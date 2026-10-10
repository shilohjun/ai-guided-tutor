/**
 * 引擎端到端测试。
 *
 * 最重要的一条断言：**任何路径产出的学生可见文本都不含答案**。
 * 包括"模型故意泄题"的情况 —— 用一个恶意适配器模拟模型被诱导，
 * 验证守卫仍然兜得住。这是整个 PoC 最该被反复验证的性质。
 */

import { describe, it, assert, assertEquals, assertNotIncludes } from './runner.js';
import { createEngine, classifyRequest } from '../src/core/engine.js';
import { createOfflineAdapter } from '../src/core/llm.js';
import { getProblem, PROBLEMS } from '../src/core/problems.data.js';
import { guard } from '../src/core/guard.js';
import { chineseNumeralToArabic, normalize } from '../src/core/text.js';

const P1 = getProblem('phy-emi-01');
const P3 = getProblem('phy-emi-03');

/** 断言文本不含任何答案指纹 */
function assertNoAnswerLeak(text, problem, label = '') {
  const t = chineseNumeralToArabic(normalize(text));
  for (const fp of problem.answerFingerprints) {
    const re = new RegExp(fp, 'i');
    const m = t.match(re);
    if (m) {
      throw new Error(`${label} 文本出现答案泄漏：命中 /${fp}/ → "${m[0]}"\n完整文本：${text}`);
    }
  }
}

/** 恶意适配器：模拟模型被诱导后直接泄题 */
function createLeakyAdapter() {
  return {
    kind: 'llm',
    model: 'leaky-mock',
    async observeStudent(input) {
      const base = await createOfflineAdapter().observeStudent(input);
      return base;
    },
    async draftHint({ level }) {
      // 每一级都故意泄题
      const evil = {
        0: '答案是 0.4 V 和 0.2 N。',
        1: '所以答案是 0.4 V，你用 E = BLv 就能算出来。',
        2: '直接算：I = E/(R+r)，结果 1 A。',
        3: '完整过程：1、算 E=0.4V；2、算 I=1A；3、算 F=0.2N。因此答案是 0.2 N。',
      };
      return JSON.stringify({ text: evil[level] ?? evil[1], nextAsk: '照做。', concepts: [] });
    },
  };
}

/** 崩溃适配器：模拟模型服务不可用 */
function createBrokenAdapter() {
  return {
    kind: 'llm',
    model: 'broken-mock',
    async observeStudent() {
      throw new Error('模拟模型 503');
    },
    async draftHint() {
      throw new Error('模拟模型 503');
    },
  };
}

describe('引擎 · 基本链路', () => {
  it('学生首次描述思路能得到 L1 提示，且含定位与复述', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '我想用安培力，但是我不知道力的大小怎么求，只知道有安培力',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assertEquals(res.hint.level, 1, '首次应为 L1');
    assert(res.diagnosis.position.stepIndex != null, '应能定位到步骤');
    assert(res.message.length > 10, '应产出学生可见消息');
    assertNoAnswerLeak(res.message, P1, 'handleTurn');
  });

  it('离线模式的输出在任意层级都不泄题', async () => {
    for (const problem of PROBLEMS) {
      for (const level of [0, 1, 2, 3]) {
        const engine = createEngine({ adapter: createOfflineAdapter(), problem });
        // 直接构造一个已知诊断，强制走指定层级
        const { buildDiagnosis, findStepByPosition } = await import('../src/core/locate.js');
        const obs = await createOfflineAdapter().observeStudent({
          problem,
          utterance: '我想用安培力和欧姆定律，但是不确定前提',
          history: [],
        });
        const diagnosis = buildDiagnosis(problem, obs, '我想用安培力和欧姆定律，但是不确定前提');
        // 概念白名单必须来自题目自身 —— 早期测试这里硬编码了 ['安培力', '欧姆定律']，
        // 于是对不含安培力的题目生成了跑题提示。测试数据本身也要符合真实约束。
        const step = findStepByPosition(problem, diagnosis.position);
        const allowedConcepts = step?.concepts ?? [];
        const drafted = await createOfflineAdapter().draftHint({
          problem,
          diagnosis,
          level,
          allowedConcepts,
          forbidden: [],
          strategy: 'condition_question',
        });
        const parsed = JSON.parse(drafted);
        assertNoAnswerLeak(parsed.text, problem, `${problem.id} L${level}`);
        const g = guard(parsed.text, problem, level, {});
        assert(g.passed, `${problem.id} L${level} 离线模板未过守卫：${JSON.stringify(g.violations)}`);
      }
    }
  });
});

describe('引擎 · 守卫兜底（模型泄题场景）', () => {
  it('模型每一级都泄题时，最终交付文本仍不含答案', async () => {
    for (const problem of [P1, P3]) {
      const engine = createEngine({ adapter: createLeakyAdapter(), problem });
      const history = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await engine.handleTurn({
          problemId: problem.id,
          utterance: i === 0 ? '我想用安培力但是不知道怎么求力' : '还是不会',
          history,
          mode: 'ai_companion',
          explicitHelpSeeking: true,
        });
        assertNoAnswerLeak(res.message, problem, `${problem.id} 第${i + 1}轮`);
        assert(res.meta.guard.passed, '出口守卫必须为 passed');
        assert(res.meta.guardHistory.length >= 1, '应记录到拦截历史');
        assert(
          res.meta.guardHistory.some((g) => !g.passed),
          '恶意适配器必须被守卫拦下至少一次',
        );
        history.push({ role: 'student', text: i === 0 ? '我想用安培力但是不知道怎么求力' : '还是不会', at: '' });
        history.push({ role: 'ai', text: res.hint.text, at: '', level: res.hint.level, metaStep: res.diagnosis.position.stepIndex });
      }
    }
  });

  it('出口守卫失败的文本绝不被放行（内部一致性）', async () => {
    const engine = createEngine({ adapter: createLeakyAdapter(), problem: P1 });
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '我想用欧姆定律',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    const recheck = guard(res.hint.text, P1, res.hint.level, {});
    assert(recheck.passed, `交付文本未过独立复核：${JSON.stringify(recheck.violations)}`);
  });
});

describe('引擎 · 降级容错', () => {
  it('模型完全不可用时仍能给出安全提示', async () => {
    const engine = createEngine({ adapter: createBrokenAdapter(), problem: P1 });
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '我不会做这道题',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assertNoAnswerLeak(res.message, P1, '降级路径');
    assert(res.hint.text.length > 5, '降级后仍应有可读提示');
  });

  it('空输入不崩溃', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assert(res.hint.text.length > 5);
  });
});

describe('引擎 · 需求识别与反捷径', () => {
  it('关键词识别各类请求', () => {
    assert(classifyRequest('告诉我答案').pureSolicitation, '应识别为纯索取');
    assert(classifyRequest('别提示了，直接给答案').pureSolicitation);
    assert(!classifyRequest('我算的是 0.4 V，对吗').pureSolicitation, '验证型不算纯索取');
    assert(classifyRequest('我算的是 0.4 V，对吗').askVerify);
  });

  it('学生直接索要答案时不进入生成流程，且话术递进', async () => {
    const engine = createEngine({ adapter: createLeakyAdapter(), problem: P1 });
    const first = await engine.handleTurn({
      problemId: P1.id,
      utterance: '直接告诉我答案',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assertEquals(first.refusal?.kind, 'answer_solicitation');
    assertNoAnswerLeak(first.message, P1, '拒绝话术');

    const second = await engine.handleTurn({
      sessionId: 'default',
      problemId: P1.id,
      utterance: '给我答案',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assertEquals(second.refusal?.count, 2, '第二次索取应使用第二档话术');
    assert(first.hint.text !== second.hint.text, '话术必须递进而不是复读');
  });

  it('索要答案但带有思路时应走正常引导（不误伤）', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '我用欧姆定律算出了电流，但力不知道怎么求，答案是什么',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assertEquals(res.refusal, undefined, '带了思路就不应走纯拒绝路径');
    assert(res.diagnosis.position.stepIndex != null, '应尝试定位');
  });
});

describe('引擎 · 层级递进在真实对话里的表现', () => {
  it('连续追问时层级单调递进且不超过 L3，且不重复同一句', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const history = [];
    const levels = [];
    const texts = [];
    for (let i = 0; i < 5; i += 1) {
      const utterance = i === 0 ? '我想用安培力，但不知道力怎么求，匀速这个条件有什么用' : '还是不会，再给一点提示';
      const res = await engine.handleTurn({
        problemId: P1.id,
        utterance,
        history,
        mode: 'ai_companion',
        explicitHelpSeeking: true,
      });
      levels.push(res.hint.level);
      texts.push(res.hint.text);
      history.push({ role: 'student', text: utterance, at: '' });
      history.push({ role: 'ai', text: res.hint.text, at: '', level: res.hint.level, metaStep: res.diagnosis.position.stepIndex });
    }
    assert(Math.max(...levels) <= 3, `层级不得超过 3，实际 ${levels.join(',')}`);
    // 不允许出现"跳过中间层级"（例如 1 → 3）
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i] > levels[i - 1]) {
        assert(levels[i] - levels[i - 1] === 1, `不得跳级：${levels.join(',')}`);
      }
    }
    assert(new Set(texts).size >= 3, `提示不应高度重复，实际不同文本数 ${new Set(texts).size}`);
  });
});

describe('引擎 · 教学质量护栏（两次真实事故的固化）', () => {
  /**
   * 事故一：L2 提示硬编码了"缺一个能跨时间累积的量，想想哪个定理"
   *        → 对着"漏内阻"的电路题聊起了动量定理，学生一眼看出 AI 没看懂题。
   * 事故二：L3 固定话术是"列出受力"
   *        → 学生在算电流时，AI 让他去列受力。
   *
   * 这两类错误比"泄题"更隐蔽，但同样致命：泄题会被守卫拦住，
   * 跑题不会 —— 所以必须用断言守住。
   */
  it('L2 提示不得引入本题领域之外的物理概念', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const history = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await engine.handleTurn({
        problemId: P1.id,
        utterance: i === 0 ? '我用欧姆定律算电流，电流我直接用 I=E/R 算就行了，电阻只有R' : '还是不懂',
        history,
        mode: 'ai_companion',
        explicitHelpSeeking: true,
      });
      // 动量/冲量/动能 这些概念在"导体棒匀速切割"题里完全不存在
      for (const forbidden of ['动量', '冲量', '吸附', '简谐', '洛伦兹']) {
        assertNotIncludes(res.message, forbidden, `第${i + 1}轮提示跑题（出现"${forbidden}"）`);
      }
      history.push({ role: 'student', text: '还是不懂', at: '' });
      history.push({
        role: 'ai',
        text: res.hint.text,
        at: '',
        level: res.hint.level,
        metaStep: res.diagnosis.position.stepIndex,
        metaGraphId: res.diagnosis.position.graphId,
      });
    }
  });

  it('L3 示范动作必须匹配当前步骤类型（不能让学生去列受力）', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const history = [];
    let l3Text = '';
    for (let i = 0; i < 4; i += 1) {
      const res = await engine.handleTurn({
        problemId: P1.id,
        utterance: i === 0 ? '我用欧姆定律算电流，电流我直接用 I=E/R 算就行了，电阻只有R' : '还是不会',
        history,
        mode: 'ai_companion',
        explicitHelpSeeking: true,
      });
      if (res.hint.level === 3) l3Text = res.hint.text;
      history.push({ role: 'student', text: '还是不会', at: '' });
      history.push({
        role: 'ai',
        text: res.hint.text,
        at: '',
        level: res.hint.level,
        metaStep: res.diagnosis.position.stepIndex,
        metaGraphId: res.diagnosis.position.graphId,
      });
    }
    assert(l3Text, '应能到达 L3 以检查示范内容');
    // 本题第 4 步是 apply（套用公式），示范动作应是"写关系式左边"，而非"列受力"
    assertNotIncludes(l3Text, '按方向列出', 'L3 示范与步骤类型不匹配');
    assert(
      /关系式|左边|左边留空|给定|量列/.test(l3Text),
      `L3 示范应针对"套用公式"这一步，实际：${l3Text}`,
    );
  });

  it('拒绝给答案时，内部诊断说明不得出现在学生可见文本里', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '直接告诉我答案',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assertNotIncludes(res.message, '未提供可诊断的思路', '内部说明泄漏给学生');
    assertNotIncludes(res.message, '我理解你的意思是', '拒绝路径不应有复述段');
    assert(res.message.startsWith('答案我先不给'), `拒绝话术应直接开场，实际：${res.message.slice(0, 30)}`);
  });

  it('停在"死胡同路径"末步时不得判为已完成', async () => {
    // 事故：学生在"只走能量守恒"这条走不通的路上卡住，
    // 引擎判成 finished 后 AI 说"你已经走到最后一步了，收尾交给你自己" ——
    // 学生明明在求助，这句回复等于把他推开。
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P3 });
    const res = await engine.handleTurn({
      problemId: P3.id,
      utterance: '我用能量守恒，Fx=½mv²，能量守恒就够了',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assert(res.diagnosis.stuckKind !== 'finished', `不应判为 finished，实际 ${res.diagnosis.stuckKind}`);
    assert(!res.suppressed, '不应抑制回复');
    assertNotIncludes(res.message, '收尾就交给你自己', '不应让学生自行收尾');
  });

  it('学生说"未知量太多解不出来"时，L2 应引导"换工具"而不是继续往下算', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P3 });
    const history = [];
    // 第 1 轮：学生走能量路径
    // 第 2 轮：学生自己发现这条路走不通（这就是死胡同信号）
    const utterances = ['我用能量守恒，Fx=½mv²，能量守恒就够了', '但是未知量太多解不出来', '还是不会'];
    let sawDeadEndKind = false;
    let l2Text = '';
    for (let i = 0; i < utterances.length; i += 1) {
      const utterance = utterances[i];
      const res = await engine.handleTurn({
        problemId: P3.id,
        utterance,
        history,
        mode: 'ai_companion',
        explicitHelpSeeking: true,
      });
      if (res.diagnosis.stuckKind === 'dead_end_path') sawDeadEndKind = true;
      if (res.hint.level === 2) l2Text = res.hint.text;
      history.push({ role: 'student', text: utterance, at: '' });
      history.push({
        role: 'ai',
        text: res.hint.text,
        at: '',
        level: res.hint.level,
        metaStep: res.diagnosis.position.stepIndex,
        metaGraphId: res.diagnosis.position.graphId,
      });
    }
    assert(sawDeadEndKind, '应识别出 dead_end_path 卡点性质');
    assert(l2Text, '应能到达 L2');
    assert(/未知量|定下来|工具|定理/.test(l2Text), `L2 应引导换工具，实际：${l2Text}`);
  });

  it('追问时不应复读学生的废话作为"理解"', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const first = await engine.handleTurn({
      problemId: P1.id,
      utterance: '我用欧姆定律算电流，电流我直接用 I=E/R 算就行了，电阻只有R',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    const history = [
      { role: 'student', text: '我用欧姆定律算电流', at: '' },
      { role: 'ai', text: first.hint.text, at: '', level: first.hint.level, metaStep: first.diagnosis.position.stepIndex, metaGraphId: first.diagnosis.position.graphId },
    ];
    const second = await engine.handleTurn({
      problemId: P1.id,
      utterance: '还是不会，再给一点提示',
      history,
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assertNotIncludes(second.message, '还是不会', '不应把"还是不会"当成学生的推理复述出来');
  });
});

describe('引擎 · 诊断可解释性', () => {
  it('诊断必须带 trace 与证据引用', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '我用欧姆定律 I=E/R 算电流，但是匀速我不知道怎么用',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assert(res.diagnosis.trace.length >= 3, '应记录各阶段 trace');
    assert(res.diagnosis.trace.some((t) => t.stage === 'locate'), '应有定位 trace');
    assert(res.diagnosis.position.confidence > 0, '应有置信度');
  });

  it('学生原话中的错因能被打上标签并给出证据', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '电流我直接用 I=E/R 算就行了，电阻只有R',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assert(
      res.diagnosis.misconceptions.some((m) => m.id === 'm-forget-r'),
      `应识别出漏内阻错因，实际：${JSON.stringify(res.diagnosis.misconceptions.map((m) => m.id))}`,
    );
    assert(res.diagnosis.misconceptions[0].evidence.length > 0, '应给出证据引用');
  });
});
