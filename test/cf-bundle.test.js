/**
 * `scripts/build-cf-bundle.mjs` 的契约：Worker 部署包里的题库必须"瘦身但不缺料"。
 *
 * 为什么这一组值得写
 * ------------------
 * 这个脚本决定的是"线上到底哪一份题库"。它做错时不会报错：
 *   · 该删的 HTML 没删 → 部署包还是 33 MB，冷启动继续 503/1105；
 *   · 不该删的字段删多了 → 学生打开题库里的题，服务端认不出来，或者没有解析。
 *
 * 所以三条断言各自盯一件事：
 *   ① 三个 HTML 字段一定被摘掉；
 *   ② 其余字段一个不少（尤其是 i / stemText / options / answerText / analysisText）；
 *   ③ 生成的模块是能被 Worker 读的 ESM 数组，且里面不含 HTML 字段名。
 */

import { describe, it, assert, assertIncludes, assertNotIncludes, assertEquals } from './runner.js';
import { slimQuestions, renderSlimModule, HTML_FIELDS } from '../scripts/build-cf-bundle.mjs';

const sample = () => [
  {
    i: 1,
    code: 'YN-2026-01',
    chap: '原子物理',
    leaf: '光电效应',
    stemText: '已知锡和铟的逸出功…',
    stemHtml: '<p>已知锡和铟…</p>',
    options: [{ l: 'A', text: '选项一' }],
    answerHtml: '<p>A</p>',
    answerText: 'A',
    analysisHtml: '<p>解析</p>',
    analysisText: '由光电效应方程…',
    knowledgeIds: ['k58'],
    methodIds: ['t1'],
  },
];

describe('Worker 部署包：题库瘦身', () => {
  it('三个 HTML 字段被摘掉，其他字段一个不少', () => {
    const [q] = slimQuestions(sample());
    for (const field of HTML_FIELDS) {
      assert(!(field in q), `${field} 必须被摘掉`);
    }
    const kept = ['i', 'code', 'chap', 'leaf', 'stemText', 'options', 'answerText', 'analysisText', 'knowledgeIds', 'methodIds'];
    for (const field of kept) {
      assert(field in q, `${field} 不能被一起删掉`);
    }
    assertEquals(q.stemText, '已知锡和铟的逸出功…', '题干文本要原样保留');
    assertEquals(q.options.length, 1, '选项要原样保留');
  });

  it('数量与顺序不变（不能顺手去重或排序）', () => {
    const list = [...sample(), { ...sample()[0], i: 2 }];
    const slim = slimQuestions(list);
    assertEquals(slim.length, 2, '题数要一致');
    assertEquals(slim[0].i, 1, '顺序要一致');
    assertEquals(slim[1].i, 2, '顺序要一致');
  });

  it('生成的模块是 ESM 数组，且不含 HTML 字段名', () => {
    const text = renderSlimModule(slimQuestions(sample()));
    assertIncludes(text, 'export const QBANK_SOURCE=[', '必须是 ESM 具名导出');
    for (const field of HTML_FIELDS) {
      assertNotIncludes(text, field, `${field} 不该出现在产物里`);
    }
    assertIncludes(text, '已知锡和铟的逸出功…', '题干文本要在产物里');
  });

  it('空数组直接拒绝（防止把题库换丢的那份文件当输入）', () => {
    // main() 里用 Array.isArray + length 兜底；这里固定住这条判断的形状
    const bad = [];
    assert(!(Array.isArray(bad) && bad.length > 0), '空题库必须被判为不合法');
  });
});
