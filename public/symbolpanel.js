/**
 * 符号面板 —— 让 index.html 的两个输入框能打出物理符号。
 *
 * ============================================================================
 * 它为什么存在（不是新功能，是把丢掉的东西找回来）
 * ============================================================================
 * 学生原话："一些物理的表达式很难写上去。"
 *
 * `²` `₀` `μ` `Ω` `√` 这些字符在普通键盘上打不出来。写不出来，学生就只能绕着
 * 用文字描述思路，表达的精度直接下降。
 *
 * 这个面板 2026-10-11 就做过（`b1919a0`，挂在旧页面的题干框上方），10-28 主界面
 * 整页重写时被一起带走了 —— 那次替换没有任何说明，也**没有任何测试守过它**，
 * 所以消失的时候 CI 是绿的。现在把它放回主界面（`public/index.html`），并且
 * 补一条 DOM 契约在 `test/ui.test.js` 里，防止下一次整页重写再演一遍。
 *
 * ============================================================================
 * 为什么清单搬到这里来
 * ============================================================================
 * 这份清单原本住在 `public/mathinput.js`（旧壳的符号插入），但那边只有测试在引用，
 * 界面一个消费者都没有 —— 属于"留着但没人用"的资产。而 `mathinput.js` 的本职是
 * 那套自动替换规则（`^2`→`²`、`mu`→`μ`），两件事本来就该分开：
 *
 *   清单 = "界面上有哪些键"（这个文件）
 *   规则 = "打字时替换什么"（mathinput.js，本轮不动）
 *
 * 分开放之后，清单只有一份真相，`symbolpanel.test.js` 直接对着它验算。
 *
 * ============================================================================
 * 插入为什么是纯函数
 * ============================================================================
 * `spliceSymbol()` 不碰 DOM：给定"原文本 + 符号 + 选区"，返回"新文本 + 光标落点"。
 * 这样 `test/symbolpanel.test.js` 能直接拿边界去砸它（光标在中间、有选区、
 * 空框、连续插两次、start>end），不用为四个 if 造一个假 DOM。
 * 浏览器里只负责"取值 → 调它 → 写回 → 把光标摆好"。
 */

/**
 * 面板清单。分组顺序按"学生实际用到的频率"排，而不是按符号表顺序 ——
 * 上标与下标用得最多（单位里到处是 `m/s²`、`v₀`）。
 *
 * `Δ` 在旧清单里同时出现在「希腊」和「其它」，这一版只留在「希腊」：
 * 同一个符号在面板里出现两次，学生要多想一遍"这两个是不是不一样"。
 */
export const PALETTE = [
  { group: '上标', items: ['²', '³', '⁻¹', '⁻²', '⁻³', '⁴', 'ⁿ'] },
  { group: '下标', items: ['₀', '₁', '₂', '₃', '₄', 'ₙ'] },
  { group: '希腊', items: ['μ', 'θ', 'Ω', 'Δ', 'Φ', 'ρ', 'λ', 'ω', 'α', 'β', 'π', 'ε', 'Σ'] },
  { group: '运算', items: ['√', '≈', '≤', '≥', '≠', '±', '×', '÷', '·', '∞', '∝'] },
  { group: '其它', items: ['°', '′', '→', '⇀', '½', '⅓', '¼', '∫', '∑', '∴', '∵'] },
];

/** 清单里所有符号（扁平）。测试与"有没有重复"的检查用它。 */
export function allSymbols() {
  return PALETTE.flatMap((g) => g.items);
}

/**
 * 把 `symbol` 插进 `value` 的 `[start, end)` 区间。
 *
 * 只做三件事，都是"显式约定"，不猜：
 *   1. `start`/`end` 缺省或不是整数 → 一律当成"光标在末尾"（追加）
 *   2. 越界 → 夹到 `[0, length]`；`start > end` → 交换（选区反着拖也成立）
 *   3. 有选区 → 覆盖选区，不是"插在选区前面"
 *
 * @returns {{ value: string, caret: number }} 新文本与光标应落在的位置
 */
export function spliceSymbol(value, symbol, start, end) {
  const text = String(value ?? '');
  const sym = String(symbol ?? '');
  const len = text.length;
  let from = clampIndex(start, len);
  let to = clampIndex(end, len);
  if (from > to) [from, to] = [to, from];
  return {
    value: text.slice(0, from) + sym + text.slice(to),
    caret: from + sym.length,
  };
}

function clampIndex(raw, len) {
  const n = Number(raw);
  if (raw == null || !Number.isFinite(n)) return len;
  return Math.min(Math.max(Math.trunc(n), 0), len);
}

/**
 * 面板该摆在哪儿。
 *
 * 这是被一次真实的抱怨逼出来的：面板浮在输入框上，"挡住正在打的那行"。
 * 第一版把浮层锚到触发按钮（Ω 在 composer-bar 里，也就是 textarea 下方），
 * 面板底边正好压在输入区；改成锚到整个 composer 之后**还是压住了** ——
 * 因为面板自然高度约 550px，而"输入框上方"常常只有 400 多，
 * 于是它落到"钳进视口"的兜底分支，照样盖住输入框。
 *
 * 所以这里的做法是：**先把高度钳到上方可用空间**（多出来的让格子在面板内部滚），
 * 再按钳过之后的高度定位。这样"不压住输入框"是一条不变量，而不是"窗口够大时才成立"。
 *
 * @param {object} input
 * @param {{top:number,bottom:number,right:number}} input.trigger 触发按钮的矩形
 * @param {{top:number,bottom:number}} input.anchor 输入框（.composer）的矩形
 * @param {{width:number,height:number}} input.size 面板的自然尺寸
 * @param {{width:number,height:number}} input.viewport 视口尺寸
 * @param {number} [input.gap] 与输入框、视口边缘留的缝
 * @param {number} [input.minRoom] 小于这个高度就不值得摆在这一侧了
 * @returns {{left:number, top:number, maxHeight:number, side:'above'|'below'|'clamped'}}
 */
export function panelPlacement({ trigger, anchor, size, viewport, gap = 8, minRoom = 160 }) {
  const maxLeft = Math.max(gap, viewport.width - size.width - gap);
  // 右对齐到触发按钮，再夹进视口 —— 手机上按钮贴近右边缘时不会溢出屏幕
  const left = Math.min(Math.max(trigger.right - size.width, gap), maxLeft);

  const roomAbove = anchor.top - gap * 2;
  const roomBelow = viewport.height - anchor.bottom - gap * 2;

  if (roomAbove >= minRoom) {
    const maxHeight = roomAbove;
    const height = Math.min(size.height, maxHeight);
    return { left, top: anchor.top - height - gap, maxHeight, side: 'above' };
  }
  if (roomBelow >= minRoom) {
    const maxHeight = roomBelow;
    return { left, top: anchor.bottom + gap, maxHeight, side: 'below' };
  }
  /*
   * 上下都挤（窗口矮到两三百像素）：这一档注定有交集，只能钳进视口自保。
   * 不静默装作没问题 —— side 字段会告诉调用方走的是兜底。
   */
  const maxHeight = Math.max(minRoom, viewport.height - gap * 2);
  const height = Math.min(size.height, maxHeight);
  const top = Math.max(gap, Math.min(anchor.top - height - gap, viewport.height - height - gap));
  return { left, top, maxHeight, side: 'clamped' };
}

/* ==========================================================================
 * 下面是浏览器那一半。Node 里 import 这个文件只会拿到两个纯函数 ——
 * `test/symbolpanel.test.js` 就是这么用的。
 * ======================================================================== */

/**
 * 面板挂在 `<body>` 上、用 `position:fixed` 定位，而不是塞在 composer 里面。
 *
 * 为什么：第 3 页的输入框长在 `.pane` 里，而 `.pane{overflow:hidden}`；
 * 第 1 页的输入框长在 `.p1{overflow-y:auto}` 里。绝对定位的浮层在这两处都会被裁掉，
 * 表现就是"点开了但只看到一条边"。挂到 body + fixed 之后，两个页面共用同一个面板，
 * 也不用为裁剪问题给容器开洞。
 */

/** 哪些输入框"被真正操作过"。没用过的框不该被当成"光标在 0"。 */
const touched = new WeakSet();

function init() {
  const panel = document.getElementById('symPanel');
  const grid = panel && panel.querySelector('[data-sym-grid]');
  const triggers = Array.from(document.querySelectorAll('[data-sym-trigger]'));
  if (!panel || !grid || !triggers.length) return;

  renderGrid(grid);

  /** 当前打开的是哪一个触发按钮，以及它对应的输入框 */
  let openFor = null;

  const targets = new Set();
  for (const trigger of triggers) {
    const id = trigger.getAttribute('data-sym-trigger');
    const target = id ? document.getElementById(id) : null;
    if (target) targets.add(target);
  }

  // 记住"这个框被碰过"。没被碰过的框（比如题库直接灌进去的题干），
  // selectionStart 默认是 0 —— 拿它当光标会把符号插到开头。
  for (const el of targets) {
    for (const type of ['focus', 'mouseup', 'keyup', 'select', 'click']) {
      el.addEventListener(type, () => touched.add(el));
    }
  }

  function caretOf(el) {
    if (!touched.has(el)) return { start: el.value.length, end: el.value.length };
    const start = Number.isInteger(el.selectionStart) ? el.selectionStart : el.value.length;
    const end = Number.isInteger(el.selectionEnd) ? el.selectionEnd : start;
    return { start, end };
  }

  function close(opts = {}) {
    if (!openFor) return;
    const { trigger, target } = openFor;
    openFor = null;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (opts.restoreFocus && target) target.focus();
  }

  function place(trigger) {
    /*
     * 垂直方向锚在**整个 composer 的上沿**，不是触发按钮的上沿。
     *
     * 触发按钮长在 .composer-bar 里，而 .composer-bar 在 textarea 下面 ——
     * 拿按钮的 top 往上排，面板底边正好落在输入区上，把学生正在打的那行挡住。
     *
     * 具体怎么摆由 panelPlacement() 算，那是个纯函数，能用真实尺寸在 Node 里验算
     * （见 test/symbolpanel.test.js 的「摆放」一组）。
     */
    const anchor = trigger.closest('.composer') || trigger;

    panel.hidden = false; // 先可见，才有尺寸可量
    panel.style.maxHeight = ''; // 量的是自然高度，不受上一次钳制的影响

    const placement = panelPlacement({
      trigger: trigger.getBoundingClientRect(),
      anchor: anchor.getBoundingClientRect(),
      size: { width: panel.offsetWidth, height: panel.offsetHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });

    panel.style.maxHeight = `${placement.maxHeight}px`;
    panel.style.left = `${placement.left}px`;
    panel.style.top = `${placement.top}px`;
  }

  function open(trigger) {
    if (openFor && openFor.trigger === trigger) {
      close();
      return;
    }
    const id = trigger.getAttribute('data-sym-trigger');
    const target = id ? document.getElementById(id) : null;
    if (!target) return;
    if (openFor) openFor.trigger.setAttribute('aria-expanded', 'false');
    openFor = { trigger, target };
    trigger.setAttribute('aria-expanded', 'true');
    place(trigger);
  }

  function insert(el, symbol) {
    const { start, end } = caretOf(el);
    const next = spliceSymbol(el.value, symbol, start, end);
    el.value = next.value;
    el.focus();
    el.setSelectionRange(next.caret, next.caret);
    touched.add(el);
    // 走一次 input 事件：发送按钮的可用态、题干下方的公式预览都挂在上面。
    // 这条与题库"填入题干"的既有写法一致（index.html 的 data-fill 也是这么派的）。
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  for (const trigger of triggers) {
    trigger.addEventListener('click', () => open(trigger));
  }

  // 按住格子时别让焦点跑掉 —— 焦点一跑，textarea 的选区就没了，
  // 插入位置会从"光标处"退化成"末尾"。
  grid.addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-sym]')) e.preventDefault();
  });

  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-sym]');
    if (!cell || !openFor) return;
    insert(openFor.target, cell.dataset.sym);
  });

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!openFor) return;
      if (panel.contains(e.target)) return;
      if (openFor.trigger.contains(e.target)) return;
      close();
    },
    true,
  );

  document.addEventListener('keydown', (e) => {
    if (!openFor) return;
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close({ restoreFocus: true });
  });

  const reposition = () => {
    if (openFor) place(openFor.trigger);
  };
  window.addEventListener('resize', reposition);
  // 输入框在滚动容器里（第 1 页 .p1、第 3 页 .pane-body），滚动时要跟着走
  window.addEventListener('scroll', reposition, true);
}

/** 把清单铺成五组按钮，每一组一行小标签 + 一串格子 */
function renderGrid(grid) {
  grid.textContent = '';
  for (const group of PALETTE) {
    const row = document.createElement('div');
    row.className = 'symgroup';

    const label = document.createElement('span');
    label.className = 'symgroup-label';
    label.textContent = group.group;

    const cells = document.createElement('div');
    cells.className = 'symrow';

    for (const symbol of group.items) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'symcell';
      cell.dataset.sym = symbol;
      cell.setAttribute('aria-label', `插入 ${symbol}`);
      cell.textContent = symbol;
      cells.appendChild(cell);
    }

    row.appendChild(label);
    row.appendChild(cells);
    grid.appendChild(row);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
