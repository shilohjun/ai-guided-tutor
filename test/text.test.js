/**
 * 归一化与中文短语匹配测试。
 *
 * 这个文件的存在理由值得写清楚：
 *   上面那些"错因命中率 0% → 90%"的修复，最初是**单测全绿**的。
 *   因为单测里的用例都是从题库签名里原文抄的，天然匹配。
 *   真实学生的说法（"安培力**应该**向右"）一进评测就全线失手。
 *
 * 结论：测试数据必须来自真实语料，而不是来自被实现的规则表。
 * 下面每一条用例都标注了它来自哪个真实场景编号。
 */

import { describe, it, assert, assertEquals } from './runner.js';
import {
  normalize,
  canonicalize,
  chineseNumeralToArabic,
  matchSignatures,
  splitSignature,
  isNegated,
  isFollowUpUtterance,
  matchAll,
  unfoldScripts,
} from '../src/core/text.js';
import { getProblem } from '../src/core/problems.data.js';

describe('文本归一化', () => {
  it('全角转半角并压缩空白', () => {
    assertEquals(normalize('　Ｂ＝０．４Ｔ　'), 'B=0.4T');
  });

  it('中文数字在单位前转阿拉伯数字', () => {
    assert(chineseNumeralToArabic('一库仑').includes('1'));
    assert(chineseNumeralToArabic('十秒').includes('10'));
  });

  it('中文数字不应破坏"一般""一致"这类词', () => {
    assertEquals(chineseNumeralToArabic('一般情况下'), '一般情况下');
    assertEquals(chineseNumeralToArabic('是一致的'), '是一致的');
  });

  it('数学符号归一：½ 与 1/2 互相命中', () => {
    assert(canonicalize('x=½at²').includes('1/2'));
  });

  it('定律名归一', () => {
    assert(canonicalize('闭合电路欧姆定律').includes('欧姆定律'));
    assert(canonicalize('法拉第电磁感应定律').includes('法拉第'));
  });
});

describe('签名拆词', () => {
  it('中文词组保持完整，不切成无意义的碎片', () => {
    // 这条断言防的是"切成 力向 这种不存在的片段"那个 bug
    const terms = splitSignature('安培力向右');
    assert(terms.includes('安培力向右'), `应保留完整词组，实际 ${JSON.stringify(terms)}`);
    assert(!terms.includes('力向'), '不应产生"力向"这类碎片');
  });

  it('ASCII/数字串整体保留', () => {
    const terms = splitSignature('P=Fv 就是R的功率');
    assert(terms.includes('P=Fv'), `实际 ${JSON.stringify(terms)}`);
  });

  it('超长中文描述句才切块', () => {
    const terms = splitSignature('电流为零所以没有安培力');
    assert(terms.length > 1, '长描述句应被切块以获得召回');
  });
});

describe('否定识别', () => {
  it('"不变""恒定"里的"不"不是否定（构词成分）', () => {
    // 这是导致 sc-03 错因漏判的根因：把"速度不变"的"不"当成了否定词
    assertEquals(isNegated('速度不变', 0, 2), false);
    assertEquals(isNegated('温度恒定', 0, 2), false);
  });

  it('"没有变化"不是对"变化"的否定', () => {
    assertEquals(isNegated('磁通量没有变化', 3, 2), false);
  });

  it('真正的否定应被识别', () => {
    assertEquals(isNegated('安培力不做功', 3, 2), true);
    assertEquals(isNegated('没有电流', 0, 2), true);
  });
});

describe('签名匹配 · 真实学生说法（防回归核心）', () => {
  const P1 = getProblem('phy-emi-01');
  const P2 = getProblem('phy-emi-02');
  const P3 = getProblem('phy-emi-03');
  const P4 = getProblem('phy-emi-04');
  const P5 = getProblem('phy-emi-05');

  /** 取某题某个错因的签名集 */
  const sig = (problem, id) => problem.misconceptions.find((m) => m.id === id).signature;
  it('sc-03：修饰语隔开的关键词仍能命中', () => {
    // 学生说"匀速就是速度不变"，签名是"匀速就是速度不变"但中间有"就是"等修饰
    const text = canonicalize('匀速就是速度不变吧，但是力和电有什么关系，我不知道力怎么求');
    const hits = matchSignatures(text, sig(P1, 'm-ignore-equilibrium'));
    assert(hits.length > 0, `应命中忽略平衡条件，实际 []（文本：${text}）`);
  });

  it('sc-02：漏内阻的标准说法能命中', () => {
    const text = canonicalize('我用欧姆定律算电流，电流我直接用 I=E/R 算就行了，电阻只有R');
    assert(matchSignatures(text, sig(P1, 'm-forget-r')).length > 0, '应命中漏内阻');
  });

  it('sc-04：安培力方向判错能命中（"应该"插入）', () => {
    const text = canonicalize('安培力应该向右吧，和运动方向一样，这样它才帮助运动');
    const hits = matchSignatures(text, sig(P1, 'm-ampere-direction'));
    assert(hits.length > 0, `应命中方向错误，实际 []（文本：${text}）`);
  });

  it('sc-05：把均匀变化当无变化能命中', () => {
    const text = canonicalize('B均匀增加，磁通量没有变化，所以没有感应电流');
    assert(matchSignatures(text, sig(P2, 'm-uniform-means-none')).length > 0, '应命中');
  });

  it('sc-07：把变加速当匀变速能命中', () => {
    const text = canonicalize('我用 x=½at² 算位移，a=F/m 是恒定的');
    const hits = matchSignatures(text, sig(P3, 'm-uniform-accel'));
    assert(hits.length > 0, `应命中匀变速误用，实际 []（文本：${text}）`);
  });

  it('sc-10：混淆总功率与R上功率能命中', () => {
    const text = canonicalize('功率我用 P=Fv，就是 2×4=8W，所以R的功率也是8W');
    assert(matchSignatures(text, sig(P4, 'm-power-confuse')).length > 0, '应命中功率混淆');
  });

  it('sc-11：把电容器当断路能命中', () => {
    const text = canonicalize('电容器隔直流，所以电流为零，没有安培力，那就匀加速');
    assert(matchSignatures(text, sig(P5, 'm-cap-open')).length > 0, '应命中电容器断路误解');
  });

  it('sc-09：认为会无限加速能命中', () => {
    const text = canonicalize('恒力作用下它会一直加速，没有最大速度');
    assert(matchSignatures(text, sig(P4, 'm-no-limit')).length > 0, '应命中无最大速度误解');
  });

  it('sc-06：有效面积取错能命中', () => {
    const text = canonicalize('面积我用 S=2(L1+L2) 算的，就是线框一圈的长度');
    assert(matchSignatures(text, sig(P2, 'm-area-error')).length > 0, '应命中面积错误');
  });
});

describe('签名匹配 · 假阳性防护', () => {
  const P1 = getProblem('phy-emi-01');
  const P4 = getProblem('phy-emi-04');
  /** 取某题某个错因的签名集（本 describe 内独立定义，避免跨作用域引用） */
  const sig = (problem, id) => problem.misconceptions.find((m) => m.id === id).signature;

  it('无关发言不应命中任何错因', () => {
    const text = canonicalize('今天天气不错，我们班下午有体育课');
    for (const m of P1.misconceptions) {
      assertEquals(matchSignatures(text, m.signature).length, 0, `${m.id} 不应命中无关发言`);
    }
  });

  it('"只有R"不应在"R的功率"里误命中', () => {
    // 拆词共现曾把 "只有R" → ["只有","R"]，"R" 到处都有 ⇒ 假阳性
    const text = canonicalize('R的功率是8W');
    const hits = matchSignatures(text, sig(P4, 'm-forget-r-04'));
    assertEquals(hits.length, 0, `不应命中，实际 ${JSON.stringify(hits)}`);
  });

  it('正确使用公式的发言不应被判为错因', () => {
    const text = canonicalize('我用欧姆定律 I=E/(R+r) 算电流，因为导体棒有内阻');
    const hits = matchSignatures(text, sig(P1, 'm-forget-r'));
    assertEquals(hits.length, 0, `正确说法不应命中，实际 ${JSON.stringify(hits)}`);
  });
});

describe('追问识别', () => {
  it('短追问应被识别', () => {
    for (const t of ['然后呢', '还是不会', '不对吗', '再提示一点', '是这样吗', '为什么']) {
      assert(isFollowUpUtterance(t), `${t} 应被识别为追问`);
    }
  });

  it('带实质内容的发言不应被当成追问', () => {
    const t = '我用欧姆定律算电流，电流我直接用 I=E/R 算就行了，电阻只有R';
    assertEquals(isFollowUpUtterance(t), false);
  });
});

describe('Cue 匹配（定位通道）', () => {
  it('步骤 cue 能命中学生的口语表达', () => {
    const P3 = getProblem('phy-emi-03');
    const step1 = P3.solutionGraphs[0].steps[0];
    const hits = matchAll(canonicalize('我用 x=½at² 算位移'), step1.cues);
    assert(hits.length > 0, '应命中"用到匀加速公式"这一 cue');
  });
});

// ---------------------------------------------------------------------------
// 键盘写法与符号写法必须等价
// ---------------------------------------------------------------------------

describe('归一化 · `v^2` 与 `v²` 是同一个东西', () => {
  /**
   * 学生反馈："一些物理的表达式很难写上去。"
   *
   * 前端做了符号面板与自动替换，但那只帮到"从界面上打字"的学生。
   * 更要紧的是：**关键词通道的两边必须折到同一个写法上**。
   * 教师写的 cue 是 `v²=2aL`，学生打的是 `v^2=2aL` ——
   * 不在归一化里对齐，这条 cue 对这个学生就等于不存在，
   * 他会被判成"没说到点子上"，而他其实说得完全正确。
   */
  it('上标：^2 → ²、^-3 → ⁻³、^n → ⁿ', () => {
    assertEquals(normalize('v^2'), 'v²');
    assertEquals(normalize('10^-3'), '10⁻³');
    assertEquals(normalize('a^n'), 'aⁿ');
  });

  it('下标：_0 → ₀、_12 → ₁₂', () => {
    assertEquals(normalize('v_0'), 'v₀');
    assertEquals(normalize('a_12'), 'a₁₂');
  });

  it('【关键】两种写法归一后完全一致，所以同一条 cue 都能命中', () => {
    const pairs = [
      ['v^2=2aL', 'v²=2aL'],
      ['h=1/2gt^2', 'h=1/2gt²'],
      ['v_0=10m/s', 'v₀=10m/s'],
      ['B_1=0.5T', 'B₁=0.5T'],
    ];
    for (const [typed, symbolic] of pairs) {
      assertEquals(normalize(typed), normalize(symbolic), `"${typed}" 与 "${symbolic}" 应当等价`);
    }
  });

  it('用键盘打出来的公式能命中教师写的 cue（这才是等价的意义）', () => {
    const cues = ['v²=2aL', 'E=BLv', 'v₀=10 m/s'];
    const typedByStudent = '我先用 v^2=2aL，再用 E=BLv，初速度 v_0=10 m/s';
    const hit = matchAll(canonicalize(typedByStudent), cues);
    assertEquals(hit.length, cues.length, `三条 cue 都该命中，实际命中：${JSON.stringify(hit)}`);
  });

  it('摊平形式带回 `^` / `_`，写成 ^2 的指纹不会变成死指纹', () => {
    assertEquals(unfoldScripts('a²=2b²'), 'a^2=2b^2');
    assertEquals(unfoldScripts('v₀'), 'v_0');
    // 反向也对得上
    assertEquals(normalize(unfoldScripts('a²=2b²')), normalize('a²=2b²'));
  });

  it('普通文本不受影响（`_` 和 `^` 不会误伤正常内容）', () => {
    for (const s of ['我先求电动势', 'sin53°=0.8', 'R+r 是总电阻', 'm/s']) {
      assertEquals(normalize(s), normalize(s));
    }
    assertEquals(normalize('a_b'), 'a_b', '非数字的下标不该被动');
  });
});
describe('证据去重 · 同一句话的两种拼法只能算一条', () => {
  /**
   * 实测事故（由评测指标发现）：数学题的 cue 里同时写着
   * `a²=2b²` 与 `a^2=2b^2` —— 同一个式子的两种拼法。
   *
   * 归一化把两种写法折成同一个字符串之后，两条 cue 同时命中，
   * 那一步的证据数被算成 2（其实只有 1 条）。定位按证据数排序，
   * 于是**系统性地偏向写得啰嗦的那一步**：两个数学场景都停在
   * "两边平方得 a²=2b²" 不肯往后走，离线定位命中率 92.9% → 85.7%。
   */
  it('归一化后相同的 cue 只算一条证据', () => {
    const hit = matchAll('两边平方得到 a²=2b²', ['a²=2b²', 'a^2=2b^2']);
    assertEquals(hit.length, 1, `两种拼法应只算一条，实际：${JSON.stringify(hit)}`);
  });

  it('不同的式子仍然各算一条（去重不能去过头）', () => {
    const hit = matchAll('由 a²=2b² 得 b²=2k²', ['a²=2b²', 'b²=2k²']);
    assertEquals(hit.length, 2);
  });

  it('去重按归一化后的形式判断，不是按原字符串', () => {
    // 全角、半角、大小写三种拼法归一后是同一个式子 ⇒ 只算一条
    const hit = matchAll('Ｅ＝ＢＬｖ', ['E=BLv', 'Ｅ＝ＢＬｖ', 'e=blv']);
    assertEquals(hit.length, 1, `三种拼法应只算一条，实际：${JSON.stringify(hit)}`);
    // 而空格是内容的一部分：`E = BLv` 与 `E=BLv` 不是同一个写法（归一化不去空格）
    assertEquals(matchAll('E = BLv', ['E=BLv']).length, 0);
  });

  it('空数组与空串不崩', () => {
    assertEquals(matchAll('x', []).length, 0);
    assertEquals(matchAll('x', ['', null, undefined]).length, 0);
  });
});