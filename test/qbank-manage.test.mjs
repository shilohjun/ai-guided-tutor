import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts/qbank-import/manage.mjs');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

test('qbank manager can preview add and delete without changing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qbank-manage-'));
  const file = join(dir, 'question.json');
  writeFileSync(file, JSON.stringify({
    code: 'TEST-001',
    ty: '计算',
    d: '中',
    p: '测试',
    stemText: '测试题干',
    stemHtml: '<p>测试题干</p>',
    options: [],
    answerText: '答案',
    analysisText: '解析',
    knowledgeIds: ['k5'],
    methodIds: ['t3a'],
  }), 'utf8');

  const add = run(['add', '--file', file, '--dry-run']);
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /dry-run.*841|将添加题目 841/);

  const remove = run(['delete', '--id', '836', '--dry-run']);
  assert.equal(remove.status, 0, remove.stderr);
  assert.match(remove.stdout, /将删除题目 836/);
  rmSync(dir, { recursive: true, force: true });
});

test('qbank manager template contains the required editing fields', () => {
  const out = run(['template']);
  assert.equal(out.status, 0, out.stderr);
  const template = JSON.parse(out.stdout);
  for (const field of ['stemText', 'stemHtml', 'options', 'answerText', 'analysisText', 'knowledgeIds', 'methodIds']) {
    assert.ok(field in template, field);
  }
});
