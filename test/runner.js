/**
 * 极简测试运行器。
 * 不引第三方框架的理由：这个 PoC 会被交到教研/企业手里，
 * "clone 下来 node 就能跑"比"先 npm install 300 个包"重要。
 */

const tests = [];
let currentSuite = '';

export function describe(name, fn) {
  currentSuite = name;
  fn();
  currentSuite = '';
}

export function it(name, fn) {
  tests.push({ suite: currentSuite, name, fn });
}

export async function run() {
  let passed = 0;
  const failures = [];
  const started = Date.now();

  for (const t of tests) {
    const label = `${t.suite} › ${t.name}`;
    try {
      await t.fn();
      passed += 1;
      process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`);
    } catch (err) {
      failures.push({ label, err });
      process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}\n      ${err.message}\n`);
    }
  }

  const ms = Date.now() - started;
  process.stdout.write(`\n${passed}/${tests.length} 通过（${ms} ms）\n`);
  if (failures.length) {
    process.stdout.write(`\n失败详情：\n`);
    for (const f of failures) {
      process.stdout.write(`\n▸ ${f.label}\n${f.err.stack ?? f.err.message}\n`);
    }
    process.exitCode = 1;
  }
  return failures.length === 0;
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

export function assert(cond, msg = '断言失败') {
  if (!cond) throw new Error(msg);
}

export function assertEquals(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  }
}

export function assertIncludes(haystack, needle, msg = '') {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${msg}\n  期望包含: ${needle}\n  实际: ${String(haystack).slice(0, 400)}`);
  }
}

export function assertNotIncludes(haystack, needle, msg = '') {
  if (String(haystack).includes(needle)) {
    throw new Error(`${msg}\n  期望不包含: ${needle}\n  实际: ${String(haystack).slice(0, 400)}`);
  }
}

export function assertThrows(fn, msg = '期望抛错') {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(msg);
}
