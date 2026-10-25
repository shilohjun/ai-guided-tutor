/**
 * 信息不足路径（反问）与"学生想对了什么"的测试。
 *
 * 这两个能力来自一次设计对照的启发：
 *   ① 学生只说"我不会"时，早期实现**仍然会硬给一个定位和错因**，只是把置信度压低。
 *      正确动作是反问 —— 编出来的定位比没有定位更糟，学生会立刻觉得"AI 在瞎说"。
 *   ② 早期实现从不告诉学生"你想对了哪些"。一个卡住的学生最需要先听到这句，
 *      否则他会以为自己整道题全错了。
 *
 * 两者都属于"教学法正确性"，跟安全指标无关，所以必须单独用测试守住。
 *
 * 另外补一条防重复的护栏测试：同一层级不能在长会话里复读同一句话。
 */

import { describe, it, assert, assertEquals, assertIncludes, assertNotIncludes } from './runner.js';
import { createEngine } from '../src/core/engine.js';
import { createOfflineAdapter } from '../src/core/llm.js';
import { getProblem } from '../src/core/problems.data.js';
import { polishVoice } from '../src/core/prompt.js';

const P1 = getProblem('phy-emi-01');

/** 只说了"我不会"这类零信息的发言 */
const ZERO_INFO_UTTERANCES = ['我不会', '不知道', '看不懂', '没思路', '然后呢', '接下来怎么办', '提示一下'];

describe('信息不足 · 应反问而不是硬猜', () => {
  it('学生只说"我不会"时不得给出任何定位', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    for (const u of ZERO_INFO_UTTERANCES) {
      const res = await engine.handleTurn({
        problemId: P1.id,
        utterance: u,
        history: [],
        mode: 'ai_companion',
        explicitHelpSeeking: true,
      });
      assertEquals(res.diagnosis.sufficientInfo, false, `"${u}" 应判定为信息不足`);
      assertEquals(res.diagnosis.position.stepIndex, null, `"${u}" 不应给出步骤定位`);
      assertEquals(res.diagnosis.misconceptions.length, 0, `"${u}" 不应给出错因`);
      assertEquals(res.hint.level, 0, `"${u}" 应只做 L0 反问`);
    }
  });

  it('反问必须落到一个具体问题，而不是"你能说详细点吗"', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '我不会',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assert(res.diagnosis.probeQuestion, '应给出 probeQuestion');
    assert(
      /条件|要求|规律|公式|哪一步|按顺序/.test(res.diagnosis.probeQuestion),
      `反问应具体可答，实际：${res.diagnosis.probeQuestion}`,
    );
    assertNotIncludes(res.message, '详细点', '不应问没有抓手的问题');
  });

  it('反问轮不得泄露方向：不得出现公式形态、不得点名规律', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '不知道',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    // 反问轮的概念白名单必须为空 —— 没有概念可引用，模型就无法给方向
    assertEquals(res.hint.concepts.length, 0, '反问轮不应携带任何概念');
    assert(!/[=＝]/.test(res.hint.text), `反问轮不应出现公式形态：${res.hint.text}`);
    for (const law of ['欧姆定律', '安培力', '法拉第', 'BLv']) {
      assertNotIncludes(res.hint.text, law, `反问轮不应点名规律「${law}」`);
    }
  });

  it('信息充足时应恢复正常诊断（不能把反问路径做成万能挡箭牌）', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '我用欧姆定律算电流，电流我直接用 I=E/R 算就行了，电阻只有R',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assertEquals(res.diagnosis.sufficientInfo, true, '有实质思路时应判为信息充足');
    assert(res.diagnosis.position.stepIndex != null, '应给出定位');
    assert(res.hint.level >= 1, '应给出真正的提示而不是反问');
  });

  it('已说过思路后再说"我不会"：不应反问，而应继续按原定位升级', async () => {
    // 这里的前提是：学生第一轮已经说了完整思路（定位到第 4 步）。
    // 第二轮他说"我不会" —— 本轮信息确实不足，但语境完全够。
    // 正确行为是继续升级提示（L1→L2），而不是把他当成"一句话都没说过"从头反问。
    // 早期实现会在这里误走反问路径，把已有诊断丢掉 —— 那才是真正的 bug。
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
      {
        role: 'ai',
        text: first.hint.text,
        at: '',
        level: first.hint.level,
        metaStep: first.diagnosis.position.stepIndex,
        metaGraphId: first.diagnosis.position.graphId,
      },
    ];
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '我不会',
      history,
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });

    // 不应反问
    assertNotIncludes(res.hint.text, '你能先说一下', '不应在已有语境时反问');
    // 应升级而不是停在原地
    assertEquals(res.hint.level, 2, `应升到 L2，实际 L${res.hint.level}`);
    // 不应凭空产生新错因（本轮学生没提供任何新证据）
    assertEquals(res.diagnosis.misconceptions.length, 0, '不应凭空产生错因');
  });
});

describe('学生想对了什么 · 先肯定再指出卡点', () => {
  it('学生用对了规律时，诊断应记录这个正面的部分', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '我用欧姆定律算电流，电流我直接用 I=E/R 算就行了，电阻只有R',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assert(res.diagnosis.strengths.length > 0, '应记录学生想对的地方');
    assert(
      res.diagnosis.strengths.some((s) => s.includes('欧姆定律')) ||
        res.diagnosis.strengths.some((s) => s.includes('方向')),
      `应指出他用对了规律，实际 ${JSON.stringify(res.diagnosis.strengths)}`,
    );
  });

  it('保留内部学习证据，但不强制在每条回复中复述或夸奖', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '我用欧姆定律算电流，电流我直接用 I=E/R 算就行了，电阻只有R',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    const visible = res.message ?? '';
    assert(
      !/我理解你的意思是|你想对的地方是/.test(visible),
      `学生可见文本不应强制长篇复述，实际：${visible.slice(0, 200)}`,
    );
  });

  it('学生没想对任何东西时不应编造正面评价', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const res = await engine.handleTurn({
      problemId: P1.id,
      utterance: '我不会',
      history: [],
      mode: 'ai_companion',
      explicitHelpSeeking: true,
    });
    assertEquals(res.diagnosis.strengths.length, 0, '信息不足时不应编造"你想对了什么"');
  });
});

describe('长会话 · 不得复读同一句提示', () => {
  it('连续 6 轮追问后，提示文本应保持多样', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
    const history = [];
    const texts = [];
    for (let i = 0; i < 6; i += 1) {
      const utterance =
        i === 0 ? '我用欧姆定律算电流，电流我直接用 I=E/R 算就行了，电阻只有R' : '还是不会';
      const res = await engine.handleTurn({
        problemId: P1.id,
        utterance,
        history,
        mode: 'ai_companion',
        explicitHelpSeeking: true,
      });
      texts.push(res.hint.text);
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
    const unique = new Set(texts).size;
    assert(unique >= 3, `6 轮里至少应有 3 种不同提示，实际 ${unique} 种：\n${texts.join('\n---\n')}`);
    // 同一句话连续出现两次是最糟的情况（学生会立刻发现 AI 卡住了）
    for (let i = 1; i < texts.length; i += 1) {
      assert(texts[i] !== texts[i - 1], `第 ${i + 1} 轮与上一轮完全重复：${texts[i]}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 语域：AI 的措辞要像一个资深教师，而不是一个陪聊机器人
// ---------------------------------------------------------------------------

describe('语域 · 措辞的专业度（由代码保证，不靠模型自觉）', () => {
  it('空话、夸张、卖萌由代码删除，而不是靠提示词里写一句"不要空话"', () => {
    assertEquals(polishVoice('加油，你可以的！我们先看看回路里有哪些电阻。').text, '我们先看看回路里有哪些电阻。');
    assertEquals(polishVoice('太棒了！你算出了 E。接下来看电流怎么求？').text, '你算出了 E。接下来看电流怎么求？');
  });

  it('句尾语气词与波浪号被清掉（但不误伤"吗/呢"这类疑问助词）', () => {
    const r = polishVoice('你先列出受力分析的式子吧～');
    assert(!r.text.includes('～'), `波浪号应被清掉：${r.text}`);
    // "吗"是正常疑问助词，必须保留，否则提问会被破坏
    assertEquals(polishVoice('这个规律成立吗？').text, '这个规律成立吗？');
  });

  it('emoji 被清掉（资深教师不会在理科提示里放表情）', () => {
    const r = polishVoice('先看回路的构成 👇 谁是电源？');
    assert(!/[\u{1F300}-\u{1FAFF}]/u.test(r.text), `仍然有 emoji：${r.text}`);
    assertIncludes(r.text, '谁是电源', '删 emoji 不能连正文一起删');
  });

  it('整句都是空话时不返回断头标点（调用方会退回原文）', () => {
    assertEquals(polishVoice('加油！').text, '');
    assertEquals(polishVoice('很棒！这道题不难，你再仔细想想。').text, '这道题不难。');
  });

  it('删小句之后不留"！我们先…"这种断头句', () => {
    const t = polishVoice('加油，你可以的！我们先看看回路里有哪些电阻。').text;
    assert(!/^[，。！？、]/.test(t), `开头不应是标点：${t}`);
  });

  it('一句话里问了两个问题会被标出来（不擅自改写，只如实记录）', () => {
    const r = polishVoice('你先试试。你觉得这个规律成立吗？那前提满足了吗？');
    assertEquals(r.multiQuestion, true, '两个问号应被标记');
    assertIncludes(r.text, '你觉得这个规律成立吗', '标记归标记，不能擅自删掉学生的选择权');
  });

  it('引擎产出的提示文本里不含语气词与 emoji', () => {
    const banned = /[\u{1F300}-\u{1FAFF}]|[啦呀哦嗯哈诶哎]|～|~/u;
    return (async () => {
      const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
      const history = [];
      for (const u of ['我不会', '还是不会', '提示一下', '再给点提示']) {
        const res = await engine.handleTurn({
          problemId: P1.id,
          utterance: u,
          history,
          mode: 'ai_companion',
          explicitHelpSeeking: true,
        });
        assert(!banned.test(res.message), `提示文本含不专业措辞：${res.message}`);
        history.push({ role: 'student', text: u, at: '' });
        history.push({ role: 'ai', text: res.hint.text, at: '', level: res.hint.level });
      }
    })();
  });
});
