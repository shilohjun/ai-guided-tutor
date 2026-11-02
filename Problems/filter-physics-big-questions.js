/**
 * Stream the subject-29 question JSONL, deduplicate it, score likely physics
 * "big questions", and write a JSONL subset plus a browsable HTML report.
 *
 * Examples:
 *   node scripts/filter-physics-big-questions.js
 *   node scripts/filter-physics-big-questions.js --min-score 7 --limit 100
 *   node scripts/filter-physics-big-questions.js --calculation-only
 */

import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INPUT = join(ROOT, 'Problems', 'id_29_records.jsonl');
const DEFAULT_OUTPUT_DIR = join(ROOT, 'Problems', 'physics-big');
const CALCULATION_OUTPUT_DIR = join(ROOT, 'Problems', 'physics-calculation');
const PER_TYPE_OUTPUT_DIR = join(ROOT, 'Problems', 'physics-calculation-5-per-type');
const TYPE_OUTPUT_DIR = join(ROOT, 'Problems', 'physics-type');

const PHYSICS_TYPE_IDS = new Set(['2902', '2903', '2904', '2905', '2906', '2907', '2909']);
const UNIT_RE = /(?:kg|mg|kN|N|km\/h|m\/s(?:\^?2)?|mA|kV|V|A|cm|mm|m|Ω|ohm|J|W|Hz|T|Pa|C|F|H|°|℃|%)/gi;
const NUMBER_RE = /[-+]?\d+(?:\.\d+)?(?:\/\d+)?/g;
const SUBQUESTION_RE = /[（(]\s*([1-9]\d*)\s*[）)]/g;
const TAG_RE = /<[^>]*>/g;
const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const EVENT_ATTR_RE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

function parseArgs(argv) {
  const options = {
    input: DEFAULT_INPUT,
    outputDir: DEFAULT_OUTPUT_DIR,
    minScore: 7,
    limit: Infinity,
    subjectId: '29',
    includeAnswers: false,
    calculationOnly: false,
    perType: null,
    typeId: null,
    outputDirExplicit: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--input') options.input = resolve(next);
    else if (arg === '--output-dir') {
      options.outputDir = resolve(next);
      options.outputDirExplicit = true;
    }
    else if (arg === '--min-score') options.minScore = parseNumber(next, '--min-score');
    else if (arg === '--limit') options.limit = parseNumber(next, '--limit');
    else if (arg === '--subject-id') options.subjectId = String(next);
    else if (arg === '--include-answers') options.includeAnswers = true;
    else if (arg === '--calculation-only') options.calculationOnly = true;
    else if (arg === '--per-type') options.perType = parseInteger(next, '--per-type');
    else if (arg === '--type-id') options.typeId = String(next);
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
    else throw new Error(`无法识别的参数：${arg}`);
    const consumesValue = !['--help', '-h', '--include-answers', '--calculation-only'].includes(arg);
    if (consumesValue) i += 1;
  }

  if (options.minScore < 0 || options.minScore > 15) {
    throw new Error('--min-score 应在 0 到 15 之间');
  }
  if (options.limit !== Infinity && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit 应为正整数');
  }
  if (options.perType !== null && options.perType < 1) {
    throw new Error('--per-type 应为正整数');
  }
  if (options.typeId !== null && !options.typeId.trim()) {
    throw new Error('--type-id 不能为空');
  }
  if (options.calculationOnly && !options.outputDirExplicit) {
    options.outputDir = options.typeId !== null
      ? join(TYPE_OUTPUT_DIR, options.typeId)
      : options.perType === 5 ? PER_TYPE_OUTPUT_DIR : CALCULATION_OUTPUT_DIR;
  }
  return options;
}

function parseNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${flag} 需要数字参数`);
  return number;
}

function parseInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${flag} 需要正整数参数`);
  return number;
}

function printHelp() {
  console.log(`
流式筛选物理大题并生成 HTML

用法：
  node scripts/filter-physics-big-questions.js [选项]

选项：
  --input <path>          输入 JSONL，默认 Problems/id_29_records.jsonl
  --output-dir <path>     输出目录，默认 Problems/physics-big
  --min-score <number>    最低大题评分，默认 7
  --limit <number>        最多输出多少道，默认不限
  --subject-id <id>       学科编号，默认 29
  --calculation-only      剔除选择题和实验题，只保留计算型物理大题
  --per-type <number>     每个题型最多保留多少道，按评分降序选择
  --type-id <id>          只筛选指定题型 ID
  --include-answers       HTML 中展开答案和解析（默认不输出，避免报告泄题）
  -h, --help              显示帮助
`);
}

function stripTags(value) {
  return String(value ?? '')
    .replace(SCRIPT_RE, ' ')
    .replace(TAG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeQuestionHtml(value) {
  return String(value ?? '')
    .replace(SCRIPT_RE, '')
    .replace(EVENT_ATTR_RE, '');
}

function countMatches(text, regex) {
  return text.match(regex)?.length ?? 0;
}

function getSubquestionCount(text) {
  const numbers = [...text.matchAll(SUBQUESTION_RE)].map((match) => Number(match[1]));
  return numbers.length ? Math.max(...numbers) : 0;
}

function getQuestionType(record) {
  return String(record.qs_type_id ?? record.type_id ?? '');
}

function getQuestionText(record) {
  return stripTags(record.qs_stem ?? record.stem ?? record.html_text ?? '');
}

function hasChoiceOptions(html, text) {
  const optionMarkers = countMatches(text, /(?:^|[\s。；;])(?:A|B|C|D)[.．、:：]/g);
  const optionTables = countMatches(html, /class=["'][^"']*(?:qml-og|option)[^"']*["']/gi);
  return optionMarkers >= 2 || optionTables > 0;
}

function calculateFeatures(record) {
  const html = String(record.qs_stem ?? record.stem ?? record.html_text ?? '');
  const structured = String(record.formatted_json ?? '');
  const text = stripTags(`${html}\n${record.html_text ?? ''}\n${structured}`);
  const typeId = getQuestionType(record);
  const subquestions = getSubquestionCount(text);
  const numbers = countMatches(text, NUMBER_RE);
  const units = [...text.matchAll(UNIT_RE)].map((match) => match[0]);
  const hasImage = /<img\b/i.test(html);
  const hasFormulaImage = /xkw-math-img|\.svg\b/i.test(html);
  const hasTable = /<table\b/i.test(html);
  const hasExperimentWords = /实验|验证|误差|打点计时器|纸带/.test(text);
  const isExperimentQuestion =
    typeId === '2903' ||
    /实验|探究|打点计时器|纸带|实验数据|实验装置|实验步骤|测量误差/.test(text);
  const hasComplexAsk = /分别求|求范围|求出|说明理由|分析|验证/.test(text);
  const hasCalculationWords = /计算|求(?:出|得|解|值)?|多大|大小|范围|表达式|速度为|加速度为|电流为|电压为|功率为|质量为|位移为/.test(text);
  const isChoiceQuestion =
    hasChoiceOptions(html, text) ||
    /["']type["']\s*:\s*["']choice["']/.test(structured) ||
    /(?:选择题|单选题|多选题|不定项选择)/.test(text);
  const hasCalculationStructure =
    hasCalculationWords &&
    (numbers >= 3 || units.length >= 2 || subquestions >= 2);
  const length = text.length;

  let score = 0;
  const reasons = [];
  if (subquestions >= 2) {
    score += 3;
    reasons.push(`多小问(${subquestions})`);
  }
  if (subquestions >= 4) {
    score += 2;
    reasons.push('小问较多');
  }
  if (length >= 500) {
    score += 2;
    reasons.push('题干较长');
  }
  if (numbers >= 8) {
    score += 2;
    reasons.push('参数较密集');
  }
  if (hasImage) {
    score += 1;
    reasons.push('含题图');
  }
  if (hasFormulaImage) {
    score += 1;
    reasons.push('含公式');
  }
  if (hasTable) {
    score += 1;
    reasons.push('含表格');
  }
  if (hasExperimentWords) {
    score += 1;
    reasons.push('实验语义');
  }
  if (hasComplexAsk) {
    score += 1;
    reasons.push('综合求解语义');
  }
  if (hasCalculationStructure) {
    score += 2;
    reasons.push('计算求解语义');
  }
  if (PHYSICS_TYPE_IDS.has(typeId)) {
    score += 1;
    reasons.push(`综合题型${typeId}`);
  }

  return {
    score,
    reasons,
    typeId,
    textLength: length,
    numberCount: numbers,
    unitCount: units.length,
    units: [...new Set(units.map((unit) => unit.toLowerCase()))],
    subquestionCount: subquestions,
    hasImage,
    hasFormulaImage,
    hasTable,
    hasExperimentWords,
    isExperimentQuestion,
    hasComplexAsk,
    hasCalculationWords,
    hasCalculationStructure,
    isChoiceQuestion,
  };
}

function getRecordSubjectId(record) {
  return record.qs_subject_id ?? record.course_id ?? record.subject_id;
}

function getRecordKey(record) {
  return String(record._id ?? record.id ?? `${record._index ?? ''}:${record.qs_stem ?? record.stem ?? ''}`);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function percent(part, whole) {
  return whole ? `${((part / whole) * 100).toFixed(1)}%` : '0.0%';
}

function renderCard(item, index, includeAnswers) {
  const record = item.record;
  const answer = includeAnswers
    ? `<details><summary>查看答案与解析</summary><div class="answer">${safeQuestionHtml(record.qs_answer ?? record.answer ?? '')}</div><div class="explanation">${safeQuestionHtml(record.qs_explanation ?? record.explanation ?? '')}</div></details>`
    : '';
  return `
    <article class="card">
      <h2>#${index + 1} <span class="score">评分 ${item.features.score}</span></h2>
      <p class="meta">
        ID：<code>${escapeHtml(record._id ?? record.id)}</code><br>
        索引：<code>${escapeHtml(record._index)}</code>　
        题型：<code>${escapeHtml(item.features.typeId)}</code>　
        难度：<code>${escapeHtml(record.qs_diff)}</code><br>
        特征：${item.features.reasons.map((reason) => `<span class="tag">${escapeHtml(reason)}</span>`).join('')}
      </p>
      <div class="question">${safeQuestionHtml(record.qs_stem ?? record.stem ?? record.html_text ?? '')}</div>
      ${answer}
    </article>`;
}

function renderHtml(items, stats, options) {
  const cards = items.map((item, index) => renderCard(item, index, options.includeAnswers)).join('\n');
  const typeRows = Object.entries(stats.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `<tr><td>${escapeHtml(type)}</td><td>${count}</td><td>${percent(count, stats.selected)}</td></tr>`)
    .join('');
  const reasonRows = Object.entries(stats.byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `<tr><td>${escapeHtml(reason)}</td><td>${count}</td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>物理大题筛选结果</title>
<style>
body{font-family:"Microsoft YaHei",Arial,sans-serif;max-width:1180px;margin:0 auto;padding:24px;background:#f5f7fa;color:#202124;line-height:1.75}
h1,h2{line-height:1.35}.summary,.card{background:#fff;border:1px solid #dfe3e8;border-radius:10px;padding:20px;margin:18px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.metric{background:#f0f5ff;border-radius:8px;padding:12px}.metric strong{display:block;font-size:24px;color:#174ea6}
.meta{color:#596579;font-size:14px;overflow-wrap:anywhere}.score{font-size:14px;color:#174ea6;font-weight:normal}.tag{display:inline-block;background:#edf3ff;color:#174ea6;border-radius:12px;padding:1px 9px;margin:2px 4px 2px 0}
.question img,.question svg{max-width:100%;height:auto}.question table{border-collapse:collapse;max-width:100%}.question td,.question th{border:1px solid #ddd;padding:7px}
code,pre{background:#eef1f5;border-radius:4px}code{padding:2px 4px}table{border-collapse:collapse;background:#fff;margin:8px 0}th,td{border:1px solid #d8dee8;padding:7px;text-align:left}th{background:#edf1f6}
details{margin-top:14px}summary{cursor:pointer;font-weight:600}.answer,.explanation{margin-top:12px;padding:12px;background:#fff8e6;border-left:4px solid #d9a441}.muted{color:#687386}
</style>
</head>
<body>
<main>
<h1>物理大题筛选结果</h1>
<p class="muted">生成时间：${escapeHtml(new Date().toISOString())}；最低评分：${options.minScore}；按题目 ID 去重。${options.typeId ? `题型 ID：${escapeHtml(options.typeId)}。` : ''}${options.calculationOnly ? '已剔除选择题和实验题，仅保留计算型题目。' : ''}${options.perType ? `每个题型最多 ${options.perType} 道。` : ''}${options.includeAnswers ? '本报告包含答案和解析。' : '本报告默认不展示答案和解析。'}</p>
<section class="summary">
<div class="grid">
<div class="metric"><strong>${stats.selected}</strong>筛选结果</div>
<div class="metric"><strong>${stats.uniqueRecords}</strong>去重题目</div>
<div class="metric"><strong>${stats.totalRecords}</strong>符合学科记录</div>
<div class="metric"><strong>${stats.duplicates}</strong>重复记录</div>
</div>
<h2>题型分布</h2><table><thead><tr><th>题型 ID</th><th>数量</th><th>占结果</th></tr></thead><tbody>${typeRows || '<tr><td colspan="3">无</td></tr>'}</tbody></table>
<h2>命中特征</h2><table><thead><tr><th>特征</th><th>数量</th></tr></thead><tbody>${reasonRows || '<tr><td colspan="2">无</td></tr>'}</tbody></table>
</section>
${cards || '<p>没有达到最低评分的题目。</p>'}
</main>
</body>
</html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = resolve(options.input);
  await mkdir(options.outputDir, { recursive: true });

  const seen = new Set();
  const candidates = [];
  const stats = {
    totalRecords: 0,
    uniqueRecords: 0,
    duplicates: 0,
    selected: 0,
    excludedChoices: 0,
    excludedExperiments: 0,
    excludedNonCalculation: 0,
    byType: Object.create(null),
    byReason: Object.create(null),
  };
  const inputStream = createReadStream(input, { encoding: 'utf8' });
  const lines = createInterface({ input: inputStream, crlfDelay: Infinity });

  let firstLine = true;
  for await (let line of lines) {
    if (firstLine) {
      line = line.replace(/^\uFEFF/, '');
      firstLine = false;
    }
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`JSONL 解析失败（已处理 ${stats.totalRecords} 条）：${error.message}`);
    }
    if (String(getRecordSubjectId(record)) !== options.subjectId) continue;
    if (options.typeId !== null && getQuestionType(record) !== options.typeId) continue;
    stats.totalRecords += 1;
    const key = getRecordKey(record);
    if (seen.has(key)) {
      stats.duplicates += 1;
      continue;
    }
    seen.add(key);
    stats.uniqueRecords += 1;

    const features = calculateFeatures(record);
    if (options.calculationOnly && features.isChoiceQuestion) {
      stats.excludedChoices += 1;
      continue;
    }
    if (options.calculationOnly && features.isExperimentQuestion) {
      stats.excludedExperiments += 1;
      continue;
    }
    if (options.calculationOnly && !features.hasCalculationStructure) {
      stats.excludedNonCalculation += 1;
      continue;
    }
    if (features.score < options.minScore) continue;
    const item = { record, features };
    candidates.push(item);
  }

  const grouped = new Map();
  for (const item of candidates) {
    const typeItems = grouped.get(item.features.typeId) ?? [];
    typeItems.push(item);
    grouped.set(item.features.typeId, typeItems);
  }
  for (const typeItems of grouped.values()) {
    typeItems.sort((a, b) =>
      b.features.score - a.features.score ||
      b.features.subquestionCount - a.features.subquestionCount ||
      b.features.numberCount - a.features.numberCount,
    );
  }
  let selected = options.perType === null
    ? candidates
    : [...grouped.values()].flatMap((typeItems) => typeItems.slice(0, options.perType));
  selected.sort((a, b) => b.features.score - a.features.score);
  if (options.limit !== Infinity) selected = selected.slice(0, options.limit);
  stats.selected = selected.length;
  for (const { features } of selected) {
    stats.byType[features.typeId] = (stats.byType[features.typeId] ?? 0) + 1;
    for (const reason of features.reasons) {
      stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
    }
  }

  const jsonl = selected.map(({ record, features }) => JSON.stringify({
    ...record,
    _big_question_score: features.score,
    _big_question_features: features,
  })).join('\n') + (selected.length ? '\n' : '');
  const outputJsonl = join(options.outputDir, 'physics-big-questions.jsonl');
  const outputHtml = join(options.outputDir, 'physics-big-questions.html');
  const outputStats = join(options.outputDir, 'physics-big-questions.stats.json');
  await writeFile(outputJsonl, jsonl, 'utf8');
  await writeFile(outputHtml, renderHtml(selected, stats, options), 'utf8');
  await writeFile(outputStats, JSON.stringify({
    generatedAt: new Date().toISOString(),
    input: relative(ROOT, input),
    outputDir: relative(ROOT, options.outputDir),
    options,
    stats,
  }, null, 2), 'utf8');

  console.log(`已完成：${basename(input)}`);
  console.log(`符合学科记录：${stats.totalRecords}，去重后：${stats.uniqueRecords}，重复：${stats.duplicates}`);
  console.log(`筛选结果：${stats.selected}，最低评分：${options.minScore}`);
  console.log(`JSONL：${outputJsonl}`);
  console.log(`HTML：${outputHtml}`);
  console.log(`统计：${outputStats}`);
}

try {
  await main();
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
}
