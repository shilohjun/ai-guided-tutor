#!/usr/bin/env node
/** 从重建后的资产里数出给 README / 文档用的真实数字。 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QBANK_SOURCE } from '../../src/core/qbank-source.data.js';
import { QBANK_GRAPHS } from '../../src/core/qbank-graphs.data.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const data = JSON.parse(readFileSync(resolve(ROOT, 'public/qbank/data.json'), 'utf8'));

const formulas = QBANK_SOURCE.reduce((a, q) => a + (q.nF || 0), 0);
const figures = QBANK_SOURCE.reduce((a, q) => a + (q.nFig || 0), 0);
const optionImgs = QBANK_SOURCE.reduce((a, q) => a + q.options.filter((o) => o.html.includes('<img')).length, 0);
const papers = new Set(QBANK_SOURCE.map((q) => q.src.replace(/第\s*\d+\s*题$/, '').trim()));
const withOptions = QBANK_SOURCE.filter((q) => q.options.length).length;
const types = {};
for (const q of QBANK_SOURCE) types[q.ty] = (types[q.ty] || 0) + 1;
const diffs = {};
for (const q of QBANK_SOURCE) diffs[q.d] = (diffs[q.d] || 0) + 1;
const leaves = QBANK_GRAPHS.knowledge.flatMap((m) => m.children.flatMap((c) => c.children));
const subs = QBANK_GRAPHS.methods.flatMap((m) => m.children);

// 计数自洽性：每棵树的 count 应当等于按标签筛出来的题数
const leafCount = new Map();
for (const q of QBANK_SOURCE) for (const id of q.knowledgeIds) leafCount.set(id, (leafCount.get(id) || 0) + 1);
const subCount = new Map();
for (const q of QBANK_SOURCE) for (const id of q.methodIds) subCount.set(id, (subCount.get(id) || 0) + 1);
const wrongLeaves = leaves.filter((l) => l.count !== (leafCount.get(l.id) || 0));
const wrongSubs = subs.filter((s) => s.count !== (subCount.get(s.id) || 0));
// 地图数据与题目数据是否一致
const mapMismatch = data.qs.filter((row) => QBANK_SOURCE.find((q) => q.i === row.i) === undefined);

console.log('题量', QBANK_SOURCE.length, '｜套卷', papers.size, '｜有选项', withOptions, '｜无选项', QBANK_SOURCE.length - withOptions);
console.log('题型', types, '｜难度', diffs);
console.log('公式图', formulas, '张 ｜图形', figures, '张 ｜含图的选项', optionImgs, '个');
console.log('知识树', QBANK_GRAPHS.knowledge.length, '模块 /', QBANK_GRAPHS.knowledge.reduce((a, m) => a + m.children.length, 0), '章 /', leaves.length, '叶');
console.log('思路树', QBANK_GRAPHS.methods.length, '类 /', subs.length, '细分');
console.log('计数不一致：叶', wrongLeaves.length, '细分', wrongSubs.length, '｜地图缺题', mapMismatch.length);
console.log('数据文件：data.json qs', data.qs.length, '｜kg 叶', data.kg.flatMap((m) => m.children.flatMap((c) => c.children)).length);
