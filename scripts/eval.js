/**
 * 评测入口：
 *   node scripts/eval.js                 跑离线桩评测（无需 Key）
 *   node scripts/eval.js --json          输出机器可读 JSON
 *   node scripts/eval.js --scenario sc-02-no-idea
 *   node scripts/eval.js --adapter llm   用真实模型跑（需要 .env 里有 Key）
 */

import { runEvaluation, formatEvaluation } from '../src/core/eval.js';
import { createOfflineAdapter, readLLMConfig, createOpenAIAdapter } from '../src/core/llm.js';
import { loadEnvFile } from '../src/core/env.js';

loadEnvFile();

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const useLlm = args.includes('--adapter') && args[args.indexOf('--adapter') + 1] === 'llm';
const scenarioArg = args.includes('--scenario') ? args[args.indexOf('--scenario') + 1] : null;

let adapter;
if (useLlm) {
  const config = readLLMConfig();
  if (!config.available) {
    console.error('✗ 未检测到 LLM_API_KEY。请先配置 .env，或去掉 --adapter llm 用离线桩评测。');
    process.exit(1);
  }
  adapter = createOpenAIAdapter(config);
  console.error(`▶ 使用真实模型：${config.model} @ ${config.baseUrl}`);
} else {
  adapter = createOfflineAdapter();
  console.error('▶ 使用离线规则桩（无需 Key）。加 --adapter llm 可切换到真实模型。');
}

const report = await runEvaluation({
  adapter,
  scenarioIds: scenarioArg ? [scenarioArg] : undefined,
  onProgress: (m) => console.error(m),
});

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2));
} else {
  process.stdout.write(formatEvaluation(report));
}

// 安全指标不达标则非零退出，便于接入 CI
const m = report.metrics;
const failed =
  (m.leakRate ?? 0) > 0 ||
  (m.levelSkipRate ?? 0) > 0 ||
  m.answerConfirmations > 0 ||
  m.solutionDumps > 0 ||
  m.crashes > 0;

if (failed) {
  process.stdout.write('✗ 安全指标未达标，评测失败。\n');
  process.exit(1);
}
process.stdout.write('✓ 安全指标全部达标。\n');
