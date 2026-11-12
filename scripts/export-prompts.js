import { readFile, writeFile } from 'node:fs/promises';
import { OBSERVE_SYSTEM_PROMPT, DRAFT_SYSTEM_PROMPT, INTAKE_SYSTEM_PROMPT } from '../src/core/llm.js';

const target = new URL('../docs/02-prompt-spec.md', import.meta.url);
const content = `# Prompt 规范（2026-11-05）

此文件由运行时提示词自动导出。修改唯一来源 src/core/llm.js 后运行 npm run prompts:export；npm run prompts:check 可检查同步情况。
不再同时维护多份互相冲突的提示词。改动说明见 [回答规范升级](07-prompt-upgrade.md)，协作说明见 [分支使用](08-branch-workflow.md)。

## 提示词分两层

| 层 | 位置 | 管什么 |
|---|---|---|
| 硬边界 + 输出格式 | \`src/core/llm.js\`（本文档导出） | 不泄题、不编造、JSON 契约、字数与层级映射 |
| 教学规范 + 老师风格 | \`languages/*.md\` → \`src/core/personas.data.js\` → \`personaPromptBlock\` | 说什么、什么时候说、说多少、用什么口气 |

这么切的原因：教学口径由教研维护、会独立改版；写死在提示词里就一定会和文稿打架。
改教学口径只改 \`languages/*.md\` 再跑 \`node scripts/build-persona-docs.mjs\`，不必碰代码。
四份规范是 \`00\`（人格与基调）、\`20\`（交互与字数）、\`30\`（保密与工作流）、\`10\`（物理准确性）；
四位老师的语言风格是 \`01\`–\`04\`。每轮只注入当前这一位老师的那一份。

## 统一约定

- 学生可见回复尽量60–100字，硬上限150字；标签、标点、公式、空格计入，换行不计。澄清和故障兜底允许更短，不凑字数。
- 回复只说一件事：给方向、补课或排障；肯定之后留白，不派活。
- L1给方向与必要的通用知识；L2补关系、条件或变量含义；L3只解析当前一步。L0仅澄清缺失信息。
- nextAsk 只用于探进度或澄清，没有要问的就留 null；"不要指派动作"同样约束 nextAsk。
- 题目最终结果与整题推导不可输出；题目既有禁区仍优先生效。通用公式不能被笼统当成泄题。
- observe记录原话证据；route决定层级；draft写回复；guard检查完整可见消息；代码规则不能证明物理语义正确。
- 不截断到150字，不删除公式后拼接残句。失败时完整再生成一次，之后使用通过检查的兜底并标记fallback，不用兜底轮支撑提示升级。
- 自主训练只把"学生正在自己写"当成不打断的理由（"我先算""我试试"、单纯应声）；他在作答时要接住并核验。新步骤、新路径、新卡点重新从L1开始，历史保留。
- 模型观察故障返回可重试的系统错误，不记为学生未形成思路，也不写入会话学习记录。

## OBSERVE：内部观察

\`\`\`text
${OBSERVE_SYSTEM_PROMPT}
\`\`\`

## DRAFT：学生提示

DRAFT 只写硬边界与输出格式。教学行为与老师风格由 \`personaPromptBlock\` 接在它后面
（见本文档开头那张表），不在这里重复。

以下范例是本次编写的格式示意，尚需物理老师审核，不能当作真实学生效果证据。

\`\`\`text
${DRAFT_SYSTEM_PROMPT}
\`\`\`

## INTAKE：读题建档

\`\`\`text
${INTAKE_SYSTEM_PROMPT}
\`\`\`

## 变更记录

2026-11-05：提示词拆成两层 —— DRAFT 只留硬边界与输出格式，教学规范与四位老师的语言风格移入 \`languages/*.md\`（构建期编译成 \`personas.data.js\`）；nextAsk 从"必须给一个动作"收窄为"只在探进度或澄清时给"；自主训练不再把"学生作答"当静默理由。
2026-10-25：统一字数与显示结构，移除强制可见复述；允许受约束的通用公式提醒；加入三级递进正例和反例；draft携带历史与本轮原话；严格核对证据完整子串；出口检查包含nextAsk；按卡点隔离升级历史；系统故障不归因学生。
`;
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')).replace(/\r\n/g, '\n') !== content) throw new Error('提示词文档与运行时代码不同，请运行 npm run prompts:export');
  console.log('提示词文档与代码一致');
} else {
  await writeFile(target, content, 'utf8');
  console.log('已从运行时源码导出 docs/02-prompt-spec.md');
}
