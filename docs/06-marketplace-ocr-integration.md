# 云市场题目 OCR 接入研究（cmapi00043052）

> ## ✅ 状态：已接通，端到端跑通
>
> ```
> 拍照 PNG(44KB) ──► /api/ocr ──► OCR 863ms ──► /api/problem/import ──► 图谱(6步/6条件/0告警)
> ```
> 实测：**2 次识别调用**（预算 40 次），端到端 1.1 秒，读题 8.9 秒，知识点全部命中。
> 测试 **265/265 通过**。
>
> 配套工具：[scripts/ocr-verify.js](../scripts/ocr-verify.js)（首次验收，1 次调用）·
> [scripts/ocr-path-probe.js](../scripts/ocr-path-probe.js)（探路径，网关 404 不计费）
>
> **2026-10 补充**：视图层重做为五页流程后，拍照入口挪到页一输入框右下。
> 本文件记录的仍是云市场通道的契约与实测质量；通道选择与视图层约束见
> [docs/04 §6.3](04-intake-and-views.md#63-拍照识题本轮启用)。
>
> 成本结论见 [docs/05-ocr-feasibility.md](05-ocr-feasibility.md)；
> 本文件记录**接入契约与实测质量**。

---

## 〇、实测确认的契约（不是猜的）

商品页「API 接口」栏给出的契约，以及**真实调用验证过的**结果：

| 项目 | 值 | 验证方式 |
|---|---|---|
| 调用地址 | `https://mquestion.market.alicloudapi.com/ocrservice/mathQuestion` | 真实调用 HTTP 200 |
| 请求方式 | POST，`Content-Type: application/json; charset=UTF-8` | 契约 + 真实调用 |
| 认证 | `Authorization: APPCODE <AppCode>` | 真实调用 |
| 请求体 | `{"img":"<纯base64>","prob":false,"rotate":false}` | 真实调用 |
| 图片限制 | base64 后 ≤4M；最短边 ≥15px；最长边 ≤4096px；jpg/png/bmp | 契约 |
| 成功响应 | `{"content":"整段题干…","figure":[…]}` | **实测** |
| 失败响应 | `{"error_code":400,"error_msg":"img和url参数不能同时为空","requestId":"…"}` | **实测** |

### 三个"与常见做法相反"、写错就必然失败的细节

1. **请求体是 JSON，不是表单。** 云市场多数接口用 `x-www-form-urlencoded`，
   这一个偏偏是 JSON —— 用表单提交会得到参数错误。
2. **图片字段名是 `img`，值是纯 base64，不能带 `data:image/jpeg;base64,` 前缀。**
   而 ShowAPI 系的通用 OCR 接口**正好相反**（要求带前缀）。
3. **没有 `showapi_res_code` / `ret_code` 那层信封** —— 是扁平结构，错误用
   `error_code` / `error_msg`。我原先按云市场通用形态预设了解析，
   **第一次真机测试就被纠正了**（见 `parseOcrResponse` 的注释）。

> 这三条都是"看起来一样、错了不报错只失败"的那类细节，
> 所以全部固化成断言（`test/ocr.test.js` 的「契约」一组）。

---

## 〇之二、为什么没继续试路径（一个有用的排查经验）

在拿到地址之前，我做过一轮零成本探测，结论值得记下来：

| 请求 | 结果 | 含义 |
|---|---|---|
| `tysbgpu.../api/predict/ocr_general` + AppCode | **401** | 路径存在、AppCode 被网关认了，但未授权 |
| 同地址 + 乱写的 AppCode | 404 | 不存在的路径 |
| 不带认证头 | 400 | 网关要求认证 |
| `tysbgpu` 上的 10 个题目识别候选路径 | 全 404 | **它们根本不在这台网关上** |

真相是题目识别在**独立域名** `mquestion.market.alicloudapi.com` 上。

**可复用的判据**：
- 网关 404 = 路径不存在（不计费，可以放心试）
- 网关 401 = **路径存在但未授权** —— 这是最有价值的一档，
  它同时证明了"域名对、路径对、AppCode 有效，只是没买那条 API"
- 网关 400（不带认证头时）= 网关要认证

这套判据把一个原本要烧调用次数的探索变成了零成本探索。

---

## 〇之三、实测识别质量（真实样题，含公式与单位）

输入是一张 1100×620 的题图（印刷体，含 Ω / m/s / 上下标）：

**识别文本（原样，未做任何清洗）**：

```
如图所示，水平放置的两条光滑平行金属导轨间距为 \mathsf{L}=0.5\；\mathsf{m}，
处于竖直向上的匀强磁场中，磁感应强度 \mathsf { B } = 0 . 4 \： \mathsf { T } _ { \circ } ，
导轨左端接有 电动势 \mathsf{E}0\，=\，1.5\，\，\mathsf{V}、 内阻 \mathsf{r}=0.1~Ω 的电源，
右端接有阻值 \mathsf{R}=0.3\：Ω 的电阻。一根质量 \mathsf{m}=0 .2kg的导体棒垂直放在导轨上，
在水平外力 作用下沿导轨以恒定速度 v=2\mathsf{m/s} 向右匀速运动。导轨电阻不计。
求：(1)导体棒中的感应电流Ⅰ的大小和方向； (2)水平外力F的大小； (3)外力做功的功率P。
```

**下游效果（关键）**：这份带 LaTeX 噪声的文本直接进读题链路，
**6 步路径 / 6 条关键条件 / 0 告警 / 图谱可用**，
知识点识别正确：电磁感应、法拉第电磁感应定律、安培力、闭合电路欧姆定律、功率。

**也就是说：OCR 的格式噪声被读题模型吸收了。** 这验证了"两段式"的设计选择 ——
OCR 只负责"把图变成字"，理解交给专门做理解的模型，而不是要求 OCR 直接输出干净题干。

### 但有三条真实缺陷，必须记下来（都不报错，只让结果悄悄变差）

| # | 现象 | 影响 | 应对 |
|---|---|---|---|
| 1 | **下标丢失**：`E0 = 1.5 V`（原文是 E₀） | 已知量符号不精确，但不影响读题 | 人工确认环节可见；不必自动纠正 |
| 2 | **LaTeX 带空格噪声**：`0 . 4`、`\mathsf { B }`、`0.1~Ω` | ⚠️ **直接影响 `answerFingerprints` / `formulaFingerprints` 的正则匹配** —— 指纹按紧凑写法生成就匹配不上，守卫会**静默失效** | 见下方"待办" |
| 3 | **图形未被检测**：题图里有人工配图，但 `figure` 返回 0 处 | 含图题的几何条件丢失，而引擎照常建档、不报错 | 已是已知风险，见 05 文档第五节第 3 条 |

> 第 2 条是本次实测**最有价值的发现**：它在 05 文档的风险清单里被列为"必须专门测的一条"，
> 现在有了实证。建议下一步在 `intake.js` 生成指纹时对文本做一次归一化
> （去空格、统一 `\mathsf{}/~/\；` 等 LaTeX 噪声），否则"OCR 来的题"守卫强度低于"粘贴来的题"。

---

## 一、第一个必须澄清的事：这是两套完全不同的接入方式

你给的链接 `market.aliyun.com/detail/cmapi00043052` 是**云市场 API 网关**商品，
它和我在评估里推荐的阿里云官方 OCR 接口**不是同一个东西**，接入方式没有任何共同点：

| | 官方 POP 接口（评估里的推荐） | **云市场商品（你买的这个）** |
|---|---|---|
| 标识 | `Product=ocr-api` `Action=RecognizeEduQuestionOcr` | `cmapi00043052`（`sku=yuncode37052000011`） |
| 鉴权 | AccessKey ID/Secret + **V3 签名**（HMAC-SHA256） | **AppCode 简单认证** |
| 凭据形态 | AK/SK 一对 | **一个 AppCode 字符串**（不是 AppKey！） |
| 请求体 | JSON 或二进制 body | **表单** `application/x-www-form-urlencoded` |
| 参数名 | `Url` / `body` / `NeedRotate`（官方文档明确） | **由服务商定义，须查该商品的接口文档** |
| 上限/计费 | 官方 OCR 的免费额度与按量计费 | 按**调用次数**计费（你已购的规格） |
| 要不要手写签名 | 要（零依赖下约 60~80 行） | **不要** —— 一个请求头就完了 |

**好消息**：你选的这条路**工程上更简单**。原本评估里"中低难度"的那一块（手写 V3 签名）**直接消失了** ——
AppCode 只要一个请求头：

```
Authorization: APPCODE <你的AppCode>
```

（官方文档：[使用简单认证（AppCode）方式调用API](https://help.aliyun.com/zh/api-gateway/traditional-api-gateway/user-guide/call-an-api-operation-by-using-an-appcode)。
也支持放进 Query 参数 `AppCode=`，但文档明确提醒：**AppCode 是明文传输，必须走 HTTPS**，
并且**只能放服务端**，绝不能下发到浏览器。）

---

## 二、术语更正：你要给我的是 AppCode，不是 AppKey

这两个是不同的东西，给错了会直接 403/401，而且错误信息很像"代码写错了"：

| 名称 | 用途 | 怎么来的 |
|---|---|---|
| **AppCode** | 简单认证（云市场商品**默认用这个**） | 云市场购买后，在 **API 网关控制台 → 调用 → 应用管理** 里那个 App 的详情页；云市场买家控制台也能看到 |
| AppKey + AppSecret | 摘要签名认证（另一条路，要自己算签名） | 同一页面的密钥对 |

你要给我的是 **AppCode**（一串大写十六进制，形如 `3F2504E04F8911D39A0C0305E82C3301`）。

⚠️ 另外：如果你说的"appkey"其实是指 **ShowAPI（万维易源）控制台**里那个 `appKey`，
那说明你买的可能是 ShowAPI 自营商品而不是这个阿里官方商品 —— 那是**第三套**接入方式
（域名 `https://route.showapi.com/<编号>-<接入点>?appKey=…`，见第五节）。请确认一下你控制台里看到的是哪个。

---

## 三、还差什么才能写代码：只有"参数名与返回字段名"

云市场商品的**接口地址、参数名、返回字段名由服务商自定义**，
而 `market.aliyun.com` 的商品页是**前端渲染**的 —— 我用 `web_fetch` 抓不到文档正文
（只拿到标题，正文是 JS 渲染的）。所以这部分**无法从公开渠道可靠确认**，只能两条路取一条：

1. **你贴文档**（最快、不花调用次数）
   云市场买家控制台 → 已购服务 / 我的服务 → 该商品 → **「接口文档」**页，把三块贴给我：
   - 接口地址（形如 `https://xxxx.market.alicloudapi.com/...`）
   - 请求参数表（名称 / 类型 / 必填 / 说明）
   - 返回参数表（名称 / 类型 / 说明）
2. **跑探测脚本**（不用贴文档，消耗几次调用次数）
   见下一节。

---

## 四、探测脚本：用最少调用次数把真实契约问出来

```bash
# 本地图片（推荐）：脚本会自动转成 dataURL 表单字段
node scripts/ocr-probe.js --appcode <你的AppCode> --image .\样题.jpg

# 或公网图片 URL
node scripts/ocr-probe.js --appcode <你的AppCode> --image https://.../a.png

# 控制消耗：默认最多 8 次、成功即停；可调小
node scripts/ocr-probe.js --appcode <AppCode> --image .\样题.jpg --limit 4
```

它做的事：按"最可能 → 最不可能"的顺序，逐个尝试**候选请求形状**
（3 个常见网关域名 × 4 个路径 × 5 个参数名 + AppCode 放 Query + 只传 URL 的形态，共 62 个候选），
每次打印 HTTP 状态、返回信封里的状态码（`showapi_res_code` / `ret_code` / `code` / `error`）、
以及返回 JSON 的**结构摘要**；一旦从返回里抽出一段像题干的中文文本就停，并把结论打印成
"可直接贴给我"的四行：请求地址、参数名、鉴权方式、文本路径。

**它不会**：写文件、改项目代码、把 AppCode 落盘（只从命令行或环境变量 `ALIYUN_OCR_APPCODE` 读）。

拿到那四行之后，`src/core/ocr.js` 就是一张配置表 + 一个 fetch 调用 —— 真正的实现量很小。

---

## 五、已知的两类"云市场 OCR"返回形态（脚本已能自动识别）

从公开资料能确认的云市场/ShowAPI 家族返回结构（脚本的 `describeEnvelope` 已覆盖）：

```jsonc
// 形态 A：ShowAPI 风格信封（万维易源系，最常见）
{
  "showapi_res_code": 0,          // 系统级：0 = 请求通了（≠ 业务成功！）
  "showapi_res_id": "...",
  "showapi_res_error": "",
  "showapi_fee_num": 1,
  "showapi_res_body": {
    "ret_code": 0,                // 业务级：真正看这个
    "remark": "",
    "str": "识别出的整段文字，换行分隔",   // 默认返回这个
    "list": [ { "text": "...", "confidence": 0.996, "text_region": [[373,40],[683,40],[683,65],[373,65]] } ]
  }
}
```

要点（对写适配器很关键）：

- **先判 `ret_code` 再取文本**：`showapi_res_code=0` 只代表通道通了，业务可能失败而 `str` 为空。
- `list` 与 `str` **由 `need_all_region` 决定返回哪个**，不要写死同时取。
- 常见业务错误码（用于给用户**人话**提示，而不是抛一个原始码）：
  `10` 参数错误 · `20` 文件格式错误 · `40` 文件下载失败 · **`50` 文件内容过大** ·
  `60` 图片解析失败 · `70` OCR 识别失败（无文字/不清晰） · `80` 服务超时 · `90` 识别异常。
  来源：[万维易源 OCR 返回字段指南](https://www.showapi.com/guides/6a96527a4ddd79ab6700bd48)。
- **体积上限比官方接口小得多**：ShowAPI 系印刷体 OCR 是 **base64 ≤0.7MB / URL ≤1MB，且建议像素 < 1200×1200**。
  这比官方 `RecognizeEduQuestionOcr` 的 10MB 严格得多 —— **前端必须压缩**（见第七节）。
- 参考资料：[ShowAPI 印刷体 OCR 接口 926-1 的 OpenAPI 描述](https://www.showapi.com/openapi/market/926.json)（含每个字段的原文说明）。

> 注意：**这是同家族产品的形态，不等于你买的那个商品的确切形态。**
> 脚本会打印真实返回，以实测为准 —— 上面这些只是用来让解析有准备，不是拿来当契约用的。

---

## 六、不用等 AppCode 就能定的部分（已完成）

| 事项 | 结论 |
|---|---|
| 鉴权方式 | `Authorization: APPCODE <code>` 请求头；或 Query `AppCode=`；**必须 HTTPS**；**只能服务端** |
| 请求编码 | 表单 `application/x-www-form-urlencoded; charset=UTF-8`（**不是 JSON**） |
| 图片怎么传 | 本地文件 → base64（多数这类接口要求带 `data:image/jpeg;base64,` 前缀）；或公网 URL |
| 要不要签名 | **不要**（AppCode 简单认证） |
| 走哪里 | 服务端。浏览器直连会把 AppCode 暴露给任何人 |
| 降级策略 | 没配 AppCode → `/api/ocr` 返回明确提示，**绝不伪造识别结果**（沿用项目现有原则） |

---

## 七、接入设计（拿到契约后按此实现，改动很小）

```
浏览器                          服务端                        云市场
  │  选图 / 拖拽 / 拍照
  │  canvas 压缩到长边 ~1600px、quality 0.8
  │  （目标 < 700KB，因为这类接口上限远小于官方 10MB）
  ├── POST /api/ocr  { image: dataURL } ──►│
  │                                        │ 体积/格式前置校验
  │                                        ├── 表单 POST + APPCODE 头 ──►│
  │                                        │◄── 信封 JSON ────────────────┤
  │                                        │ ret_code 判定 → 归一化
  │◄── { rawText, figures?, latencyMs, provider } ──┤
  │
  │  ★ 回填到 #stem-input，**不自动导入**
  │  ★ 学生看一眼 / 改错字，再点「读懂这道题」
  └── POST /api/problem/import { rawText } ──►（既有链路，一行不改）
```

**为什么坚持"回填 + 人工确认"而不是一键直通**：OCR 错一个数值 → 已知量错 → 提示全错 →
学生会认为产品不行。这一步把 OCR 错误从**故障**降级为**可修正的输入**，是整个接入里性价比最高的一条设计。

### 要动的文件

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/core/ocr.js` | **新建** | 契约配置表 + 表单 POST + 信封归一化 + 错误码→人话 + 无 Key 降级 |
| `src/server/router.js` | 改 | 新增 `POST /api/ocr`；[router.js:204](../src/server/router.js#L204) 的 1MB 读体上限需协调 |
| `public/app.js` | 改 | `handleImage`（[app.js:1489](../public/app.js#L1489)）：压缩 → 调接口 → 回填输入框；`OCR_PLAN`（[app.js:1365](../public/app.js#L1365)）文案更新 |
| `public/index.html` | 改 | [index.html:149](../public/index.html#L149) "这一环还没接" → 真实状态 |
| `.env` / `.env.example` | 改 | `ALIYUN_OCR_APPCODE` / `ALIYUN_OCR_ENDPOINT` / `ALIYUN_OCR_IMAGE_FIELD`。**`env.js` 不用改** |
| `src/server/server.js` | 改 | 启动日志加一行 OCR 可用性（AppCode 用 `maskSecret` 脱敏） |
| `api/index.js` | 改 | 公网 Demo 比照 [api/index.js:35](../api/index.js#L35) **强制关闭 OCR**，否则公开链接会烧你的调用次数 |
| `test/ocr.test.js` | **新建** | 信封解析、错误码映射、无 Key 降级、**AppCode 不外泄**、路由契约 |
| `test/run.js` + `README.md` + `docs/周报.md` | 改 | 注册套件；⚠️ [test/docs.test.js:94](../test/docs.test.js#L94) 会核对用例总数，必须同步 |

---

## 八、我需要你给的东西（按优先级）

| # | 要什么 | 为什么 |
|---|---|---|
| 1 | **AppCode**（不是 AppKey；控制台里的 AppCode 值） | 唯一凭据 |
| 2 | 该商品**接口文档**里的：接口地址 + 请求参数表 + 返回参数表 | 有它就不用盲试，`src/core/ocr.js` 可以直接写死契约 |
| 3 | **一张真实样题照片**（本地文件路径即可） | 探测脚本需要；也用来验证公式识别质量 |
| 4 | 确认一下：你控制台看到的是「云市场已购服务」还是「ShowAPI/万维易源 appKey」 | 决定走第一/第五节哪一套 |

**顺序建议**：先给 1 + 3，我跑探测脚本把真实契约问出来；如果 2 顺手能贴，那就更快、一次调用都不用花。

> ### 已全部拿到 ✅
>
> 地址、参数名、AppCode 都已确认并写进 `.env`，无需再提供任何东西。
> 剩下要做的只有**人工质量验收**（见 〇之三 的三条缺陷）。

---

## 九、本轮实现与验收

| 文件 | 内容 |
|---|---|
| [src/core/ocr.js](../src/core/ocr.js) | 契约表（JSON 体 / `img` 纯 base64 / `prob`+`rotate`）、扁平信封解析、错误码→人话、阅读顺序排序、按次计费的失败分支策略 |
| [src/server/router.js](../src/server/router.js) | `POST /api/ocr`；按路由分档的读体上限；调用前的体积校验；已验证形状的进程级缓存 |
| [public/app.js](../public/app.js) | canvas 压缩（长边 1600 / JPEG 0.85 / 白底）、调接口、**回填输入框而不自动导入**、区分"是否已计费"的失败提示 |
| [public/index.html](../public/index.html) | 入口文案改为真实状态（可用性由 `/api/health` 决定） |
| [api/index.js](../api/index.js) | 公网部署默认清除凭据（`PUBLIC_DEMO_ALLOW_OCR=1` 才开） |
| [test/ocr.test.js](../test/ocr.test.js) | 50 个用例：契约、错误码、省钱语义、凭据不外泄、真实 HTTP 路由 |

### 验收结果（实测）

| 项 | 结果 |
|---|---|
| 端到端耗时 | OCR 863 ms + 读题 8.9 s |
| 候选探索开销 | **1 次**（地址确定后无探索） |
| 下游可用性 | `graphReady=true`，6 步 / 6 条件 / 0 告警 |
| 知识点识别 | 电磁感应、法拉第电磁感应定律、安培力、闭合电路欧姆定律、功率（全对） |
| 识别调用消耗 | **2 次** / 预算 40 次 |

### 可复制的验收命令（各花 1 次调用）

```bash
# 首次验收：确认契约 + 看识别质量（脚本对真实识别只发一次请求，不重试）
node scripts/ocr-verify.js --appcode <AppCode> --image .\样题.jpg

# 完整链路：拍照 → OCR → 读懂（服务已启动时）
node -e "..."   # 见 〇之三 的实测；或直接在页面里点「识别成题干」
```

### 三个只有"真起服务"才暴露出来的坑（已修，均有断言守着）

1. **`req.destroy()` 会让 413 变成"网络错误"。**
   超限时先 destroy 再写响应 ⇒ socket 在响应发出前被掐断 ⇒ 客户端看到 `fetch failed`。
   学生会以为网络不好、反复重试 —— 而每次重试都在烧调用次数。
2. **`req.pause()` 会死锁。** 客户端在等响应、服务端在等 body，测试直接挂住。
   正确做法：**继续读完但一个字节都不再存**，内存占用封顶在阈值附近。
3. **预设的返回信封是错的。** 按云市场通用形态（`showapi_res_code` / `ret_code`）写的解析，
   在真实响应（扁平 `content` / `error_code`）面前会**静默失败** ——
   表现为"识别成功但输入框是空的"。真机一次调用就纠正了它。

这三条的共同特征：**不报错，只让产品悄悄变差**。

---

**这份研究做了什么**：核对了云市场 AppCode 认证的官方文档、抓取并核对了同家族 OCR 接口的 OpenAPI 字段定义与业务错误码、
确认了商品页无法抓取正文这一事实、写好了探测脚本并实测了它的参数校验与错误处理路径。
**没做什么**：没有调用过你的接口（没有 AppCode），没有写入任何凭据，没有猜一个参数名就当成契约写进代码。
