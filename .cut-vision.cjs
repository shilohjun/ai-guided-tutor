/**
 * 一次性脚本：从 src/core/ocr.js 里移除"视觉模型通道"的契约块。
 * 只做这一处；其余改动（配置分支、提示文案、调用函数）用编辑工具逐段做，
 * 便于逐条核对。执行后脚本自身即删除。
 */
const fs = require('fs');

const FILE = 'src/core/ocr.js';
const lines = fs.readFileSync(FILE, 'utf8').split('\n');

// 锚点 1：契约块开头的文档注释
const start = lines.findIndex((l) => l.includes('视觉模型（OpenAI 兼容多模态）'));
if (start < 0) throw new Error('没找到视觉通道注释头');
const hasDocStart = (lines[start - 1] || '').trim() === '/**';
const removeFrom = hasDocStart ? start - 1 : start;

// 锚点 2：对象体到 `  },`
const open = lines.findIndex((l, i) => i > start && /^\s{2}vision:\s*\{/.test(l));
if (open < 0) throw new Error('没找到 vision 契约对象');
let close = -1;
for (let i = open + 1; i < lines.length; i += 1) {
  if (/^\s{2}\},?\s*$/.test(lines[i])) { close = i; break; }
}
if (close < 0) throw new Error('没找到 vision 对象结尾');

// 连同后面的一个空行一起删，避免留下两个连续空行
let removeTo = close;
if ((lines[removeTo + 1] || '').trim() === '') removeTo += 1;

console.log('删除行区间 ' + (removeFrom + 1) + '-' + (removeTo + 1) + '（共 ' + (removeTo - removeFrom + 1) + ' 行）');
console.log('首行: ' + lines[removeFrom]);
console.log('末行: ' + lines[removeTo]);
console.log('删除后紧跟: ' + lines[removeTo + 1]);

lines.splice(removeFrom, removeTo - removeFrom + 1);
fs.writeFileSync(FILE, lines.join('\n'), 'utf8');
console.log('已写入 ' + FILE);
