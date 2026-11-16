#!/usr/bin/env node
/** 校验：新分类树里的每个叶节点 / 方法细分，在 qbank-review.js 里都有文案；顺带列出旧题库对不上的题。 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QBANK_GRAPHS } from '../../src/core/qbank-graphs.data.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = readFileSync(resolve(ROOT, 'src/core/qbank-review.js'), 'utf8');

/** 从源码里把 const NAME = { … }; 的对象字面量取出来求值（本地文件，无可执行外部输入）。 */
function literal(name) {
  const start = src.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  const from = src.indexOf('{', start);
  let depth = 0;
  let inStr = null;
  for (let i = from; i < src.length; i += 1) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') i += 1;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') inStr = c;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (!depth) return evaluate(src.slice(from, i + 1));
    }
  }
  throw new Error(`${name} 没配平`);
}
function evaluate(code) {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${code});`)();
}

const KNOWLEDGE = literal('KNOWLEDGE_TEXT');
const METHOD = literal('METHOD_TEXT');

const missingLeaves = [];
const leaves = QBANK_GRAPHS.knowledge.flatMap((m) => m.children.flatMap((c) => c.children));
for (const leaf of leaves) {
  if (leaf.name === '综合应用') continue;
  if (!KNOWLEDGE[leaf.name]) missingLeaves.push(`${leaf.id} ${leaf.name}`);
}
const extraneous = Object.keys(KNOWLEDGE).filter((name) => !leaves.some((l) => l.name === name));

const missingFamilies = QBANK_GRAPHS.methods.filter((t) => !METHOD[t.id]).map((t) => `${t.id} ${t.name}`);
const missingSubs = QBANK_GRAPHS.methods.flatMap((t) => t.children.filter((c) => !METHOD[c.id]).map((c) => `${c.id} ${c.name}`));

console.log('知识叶节点', leaves.length, '｜缺文案', missingLeaves.length);
for (const x of missingLeaves) console.log('   缺', x);
console.log('已不在树里的旧文案', extraneous.length, extraneous.length ? extraneous.join('、') : '');
console.log('方法大类', QBANK_GRAPHS.methods.length, '｜缺文案', missingFamilies.length, missingFamilies.join('、'));
console.log('方法细分', QBANK_GRAPHS.methods.flatMap((t) => t.children).length, '｜缺文案', missingSubs.length, missingSubs.join('、'));
