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
import { loadEnvFile } from '../src/core/env.js';
import { readLLMConfig } from '../src/core/llm.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INPUT = join(ROOT, 'Problems', 'id_29_records.jsonl');
const DEFAULT_OUTPUT_DIR = join(ROOT, 'Problems', 'physics-big');
const CALCULATION_OUTPUT_DIR = join(ROOT, 'Problems', 'physics-calculation');
const PER_TYPE_OUTPUT_DIR = join(ROOT, 'Problems', 'physics-calculation-5-per-type');
const TYPE_OUTPUT_DIR = join(ROOT, 'Problems', 'physics-type');

const UNIT_RE = /(?:kg|mg|kN|N|km\/h|m\/s(?:\^?2)?|mA|kV|V|A|cm|mm|m|Ω|ohm|J|W|Hz|T|Pa|C|F|H|°|℃|%)/gi;
const NUMBER_RE = /[-+]?\d+(?:\.\d+)?(?:\/\d+)?/g;
const SUBQUESTION_RE = /[（(]\s*([1-9]\d*)\s*[）)]/g;
const TAG_RE = /<[^>]*>/g;
const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const EVENT_ATTR_RE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const CALCULATION_TARGET_RE = /(?:求|计算|算出|算得|求出|求得|求解|求(?:其|该)?(?:大小|范围|最小值|最大值|质量|速度|加速度|位移|时间|电流|电压|电阻|功率|能量|动量|冲量|拉力|压力|摩擦力|支持力|张力|电势|电场强度|磁感应强度))/;
const NUMERIC_RESULT_RE = /(?:多少|多大|范围|最小值|最大值|表达式|数值|结果|分别为|大小为|等于|取值)/;
const PHYSICAL_QUANTITY_RE = /(?:质量|重力|速度|速率|加速度|位移|路程|时间|力|拉力|压力|摩擦力|支持力|张力|功|功率|能量|动量|冲量|电流|电压|电阻|电功率|电势|电场|磁场|磁感应|电动势|电荷|电容|频率|角速度|半径|高度|距离|密度)/;
const NUMERIC_UNIT_RE = /(?:\d+(?:\.\d+)?\s*(?:kg|mg|g|t|N|kN|m\/s(?:\^?2)?|km\/h|m|cm|mm|A|mA|V|kV|Ω|ohm|J|W|Hz|T|Pa|C|F|H|°|℃|%))/i;
const DERIVATION_RE = /(?:由|根据|可得|解得|代入|联立|由此|因此|所以).{0,80}(?:=|得|可得|解得)/;

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
    index: null,
    outputDirExplicit: false,
    ai: false,
    aiLimit: 100,
    aiThreshold: 70,
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
    else if (arg === '--index') options.index = String(next);
    else if (arg === '--ai') options.ai = true;
    else if (arg === '--ai-limit') options.aiLimit = parseInteger(next, '--ai-limit');
    else if (arg === '--ai-threshold') options.aiThreshold = parseNumber(next, '--ai-threshold');
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
    else throw new Error(`无法识别的参数：${arg}`);
    const consumesValue = !['--help', '-h', '--include-answers', '--calculation-only', '--ai'].includes(arg);
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
  if (options.aiLimit < 1) throw new Error('--ai-limit 应为正整数');
  if (options.aiThreshold < 0 || options.aiThreshold > 100) {
    throw new Error('--ai-threshold 应在 0 到 100 之间');
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

function extractJson(value) {
  const text = String(value ?? '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function classifyWithAI(item, config) {
  const record = item.record;
  const stem = stripTags(record.qs_stem ?? record.stem ?? record.html_text ?? '').slice(0, 12000);
  const prompt = `请只判断这道题是否是“物理计算大题”，不要解题，不要输出答案。

判定标准：
1. isCalculation=true：需要根据题目条件建立物理关系并计算一个或多个物理量、范围或表达式；
2. isCalculation=false：选择题、判断题、纯知识问答、只填概念、只填实验步骤/误差、只读图识别；
3. 实验题即使包含速度/加速度计算，只要核心是实验操作、实验数据处理或误差分析，isExperiment=true；
4. 只返回 JSON，不要 markdown：
{"isCalculation":true,"isExperiment":false,"isChoice":false,"confidence":0-100,"score":0-100,"reason":"不超过40字"}

题型ID：${getQuestionType(record)}
题干：
${stem}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 180,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你是严格的高中物理题型审核员。只做分类，不解题。' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`AI 请求失败 ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const data = await response.json();
    const result = extractJson(data?.choices?.[0]?.message?.content);
    if (!result || typeof result.isCalculation !== 'boolean') {
      throw new Error('AI 返回格式无效，缺少 isCalculation');
    }
    return {
      isCalculation: result.isCalculation,
      isExperiment: Boolean(result.isExperiment),
      isChoice: Boolean(result.isChoice),
      confidence: Number(result.confidence) || 0,
      score: Number(result.score) || 0,
      reason: String(result.reason ?? '').slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
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
  --index <name>          只筛选指定来源索引
  --ai                    使用 OpenAI 兼容模型复核计算题
  --ai-limit <number>     最多送入模型复核的候选数，默认 100
  --ai-threshold <num>   AI 计算题置信度阈值，默认 70
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

function getQuestionTypeName(record) {
  return String(record.type?.name ?? record.type_name ?? '').trim();
}

function getQuestionText(record) {
  return stripTags(record.qs_stem ?? record.stem ?? record.html_text ?? '');
}

function hasChoiceOptions(html, text) {
  const optionMarkers = countMatches(text, /(?:^|[\s。；;])(?:A|B|C|D)[.．、:：]/g);
  const optionTables = countMatches(html, /class=["'][^"']*(?:qml-og|option)[^"']*["']/gi);
  return optionMarkers >= 2 || optionTables > 0;
}

function getStructuredFormat(record) {
  const value = String(record.formatted_json ?? '');
  return {
    isChoice: /['"]type['"]\s*:\s*['"]choice['"]/.test(value) || /(?:选择题|单选题|多选题|不定项选择)/.test(value),
    hasBlank: /['"]type['"]\s*:\s*['"]blank['"]/.test(value),
    hasNumericInput: /(?:数值|number|numeric|formula|expression)/i.test(value),
    hasOptions: /['"]options['"]\s*:/.test(value),
  };
}

function calculateFeatures(record) {
  const html = String(record.qs_stem ?? record.stem ?? record.html_text ?? '');
  const structured = String(record.formatted_json ?? '');
  const answerText = stripTags(record.qs_answer ?? record.answer_text ?? record.answer ?? '');
  const explanationText = stripTags(record.qs_explanation ?? record.explanation_text ?? record.explanation ?? '');
  const text = stripTags(`${html}\n${record.html_text ?? ''}\n${structured}`);
  const typeId = getQuestionType(record);
  const typeName = getQuestionTypeName(record);
  const format = getStructuredFormat(record);
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
  const hasCalculationTarget = CALCULATION_TARGET_RE.test(text);
  const hasNumericResult = NUMERIC_RESULT_RE.test(text);
  const hasPhysicalQuantity = PHYSICAL_QUANTITY_RE.test(text);
  const hasNumericUnit = NUMERIC_UNIT_RE.test(text);
  const hasDerivation = DERIVATION_RE.test(`${answerText} ${explanationText}`);
  const hasCalculationWords = hasCalculationTarget || hasNumericResult;
  const isChoiceQuestion =
    hasChoiceOptions(html, text) ||
    format.isChoice;
  const isObjectiveQuestion =
    /选择题|单选题|多选题|不定项选择|填空题|知识点填空题|判断题|作图题/.test(typeName) ||
    new Set(['1', '2901', '2902', '2905', '2906', '2907', '2908']).has(typeId);
  const hasCalculationStructure =
    !isChoiceQuestion &&
    !isExperimentQuestion &&
    hasCalculationTarget &&
    hasPhysicalQuantity &&
    (hasNumericUnit || numbers >= 3 || subquestions >= 2 || hasDerivation);
  const isObjectiveBlank =
    !isChoiceQuestion &&
    format.hasBlank &&
    !format.hasNumericInput &&
    !hasCalculationTarget &&
    !hasDerivation;
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

  return {
    score,
    reasons,
    typeId,
    typeName,
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
    hasCalculationTarget,
    hasNumericResult,
    hasPhysicalQuantity,
    hasNumericUnit,
    hasDerivation,
    hasCalculationStructure,
    isObjectiveBlank,
    structuredFormat: format,
    isChoiceQuestion,
    isObjectiveQuestion,
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
  const aiTag = item.ai
    ? `<span class="tag">AI评分 ${item.ai.score}</span><span class="tag">${escapeHtml(item.ai.reason)}</span>`
    : '';
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
        特征：${item.features.reasons.map((reason) => `<span class="tag">${escapeHtml(reason)}</span>`).join('')}${aiTag}
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
<p class="muted">生成时间：${escapeHtml(new Date().toISOString())}；最低评分：${options.minScore}；按题目 ID 去重。${options.index ? `来源索引：${escapeHtml(options.index)}。` : ''}${options.typeId ? `题型 ID：${escapeHtml(options.typeId)}。` : ''}${options.calculationOnly ? '已剔除选择题和实验题，仅保留计算型题目。' : ''}${options.ai ? `已使用 AI 复核（候选上限 ${options.aiLimit}，阈值 ${options.aiThreshold}）。` : ''}${options.perType ? `每个题型最多 ${options.perType} 道。` : ''}${options.includeAnswers ? '本报告包含答案和解析。' : '本报告默认不展示答案和解析。'}</p>
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
    aiReviewed: 0,
    aiRejected: 0,
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
    if (options.index !== null && String(record._index ?? record.index ?? '') !== options.index) continue;
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
    if (options.calculationOnly && (features.isChoiceQuestion || features.isObjectiveQuestion)) {
      stats.excludedChoices += 1;
      continue;
    }
    if (options.calculationOnly && features.isExperimentQuestion) {
      stats.excludedExperiments += 1;
      continue;
    }
    if (options.calculationOnly && features.isObjectiveBlank) {
      stats.excludedNonCalculation += 1;
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

  if (options.ai) {
    loadEnvFile();
    const config = readLLMConfig();
    if (!config.available) {
      throw new Error('--ai 需要配置 LLM_API_KEY 或 OPENAI_API_KEY');
    }
    const aiCandidates = candidates
      .sort((a, b) =>
        b.features.score - a.features.score ||
        b.features.subquestionCount - a.features.subquestionCount ||
        b.features.numberCount - a.features.numberCount,
      )
      .slice(0, options.aiLimit);
    for (const item of aiCandidates) {
      item.ai = await classifyWithAI(item, config);
      stats.aiReviewed += 1;
      if (
        !item.ai.isCalculation ||
        item.ai.isExperiment ||
        item.ai.isChoice ||
        item.ai.confidence < options.aiThreshold
      ) {
        stats.aiRejected += 1;
      }
    }
    candidates.splice(0, candidates.length, ...aiCandidates.filter((item) =>
      item.ai.isCalculation &&
      !item.ai.isExperiment &&
      !item.ai.isChoice &&
      item.ai.confidence >= options.aiThreshold,
    ));
  }
  const grouped = new Map();
  for (const item of candidates) {
    const typeItems = grouped.get(item.features.typeId) ?? [];
    typeItems.push(item);
    grouped.set(item.features.typeId, typeItems);
  }
  for (const typeItems of grouped.values()) {
    typeItems.sort((a, b) =>
      (b.ai?.score ?? b.features.score) - (a.ai?.score ?? a.features.score) ||
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

  const jsonl = selected.map(({ record, features, ai }) => JSON.stringify({
    ...record,
    _big_question_score: features.score,
    _big_question_features: features,
    ...(ai ? { _ai_review: ai } : {}),
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
