#!/usr/bin/env node
/**
 * 安全地写入 / 更新 .env 里的配置项。
 *
 * 为什么需要它：`cp .env.example .env` 是**不可逆**的 —— 目标文件已存在时
 * 会被整体截断重写，里面所有已填的 Key、口令一次全丢，且 .env 不入 git、
 * 不进回收站，事后无从恢复。这类操作不该靠"记得别手滑"来防。
 *
 * 用法：
 *   node scripts/set-env.js LLM_API_KEY=sk-xxxx LLM_VISION_MODEL=qwen-vl-max
 *   node scripts/set-env.js --show                 # 只看当前配置（值打码）
 *   node scripts/set-env.js --unset ALIYUN_OCR_APPCODE
 *
 * 行为约定：
 *   - .env 存在时**只改点名的键**，逐行原位替换；其余注释、空行、顺序一概不动
 *   - .env 不存在时，先以 .env.example 为底再写入（等价于首次初始化）
 *   - 点名但文件里没有的键 → 追加到末尾
 *   - 值里含空格或 # 时不加引号会读错，此时直接拒绝并提示
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const TEMPLATE_PATH = join(ROOT, '.env.example');

/** 密钥类字段：只回显长度和首尾几位，避免把凭据打到终端或被截图带走 */
const SECRET_KEYS = /(KEY|APPCODE|SECRET|TOKEN|PASSWORD|口令)/i;

function mask(key, value) {
  if (!value) return '(空)';
  if (!SECRET_KEYS.test(key)) return value;
  if (value.length <= 8) return `***（${value.length} 位）`;
  return `${value.slice(0, 4)}…${value.slice(-3)}（${value.length} 位）`;
}

function readEnvText() {
  if (existsSync(ENV_PATH)) {
    return { text: readFileSync(ENV_PATH, 'utf8'), created: false };
  }
  if (!existsSync(TEMPLATE_PATH)) {
    throw new Error('找不到 .env 与 .env.example —— 请确认在 UI/ 目录下运行');
  }
  return { text: readFileSync(TEMPLATE_PATH, 'utf8'), created: true };
}

function getValue(text, key) {
  // 只吃行内空白：\s 会跨过换行，把下一行误当成当前键的值
  const m = text.match(new RegExp(`^${key}[ \\t]*=[ \\t]*([^\\r\\n]*)$`, 'm'));
  return m ? m[1].trim() : null;
}

/** 原位替换；键不存在则追加。返回新的全文 */
function setValue(text, key, value) {
  const re = new RegExp(`^(${key}[ \\t]*=[ \\t]*)[^\\r\\n]*$`, 'm');
  if (re.test(text)) return text.replace(re, `$1${value}`);
  const tail = text.endsWith('\n') ? '' : '\n';
  return `${text}${tail}${key}=${value}\n`;
}

function unsetValue(text, key) {
  const re = new RegExp(`^(${key}[ \\t]*=[ \\t]*)[^\\r\\n]*$`, 'm');
  return re.test(text) ? text.replace(re, '$1') : text;
}

function show(text) {
  const keys = [...text.matchAll(/^([A-Z][A-Z0-9_]*)[ \t]*=/gm)].map((m) => m[1]);
  const width = Math.max(...keys.map((k) => k.length), 0);
  for (const k of keys) console.log(`  ${k.padEnd(width)}  ${mask(k, getValue(text, k) ?? '')}`);
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  fail('没有要写入的项。用法：node scripts/set-env.js LLM_API_KEY=sk-xxxx');
}

const { text: original, created } = readEnvText();
let text = original;
let changed = 0;

if (argv[0] === '--show') {
  console.log(`\n.env ${created ? '不存在（下面是模板）' : '当前配置'}：\n`);
  show(text);
  process.exit(0);
}

const unsetMode = argv[0] === '--unset';
const args = unsetMode ? argv.slice(1) : argv;

for (const raw of args) {
  if (unsetMode) {
    // --unset KEY 或 --unset KEY=whatever
    const key = raw.split('=')[0].trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail(`键名不合法：${raw}`);
    text = unsetValue(text, key);
    console.log(`  - ${key} 已清空`);
    changed += 1;
    continue;
  }

  const eq = raw.indexOf('=');
  if (eq < 1) fail(`参数格式应为 KEY=VALUE，收到：${raw}`);
  const key = raw.slice(0, eq).trim();
  const value = raw.slice(eq + 1).trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail(`键名不合法：${key}（要求全大写字母数字下划线）`);
  if (!value) fail(`${key} 的值为空。要清空请用 --unset ${key}`);
  if (/[\s#]/.test(value)) {
    fail(`${key} 的值里有空格或 #，直接写入会被读成截断值。请去掉空格，或手动编辑 .env 并加引号`);
  }

  text = setValue(text, key, value);
  console.log(`  + ${key} = ${mask(key, value)}`);
  changed += 1;
}

if (!changed) fail('没有任何改动');

writeFileSync(ENV_PATH, text, 'utf8');

console.log(
  `\n✓ 已写入 ${ENV_PATH}${created ? '（首次创建，其余项取自 .env.example）' : '（只改了上面这几项，其余内容未动）'}`,
);
console.log('  重启服务后生效：npm start');
