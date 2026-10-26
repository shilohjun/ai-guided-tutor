import { readFile, writeFile } from 'node:fs/promises';
import { OBSERVE_SYSTEM_PROMPT, DRAFT_SYSTEM_PROMPT, INTAKE_SYSTEM_PROMPT } from '../src/core/llm.js';

const target = new URL('../docs/02-prompt-spec.md', import.meta.url);
const content = `# Prompt 规范（2026-10-25）

此文件由运行时提示词自动导出。修改唯一来源 src/core/llm.js 后运行 npm run prompts:export；npm run prompts:check 可检查同步情况。
不再同时维护多份互相冲突的提示词。改动说明见 [回答规范升级](07-prompt-upgrade.md)，协作说明见 [分支使用](08-branch-workflow.md)。

## 统一约定

- 学生可见回复尽量60–100字，硬上限150字；标签、标点、公式、空格计入，换行不计。澄清和故障兜底允许更短，不凑字数。
- 通常“提示：方向或局部解释”与“试一试：一个任务”两行；公式可单独占第三行。
- L1给方向与必要的通用知识；L2增加关系、条件或变量含义；L3只解析当前一步。L0仅澄清缺失信息。
- 题目最终结果与整题推导不可输出；题目既有禁区仍优先生效。通用公式不能被笼统当成泄题。
- observe记录原话证据；route决定层级；draft写回复；guard检查完整可见消息；代码规则不能证明物理语义正确。
- 不截断到150字，不删除公式后拼接残句。失败时完整再生成一次，之后使用通过检查的兜底并标记fallback，不用兜底轮支撑提示升级。
- 自主训练只在学生主动求助时提示。新步骤、新路径、新卡点重新从L1开始，历史保留。简短追问沿用原卡点。
- 模型观察故障返回可重试的系统错误，不记为学生未形成思路，也不写入会话学习记录。

## OBSERVE：内部观察

\`\`\`text
${OBSERVE_SYSTEM_PROMPT}
\`\`\`

## DRAFT：学生提示

以下范例是本次编写的格式与递进示意，尚需物理老师审核，不能当作真实学生效果证据。

\`\`\`text
${DRAFT_SYSTEM_PROMPT}
\`\`\`

## INTAKE：读题建档

\`\`\`text
${INTAKE_SYSTEM_PROMPT}
\`\`\`

## 变更记录

2026-10-25：统一字数与显示结构，移除强制可见复述；允许受约束的通用公式提醒；加入三级递进正例和反例；draft携带历史与本轮原话；严格核对证据完整子串；出口检查包含nextAsk；按卡点隔离升级历史；系统故障不归因学生。
`;
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')).replace(/\r\n/g, '\n') !== content) throw new Error('提示词文档与运行时代码不同，请运行 npm run prompts:export');
  console.log('提示词文档与代码一致');
} else {
  await writeFile(target, content, 'utf8');
  console.log('已从运行时源码导出 docs/02-prompt-spec.md');
}
