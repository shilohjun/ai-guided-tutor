/**
 * 把 `languages/` 里的教研文稿编译成 `src/core/personas.data.js`。
 *
 * 为什么要有这一步：
 *   教学的「说什么、什么时候说、说多少」和四位老师的「怎么说」由教研维护在
 *   `languages/*.md` 里，而模型每轮都要把这几份文稿当系统提示的一部分读进去。
 *   如果运行时直接 readFile，`scripts/build-cloudbase.mjs` 只复制 `src/`，
 *   腾讯云函数上这些 md 根本不存在 —— 表现是提示词悄悄变成空字符串，
 *   而不是报错。所以这里在**构建期**把文稿编译成一个普通的 ESM 模块，
 *   跟源码一起走所有部署形态。
 *
 * 用法：
 *   node scripts/build-persona-docs.mjs           生成（覆盖 personas.data.js）
 *   node scripts/build-persona-docs.mjs --check   只检查是否与 md 同步（CI 用）
 *
 * `languages/` 目前不在版本控制里（见 .gitignore）。生成物是照常提交的，
 * 所以没有这个目录的环境（别人 clone、Vercel 构建）依然能跑；
 * --check 在没有该目录时只提示、不判失败。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'languages');
const OUT = join(ROOT, 'src', 'core', 'personas.data.js');

/** 共享文稿：文件名前缀 → 导出名。前缀对不上就报错，不静默跳过。 */
const SHARED = [
  ['00_', 'PERSONA_SHARED_DOC', '核心人格与沟通基调'],
  ['10_', 'PERSONA_PHYSICS_DOC', '物理学科准确性规范'],
  ['20_', 'PERSONA_LIMITS_DOC', '交互规则与字数控场'],
  ['30_', 'PERSONA_SCAFFOLDING_DOC', '辅导工作流与保密协议'],
];

/** 四位老师：顺序即前端展示顺序。 */
const VOICES = [
  ['paimon', '01_', '派蒙'],
  ['hermione', '02_', '赫敏'],
  ['zhuge', '03_', '诸葛亮'],
  ['jianhua', '04_', '建华教授'],
];

/**
 * 把 md 原文变成可以放进模板字符串的片段。
 * 只处理模板字符串会吃掉的三样：反斜杠、反引号、`${`。
 */
function toTemplateLiteral(text) {
  return text
    .replace(/\r\n/g, '\n')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function findFile(prefix) {
  const hits = readdirSync(SRC_DIR).filter((f) => f.startsWith(prefix) && f.endsWith('.md'));
  if (hits.length !== 1) {
    throw new Error(
      `languages/ 里以 ${prefix} 开头的 md 应当恰好 1 个，实际 ${hits.length} 个：${hits.join(', ') || '（无）'}`,
    );
  }
  return hits[0];
}

function render() {
  const parts = [];
  parts.push(`/**
 * 老师人格与教学规范原文 —— **由 scripts/build-persona-docs.mjs 生成，不要手改**。
 *
 * 真相在 languages/*.md（教研维护）。改了文稿就重跑：
 *   node scripts/build-persona-docs.mjs
 * 忘了跑会被 npm test 里的 personas 用例和 prompts:check 一起抓住。
 *
 * 为什么原文整段收进代码而不是运行时读文件：
 *   部署形态（Vercel / 腾讯云 CloudBase / 单机）并不保证 languages/ 会被打包，
 *   而这几份文稿必须和提示词一起进模型 —— 缺了就会静默变成空字符串。
 *
 * 只允许「怎么说」与教研规范进入提示词；不泄题的硬边界仍在 src/core/llm.js
 * 与 src/core/guard.js。两份冲突时以产品硬边界为准。
 */`);

  for (const [prefix, name, title] of SHARED) {
    const file = findFile(prefix);
    const body = toTemplateLiteral(readFileSync(join(SRC_DIR, file), 'utf8'));
    parts.push(`/** ${title}（languages/${file}） */\nexport const ${name} = \`${body}\`;`);
  }

  const voiceLines = [];
  for (const [id, prefix, label] of VOICES) {
    const file = findFile(prefix);
    const body = toTemplateLiteral(readFileSync(join(SRC_DIR, file), 'utf8'));
    voiceLines.push(`  /** ${label}（languages/${file}） */\n  ${id}: \`${body}\`,`);
  }
  parts.push(`/** 四位老师的语言风格原文，键与 personas.js 的 id 一一对应。 */\nexport const PERSONA_VOICE_DOCS = {\n${voiceLines.join('\n')}\n};`);

  return parts.join('\n\n') + '\n';
}

if (!existsSync(SRC_DIR)) {
  const msg = 'languages/ 不存在（该目录未纳入版本控制），跳过人格文稿生成。';
  if (process.argv.includes('--check')) {
    process.stdout.write(`  \x1b[33m!\x1b[0m ${msg}\n`);
    process.exit(0);
  }
  process.stdout.write(`${msg}\n`);
  process.exit(0);
}

const content = render();

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== content) {
    process.stderr.write(
      '  \x1b[31m✗\x1b[0m src/core/personas.data.js 与 languages/*.md 不同步，请运行 node scripts/build-persona-docs.mjs\n',
    );
    process.exit(1);
  }
  process.stdout.write('  \x1b[32m✓\x1b[0m 人格文稿与 languages/*.md 同步\n');
  process.exit(0);
}

writeFileSync(OUT, content);
process.stdout.write(`  \x1b[32m✓\x1b[0m 已生成 src/core/personas.data.js（${content.length} 字符）\n`);
