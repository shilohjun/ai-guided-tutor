/**
 * 守卫单元测试 —— 防泄题是本产品的生命线，测试必须比实现更"刻薄"。
 * 这里刻意构造各种"模型可能的绕过手法"，验证守卫能拦住。
 */

import { describe, it, assert, assertEquals, assertIncludes, assertNotIncludes } from './runner.js';
import {
  guard,
  checkAnswerLeak,
  checkFormulaLeak,
  checkLevelOverflow,
  checkSolutionDump,
  checkConclusion,
  checkConceptDomain,
  checkSolutionInsight,
  extractValueUnits,
  safeFallbackHint,
  isTitleSafeForStudent,
  safeStepRef,
} from '../src/core/guard.js';
import { getProblem, PROBLEMS } from '../src/core/problems.data.js';
import { createEngine } from '../src/core/engine.js';
import { createOfflineAdapter } from '../src/core/llm.js';

const P1 = getProblem('phy-emi-01'); // 答案 0.4V / 1A / 0.2N / 0.4W
const P3 = getProblem('phy-emi-03'); // 答案 q=1C / x=1m / Q=1J

describe('守卫 · 答案泄漏检测', () => {
  it('直接给出数值答案应被拦截', () => {
    const v = checkAnswerLeak('这一步算出来是 0.4 V，所以外力是 0.2 N。', P1);
    assert(v.length >= 2, `应命中至少 2 条，实际 ${v.length}`);
    assert(v.every((x) => x.kind === 'answer_in_text'));
  });

  it('中文数字说法不能绕过', () => {
    const v = checkAnswerLeak('通过电阻的电荷量是一库仑。', P3);
    assert(v.length >= 1, '中文"一库仑"应被识别为 1 C 的泄漏');
  });

  it('只说公式不给数值不应判为答案泄漏', () => {
    const v = checkAnswerLeak('你可以想想 E 和 B、L、v 的关系。', P1);
    assertEquals(v.length, 0, '公式问题应交给 formula 检查，而不是答案检查');
  });

  it('引用题干已知量不应被误判', () => {
    // 0.4 T 是题干给的 B，不是答案（答案里的 0.4 V 才是）
    const v = checkAnswerLeak('B = 0.4 T 这个条件你注意到了吗？', P1);
    assertEquals(v.length, 0, '题干已知量不应算泄漏');
  });

  it('从参考答案自动抽取数值单位对', () => {
    const pairs = extractValueUnits(P1.referenceAnswer);
    assert(pairs.length >= 3, `应抽出多个数值单位对，实际 ${pairs.length}`);
    assert(
      pairs.some((p) => p.value === '0.4' && p.unit === 'V'),
      '应包含 0.4 V',
    );
  });
});

describe('守卫 · 公式泄漏检测', () => {
  it('L1 出现完整解法表达式应被拦截', () => {
    const v = checkFormulaLeak('你可以直接用 E = BLv 算。', P1, 1);
    assert(v.length >= 1, 'L1 不应出现 BLv');
  });

  it('L3 允许出现符号形式但仍拦截完整表达式', () => {
    const allowed = checkFormulaLeak('我们先只写左边：力的冲量。', P1, 3);
    assertEquals(allowed.length, 0, 'L3 描述动作不应被拦');
    const blocked = checkFormulaLeak('直接套 E = BLv 就出来了。', P1, 3);
    assert(blocked.length >= 1, 'L3 也不应给出完整解法表达式');
  });

  it('L2 给出方向性描述不应被拦', () => {
    const v = checkFormulaLeak('力的大小和电流有关，电流又和速度有关。', P1, 2);
    assertEquals(v.length, 0, '纯方向提示不应被拦');
  });
});

describe('守卫 · 层级越界检测', () => {
  it('L1 出现公式形态应被判越界', () => {
    const v = checkLevelOverflow('你想想 I = E/(R+r) 对不对？', P1, 1);
    assert(v.length >= 1, 'L1 不应出现公式形态');
  });

  it('L3 允许出现公式形态', () => {
    const v = checkLevelOverflow('你可以写 I = E/(R+r)', P1, 3);
    assertEquals(v.length, 0, 'L3 允许公式形态');
  });

  it('"匀速 ⇒ 合力为零"这类条件翻译不算公式', () => {
    const v = checkLevelOverflow('题目说匀速，那合力满足什么条件？', P1, 1);
    assertEquals(v.length, 0, '不应把文字条件翻译当公式');
  });
});

describe('守卫 · 步骤倾倒与收口句式', () => {
  it('列出 3 个以上编号步骤应被拦', () => {
    const v = checkSolutionDump('1、先算电动势\n2、再算电流\n3、然后求安培力\n4、最后求功率');
    assert(v.length >= 1, '完整步骤清单应被拦');
  });

  it('长箭头推导链应被拦', () => {
    const v = checkSolutionDump('E → I → F安 → F外 → P');
    assert(v.length >= 1, '完整推导链应被拦');
  });

  it('收口句式应被拦', () => {
    for (const t of ['所以答案是 0.2 N。', '因此可得外力大小。', '最终结果就是 0.4 W。', '结论是外力等于安培力。']) {
      const v = checkConclusion(t);
      assert(v.length >= 1, `应拦下：${t}`);
    }
  });

  it('正常引导语不应被误拦', () => {
    const ok = [
      '你打算用哪个规律？它成立的前提是什么？',
      '先只把研究对象受到的力按方向列出来。',
      '题目里的"匀速"在力学上意味着什么？',
    ];
    for (const t of ok) {
      const g = guard(t, P1, 1, {});
      assert(g.passed, `不应拦下正常引导语：${t} —— 命中 ${JSON.stringify(g.violations)}`);
    }
  });
});

describe('守卫 · 概念域越界（跑题）检测', () => {
  it('对着电路题聊动量定理应被拦截', () => {
    // 这是实测抓到的真实事故：L2 模板硬编码了动量定理话术
    const v = checkConceptDomain('现在你手上缺的是一个能跨时间累积的量，想想动量定理。', P1);
    assert(v.length >= 1, '应判为跑题');
    assertEquals(v[0].kind, 'concept_out_of_domain');
  });

  it('本题领域内的概念不应被拦', () => {
    const ok = [
      '谁是提供电动势的那一部分？它自身有没有电阻？',
      '导体棒受到的安培力方向该怎么判断？',
      '闭合电路欧姆定律的分母里除了外电阻还有什么？',
    ];
    for (const t of ok) {
      const v = checkConceptDomain(t, P1);
      assertEquals(v.length, 0, `不应拦下本领域提示：${t} → ${JSON.stringify(v)}`);
    }
  });

  it('通用教学用语不应被误判为跑题', () => {
    const ok = [
      '先只把研究对象单独拎出来，按方向列出各个量。',
      '这一步的关键在它和另一个量之间的关系。',
      '把你要用的关系式的左边先写出来，右边留空。',
      '把题目给了什么、要求什么各说一遍。',
    ];
    for (const t of ok) {
      const v = checkConceptDomain(t, P1);
      assertEquals(v.length, 0, `教学用语被误判：${t} → ${JSON.stringify(v)}`);
    }
  });

  it('本题涉及的概念不属于越界（同一概念在题库文本里出现过即放行）', () => {
    const P3 = getProblem('phy-emi-03');
    // 动量定理是 P3 的标准解法之一，因此对 P3 说动量定理是合法的
    const v = checkConceptDomain('想想动量定理能不能用上。', P3);
    assertEquals(v.length, 0, 'P3 涉及动量定理，不应判为越界');
    // 但对 P1（匀速切割题）就不合法
    const v2 = checkConceptDomain('想想动量定理能不能用上。', P1);
    assert(v2.length >= 1, 'P1 不涉及动量定理，应判为越界');
  });

  it('跑题提示经守卫后被整体替换为安全模板', () => {
    const g = guard('你想想动量定理，或者用动能定理试试。', P1, 2, {});
    assert(!g.passed, '应判定为不通过');
    assertEquals(g.repairStrategy, 'safe-template');
    const recheck = guard(g.repairedText, P1, 2, {});
    assert(recheck.passed, '重写结果必须干净');
  });
});

describe('守卫 · 解法要点泄漏（"说出答案"的第三种形态）', () => {
  it('实测事故原句必须被拦截', () => {
    // 真模型 glm-4-plus 在 L1 层的真实回复：
    // 没有公式、没有数值，形式上完全合规，但把学生漏掉的那个知识点直接说出来了
    const incident = '现在需要关注的是整个电路的结构，导体棒产生的电动势相当于电源，而电阻R和导体棒自身的电阻r组成了外电路和内阻。';
    const v = checkSolutionInsight(incident, P1, 1);
    assert(v.length >= 1, `应拦下实测事故原句，实际 ${JSON.stringify(v)}`);
    assertEquals(v[0].kind, 'solution_insight');
  });

  it('L0/L1/L2 都拦，L3 放行（降级示范允许说到这个颗粒度）', () => {
    const reveal = '导体棒是电源，它自身的电阻 r 是内阻。';
    for (const level of [0, 1, 2]) {
      assert(checkSolutionInsight(reveal, P1, level).length >= 1, `L${level} 应拦截`);
    }
    assertEquals(checkSolutionInsight(reveal, P1, 3).length, 0, 'L3 应放行');
  });

  it('"在问"不拦，"在答"才拦', () => {
    const asking = [
      '谁是提供电动势的那一部分？它自身有没有电阻？',
      '这段电路里，一共有几处电阻在限制电流？',
      '你说的这个规律，成立需要满足什么前提？',
    ];
    for (const t of asking) {
      assertEquals(checkSolutionInsight(t, P1, 1).length, 0, `提问不应被拦：${t}`);
    }
  });

  it('被拦后整体替换为安全模板，且模板自身干净', () => {
    const incident = '导体棒相当于电源，r 是内阻。';
    const g = guard(incident, P1, 1, {});
    assert(!g.passed);
    assertEquals(g.repairStrategy, 'safe-template');
    assert(guard(g.repairedText, P1, 1, {}).passed, '重写结果必须干净');
    // 兜底模板也不能说漏嘴
    assertEquals(checkSolutionInsight(g.repairedText, P1, 1).length, 0, '兜底模板不得含解法要点');
  });

  it('各题的安全兜底模板在所有层级都不得含解法要点', () => {
    for (const p of PROBLEMS) {
      for (const level of [0, 1, 2, 3]) {
        const t = safeFallbackHint(p, level, {});
        assertEquals(
          checkSolutionInsight(t, p, level).length,
          0,
          `${p.id} L${level} 兜底模板含解法要点：${JSON.stringify(checkSolutionInsight(t, p, level))}`,
        );
      }
    }
  });
});

describe('守卫 · 端到端与降级重写', () => {
  it('泄漏文本被拦后必须给出可用的重写结果', () => {
    const g = guard('所以答案是 0.4 V，你可以直接用 E = BLv 算出来。', P1, 1, {});
    assert(!g.passed, '应判定为不通过');
    assert(g.repairedText && g.repairedText.length > 5, '必须产出重写文本');
    // 重写结果本身也必须干净
    const recheck = guard(g.repairedText, P1, 1, {});
    assert(recheck.passed, `重写结果仍不干净：${JSON.stringify(recheck.violations)}`);
  });

  it('安全兜底模板对任意层级都必须通过守卫', () => {
    for (const p of [P1, P3]) {
      for (const level of [0, 1, 2, 3]) {
        const t = safeFallbackHint(p, level, {});
        const g = guard(t, p, level, {});
        assert(g.passed, `兜底模板未通过：${p.id} L${level} → ${JSON.stringify(g.violations)}`);
      }
    }
  });

  it('守卫结果结构符合类型契约', () => {
    const g = guard('所以答案是 0.4 V', P1, 1, {});
    assertEquals(typeof g.passed, 'boolean');
    assert(Array.isArray(g.violations));
    assert(g.violations.every((v) => typeof v.kind === 'string' && typeof v.detail === 'string'));
  });
});

// ---------------------------------------------------------------------------
// 步骤标题的对外安全（真模型评测抓到过的漏洞）
// ---------------------------------------------------------------------------

describe('步骤标题 · 含结论的标题不许说给学生', () => {
  /**
   * 实测事故：复述段原样引用步骤标题，而那一步的标题是
   *   「因此 a、b 有公因数 2，与"互质"矛盾」
   * —— 等于把整个证明的结论递过去了。
   *
   * 这个洞一直存在，只是离线桩的定位很少落到那一步，所以一直没被看见。
   * 结论：**步骤标题是教研语言，不是学生语言**，能不能给学生看要逐条判断。
   */
  const math = PROBLEMS.find((p) => p.subject === 'math');

  it('命中答案/公式/结论指纹的标题被判为不可展示', () => {
    const risky = math.solutionGraphs
      .flatMap((g) => g.steps)
      .map((s) => s.title)
      .filter((t) => !isTitleSafeForStudent(t, math));
    assert(risky.length > 0, '这道数学题应当至少有一个含结论的步骤标题被拦下');
  });

  it('安全引用：不安全的退到"第 N 步（动作类型）"，而不是照抄标题', () => {
    const step = math.solutionGraphs[0].steps.find((s) => !isTitleSafeForStudent(s.title, math));
    assert(step, '需要一个不安全的步骤做样本');
    const ref = safeStepRef(math, step);
    assert(!ref.includes(step.title), `不该照抄标题：${ref}`);
    assertIncludes(ref, `第 ${step.index} 步`, '应退到带序号的说法');
    assertIncludes(ref, '步（', '应带上动作类型，让学生知道那一步在做什么');
  });

  it('derive / conclude 两类标题一律不引（它们天然写结果）', () => {
    const step = { index: 9, title: '把数值代进去算出来', kind: 'conclude' };
    const ref = safeStepRef(P1, step);
    assert(!ref.includes('把数值代进去'), `conclude 步骤不该引标题：${ref}`);
  });

  it('引擎复述段里不出现任何未经检查的步骤标题', async () => {
    const engine = createEngine({ adapter: createOfflineAdapter(), problem: math });
    const history = [];
    for (const u of ['我假设√2=a/b，两边平方得到 a²=2b²，所以 a 和 b 都是偶数', '然后呢', '还是不会']) {
      const res = await engine.handleTurn({
        problemId: math.id,
        utterance: u,
        history,
        mode: 'ai_companion',
        explicitHelpSeeking: true,
      });
      for (const g of math.solutionGraphs) {
        for (const s of g.steps) {
          if (isTitleSafeForStudent(s.title, math)) continue;
          assertNotIncludes(res.message, s.title, `学生可见文本里出现了不安全标题：「${s.title}」`);
        }
      }
      history.push({ role: 'student', text: u, at: '' });
      history.push({ role: 'ai', text: res.hint.text, at: '', level: res.hint.level });
    }
  });
});