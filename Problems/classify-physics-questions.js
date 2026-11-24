import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_INPUT = join(ROOT, 'Problems', 'id_29_records.jsonl');
const DEFAULT_OUTPUT_DIR = join(ROOT, 'Problems', 'physics-by-type');

const CATEGORIES = [
  '填空题',
  '判断题',
  '作图题',
  '选择题',
  '实验题',
  '解答题',
  '综合题',
];

const TYPE_CATEGORY = new Map([
  ['2902', '填空题'],
  ['2906', '填空题'],
  ['2907', '判断题'],
  ['2905', '作图题'],
  ['2904', '解答题'],
  ['2909', '综合题'],
]);

const TYPE_NAME_CATEGORY = [
  [/填空题|知识点填空/, '填空题'],
  [/判断题/, '判断题'],
  [/作图题/, '作图题'],
  [/选择题|单选题|多选题|不定项选择/, '选择题'],
  [/实验题|探究题/, '实验题'],
  [/解答题/, '解答题'],
  [/综合题/, '综合题'],
];

const OBJECTIVE_TYPE_IDS = new Set(['1', '2901', '2908']);
const TAG_RE = /<[^>]*>/g;
const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const NUMBER_RE = /[-+]?\d+(?:\.\d+)?(?:\/\d+)?/g;
const PHYSICAL_QUANTITY_RE = /质量|重力|速度|速率|加速度|位移|路程|时间|力|拉力|压力|摩擦力|支持力|张力|功|功率|能量|动量|冲量|电流|电压|电阻|电势|电场|磁场|电荷|频率|角速度|半径|高度|距离|密度/;
const CALCULATION_TARGET_RE = /求|计算|算出|算得|求出|求得|求解|求范围|求大小|求最小值|求最大值/;

function parseArgs(argv) {
  const options = { input: DEFAULT_INPUT, outputDir: DEFAULT_OUTPUT_DIR, subjectId: '29' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') options.input = resolve(argv[++i]);
    else if (arg === '--output-dir') options.outputDir = resolve(argv[++i]);
    else if (arg === '--subject-id') options.subjectId = String(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node Problems/classify-physics-questions.js [--input 文件] [--output-dir 文件夹] [--subject-id ID]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function textOf(value) {
  return String(value ?? '')
    .replace(SCRIPT_RE, ' ')
    .replace(TAG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTypeId(record) {
  return String(record.qs_type_id ?? record.type_id ?? '');
}

function getTypeName(record) {
  return String(record.type?.name ?? record.type_name ?? '').trim();
}

function getStem(record) {
  return String(record.qs_stem ?? record.stem ?? record.html_text ?? '');
}

function hasChoiceStructure(record, text) {
  const formatted = String(record.formatted_json ?? '');
  return /(?:选择题|单选题|多选题|不定项选择)/.test(`${text} ${formatted}`) ||
    /['"]type['"]\s*:\s*['"]choice['"]/.test(formatted) ||
    /(?:^|[\s。；;])(?:A|B|C|D)[.．、:：]/.test(text);
}

function isExperiment(record, text) {
  const typeName = getTypeName(record);
  return /实验题|探究题/.test(typeName) ||
    /实验|探究|打点计时器|纸带|实验数据|实验装置|实验步骤|测量误差/.test(text) ||
    getTypeId(record) === '2903';
}

function isCalculation(record, text) {
  const answer = textOf(record.qs_answer ?? record.answer ?? '');
  const explanation = textOf(record.qs_explanation ?? record.explanation ?? '');
  const numbers = text.match(NUMBER_RE)?.length ?? 0;
  return CALCULATION_TARGET_RE.test(text) &&
    PHYSICAL_QUANTITY_RE.test(text) &&
    (numbers >= 3 || /由|根据|可得|解得|代入|联立/.test(`${answer} ${explanation}`));
}

function classify(record) {
  const typeId = getTypeId(record);
  const typeName = getTypeName(record);
  const text = textOf(`${getStem(record)} ${record.formatted_json ?? ''}`);
  if (isExperiment(record, text)) return '实验题';
  for (const [pattern, category] of TYPE_NAME_CATEGORY) {
    if (pattern.test(typeName)) return category;
  }
  if (TYPE_CATEGORY.has(typeId)) return TYPE_CATEGORY.get(typeId);
  if (OBJECTIVE_TYPE_IDS.has(typeId) || hasChoiceStructure(record, text)) return '选择题';
  if (isCalculation(record, text)) return '解答题';
  return '解答题';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeHtml(value) {
  return String(value ?? '').replace(SCRIPT_RE, '').replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function htmlStart(category, count) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(category)}</title><style>body{font-family:Arial,sans-serif;max-width:1100px;margin:2rem auto;line-height:1.7;color:#222}.card{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}.meta{color:#666;font-size:.9rem}.question img{max-width:100%}details{margin-top:1rem;background:#f7f7f7;padding:.7rem}</style></head><body><h1>${escapeHtml(category)}</h1><p>去重后共 ${count} 道。</p>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outputDir, { recursive: true });
  const records = new Map();
  const stats = { totalRecords: 0, uniqueRecords: 0, duplicates: 0, byCategory: Object.fromEntries(CATEGORIES.map((category) => [category, 0])) };
  const lines = createInterface({ input: createReadStream(options.input, { encoding: 'utf8' }), crlfDelay: Infinity });
  let firstLine = true;
  for await (let line of lines) {
    if (firstLine) {
      line = line.replace(/^\uFEFF/, '');
      firstLine = false;
    }
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (String(record.qs_subject_id ?? record.course_id ?? record.subject_id) !== options.subjectId) continue;
    stats.totalRecords += 1;
    const key = String(record._id ?? record.id ?? `${record._index ?? ''}:${getStem(record)}`);
    if (records.has(key)) {
      stats.duplicates += 1;
      continue;
    }
    records.set(key, record);
  }
  stats.uniqueRecords = records.size;
  const grouped = new Map(CATEGORIES.map((category) => [category, []]));
  for (const record of records.values()) {
    const category = classify(record);
    grouped.get(category).push(record);
    stats.byCategory[category] += 1;
  }
  for (const category of CATEGORIES) {
    const directory = join(options.outputDir, category);
    await mkdir(directory, { recursive: true });
    const items = grouped.get(category);
    const jsonl = items.map((record) => JSON.stringify(record)).join('\n') + (items.length ? '\n' : '');
    const cards = items.map((record, index) => `<article class="card"><h2>#${index + 1}</h2><p class="meta">ID：${escapeHtml(record._id ?? record.id)}　题型ID：${escapeHtml(getTypeId(record))}　索引：${escapeHtml(record._index)}</p><div class="question">${safeHtml(getStem(record))}</div><details><summary>查看答案与解析</summary><div>${safeHtml(record.qs_answer ?? record.answer ?? '')}</div><div>${safeHtml(record.qs_explanation ?? record.explanation ?? '')}</div></details></article>`).join('\n');
    await writeFile(join(directory, 'questions.jsonl'), jsonl, 'utf8');
    await writeFile(join(directory, 'questions.html'), `${htmlStart(category, items.length)}${cards}</body></html>`, 'utf8');
    await writeFile(join(directory, 'stats.json'), JSON.stringify({ category, count: items.length }, null, 2), 'utf8');
  }
  await writeFile(join(options.outputDir, 'stats.json'), JSON.stringify({ ...stats, generatedAt: new Date().toISOString(), input: options.input }, null, 2), 'utf8');
  console.log(`已完成：去重后 ${stats.uniqueRecords} 道，分类输出到 ${options.outputDir}`);
  for (const category of CATEGORIES) console.log(`${category}：${stats.byCategory[category]}`);
}

try {
  await main();
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
}
