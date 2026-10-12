/**
 * 测试入口：node test/run.js
 * 也支持只跑某一部分：node test/run.js guard
 */

import { run } from './runner.js';

const filter = process.argv[2];

const suites = ['text', 'guard', 'route', 'engine', 'probe', 'intake', 'analysis', 'verify', 'mathinput', 'docs', 'ui'];

process.stdout.write('\n▶ 提示引擎测试套件\n\n');

for (const name of suites) {
  if (filter && !name.includes(filter)) continue;
  try {
    await import(`./${name}.test.js`);
  } catch (err) {
    process.stdout.write(`  \x1b[31m✗\x1b[0m 加载 ${name}.test.js 失败：${err.message}\n`);
    process.exitCode = 1;
  }
}

await run();
