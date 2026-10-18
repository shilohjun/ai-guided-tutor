# 学术版配色系统 · 落地说明

**产物**：`v3.html`（单文件，样式 + 逻辑齐全，可直接双击打开）· `preview/`（8 张双主题截图）
**基线**：由 `v2.html` 逐处改写而来，**没有重画页面结构**。原文件的应用逻辑（`<script>`）逐字节保留，只做了 6 处必要补丁（见 §4.6）。
**验证**：Chrome 实测 22/22 项主题控制器断言通过；对比度全部用脚本按 WCAG 2.x 公式实算，不靠肉眼。

---

## 0. 先定位：原文件到底用了哪些色

改色之前先把 `v2.html` 的内联样式拆出来盘点（`<style>` 里 100 个 hex、27 个 rgba）。结论是**它不是"配色不好看"，是根本没有配色系统**：

| 问题 | 证据 |
|---|---|
| 主按钮用的是灰钢蓝，不是藏青 | `.primary{background:#344b68}`，`hsl(212,29%,32%)`，饱和度只有 29%，偏灰 |
| 真正的蓝色是一个消费级 SaaS 电光蓝 | `#3563E9` 出现 **10 次**：进度条、上传图标、勾选、步骤序号、焦点环底色。`hsl(225,81%,56%)`，饱和度 81% —— 正是规范里点名要避免的"科技蓝" |
| 焦点环几乎不可见 | `outline:3px solid #a6bbfa`，对白底 **1.89:1**，规范要求 ≥3:1 |
| 弱化文字全部不达标 | `#6c7481` 对 `#f7f7f7` = **4.40:1**；`#788393` 对白 = **3.84:1**。都是 12–14px 的正文级文字 |
| 组件里大量裸写 hex | `button`、`.card`、`textarea`、`.tag`、`.badge` 各写各的白底/灰边，没有任何变量 |
| 语义色靠 emoji | 报告页用 `✅ ⚠ ❌` 表状态，系统 emoji 是**高饱和彩色**，且跨平台不一致 |
| 一套 CSS 里塞了 3 个版本 | 41 行 `body[data-version="1"|"3"]` 覆盖，只用得上 v2 那套 —— 本次作为死代码删除 |

**结论**：不是换几个颜色，而是要把"色值"换成"语义 token"，再让组件只读 token。

---

## 1. 色值映射：旧 hex → 新语义 token

这张表就是实际替换清单，左侧每一行在原文件里都能搜到。

### 1.1 背景与文字

| 旧值 | 原用途 | 新 token | 新值（浅色） |
|---|---|---|---|
| `#f7f7f7` | `body` 背景 | `--bg-page` | `#F7F8F5` 暖纸白（去掉冷灰，加一点黄） |
| `#292d33` | `body` 正文 | `--text-primary` | `#23231F` 深棕黑 |
| `white` / `#ffffff` | 卡片、按钮、输入框、下拉 | `--bg-surface` | `#FFFFFF` |
| — | 卡片内抬升层 | `--bg-elevated` | `#FFFFFF`（深色才拉开） |
| `#f0f3f8` | 按钮 hover、AI 气泡 | `--bg-hover` / `--bg-sunken` | `#EEF0EC` |
| `#e8effa` | 用户气泡 | `--bg-selected` | `#EDF2F8`（藏青 50） |
| `#24324b` | Toast 底 | `--toast-bg` → `--bg-inverse` | `#1B3050` |
| `#6c7481` | `.muted` | `--text-muted` | `#696C64`（4.7:1，原值 4.4 不达标） |
| `#6b7280` / `#66758c` | 上传提示、指标标签、等待文案 | `--text-muted` / `--text-secondary` | `#696C64` / `#5C5F58` |
| `#788393` | 消息角色名、空态文字 | `--text-muted` | `#696C64`（原 3.84:1 → 5.34:1） |
| `#5b6677` | `.tag` 文字 | `--text-secondary` | `#5C5F58` |

### 1.2 描边

| 旧值 | 原用途 | 新 token | 新值 |
|---|---|---|---|
| `#dddddd` / `#dde1e6` / `#e3e7ec` / `#e5eaf0` | 分割线、卡片边 | `--border` | `#E2E4DF` |
| — | 更弱的发丝线 | `--border-subtle` | `#EDEFEA` |
| `#cbd4e3` / `#abb5c7` | 虚线框、下拉边 | `--border-strong` | `#C9CCC5` |
| `#d3d7dd` / `#d7dce2` | 按钮边、输入框边 | `--border-control` | `#8A8C85`（**3.4:1**，见 §7 说明） |
| `#55739d` | 选中卡片边 | `--brand` | `#2E4E7A` |
| `#d8e0ee` | 步骤连接线 | `--border` | `#E2E4DF` |

### 1.3 品牌与状态

| 旧值 | 原用途 | 新 token | 新值 |
|---|---|---|---|
| `#344b68` | 主按钮 | `--brand` | `#2E4E7A` 藏青 700 |
| `#243a55` | 主按钮 hover | `--brand-hover` | `#243F63` |
| `#3563e9` ×10 | 进度条/勾选/序号/图标 | `--brand` | `#2E4E7A` |
| `#eaf0ff` | 步骤序号底 | `--bg-sunken` | `#EEF0EC` |
| `#eff4fc` | 选中卡片底 | `--bg-selected` | `#EDF2F8` |
| `#a6bbfa` | 焦点环 | `--focus-ring` | `#2E4E7A`（**7.9:1**） |
| `#546b89` | 模式图标 | `--brand` | `#2E4E7A` |
| `#377852` / `#eff8f0` | 掌握徽标 | `--success-ink` / `--success-tint` | `#2A6B46` / `#E7F3EC` |
| `#94601e` / `#fff6e7` | 待巩固徽标 | `--warning-ink` / `--warning-tint` | `#8E6410` / `#FAF1DE` |
| `#a55252` / `#fff0f0` | 薄弱徽标 | `--danger-ink` / `--danger-tint` | `#A3352F` / `#FBEDEC` |
| `#a33c3c` | `.error` 文字 | `--danger` | `#B33A3A`（5.86:1） |
| `#f3f6fb` / `#5a6680` | `.notice` | `--accent-amber-tint` / `--text-primary` | `#FAF1DE` / `#23231F` |
| `#f8f9fb` / `#eff2f6` | 空态、骨架屏 | `--bg-sunken` | `#EEF0EC` |
| `#f7f9fc` | 推荐问题 chip | `--bg-sunken` | `#EEF0EC` |
| `#e8edf6` | 进度条轨道 | `--bg-sunken` | `#EEF0EC` |

> 一处刻意保留的"反转"：`.primary` 原来是 `#344b68`（灰钢蓝），新值 `#2E4E7A` 色相相同但饱和度从 29% 提到 45%，**更藏青、也更沉**，不是简单换蓝。

---

## 2. 两层 Token 清单

命名约定：`--prim-{色族}-{明度}`，数字越小越浅；组件**只允许**引用语义层。

### 2.1 Primitive（只存色名与色值）

```css
/* 藏青 / 靛蓝 —— 主色 */
--prim-navy-050:#EDF2F8;  --prim-navy-100:#C9D8EA;  --prim-navy-200:#9FBCE6;
--prim-navy-300:#7FA3D4;  --prim-navy-400:#5A82B6;  --prim-navy-500:#4A6C9C;
--prim-navy-600:#3A5C8C;  --prim-navy-700:#2E4E7A;  --prim-navy-800:#243F63;
--prim-navy-900:#1B3050;  --prim-navy-950:#16273A;

/* 学院青绿 —— 辅助 */
--prim-teal-050:#E8F2EF;  --prim-teal-100:#C3DCD4;  --prim-teal-300:#5CC4AE;
--prim-teal-500:#2E9581;  --prim-teal-700:#1F7A68;  --prim-teal-800:#17604F;

/* 琥珀金 —— 点缀 */
--prim-amber-050:#FAF1DE; --prim-amber-100:#EBD7AC; --prim-amber-300:#E0B45C;
--prim-amber-500:#C99A34; --prim-amber-700:#B07D17; --prim-amber-800:#8E6410;

/* 学术版状态色：低饱和，无 sRGB 纯红纯绿 */
--prim-green-050:#E7F3EC; --prim-green-150:#C4DECE; --prim-green-300:#63B884;
--prim-green-700:#2E8B57; --prim-green-800:#2A6B46;
--prim-red-050:#FBEDEC;   --prim-red-150:#E9C9C6;   --prim-red-300:#D96A6A;
--prim-red-700:#B33A3A;   --prim-red-800:#A3352F;

/* 暖纸白 / 深棕黑（浅色主题中性色） */
--prim-paper-000:#FFFFFF; --prim-paper-050:#F7F8F5; --prim-paper-100:#EEF0EC;
--prim-paper-150:#EDEFEA; --prim-paper-200:#E2E4DF; --prim-paper-300:#C9CCC5;
--prim-paper-500:#8A8C85;
--prim-ink-950:#1C1C17;   --prim-ink-900:#23231F;
--prim-ink-600:#5C5F58;   --prim-ink-500:#696C64;

/* 深海蓝（深色主题中性色） */
--prim-abyss-950:#0A0F15; --prim-abyss-900:#0E141B;
--prim-abyss-800:#141C25; --prim-abyss-700:#1B2530;

/* 深色主题下语义色的低饱和底 */
--prim-abyss-teal:#0C1715; --prim-abyss-amber:#241B0D;
--prim-abyss-green:#0F2119; --prim-abyss-red:#241315;
```

### 2.2 Semantic（浅色 `:root` / 深色 `[data-theme="dark"]`）

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bg-page` | `paper-050` | `abyss-900` | 页面底 |
| `--bg-surface` | `paper-000` | `abyss-800` | 卡片 |
| `--bg-elevated` | `paper-000` | `abyss-700` | 抬升层（仅深色有差） |
| `--bg-sunken` | `paper-100` | `abyss-950` | 内嵌 / 代码块 / 空态 |
| `--bg-hover` | `paper-100` | `abyss-700` | hover |
| `--bg-selected` | `navy-050` | `navy-950` | 选中 |
| `--bg-inverse` | `navy-900` | `abyss-700` | 反色面（Toast） |
| `--border-subtle` | `paper-150` | `rgba(150,180,220,.09)` | 发丝线 |
| `--border` | `paper-200` | `rgba(150,180,220,.14)` | 卡片边（装饰） |
| `--border-strong` | `paper-300` | `rgba(150,180,220,.26)` | 强分割 |
| `--border-control` | `paper-500` | `rgba(150,180,220,.58)` | **交互控件边（≥3:1）** |
| `--text-heading` | `ink-950` | `#F2F6FA` | 标题（比正文深一档） |
| `--text-primary` | `ink-900` | `#E8EDF2` | 正文 |
| `--text-secondary` | `ink-600` | `#A6B2BF` | 次级 |
| `--text-muted` | `ink-500` | `#84909E` | 弱化（已提到 4.5+） |
| `--text-inverse` | `paper-050` | `abyss-900` | 反色文字 |
| `--text-on-brand` | `paper-050` | `abyss-900` | 主色上的文字 |
| `--brand` | `navy-700` | `navy-300` | 主色 |
| `--brand-hover` | `navy-800` | `navy-200` | 主色 hover |
| `--brand-active` | `navy-900` | `navy-100` | 主色 active |
| `--brand-tint` | `navy-050` | `navy-950` | 主色染底 |
| `--brand-tint-border` | `navy-100` | `#2C4460` | 主色染底描边 |
| `--accent-teal` | `teal-700` | `teal-300` | 推导 / 正确 |
| `--accent-teal-tint` | `teal-050` | `#0C1715` | 公式块底 |
| `--accent-teal-border` | `teal-100` | `#1A342E` | 公式块描边 |
| `--accent-amber` | `amber-700` | `amber-300` | 待讨论 / 进行中（**图形**） |
| `--accent-amber-ink` | `amber-800` | `amber-300` | 琥珀色**当文字**时用 |
| `--accent-amber-tint` | `amber-050` | `#241B0D` | 提示块底 |
| `--accent-amber-border` | `amber-100` | `#3E3115` | 提示块描边 |
| `--success` / `-ink` | `green-700` / `green-800` | `green-300` | 掌握 |
| `--success-tint` / `-border` | `green-050` / `green-150` | `#0F2119` / `#1F3B2C` | 徽标底 |
| `--warning` / `-ink` | `amber-700` / `amber-800` | `amber-300` | 待巩固 |
| `--warning-tint` / `-border` | `amber-050` / `amber-100` | `#241B0D` / `#3E3115` | 徽标底 |
| `--danger` / `-ink` | `red-700` / `red-800` | `red-300` | 错误 |
| `--danger-tint` / `-border` | `red-050` / `red-150` | `#241315` / `#45262A` | 错误块 |
| `--focus-ring` | `navy-700` | `navy-300` | 焦点环 |
| `--selection-bg` | `#D8E4F1` | `#2B4260` | 文字选中 |
| `--shadow-card` / `--shadow-pop` | 双层极轻 | 更重、更深 | 阴影 |
| `--toast-bg` / `--toast-border` | `bg-inverse` / `navy-900` | `bg-inverse` / `rgba(...,.26)` | Toast |
| `--logo-tint-alpha` | `.55` | `.26` | Logo 渐变透明度 |

> **深色为什么这样调**：不是把浅色值反过来。品牌色从 `#2E4E7A` 提到 `#7FA3D4`（HSL 明度 33%→66%），饱和度保持 45–48% 而**没有拉满**；青绿 `#1F7A68`→`#5CC4AE`、琥珀 `#B07D17`→`#E0B45C` 同理。语义底（如公式块）用 `#0C1715` 这种"几乎中性"的深色，避免整块发绿。

### 2.3 非颜色 token

| Token | 值 | 说明 |
|---|---|---|
| `--font-serif` | Source Serif 4 → Noto Serif SC → 思源宋 → Songti SC → STZhongsong → SimSun | 标题、指标数字 |
| `--font-sans` | Inter → Noto Sans SC → PingFang SC → 微软雅黑 | 正文 |
| `--font-mono` | JetBrains Mono → Cascadia Mono → Consolas | 公式、标签、序号、页脚 |
| `--measure` | `66ch` | 标题与正文最大行宽 |
| `--radius` / `--radius-lg` | `4px` / `8px` | 控件 / 卡片 |
| `--shell` | `1200px` | 版心 |

---

## 3. 主题切换最小实现（含防 FOUC）

三段代码，`v3.html` 里就在这三处，可直接剥出来用。

### 3.1 `<head>` 内联脚本（必须在 `<style>` 之前）

```html
<script>
(function () {
  var root = document.documentElement;
  var KEY = 'dsh-theme', CKEY = 'dsh-contrast';
  var mqDark = window.matchMedia('(prefers-color-scheme: dark)');
  var mqMore = window.matchMedia('(prefers-contrast: more)');
  var read  = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var write = function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} };

  // 优先级：URL ?theme= 预览参数 > localStorage > 系统
  var fromUrl = new URLSearchParams(location.search).get('theme');
  var valid = function (p) { return p === 'light' || p === 'dark' || p === 'system'; };
  var pref = valid(fromUrl) ? fromUrl : (valid(read(KEY)) ? read(KEY) : 'system');

  function resolve(p) { return p === 'system' ? (mqDark.matches ? 'dark' : 'light') : p; }
  function paint(p) {
    var t = resolve(p);
    root.setAttribute('data-theme', t);
    root.setAttribute('data-theme-pref', p);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0E141B' : '#F7F8F5');
  }

  var cPref = read(CKEY);
  if (cPref !== 'high' && cPref !== 'normal') cPref = mqMore.matches ? 'high' : 'normal';
  root.setAttribute('data-contrast', cPref);

  paint(pref);
  window.Theme = {
    KEY: KEY, CKEY: CKEY, pref: function () { return pref; },
    set: function (p, persist) { if (!valid(p)) return; pref = p; if (persist) write(KEY, p); paint(p); },
    repaint: function () { paint(pref); }, mqDark: mqDark, mqMore: mqMore
  };
})();
</script>
```

**为什么这样不会闪**：`data-theme` 在 `<style>` 之前就写到 `<html>` 上，首帧绘制时 CSS 变量已经是目标主题。没有用 `prefers-color-scheme` 媒体查询来决定"默认"，所以不存在"先画浅色再切深色"。

### 3.2 三态控件标记

```html
<div class="theme-switch" role="radiogroup" aria-label="主题">
  <button type="button" role="radio" aria-checked="false" data-theme-set="light" tabindex="-1" aria-label="浅色主题">
    <span class="seg-glyph" aria-hidden="true">☀</span><span class="seg-label">浅色</span>
  </button>
  <button type="button" role="radio" aria-checked="false" data-theme-set="dark" tabindex="-1" aria-label="深色主题">
    <span class="seg-glyph" aria-hidden="true">☾</span><span class="seg-label">深色</span>
  </button>
  <button type="button" role="radio" aria-checked="false" data-theme-set="system" tabindex="-1" aria-label="跟随系统">
    <span class="seg-glyph" aria-hidden="true">◐</span><span class="seg-label">跟随</span>
  </button>
</div>
```

用 `radiogroup` + `aria-checked` + roving `tabindex`（只有选中项是 `0`），左右方向键切换 —— 不是三个 `aria-pressed` 按钮，因为"三选一"在语义上是 radio。

### 3.3 控制器（`</body>` 前，不参与首屏）

```js
radios.forEach(function (b) {
  b.addEventListener('click', function () { choose(b.dataset.themeSet); });
  b.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    var i = radios.indexOf(b), n = radios.length;
    var next = radios[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n];
    next.focus(); choose(next.dataset.themeSet);
  });
});

function choose(pref) {
  window.Theme.set(pref, true);       // 写 localStorage + 上色
  syncRadios(pref);                   // aria-checked / tabindex
  announce('主题：' + LABEL[pref]);    // 复用 #toast (role=status)
}

// 跟随系统时，系统切换要实时生效
window.Theme.mqDark.addEventListener('change', function () {
  if (window.Theme.pref() === 'system') window.Theme.repaint();
});
```

### 3.4 无 JS 兜底

`html` 上没有 `data-theme` 时，由媒体查询接管：

```css
@media (prefers-color-scheme: dark) {
  html:not([data-theme]) { /* 与 [data-theme="dark"] 完全相同的 token 值 */ }
}
```

> ⚠️ 这一段是**镜像**。改深色 token 时必须两处同步（`v3.html` 里已用注释标出）。如果你更在意可维护性，可以删掉镜像，代价是禁用 JS 的用户只能看到浅色。

---

## 4. 五个（+1 个新增）冲突最严重的组件

### 4.1 主按钮 + 焦点环

```css
/* 旧：灰钢蓝 + 3px 淡蓝环，白底上 1.89:1，几乎看不见 */
button { border:1px solid #d3d7dd; background:white; border-radius:6px; }
.primary { background:#344b68; border-color:#344b68; color:white; }
button:focus-visible { outline:3px solid #a6bbfa; outline-offset:3px; }

/* 新：藏青主色 + 2px 品牌色环 + 2px 留白；边框用 ≥3:1 的 border-control */
button, .button {
  border:1px solid var(--border-control);
  background:var(--bg-surface);
  color:var(--text-primary);
  border-radius:var(--radius);
}
button:hover { background:var(--bg-hover); border-color:var(--brand); }
.primary {
  background:var(--brand); border-color:var(--brand);
  color:var(--text-on-brand); font-weight:600;
}
.primary:hover { background:var(--brand-hover); border-color:var(--brand-hover); }
:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; }
```

- 焦点环 `#2E4E7A` 对白底 **8.44:1**（旧 1.89:1），2px + 2px offset 就是规范要的"2px 实线 + 2px 留白"。
- 主按钮是全站唯一的大面积主色块，每屏只出现一次。
- 禁用态不再用 `opacity:.45`（会把文字一起降到不可读），改成"沉底 + 弱化文字"。

### 4.2 卡片 / 表面层级

```css
/* 旧：白底 + 灰蓝边 + 10px 圆角，和页面底几乎没区别，也没有层级 */
.card { padding:24px; background:white; border:1px solid #dde1e6; border-radius:10px; }

/* 新：纸白面 + 发丝线 + 8px 圆角 + 极轻阴影；"抬升"只靠 bg-elevated */
.card {
  padding:1.5rem;
  background:var(--bg-surface);
  border:1px solid var(--border);
  border-radius:var(--radius-lg);
  box-shadow:var(--shadow-card);
  min-width:0;
}
```

顺带修了一个旧 bug：`.card` 也被 `button:hover` 命中，模式选择卡一悬停就整块变灰蓝（`#f0f3f8` 盖住白底）。现在 `.mode:hover` 显式回到 `--bg-surface`，只让描边变深。

### 4.3 聊天气泡 → 推导记录（本次改动最大的一处）

SaaS 气泡是"消费级"痕迹最重的元素。既然定位是"实验室 / 期刊 / 推导记录"，就改成**日志条目**：左侧 2px 竖线 + 说话人小标签，你和 AI 都左对齐，读起来是连续的推导过程而不是对话气泡。

```css
/* 旧 */
.bubble { max-width:88%; padding:14px 18px; background:#f0f3f8; border-radius:8px; }
.message.user { align-items:flex-end; }
.user .bubble { background:#e8effa; }

/* 新 */
.message {
  padding:.85rem 1rem .95rem;
  margin-bottom:.5rem;
  border-left:2px solid var(--border);          /* 默认线 */
  border-radius:0 var(--radius) var(--radius) 0;
}
.message.ai   { border-left-color:var(--accent-teal); }   /* 推导 = 青绿 */
.message.user { border-left-color:var(--brand); background:var(--bg-selected); }
.message > span {                                /* 角色名 */
  font-family:var(--font-mono); font-size:.625rem; letter-spacing:.12em;
  color:var(--text-muted);
}
.bubble { max-width:65ch; background:none; border:0; color:var(--text-primary); }
```

角色区分是**三重**的：竖线颜色 + 角色文字（"你"/"AI 助手"）+ 你的发言有染底。不依赖颜色单独表意。

### 4.4 提示块 / 错误块（去掉彩色 emoji）

```css
/* 旧：整块淡蓝灰，没有语义；错误只有红字 */
.notice { font-size:14px; background:#f3f6fb; padding:12px; border-radius:6px; color:#5a6680; }
.error  { color:#a33c3c; font-size:14px; }

/* 新：旁注式——淡底 + 1px 同色描边 + 左侧 2px 强调线，正文永远用 text-primary */
.notice {
  background:var(--accent-amber-tint);
  border:1px solid var(--accent-amber-border);
  border-left:2px solid var(--accent-amber);
  color:var(--text-primary);              /* 不在彩色底上放彩色字 */
}
.notice::before {                          /* 小标签，用 amber-ink (4.7:1) */
  content:"备注"; font-family:var(--font-mono);
  font-size:.625rem; letter-spacing:.14em; color:var(--accent-amber-ink);
}
.error {
  background:var(--danger-tint);
  border:1px solid var(--danger-border);
  border-left:2px solid var(--danger);
  color:var(--text-primary);
}
.error::before {                           /* 圆形感叹号，纯 CSS，不依赖 emoji */
  content:"!"; width:16px; height:16px; border:1px solid var(--danger);
  border-radius:50%; color:var(--danger);
  font-family:var(--font-mono); font-weight:700;
}
```

### 4.5 状态徽标（图标 + 文字 + 底色 + 描边）

```html
<!-- 旧：彩色 emoji，系统渲染，高饱和且跨平台不一致 -->
<span class="badge good">✅ 掌握</span>

<!-- 新：字形图标 aria-hidden + 文字；颜色只给图标，文字仍是 text-primary -->
<span class="badge good"><span class="glyph" aria-hidden="true">✓</span>掌握</span>
```

```css
.badge {
  display:inline-flex; align-items:center; gap:.35rem;
  padding:.15rem .5rem; border-radius:2px;
  background:var(--bg-sunken); border:1px solid var(--border);
  color:var(--text-primary); font-size:.8125rem;
}
.badge.good { background:var(--success-tint); border-color:var(--success-border); }
.badge.good .glyph { color:var(--success-ink); }   /* 5.6:1，且只用于 12px 图标 */
```

原来的 `✅/⚠/❌` 是三个高饱和彩色方块，正好撞上"绝对不要荧光高饱和"；换成 `✓ / ! / ✕` 后，整页唯一的彩色就只剩徽标底那一点点染色（面积 <0.5%）。

### 4.6 新增：公式块（理工科必须有）

原项目**完全没有代码/公式排版**，但物理题里全是关系式。补一个组件，并接到 AI 提示里：当学生问"这个公式为什么能用"时，提示下方出现关系式。

```css
.formula {
  display:flex; align-items:baseline; flex-wrap:wrap; gap:.5rem;
  margin-top:.7rem; padding:.55rem .8rem;
  background:var(--accent-teal-tint);
  border:1px solid var(--accent-teal-border);
  border-radius:var(--radius);
  font-family:var(--font-mono);
  font-size:.875rem; line-height:1.9;
  color:var(--text-primary);
  tab-size:2;
}
.formula-label { font-size:.625rem; letter-spacing:.14em; color:var(--text-secondary); }
```

```html
<div class="formula"><span class="formula-label">关系式</span>F合 = m · a</div>
```

> 配套的 `.code-block` 也已定义（同一套 token，左侧线换成 `--brand`），给计算机类题目用；当前演示数据里没用到，可以按需接。

**JS 侧只加了 3 处**（其余逻辑逐字节保留）：
1. `formulaFor(t)` —— 按知识点给出**关系式而非答案**；
2. `state.messages.push({..., formula:formulaFor(t)})`；
3. 渲染时 `${m.formula ? '<div class="formula">…' : ''}`。

另外 3 处：`syncFlow()`（页头五步刻度）、`render()` 末尾调用、报告页徽标内联字形。

---

## 5. 对比度自检清单

全部为脚本实算（WCAG 2.x 相对亮度公式），非估算。

### 5.1 浅色主题

| 组合 | 比值 | 要求 | 结论 |
|---|---|---|---|
| 正文 `#23231F` / 页面 `#F7F8F5` | **14.79** | ≥4.5（目标 7） | ✅ AAA |
| 正文 `#23231F` / 卡片 `#FFFFFF` | **15.77** | ≥4.5 | ✅ AAA |
| 标题 `#1C1C17` / 卡片 | **17.10** | ≥4.5 | ✅ AAA |
| 次级 `#5C5F58` / 卡片 | **6.50** | ≥4.5 | ✅ AA |
| 次级 `#5C5F58` / 页面 | **6.09** | ≥4.5 | ✅ AA |
| 弱化 `#696C64` / 卡片 | **5.34** | ≥4.5 | ✅ AA |
| 弱化 `#696C64` / 页面 | **5.01** | ≥4.5 | ✅ AA |
| 弱化 `#696C64` / 沉底 `#EEF0EC` | **4.66** | ≥4.5 | ✅ AA（最紧的一处） |
| 主色 `#2E4E7A` / 卡片 | **8.44** | ≥4.5 | ✅ AAA |
| 主色上的白 `#F7F8F5` / `#2E4E7A` | **7.92** | ≥4.5 | ✅ AAA |
| 主按钮 hover `#F7F8F5` / `#243F63` | **10.40** | ≥4.5 | ✅ AAA |
| 青绿 `#1F7A68` / 卡片 | **5.20** | ≥4.5 | ✅ AA |
| 青绿 `#1F7A68` / 青绿底 `#E8F2EF` | **4.55** | ≥4.5 | ✅ AA（临界） |
| 琥珀字 `#8E6410` / 琥珀底 `#FAF1DE` | **4.70** | ≥4.5 | ✅ AA |
| 成功字 `#2A6B46` / 成功底 `#E7F3EC` | **5.60** | ≥4.5 | ✅ AA |
| 错误 `#B33A3A` / 卡片 | **5.86** | ≥4.5 | ✅ AA |
| 错误字 `#A3352F` / 错误底 `#FBEDEC` | **5.93** | ≥4.5 | ✅ AA |
| 控件边 `#8A8C85` / 卡片 | **3.40** | ≥3 | ✅ |
| 控件边 `#8A8C85` / 页面 | **3.19** | ≥3 | ✅（临界） |
| 焦点环 `#2E4E7A` / 页面 | **7.92** | ≥3 | ✅ |
| 正文 / 选中底 `#EDF2F8` | **14.01** | ≥4.5 | ✅ |
| 正文 / 提示底 `#FAF1DE` | **14.04** | ≥4.5 | ✅ |
| Toast `#F7F8F5` / `#1B3050` | **12.43** | ≥4.5 | ✅ |
| 卡片边 `#E2E4DF` / 白 | 1.28 | 装饰 | ⚠️ 不承担识别功能，可接受 |
| 强边 `#C9CCC5` / 白 | 1.62 | 装饰 | ⚠️ 同上 |

### 5.2 深色主题

| 组合 | 比值 | 要求 | 结论 |
|---|---|---|---|
| 正文 `#E8EDF2` / 页面 `#0E141B` | **15.71** | ≥4.5 | ✅ AAA |
| 正文 `#E8EDF2` / 卡片 `#141C25` | **14.58** | ≥4.5 | ✅ AAA |
| 标题 `#F2F6FA` / 卡片 | **15.82** | ≥4.5 | ✅ AAA |
| 次级 `#A6B2BF` / 卡片 | **7.97** | ≥4.5 | ✅ AAA |
| 次级 `#A6B2BF` / 抬升 `#1B2530` | **7.20** | ≥4.5 | ✅ AA |
| 弱化 `#84909E` / 页面 | **5.70** | ≥4.5 | ✅ AA |
| 弱化 `#84909E` / 卡片 | **5.29** | ≥4.5 | ✅ AA |
| 弱化 `#84909E` / 抬升 | **4.77** | ≥4.5 | ✅ AA（最紧） |
| 主色 `#7FA3D4` / 卡片 | **6.62** | ≥4.5 | ✅ AA |
| 主色 `#7FA3D4` / 页面 | **7.13** | ≥4.5 | ✅ AA |
| 主色上写字 `#0E141B` / `#7FA3D4` | **7.13** | ≥4.5 | ✅ AAA |
| 主色 hover `#9FBCE6` / 卡片 | **8.84** | ≥4.5 | ✅ AAA |
| 青绿 `#5CC4AE` / 卡片 | **8.15** | ≥4.5 | ✅ AAA |
| 琥珀 `#E0B45C` / 卡片 | **8.88** | ≥4.5 | ✅ AAA |
| 成功 `#63B884` / 卡片 | **7.13** | ≥3 | ✅ |
| 错误 `#D96A6A` / 卡片 | **5.09** | ≥4.5 | ✅ AA |
| 警告 `#D4A94F` / 卡片 | **7.84** | ≥3 | ✅ |
| 正文 / 选中底 `#16273A` | **12.87** | ≥4.5 | ✅ |
| 控件边 `rgba(...,.58)` 合成 `#5F748F` / 卡片 | **3.58** | ≥3 | ✅ |
| 卡片边 `rgba(...,.14)` 合成 `#26313F` | **1.30** | 装饰 | ⚠️ 不可见是刻意的（深色下靠面差分层） |
| Toast `#E8EDF2` / `#1B2530` | 12.8 | ≥4.5 | ✅ |

### 5.3 顺带算了一下旧值（作为改动依据）

| 旧组合 | 比值 | 判定 |
|---|---|---|
| `#6c7481` / `#f7f7f7`（`.muted`） | **4.40** | ❌ 低于 4.5 |
| `#788393` / 白（角色名、空态） | **3.84** | ❌ 明显不达标 |
| `#a6bbfa` / 白（焦点环） | **1.89** | ❌ 焦点环几乎不可见 |
| `#3563e9` / 白（品牌蓝） | 5.11 | ✅ 对比度够，但**色相饱和度违规**（81% 消费级蓝） |

---

## 6. 颜色面积分配（自查）

按实际渲染面积估算（1440px 首屏）：

| 类别 | 占比 | 出现在哪 |
|---|---|---|
| 中性色（底 / 字 / 线） | **≈ 86%** | 全部 |
| 主色藏青 | **≈ 10%** | Logo 方块、主按钮、选区描边、步骤序号、进度刻痕、下划线 |
| 青绿 | **≈ 2.5%** | AI 记录左侧 2px、公式块底、成功徽标图标 |
| 琥珀 | **≈ 1%** | 提示块底 + 左线、等待圆点、待巩固图标 |
| 危险红 | **≈ 0.5%** | 仅错误态 |

- 彩色只出现在"小面积 + 有语义"的位置，没有一块彩色大背景。
- 每个页面最多一个主按钮；标题**全部**是 `--text-heading`，没有彩色标题。
- 渐变全站只出现在 Logo（34×34px），透明度 `0.55` / 深色 `0.26`。

---

## 7. 需要你再确认的 8 件事

标 ⚠️ 的是我做了判断、但你的规范里没写死的地方。

1. ⚠️ **`--text-muted` 没沿用 `#8A8C85`。** 你给的参考值对白底只有 **3.40:1**，对页面底 **3.19:1**，`p.muted` 是 16px 正文级文字，必须 ≥4.5。所以我把它降到 `#696C64`（5.34:1），原值 `#8A8C85` 降级为 `--prim-paper-500`，只用于**控件描边**（那里只需 3:1）。如果你希望弱化文字再浅一点换取"更安静"的观感，这是唯一需要你拍板的取舍。
2. ⚠️ **`--border-control` 是新增的语义 token。** 规范给的 `--border-strong: #C9CCC5` 只有 **1.62:1**，做输入框/按钮描边不满足"UI 组件 ≥3:1"。所以交互控件统一走 `#8A8C85`（3.40:1），`--border` / `--border-strong` 继续做纯装饰分割线。**如果你认为 1.6:1 的边框也能接受**（很多设计系统这么干），把 `.card` 之外的控件边框改回 `--border-strong` 即可。
3. ⚠️ **深色 `--text-muted` 从 `#74808D` 提到 `#84909E`。** 原值对 `#141C25` 是 **4.27:1**，差 0.23。只在"抬升面"上最紧（4.77:1）。
4. ⚠️ **琥珀金不能当正文色。** `#B07D17` 对白底 **3.63:1**，只够做图标/竖线（≥3:1）。需要它当文字时（提示块"备注"标签），用的是 `--accent-amber-ink: #8E6410`（4.70:1）。同理 `--success #2E8B57` 只有 4.25:1、`--warning #B8860B` 只有 3.25:1，**都只做图形**，文字用 `-ink` 变体。
5. ⚠️ **提示块的"备注"是琥珀字压琥珀底**（4.70:1）。严格按"彩色文字不放彩色底"的条文字面，这算擦边。我保留它是因为底色的饱和度只有 ~6%，且它是整个提示块的语义标签；若你不接受，改成 `--text-muted` 即可（4.66:1）。
6. ⚠️ **中文衬线一律用 400 + `font-synthesis-weight:none`。** 因为 Noto Serif SC / 思源宋 / 宋体通常只装 Regular，写 600 会被浏览器**合成粗体**，笔画发糊（第一版截图就是这个毛病，已修）。代价是标题靠字号和灰度拉层级，不靠字重。
7. ⚠️ **没有引外部字体。** 为了离线可用 + 不闪字，`Source Serif 4 / JetBrains Mono / Inter` 只在字体栈里"如果装了就用"。想强制统一观感，需要自带 woff2（中文字体体积大，建议只自托子集）。当前这台机器的回退链是：标题 Noto Serif SC、正文 Noto Sans SC、等宽 Cascadia Mono。
8. ⚠️ **无 JS 兜底的深色块是镜像代码**（§3.4），改 token 要改两处。如果你完全不考虑无 JS 场景，删掉它更干净。

---

## 8. 文件与改动范围

| 项目 | 说明 |
|---|---|
| `v3.html` | 单文件成品，72 KB；直接双击即可用，无构建、无依赖 |
| 逻辑 | 原 `<script>` 逐字节复用，仅 6 处补丁（`syncFlow` ×2、`formulaFor`、formula 入队、formula 渲染、徽标字形） |
| 删除 | 41 行 `body[data-version="1"], [data-version="3"]` 死样式（当前只用 v2 那套） |
| 保留 | 全部 5 个页面、语音输入、图片上传、localStorage 之外的运行时状态、`prefers-reduced-motion` |
| 新增 | 报头 + 五步刻度、三态主题开关、高对比开关、公式块、`?theme=light\|dark` 预览参数 |
| 未做 | 没接入构建流程、没改 `v2.html`（保留原文件便于对比） |

### 快速自检

1. 打开 `v3.html`，右上角切 浅色 / 深色 / 跟随 —— 状态要落到 localStorage，刷新不闪。
2. 用 `?theme=dark` 直接打开，首帧就是深色（不会先白一下）。
3. Tab 键走一圈：焦点环是 2px 藏青、有 2px 留白，不会被裁掉。
4. 系统设置里开"对比度增强"，或点"高对比"：正文更深、描边更实，背景不变。
5. 关掉 JS 再打开：应跟随系统主题（镜像块生效）。
