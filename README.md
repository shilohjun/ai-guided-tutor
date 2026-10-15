# AI 重难题引导助手

> 让学生先交出自己的思路，AI 看懂他卡在哪一步，然后**只给提示、不给答案**。

面向中学生重难题的引导式解题助手。它不回答"这道题怎么做"，而是先读懂学生已经想到哪一步，
再给出一句恰好够用的提示，逼学生自己往下走一步。

[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![依赖](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![测试](https://img.shields.io/badge/tests-273%20passing-brightgreen)](test/run.js)
[![许可](https://img.shields.io/badge/license-UNLICENSED-lightgrey)](LICENSE)

仓库地址：<https://github.com/shilohjun/ai-guided-tutor>

<p align="center">
  <img src="docs/screenshots/01-start.png" width="49%" alt="导入题目" />
  <img src="docs/screenshots/02-analysis.png" width="49%" alt="分步引导" />
  <br />
  <img src="docs/screenshots/03-teacher.png" width="49%" alt="教师视图" />
  <img src="docs/screenshots/06-report.png" width="49%" alt="学习报告" />
</p>

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [核心机制](#核心机制)
- [快速开始](#快速开始)
- [配置](#配置)
- [可用脚本](#可用脚本)
- [测试与评测](#测试与评测)
- [项目结构](#项目结构)
- [API 一览](#api-一览)
- [部署](#部署)
- [已知边界](#已知边界)
- [文档](#文档)
- [许可](#许可)

---

## 它解决什么问题

现在的学习产品普遍是「学生提问 → AI 完整讲解」。AI 只能靠最终答案判断学生的问题，
结果是学生拿到一份能看懂的解答，却依然不会做下一道题。

本项目把这个方向反过来：

| | 常见做法 | 本项目 |
|---|---|---|
| 入口 | 学生问，AI 答 | **学生先交出自己的思路** |
| AI 的依据 | 最终答案对不对 | **学生是怎么走到这一步的** |
| AI 的输出 | 完整讲解 | **恰好够用的提示** |
| 衡量标准 | 答对没有 | 卡在哪、为什么卡、下一步做什么 |

方向一变，技术难题也随之而来：**怎么保证 AI 在"帮"学生的同时，绝不把答案给出去？**
这是本项目的核心工作，也是下面三根支柱要解决的问题。

---

## 核心机制

### 一、卡点分类体系

「学生卡住了」不是一个状态，而是七种完全不同的处境。诊断层必须把它们分开，
否则提示会答非所问 —— 对"漏了前提"的学生追问"用什么规律"，等于白问。

| `stuckKind` | 学生处境 | 策略取向 |
|---|---|---|
| `not_started` | 还没形成思路 | 只做结构化澄清，不给任何方向 |
| `knowledge_gap` | 不知道用哪个规律 | 问过程性质，不点名公式 |
| `precondition_gap` | 知道规律但漏了前提 | 条件追问（最高价值场景） |
| `direction_lost` | 知道规律但走不下去 | 指关系、不指式子 |
| `execution_error` | 思路对但算错了 | 邀请自查，必要时局部示范 |
| `dead_end_path` | 自己已发现这条路走不通 | 引导换工具，而不是继续算 |
| `finished` | 已接近完成 | **AI 应当沉默** |

诊断结果必须能指回学生原话（`evidenceQuotes`），否则该次定位不被采信、
降级为"先澄清"。宁可先问一句"我理解得对吗"，也不对着错误的步骤给提示。

### 二、分层提示机制

提示分四层递进，**最多一次只升一级**：

| 层级 | 形态 | 内容 |
|---|---|---|
| `L0` | 结构化澄清 | 帮学生把话说清楚，不算提示 |
| `L1` | 条件追问 | 只问，不指方向 |
| `L2` | 方向提示 | 指出该看哪个量、哪个关系，但不给表达式 |
| `L3` | 降级示范 | 示范一步"动作"，不给数值结果 |

层级由两条硬护栏约束，它们不依赖模型自觉，而是在决策层强制生效：

- **禁止跳级** —— 按历史"连续前缀"判断可达层级，L3 要求历史里出现过 L2，L2 要求出现过 L1。
- **禁止原地打转** —— 同一层级在同一卡点已给过 2 次时，允许升一级；
  L3 再重复则不再给提示，改为要求学生复述自己的下一步。

### 三、防泄题机制

交付给学生的每一句话，都要先过七类确定性检查：

| # | 拦截内容 | 生效层级 |
|---|---|---|
| 1 | 数值答案（含"一库仑"这类中文数字说法） | 全部 |
| 2 | 解法性公式的完整表达式 | 全部（L3 允许"半边"） |
| 3 | 超出声明层级的内容（L1/L2 出现公式形态） | L0–L2 |
| 4 | 解法倾倒：编号步骤 > 2 个，或推导箭头 > 2 个 | 全部 |
| 5 | 收口句式："所以答案是 / 最终结果 / 因此可得" | 全部 |
| 6 | 跑题：引用了本题不存在的概念 | 全部 |
| 7 | **说出解题核心结论**（如"导体棒是电源，r 是内阻"） | L0–L2 |

第 7 类的判据是「**指派**」而不是「提及」：

- ✅ 允许：*「谁是提供电动势的那一部分？它自身有没有电阻？」*（在问）
- ❌ 拦截：*「导体棒相当于电源，它的电阻就是内阻。」*（在答）

它来自一次真模型实测：那句回复没有公式、没有数值，形式上完全合规，
但学生漏的正是"导体棒有内阻"—— 前六类检查全都拦不住。

七类检查在 `src/core/guard.js` 中的实现，以及它们各自产出的违规类型：

| 检查函数 | 违规 `kind` | 拦截内容 |
|---|---|---|
| `checkAnswerLeak` | `answer_in_text` | 数值答案 |
| `checkFormulaLeak` | `formula_leak` | 解法性公式表达式 |
| `checkLevelOverflow` | `level_overflow` | 超出声明层级的内容 |
| `checkSolutionDump` | `solution_dump` | 解法倾倒 |
| `checkConclusion` | `final_conclusion` | 收口句式 |
| `checkConceptDomain` | `concept_out_of_domain` | 跑题概念 |
| `checkSolutionInsight` | `solution_insight` | 解题核心结论 |

> 详细契约见 [`docs/01-hint-ontology-and-contract.md`](docs/01-hint-ontology-and-contract.md)
> 与 [`docs/02-prompt-spec.md`](docs/02-prompt-spec.md)。

---

## 快速开始

需要 **Node.js 20 或更高版本**。项目**零运行时依赖**，无需 `npm install`：

```bash
git clone https://github.com/shilohjun/ai-guided-tutor.git
cd ai-guided-tutor
npm start
```

然后打开 <http://127.0.0.1:5173>。

没有配置模型 Key 也能完整跑通 —— 引擎会自动降级到**离线规则桩**，
页面、测试、评测全部可用，只是提示文案来自规则而不是模型。

---

## 配置

复制 `.env.example` 为 `.env` 后按需填写。`.env` 已在 `.gitignore` 中，不会被提交。

| 变量 | 说明 | 默认 |
|---|---|---|
| `LLM_API_KEY` | 模型 API Key，留空即走离线规则桩 | 空 |
| `LLM_BASE_URL` | OpenAI 兼容接口地址（末尾不带 `/chat/completions`） | `https://api.deepseek.com/v1` |
| `LLM_MODEL` | 模型名 | `deepseek-chat` |
| `LLM_TIMEOUT_MS` | 单次请求超时，理科长题建议 ≥ 30s | `45000` |
| `PORT` / `HOST` | 本地服务地址 | `5173` / `127.0.0.1` |
| `TEACHER_KEY` | 教师视图口令，见下方说明 | 空 |
| `ALIYUN_OCR_APPCODE` | 拍照识题凭据，留空则该入口显示"未启用" | 空 |

### 接入模型

任何兼容 OpenAI Chat Completions 协议的服务都可以：

```env
LLM_API_KEY=你的API密钥
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
```

`.env.example` 中另附了阿里百炼 / 智谱的接口地址与模型名。

### 教师视图口令

学生视图与教师视图在**服务端**就分开了：`/api/chat` 只返回学生可见内容，
`/api/teacher/*` 才返回知识点、解题路径、参考答案与完整 trace。

| 形态 | 行为 |
|---|---|
| 本地留空 | 不需要口令，点一下即可进入教师视图 |
| 配置了口令 | 必须带对口令，否则一律 `401` |
| 公网部署且留空 | 教师视图整体关闭（`api/index.js` 强制锁死） |

口令只放在服务端环境变量里，不要写进任何前端文件。

### 启用拍照识题

拍照识题需要阿里云 OCR 云市场服务的 **AppCode**（注意不是 AppKey/AppSecret）：

```env
ALIYUN_OCR_APPCODE=你的AppCode
ALIYUN_OCR_PROVIDER=marketplace
```

重启服务后即可使用。图片识别**按成功调用次数计费**，且没有"额度用完自动停"的保护，
请先确认所用服务的计费说明。OCR 只识别题干文字，**不会自动理解受力图、电路图或几何图** ——
遇到依赖图形的题目，请在导入前补充图形信息。

因此拍照流程刻意做成「识别 → 回填输入框 → 学生确认 → 再读题」，而不是一键直通：
识别错一个数值，会让整条读题链路悄悄跑偏。

---

## 可用脚本

```bash
npm start          # 启动本地服务
npm run dev        # 监听文件变化并重启
npm test           # 运行全部单元测试（273 个用例）
npm run eval       # 离线评测（19 场景，无需 Key）
npm run eval:llm   # 使用 .env 中配置的模型重跑评测
npm run ocr:path   # 探测 OCR 链路连通性
npm run all        # 测试 + 离线评测
```

---

## 测试与评测

```bash
npm test
```

当前规模：**273 个用例**，覆盖诊断、路由、守卫、读题、OCR、前端 DOM 契约等。

```bash
npm run eval
```

在 **19 个教研标注场景**（物理 15、数学 4）上跑离线评测，输出泄题率、跳级率、
定位命中率、错因命中率等指标。切到真模型后**必须重跑**：

```bash
npm run eval:llm
```

`test/docs.test.js` 会从源码里**实际数出**卡点种类、守卫类别与用例总数，
再回头核对本文档。以后谁加了第 8 类守卫或第 8 种卡点，测试会先失败，逼着文档同步。

> 评测口径与指标定义见 [`docs/03-evaluation-spec.md`](docs/03-evaluation-spec.md)。

---

## 项目结构

```text
api/            Vercel Serverless API 入口
public/         Web 页面与静态资源（零构建，原生 JS）
server/         本地 HTTP 服务
src/core/       引擎核心
  ├─ engine.js      主流程编排
  ├─ locate.js      卡点定位
  ├─ route.js       分层提示与两条硬护栏
  ├─ guard.js       防泄题七类检查
  ├─ intake.js      读题（文字 → 结构化题目）
  ├─ ocr.js         拍照识题
  ├─ eval.js        评测场景集与指标
  └─ types.ts       类型契约
src/server/     API 路由（本地与线上共用同一份）
test/           自动化测试（自研极简运行器，零依赖）
scripts/        评测与 OCR 探测脚本
docs/           设计文档与截图
showcase/       项目成果展示页（可独立发布）
```

---

## API 一览

本地与 Vercel 环境复用同一份路由（`src/server/router.js`），行为不会漂移。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查与当前运行模式 |
| `GET` | `/api/problems` | 内置题目列表 |
| `GET` | `/api/problem?id=` | 单个题目（学生可见版本） |
| `POST` | `/api/problem/import` | 题目文字 → 结构化题目 |
| `POST` | `/api/ocr` | 题目照片 → 题干文本 |
| `POST` | `/api/chat` | 一轮引导对话（已过滤，不含解题路径与答案） |
| `GET` | `/api/report?sessionId=` | 学生学习报告 |
| `POST` | `/api/eval` | 触发评测 |
| `POST` | `/api/reset` | 重置会话 |
| `GET` | `/api/teacher/overview` | 教学汇总（需口令） |
| `GET` | `/api/teacher/problem?id=` | 题目知识点与解题路径（需口令） |
| `GET` | `/api/teacher/session?sessionId=` | 完整对话与 trace（需口令） |

---

## 部署

仓库包含 Vercel 部署配置。**公开 Demo 默认关闭真模型、拍照 OCR 与教师视图** ——
这个决定写在 `api/index.js` 里，而不是靠部署时"记得别配"：

- 公网服务带着 API Key 跑真模型，等于把额度挂出去。安全保证全部在决策层与守卫层，
  与模型能力无关，离线桩下泄题率同样是 0%。
- 拍照识题按次计费，删 Key 也拦不住已经发出去的调用。
- 教师接口返回完整解题路径与参考答案，挂在公开链接上等于把答案发出去。

确实需要在公网演示某一环时，必须显式设置对应开关（如 `PUBLIC_DEMO_ALLOW_OCR=1`），
并先阅读 `api/index.js` 中的限制说明。

`showcase/` 是**独立的单文件展示页**（零外部依赖），由
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) 发布到 GitHub Pages；
它与可交互的应用页面相互独立。发布前需在仓库 Settings → Pages 中把 Source 设为
**GitHub Actions**。

---

## 已知边界

**现在这组数据证明的是「安全」，不是「有用」。**

- 它能证明：在 19 个场景与压力测试下，引擎**守得住不给答案**（泄题率 0%、跳级率 0%）。
- 它**还不能**证明：提示对学生的实际学习效果。这需要教研老师盲评真实对话才能判断，
  我们刻意没有把这一点省略。

其他已知限制：

| 限制 | 说明 |
|---|---|
| 场景集规模 | 仅 19 个场景且由人编写，覆盖不了真实学生的表达多样性 |
| 长会话稳定性 | 场景集最长 3 轮，尚未做 10+ 轮疲劳测试 |
| 跨学科泛化 | 主要验证物理电磁感应，数学仅 4 个场景作了初步验证 |
| 图形类题目 | OCR 只识别文字，读不懂受力图、电路图与几何图 |
| 指标口径 | 离线指标基于规则桩，接入真模型后需重跑确认 |

---

## 文档

| 文档 | 内容 |
|---|---|
| [`01-hint-ontology-and-contract.md`](docs/01-hint-ontology-and-contract.md) | 提示本体与接口契约 |
| [`02-prompt-spec.md`](docs/02-prompt-spec.md) | Prompt 规范 |
| [`03-evaluation-spec.md`](docs/03-evaluation-spec.md) | 评测标准与方法 |
| [`04-intake-and-views.md`](docs/04-intake-and-views.md) | 读题链路与视图隔离 |
| [`05-ocr-feasibility.md`](docs/05-ocr-feasibility.md) | 图片识别可行性评估 |
| [`06-marketplace-ocr-integration.md`](docs/06-marketplace-ocr-integration.md) | 云市场题目 OCR 接入研究 |
| [`周报.md`](docs/周报.md) | 工作周报 |
| [`showcase/`](showcase/) | 项目成果演示页 |

---

## 许可

项目当前标记为**未授权公开许可**（`UNLICENSED`）。如需复用或分发代码，请先联系项目作者。
