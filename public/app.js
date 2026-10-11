import { applyShortcut, PALETTE } from './mathinput.js';
/**
 * Demo 前端逻辑（零依赖 ES module，无构建步骤）。
 *
 * ============================================================================
 * 两条设计纪律
 * ============================================================================
 * ① **学生视图只渲染服务端给的字段。**
 *    前端不做"拿到了但故意不显示"—— 那等于学生打开 F12 就能看到。
 *    凡是不该学生看的（路径、指纹、错因标签、完整 trace），服务端根本不会发过来。
 *
 * ② **动效只用来解释状态变化，不用来装饰。**
 *    出现（fadeRise）、被点亮（pulse）、逐条揭晓（stagger）、
 *    关系建立（描线）—— 每一种都对应一次真实的状态变化。
 *    全部动效在 `prefers-reduced-motion` 下退化为"直接显示"（见 styles.css）。
 */

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const state = {
  view: 'student',
  mode: 'ai_companion',
  /** 题目面板当前显示"原题"还是"解析" */
  problemView: 'original',
  problems: [],
  scripts: [],
  currentProblem: null,
  currentAnalysis: null,
  sessionId: null,
  turns: 0,
  reachedLevels: new Set(),
  currentLevel: null,
  hasMessages: false,
  busy: false,
  teacherKey: sessionStorage.getItem('dsh-teacher-key') ?? '',
  teacherTab: 'overview',
  teacherSessionId: null,
  /** 学生自己算出来的答案（跨轮累计，仅用于完成界面的回显） */
  confirmed: [],
};

const MODE_HINT = {
  self_training: '自主训练：我先不说话，只在你说"卡住了"或者思路明显走岔时出声。',
  ai_companion: '学伴陪伴：我会在你思路出现岔路时出声，但不会每一步都打断你。',
};

const LEVEL_SHORT = { 0: '澄清问题', 1: '问一个前提', 2: '给一个方向', 3: '示范一步' };

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/** HTML 转义 —— 所有来自模型/学生/题库的文本都必须过这一层 */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers ?? {}) };
  if (path.startsWith('/api/teacher/') && state.teacherKey) headers['x-teacher-key'] = state.teacherKey;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.hint = data.hint ?? null;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(text) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function scrollToBottom() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

function newSessionId(problemId) {
  return `demo-${problemId}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// 页面导航
// ---------------------------------------------------------------------------

const STUDENT_PAGES = ['page-start', 'page-chat', 'page-report'];

function showPage(pageId) {
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === pageId));
  $$('.step').forEach((b) => b.classList.toggle('active', b.dataset.page === pageId));
  $('#nav').hidden = pageId === 'page-teacher';
  if (pageId === 'page-report') loadReport();
  if (pageId === 'page-teacher') loadTeacher();
  /**
   * 题干阅读框必须在**页面可见之后**才量得出溢出。
   *
   * 踩到的坑：selectProblem 的顺序是 applyProblemToChat → showPage('page-chat')，
   * 而 applyProblemToChat 里已经调过一次 enhanceStemBoxes ——
   * 那时 #page-chat 还是 display:none，clientHeight 为 0，
   * 函数按"量不出来就不判断"提前返回，于是长题目的滚动提示永远不出现。
   * 所以入口放在这里（页面切换的必经之路），并且等一帧让布局落定。
   */
  if (pageId === 'page-chat') {
    requestAnimationFrame(() => enhanceStemBoxes($('#pane-original')));
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setView(view) {
  state.view = view;
  document.body.classList.toggle('view-teacher', view === 'teacher');
  $$('#view-switch .seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $('#brand-sub').textContent = view === 'teacher' ? '教研视角 · 完整路径与判断链路' : '只给提示 · 不给答案';
  if (view === 'teacher') {
    showPage('page-teacher');
  } else {
    const current = $$('.page.active')[0]?.id;
    showPage(STUDENT_PAGES.includes(current) ? current : 'page-start');
  }
}

/**
 * 切换陪伴方式。
 *
 * 单一事实来源：`state.mode`。首页的模式卡与对话页的模式开关
 * 都只是它的两个视图 —— 两处必须同步，否则会出现
 * "首页显示自主训练、对话页显示学伴陪伴"这种自相矛盾的状态。
 */
function setMode(mode, opts = {}) {
  state.mode = mode;
  $$('#mode-switch .seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $$('#mode-cards .mode-card').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#mode-hint').textContent = MODE_HINT[mode];
  if (opts.announce) toast(mode === 'self_training' ? '已切换：自主训练 · 我不再主动开口' : '已切换：学伴陪伴 · 关键处我会提醒你');
}

/** 原题 / 解析 开关 */
function setProblemView(view) {
  state.problemView = view;
  const seg = $('#seg-problem-view');
  seg.dataset.view = view;
  $$('#seg-problem-view button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $('#pane-original').classList.toggle('active', view === 'original');
  $('#pane-parsed').classList.toggle('active', view === 'parsed');
  // 面板隐藏时 scrollHeight/clientHeight 都是 0，量不出溢出 —— 切回来要重测一次
  if (view === 'original') enhanceStemBoxes($('#pane-original'));
  // 解析里的知识图谱需要更宽的位置
  $('#workbench').classList.toggle('wide-left', view === 'parsed');
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

async function init() {
  bindEvents();
  setMode('ai_companion');
  setProblemView('original');
  updateLadder(null);
  await Promise.all([loadHealth(), loadProblems(), loadScripts()]);
  showPage('page-start');
  await applyDeepLink();
}

/**
 * 深链接：让"打开就是某个状态"成为可能。
 *
 *   ?problem=phy-emi-01&pane=parsed&page=chat   直接看这道题的解析
 *   ?view=teacher&tab=problem                   直接进教师视图的题目页
 *   ?view=teacher&tab=session&session=<id>      直接看某一次会话的复盘
 *   ?mode=self_training                         默认自主训练
 *
 * 为什么要做这个：
 *   演示时经常需要"跳到某一道题的解析"给人看；
 *   而且一份带着状态的链接比"你先点这里再点那里"可靠得多 ——
 *   也给自动化截图/回归留了口子。
 * 不认识的参数一律忽略，不报错（链接被手工改坏不该让页面白屏）。
 */
async function applyDeepLink() {
  const q = new URLSearchParams(location.search);
  applySessionLink(q);
  const mode = q.get('mode');
  if (mode === 'self_training' || mode === 'ai_companion') setMode(mode);

  const pid = q.get('problem');
  if (pid && state.problems.some((p) => p.id === pid)) {
    try {
      await selectProblem(pid);
    } catch {
      /* 题目不存在就当没传 */
    }
  }

  const pane = q.get('pane');
  if (pane === 'parsed' || pane === 'original') setProblemView(pane);

  const view = q.get('view');
  if (view === 'teacher') {
    const tab = q.get('tab');
    if (tab && ['overview', 'session', 'problem', 'eval'].includes(tab)) {
      state.teacherTab = tab;
      $$('#teacher-tabs .seg-btn').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
    }
    setView('teacher');
    return;
  }

  const page = q.get('page');
  if (page && STUDENT_PAGES.includes(`page-${page}`)) showPage(`page-${page}`);
}

/**
 * 指定会话：学生可以直接打开自己的学习报告链接，教研可以直接打开某节课的复盘。
 * 这让"把报告发给别人看"成为可能 —— 而不是只能当场演示。
 */
function applySessionLink(q) {
  const session = q.get('session');
  if (!session) return;
  state.sessionId = session;
  state.teacherSessionId = session;
  // 报告页靠 turns 判断"有没有内容可汇总"；用链接进来时按"有"处理，
  // 真正的判定交给 /api/report —— 会话过期时它会返回可读的提示。
  state.turns = Math.max(state.turns, 1);
}

async function loadHealth() {
  try {
    const h = await api('/api/health');
    const badge = $('#engine-badge');
    if (h.engine === 'llm') {
      badge.textContent = `真模型 ${h.model}`;
      badge.classList.remove('offline');
      badge.title = `已接入 ${h.llmBaseUrl}（Key ${h.keyMask}）· 读题能力：${h.capabilities.intake ? '可用' : '仅骨架'}`;
    } else {
      badge.textContent = '离线规则桩';
      badge.classList.add('offline');
      badge.title = '未配置 LLM_API_KEY —— 全流程可跑，但读题只有通用骨架，提示话术更模板化';
    }
    applyTeacherMode(h.teacherView);
  } catch {
    $('#engine-badge').textContent = '连接失败';
  }
}

/** 把服务端的教师视图形态翻译成门口那句话（形态由 router.js 的 teacherMode 决定） */
function applyTeacherMode(mode) {
  const pill = $('#teacher-gate-pill');
  if (!pill) return;
  if (mode === 'open') {
    pill.textContent = '本地模式 · 无需口令';
    pill.className = 'pill pill-live';
  } else if (mode === 'key') {
    pill.textContent = '需要口令';
    pill.className = 'pill';
  } else {
    pill.textContent = '本部署已关闭';
    pill.className = 'pill pill-muted';
  }
  if (mode === 'off') {
    $('#teacher-key').disabled = true;
    $('#btn-teacher-login').disabled = true;
    gateMessage('教师视图在本部署形态下已关闭 —— 它包含完整解题路径与参考答案，公网默认不开放。');
  }
}

async function loadProblems() {
  const { problems } = await api('/api/problems');
  state.problems = problems;
  $('#problem-count').textContent = `${problems.length} 道题`;
  renderProblemList();
}

function renderProblemList() {
  const label = { physics: '物理', math: '数学', chemistry: '化学' };
  $('#problem-list').innerHTML = state.problems
    .map(
      (p, i) => `
      <button class="problem-item stagger ${state.currentProblem?.id === p.id ? 'selected' : ''}" style="--i:${i}" data-id="${esc(p.id)}">
        <div class="problem-item-head">
          <span class="tag tag-${p.subject === 'math' ? 'math' : p.subject === 'chemistry' ? 'chem' : 'phy'}">${esc(label[p.subject] ?? p.subject)}</span>
          ${p.source === 'imported' ? '<span class="tag tag-imported">刚导入</span>' : ''}
          <strong>${esc(p.topics[0] ?? '')}</strong>
          <span class="tag tag-diff">难度 ${p.difficulty}/5</span>
        </div>
        <div class="problem-stem">${esc(p.stemPreview)}</div>
        ${
          p.source === 'imported' && p.graphConfidence === 'degraded'
            ? '<div class="small" style="color:var(--warn);margin-top:5px">⚠ 本题图谱缺少答案指纹，防泄题强度较弱</div>'
            : ''
        }
      </button>`,
    )
    .join('');

  $$('#problem-list .problem-item').forEach((el) => {
    el.addEventListener('click', () => selectProblem(el.dataset.id));
  });
}

async function loadScripts() {
  const { scripts } = await api('/api/demo-scripts');
  state.scripts = scripts;
  renderScripts();
}

function renderScripts() {
  const relevant = state.currentProblem ? state.scripts.filter((s) => s.problemId === state.currentProblem.id) : [];
  const list = relevant.length ? relevant : state.scripts.filter((s) => s.kind === 'understanding').slice(0, 6);

  $('#script-list').innerHTML = list
    .map(
      (s, i) => `
      <button class="script-item stagger" style="--i:${i}" data-id="${esc(s.id)}">
        ${esc(s.title)}
        <em>「${esc(s.utterances[0].slice(0, 26))}${s.utterances[0].length > 26 ? '…' : ''}」</em>
      </button>`,
    )
    .join('');

  $$('#script-list .script-item').forEach((el) => {
    el.addEventListener('click', () => {
      const script = state.scripts.find((s) => s.id === el.dataset.id);
      if (!script) return;
      if (state.currentProblem && script.problemId !== state.currentProblem.id) {
        selectProblem(script.problemId).then(() => {
          $('#input').value = script.utterances[0];
          $('#input').focus();
          autoGrow($('#input'));
        });
        return;
      }
      $('#input').value = script.utterances[0];
      $('#input').focus();
      autoGrow($('#input'));
    });
  });
}

// ---------------------------------------------------------------------------
// 读题（任意新题目导入）
// ---------------------------------------------------------------------------

const SAMPLE_STEM =
  '质量为 0.5 kg 的小球从高 h = 20 m 处由静止开始自由下落，不计空气阻力，g 取 10 m/s²。' +
  '求：(1) 小球落地时的速度大小；(2) 小球在落地前 1 s 内下落的高度。';

async function importProblem() {
  const rawText = $('#stem-input').value.trim();
  const notice = $('#import-notice');
  if (rawText.length < 8) {
    notice.hidden = false;
    notice.className = 'notice notice-warn';
    notice.textContent = '题干太短了，至少 8 个字。把完整题目贴进来再试。';
    return;
  }

  const btn = $('#btn-import');
  btn.disabled = true;
  btn.textContent = '正在读题…';
  notice.hidden = false;
  notice.className = 'notice';
  notice.innerHTML =
    '<strong>正在读懂这道题</strong> —— 抽取条件与目标 → 标出知识点 → 逐条解释关键条件 → 生成解题路径。大约 5~15 秒。';

  try {
    const res = await api('/api/problem/import', { method: 'POST', body: JSON.stringify({ rawText }) });
    notice.hidden = true;
    await applyImportedProblem(res);
    await loadProblems();
    toast('读题完成，解析已就绪');
  } catch (err) {
    notice.className = 'notice notice-warn';
    notice.textContent = `读题失败：${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '读懂这道题';
  }
}

async function applyImportedProblem(res) {
  const p = res.problem;
  state.currentProblem = p;
  state.currentAnalysis = p.analysis ?? null;
  state.sessionId = newSessionId(p.id);
  state.turns = 0;
  state.reachedLevels = new Set();
  state.currentLevel = null;
  state.hasMessages = false;
  state.confirmed = [];

  $('#intake-result').hidden = false;
  $('#intake-topics').innerHTML = (res.intake.topics ?? [])
    .map((t, i) => `<span class="tag tag-key stagger" style="--i:${i}">${esc(t)}</span>`)
    .join('');
  $('#intake-steps').textContent = String(res.intake.stepCount);
  $('#intake-engine').textContent = res.intake.usedModel
    ? `读题模型 · ${res.intake.latencyMs} ms`
    : '通用骨架（离线）';
  $('#intake-engine').className = res.intake.usedModel && res.intake.graphReady ? 'pill pill-live' : 'pill pill-muted';
  $('#intake-why').textContent = res.intake.notice;

  // 关键条件速览（会剧透的那条显示为提问）
  const conds = p.analysis?.keyConditions ?? [];
  $('#intake-conditions').innerHTML = conds.length
    ? conds.map((c, i) => conditionHtml(c, i)).join('')
    : '<p class="muted small">这道题没有识别出"一句话改变整道题"的定性条件。</p>';
  $('#intake-conditions-note').textContent = conds.length
    ? `共 ${conds.length} 条关键条件，其中 ${conds.filter((c) => c.revealsInsight).length} 条会剧透，已改成提问。`
    : '';

  applyProblemToChat(p);
  renderProblemList();
  $('#intake-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** 一条关键条件的渲染（学生版：剧透的那条只给提问） */
function conditionHtml(c, i) {
  return `
    <div class="cond-item stagger ${c.revealsInsight ? 'is-locked' : ''}" style="--i:${i}">
      <div class="cond-head">
        <span class="cond-label">${esc(c.label)}</span>
        ${c.text ? `<span class="cond-quote">${esc(c.text)}</span>` : ''}
      </div>
      ${
        c.meaning
          ? `<div class="cond-meaning">${esc(c.meaning)}</div>`
          : `<div class="cond-ask">${esc(c.question ?? '这条条件在解题上起什么作用？先自己翻译一遍。')}</div>
             <div class="small muted" style="margin-top:4px">这条会直接影响解法，所以留给你自己翻译。</div>`
      }
    </div>`;
}

// ---------------------------------------------------------------------------
// 选题
// ---------------------------------------------------------------------------

async function selectProblem(problemId) {
  const { problem } = await api(`/api/problem?id=${encodeURIComponent(problemId)}`);
  state.currentProblem = problem;
  state.currentAnalysis = problem.analysis ?? null;
  state.sessionId = newSessionId(problemId);
  state.turns = 0;
  state.reachedLevels = new Set();
  state.currentLevel = null;
  state.hasMessages = false;
  state.confirmed = [];

  applyProblemToChat(problem);
  renderProblemList();
  renderScripts();
  showPage('page-chat');
  $('#input').focus();
}

function applyProblemToChat(problem) {
  $('#chat-stem').textContent = problem.stem;
  $('#chat-givens').innerHTML = (problem.givens ?? [])
    .map((g, i) => `<span class="tag stagger" style="--i:${i}">${esc(g)}</span>`)
    .join('');
  $('#chat-title').textContent = (problem.topics ?? []).slice(0, 2).join(' / ') || '题目';
  enhanceStemBoxes($('#pane-original'));
  $('#messages').innerHTML = '';
  renderEmptyState();
  $('#input').disabled = false;
  $('#btn-send').disabled = false;
  renderAnalysis(problem.analysis, problem);
  renderProgress(null, problem);
  renderUnderstood([]);
  renderEnginePath(null);
  $('#status-level').textContent = '—';
  updateLadder(null);
  setProblemView('original');
}

function renderEmptyState() {
  $('#messages').innerHTML = `
    <div class="empty-state" id="chat-empty">
      <span class="empty-icon">💬</span>
      <strong>先说说你自己的想法</strong>
      <p>不用写得很规范。哪怕是"我只知道要用自由落体公式，但不知道第二问问的是什么"这种半句话都可以 —— 我的任务就是从这种半句话里看出你卡在哪。</p>
    </div>`;
}

// ---------------------------------------------------------------------------
// 解析面板：关键变量 / 关键条件 / 知识图谱
// ---------------------------------------------------------------------------

function renderAnalysis(analysis, problem) {
  const box = $('#analysis-body');
  if (!analysis) {
    box.innerHTML = '<p class="muted small">这道题还没有解析数据。</p>';
    return;
  }

  const v = analysis.variables ?? { given: [], asked: [] };
  const kg = analysis.knowledgeGraph;

  box.innerHTML = `
    ${analysis.summary ? `<div class="analysis-summary stagger" style="--i:0">${esc(analysis.summary)}</div>` : ''}

    <div class="var-group">
      <h4 class="mini-title">关键变量 · 已知</h4>
      <div class="var-list">
        ${
          v.given?.length
            ? v.given
                .map(
                  (x, i) => `
          <div class="var-row stagger" style="--i:${i}">
            <span class="var-sym">${esc(x.symbol || '·')}</span>
            ${x.value ? `<span class="var-val">= ${esc(x.value)} ${esc(x.unit ?? '')}</span>` : `<span class="var-val">${esc(x.raw)}</span>`}
            ${x.note ? `<span class="var-note">${esc(x.note)}</span>` : ''}
          </div>`,
                )
                .join('')
            : '<p class="muted small">没有抽出结构化的已知量。</p>'
        }
      </div>
    </div>

    <div class="var-group">
      <h4 class="mini-title">关键变量 · 待求</h4>
      <div class="var-list">
        ${
          v.asked?.length
            ? v.asked
                .map(
                  (x, i) => `
          <div class="var-row is-asked stagger" style="--i:${i}">
            <span class="var-sym">${esc(x.symbol || '?')}</span>
            <span class="var-val">${esc(x.note || x.raw)}</span>
          </div>`,
                )
                .join('')
            : '<p class="muted small">没有抽出待求量。</p>'
        }
      </div>
    </div>

    <div class="var-group">
      <h4 class="mini-title">关键条件</h4>
      <div class="cond-list">
        ${
          analysis.keyConditions?.length
            ? analysis.keyConditions.map((c, i) => conditionHtml(c, i)).join('')
            : '<p class="muted small">没有识别出定性关键条件。</p>'
        }
      </div>
    </div>

    <div class="var-group">
      <h4 class="mini-title">知识图谱</h4>
      <div class="kg-wrap" id="kg-wrap"></div>
    </div>
  `;

  if (kg?.nodes?.length) {
    renderKnowledgeGraph($('#kg-wrap'), kg, { problem, mode: 'layered' });
  } else {
    $('#kg-wrap').innerHTML = '<p class="muted small">这道题还没有知识点图谱。</p>';
  }
}

/**
 * 知识图谱渲染 —— 两种形态，按可用宽度选，不是两套数据。
 *
 * `mode: 'layered'`（窄栏 / 学生侧）
 *   一行一层，从上到下"更基础的 → 本题核心"。为什么不用 SVG：
 *   SVG 会被等比缩放到容器宽度，节点文字随之缩成 8px 还互相重叠 ——
 *   图谱就退化成了装饰。分层列表在 320px 宽里仍然读得清。
 *
 * `mode: 'svg'`（全宽 / 教师侧）
 *   真正的节点图：按 level 分层排布，边自上而下带关系标签。
 *   教师页有整屏宽度，还多了"概念出现在第几步"这一层信息。
 *
 * 两种形态用的是**同一份 kg 数据**，所以不会出现"学生看到的和学生说的不一致"。
 */
function renderKnowledgeGraph(container, kg, opts = {}) {
  const nodes = kg.nodes ?? [];
  if (!nodes.length) {
    container.innerHTML = '<p class="muted small">没有知识点数据。</p>';
    return;
  }
  if (opts.mode === 'svg') renderKgSvg(container, kg, opts);
  else renderKgLayered(container, kg, opts);
}

/** 分层列表版：窄栏可读 */
function renderKgLayered(container, kg, opts = {}) {
  const nodes = kg.nodes ?? [];
  // level 大的在上（更基础）
  const levels = [...new Set(nodes.map((n) => n.level ?? 1))].sort((a, b) => b - a);
  const relOf = (fromLevel, toLevel) => {
    const fromIds = new Set(nodes.filter((n) => (n.level ?? 1) === fromLevel).map((n) => n.id));
    const toIds = new Set(nodes.filter((n) => (n.level ?? 1) === toLevel).map((n) => n.id));
    const hit = (kg.edges ?? []).find((e) => fromIds.has(e.from) && toIds.has(e.to));
    return hit?.label ?? '前置';
  };

  let i = 0;
  const html = levels
    .map((lv, li) => {
      const group = nodes.filter((n) => (n.level ?? 1) === lv);
      const label = lv === 1 ? '本题核心' : lv === 2 ? '直接前置' : '更基础';
      const connector =
        li > 0
          ? `<div class="kg-connector">${esc(relOf(levels[li - 1], lv))}</div>`
          : '';
      return `
        ${connector}
        <div class="kg-layer">
          <div class="kg-layer-head">${esc(label)}</div>
          <div class="kg-nodes">
            ${group
              .map((n) => {
                const roleText = n.role === 'core' ? '核心' : n.role === 'concept' ? '概念' : '前置';
                const cur = i;
                i += 1;
                return `<button type="button" class="kg-node ${esc(n.role)}" style="--i:${cur}" data-kg-id="${esc(n.id)}">
                  <span class="kg-node-name">${esc(n.name)}</span>
                  <span class="kg-node-role">${esc(roleText)}</span>
                </button>`;
              })
              .join('')}
          </div>
        </div>`;
    })
    .join('');

  container.innerHTML = `
    <div class="kg-layer-list">${html}</div>
    ${
      kg.edgeSource === 'derived'
        ? '<div class="kg-legend"><span class="muted">层间关系按题干文本推导，非教研标注</span></div>'
        : ''
    }
    <div id="kg-detail" hidden></div>
  `;

  bindKgNodeClicks(container, nodes);
}

/** 节点图版：全宽教师页 */
function renderKgSvg(container, kg, opts = {}) {
  const nodes = kg.nodes ?? [];
  const NW = 152;
  const NH = 44;
  const GX = 22;
  const GY = 42;
  const PAD = 10;

  const levels = [...new Set(nodes.map((n) => n.level ?? 1))].sort((a, b) => b - a);
  const columns = levels.map((lv) => nodes.filter((n) => (n.level ?? 1) === lv));

  const width = Math.max(...columns.map((c) => c.length)) * (NW + GX) - GX + PAD * 2;
  const height = columns.length * (NH + GY) - GY + PAD * 2;

  const pos = new Map();
  columns.forEach((col, ci) => {
    const rowWidth = col.length * (NW + GX) - GX;
    const startX = PAD + (width - PAD * 2 - rowWidth) / 2;
    col.forEach((n, ni) => {
      pos.set(n.id, { x: startX + ni * (NW + GX), y: PAD + ci * (NH + GY) });
    });
  });

  const roleStyle = {
    core: { fill: '#eeefff', stroke: '#4f46e5', text: '#3730a3', badge: '本题核心', badgeFill: '#4f46e5' },
    support: { fill: '#fbfaf8', stroke: '#d9d4cc', text: '#57534e', badge: '前置知识', badgeFill: '#918b82' },
    concept: { fill: '#f4efff', stroke: '#c4b5fd', text: '#6d28d9', badge: '步骤概念', badgeFill: '#7c3aed' },
  };

  const edges = (kg.edges ?? [])
    .map((e, i) => {
      const from = pos.get(e.from);
      const to = pos.get(e.to);
      if (!from || !to) return '';
      const x1 = from.x + NW / 2;
      const y1 = from.y + NH;
      const x2 = to.x + NW / 2;
      const y2 = to.y;
      const midY = (y1 + y2) / 2;
      const len = Math.hypot(x2 - x1, y2 - y1) + 40;
      return `
        <g>
          <path class="kg-edge" d="M${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}" marker-end="url(#kg-arrow)"
                style="stroke-dasharray:${len};stroke-dashoffset:${len};animation:drawLine 520ms var(--ease) forwards;animation-delay:${180 + i * 90}ms"></path>
          <text class="kg-edge-label" x="${(x1 + x2) / 2 + 4}" y="${midY + 3}">${esc(e.label ?? '')}</text>
        </g>`;
    })
    .join('');

  const nodeSvg = nodes
    .map((n, i) => {
      const p = pos.get(n.id);
      const st = roleStyle[n.role] ?? roleStyle.support;
      const sub = (n.steps ?? []).length
        ? `出现在第 ${n.steps.join('、')} 步`
        : n.role === 'core'
          ? '本题核心考点'
          : n.role === 'concept'
            ? '解法用到的概念'
            : '需要用到的基础';
      return `
        <g class="kg-node-box" data-kg-id="${esc(n.id)}"
           style="animation:popIn 380ms var(--ease-spring) backwards;animation-delay:${i * 70}ms">
          <rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="11"
                fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.5"></rect>
          <text class="kg-node-title" x="${p.x + 12}" y="${p.y + 19}">${esc(clip(n.name, 13))}</text>
          <text class="kg-node-sub" x="${p.x + 12}" y="${p.y + 34}" fill="${st.text}">${esc(sub)}</text>
        </g>`;
    })
    .join('');

  container.innerHTML = `
    <svg class="kg-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="知识图谱">
      <defs>
        <marker id="kg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#d9d4cc"></path>
        </marker>
      </defs>
      ${edges}
      ${nodeSvg}
    </svg>
    <div class="kg-legend">
      <span><i style="background:#4f46e5"></i>本题核心</span>
      <span><i style="background:#d9d4cc"></i>前置知识</span>
      <span><i style="background:#7c3aed"></i>步骤概念</span>
      ${kg.edgeSource === 'derived' ? '<span class="muted">（关系按文本推导，非教研标注）</span>' : ''}
    </div>
    <div id="kg-detail" hidden></div>
  `;

  bindKgNodeClicks(container, nodes);
  void opts;
}

/** 点节点 → 就地展开这条知识点的说明（微交互：不跳页、不弹窗） */
function bindKgNodeClicks(container, nodes) {
  container.querySelectorAll('[data-kg-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const node = nodes.find((n) => n.id === el.dataset.kgId);
      if (!node) return;
      const detail = container.querySelector('#kg-detail');
      if (!detail) return;
      const same = detail.dataset.openId === node.id && !detail.hidden;
      if (same) {
        detail.hidden = true;
        detail.dataset.openId = '';
        return;
      }
      detail.hidden = false;
      detail.dataset.openId = node.id;
      detail.className = 'kg-node-detail';
      detail.innerHTML = `
        <strong>${esc(node.name)}</strong>
        <div class="muted small" style="margin-top:4px">
          ${esc(node.note || (node.role === 'core' ? '本题的核心考点' : '本题需要用到的前置知识'))}
        </div>
        ${
          (node.steps ?? []).length
            ? `<div class="small" style="margin-top:6px">解题路径里出现在：第 ${node.steps.join('、')} 步</div>`
            : ''
        }`;
    });
  });
}

function clip(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

function bindEvents() {
  $('#composer').addEventListener('submit', onSubmit);
  $('#input').addEventListener('input', (e) => autoGrow(e.target));
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit(e);
    }
  });

  $$('.step').forEach((btn) => btn.addEventListener('click', () => showPage(btn.dataset.page)));
  $('#btn-goto-chat').addEventListener('click', () => showPage('page-chat'));
  $('#btn-change-problem').addEventListener('click', () => showPage('page-start'));

  $$('#view-switch .seg-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $$('#mode-switch .seg-btn').forEach((b) =>
    b.addEventListener('click', () => setMode(b.dataset.mode, { announce: true })),
  );
  $$('#mode-cards .mode-card').forEach((b) =>
    b.addEventListener('click', () => setMode(b.dataset.mode, { announce: true })),
  );
  $$('#seg-problem-view button').forEach((b) =>
    b.addEventListener('click', () => setProblemView(b.dataset.view)),
  );

  $('#btn-sample').addEventListener('click', () => {
    $('#stem-input').value = SAMPLE_STEM;
    $('#stem-input').focus();
    toast('已填入示例题干');
  });
  $('#btn-import').addEventListener('click', importProblem);
  $('#btn-start-chat').addEventListener('click', () => showPage('page-chat'));

  /* 完成确认层 */
  $('#done-report').addEventListener('click', () => {
    hideCompletion();
    showPage('page-report');
  });
  $('#done-stay').addEventListener('click', hideCompletion);
  $('#done-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hideCompletion();
  });

  /* 非线性跳转：不做了也能直接看报告。
     真实的学习过程是跳的，不该由系统规定"走完哪几步才放行"。 */
  $('#btn-finish').addEventListener('click', () => {
    if (!state.hasMessages) {
      toast('先说一句你的思路，报告才有东西可汇总');
      return;
    }
    showPage('page-report');
  });

  $('#btn-teacher-login').addEventListener('click', teacherLogin);
  $('#teacher-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') teacherLogin();
  });
  $$('#teacher-tabs .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.teacherTab = b.dataset.tab;
      $$('#teacher-tabs .seg-btn').forEach((x) => x.classList.toggle('on', x === b));
      loadTeacher();
    }),
  );
  $('#btn-teacher-refresh').addEventListener('click', () => {
    loadTeacher();
    toast('已刷新');
  });

  bindUpload();
  bindVoiceInput();
  bindMathInput();
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
}

async function onSubmit(e) {
  e?.preventDefault?.();
  if (state.busy) return;
  const input = $('#input');
  const utterance = input.value.trim();
  if (!utterance) return;
  if (!state.currentProblem) {
    showPage('page-start');
    return;
  }

  state.busy = true;
  $('#btn-send').disabled = true;
  input.value = '';
  autoGrow(input);

  $('#chat-empty')?.remove();
  state.hasMessages = true;
  appendStudentBubble(utterance);

  const thinking = document.createElement('div');
  thinking.className = 'thinking';
  thinking.innerHTML = '<span></span><span></span><span></span>';
  $('#messages').appendChild(thinking);
  scrollToBottom();

  try {
    const res = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: state.sessionId,
        problemId: state.currentProblem.id,
        utterance,
        mode: state.mode,
        explicitHelpSeeking: $('#help-seeking').checked,
      }),
    });

    thinking.remove();
    state.turns += 1;
    if (res.hint.level != null) {
      state.reachedLevels.add(res.hint.level);
      state.currentLevel = res.hint.level;
    }
    appendAiBubble(res);
    renderProgress(res.progress, state.currentProblem);
    $('#status-level').textContent = res.completion
      ? (res.completion.complete ? '全部完成' : `答对 ${res.completion.matched.length} 处`)
      : res.suppressed
        ? '静默观测'
        : `${res.hint.levelName.replace(/^L\d\s*/, '')}（${LEVEL_SHORT[res.hint.level] ?? ''}）`;
    renderUnderstood(res.understood);
    renderEnginePath(res);
    updateLadder(state.currentLevel);

    /* ---- 答案判定：累计学生自己算出的结果，答完就弹完成确认 ---- */
    if (res.completion?.matched?.length) {
      for (const m of res.completion.matched) {
        const key = `${m.value}|${m.unit}`;
        if (!state.confirmed.some((c) => c.key === key)) {
          state.confirmed.push({ key, value: m.value, unit: m.unit, raw: m.raw || `${m.value} ${m.unit}` });
        }
      }
    }
    if (res.completion?.complete) showCompletion(res.completion);
  } catch (err) {
    thinking.remove();
    const extra = err.status === 404 ? '\n（导入的题目在服务重启后会失效，请重新粘贴一次题目。）' : '';
    appendSystemBubble(`出错了：${err.message}${extra}`);
  } finally {
    state.busy = false;
    $('#btn-send').disabled = false;
    input.focus();
  }
}

function appendStudentBubble(text) {
  const el = document.createElement('div');
  el.className = 'msg msg-student';
  el.innerHTML = `<div class="bubble">${esc(text)}</div>`;
  $('#messages').appendChild(el);
  scrollToBottom();
}

/**
 * 渲染学伴回复。
 *
 * 这里**没有**任何"守卫拦截 / 防泄题"的展示 ——
 * 那是我们的工程内控，不是学生的学习内容（见 prompt.js 的 buildStudentEnginePath 注释）。
 * 学生看到的是：复述 → 提示 → 下一步，以及"我读懂了你的什么"。
 */
function appendAiBubble(res) {
  const el = document.createElement('div');

  /* ---- 确认轮：学生自己答对了。与"提示"在视觉上明确分开 ---- */
  if (res.completion) {
    el.className = 'msg msg-ai msg-confirm';
    const echo = (res.completion.matched ?? [])
      .map((m) => `<div>✓ 你说的：<b>${esc(m.quote || `${m.value} ${m.unit}`)}</b></div>`)
      .join('');
    const rest = res.completion.complete
      ? '<div class="confirm-echo">这道题的所有待求量你都算出来了。</div>'
      : `<div class="confirm-echo">还有 <b>${res.completion.remainingCount}</b> 个待求量没着落。</div>`;
    el.innerHTML = `
      <div class="mav">✓</div>
      <div>
        <div class="bubble">
          <div class="hint-text">${esc(res.message)}</div>
          ${echo}${rest}
          <div class="confirm-note">这些数字是你自己写出来的，我没有替你算。</div>
        </div>
      </div>`;
    $('#messages').appendChild(el);
    scrollToBottom();
    return;
  }

  el.className = 'msg msg-ai';

  const chips = [];
  if (res.hint.level != null) {
    chips.push(`<span class="level-chip level-${res.hint.level}">${esc(res.hint.levelName)}</span>`);
  }
  if (res.suppressed) chips.push('<span class="chip">静默观测 · 没打扰你</span>');
  if (res.refused) chips.push('<span class="chip chip-refuse">没给答案，给了下一步</span>');
  if ((res.hint.concepts ?? []).length) {
    chips.push(...res.hint.concepts.slice(0, 3).map((c) => `<span class="chip">${esc(c)}</span>`));
  }

  const parts = String(res.message ?? '').split('\n\n');
  const body = parts
    .map((p) => {
      const safe = esc(p);
      if (p.startsWith('【下一步】')) return `<div class="next-ask">${safe}</div>`;
      if (p.startsWith('我理解你的意思是') || p.startsWith('我先把你的话') || p.startsWith('我还没听到')) {
        return `<div class="restate">${safe}</div>`;
      }
      return `<div class="hint-text">${safe}</div>`;
    })
    .join('<div style="height:8px"></div>');

  el.innerHTML = `<div class="mav">AI</div><div><div class="bubble">${body}</div><div class="msg-meta">${chips.join('')}</div></div>`;
  $('#messages').appendChild(el);
  scrollToBottom();
}

function appendSystemBubble(text) {
  const el = document.createElement('div');
  el.className = 'msg msg-ai';
  el.innerHTML = `<div class="mav">!</div><div class="bubble" style="background:var(--risk-soft);border-color:#f7cfca;color:var(--risk);white-space:pre-wrap">${esc(text)}</div>`;
  $('#messages').appendChild(el);
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// 符号面板与自动替换
// ---------------------------------------------------------------------------

/**
 * 学生反馈："一些物理的表达式很难写上去。"
 *
 * 这是实情 —— ² ₀ μ Ω √ ≈ 在普通键盘上打不出来，
 * 写不出公式的学生只能用文字绕，思路的表达精度直接下降。
 *
 * 两层机制：
 *   ① 符号面板：点一下就插到光标处（零学习成本）
 *   ② 自动替换：v^2 → v²、mu → μ、>= → ≥（打字即得，可关闭）
 *
 * 规则不写在这里，而是 import 自 mathinput.js —— 那个文件是纯函数，
 * 能被 test/mathinput.test.js 直接跑，规则不会漂移成两份。
 */
function bindMathInput() {
  const bar = $('#mathbar');
  const toggle = $('#mathbar-toggle');
  const body = $('#mathbar-body');
  const autoBox = $('#mathbar-auto');
  const input = $('#input');
  if (!bar || !toggle || !body || !input) return;

  // ---- 面板内容 ----
  body.innerHTML = `${PALETTE.map(
    (g) => `
      <div class="mathbar-row">
        <span class="mbr-label">${esc(g.group)}</span>
        <span class="mbr-items">${g.items
          .map((s) => `<button type="button" class="sym-btn" data-sym="${esc(s)}">${esc(s)}</button>`)
          .join('')}</span>
      </div>`,
  ).join('')}
      <div class="mathbar-hint">
        也可以直接打字：<code>v^2</code> 变 v²、<code>v_0</code> 变 v₀、<code>mu</code> 变 μ、
        <code>sqrt</code> 变 √、<code>&gt;=</code> 变 ≥（打完后跟一个空格或标点即可）
      </div>`;

  toggle.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  });

  // ---- 点一下插入到光标处（不要让光标跳到末尾） ----
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('.sym-btn');
    if (!btn || input.disabled) return;
    insertAtCaret(input, btn.dataset.sym);
  });

  // ---- 自动替换：逐字触发，只替换"光标之前刚打完的那一段" ----
  input.addEventListener('input', () => {
    if (autoBox.checked) applyShortcutAtCaret(input);
    // 增高由既有监听负责（见文件上方 `#input` 的 input 监听），这里不重复挂
  });

  /**
   * 失焦与提交前做一次 flush：
   * 希腊字母要"等一个边界"才替换，所以行尾的 `mu` 需要在这里收掉。
   */
  input.addEventListener('blur', () => {
    if (autoBox.checked) applyShortcutAtCaret(input, { flush: true });
  });
  $('#composer')?.addEventListener('submit', () => {
    if (autoBox.checked) applyShortcutAtCaret(input, { flush: true });
  });
}

/** 把 text 插到光标处，并把光标移到插入内容之后 */
function insertAtCaret(el, text) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const pos = start + text.length;
  el.setSelectionRange(pos, pos);
  el.focus();
  autoGrow(el);
}

/**
 * 在光标处跑一次自动替换。
 *
 * 只改"光标之前刚打完的那一段"：整串重写会把光标顶到末尾，
 * 学生在句中改一个字就会被打断 —— 那比不支持符号更烦人。
 */
function applyShortcutAtCaret(el, opts) {
  const caret = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, caret);
  const hit = applyShortcut(before, opts);
  if (!hit) return;
  el.value = before.slice(0, hit.start) + hit.replacement + el.value.slice(caret);
  const pos = hit.start + hit.replacement.length;
  el.setSelectionRange(pos, pos);
}

// ---------------------------------------------------------------------------
// 题干阅读框（超长题目在框内滚动，不把整页拉长）
// ---------------------------------------------------------------------------

/**
 * 检测题干有没有被截断，并给出"还有内容"的提示。
 *
 * 为什么需要 JS 而不是纯 CSS：
 *   纯 max-height + overflow 对短题目本来就不生效（这是好事），
 *   但**渐隐遮罩和提示文字必须只在真正被截断时出现** ——
 *   否则一道两行的题目下面挂着"框内可滚动查看全文"，那是骗人。
 *
 * 边界值（min(46vh, 420px)）写在 CSS 里，这里只负责判断与提示。
 */
function enhanceStemBoxes(root = document) {
  root.querySelectorAll('.stem-box').forEach((box) => {
    const stem = box.querySelector('.stem');
    if (!stem) return;

    // 隐藏状态下量不出高度（都是 0），此时不判断，等可见时再量
    if (!stem.clientHeight) return;

    const overflow = stem.scrollHeight - stem.clientHeight > 8;
    box.classList.toggle('is-long', overflow);

    // 提示是 box 的**兄弟节点**，不是子节点 —— 放在里面会被 ::after 渐隐层盖住（截图验证过）
    const hint = box.parentElement?.querySelector('.stem-hint') ?? box.querySelector('.stem-hint');
    if (hint) {
      hint.hidden = !overflow;
      if (overflow) {
        const chars = (stem.textContent ?? '').trim().length;
        hint.textContent = `题目较长（约 ${chars} 字），框内可滚动查看全文`;
      }
    }

    const atBottom = () => stem.scrollTop + stem.clientHeight >= stem.scrollHeight - 6;
    if (stem.dataset.scrollBound !== '1') {
      stem.addEventListener('scroll', () => box.classList.toggle('is-at-bottom', atBottom()), { passive: true });
      stem.dataset.scrollBound = '1';
    }
    box.classList.toggle('is-at-bottom', atBottom());
  });
}
// ---------------------------------------------------------------------------
// 完成确认
// ---------------------------------------------------------------------------

/**
 * 学生自己把题做出来了 —— 给他一个明确的、需要确认的停顿。
 *
 * 两个刻意的设计：
 *   ① 界面上出现的**每一个数字都来自学生自己的原话**（`matched` 由引擎从
 *      他的发言里取出来，不是引擎算的）。所以这里只做回显，不做任何数值计算。
 *   ② 按钮里没有"再做一题"这种催促。学习本来就该在这里停一下。
 */
function showCompletion(completion) {
  const overlay = $('#done-overlay');
  if (!overlay) return;

  const answers = state.confirmed.length
    ? state.confirmed
    : (completion.matched ?? []).map((m) => ({ value: m.value, unit: m.unit, raw: m.raw || `${m.value} ${m.unit}` }));

  $('#done-answers').innerHTML = answers
    .map((a, i) => `<span class="done-answer" style="--i:${i}">${esc(a.raw)}</span>`)
    .join('');

  const hints = state.turns;
  $('#done-stats').innerHTML = `
    <div class="ds"><div class="ds-n">${answers.length}</div><div class="ds-l">个待求量</div></div>
    <div class="ds"><div class="ds-n">${hints}</div><div class="ds-l">轮对话</div></div>
    <div class="ds"><div class="ds-n">${state.reachedLevels.size ? 'L' + Math.max(...state.reachedLevels) : '—'}</div><div class="ds-l">用到的最高提示</div></div>`;

  overlay.hidden = false;
  $('#done-report').focus();
}

function hideCompletion() {
  const overlay = $('#done-overlay');
  if (overlay) overlay.hidden = true;
}

// ---------------------------------------------------------------------------
// 学习状态
// ---------------------------------------------------------------------------

function renderProgress(progress, problem) {
  const total = progress?.stepCount || problem?.stepCount || 0;
  const idx = progress?.stepIndex ?? null;
  const completed = new Set(progress?.completed ?? []);

  // ---- 路径轨道：编号 + 状态，随进度点亮 ----
  renderPathTrack($('#path-track'), { total, current: idx, completed });

  if (!progress) {
    $('#progress-fill').style.width = '0%';
    $('#progress-text').textContent = problem ? `这道题共 ${total} 个关键步骤` : '还没有开始';
    return;
  }
  const pct = idx && total ? Math.round((idx / total) * 100) : 0;
  $('#progress-fill').style.width = `${pct}%`;
  $('#progress-text').textContent =
    idx && total ? `第 ${idx} / ${total} 步 · 判断把握：${progress.confidenceLabel}` : `还看不出你停在哪一步 · 共 ${total} 步`;
}

/**
 * 路径轨道。
 *
 * @param {HTMLElement} box
 * @param {{total:number, current:number|null, completed:Set<number>, steps?:Array, teacher?:boolean}} opts
 *
 * 学生版只渲染编号（步骤名 = 解法，不能给）；
 * 教师版会多渲染一层步骤名与"被问了几轮"，因为教研要看的就是那个。
 */
function renderPathTrack(box, opts) {
  if (!box) return;
  const { total, current = null, completed = new Set(), steps = null, teacher = false } = opts;

  if (!total) {
    box.innerHTML = '<span class="muted small">这道题还没有路径步骤。</span>';
    return;
  }

  const titleOf = (i) => (steps ? steps.find((s) => s.index === i)?.title : null);

  box.innerHTML = Array.from({ length: total }, (_, k) => {
    const i = k + 1;
    let cls = '';
    if (i === current) cls = 'current';
    else if (completed.has(i)) cls = 'done';
    /**
     * 轨道上**只写编号**。
     *
     * 曾经在点下面挂过步骤名（absolute + nowrap），结果 8 个点挨在一起时
     * 8 个标题全部水平重叠，糊成一团彩色的字 —— 截图里一眼就能看到。
     * 而步骤名在下方的列表里已经有了，轨道不需要重复这一层。
     * 现在标题只放在 title 属性里，悬停才出现。
     */
    const label = teacher && titleOf(i) ? `第 ${i} 步 · ${titleOf(i)}` : `第 ${i} 步`;
    return `<span class="path-dot ${cls}" title="${esc(label)}">${i}</span>`;
  }).join('');
  box.classList.toggle('teacher', teacher);
}

/** 教师版：路径进度列表（带步骤名与访问次数） */
function renderPathList(box, pathProgress) {
  if (!box) return;
  const steps = pathProgress?.steps ?? [];
  if (!steps.length) {
    box.innerHTML = '<p class="muted">这个会话还没有定位记录。</p>';
    return;
  }
  box.innerHTML = `
    <div class="path-track teacher" id="teacher-path-track"></div>
    <div class="path-list">
      ${steps
        .map(
          (s) => `
        <div class="path-list-row ${s.isCurrent ? 'current' : s.reached ? 'reached' : ''}">
          <span class="pl-idx">${s.index}</span>
          <span class="pl-title">${esc(s.title)} <span class="kind-pill">${esc(s.kind)}</span></span>
          ${s.visits ? `<span class="pl-visits">问了 ${s.visits} 轮</span>` : '<span class="muted small">没走到</span>'}
        </div>`,
        )
        .join('')}
    </div>
    <p class="muted small" style="margin-top:8px">
      「问了 N 轮」是这一节课的真实卡点分布 —— 比"最后停在哪一步"信息量大得多：
      学生可能先走到第 5 步又退回来问第 2 步，只记最后位置会把整条轨迹丢掉。
    </p>`;
  renderPathTrack($('#teacher-path-track'), {
    total: pathProgress.stepCount,
    current: pathProgress.lastLocatedStep,
    completed: new Set(pathProgress.reachedSteps ?? []),
    steps,
    teacher: true,
  });
}

function renderUnderstood(list) {
  const box = $('#understood-list');
  if (!list || !list.length) {
    box.innerHTML =
      '<li class="muted">这一轮我还没抓到可以肯定的部分。把思路再说具体一点，我就能指出你想对了什么。</li>';
    return;
  }
  box.innerHTML = list
    .map(
      (s, i) => `<li style="--i:${i}"><span class="uf-check">✓</span><span>${esc(s)}</span></li>`,
    )
    .join('');
}

function renderEnginePath(res) {
  const box = $('#engine-path');
  if (!res) {
    box.innerHTML = '<li class="muted small">你说一句话，这里会显示我的判断过程。</li>';
    $('#engine-latency').textContent = '—';
    return;
  }
  const toneIcon = { ok: '✓', info: '·', hold: '⏸' };
  box.innerHTML = (res.enginePath ?? [])
    .map(
      (e, i) => `<li class="engine-step tone-${esc(e.tone)} stagger" style="--i:${i}">
        <span class="engine-dot">${toneIcon[e.tone] ?? '·'}</span>
        <span class="engine-stage">${esc(engineStageName(e.stage))}</span>
        <span class="engine-label">${esc(e.label)}</span>
      </li>`,
    )
    .join('');
  $('#engine-latency').textContent = res.meta ? `${res.meta.latencyMs} ms` : '—';
}

function engineStageName(stage) {
  return (
    { intake: '读题', understand: '听懂', locate: '定位', route: '决定', generate: '成文', guard: '复核' }[stage] ??
    stage
  );
}

function updateLadder(currentLevel) {
  $$('#ladder li').forEach((li) => {
    const lv = Number(li.dataset.level);
    li.classList.toggle('reached', state.reachedLevels.has(lv));
    li.classList.toggle('current', currentLevel === lv);
  });
}

// ---------------------------------------------------------------------------
// 拍照上传（当前仅占位，但把缺口说清楚）
// ---------------------------------------------------------------------------

const OCR_PLAN = `图像 → 题干 的补法（约 0.5 天，视模型而定）

1) 取图：前端 FileReader 读为 dataURL（已实现，见下方预览）
2) 调用：把 dataURL 作为 image_url 传给视觉模型

   POST {LLM_BASE_URL}/chat/completions
   {
     "model": "qwen-vl-max",           // 或 glm-4v / gpt-4o
     "messages": [{
       "role": "user",
       "content": [
         { "type": "text", "text": "把这张题的题干完整转录为纯文本，保留所有数值与单位，不要解答。" },
         { "type": "image_url", "image_url": { "url": "<dataURL>" } }
       ]
     }]
   }

3) 落库：转录文本 → 直接走已经做好的 /api/problem/import
   （读题链路已经通了，所以这一步接上视觉模型后是真正的"端到端可用"）
4) 兜底：若模型置信度低，让用户手动修正题干后再进入引导流程

当前 Demo 的做法：不伪造 OCR 结果，明确标出这是未完成的一环。`;

// ---------------------------------------------------------------------------
// 语音输入（Web Speech API）
// ---------------------------------------------------------------------------

/**
 * 用说的比用打的自然 —— 而这条路**不需要任何硬件**。
 *
 * 为什么值得单独做：这个产品的核心动作是"学生交出自己的思路"，
 * 而真实学生在纸上、在草稿上想问题时的表达是口语的。
 * README 里把"实时笔迹观测"列为需要摄像头/点阵笔（要企业支持），
 * 但语音输入是同一件事里**零硬件成本**的那一半。
 *
 * 三个刻意的处理：
 *   ① 浏览器不支持就**不显示按钮**（不显示一个点了没用的东西）
 *   ② 识别是增量的（interimResults）—— 说话时字就一个个出现，学生知道它在听
 *   ③ 识别结果**追加**到输入框，不覆盖学生已经打的字
 */
function bindVoiceInput() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('#btn-mic');
  if (!SR || !btn) return; // 不支持就保持 hidden，什么都不做

  btn.hidden = false;
  let rec = null;
  let recording = false;

  const setRecording = (on) => {
    recording = on;
    btn.classList.toggle('rec', on);
    // 文案必须与真实交互一致：这里是"点一下开始 / 再点一下结束"，不是按住说话。
    // 写"按住说话"而实现是点击切换，会让学生一直按着不动 —— 然后用不了。
    $('#mic-label').textContent = on ? '在听…点一下停' : '说思路';
  };

  btn.addEventListener('click', () => {
    if (recording) {
      rec?.stop();
      return;
    }
    rec = new SR();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;

    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      const input = $('#input');
      // 追加而不是覆盖：学生可能已经手打了一半
      input.value = `${input.value}${finalText}${interim}`.trim();
      autoGrow(input);
      if (finalText) finalText = '';
    };
    rec.onerror = (e) => {
      setRecording(false);
      toast(e.error === 'not-allowed' ? '麦克风没有授权，请在浏览器地址栏允许后重试' : `语音识别出错：${e.error}`);
    };
    rec.onend = () => setRecording(false);

    try {
      rec.start();
      setRecording(true);
      toast('正在听……说说你的思路');
    } catch {
      setRecording(false);
    }
  });
}

function bindUpload() {
  const fileInput = $('#file-input');
  const dropzone = $('#dropzone');
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleImage(file);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handleImage(file);
  });

  $('#ocr-explain').addEventListener('click', () => {
    const pre = $('#ocr-plan');
    pre.hidden = !pre.hidden;
    if (!pre.textContent) pre.textContent = OCR_PLAN;
  });
}

function handleImage(file) {
  if (!file.type.startsWith('image/')) {
    toast('请选择图片文件');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = $('#preview');
    img.src = String(reader.result);
    img.hidden = false;
  };
  reader.readAsDataURL(file);
  $('#ocr-notice').hidden = false;
}

// ---------------------------------------------------------------------------
// 学习报告
// ---------------------------------------------------------------------------

/**
 * 学习报告。
 *
 * **有 sessionId 就去问服务端**，不再用"客户端有没有对话记录"来挡。
 * 原因是被分享链接暴露出来的：`?session=xxx` 进来时客户端没有 currentProblem，
 * 于是直接显示"还没有可以汇总的对话"—— 而服务端明明有这份报告。
 * 判断"有没有内容可汇总"是服务端的事（它才知道这个会话存不存在、有几轮）。
 */
async function loadReport() {
  const box = $('#report-body');
  if (!state.sessionId) {
    renderReportEmpty();
    return;
  }

  box.innerHTML = '<div class="card"><div class="skeleton" style="height: 120px"></div></div>';
  try {
    const { report } = await api(`/api/report?sessionId=${encodeURIComponent(state.sessionId)}`);
    if (!report.hintStats.total && !report.hintStats.confirmed) {
      renderReportEmpty();
      return;
    }
    renderReport(report);
  } catch (err) {
    if (err.status === 404) {
      renderReportEmpty('这个会话已经不在了（公开演示部署在 serverless 上，冷启动会丢会话）。');
      return;
    }
    box.innerHTML = `<div class="card"><p>报告生成失败：${esc(err.message)}</p></div>`;
  }
}

function renderReportEmpty(note) {
  const box = $('#report-body');
  box.innerHTML = `
    <div class="empty-state card">
      <span class="empty-icon">📄</span>
      <strong>还没有可以汇总的对话</strong>
      <p>${esc(note || '先去「一起想」页跟学伴聊几轮，再回来生成报告。')}</p>
      <button class="btn btn-primary" id="btn-goto-chat-2">去一起想</button>
    </div>`;
  $('#btn-goto-chat-2')?.addEventListener('click', () => showPage('page-chat'));
}

const STUCK_KIND_LABEL = {
  not_started: '还没开始想',
  knowledge_gap: '不确定该用哪个规律',
  precondition_gap: '漏了规律的前提条件',
  direction_lost: '知道规律但走不下去',
  execution_error: '思路对但执行出错',
  dead_end_path: '当前这条路走不通，需要换工具',
  finished: '已接近完成',
};

function renderReport(r) {
  const ind = Math.round(r.independence.score * 100);
  $('#report-body').innerHTML = `
    <div class="report-grid">
      <div class="card report-full">
        <div class="card-head">
          <h2>${esc(r.problemTitle)}</h2>
          <span class="pill">${esc(r.meta.engine === 'llm' ? `真模型 ${r.meta.model ?? ''}` : '离线规则桩')}</span>
        </div>
        <p class="muted small">下面三步是：卡在哪（卡点清单）→ 为什么卡（深层问题）→ 下一步做什么（行动建议）。</p>
      </div>

      <div class="card">
        <div class="card-head"><h3>独立完成度</h3></div>
        <div class="independence-num">${ind}<span>%</span></div>
        <div class="independence-bar"><div class="independence-fill" style="width:${ind}%"></div></div>
        <p class="small" style="color:var(--ink-2)">${esc(r.independence.note)}</p>
        <p class="muted small" style="margin-top:8px">
          这个数字衡量的是「你得到的帮助强度」，不是你的水平。被示范得越多，这个数越低。
        </p>
      </div>

      <div class="card">
        <div class="card-head"><h3>我帮了你多少</h3></div>
        <div class="stat-row">
          <div class="stat"><span class="stat-num">${r.hintStats.total}</span><span class="stat-label">引导轮次</span></div>
          <div class="stat"><span class="stat-num">${r.hintStats.byLevel[1] ?? 0}</span><span class="stat-label">问前提</span></div>
          <div class="stat"><span class="stat-num">${r.hintStats.byLevel[2] ?? 0}</span><span class="stat-label">给方向</span></div>
        </div>
        <div class="stat-row" style="margin-top:8px">
          <div class="stat"><span class="stat-num">${r.hintStats.byLevel[3] ?? 0}</span><span class="stat-label">示范动作</span></div>
          <div class="stat"><span class="stat-num">${r.hintStats.byLevel[0] ?? 0}</span><span class="stat-label">澄清问题</span></div>
          <div class="stat"><span class="stat-num green">${r.hintStats.total - (r.hintStats.byLevel[3] ?? 0)}</span><span class="stat-label">只靠问句</span></div>
        </div>
        ${
          r.hintStats.confirmed
            ? `<div class="stat-row" style="margin-top:8px">
                 <div class="stat"><span class="stat-num green">${r.hintStats.confirmed}</span><span class="stat-label">你自己算出的结果</span></div>
                 ${r.hintStats.confirmedComplete ? '<div class="stat"><span class="stat-num green">✓</span><span class="stat-label">整题独立完成</span></div>' : ''}
               </div>
               <p class="muted small" style="margin-top:6px">
                 这一栏是"你算对了"的次数 —— 它不该被算进"我帮了你多少"，所以单独列出来。
               </p>`
            : ''
        }
      </div>

      <div class="card report-full">
        <div class="card-head"><h3>① 卡点清单</h3><span class="pill">卡在哪</span></div>
        ${
          r.stuckPoints.length
            ? r.stuckPoints
                .map(
                  (s) => `
            <div class="stuck-item">
              <div class="stuck-head">
                <strong>${esc(s.stepTitle)}</strong>
                <span class="kind-tag kind-${esc(s.kind)}">${esc(STUCK_KIND_LABEL[s.kind] ?? s.kind)}</span>
                <span class="chip">引导 ${s.hintRounds} 轮</span>
                <span class="chip">最高用到 L${s.maxLevel}</span>
              </div>
              ${
                s.misconceptionLabels.length
                  ? `<div class="small" style="color:var(--ink-2)">这一步的问题：${s.misconceptionLabels.map(esc).join('；')}</div>`
                  : '<div class="small muted">还没归到具体类型，属于"暂时没想到"。</div>'
              }
            </div>`,
                )
                .join('')
            : '<p class="muted">本轮没有出现明显卡点。</p>'
        }
      </div>

      <div class="card">
        <div class="card-head"><h3>② 深层问题</h3><span class="pill">为什么卡</span></div>
        ${
          r.deeperIssues.length
            ? `<ul class="bullet-list">${r.deeperIssues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
            : '<p class="muted">未归纳出系统性缺口。</p>'
        }
      </div>

      <div class="card">
        <div class="card-head"><h3>③ 举一反三建议</h3><span class="pill">下一步做什么</span></div>
        ${r.recommendations
          .map(
            (rec) => `
          <div class="rec-item">
            <strong>${esc(rec.topic)}</strong>
            <p>${esc(rec.reason)}</p>
            <span class="drill">✎ ${esc(rec.drill)}</span>
          </div>`,
          )
          .join('')}
      </div>

      <div class="card report-full">
        <div class="card-head"><h3>下一步行动</h3></div>
        <ol class="action-list">${r.nextActions.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// 教师视图
// ---------------------------------------------------------------------------

function gateMessage(text, warn = true) {
  const msg = $('#teacher-gate-msg');
  msg.hidden = false;
  msg.className = warn ? 'notice notice-warn' : 'notice';
  msg.textContent = text;
}

function lockTeacher(text) {
  state.teacherKey = '';
  sessionStorage.removeItem('dsh-teacher-key');
  $('#teacher-gate').hidden = false;
  $('#teacher-body').hidden = true;
  if (text) gateMessage(text);
}

/**
 * 确保教师视图已解锁。
 *
 * 三种形态都要处理（服务端的三种模式见 router.js 的 teacherMode）：
 *   'open' 本地开发模式 —— 不需要口令，**先无口令试一次**，成功就直接进
 *   'key'  需要口令 —— 401 时显示口令输入框
 *   'off'  公网部署已锁死 —— 403 时显示"本部署形态已关闭"
 */
async function ensureTeacherUnlocked() {
  if (!$('#teacher-body').hidden) return true;
  try {
    await api('/api/teacher/overview');
    $('#teacher-gate').hidden = true;
    $('#teacher-body').hidden = false;
    $('#teacher-gate-msg').hidden = true;
    return true;
  } catch (err) {
    if (err.status === 401) {
      $('#teacher-gate').hidden = false;
      $('#teacher-body').hidden = true;
      if (state.teacherKey) gateMessage('口令不正确，或服务端已改过口令。请重新输入。');
      return false;
    }
    lockTeacher(err.hint ? `${err.message}（${err.hint}）` : err.message);
    return false;
  }
}

async function teacherLogin() {
  const key = $('#teacher-key').value.trim();
  state.teacherKey = key;
  if (key) sessionStorage.setItem('dsh-teacher-key', key);
  else sessionStorage.removeItem('dsh-teacher-key');

  try {
    await api('/api/teacher/overview');
    $('#teacher-gate').hidden = true;
    $('#teacher-body').hidden = false;
    $('#teacher-gate-msg').hidden = true;
    loadTeacher();
  } catch (err) {
    if (err.status === 401) {
      gateMessage('口令不正确。本地未配口令时可以留空直接进入；配了口令则要填对。');
      return;
    }
    lockTeacher(err.hint ? `${err.message}（${err.hint}）` : err.message);
  }
}

async function loadTeacher() {
  if (!(await ensureTeacherUnlocked())) return;
  try {
    if (state.teacherTab === 'overview') return await renderTeacherOverview();
    if (state.teacherTab === 'session') return await renderTeacherSession();
    if (state.teacherTab === 'problem') return await renderTeacherProblem();
    if (state.teacherTab === 'eval') return await renderTeacherEval();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      lockTeacher(`口令失效：${err.message}`);
      return;
    }
    $('#teacher-content').innerHTML = `<div class="card"><p>加载失败：${esc(err.message)}</p></div>`;
  }
}

async function renderTeacherOverview() {
  const box = $('#teacher-content');
  box.innerHTML = '<div class="card"><div class="skeleton" style="height: 140px"></div></div>';
  const d = await api('/api/teacher/overview');

  box.innerHTML = `
    <div class="stat-row teacher-stats">
      <div class="stat"><span class="stat-num">${d.registry.library}</span><span class="stat-label">题库题目</span></div>
      <div class="stat"><span class="stat-num">${d.registry.imported}</span><span class="stat-label">现场导入题目</span></div>
      <div class="stat"><span class="stat-num">${d.sessions}</span><span class="stat-label">活跃会话</span></div>
      <div class="stat"><span class="stat-num">${d.summary.turns}</span><span class="stat-label">引导轮次</span></div>
      <div class="stat"><span class="stat-num">${d.summary.guardBlocked}</span><span class="stat-label">护栏拦截</span></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>帮助强度分布</h3></div>
        <p class="muted small">L1 占比越高，说明学生越是靠自己走过去的 —— 这是我们希望看到的形状。</p>
        ${renderBarChart([
          ['L0 澄清', d.summary.byLevel[0] ?? 0, 'var(--ink-3)'],
          ['L1 问前提', d.summary.byLevel[1] ?? 0, 'var(--ok)'],
          ['L2 给方向', d.summary.byLevel[2] ?? 0, 'var(--brand)'],
          ['L3 示范', d.summary.byLevel[3] ?? 0, 'var(--warn)'],
        ])}
      </div>
      <div class="card">
        <div class="card-head"><h3>卡点性质分布</h3></div>
        <p class="muted small">教研最关心的一个问题：学生普遍卡在哪一类。</p>
        ${
          d.summary.stuckKindDistribution.length
            ? renderBarChart(
                d.summary.stuckKindDistribution.map((s) => [
                  STUCK_KIND_LABEL[s.kind] ?? s.kind,
                  s.count,
                  s.kind === 'precondition_gap' ? 'var(--ok)' : 'var(--brand)',
                ]),
              )
            : '<p class="muted">还没有数据。去学生视图聊几轮。</p>'
        }
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>会话列表</h3><span class="pill pill-muted">${esc(d.note)}</span></div>
      ${
        d.sessionsDetail.length
          ? `<table class="tbl">
              <thead><tr><th>会话</th><th>题目</th><th>来源</th><th>知识点</th><th>轮次</th><th></th></tr></thead>
              <tbody>${d.sessionsDetail
                .map(
                  (s) => `<tr>
                    <td class="mono">${esc(s.sessionId.slice(0, 18))}</td>
                    <td class="mono">${esc(s.problemId)}</td>
                    <td>${s.problemSource === 'imported' ? '<span class="tag tag-imported">导入</span>' : '<span class="tag">题库</span>'}</td>
                    <td>${s.topics.map((t) => `<span class="tag tag-soft">${esc(t)}</span>`).join(' ')}</td>
                    <td>${s.turns}</td>
                    <td><button class="btn btn-ghost btn-sm" data-open-session="${esc(s.sessionId)}">复盘</button></td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table>`
          : '<p class="muted">还没有活跃会话。</p>'
      }
    </div>`;

  $$('[data-open-session]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.teacherSessionId = btn.dataset.openSession;
      state.teacherTab = 'session';
      $$('#teacher-tabs .seg-btn').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'session'));
      loadTeacher();
    }),
  );
}

function renderBarChart(rows) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return `<div class="bars">${rows
    .map(
      ([label, value, color], i) => `
      <div class="bar-row">
        <span class="bar-label">${esc(label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.round((value / max) * 100)}%;background:${color};transition-delay:${i * 80}ms"></span></span>
        <span class="bar-value">${value}</span>
      </div>`,
    )
    .join('')}</div>`;
}

async function renderTeacherSession() {
  const box = $('#teacher-content');
  const sessionId = state.teacherSessionId ?? state.sessionId;
  if (!sessionId) {
    box.innerHTML = '<div class="card"><p class="muted">还没有会话。先去学生视图和学生聊几轮。</p></div>';
    return;
  }
  box.innerHTML = '<div class="card"><div class="skeleton" style="height: 160px"></div></div>';
  const d = await api(`/api/teacher/session?sessionId=${encodeURIComponent(sessionId)}`);

  box.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>会话 ${esc(d.sessionId)}</h3>
        <span class="pill ${d.problem.source === 'imported' ? 'pill-muted' : ''}">${d.problem.source === 'imported' ? '导入题目（图谱由模型生成）' : '题库题目（图谱经教研维护）'}</span>
      </div>
      <div class="kv-grid">
        <div><span class="k">题目</span><span class="v mono">${esc(d.problem.id)}</span></div>
        <div><span class="k">知识点</span><span class="v">${d.problem.topics.map((t) => `<span class="tag tag-soft">${esc(t)}</span>`).join(' ')}</span></div>
        <div><span class="k">引导轮次</span><span class="v">${d.summary.totalTurns}（层级序列 L${d.summary.levelProgression.join(' → L') || '-'}）</span></div>
        <div><span class="k">护栏拦截</span><span class="v">${d.summary.guardBlocked} 次</span></div>
      </div>
    </div>

    ${
      d.problem.importMeta?.warnings?.length
        ? `<div class="card"><div class="card-head"><h3>⚠ 读题质量告警</h3></div>
            <ul class="bullet-list">${d.problem.importMeta.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
            <p class="muted small">
              这条链路是"让模型现场读题"，所以<strong>必须</strong>把它的不确定性显示出来，
              否则教研会把模型生成的路径当成教研审过的路径。
            </p></div>`
        : ''
    }

    <div class="card">
      <div class="card-head"><h3>路径进度</h3><span class="pill pill-muted">${esc(d.summary.pathProgress.graphName ?? '')}</span></div>
      <div id="teacher-path"></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>逐轮复盘</h3><span class="pill pill-muted">引擎的完整判断链路</span></div>
      ${
        d.turns.length
          ? d.turns
              .map(
                (t) => `
        <div class="turn-card">
          <div class="turn-head">
            <strong>第 ${t.index} 轮</strong>
            <span class="level-chip level-${t.deliveredLevel}">${esc(t.levelName)}</span>
            <span class="kind-tag kind-${esc(t.stuckKind)}">${esc(STUCK_KIND_LABEL[t.stuckKind] ?? t.stuckKind)}</span>
            <span class="chip">第 ${t.stepIndex ?? '?'} 步${t.stepTitle ? ` · ${esc(t.stepTitle)}` : ''}</span>
            <span class="chip ${t.guardPassed ? '' : 'chip-block'}">${
              t.guardPassed
                ? t.repairStrategy
                  ? `护栏重写(${esc(t.repairStrategy)})`
                  : '一次通过'
                : `拦截 ${esc(t.violationKinds.join(','))}`
            }</span>
            ${t.voice?.multiQuestion ? '<span class="chip chip-block">一句里问了两个问题</span>' : ''}
            ${t.voice?.emptyTalkRemoved?.length ? `<span class="chip chip-block">删掉空话：${esc(t.voice.emptyTalkRemoved.join('、'))}</span>` : ''}
          </div>
          <div class="turn-body">
            <div><span class="k">学生说</span><span class="v">${esc(t.utterance)}</span></div>
            <div><span class="k">实际发出</span><span class="v">${esc(t.hintText)}</span></div>
            <div><span class="k">学生可见全文</span><span class="v pre">${esc(t.studentMessage)}</span></div>
            <div><span class="k">决策依据</span><span class="v">${esc(t.rationale)}</span></div>
            ${
              t.misconceptionLabels.length
                ? `<div><span class="k">判定错因</span><span class="v">${t.misconceptionLabels.map(esc).join('；')}</span></div>`
                : ''
            }
            ${
              t.evidenceQuotes.length
                ? `<div><span class="k">学生原话证据</span><span class="v">${t.evidenceQuotes.map((q) => `<span class="quote">${esc(q)}</span>`).join(' ')}</span></div>`
                : ''
            }
            ${
              t.guardViolations.length
                ? `<div><span class="k">被拦下的片段</span><span class="v mono small">${t.guardViolations
                    .map((v) => `${esc(v.kind)}：${esc(v.match ?? v.detail)}`)
                    .join('<br>')}</span></div>`
                : ''
            }
          </div>
          <details class="fold-inline">
            <summary>展开引擎判断链路（${t.trace.length} 步）</summary>
            <div class="trace-list">
              ${t.trace
                .map(
                  (e) => `<div class="trace-item"><span class="trace-stage">${esc(e.stage)}</span><span>${esc(e.message)}</span></div>`,
                )
                .join('')}
            </div>
          </details>
        </div>`,
              )
              .join('')
          : '<p class="muted">这个会话还没有轮次。</p>'
      }
    </div>`;

  renderPathList($('#teacher-path'), d.summary.pathProgress);
}

async function renderTeacherProblem() {
  const box = $('#teacher-content');
  if (!state.currentProblem) {
    box.innerHTML = '<div class="card"><p class="muted">先去学生视图选一道题或导入一道题。</p></div>';
    return;
  }
  box.innerHTML = '<div class="card"><div class="skeleton" style="height: 160px"></div></div>';
  const d = await api(`/api/teacher/problem?id=${encodeURIComponent(state.currentProblem.id)}`);
  const p = d.problem;
  const a = p.analysis;

  box.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>${esc(p.topics[0] ?? '题目')}</h2>
        <span class="pill ${p.source === 'imported' ? 'pill-muted' : ''}">${p.source === 'imported' ? '导入 · 图谱由模型生成' : '题库 · 图谱经教研维护'}</span>
      </div>
      <div class="stem-box"><div class="stem">${esc(p.stem)}</div></div><p class="stem-hint" hidden></p>
      <div class="tag-row" style="margin-top:8px">${p.topics.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <div class="kv-grid">
        <div><span class="k">已知</span><span class="v">${p.givens.map(esc).join('；')}</span></div>
        <div><span class="k">待求</span><span class="v">${p.asked.map(esc).join('；')}</span></div>
      </div>
      ${
        p.importMeta
          ? `<div class="muted small" style="margin-top:8px">
              导入时间 ${esc(p.importMeta.createdAt)}　·　关键关节：${
                (p.importMeta.analysis?.keySteps ?? []).map((s) => `第 ${s.index} 步 ${esc(s.title)}`).join('；') || '—'
              }
            </div>
            ${
              p.importMeta.warnings?.length
                ? `<div class="notice notice-warn" style="margin-top:8px">读题告警：${p.importMeta.warnings.map(esc).join('；')}</div>`
                : ''
            }`
          : ''
      }
    </div>

    ${
      a
        ? `<div class="card">
            <div class="card-head"><h3>解析（教师版 · 含剧透标记）</h3><span class="pill pill-teach">学生只看得到其中一部分</span></div>
            <div class="analysis-summary">${esc(a.summary)}</div>

            <h4 class="mini-title">关键变量</h4>
            <div class="var-list">
              ${(a.variables?.given ?? [])
                .map(
                  (x) => `<div class="var-row"><span class="var-sym">${esc(x.symbol || '·')}</span>
                    <span class="var-val">${x.value ? `= ${esc(x.value)} ${esc(x.unit ?? '')}` : esc(x.raw)}</span>
                    <span class="var-note">${esc(x.note ?? '')}</span></div>`,
                )
                .join('')}
              ${(a.variables?.asked ?? [])
                .map(
                  (x) => `<div class="var-row is-asked"><span class="var-sym">${esc(x.symbol || '?')}</span>
                    <span class="var-val">${esc(x.note || x.raw)}</span></div>`,
                )
                .join('')}
            </div>

            <h4 class="mini-title">关键条件（含"会不会剧透"的判定）</h4>
            <div class="cond-list">
              ${(a.keyConditions ?? [])
                .map(
                  (c) => `<div class="cond-item ${c.reveals ? 'is-locked' : ''}">
                    <div class="cond-head">
                      <span class="cond-label">${esc(c.label)}</span>
                      ${c.text ? `<span class="cond-quote">${esc(c.text)}</span>` : ''}
                      <span class="chip ${c.reveals ? 'chip-block' : 'chip-guard'}">${c.reveals ? '会剧透 → 学生只看到提问' : '可直接展示'}</span>
                    </div>
                    <div class="cond-meaning">${esc(c.meaning)}</div>
                    ${c.reveals ? `<div class="small muted" style="margin-top:4px">学生版显示为：${esc(c.ask)}</div>` : ''}
                  </div>`,
                )
                .join('')}
            </div>

            <h4 class="mini-title">知识图谱（含步骤里的概念）</h4>
            <div class="kg-wrap" id="kg-wrap-teacher"></div>
          </div>`
        : ''
    }

    <div class="card">
      <div class="card-head"><h3>完整解题路径（学生视图拿不到）</h3><span class="pill pill-muted">${p.solutionGraphs.length} 条路径</span></div>
      ${p.solutionGraphs
        .map(
          (g) => `
        <div class="graph-block">
          <h4>${esc(g.name)} <span class="mono small">${esc(g.id)}</span></h4>
          <div class="muted small">适用前提：${g.preconditions.map(esc).join('；') || '—'}</div>
          <ol class="step-graph">
            ${g.steps
              .map(
                (s) => `<li class="step-node kind-${esc(s.kind)}">
                  <span class="step-idx">${s.index}</span>
                  <div class="step-main">
                    <strong>${esc(s.title)}</strong>
                    <span class="kind-pill">${esc(s.kind)}</span>
                    <div class="small muted">意图：${esc(s.intent)}</div>
                    <div class="small">概念：${s.concepts.map((c) => `<span class="tag tag-soft">${esc(c)}</span>`).join(' ') || '—'}</div>
                    <div class="small muted">定位关键词：${(s.cues ?? []).map((c) => `<code>${esc(c)}</code>`).join(' ') || '⚠ 无（关键词通道对这一步失效）'}</div>
                  </div>
                </li>`,
              )
              .join('')}
          </ol>
        </div>`,
        )
        .join('')}
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>错因库</h3></div>
        ${
          p.misconceptions.length
            ? p.misconceptions
                .map(
                  (m) => `<div class="mis-item">
                    <strong>${esc(m.label)}</strong>
                    <div class="small muted">${esc(m.rootCause)}</div>
                    <div class="small muted mono">${esc(m.id)}</div>
                  </div>`,
                )
                .join('')
            : '<p class="muted">本题没有可用错因库 —— 引擎无法把学生的话归类到具体认知缺口。</p>'
        }
      </div>
      <div class="card">
        <div class="card-head"><h3>防泄题基准（守卫的比对基准）</h3></div>
        <p class="muted small">
          这三组指纹就是"什么算说出了答案"。它们<strong>只在服务端</strong>参与判断，
          学生视图的接口不会返回它们。
        </p>
        <h4 class="mini-title">答案指纹 ${p.answerFingerprints.length ? '' : '⚠ 空'}</h4>
        <div class="fp-box">${p.answerFingerprints.map((f) => `<code>${esc(f)}</code>`).join('') || '<span class="muted small">无 —— 数值型防泄题对本题失效</span>'}</div>
        <h4 class="mini-title">解法公式指纹</h4>
        <div class="fp-box">${p.formulaFingerprints.map((f) => `<code>${esc(f)}</code>`).join('') || '<span class="muted small">无</span>'}</div>
        <h4 class="mini-title">结论指纹（说破就毁掉这道题）</h4>
        <div class="fp-box">${p.solutionInsights.map((f) => `<code>${esc(f)}</code>`).join('') || '<span class="muted small">无</span>'}</div>
        <h4 class="mini-title">参考答案（仅教研可见）</h4>
        <div class="pre ref-answer">${esc(p.referenceAnswer) || '<span class="muted small">（无）</span>'}</div>
      </div>
    </div>`;

  if (a?.knowledgeGraph?.nodes?.length) {
    renderKnowledgeGraph($('#kg-wrap-teacher'), a.knowledgeGraph, { teacher: true, mode: 'svg' });
  }
  enhanceStemBoxes($('#teacher-content'));
}

async function renderTeacherEval() {
  const box = $('#teacher-content');
  box.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>离线评测 · 19 个典型学生场景</h3></div>
      <p class="muted small">
        为什么这一栏放在教师视图：它是<strong>工程质量指标</strong>，不是学生学习内容。
        放在学生界面上，学生会以为"AI 在考核我"。
      </p>
      <p class="muted small" style="margin-top:6px">
        用离线规则桩跑：安全指标（泄题 / 跳级 / 确认答案 / 解法倾倒）由决策层与守卫层保证，
        与模型能力无关，所以离线与真模型下完全一致；而且一秒出结果，不用等 39 轮请求。
      </p>
      <button class="btn btn-primary" id="btn-run-eval" style="margin-top:12px">跑一遍离线评测</button>
      <div id="eval-result" style="margin-top:14px"></div>
    </div>`;
  $('#btn-run-eval').addEventListener('click', runEval);
}

async function runEval() {
  const btn = $('#btn-run-eval');
  const out = $('#eval-result');
  btn.disabled = true;
  btn.textContent = '正在跑 19 个场景…';
  out.innerHTML = '';
  try {
    const { metrics, adapter } = await api('/api/eval', { method: 'POST', body: JSON.stringify({ useLlm: false }) });
    const rows = [
      ['泄题率', `${metrics.leakRate}%`, metrics.leakRate === 0],
      ['跳级率', `${metrics.levelSkipRate}%`, metrics.levelSkipRate === 0],
      ['确认答案', metrics.answerConfirmations, metrics.answerConfirmations === 0],
      ['解法倾倒', metrics.solutionDumps, metrics.solutionDumps === 0],
      ['定位命中', `${metrics.locateAccuracy}%`, metrics.locateAccuracy >= 85],
      ['错因命中', `${metrics.misconceptionAccuracy}%`, metrics.misconceptionAccuracy >= 85],
      ['可行动率', `${metrics.actionableRate}%`, metrics.actionableRate >= 85],
      ['守卫拦截', metrics.guardBlocks, true],
    ];
    out.innerHTML = `
      <div class="eval-metrics">
        ${rows
          .map(
            ([k, v, ok], i) =>
              `<div class="eval-metric stagger ${ok ? 'ok' : 'bad'}" style="--i:${i}"><span class="v">${esc(v)}</span><span class="k">${esc(k)}</span></div>`,
          )
          .join('')}
      </div>
      <p class="small muted" style="margin-top:10px">
        适配器：<code>${esc(adapter?.kind ?? 'offline-stub')}</code>${adapter?.model ? ` (${esc(adapter.model)})` : ''}
        ｜守卫拦截说明护栏在工作，不是负指标。
      </p>
      <p class="small muted">
        真模型数据请用命令行跑：<code>node scripts/eval.js --adapter llm</code>（结果见 share/ 目录）。
      </p>`;
  } catch (err) {
    out.innerHTML = `<p class="muted">评测失败：${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '跑一遍离线评测';
  }
}

// ---------------------------------------------------------------------------

init().catch((err) => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div style="background:var(--risk-soft);color:var(--risk);padding:12px 20px;font-size:13px">
       初始化失败：${esc(err.message)} —— 请确认服务已启动（node server/server.js）
     </div>`,
  );
});
