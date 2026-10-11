# 提示本体与接口契约

> 本文档定义「AI 看懂学生思路 + 只给提示不给答案」这一能力的**对外契约**。
> 前端、提示词、评测三方都以本文档为准；代码里的 `src/core/types.ts` 是它的可执行版本。
> 两者不一致时，以 `types.ts` 为准，并请同步修改本文档。

---

## 一、核心设计立场

### 1.1 为什么把能力拆成"观察"与"决策"两层

绝大多数 AI 教学产品把"判断 + 话术"一起交给模型。这样做在 Demo 阶段没问题，
但会在三个地方失控：

| 失控点 | 后果 | 本项目的做法 |
|---|---|---|
| 模型自行决定给几级提示 | 学生一喊难就直接给答案 | **层级由规则引擎决定**，模型无权修改 |
| 模型自行决定"什么算给了答案" | 换个说法就把答案说出来了 | **出口守卫做确定性检查**，拦下就重写 |
| 模型自述理解学生 | 定位错了却无从发现 | **双通道交叉校验 + 证据引用**，必须能指回学生原话 |

因此本项目的职责切分是：

```
LLM（观察员）         规则代码（决策者）        守卫（把关者）
──────────────       ──────────────────       ──────────────
学生说了什么          该给几级提示              有没有泄题
落在哪一步            用什么策略                有没有跑题
像哪类错因            允许引用哪些概念          有没有越界
```

**一句话概括：模型负责"懂"，代码负责"分寸"。**

### 1.2 为什么"不给答案"要做成工程约束

Prompt 里写"请不要给答案"是**请求**，不是**保证**。模型会用至少五种方式绕过：

1. 直接给出数值答案
2. 换个说法给近似值（"大约是 0.4 左右"）
3. 给出公式让学生自己算出（"用 E = BLv 就行"）
4. 列出完整步骤让学生抄（"1、… 2、… 3、…"）
5. 用收口句式下结论（"所以答案是…"）

守卫对这五类各有一条检查（外加本文档成文后新增的第六条"跑题"），
在提示文本出口处强制校验。**任何被交付给学生的文本，必然通过了全部六条检查** ——
这一点由测试逐一断言，而不是靠代码审阅。

---

## 二、数据模型

### 2.1 Problem（题目与标准解题路径）

标准解不是一段文本，而是**带前提条件的步骤图谱**。原因：
"只给提示"的本质是"告诉学生该检查哪一步的什么条件"，
如果只有一段参考解答，就无法定位"他卡在第几步"。

```ts
interface Problem {
  id: string;
  subject: 'physics' | 'math' | 'chemistry';
  topics: string[];          // 知识图谱映射用（对接企业知识库）
  difficulty: 1 | 2 | 3 | 4 | 5;
  stem: string;
  givens: string[];          // 结构化已知量
  asked: string[];
  solutionGraphs: SolutionGraph[];   // 支持多解
  misconceptions: Misconception[];   // 常见错因库
  answerFingerprints: string[];      // 数值答案指纹（守卫基准一）
  formulaFingerprints?: string[];    // 解法公式指纹（守卫基准二）
  referenceAnswer: string;           // 仅服务端持有，绝不出网
}
```

**关键字段：`SolutionStep.kind`**

它决定提示的形态，是"提示切题"的根据：

| kind | 含义 | 该步该给什么提示 |
|---|---|---|
| `setup` | 建立模型、画图、选系统 | 示范"怎么摆研究对象" |
| `identify` | 识别适用规律 | 问"发生了什么过程" |
| `precondition` | 检查规律的前提 | **条件追问的主战场**（本产品最强项） |
| `apply` | 套用公式 | 示范"只写式子左边" |
| `derive` | 代数/微分运算 | 示范"写成符号链" |
| `interpret` | 物理意义解释 | 问"这个量代表什么" |
| `conclude` | 得出最终结果 | **只在此步才可能触及答案** |

> 实战教训：L3 的示范动作如果写成固定话术，就会出现
> "学生在算电流，AI 让他去列受力"这种明显错位。
> 因此 `kind → 示范动作` 是必须的映射，而不是可选的优化。

### 2.2 Misconception（错因）

错因不是给学生看的标签，而是**从"卡住"到"该检查什么"的桥**。

```ts
interface Misconception {
  id: string;
  label: string;          // 教研视角标签，不下发学生
  signature: string[];    // 学生典型说法（离线匹配 + few-shot）
  rootCause: string;      // 认知缺口（用于归纳"深层问题"）
  hintSeeds: string[];    // 提示种子：只指方向，不含结论
  highLeakRisk?: boolean; // 标记"顺手就会说出答案"的高危错因
}
```

`hintSeeds` 是整个题库里最需要教研投入的字段。它必须满足：

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
  evidenceQuotes: string[];   // 必须能指回学生原话
  restatement: string;        // 给学生的一句复述
  trace: TraceEntry[];        // 完整判断链路（教师视图用）
}
```

**`stuckKind` 是策略选择的唯一输入**，它把"学生卡住"这件事分成六种互不相同的处境：

| stuckKind | 学生处境 | 策略取向 |
|---|---|---|
| `not_started` | 还没形成思路 | 只做结构化澄清，**不给任何物理方向** |
| `knowledge_gap` | 不知道用哪个规律 | 问过程性质，不点名公式 |
| `precondition_gap` | 知道规律但漏了前提 | **条件追问**（最高价值场景） |
| `direction_lost` | 知道规律但走不下去 | 方向提示：指关系不指式子 |
| `execution_error` | 思路对但算错了 | 邀请自查；必要时局部示范 |
| `finished` | 已接近完成 | **AI 应沉默** |

**`evidenceQuotes` 是防幻觉的关键**：诊断必须能指回学生原话的子串，
否则这次定位不被采信（降置信 → 退化为"先澄清"）。
宁可先问一句"我理解得对吗"，也不要对着错误的步骤给出提示。

---

## 三、提示层级契约

### 3.1 三层递进（+ 一层前置澄清）

| 层级 | 名称 | 允许 | **绝对禁止** |
|---|---|---|---|
| **L0** | 结构化澄清 | 帮学生分清已知/目标/困惑；开放式提问 | 任何物理方向 |
| **L1** | 条件追问 | 追问某个规律的前提；追问某个条件的含义 | 出现公式形态；点名该用哪个公式 |
| **L2** | 方向提示 | 指出该关注哪两个量之间的**关系**、哪个模块之间要打通 | 给出关系式；给出数值结果 |
| **L3** | 降级示范 | 示范**一个动作**（选对象 / 写式子左边 / 列条件清单） | 给出数值结果；给出完整表达式 |

### 3.2 升级规则（确定性，模型无权修改）

```
首次求助                        → L1
已给 L1，学生仍卡在同一处        → L2
已给 L2，学生仍卡在同一处        → L3
已在 L3，学生仍卡在同一处        → 不再升级，改为要求学生复述自己的下一步
学生表示"我试试 / 让我想"        → 维持当前层级，不升级
学生已接近完成且无错因           → 不介入（沉默）
自主训练模式 + 未求助 + 非高置信卡点 → 不介入（静默观测）
思维对但执行错（execution_error） → 可一次到 L3（局部示范性价比最高）
```

**两条硬性护栏：**

- **护栏 A（禁止跳级）**：能达到的层级 = 从 L1 开始的最长连续段 + 1。
  > 这里修过一个真实的越级漏洞：早期版本只检查"目标层级的前一级是否出现过"，
  > 当历史里出现 `[L2]`（缺 L1）时，L2 存在 ⇒ 允许升到 L3，而 L1 从未给出 ——
  > 学生直接拿到了最高级别的示范。现在按"连续前缀"判断。
- **护栏 B（禁止原地打转）**：同一卡点同一层级给过 2 次即升一级；
  已到 L3 则转为要求学生复述。同时轮换话术变体，绝不复读同一句。

### 3.3 关键设计：模型不决定层级

这是本契约里**最重要的一条约束**。原因：

- 如果让模型自行决定层级，实测会出现两个方向的失效：
  ① 学生一喊难就直接给到 L3（等于变相给答案）；
  ② 学生已经快想通了，模型还在机械升级，反而打断他。
- 层级是**教学策略问题**，不是语言问题，因此属于规则引擎。

实现上，模型拿到的 `DraftInput` 里 `level` 是一个**只读入参**，
它只能"在这个层级内把话写好"，不能改变层级。

---

## 四、HTTP 接口契约

> **本节最重要的约定：学生视图与教师视图在服务端分流。**
>
> | 端点 | 谁可以拿 | 内容 |
> |---|---|---|
> | `/api/problem`、`/api/chat`、`/api/report` | 学生 | **白名单投影**：无路径名、无步骤、无指纹、无参考答案、无错因标签、无守卫细节 |
> | `/api/teacher/*` | 带 `TEACHER_KEY` 的人 | 完整图谱、参考答案、三组指纹、逐轮 trace |
>
> 这是**服务端不给**，不是前端不显示 —— 学生打开 F12 也拿不到。
> 判定一个改动有没有破坏它，看 `test/ui.test.js`（密钥扫描）与
> `test/analysis.test.js`（学生载荷反向断言）。

### 4.1 `GET /api/problem?id=<problemId>`

下发题目与学生版解析。**注意：参考答案、错因教研标签、答案指纹、路径内容决不出网。**

```json
{
  "problem": {
    "id": "phy-emi-01",
    "source": "library",              // 或 "imported"
    "subject": "physics",
    "topics": ["电磁感应", "法拉第电磁感应定律", "..."],
    "difficulty": 2,
    "stem": "如图所示，水平放置的两条光滑平行金属导轨……",
    "givens": ["L = 0.5 m", "B = 0.4 T", "..."],
    "asked": ["感应电动势 E", "感应电流 I", "..."],
    "figure": "水平导轨，竖直向上磁场……",
    "stepCount": 8,
    "analysis": {
      "summary": "物理题，考点集中在电磁感应、法拉第电磁感应定律：……",
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
          "meaning": null,                                  // ← 会剧透，所以不给
          "question": "\"匀速\"在力学上等价于什么条件？先把这句话翻译出来。",
          "revealsInsight": true
        },
        {
          "text": "…水平放置的两条光滑平行金属导轨…",
          "label": "接触面光滑",
          "kind": "qualitative",
          "meaning": "摩擦力为零，沿接触面方向上只有重力分量与外力参与，不需要再引入摩擦系数。",
          "question": null,
          "revealsInsight": false
        }
      ],
      "knowledgeGraph": {
        "nodes": [{ "id": "电磁感应", "name": "电磁感应", "role": "core", "level": 1, "note": "" }],
        "edges": [{ "from": "安培力", "to": "电磁感应", "relation": "prereq", "label": "前置" }],
        "edgeSource": "derived",        // model = 读题时模型判断；derived = 按文本推导
        "scope": "topics-only"          // 学生图谱刻意不含步骤概念
      }
    }
  }
}
```

两条刻意的取舍，写在这里以免后人"顺手补全"：

- **没有 `graphSummary` / 路径名。** 路径名（如"电动势—电流—安培力—平衡"）本身就把解法说出来了。
  学生只知道"一共几步"。
- **没有 `conceptTags`。** 曾经有，是 `steps[].concepts` 的汇总 ——
  而那里面包含「电源与内阻」「匀速直线运动合力为零」，**恰好是本题的两个 `solutionInsight`**。
  等于把答案印在题目下面。现在知识点只从 `topics`（章节级）来。

### 4.1b `POST /api/problem/import` —— 读一道新题

**请求**

```json
{ "rawText": "质量为 0.5 kg 的小球从高 h = 20 m 处由静止开始自由下落……", "subjectHint": null }
```

**响应**（`problem` 的形状与 4.1 完全一致）

```json
{
  "problem": { "...": "同上" },
  "intake": {
    "usedModel": true,
    "latencyMs": 9125,
    "topics": ["自由落体运动", "匀变速直线运动"],
    "stepCount": 7,
    "graphReady": true,               // 有答案指纹 ⇒ 数值防泄题有效
    "analysisFromModel": true,
    "conditionCount": 3,
    "notice": "已读懂这道题：条件、目标、知识点与解题路径都已建档（路径对学生不可见，只用于后续引导）。"
  }
}
```

| 状态码 | 含义 |
|---|---|
| 400 | 题干短于 8 字 |
| 422 | 读题失败（模型不可用且降级也失败） |
| 200 | 成功；**降级也会返回 200**，但 `usedModel:false` + `notice` 会写明"路径是通用骨架" |

> 降级返回 200 而不是报错，是刻意的：学生应该拿到一个能用的（哪怕更弱的）引导，
> 而不是一个错误页。代价是"降级"必须**显式可见** —— 所以有 `usedModel` 和 `notice`。

### 4.2 `POST /api/chat`

**请求**

```json
{
  "sessionId": "demo-phy-emi-01-1712345678",
  "problemId": "phy-emi-01",
  "utterance": "我用欧姆定律算电流，电流我直接用 I=E/R 算就行了，电阻只有R",
  "mode": "ai_companion",          // 或 "self_training"
  "explicitHelpSeeking": true
}
```

**响应**

```json
{
  "message": "我理解你的意思是：……\n\n这段电路里，谁是提供电动势的那一部分？\n\n【下一步】检查一下这个规律的前提条件",
  "hint": {
    "level": 1,
    "levelName": "L1 条件追问",
    "form": "condition_question",
    "text": "这段电路里，谁是提供电动势的那一部分？它自身有没有电阻？",
    "concepts": ["闭合电路欧姆定律", "含内阻电路"],
    "nextAsk": "检查一下这个规律的前提条件，然后告诉我哪一条最值得怀疑。",
    "rationale": "层级 L1（condition_question）；首次给出提示，从 L1 条件追问开始"
  },
  "diagnosis": {
    "stepIndex": 4,
    "graphId": "phy-emi-01-g1",
    "confidence": 0.9,
    "feasibility": "partially_viable",
    "stuckKind": "precondition_gap",
    "teacherView": {
      "misconceptionLabels": ["把导体棒当外电路，算电流时漏掉内阻 r"],
      "evidenceQuotes": ["I=E/R", "电阻只有R"],
      "trace": [{ "stage": "locate", "message": "双通道定位：关键词通道=4，语义通道=4，一致 ⇒ 定位第 4 步（置信 0.9）" }]
    }
  },
  "refusal": null,
  "suppressed": false,
  "allowedNextLevel": 2,
  "meta": {
    "engine": "offline-stub",     // 或 "llm"
    "model": null,
    "latencyMs": 3,
    "guardPassed": true,
    "guardBlocked": 0
  }
}
```

**字段语义要点**

| 字段 | 说明 |
|---|---|
| `message` | 学生可见的完整文本（复述 + 提示 + 下一步）。**唯一应该渲染给学生看的字段。** |
| `hint.text` | 仅提示部分，不含复述。用于 UI 分行着色 |
| `hint.levelNote` | 层级的人话版本（"我在问你一个前提"）。给学生的不是 `L1 条件追问` 这种教研语言 |
| `progress` | `{ stepIndex, stepCount, confidenceLabel }` —— 只给"第几步 / 共几步 / 把握粗档" |
| `enginePath` | 引擎判断链路的**学生版投影**（见 §4.6） |
| `understood` | 学生已经想对的地方（正面反馈，报告与鼓励都从这里出） |
| `refusal` | 非空表示本轮走的是"拒绝给答案"路径，`count` 是累计次数（话术递进） |
| `suppressed` | true 表示"决定不介入"（自主训练静默 / 学生已完成） |
| `allowedNextLevel` | 下一轮最多可升到几级，供 UI 提示"再想想还能要提示" |

**响应里刻意不存在的东西**（不是"前端不显示"，是根本没发）：

`diagnosis.stuckKind`、`confidence` 数值、`hint.rationale`、`meta.guardPassed`、
`guardBlocked`、`guardHistory`、错因标签、路径名、步骤标题。

> 早期版本把 `diagnosis.teacherView`（错因标签 + 证据原话 + 完整 trace）
> 和学生消息一起返回，靠前端一个 checkbox 决定显不显示 —— 打开 F12 就能看到。
> 现在这些只在 `/api/teacher/*` 里，且必须带口令。

### 4.3 `GET /api/report?sessionId=<id>`

返回学习报告，结构见 §5。

### 4.4 `POST /api/eval`

一键跑离线评测，返回指标。**用途：路演/评审时当场证明"泄题率 0%"**，
而不是只给一个漂亮的演示截图。

> 入口在学生界面里已经移除了 —— 它是工程质量指标，
> 放在学生页面上学生会以为"AI 在考核我"。现在只在教师视图 → 质量评测里。

### 4.5 `GET /api/health`

返回引擎模式、读题能力、教师视图形态、题目注册表统计。**绝不回传口令本身。**

```json
{
  "engine": "llm",
  "model": "deepseek-chat",
  "llmConfigured": true,
  "keyMask": "sk-91a…789f（共 35 位）",
  "capabilities": { "intake": true, "intakeFallback": true },
  "teacherView": "open",            // open | key | off
  "registry": { "library": 6, "imported": 0, "importTtlHours": 6, "maxImported": 200 }
}
```

### 4.6 教师视图端点（需 `TEACHER_KEY`）

三种形态由**部署形态**决定，不由"有没有配口令"决定（见 `router.js` 的 `teacherMode`）：

| 形态 | 触发条件 | 行为 |
|---|---|---|
| `open` | 本地运行且 `TEACHER_KEY` 留空 | 直接进（自己看图谱/复盘方便） |
| `key` | 配了 `TEACHER_KEY` | 不带口令一律 401 |
| `off` | 公网部署（`api/index.js` 强制置位）且没配口令 | 403，整体关闭 |

**为什么公网一定要 `off`**：教师接口返回的是**完整解题路径 + 参考答案 + 答案指纹**。
如果"没配口令 = 开放"这个默认值跟着代码上了 Vercel，
那份公开链接就等于把答案挂在网上 —— 而这恰恰是最容易发生的疏忽：
本地跑得好好的，部署时没人会想起来"还得去配个口令"。
三档形态在 `test/ui.test.js` 里各有断言，其中一条专门检查
`api/index.js` 那段强制锁死逻辑还在不在（删掉不会有任何报错）。

| 端点 | 返回 |
|---|---|
| `GET /api/teacher/overview` | 跨会话聚合：帮助强度分布、卡点性质分布、会话列表 |
| `GET /api/teacher/session?sessionId=` | 逐轮复盘：层级、卡点性质、定位步骤、**被拦下的原句与违规类型**、学生原话证据、voice 体检、完整 trace |
| `GET /api/teacher/problem?id=` | 完整图谱 + 参考答案 + 三组指纹 + 教师版解析（含剧透标记） |

**引擎判断链路（§4.6 的核心）在两个视图里是两次独立的投影，不是同一份数据加打码**：

| | 学生版 | 教师版 |
|---|---|---|
| 来源 | `prompt.js` 的 `buildStudentEnginePath()` 白名单构造 | `diagnosis.trace` 完整内容 |
| 内容 | 读题 / 听懂（引用学生自己的词）/ 定位（只说第几步）/ 决定（给人话）/ 成文 | 双通道定位数值、冲突与采信、卡点性质、层级策略、守卫违规 |
| 刻意没有 | 错因标签、置信度数字、违规类型、层级策略名、路径名、步骤标题 | —— |

打码依赖"记得打哪里"，每加一个字段都要重审一遍；白名单依赖"允许说什么"，
漏一处只是少说一句话。这和守卫用**封闭词表**而不是黑名单是同一条思路。

### 4.7 其它

| 端点 | 说明 |
|---|---|
| `GET /api/problems` | 题目列表（题库 + 现场导入），导入题会带 `graphConfidence` 标记 |
| `GET /api/demo-scripts` | 演示剧本（典型学生的说法），供现场一键填入 |
| `POST /api/reset` | 清掉某个会话 |


返回引擎模式、是否已配 Key（**只回显脱敏信息**）、提示策略摘要。

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

**注意文案约束**：这个数字衡量的是"**你得到的帮助强度**"，不是"你的水平"。
报告里必须显式说明这一点，否则学生会把它当成分数评价，违背产品主张。

> 这与 proposal 的主张一致：关注"怎么走到这一步"，而不是"答对没有"。
> 因此独立完成度刻意**不用"对了几步"**来算。

### 5.2 深层问题归纳

刻意用**可审计的模式表**而不是聚类算法：

```ts
const DEEPER_PATTERNS = [
  { id: 'precondition-habit',      test: /前提|条件|漏|忘|忽略|误判|混淆|均匀/ },
  { id: 'cross-module-translation',test: /平衡|匀速|受力|运动/ },
  { id: 'tool-selection',          test: /动量|能量|变加速|匀变速|工具|方程/ },
  { id: 'energy-accounting',       test: /做功|能量|热量|焦耳|功率/ },
  { id: 'circuit-modeling',        test: /内阻|回路|电源|并联|隔直|电容/ },
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
| 3 | `level_overflow` | 超出声明层级的内容（L1/L2 出现公式形态） | L0–L2 |
| 4 | `solution_dump` | 编号步骤 >2 个，或推导箭头 >2 个 | 全部 |
| 5 | `final_conclusion` | "所以答案是/最终结果/因此可得"类收口句式 | 全部 |
| 6 | `concept_out_of_domain` | 跑题：引用了本题不存在的物理概念 | 全部 |
| 7 | `solution_insight` | **说出解题核心结论**（如"导体棒是电源，r 是内阻"） | L0–L2 |

第 7 类的判据是"**指派**"而不是"提及"：

- ✅ 允许："谁是提供电动势的那一部分？它自身有没有电阻？"（在问）
- ❌ 拦截："导体棒相当于电源，它的电阻就是内阻。"（在答）

它来自一次真模型实测：那句回复没有公式、没有数值，形式上完全合规，
但学生漏的正是"导体棒有内阻"—— 前 6 类检查全都拦不住。

> **同一套 `solutionInsights` 指纹也被"解析层"复用**（见 `analysis.js` 的 `doesReveal`）。
> 这是刻意的：解析面板里的"关键条件含义"如果会剧透，判定基准必须与守卫完全一致，
> 否则会出现"解析里能说、提示里不能说"的口径矛盾 —— 那种矛盾教研一眼就能看出来，
> 而且会让人不再相信任何一条拦截记录。

### 6.2 检查 1 的双通道设计

- **通道 a**：命中题库的 `answerFingerprints`（教研手工维护，精度高）
- **通道 b**：从 `referenceAnswer` 自动抽取"数值 + 单位"对做兜底（召回高）

通道 b 的存在是为了防"教研漏写指纹"这类**人为疏漏**。
两通道都会排除题干已给的已知量（否则会误判"B = 0.4 T 这个条件你注意到了吗"）。

### 6.3 检查 6 的演进过程（值得记录）

这条规则走了两轮弯路，写下来避免后人重踩：

1. **单字白名单** → 中文虚词太多，守卫自己的兜底模板都被判跑题
2. **二元字组白名单** → 由模板用语构成的白名单永远补不全
   （"先别""你先""看看"这类组合是无穷的）
3. **最终方案：封闭词表** —— 只维护一张"中学物理常见概念"词表，
   当提示提到一个**本题领域里不存在**的词表词条时才拦

判定基准是 `buildDomainText(problem)`：把题目自身所有文本拼起来，
用整体包含判断（而不是分词）。这样"电磁感应"能自然覆盖"感应电动势"。

### 6.4 拦截后的降级重写

| 违规类型 | 重写策略 | 理由 |
|---|---|---|
| `answer_in_text` / `final_conclusion` / `concept_out_of_domain` | 整体替换为安全模板 | 这三类说明模型"没理解题目"或"越了红线"，局部删改救不回来 |
| `formula_leak` / `level_overflow` | 剥离公式片段，保留问句 | 提示骨架通常是好的，只是多了个式子 |
| `solution_dump` | 截断到前两句 | 内容对，但给多了 |

重写后**必须重新校验**；仍不干净则降级。模型最多重试一次，
两次都不过就直接用安全兜底模板 —— **永不泄题优先于文采**。

### 6.5 出口断言

引擎在返回前会断言 `guard.passed === true`，否则**抛错**。
这样做是让"守卫失效"变成一个立刻可见的崩溃，而不是静默地把答案发给学生。

---

## 七、LLM 适配层契约

真模型与离线桩实现**同一接口**，这是"没 Key 也能跑全套测试"的根据。

```ts
interface LLMAdapter {
  readonly kind: 'offline-stub' | 'llm';
  readonly model?: string;
  observeStudent(input: ObserveInput): Promise<Observation>;  // 只做观察
  draftHint(input: DraftInput): Promise<string>;              // 只在层级内写话
}
```

**关键约束：`Observation` 里没有任何"决策"字段。**
它只有"学生说了什么、落在哪一步、像哪类错因"，
没有"该给几级提示"、"是否放行"。

| 实现 | 用途 | 定位方式 | 已知局限 |
|---|---|---|---|
| `createOpenAIAdapter` | 生产路径 | LLM 语义理解 | 依赖 Key；受模型能力影响 |
| `createOfflineAdapter` | 开发/测试/评测基线 | 规则 + 关键词 | 无法处理"完全换一种说法"的表达 |

**离线模式的准确定位**：它的价值是**验证护栏与流程**，而不是验证理解能力。
所有安全指标（泄题率 / 跳级率 / 确认答案 / 解法倾倒）在离线模式下都必须为 0 ——
因为这些问题都在"决策"与"守卫"层，与模型能力无关。

---

## 八、接入企业模型时的适配点

按 proposal §三 的诉求，接企业模型只需改一处：

1. 在 `.env` 填 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`
2. 若企业模型是 OpenAI 兼容协议 → **无需改代码**
3. 若是私有协议 → 只需实现 `LLMAdapter` 接口的两个方法
   （`observeStudent` / `draftHint`），其余全部复用

需要企业提供的能力清单：

| 需要 | 用途 | 是否阻塞 |
|---|---|---|
| OpenAI 兼容 chat completions | 观察 + 起草 | 是 |
| JSON 输出稳定（`response_format`） | 结构化解耦 | 建议；有三级容错兜底 |
| 视觉模型（VL） | 拍照识题（proposal 环节①） | 否，可后置 |
| 知识图谱/知识点标签 | `Problem.topics` 对齐 | 否，可先用教研标注 |
