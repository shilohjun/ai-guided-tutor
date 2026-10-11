/**
 * 题目解析（analysis）测试。
 *
 * 这个套件守的是"解析面板"最要命的一条性质：
 * **知识图谱对学生的版本里，绝不能出现解题步骤里的概念。**
 *
 * 这不是理论担忧 —— 本轮之前我确实漏过一次：
 * 把 steps[].concepts 汇总成 conceptTags 发给学生，而那道题的概念里有
 * 「电源与内阻」「匀速直线运动合力为零」，恰好就是本题的两个 solutionInsights。
 * 等于把答案印在题目下面。
 *
 * 所以这里用**反向断言**（学生版解析的 JSON 里不许出现任何步骤标题 / cues / intent）
 * 而不是正向断言（"应该有 3 个节点"）—— 正向断言会随着数据变化而失效，
 * 反向断言只要泄题就一定会失败。
 */

import { describe, it, assert, assertEquals, assertNotIncludes } from './runner.js';
import {
  buildProblemAnalysis,
  toStudentAnalysis,
  toTeacherAnalysis,
  parseVariable,
  CONDITION_MARKERS,
} from '../src/core/analysis.js';
import { getProblem } from '../src/core/problems.data.js';
import { getProblemAnalysis } from '../src/core/registry.js';

const P1 = getProblem('phy-emi-01'); // 匀速切割磁感线：solutionInsights 里有"合力为零"

describe('解析 · 关键变量', () => {
  it('"L = 0.5 m" 能拆成符号 / 值 / 单位，并给出中文说明', () => {
    const v = parseVariable('L = 0.5 m', 'given', 0);
    assertEquals(v.symbol, 'L');
    assertEquals(v.value, '0.5');
    assertEquals(v.unit, 'm');
    assertEquals(v.note, '长度 / 距离');
  });

  it('"感应电动势 E" 这种中文在前、符号在后的写法也能取到符号', () => {
    const v = parseVariable('感应电动势 E', 'asked', 1);
    assertEquals(v.symbol, 'E');
    assertEquals(v.value, null);
    assert(v.note.includes('感应电动势'), `说明应保留中文名，实际：${v.note}`);
  });

  it('定性条件（"匀速运动"）不会被印成两遍', () => {
    const v = parseVariable('匀速运动', 'given', 2);
    assertEquals(v.value, null);
    assertEquals(v.note, '', '与原文相同的说明必须留空，否则 UI 会出现"匀速运动 匀速运动"');
  });

  it('整道题的变量分组：已知与待求都非空', () => {
    const a = buildProblemAnalysis(P1);
    assert(a.variables.given.length >= 4, `已知量应有 4 条以上，实际 ${a.variables.given.length}`);
    assert(a.variables.asked.length >= 1, '待求量不应为空');
  });
});

describe('解析 · 关键条件', () => {
  it('能扫出"匀速"这类一句话改变整道题的条件', () => {
    const a = buildProblemAnalysis(P1);
    const labels = a.keyConditions.map((c) => c.label);
    assert(
      labels.some((l) => l.includes('匀速')),
      `应识别出"匀速"这条关键条件，实际：${JSON.stringify(labels)}`,
    );
  });

  it('会剧透的条件被标记出来（判据与守卫的指纹完全一致）', () => {
    const a = buildProblemAnalysis(P1);
    const uniform = a.keyConditions.find((c) => c.label.includes('匀速'));
    assert(uniform, '应有匀速条件');
    assertEquals(
      uniform.reveals,
      true,
      '"匀速 ⇒ 合力为零"正是本题的 solutionInsight，必须判为会剧透',
    );
  });

  it('引用的是题干原话的一段，而不是整句', () => {
    const a = buildProblemAnalysis(P1);
    for (const c of a.keyConditions) {
      assert(c.text.length > 0, '每条条件都要有原话引用');
      assert(c.text.length <= 60, `引用过长（${c.text.length} 字）：${c.text}`);
    }
    // 同一道题里不同条件的引用不应完全一样 —— 否则学生看不出每条到底指哪几个字
    const texts = a.keyConditions.map((c) => c.text);
    assertEquals(new Set(texts).size, texts.length, `条件引用出现了重复：${JSON.stringify(texts)}`);
  });

  it('标记表本身是自洽的：每条都有 label / meaning / ask', () => {
    for (const m of CONDITION_MARKERS) {
      assert(m.re instanceof RegExp, 're 必须是正则');
      assert(m.label && m.meaning && m.ask, `标记 ${m.label} 缺字段`);
    }
  });
});

describe('解析 · 知识图谱（防泄题的核心断言）', () => {
  it('学生图谱的节点只来自 topics，不含解题步骤里的概念', () => {
    const a = buildProblemAnalysis(P1);
    const studentNames = a.knowledgeGraph.student.nodes.map((n) => n.name);
    const topicSet = new Set(P1.topics);
    for (const name of studentNames) {
      assert(topicSet.has(name), `学生图谱出现了非知识点的节点：${name}`);
    }
  });

  it('学生版解析的 JSON 里不许出现任何步骤标题 / cues / intent', () => {
    const a = buildProblemAnalysis(P1);
    const studentJson = JSON.stringify(toStudentAnalysis(a, P1));
    /**
     * 题干、知识点、已知量、待求量本来就是要给学生看的，
     * 所以"某个 cue 恰好是知识点的子串"（如 cue「法拉第」与 topic「法拉第电磁感应定律」）
     * 不算泄漏 —— 那是同一个词的正常出现，不是从解法里漏出来的。
     * 判据因此收窄成：**不能出现"只存在于解法里"的词**。
     */
    const legit = [P1.stem, ...P1.topics, ...P1.givens, ...P1.asked].join(' ');

    for (const g of P1.solutionGraphs) {
      for (const s of g.steps) {
        assertNotIncludes(studentJson, s.title, `学生解析里出现了步骤标题：「${s.title}」`);
        for (const cue of s.cues ?? []) {
          if (cue.length >= 3 && !legit.includes(cue)) {
            assertNotIncludes(studentJson, cue, `学生解析里出现了只存在于解法里的关键词：「${cue}」`);
          }
        }
        // intent 是"学生该产出什么"，经常直接写着答案，绝不能出网
        if (s.intent && s.intent.length >= 6 && !legit.includes(s.intent)) {
          assertNotIncludes(studentJson, s.intent, `学生解析里出现了步骤意图：「${s.intent}」`);
        }
      }
      assertNotIncludes(studentJson, g.name, `学生解析里出现了路径名：「${g.name}」`);
      for (const pre of g.preconditions ?? []) {
        if (pre.length >= 8 && !legit.includes(pre)) {
          assertNotIncludes(studentJson, pre, `学生解析里出现了路径前提：「${pre}」`);
        }
      }
    }
  });

  it('教师图谱才有步骤里的概念，并且标出它出现在第几步', () => {
    const a = buildProblemAnalysis(P1);
    const concepts = a.knowledgeGraph.teacher.nodes.filter((n) => n.kind === 'concept');
    assert(concepts.length > 0, '教师图谱应包含步骤概念');
    assert(
      concepts.some((c) => c.steps.length > 0),
      '概念节点必须带上"出现在第几步"',
    );
    // 这个具体概念是本题的解法要点，绝不能出现在学生图里
    const studentNames = a.knowledgeGraph.student.nodes.map((n) => n.name);
    assert(!studentNames.includes('电源与内阻'), '「电源与内阻」是解法要点，不能在学生图谱里');
  });

  it('图谱的边都指向存在的节点（不会画出悬空的线）', () => {
    const a = buildProblemAnalysis(P1);
    for (const scope of ['student', 'teacher']) {
      const ids = new Set(a.knowledgeGraph[scope].nodes.map((n) => n.id));
      for (const e of a.knowledgeGraph[scope].edges) {
        assert(ids.has(e.from), `${scope} 图的边 from 指向了不存在的节点：${e.from}`);
        assert(ids.has(e.to), `${scope} 图的边 to 指向了不存在的节点：${e.to}`);
      }
    }
  });

  it('题型（题库题 / 导入题）走同一条解析代码路径', () => {
    const imported = {
      ...P1,
      id: 'imp-test-analysis',
      source: 'imported',
      topics: ['自由落体运动', '匀变速直线运动'],
      givens: ['h = 20 m', 'g = 10 m/s²'],
      asked: ['落地速度 v'],
    };
    const a = buildProblemAnalysis(imported);
    assertEquals(a.knowledgeGraph.student.nodes.length, 2, '导入题的知识点同样能构成图谱');
    assert(a.variables.given.length === 2, '导入题的变量同样被解析');
  });
});

describe('解析 · 两个投影的边界', () => {
  it('会剧透的条件：学生拿到提问，教师拿到完整含义', () => {
    const a = buildProblemAnalysis(P1);
    const student = toStudentAnalysis(a, P1);
    const teacher = toTeacherAnalysis(a);

    const s = student.keyConditions.find((c) => c.revealsInsight);
    const t = teacher.keyConditions.find((c) => c.reveals);
    assert(s && t, '应有一条会剧透的条件');

    assertEquals(s.meaning, null, '学生版不得返回会剧透的含义');
    assert(s.question && s.question.length > 4, '学生版必须给出一句可回答的提问');
    assert(t.meaning.length > 6, '教师版必须保留完整含义，否则教研无法核对');
    assertNotIncludes(JSON.stringify(student), t.meaning, '教师含义不得出现在学生载荷里');
  });

  it('不剧透的条件：学生直接看到含义', () => {
    const a = buildProblemAnalysis(P1);
    const student = toStudentAnalysis(a, P1);
    const safe = student.keyConditions.find((c) => !c.revealsInsight);
    assert(safe, '本题应至少有一条不剧透的条件（如"接触面光滑"）');
    assert(safe.meaning && safe.meaning.length > 4, '不剧透的条件应直接给出含义');
    assertEquals(safe.question, null);
  });

  it('registry 的解析缓存返回同一个对象（同一道题不会每次重建图谱）', () => {
    const a1 = getProblemAnalysis(P1);
    const a2 = getProblemAnalysis(P1);
    assert(a1 === a2, '同一道题的解析应被缓存复用');
  });
});
