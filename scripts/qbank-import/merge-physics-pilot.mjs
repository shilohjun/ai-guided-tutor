#!/usr/bin/env node
/**
 * Promote the five enterprise-bank pilot records into the formal qbank.
 *
 * Enterprise fields are normalized here once:
 *   _id -> enterprise.sourceId
 *   qs_stem/stem/html_text -> stemHtml/stemText
 *   qs_answer/qs_explanation -> answer and analysis fields
 *   qs_type_id/type.name/_index -> enterprise.typeId/typeName/index
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QBANK_SOURCE } from '../../src/core/qbank-source.data.js';
import { PHYSICS_PILOT_SOURCE } from '../../src/core/qbank-physics-pilot.data.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SOURCE_FILE = join(ROOT, 'src', 'core', 'qbank-source.data.js');
const PUBLIC_INDEX = join(ROOT, 'public', 'qbank', 'data.json');
const PUBLIC_QUESTIONS = join(ROOT, 'public', 'qbank', 'q');
const START_ID = Math.max(...QBANK_SOURCE.map((q) => q.i)) + 1;

const TAG_RE = /<[^>]*>/g;
const existingEnterprise = QBANK_SOURCE.filter((q) => q.enterprise?.sourceId);
const existingIds = new Set(existingEnterprise.map((q) => q.enterprise.sourceId));

if (existingEnterprise.length !== 0) {
  if (existingEnterprise.length !== PHYSICS_PILOT_SOURCE.length) {
    throw new Error('正式题库已包含部分企业题，拒绝继续合并以避免数据重复');
  }
  console.log(`正式题库已包含 ${existingEnterprise.length} 道企业题，无需重复合并`);
  process.exit(0);
}

const mappings = [
  { chap: '牛顿运动定律', leaf: '受力分析与正交分解', knowledgeIds: ['k5', 'kx5'], methodIds: ['t3a', 't5b', 't1b'] },
  { chap: '牛顿运动定律', leaf: '受力分析与正交分解', knowledgeIds: ['k5', 'kx7'], methodIds: ['t3a', 't5b', 't1b'] },
  { chap: '牛顿运动定律', leaf: '受力分析与正交分解', knowledgeIds: ['k5', 'kx5'], methodIds: ['t3a', 't6a', 't1b'] },
  { chap: '直线运动', leaf: '匀变速直线运动规律', knowledgeIds: ['k1', 'kx6'], methodIds: ['t4a', 't1b'] },
  { chap: '直线运动', leaf: '匀变速直线运动规律', knowledgeIds: ['k1', 'kx6'], methodIds: ['t4a', 't1b'] },
];

const additions = PHYSICS_PILOT_SOURCE.map((pilot, index) => {
  if (existingIds.has(pilot.sourceId)) throw new Error(`重复企业题源 ID：${pilot.sourceId}`);
  const mapping = mappings[index];
  return {
    ...pilot,
    i: START_ID + index,
    pilot: undefined,
    sourceId: undefined,
    code: `ENTERPRISE-PHYSICS-${String(index + 1).padStart(3, '0')}`,
    no: String(START_ID + index).padStart(3, '0'),
    ty: '计算',
    d: typeof pilot.d === 'number' ? pilot.d : 3,
    p: '企业题库',
    mod: '力学',
    chap: mapping.chap,
    leaf: mapping.leaf,
    t1: '平衡与约束',
    t2: '牛顿定律方程组',
    src: `企业题库 · 解答题 · ${index + 1}`,
    knowledgeIds: mapping.knowledgeIds,
    methodIds: mapping.methodIds,
    enterprise: {
      sourceId: pilot.sourceId,
      index: 'physics-by-type/解答题',
      typeId: '2904',
      typeName: '解答题',
      originalId: pilot.sourceId,
      reviewStatus: 'needs-review',
    },
  };
});

for (const record of additions) {
  delete record.pilot;
  delete record.sourceId;
}

const source = [...QBANK_SOURCE, ...additions];
await writeFile(
  SOURCE_FILE,
  `// Generated from the supplied question bank; data only. Reference answers are server-only.\nexport const QBANK_SOURCE = ${JSON.stringify(source)};\n`,
  'utf8',
);

const publicQuestions = additions.map((q) => ({
  i: q.i,
  c: q.code,
  src: q.src,
  m: q.mod,
  k: `c-${q.mod}-${q.chap}`,
  l: q.knowledgeIds[0] ?? '',
  t: q.t1,
  t2: q.methodIds[0] ?? '',
  ty: q.ty,
  d: typeof q.d === 'number' ? q.d : 3,
  p: q.p,
  s: q.stemText,
  stem: q.stemText,
  opt: q.options.map((o) => `${o.l}. ${o.text}`).join(' '),
}));
const oldIndex = JSON.parse(await (await import('node:fs/promises')).readFile(PUBLIC_INDEX, 'utf8'));
await writeFile(PUBLIC_INDEX, JSON.stringify({ ...oldIndex, qs: [...oldIndex.qs, ...publicQuestions] }), 'utf8');

for (const q of additions) {
  const publicQuestion = {
    i: q.i,
    code: q.code,
    no: q.no,
    src: q.src,
    ty: q.ty,
    d: q.d,
    p: q.p,
    mod: q.mod,
    chap: q.chap,
    leaf: q.leaf,
    t1: q.t1,
    t2: q.t2,
    stemHtml: q.stemHtml,
    stemText: q.stemText,
    options: q.options,
    nF: q.nF,
    nFig: q.nFig,
    knowledgeIds: q.knowledgeIds,
    methodIds: q.methodIds,
  };
  await writeFile(join(PUBLIC_QUESTIONS, `${q.i}.json`), JSON.stringify(publicQuestion), 'utf8');
}

console.log(`正式合并完成：${additions.length} 道，题库总数 ${source.length}`);
console.log(`新增编号：${additions.map((q) => `qbank-${q.i}`).join(', ')}`);
