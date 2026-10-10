/**
 * 极简 .env 读取器（零依赖）。
 *
 * 为什么不直接用 dotenv：
 *   PoC 要交给企业/教研跑，依赖越少越好；且 Node 24 原生支持 --env-file，
 *   但为了兼容"直接 node scripts/xxx.js"的用法，这里自己读一下更省事。
 *
 * 注意：本文件只读取，不打印任何 Key 内容。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 支持的 Key 名（按优先级） */
export const SUPPORTED_KEYS = ['LLM_API_KEY', 'OPENAI_API_KEY'];
export const SUPPORTED_BASE_URLS = ['LLM_BASE_URL', 'OPENAI_BASE_URL'];
export const SUPPORTED_MODELS = ['LLM_MODEL', 'OPENAI_MODEL'];

export function loadEnvFile(filePath = resolve(ROOT, '.env')) {
  if (!existsSync(filePath)) return { loaded: false, path: filePath };
  const content = readFileSync(filePath, 'utf8');
  let count = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去掉成对引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
      count += 1;
    }
  }
  return { loaded: true, path: filePath, count };
}

/** 脱敏显示，用于启动日志（永不打印完整 Key） */
export function maskSecret(secret) {
  if (!secret) return '(未设置)';
  if (secret.length <= 10) return `${secret.slice(0, 2)}****`;
  return `${secret.slice(0, 6)}…${secret.slice(-4)}（共 ${secret.length} 位）`;
}

export { ROOT };
