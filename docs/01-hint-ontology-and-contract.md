# 提示本体与接口契约

> 本文定义「AI 看懂学生思路 + 只给提示不给答案」这一能力的**对外契约**。
> 前端、提示词、评测三方都以本文为准；代码里的 `src/core/types.ts` 是它的可执行版本。
> 两者不一致时，以 `types.ts` 为准，并请同步修改本文。

---

## 一、核心设计立场

### 1.1 为什么把能力拆成"观察"与"决策"两层

绝大多数 AI 教学产品把"判断 + 话术"一起交给模型。Demo 阶段没问题，但会在三处失控：

| 失控点 | 后果 | 本项目的做法 |
|---|---|---|
| 模型自行决定给几级提示 | 学生一喊难就直接给答案 | **层级由规则引擎决定**，模型无权修改 |
| 模型自行决定"什么算给了答案" | 换个说法就把答案说出来了 | **出口守卫做确定性检查**，拦下就重写 |
| 模型自述理解学生 | 定位错了却无从发现 | **双通道交叉校验 + 证据引用**，必须能指回学生原话 |

职责切分：

```
LLM（观察员）         规则代码（决策者）        守卫（把关者）
──────────────       ──────────────────       ──────────────
学生说了什么          该给几级提示              有没有泄题
落在哪一步            用什么策略                有没有跑题
像哪类错因            允许引用哪些概念          有没有越界
```

**一句话：模型负责"懂"，代码负责"分寸"。**

### 1.2 为什么"不给答案"要做成工程约束

Prompt 里写"请不要给答案"是**请求**，不是**保证**。模型至少会用六种方式绕过：
给出数值答案 / 给近似值 / 给公式让学生自己算 / 列出完整步骤 / 用收口句式下结论 /
**用"指派式"的陈述把结论说破**（不加公式、不加数值，但等于告诉学生答案）。

守卫对六类各有一条检查（外加跑题检查，共七类），在出口强制校验。
**任何被交付给学生的文本，必然通过了全部七类检查** —— 这一点由测试逐一断言，而非代码审阅。

---

## 二、数据模型

### 2.1 Problem（题目与标准解题路径）

标准解不是一段文本，而是**带前提条件的步骤图谱** —— 因为"只给提示"的本质是
"告诉学生该检查哪一步的什么条件"，若只有一段参考解答，就无法定位"他卡在第几步"。

```ts
interface Problem {
  id: string;
  subject: 'physics' | 'math' | 'chemistry';
  topics: string[];          // 知识图谱映射用（章节级）
  difficulty: 1 | 2 | 3 | 4 | 5;
  stem: string;
  givens: string[];          // 结构化已知量
  asked: string[];
  solutionGraphs: SolutionGraph[];   // 支持多解
  misconceptions: Misconception[];   // 常见错因库
  answerFingerprints: string[];      // 数值答案指纹（守卫基准一）
  formulaFingerprints?: string[];    // 解法公式指纹（守卫基准二）
  solutionInsights?: string[];       // 结论要点指纹（守卫基准三）
  referenceAnswer: string;           // 仅服务端持有，绝不出网
}
```

**关键字段：`SolutionStep.kind`** —— 它决定提示的形态，是"提示切题"的根据：

| kind | 含义 | 该步该给什么提示 |
|---|---|---|
| `setup` | 建立模型、画图、选系统 | 示范"怎么摆研究对象" |
| `identify` | 识别适用规律 | 问"发生了什么过程" |
| `precondition` | 检查规律的前提 | **条件追问的主战场**（本产品最强项） |
| `apply` | 套用公式 | 示范"只写式子左边" |
| `derive` | 代数/微分运算 | 示范"写成符号链" |
| `interpret` | 物理意义解释 | 问"这个量代表什么" |
| `conclude` | 得出最终结果 | 只在此步才可能触及答案 |

> 实战教训：L3 的示范动作若写成固定话术，就会出现"学生在算电流，AI 让他去列受力"这种错位。
> 因此 `kind → 示范动作` 是必须的映射，不是可选的优化。

### 2.2 Misconception（错因）

错因不是给学生看的标签，而是**从"卡住"到"该检查什么"的桥**。

```ts
interface Misconception {
  id: string;
  label: string;          // 教研视角标签，不下发学生
  signature: string[];    // 学生典型说法（离线匹配 + few-shot）
  rootCause: string;      // 认知缺口
  hintSeeds: string[];    // 提示种子：只指方向，不含结论
}
```

`hintSeeds` 是最需要教研投入的字段，必须满足：

- ✅ 是一个**问题**或**指向**："这个规律成立需要什么前提？"
- ❌ 不是半个答案："注意内阻"（等于告诉了他错在哪）
- ❌ 不是公式："用 I = E/(R+r)"（等于给了答案）

### 2.3 Diagnosis（诊断结论）

```ts
interface Diagnosis {
  position: { graphId, stepIndex, confidence, completedSteps, divergedAt };
  feasibility: 'viable' | 'partially_viable' | 'not_viable' | 'unclear';
  misconceptions: { id, label, evidence, confidence }[];
  stuckKind: StuckKind;
  sufficientInfo: boolean;    // 学生是否真的说了可诊断的内容
  evidenceQuotes: string[];   // 必须能指回学生原话
  strengths: string[];        // 学生已经想对的地方
  restatement: string;        // 给学生的一句复述
  trace: TraceEntry[];        // 完整判断链路（教师视图用）
}
```

**`stuckKind` 是策略选择的唯一输入**，它把"学生卡住"分成七种互不相同的处境：

| stuckKind | 学生处境 | 策略取向 |
|---|---|---|
| `not_started` | 还没形成思路 | 只做结构化澄清，不给任何方向 |
| `knowledge_gap` | 不知道用哪个规律 | 问过程性质，不点名公式 |
| `precondition_gap` | 知道规律但漏了前提 | **条件追问**（最高价值场景） |
| `direction_lost` | 知道规律但走不下去 | 方向提示：指关系不指式子 |
| `execution_error` | 思路对但算错了 | 邀请自查；必要时局部示范 |
| `dead_end_path` | 自己已发现走不通 | 引导换工具，而不是继续算 |
| `finished` | 已接近完成 | **AI 应沉默** |

**`evidenceQuotes` 是防幻觉的关键**：诊断必须能指回学生原话的子串，
否则该次定位不被采信（降置信 → 退化为"先澄清"）。
宁可先问一句"我理解得对吗"，也不要对着错误的步骤给出提示。

---

## 三、提示层级契约

### 3.1 四层递进

| 层级 | 名称 | 允许 | 绝对禁止 |
|---|---|---|---|
| **L0** | 结构化澄清 | 帮学生分清已知/目标/困惑；开放式提问 | 任何具体方向（不点名规律 / 公式） |
| **L1** | 条件追问 | 追问某个规律的前提；追问某个条件的含义 | 出现公式形态；点名该用哪个公式 |
| **L2** | 方向提示 | 指出该关注哪两个量之间的**关系**、哪个模块要打通 | 给出关系式；给出数值结果 |
| **L3** | 降级示范 | 示范**一个动作**（选对象 / 写式子左边 / 列条件清单） | 给出数值结果；给出完整表达式 |

### 3.2 升级规则（确定性，模型无权修改）

```
首次求助                          → L1
已给 L1，学生仍卡在同一处          → L2
已给 L2，学生仍卡在同一处          → L3
已在 L3，学生仍卡在同一处          → 不再升级，改为要求学生复述自己的下一步
学生表示"我试试 / 让我想"          → 维持当前层级，不升级
学生已接近完成且无错因             → 不介入（沉默）
自主训练 + 未求助 + 非高置信卡点   → 不介入（静默观测）
信息不足（只说"我不会"）且无历史   → L0 反问，不硬猜定位
```

**两条硬性护栏：**

- **护栏 A（禁止跳级）**：能达到的层级 = 从 L1 开始的最长连续段 + 1（按"连续前缀"判断，
  而不是只看前一级）。这里修过一个真实漏洞：历史里出现 `[L2]`（缺 L1）时，
  旧规则会放行 L3，学生直接拿到最强示范。
- **护栏 B（禁止原地打转）**：同一卡点同一层级给过 2 次即升一级；
  已到 L3 则转为要求学生复述。同时轮换话术变体，绝不复读同一句。

### 3.3 关键设计：模型不决定层级

这是本契约里**最重要的一条约束**。若让模型自行决定层级，实测会出现两个方向的失效：
① 学生一喊难就直接给到 L3（变相给答案）；② 学生已快想通，模型还在机械升级，反而打断他。
层级是**教学策略问题**，不是语言问题，因此属于规则引擎。

实现上，模型拿到的 `DraftInput.level` 是**只读入参**：它只能"在这个层级内把话写好"，不能改变层级。

---

## 四、HTTP 接口契约

> **最重要的约定：学生视图与教师视图在服务端分流。**
>
> | 端点 | 谁可以拿 | 内容 |
> |---|---|---|
> | `/api/problem`、`/api/chat`、`/api/report` | 学生 | **白名单投影**：无路径名、无步骤、无指纹、无参考答案、无错因标签、无守卫细节 |
> | `/api/teacher/*` | 带 `TEACHER_KEY` 的人 | 完整图谱、参考答案、三组指纹、逐轮 trace |
>
> 这是**服务端不给**，不是前端不显示 —— 学生打开 F12 也拿不到。
> 由 `test/ui.test.js`（密钥扫描）与 `test/analysis.test.js`（学生载荷反向断言）守着。

### 4.1 `GET /api/problem?id=<problemId>`

下发题目与学生版解析。**参考答案、错因教研标签、三组指纹、路径内容决不出网。**

```json
{
  "problem": {
    "id": "phy-emi-01",
    "source": "library",
    "subject": "physics",
    "topics": ["电磁感应", "法拉第电磁感应定律"],
    "difficulty": 2,
    "stem": "如图所示……",
    "givens": ["L = 0.5 m", "B = 0.4 T"],
    "asked": ["感应电动势 E", "感应电流 I"],
    "figure": "水平导轨，竖直向上磁场……",
    "stepCount": 8,
    "analysis": {
      "summary": "物理题，考点集中在电磁感应……",
      "variables": {
        "given": [{ "id": "v0", "kind": "given", "raw": "L = 0.5 m", "symbol": "L", "value": "0.5", "unit": "m", "note": "长度 / 距离" }],
        "asked": [{ "id": "v0", "kind": "asked", "raw": "感应电动势 E", "symbol": "E", "value": null, "unit": "", "note": "感应电动势 E" }],
        "qualitative": ["匀速运动"]
      },
      "keyConditions": [
        {
          "text": "…使导体棒沿导轨以恒定速度 v = 2 m/s 向右…",
          "label": "匀速（速度不变）",
          "kind": "constraint",
          "meaning": null,
          "question": "\"匀速\"在力学上等价于什么条件？先把这句话翻译出来。",
          "revealsInsight": true
        }
      ],
      "knowledgeGraph": {
        "nodes": [{ "id": "电磁感应", "name": "电磁感应", "role": "core", "level": 1, "note": "" }],
        "edges": [{ "from": "安培力", "to": "电磁感应", "relation": "prereq", "label": "前置" }],
        "edgeSource": "derived",
        "scope": "topics-only"
      }
    }
  }
}
```

两条刻意的取舍，写在这里以免后人"顺手补全"：

- **没有 `graphSummary` / 路径名。** 路径名本身就把解法说出来了，学生只知道"一共几步"。
- **没有 `conceptTags`。** 曾经有，是 `steps[].concepts` 的汇总，而其中包含
  「电源与内阻」「匀速直线运动合力为零」，**恰好是本题的两个 `solutionInsight`** ——
  等于把答案印在题目下面。现在知识点只从 `topics`（章节级）来。

### 4.1b `POST /api/problem/import` —— 读一道新题

请求：`{ "rawText": "……", "subjectHint": null }`

响应（`problem` 形状与 4.1 一致）：

```json
{
  "problem": { "...": "同上" },
  "intake": {
    "usedModel": true,
    "latencyMs": 9125,
    "topics": ["自由落体运动", "匀变速直线运动"],
    "stepCount": 7,
    "graphReady": true,
    "analysisFromModel": true,
    "conditionCount": 3,
    "notice": "已读懂这道题……（路径对学生不可见，只用于后续引导）。"
  }
}
```

| 状态码 | 含义 |
|---|---|
| 400 | 题干短于 8 字 |
| 422 | 读题失败（模型不可用且降级也失败） |
| 200 | 成功；**降级也返回 200**，但 `usedModel:false` + `notice` 会写明"路径是通用骨架" |

> 降级返回 200 而不是报错，是刻意的：学生应拿到一个能用的（哪怕更弱的）引导，
> 而不是错误页。代价是"降级"必须**显式可见** —— 所以有 `usedModel` 与 `notice`。

### 4.2 `POST /api/chat`

请求：`{ sessionId, problemId, utterance, mode, explicitHelpSeeking }`

```json
{
  "message": "我理解你的意思是：……\n\n这段电路里，谁是提供电动势的那一部分？\n\n【下一步】检查一下这个规律的前提条件",
  "hint": {
    "level": 1,
    "levelName": "L1 条件追问",
    "levelNote": "我在问你一个前提",
    "form": "condition_question",
    "text": "这段电路里，谁是提供电动势的那一部分？它自身有没有电阻？",
    "concepts": ["闭合电路欧姆定律", "含内阻电路"],
    "nextAsk": "检查一下这个规律的前提条件，然后告诉我哪一条最值得怀疑。"
  },
  "progress": { "stepIndex": 4, "stepCount": 7, "completed": [1, 2, 3], "confidenceLabel": "高" },
  "enginePath": [{ "stage": "locate", "label": "定位：按你说的话，你大概走到第 4 步（共 7 步）", "tone": "ok" }],
  "understood": ["选对了「闭合电路欧姆定律」这个方向"],
  "nextStep": "检查一下这个规律的前提条件，然后告诉我哪一条最值得怀疑。",
  "mode": "ai_companion",
  "reviewed": false,
  "suppressed": false,
  "refused": false,
  "completion": null,
  "meta": { "engine": "offline-stub", "model": null, "latencyMs": 3 }
}
```

**字段语义要点**

| 字段 | 说明 |
|---|---|
| `message` | 学生可见的完整文本（复述 + 提示 + 下一步）。**唯一应该渲染给学生看的字段。** |
| `hint.text` | 仅提示部分，不含复述。用于 UI 分行着色 |
| `hint.levelNote` | 层级的人话版本（"我在问你一个前提"），不是 `L1 条件追问` 这种教研语言 |
| `progress` | `{ stepIndex, stepCount, completed, confidenceLabel }` —— 只给"第几步 / 共几步 / 走过哪些步 / 把握粗档" |
| `enginePath` | 引擎判断链路的学生版投影（见 §4.6） |
| `understood` | 学生已经想对的地方（正面反馈） |
| `refused` | true 表示本轮走"拒绝给答案"路径（累计次数只留在服务端） |
| `suppressed` | true 表示"决定不介入"（自主训练静默 / 学生已完成） |
| `reviewed` | true 表示本轮提示经过复核重写（只说"复核过"，不说违规类型） |
| `completion` | 答案判定结果：`{ complete, matched, remainingCount, expectedCount }`，`matched` 里的数字全部来自学生原话 |

**响应里刻意不存在的东西**（不是"前端不显示"，是根本没发）：
`diagnosis.stuckKind`、`confidence` 数值、`hint.rationale`、`meta.guardPassed`、
`guardBlocked`、`guardHistory`、错因标签、路径名、步骤标题。

> 早期版本把 `diagnosis.teacherView` 和学生消息一起返回，靠前端一个 checkbox 决定显不显示 ——
> 打开 F12 就能看到。现在这些只在 `/api/teacher/*`，且必须带口令。

### 4.3 其它端点

| 端点 | 说明 |
|---|---|
| `GET /api/report?sessionId=` | 学生学习报告（结构见 §五） |
| `POST /api/eval` | 一键跑离线评测，返回指标；入口只在教师视图 |
| `GET /api/health` | 引擎模式、读题能力、教师视图形态、题目注册表统计，**绝不回传口令** |
| `GET /api/problems` | 题目列表（题库 + 现场导入） |
| `GET /api/demo-scripts` | 演示剧本 |
| `POST /api/reset` | 清掉某个会话 |

### 4.4 教师视图端点（需 `TEACHER_KEY`）

三种形态由**部署形态**决定，不由"有没有配口令"决定（`router.js` 的 `teacherMode`）：

| 形态 | 触发条件 | 行为 |
|---|---|---|
| `open` | 本地运行且 `TEACHER_KEY` 留空 | 直接进 |
| `key` | 配了 `TEACHER_KEY` | 不带口令一律 401 |
| `off` | 公网部署（`api/index.js` 强制置位）且没配口令 | 403，整体关闭 |

**为什么公网一定要 `off`**：教师接口返回**完整解题路径 + 参考答案 + 答案指纹**。
若"没配口令 = 开放"这个默认值跟着代码上了 Vercel，那份公开链接就等于把答案挂在网上 ——
而这恰恰是最容易发生的疏忽（本地跑得好好的，部署时没人会想起来去配口令）。
三档形态在 `test/ui.test.js` 各有断言，其中一条专门检查 `api/index.js` 的强制锁死逻辑还在不在。

| 端点 | 返回 |
|---|---|
| `GET /api/teacher/overview` | 跨会话聚合：帮助强度分布、卡点性质分布、会话列表 |
| `GET /api/teacher/session?sessionId=` | 逐轮复盘：层级、卡点、定位步骤、被拦下的原句与违规类型、证据、voice 体检、完整 trace |
| `GET /api/teacher/problem?id=` | 完整图谱 + 参考答案 + 三组指纹 + 教师版解析（含剧透标记） |

**引擎判断链路在两个视图里是两次独立的投影，不是同一份数据加打码：**

| | 学生版 | 教师版 |
|---|---|---|
| 来源 | `prompt.js` 的 `buildStudentEnginePath()` 白名单构造 | `diagnosis.trace` 完整内容 |
| 内容 | 读题 / 听懂 / 定位（只说第几步）/ 决定（给人话）/ 成文 | 双通道定位数值、冲突与采信、卡点性质、层级策略、守卫违规 |
| 刻意没有 | 错因标签、置信度数字、违规类型、层级策略名、路径名、步骤标题 | —— |

打码依赖"记得打哪里"，白名单依赖"允许说什么"；漏一处只是少说一句话。
这与守卫用**封闭词表**而不是黑名单是同一条思路。

---

## 五、学习报告契约

报告的设计原则：**报告不是给分的，是给下一步的。**
因此每一条卡点都必须带三样东西：具体位置 / 认知缺口 / 可执行动作。

```ts
interface Report {
  stuckPoints: { stepIndex, stepTitle, kind, misconceptionLabels, hintRounds, maxLevel }[];
  hintStats: { total, byLevel: {0,1,2,3}, guardBlocked };
  independence: { score, completedSteps, totalSteps, note };
  deeperIssues: string[];        // 跨卡点归纳的认知缺口
  recommendations: { topic, reason, drill }[];
  nextActions: string[];
}
```

### 5.1 独立完成度算法（可解释版）

```
基础分 = 学生自己走过的步骤数 / 总步骤数
扣分项 = L3 示范次数 × 0.1 + L2 方向提示次数 × 0.04   （最多扣 0.4）
结果裁剪到 [0, 1]
```

**文案约束**：这个数字衡量的是"**你得到的帮助强度**"，不是"你的水平"。
报告里必须显式说明这一点，否则学生会把它当成分数评价。
因此独立完成度刻意**不用"对了几步"**来算。

### 5.2 深层问题归纳

刻意用**可审计的模式表**而不是聚类算法：

```ts
const DEEPER_PATTERNS = [
  { id: 'precondition-habit',       test: /前提|条件|漏|忘|忽略|误判|混淆|均匀/ },
  { id: 'cross-module-translation', test: /平衡|匀速|受力|运动/ },
  { id: 'tool-selection',           test: /动量|能量|变加速|匀变速|工具|方程/ },
  { id: 'energy-accounting',        test: /做功|能量|热量|焦耳|功率/ },
  { id: 'circuit-modeling',         test: /内阻|回路|电源|并联|隔直|电容/ },
];
```

理由：教研能读懂、能改、能跟知识点图谱对齐 —— 这比算法高级更重要。

---

## 六、防泄题守卫契约

### 6.1 七类检查

| # | kind | 拦截内容 | 生效层级 |
|---|---|---|---|
| 1 | `answer_in_text` | 数值答案（含中文数字说法"一库仑"） | 全部 |
| 2 | `formula_leak` | 解法性公式的完整表达式 | 全部（L3 允许"半边"） |
| 3 | `level_overflow` | 超出声明层级的内容 | L0–L2 |
| 4 | `solution_dump` | 编号步骤 >2 个，或推导箭头 >2 个 | 全部 |
| 5 | `final_conclusion` | "所以答案是/最终结果/因此可得"类收口句式 | 全部 |
| 6 | `concept_out_of_domain` | 跑题：引用了本题不存在的物理概念 | 全部 |
| 7 | `solution_insight` | 说出解题核心结论（如"导体棒是电源，r 是内阻"） | L0–L2 |

第 7 类的判据是"**指派**"而不是"提及"：

- ✅ 允许："谁是提供电动势的那一部分？它自身有没有电阻？"（在问）
- ❌ 拦截："导体棒相当于电源，它的电阻就是内阻。"（在答）

它来自一次真模型实测：那句回复没有公式、没有数值，形式上完全合规，
但学生漏的正是"导体棒有内阻"—— 此前的六条检查全都拦不住。

> **同一套 `solutionInsights` 指纹也被解析层复用**（`analysis.js` 的 `doesReveal`）。
> 这是刻意的：解析面板的"关键条件含义"若会剧透，判定基准必须与守卫完全一致，
> 否则会出现"解析里能说、提示里不能说"的口径矛盾。

### 6.2 检查 1 的双通道设计

- **通道 a**：命中题库的 `answerFingerprints`（教研手工维护，精度高）
- **通道 b**：从 `referenceAnswer` 自动抽取"数值 + 单位"对做兜底（召回高）

通道 b 防"教研漏写指纹"这类人为疏漏。两通道都会排除题干已给的已知量
（否则会误判"B = 0.4 T 这个条件你注意到了吗"）。

### 6.3 拦截后的降级重写

| 违规类型 | 重写策略 | 理由 |
|---|---|---|
| `answer_in_text` / `final_conclusion` / `concept_out_of_domain` / `solution_insight` | 整体替换为安全模板 | 说明模型"没理解题目"或"越了红线"，局部删改救不回来 |
| `formula_leak` / `level_overflow` | 剥离公式片段，保留问句 | 提示骨架通常是好的，只是多了个式子 |
| `solution_dump` | 截断到前两句 | 内容对，但给多了 |

重写后**必须重新校验**；仍不干净则降级。模型最多重试一次，
两次都不过就直接用安全兜底模板 —— **永不泄题优先于文采**。

> 走哪条路要看重写策略：`strip-equation` / `truncate` 只删掉了越界的一小段，
> 模型自己的说法还在 ⇒ 直接采用（更快、也更贴学生）；
> `safe-template` 是整句被换成通用模板 ⇒ **把拦截原因带回给模型重试一次**，
> 两次都不过才用模板。早期实现在第一次被拦时就直接采用模板，
> 于是"重试"这条路径几乎从不发生，提示质量被静默拉低。

### 6.4 出口断言

引擎在返回前断言 `guard.passed === true`，否则**抛错**。
这让"守卫失效"变成一个立刻可见的崩溃，而不是静默地把答案发给学生。

---

## 七、LLM 适配层契约

真模型与离线桩实现**同一接口**，这是"没 Key 也能跑全套测试"的根据。

```ts
interface LLMAdapter {
  readonly kind: 'offline-stub' | 'llm';
  readonly model?: string;
  observeStudent(input: ObserveInput): Promise<Observation>;  // 只做观察
  draftHint(input: DraftInput): Promise<string>;              // 只在层级内写话
  understandProblem?(input): Promise<ProblemDraft>;           // 可选：读题
}
```

**关键约束：`Observation` 里没有任何"决策"字段。**
它只有"学生说了什么、落在哪一步、像哪类错因"，
没有"该给几级提示"、"是否放行"。

| 实现 | 用途 | 定位方式 | 已知局限 |
|---|---|---|---|
| `createOpenAIAdapter` | 生产路径 | LLM 语义理解 | 依赖 Key；受模型能力影响 |
| `createOfflineAdapter` | 开发/测试/评测基线 | 规则 + 关键词 | 无法处理"完全换一种说法" |

**离线模式的准确定位**：它的价值是**验证护栏与流程**，而不是验证理解能力。
所有安全指标（泄题率 / 跳级率 / 确认答案 / 解法倾倒）在离线模式下都必须为 0 ——
因为这些问题都在"决策"与"守卫"层，与模型能力无关。

---

## 八、接入企业模型时的适配点

只需改一处：

1. 在 `.env` 填 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`
2. 若企业模型是 OpenAI 兼容协议 → **无需改代码**
3. 若是私有协议 → 只需实现 `LLMAdapter` 的两个方法，其余全部复用

需要企业提供的能力：

| 需要 | 用途 | 是否阻塞 |
|---|---|---|
| OpenAI 兼容 chat completions | 观察 + 起草 | 是 |
| JSON 输出稳定（`response_format`） | 结构化解耦 | 建议；有三级容错兜底 |
| 视觉模型（VL） | 拍照识题 | 否，可后置 |
| 知识图谱/知识点标签 | `Problem.topics` 对齐 | 否，可先用教研标注 |
