/* =========================================================================
   第 1 步 · v3 学术皮肤壳
   -------------------------------------------------------------------------
   这一步只验证版式与流程：5 页、气泡对话、主题、按钮文案。
   真实 API / OCR / 解析 / KG / 历史 / 报告 / 公式卡在第二步接。
   所有数据都是本地占位，不写入服务端。
   ========================================================================= */

import { applyShortcut } from './mathinput.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers ?? {}) };
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.charged = typeof data.charged === 'boolean' ? data.charged : undefined;
    throw err;
  }
  return data;
}

const OCR_MAX_EDGE = 1600;

function compressImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const img = new Image();
      img.onerror = () => resolve(null);
      img.onload = () => {
        try {
          const scale = Math.min(1, OCR_MAX_EDGE / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: w, height: h, scaled: scale < 1 });
        } catch (error) {
          resolve(null);
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

const FLOW = ['题目录入', '解题方式', '对话研讨', '学习报告', '迁移练习'];

const PROBLEMS = [
  {
    subject: '物理',
    tag: '计算题 · 牛顿第二定律',
    topic: '牛顿第二定律',
    text: '质量为 2 kg 的物块放在光滑水平面上，受到水平向右的 6 N 拉力。求物块的加速度。',
  },
  {
    subject: '数学',
    tag: '计算题 · 二次函数',
    topic: '二次函数',
    text: '已知二次函数 y = x² − 4x + 3，求它的顶点坐标与最小值。',
  },
  {
    subject: '物理',
    tag: '分析题 · 机械能守恒',
    topic: '机械能守恒',
    text: '一个小球从光滑曲面上的某点由静止释放，滑至最低点。忽略空气阻力，请分析小球运动过程中动能和重力势能的变化。',
  },
];

const RELATED = [
  { tag: '物理 · 计算题 · 牛顿第二定律', text: '质量为 3 kg 的木箱在粗糙水平面上受到 12 N 水平拉力，滑动摩擦力为 3 N。求木箱的加速度。' },
  { tag: '数学 · 计算题 · 二次函数', text: '已知二次函数 y = x² + 6x + 5，求它的顶点坐标与最小值。' },
  { tag: '物理 · 分析题 · 机械能守恒', text: '小球从光滑轨道高处滑下后进入粗糙水平面。请分段判断机械能是否守恒，并说明原因。' },
];

const CHIPS = [
  '这道题应该从哪里入手？',
  '我漏掉了哪个条件？',
  '我画的受力图对吗？',
  '这个公式为什么能用？',
  '我卡在这一步了，能给一点提示吗？',
];

const SYMBOLS = ['²', '³', '₀', 'μ', 'Ω', '√', '≈', '≥', '≤', 'Δ', 'Φ', '×', '÷', '·', '→', '∴'];

const HINTS = {
  牛顿第二定律: '先检查使用条件：这个物理规律成立需要哪些前提，题目是否满足？',
  二次函数: '先把它化成顶点式：式子里的哪一部分决定了图象的左右位置？',
  机械能守恒: '先判断：在这段运动里，除了重力，还有别的力做功吗？',
};

const FORMULA = {
  牛顿第二定律: {
    formula: 'F合 = m · a',
    note: '适用条件：惯性参考系；质量不变。只给规律，不代入本题数值。',
  },
  二次函数: {
    formula: 'y = a(x − h)² + k',
    note: '顶点式：顶点为 (h, k)，a ≠ 0。只给形式，不代入本题系数。',
  },
  机械能守恒: {
    formula: 'Ek + Ep = 常量',
    note: '适用条件：只有重力或弹力做功，其他力不做功，或做功之和为零。',
  },
};

const INTAKE = {
  牛顿第二定律: {
    topics: 3,
    conditions: 6,
    steps: 7,
    list: ['物块质量 m = 2 kg', '水平拉力 F = 6 N', '接触面光滑，无摩擦力'],
  },
  二次函数: {
    topics: 2,
    conditions: 4,
    steps: 5,
    list: ['二次项系数 a = 1', '一次项系数 b = −4', '常数项 c = 3'],
  },
  机械能守恒: {
    topics: 3,
    conditions: 5,
    steps: 6,
    list: ['曲面光滑', '忽略空气阻力', '初速度为零'],
  },
};

const params = new URLSearchParams(location.search);

const state = {
  step: 1,
  tab: 'text',
  text: '',
  image: '',
  ocrImage: '',
  ocrBusy: false,
  ocrNotice: '',
  ocrStatus: '',
  selected: 0,
  problems: PROBLEMS,
  problem: PROBLEMS[0],
  analysis: null,
  problemView: 'original',
  mode: 'companion',
  sessionId: null,
  turns: 0,
  started: 0,
  hintLevel: null,
  messages: [],
  steps: [],
  draft: '',
  photo: '',
  formulaOpen: params.get('formula') === '1',
  formulaMessageIndex: null,
  formulaCard: null,
  asideCollapsed: false,
  symbolsOpen: false,
  autoReplace: true,
  demo: params.get('demo') === '1' || (() => {
    try { return sessionStorage.getItem('dsh-demo') === '1'; } catch { return false; }
  })(),
  demoAnswer: null,
  demoLoading: false,
  busy: false,
  importing: false,
  notice: '',
  report: null,
  reportLoading: false,
  reportError: '',
  history: [],
  restored: false,
  renderedStep: null,
};

const LEARNING_KEY = 'dsh-v3-learning-history:v1';
const MAX_HISTORY = 8;

function readLearningStore() {
  try {
    const store = JSON.parse(localStorage.getItem(LEARNING_KEY) || '{"version":1,"sessions":[]}');
    return Array.isArray(store.sessions) ? store : { version: 1, sessions: [] };
  } catch {
    return { version: 1, sessions: [] };
  }
}

function writeLearningStore(store) {
  try {
    localStorage.setItem(LEARNING_KEY, JSON.stringify(store));
  } catch {
    /* 空间不足时放弃写入，不影响当前会话 */
  }
}

function persistSession() {
  if (state.demo) return;
  if (!state.sessionId || !state.problem?.id || !state.messages.length) return;
  const store = readLearningStore();
  const snapshot = {
    sessionId: state.sessionId,
    problemId: state.problem.id,
    problem: state.problem,
    analysis: state.analysis,
    messages: state.messages,
    steps: state.steps,
    mode: state.mode,
    turns: state.turns,
    started: state.started,
    updatedAt: Date.now(),
    title: (state.problem.topics ?? []).slice(0, 2).join(' / ') || state.problem.stem?.slice(0, 18) || '本次学习',
  };
  store.sessions = [snapshot, ...store.sessions.filter((s) => s.sessionId !== state.sessionId)].slice(0, MAX_HISTORY);
  writeLearningStore(store);
  state.history = store.sessions.map((s) => ({
    sessionId: s.sessionId,
    title: s.title,
    time: new Date(s.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  }));
}

function restoreSession(snapshot) {
  if (!snapshot) return;
  state.problem = snapshot.problem;
  state.analysis = snapshot.analysis ?? snapshot.problem?.analysis ?? null;
  state.sessionId = snapshot.sessionId;
  state.messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  state.steps = Array.isArray(snapshot.steps) ? snapshot.steps : [];
  state.mode = snapshot.mode ?? 'companion';
  state.turns = snapshot.turns ?? 0;
  state.started = snapshot.started ?? 0;
  state.hintLevel = null;
  state.formulaOpen = false;
  state.formulaMessageIndex = null;
  state.formulaCard = null;
  state.demoAnswer = null;
  state.demoLoading = false;
  state.report = null;
  state.reportError = '';
  state.step = 3;
  state.restored = true;
  render();
}

function loadHistory() {
  const store = readLearningStore();
  state.history = store.sessions.map((s) => ({
    sessionId: s.sessionId,
    title: s.title,
    time: new Date(s.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  }));
  return store.sessions;
}

const requestedStep = Number(params.get('step'));
if (requestedStep >= 1 && requestedStep <= 5) state.step = requestedStep;
if (params.get('tab') === 'image') state.tab = 'image';
if (params.get('pane') === 'parsed' || params.get('pane') === 'original') state.problemView = params.get('pane');
if (params.get('mode') === 'solo' || params.get('mode') === 'companion') state.mode = params.get('mode');
if (params.get('session')) state.sessionId = params.get('session');

function normalizeProblem(p) {
  const topics = Array.isArray(p.topics) ? p.topics : [];
  const topic = topics[0] || p.topic || '';
  const subject = p.subject === 'math' ? '数学' : p.subject === 'chemistry' ? '化学' : '物理';
  return {
    ...p,
    topic,
    subject,
    text: p.stemPreview ?? p.stem ?? p.text ?? '',
    tag: p.tag || `${subject} · ${topic || '题目'} · 难度 ${p.difficulty ?? '?'}/5`,
  };
}

async function loadProblems(keepSelection = false) {
  try {
    const { problems } = await api('/api/problems');
    if (!Array.isArray(problems) || !problems.length) return;
    state.problems = problems.map(normalizeProblem);
    if (!keepSelection) {
      state.selected = 0;
      state.problem = state.problems[0];
    }
    render();
  } catch (err) {
    console.warn('题目列表加载失败，使用本地示例', err);
  }
}

function problemStem() {
  return state.problem?.stem ?? state.problem?.text ?? '';
}

function problemTopic() {
  return (Array.isArray(state.problem?.topics) && state.problem.topics[0]) || state.problem?.topic || '';
}

function askedForHelp(text) {
  return /[?？]|为什么|怎么|如何|能否|能给|请|提示|帮|不懂|不会|不知道|哪里|对吗|卡在|漏掉/.test(text);
}

function newSessionId(problemId) {
  return `demo-${problemId}-${Date.now()}`;
}

async function selectSample(index) {
  state.selected = index;
  state.text = '';
  state.notice = '';
  state.problem = state.problems[index];
  render();

  const entry = state.problems[index];
  if (!entry?.id) return;
  try {
    const { problem } = await api(`/api/problem?id=${encodeURIComponent(entry.id)}`);
    state.problem = problem;
    state.analysis = problem.analysis ?? null;
    state.sessionId = newSessionId(problem.id);
    state.turns = 0;
    state.started = 0;
    state.hintLevel = null;
    state.formulaOpen = false;
    state.formulaCard = null;
    state.demoAnswer = null;
    state.demoLoading = false;
    state.messages = [];
    state.steps = [];
    state.restored = false;
    render();
  } catch (err) {
    state.notice = `题目加载失败：${err.message}`;
    render();
  }
}

async function confirmProblem() {
  if (!validProblem() || state.importing) return;

  if (state.selected < 0 || state.text.trim()) {
    state.importing = true;
    state.notice = '正在读懂这道题：抽取条件与目标、标出知识点、生成解题路径，大约 5~15 秒。';
    render();
    try {
      const res = await api('/api/problem/import', {
        method: 'POST',
        body: JSON.stringify({ rawText: state.text.trim() }),
      });
      state.problem = res.problem;
      state.analysis = res.problem.analysis ?? null;
      state.sessionId = newSessionId(res.problem.id);
      state.selected = -1;
      state.importing = false;
      state.notice = '';
      state.step = 2;
      render();
      toast('读题完成，解析已就绪');
    } catch (err) {
      state.importing = false;
      state.notice = `读题失败：${err.message}`;
      render();
    }
    return;
  }

  const entry = state.problem;
  if (entry.id && !entry.stem) {
    try {
      const { problem } = await api(`/api/problem?id=${encodeURIComponent(entry.id)}`);
      state.problem = problem;
      state.analysis = problem.analysis ?? null;
    } catch (err) {
      state.notice = `题目加载失败：${err.message}`;
      render();
      return;
    }
  }
  state.sessionId = newSessionId(state.problem.id);
  state.turns = 0;
  state.started = 0;
  state.hintLevel = null;
  state.formulaOpen = false;
  state.formulaCard = null;
  state.demoAnswer = null;
  state.demoLoading = false;
  state.messages = [];
  state.steps = [];
  state.restored = false;
  state.step = 2;
  render();
}

function heading(title, sub = '') {
  return `<header><h1>${title}</h1>${sub ? `<p class="muted">${sub}</p>` : ''}</header>`;
}

function foot(label, action, cls = 'primary', disabled = false) {
  return `<footer><button class="${cls}" data-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button></footer>`;
}

function validProblem() {
  return state.selected >= 0 || Boolean(state.text.trim());
}

function syncFlow() {
  const index = Math.max(0, Math.min(4, state.step - 1));
  $$('.flow-tick').forEach((tick, i) => {
    tick.classList.toggle('is-done', i < index);
    tick.classList.toggle('is-now', i === index);
  });
  const label = $('#flow-label');
  if (label) label.textContent = `0${index + 1} / 05 · ${FLOW[index]}`;
}

function render() {
  document.body.dataset.step = String(state.step);
  const pages = { 1: inputPage, 2: modePage, 3: chatPage, 4: reportPage, 5: practicePage };
  // 只在「换页」时播放上浮动画，页内点按不重播，避免界面一直抖
  const pageChanged = state.renderedStep !== state.step;
  state.renderedStep = state.step;
  $('#app').innerHTML = `<div class="page-shell${pageChanged ? ' page-enter' : ''}" data-page="${state.step}">${pages[state.step]()}</div>`;
  syncFlow();
  bind();
  if (state.step === 1) {
    const list = $('.question-list');
    if (list) list.scrollTop = 0;
  }
  if (state.step === 4) loadReportIfNeeded();
  if (state.step === 3) {
    const box = $('#messages');
    if (box) box.scrollTop = box.scrollHeight;
  } else {
    window.scrollTo(0, 0);
  }
}

/* ---------- ① 题目录入 ---------- */
function demoToggleHtml() {
  return `<div class="demo-toggle">
    <div class="demo-toggle-copy">
      <strong>演示模式</strong>
      <p>开启后，对话里可以查看本题参考答案；正常模式不会。</p>
    </div>
    <button class="switch" type="button" role="switch" aria-checked="${state.demo}" data-action="toggle-demo" aria-label="演示模式"><span></span></button>
  </div>`;
}

function inputPage() {
  const selected = state.selected;
  const problems = state.problems ?? PROBLEMS;
  return `${heading(
    '重难题，AI 陪你一步步想通',
    '先读懂你的题：关键变量、关键条件、涉及的知识点；然后用一条不给你看的路径，判断你卡在哪一步。',
  )}
  ${demoToggleHtml()}
  <div class="input-grid">
    <section class="card">
      <h2>输入你的题目</h2>
      <div class="tabs" role="tablist">
        <button role="tab" aria-selected="${state.tab === 'text'}" data-tab="text" class="${state.tab === 'text' ? 'active' : ''}">文字输入</button>
        <button role="tab" aria-selected="${state.tab === 'image'}" data-tab="image" class="${state.tab === 'image' ? 'active' : ''}">图片上传</button>
      </div>
      ${
        state.tab === 'text'
          ? `<label class="sr" for="problem-text">题目内容</label>
             <textarea id="problem-text" class="problem-input" placeholder="输入题干、已知条件和要求解的问题。">${esc(state.text)}</textarea>
             ${state.ocrNotice ? `<div class="notice">${esc(state.ocrNotice)}</div>` : ''}`
          : `<label class="upload-box">
               ${state.image ? `<img src="${state.image}" alt="已上传的题目图片">` : '<span class="upload-icon">＋</span>'}
               <strong>${state.image ? '重新选择图片' : '选择题目图片'}</strong>
               <span>支持 JPG / PNG；识别后会回填题干，请核对数字、单位和符号。</span>
               <input type="file" id="problem-file" accept="image/*">
             </label>
             <div class="ocr-actions">
               <span class="muted small">${esc(state.image ? state.ocrStatus || '已选择图片' : '先选择一张题目照片')}</span>
               <div>
                 ${state.image ? '<button class="quiet" data-action="ocr-clear">重新选择</button>' : ''}
                 <button class="primary" data-action="ocr" ${!state.image || state.ocrBusy ? 'disabled' : ''}>${state.ocrBusy ? '识别中…' : '识别成题干'}</button>
               </div>
             </div>
             ${state.ocrNotice ? `<div class="notice">${esc(state.ocrNotice)}</div>` : ''}`
      }
      <p class="muted small" style="margin-top:.8rem">粘贴的题和拍的照片，走同一条读题链路。</p>
      ${state.notice ? `<div class="notice">${esc(state.notice)}</div>` : ''}
    </section>

    <section class="card">
      <div class="card-headline"><h2>示例题目</h2><span class="tag">${problems.length} 道</span></div>
      <div class="question-list">
        ${problems.map(
          (p, i) => `<button class="question ${selected === i ? 'selected' : ''}" data-question="${i}" aria-pressed="${selected === i}">
            <span class="tag">${p.tag}</span>${selected === i ? '<span class="check">✓ 已选择</span>' : ''}
            <p>${esc(p.text)}</p>
          </button>`,
        ).join('')}
      </div>
    </section>
  </div>
  ${foot(state.importing ? '正在读题…' : '确认题目', 'confirm', 'primary', !validProblem() || state.importing)}`;
}

/* ---------- ② 解题方式 ---------- */
function modePage() {
  const analysis = state.analysis ?? state.problem.analysis ?? null;
  const topics = Array.isArray(state.problem.topics) && state.problem.topics.length
    ? state.problem.topics
    : [state.problem.topic].filter(Boolean);
  const conditions = analysis?.keyConditions ?? [];
  const stepCount = state.problem.stepCount ?? analysis?.stepCount ?? 6;
  const fallback = INTAKE[problemTopic()] ?? INTAKE.牛顿第二定律;
  const intake = {
    topics: topics.length || fallback.topics,
    conditions: conditions.length || fallback.conditions,
    steps: stepCount || fallback.steps,
    list: conditions.length
      ? conditions.map((c) => {
          const label = c.label || '关键条件';
          if (c.revealsInsight) return `${label}：${c.question || '这条条件会直接影响解法，先自己翻译一遍。'}`;
          return `${label}${c.text ? `：${c.text}` : ''}`;
        })
      : fallback.list,
  };
  const modes = [
    {
      key: 'companion',
      icon: '▤',
      title: 'AI 伴学',
      lead: '你边做边说，AI 在关键步骤给你一点提示。',
      body: '会关注你输入或提交的解题步骤，帮助你发现遗漏的条件，不直接给答案。',
    },
    {
      key: 'solo',
      icon: '✎',
      title: '自主训练',
      lead: '先自己试一试，需要时再叫 AI。',
      body: '记录过程时不主动打断，只有你明确求助时才给提示。',
    },
  ];

  return `${heading('选择你的解题方式', '两种方式都不会直接给答案；区别只在“什么时候开口”。')}
  <section class="intake-summary">
    <p><strong>已读懂</strong> · ${intake.topics} 个知识点 · ${intake.conditions} 个关键条件 · ${intake.steps} 步路径</p>
    <details class="fold">
      <summary>查看关键条件</summary>
      <div class="fold-body">
        <ul class="action-list">${intake.list.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
      </div>
    </details>
  </section>

  <div class="mode-grid">
    ${modes
      .map(
        (m) => `<button class="mode ${state.mode === m.key ? 'selected' : ''}" data-mode="${m.key}" aria-pressed="${state.mode === m.key}">
          <span class="mode-icon" aria-hidden="true">${m.icon}</span>
          <span class="check">${state.mode === m.key ? '✓' : ''}</span>
          <h2>${m.title}</h2>
          <h3>${m.lead}</h3>
          <p>${m.body}</p>
        </button>`,
      )
      .join('')}
  </div>
  <p class="muted small">做题过程中也可以切换模式。</p>
  ${foot('确认，开始做题', 'start', 'primary', !state.mode)}`;
}

/* ---------- ③ 对话 ---------- */
function messageHtml(m, index) {
  const card = m.role === 'ai' && state.formulaOpen && index === state.formulaMessageIndex ? formulaCardHtml() : '';
  return `<div class="message ${m.role}">
    <span>${m.role === 'user' ? '你' : 'AI 助手'}</span>
    <div class="bubble">${esc(m.text)}${card}</div>
  </div>`;
}

function kgLayeredHtml(kg) {
  const nodes = kg?.nodes ?? [];
  if (!nodes.length) return '';
  const levels = [...new Set(nodes.map((n) => n.level ?? 1))].sort((a, b) => b - a);
  const layers = levels
    .map((level) => {
      const group = nodes.filter((n) => (n.level ?? 1) === level);
      const label = level === 1 ? '本题核心' : level === 2 ? '直接前置' : '更基础';
      return `<div class="kg-layer">
        <div class="kg-layer-head">${label}</div>
        <div class="kg-nodes">${group.map((n) => `<span class="tag">${esc(n.name ?? n.id)}</span>`).join('')}</div>
      </div>`;
    })
    .join('');
  return `<details class="fold"><summary>知识图谱 · ${nodes.length} 个节点</summary><div class="fold-body kg-layers">${layers}</div></details>`;
}

function formulaCardHtml() {
  const topic = problemTopic();
  const card = state.formulaCard;
  const f = card
    ? { formula: card.formula, note: card.note, topic: card.topic }
    : FORMULA[topic] ?? FORMULA.牛顿第二定律;
  return `<div class="formula-card">
    <span class="formula-label">公式卡 · 来自题库</span>
    <div class="formula">${esc(f.formula)}</div>
    <p class="formula-note">${esc(f.note)}</p>
    <span class="formula-source">知识点：${esc(f.topic || topic || '本题')}</span>
  </div>`;
}

function formulaTriggerHtml() {
  return `<div class="formula-trigger-row">
    <button class="outline formula-trigger" data-action="formula">还是想不起来，给我公式</button>
    <span class="muted small">已给过 3 轮提示 · 公式卡不计入提示层级</span>
  </div>`;
}

function demoTriggerHtml() {
  return `<div class="formula-trigger-row demo-trigger-row">
    <button class="outline formula-trigger" data-action="demo-answer" ${state.demoLoading ? 'disabled' : ''}>${state.demoLoading ? '正在取答案…' : '我已做出答案（演示）'}</button>
  </div>`;
}

function demoAnswerCardHtml() {
  const answer = state.demoAnswer;
  return `<div class="demo-answer-card">
    <span class="formula-label">演示 · 参考答案</span>
    <div class="demo-values">${(answer.values ?? []).map((v) => `<span>${esc(v)}</span>`).join('')}</div>
    <p class="formula-note">这是演示用的最终答案，不经过 AI；点击下面的按钮会把它填进输入框，再由你点发送。</p>
    <button class="outline" data-action="fill-demo-answer">填入输入框</button>
  </div>`;
}

async function loadDemoAnswer() {
  if (!state.demo || state.demoLoading) return;
  if (!state.problem?.id) {
    toast('这道题还没有读入');
    return;
  }
  state.demoLoading = true;
  render();
  try {
    const res = await api('/api/demo/answer', {
      method: 'POST',
      body: JSON.stringify({ problemId: state.problem.id, demo: true }),
    });
    state.demoAnswer = res;
  } catch (err) {
    toast(err.message);
  } finally {
    state.demoLoading = false;
    render();
  }
}

function applyShortcutAtCaret(el, opts = {}) {
  const caret = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, caret);
  const hit = applyShortcut(before, opts);
  if (!hit) return;
  el.value = before.slice(0, hit.start) + hit.replacement + el.value.slice(caret);
  const pos = hit.start + hit.replacement.length;
  el.setSelectionRange(pos, pos);
  state.draft = el.value;
}

function mathbarHtml() {
  return `<div class="mathbar">
    <div class="mathbar-head">
      <span class="mathbar-title">符号面板</span>
      <label class="mathbar-auto"><input id="auto-replace" type="checkbox" ${state.autoReplace ? 'checked' : ''}> 自动替换</label>
    </div>
    <div class="mathbar-grid">
      ${SYMBOLS.map((s) => `<button type="button" data-symbol="${esc(s)}" aria-label="插入 ${esc(s)}">${s}</button>`).join('')}
    </div>
  </div>`;
}

function symbolPopoverHtml() {
  return `<div class="symbol-popover">${mathbarHtml()}</div>`;
}

function chatPage() {
  const p = state.problem;
  const analysis = state.analysis ?? p.analysis ?? null;
  const topics = Array.isArray(p.topics) && p.topics.length ? p.topics : [p.topic].filter(Boolean);
  const conditions = analysis?.keyConditions ?? [];
  return `<div class="chat-layout ${state.asideCollapsed ? 'is-collapsed' : ''}">
    <aside class="chat-aside">
      <div class="aside-head">
        <span class="aside-kicker">辅助</span>
        <button class="aside-toggle" data-action="toggle-aside" aria-expanded="${!state.asideCollapsed}" title="${state.asideCollapsed ? '展开侧栏' : '收起侧栏'}">${state.asideCollapsed ? '›' : '‹ 收起'}</button>
      </div>
      <div class="aside-rail" aria-hidden="${!state.asideCollapsed}">题目 · 进度</div>
      <div class="aside-body">
      <section class="card problem-card">
        <div class="card-headline">
          <h2>当前题目</h2>
          <button class="link-button" data-action="change">换一题</button>
        </div>
        <div class="problem-toggle" role="group" aria-label="题目显示方式">
          <button class="${state.problemView === 'original' ? 'on' : ''}" data-problem-view="original">原题</button>
          <button class="${state.problemView === 'parsed' ? 'on' : ''}" data-problem-view="parsed">解析</button>
        </div>
        ${
          state.problemView === 'original'
            ? `<p style="margin-top:.75rem">${esc(problemStem())}</p>`
            : `<div class="analysis-mini">
                 ${analysis?.summary ? `<p>${esc(analysis.summary)}</p>` : ''}
                 <div class="report-tags">${topics.slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
                 <h3 style="margin-top:.9rem">关键条件</h3>
                 ${
                   conditions.length
                     ? `<ul class="action-list">${conditions.map((c) => {
                         const label = c.label || '关键条件';
                         const body = c.revealsInsight
                           ? (c.question || '这条条件会直接影响解法，先自己翻译一遍。')
                           : (c.text || c.meaning || '');
                         return `<li><strong>${esc(label)}</strong>${body ? `：${esc(body)}` : ''}</li>`;
                       }).join('')}</ul>`
                     : '<p class="muted small">这道题还没有解析数据。</p>'
                 }
                 ${analysis?.knowledgeGraph?.nodes?.length ? kgLayeredHtml(analysis.knowledgeGraph) : ''}
               </div>`
        }
      </section>

      <section class="card progress-card">
        <h2>对话进度</h2>
        ${
          state.steps.length
            ? `<ol class="steps">
                 ${state.steps
                   .map(
                     (s, i) => `<li class="${i === state.steps.length - 1 ? 'is-current' : ''}">
                       <div class="step-row"><span>${i + 1}</span><div>${esc(s)}</div></div>
                     </li>`,
                   )
                   .join('')}
               </ol>`
            : '<p class="muted">从你的第一步想法开始记录。</p>'
        }
        ${state.restored ? '<p class="muted small" style="margin-top:.6rem">已恢复上次学习进度。</p>' : ''}
        <details class="fold">
          <summary>历史记录 (${state.history.length})</summary>
          <div class="fold-body">
            <input id="history-search" class="history-search" type="search" placeholder="搜索步骤、关键词或时间">
            <ul class="history-list" id="history-list">
              ${
                state.history.length
                  ? state.history
                      .map(
                        (h) => `<li data-search="${esc((h.title + ' ' + h.time).toLowerCase())}" data-history="${esc(h.sessionId)}"><strong>${esc(h.title)}</strong><span>${esc(h.time)}</span></li>`,
                      )
                      .join('')
                  : '<li class="muted small">暂无历史会话</li>'
              }
            </ul>
          </div>
        </details>
      </section>
      </div>
    </aside>

    <section class="card chat-card">
      <div class="chat-head">
        <div>
          <h2>AI 解题对话</h2>
          <small class="muted">提示思路，不直接给答案</small>
        </div>
        <div class="chat-actions">
          <label class="sr" for="mode-switch">切换解题模式</label>
          <select id="mode-switch">
            <option value="companion" ${state.mode === 'companion' ? 'selected' : ''}>AI 伴学</option>
            <option value="solo" ${state.mode === 'solo' ? 'selected' : ''}>自主训练</option>
          </select>
          <div class="chat-actions-row">
            <button class="outline" data-action="report">我已完成，查看报告</button>
            <button class="quiet" data-action="practice">跳过报告，继续练习</button>
          </div>
        </div>
      </div>

      <div id="messages" class="messages" role="log" aria-live="polite">
        ${state.messages.map((m, i) => messageHtml(m, i)).join('')}
        ${state.formulaOpen || state.hintLevel !== 3 ? '' : formulaTriggerHtml()}
        ${state.demo && !state.demoAnswer && state.messages.some((m) => m.role === 'ai') ? demoTriggerHtml() : ''}
        ${state.demoAnswer ? demoAnswerCardHtml() : ''}
        ${state.busy ? '<div class="waiting">正在整理提示…</div>' : ''}
      </div>

      <div class="composer">
        <div class="suggestions" aria-label="推荐问题">
          ${CHIPS.map((c, i) => `<button type="button" data-chip="${i}">${esc(c)}</button>`).join('')}
        </div>
        ${state.symbolsOpen ? symbolPopoverHtml() : ''}
        <label class="sr" for="draft">输入你的想法或问题</label>
        <textarea id="draft" rows="2" placeholder="说说你的思路，或问一个卡住你的问题…">${esc(state.draft)}</textarea>
        <div class="composer-tools">
          <span class="muted" role="status">先想一步，再说一步</span>
          <div>
            <button class="quiet symbol-trigger" data-action="symbols" aria-expanded="${state.symbolsOpen}">Ω 符号</button>
            <button class="quiet" data-action="voice">语音输入</button>
            <label class="button quiet">拍照上传<input id="chat-file" type="file" accept="image/*" hidden></label>
            <button class="primary" data-action="send" ${state.busy ? 'disabled' : ''}>发送</button>
          </div>
        </div>
      </div>
    </section>
  </div>`;
}

/* ---------- ④ 学习报告 ---------- */
const STUCK_KIND_LABEL = {
  not_started: '还没开始想',
  knowledge_gap: '不确定该用哪个规律',
  precondition_gap: '漏了规律的前提条件',
  direction_lost: '知道规律但走不下去',
  execution_error: '思路对但执行出错',
  dead_end_path: '这条路走不通',
  finished: '已接近完成',
};

async function loadReportIfNeeded() {
  if (state.step !== 4 || state.report || state.reportError || state.reportLoading) return;
  if (!state.sessionId) {
    state.reportError = '还没有可以汇总的对话。先去「对话研讨」跟学伴聊几轮，再回来生成报告。';
    render();
    return;
  }

  state.reportLoading = true;
  render();
  try {
    const { report } = await api(`/api/report?sessionId=${encodeURIComponent(state.sessionId)}`);
    state.report = report;
  } catch (err) {
    state.reportError = err.status === 404
      ? '这个会话已经不在了（公开演示部署在 serverless 上，冷启动会丢会话）。'
      : `报告生成失败：${err.message}`;
  } finally {
    state.reportLoading = false;
    render();
  }
}

function reportPage() {
  const head = heading('学习报告', '报告不评价你对了几步，只回答：卡在哪、为什么卡、下一步做什么。');
  if (state.report) {
    const minutes = state.started ? Math.max(1, Math.round((Date.now() - state.started) / 60000)) : null;
    return `${head}
      <div class="report-dashboard">${renderReportCards(state.report)}</div>
      <p class="report-duration">学习时长 ${minutes ? `${minutes} 分钟` : '—'}</p>
      ${foot('确认', 'to-practice', 'primary')}`;
  }
  if (state.reportError) {
    return `${head}<section class="card"><div class="empty">${esc(state.reportError)}</div><footer><button class="outline" data-action="back-chat">去对话</button><button class="outline" data-action="home">回首页</button></footer></section>`;
  }
  return `${head}<section class="card"><h2>正在整理学习报告…</h2><div class="skeleton"><div></div><div></div><div></div></div></section>`;
}

function renderReportCards(r) {
  const ind = Math.round((r.independence?.score ?? 0) * 100);
  const byLevel = r.hintStats?.byLevel ?? {};
  const stuck = r.stuckPoints ?? [];
  const deeper = r.deeperIssues ?? [];
  const recs = r.recommendations ?? [];
  const actions = r.nextActions ?? [];
  const tags = [r.problemTitle].filter(Boolean);

  return `
    <section class="card report-summary">
      <h2>本次学习小结</h2>
      <div class="metrics">
        <div><span>本次练习</span><strong>1 题</strong></div>
        <div><span>独立完成度</span><strong>${ind}%</strong></div>
        <div><span>引导轮次</span><strong>${r.hintStats?.total ?? 0} 轮</strong></div>
      </div>
      <div class="report-tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <div class="report-stats">
        <div><strong>${byLevel[1] ?? 0}</strong><span>问前提</span></div>
        <div><strong>${byLevel[2] ?? 0}</strong><span>给方向</span></div>
        <div><strong>${byLevel[3] ?? 0}</strong><span>示范一步</span></div>
        <div><strong>${r.hintStats?.confirmed ?? 0}</strong><span>你自己算出的结果</span></div>
        <div><strong>${r.hintStats?.confirmedComplete ? '✓' : '—'}</strong><span>整题独立完成</span></div>
        <div><strong>${r.formulaCards ?? 0}</strong><span>公式卡</span></div>
      </div>
      <p class="muted" style="margin-top:.8rem;font-size:.8125rem">${esc(r.independence?.note ?? '独立完成度衡量的是你得到的帮助强度，不是你的水平。')}</p>
    </section>

    <section class="card report-stuck">
      <h2>卡点与深层问题</h2>
      ${stuck.length
        ? stuck.map((s) => `<div class="stuck-item">
            <div class="stuck-head">
              <strong>${esc(s.stepTitle)}</strong>
              <span class="badge warn"><span class="glyph">!</span>${esc(STUCK_KIND_LABEL[s.kind] ?? s.kind)}</span>
              <span class="tag">引导 ${s.hintRounds} 轮</span>
              <span class="tag">最高 L${s.maxLevel}</span>
            </div>
            ${s.misconceptionLabels?.length ? `<p>${s.misconceptionLabels.map(esc).join('；')}</p>` : '<p class="muted">还没归到具体类型。</p>'}
          </div>`).join('')
        : '<div class="empty">本轮没有出现明显卡点。</div>'}
      <h3>深层问题</h3>
      ${deeper.length ? `<ul class="action-list">${deeper.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">未归纳出系统性缺口。</p>'}
    </section>

    <section class="card report-next">
      <h2>下一步</h2>
      <h3>举一反三</h3>
      ${recs.length
        ? recs.map((rec) => `<div class="rec-item"><strong>${esc(rec.topic)}</strong><p>${esc(rec.reason)}</p><span class="tag">${esc(rec.drill)}</span></div>`).join('')
        : '<p class="muted">暂时没有推荐。</p>'}
      <h3>行动建议</h3>
      ${actions.length ? `<ol class="action-list">${actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>` : '<p class="muted">暂无行动建议。</p>'}
    </section>
  `;
}

/* ---------- ⑤ 迁移练习 ---------- */
function relatedProblems() {
  const currentTopics = Array.isArray(state.problem?.topics) ? state.problem.topics : [];
  const candidates = (state.problems ?? []).filter((p) => p.id && p.id !== state.problem?.id);
  const sameTopic = candidates.filter((p) => (p.topics ?? []).some((t) => currentTopics.includes(t)));
  const picked = (sameTopic.length ? sameTopic : candidates).slice(0, 3);
  if (picked.length) {
    return picked.map((p) => ({
      id: p.id,
      tag: p.tag,
      text: p.text,
    }));
  }
  return RELATED;
}

function practicePage() {
  const related = relatedProblems();
  return `${heading('把这一步，变成你的能力', '再独立走一遍，看看哪一步已经想通；再用相近的情境，把规律迁移出去。')}
  <div class="practice-grid">
    <section class="card redo">
      <span class="mode-icon" aria-hidden="true">↻</span>
      <h2>重做这道题</h2>
      <p class="muted">不看提示，再独立走一遍；卡住的地方会比第一次更清楚。</p>
      <button class="outline" data-action="redo">重做这道题</button>
    </section>
    <section class="card">
      <h2>举一反三</h2>
      <p class="muted">用相近的知识点，试试新的情境。</p>
      <div class="question-list">
        ${related.map(
          (q, i) => `<button class="question" data-related="${i}">
            <span class="tag">${esc(q.tag)}</span>
            <p>${esc(q.text)}</p>
          </button>`,
        ).join('')}
      </div>
    </section>
  </div>
  <footer><button class="outline" data-action="home">返回</button></footer>`;
}

/* ---------- 行为 ---------- */
function beginChat() {
  if (!state.sessionId) state.sessionId = newSessionId(state.problem.id ?? 'import');
  state.messages = [{ role: 'ai', text: '先说说你的想法：你准备从哪里入手，或者已经做到哪一步了？' }];
  state.steps = [];
  state.turns = 0;
  state.started = Date.now();
  state.hintLevel = null;
  state.formulaOpen = false;
  state.formulaMessageIndex = null;
  state.formulaCard = null;
  state.demoAnswer = null;
  state.demoLoading = false;
  state.symbolsOpen = false;
  state.draft = '';
  state.photo = '';
  state.busy = false;
  state.report = null;
  state.reportError = '';
  state.restored = false;
}

function action(name) {
  if (name === 'home') {
    state.step = 1;
    state.formulaOpen = false;
    render();
  } else if (name === 'confirm') {
    confirmProblem();
  } else if (name === 'start' && state.mode) {
    beginChat();
    state.step = 3;
    render();
  } else if (name === 'report') {
    state.step = 4;
    state.report = null;
    state.reportError = '';
    render();
  } else if (name === 'practice' || name === 'to-practice') {
    state.step = 5;
    render();
  } else if (name === 'redo') {
    beginChat();
    state.step = 2;
    render();
  } else if (name === 'change') {
    state.step = 1;
    render();
  } else if (name === 'formula') {
    openFormulaCard();
  } else if (name === 'demo-answer') {
    loadDemoAnswer();
  } else if (name === 'fill-demo-answer') {
    if (state.demoAnswer?.answer) {
      state.draft = state.demoAnswer.answer;
      state.symbolsOpen = false;
      render();
      const draft = $('#draft');
      if (draft) draft.focus();
      toast('已填入输入框，请点发送');
    }
  } else if (name === 'toggle-demo') {
    state.demo = !state.demo;
    if (!state.demo) {
      state.demoAnswer = null;
      state.demoLoading = false;
    }
    try { sessionStorage.setItem('dsh-demo', state.demo ? '1' : '0'); } catch (error) { /* ignore */ }
    const pill = $('#demo-pill');
    if (pill) pill.hidden = !state.demo;
    render();
    toast(state.demo ? '演示模式已开启' : '已关闭演示模式');
  } else if (name === 'toggle-aside') {
    state.asideCollapsed = !state.asideCollapsed;
    render();
  } else if (name === 'symbols') {
    state.symbolsOpen = !state.symbolsOpen;
    render();
  } else if (name === 'send') {
    send();
  } else if (name === 'back-chat') {
    state.step = 3;
    render();
  } else if (name === 'ocr') {
    runOcr();
  } else if (name === 'ocr-clear') {
    state.image = '';
    state.ocrImage = '';
    state.ocrBusy = false;
    state.ocrNotice = '';
    state.ocrStatus = '';
    render();
  } else if (name === 'voice') {
    toast('语音输入尚未接入');
  }
}

async function openFormulaCard() {
  if (state.hintLevel !== 3 || state.formulaOpen) return;
  if (!state.sessionId) {
    toast('公式卡需要先有一条真实的学习会话');
    return;
  }
  try {
    const { card } = await api('/api/formula', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    state.formulaCard = card;
  } catch (err) {
    toast(err.message);
    return;
  }
  const lastAi = state.messages.map((m) => m.role).lastIndexOf('ai');
  if (lastAi < 0) return;
  state.formulaOpen = true;
  state.formulaMessageIndex = lastAi;
  render();
}

const CONFETTI_COLORS = ['#5B52E0', '#7C4DFF', '#F2673A', '#F4B740', '#2BB894', '#E85D9C'];

/* 完成时的彩纸：纯装饰，减少动态时直接跳过 */
function burstConfetti() {
  const layer = $('#confetti-layer');
  if (!layer) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    layer.innerHTML = '';
    return;
  }
  layer.innerHTML = '';
  for (let i = 0; i < 40; i += 1) {
    const piece = document.createElement('i');
    piece.className = 'confetti';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.width = `${6 + Math.random() * 7}px`;
    piece.style.height = `${9 + Math.random() * 11}px`;
    piece.style.borderRadius = Math.random() > 0.55 ? '50%' : '2px';
    piece.style.setProperty('--drift', `${(Math.random() * 2 - 1) * 170}px`);
    piece.style.setProperty('--dur', `${3 + Math.random() * 1.8}s`);
    piece.style.setProperty('--delay', `${Math.random() * 0.7}s`);
    layer.appendChild(piece);
  }
}

function showCongrats(completion) {
  const answers = (completion.matched ?? [])
    .map((m) => `${m.value ?? ''} ${m.unit ?? ''}`.trim() || m.quote)
    .filter(Boolean);
  const box = $('#done-answers');
  if (box) {
    box.innerHTML = answers.length
      ? answers.map((a) => `<span>${esc(a)}</span>`).join('')
      : '<span>全部待求量</span>';
  }
  const stats = $('#done-stats');
  if (stats) {
    stats.innerHTML = `
      <div><strong>${answers.length || '—'}</strong><span>个待求量</span></div>
      <div><strong>${state.turns}</strong><span>轮对话</span></div>
      <div><strong>${state.hintLevel == null ? '—' : `L${state.hintLevel}`}</strong><span>用到的最高提示</span></div>`;
  }
  const overlay = $('#done-overlay');
  if (overlay) {
    overlay.hidden = false;
    burstConfetti();
    $('#btn-done-report')?.focus();
  }
}

function base64Bytes(dataUrl) {
  const index = dataUrl.indexOf(',');
  return Math.floor((dataUrl.length - (index + 1)) * 0.75);
}

async function runOcr() {
  if (!state.ocrImage || state.ocrBusy) return;
  if (base64Bytes(state.ocrImage) > 1_500_000) {
    state.ocrNotice = '图片压缩后仍超过 1.5 MB，请换一张更小的照片，或直接粘贴题目文字。';
    render();
    return;
  }

  state.ocrBusy = true;
  state.ocrNotice = '正在识别题目文字，大约 2~8 秒；识别结果会回填到文字输入框，请你核对。';
  render();

  try {
    const res = await api('/api/ocr', {
      method: 'POST',
      body: JSON.stringify({ image: state.ocrImage }),
    });
    const text = String(res.rawText ?? '').trim();
    if (!text) throw new Error('没有识别到文字，请换一张更清晰的照片');

    state.text = state.text.trim() ? `${state.text.trim()}\n${text}` : text;
    state.selected = -1;
    state.tab = 'text';
    state.ocrBusy = false;
    const figureNote = res.figureCount > 0
      ? `，并检测到 ${res.figureCount} 处配图（图形内容没有进题干，依赖图形时请补一句图里画了什么）`
      : '';
    state.ocrNotice = `识别完成（${res.latencyMs} ms${figureNote}）。文字已填入下方输入框，请先核对数值、上下标和单位，再点「确认题目」。`;
    render();
    toast('已填入输入框，请核对后确认题目');
  } catch (err) {
    state.ocrBusy = false;
    const charged = err.charged === true
      ? '这次调用可能已经计费，建议先确认照片清晰、确实是题目，再决定是否重试。'
      : err.charged === false
        ? '这次请求没有到达识别服务（未计费），可以直接重试。'
        : '';
    state.ocrNotice = `识别失败：${err.message}${charged ? ` ${charged}` : ''}`;
    render();
  }
}

async function send() {
  const text = state.draft.trim();
  if (!text || state.busy) return;
  if (!state.problem?.id) {
    toast('这道题还没有读入，请先确认题目');
    return;
  }

  if (state.hintLevel === 3 && !state.formulaOpen && /给我公式|公式是什么|直接给公式/.test(text)) {
    state.messages.push({ role: 'user', text });
    state.draft = '';
    openFormulaCard();
    return;
  }

  state.messages.push({ role: 'user', text });
  state.steps.push(`第 ${state.turns + 1} 轮 · ${text.length > 18 ? `${text.slice(0, 18)}…` : text}`);
  state.draft = '';
  state.symbolsOpen = false;
  state.busy = true;
  state.report = null;
  state.reportError = '';
  render();

  try {
    const res = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: state.sessionId,
        problemId: state.problem.id,
        utterance: text,
        mode: state.mode === 'solo' ? 'self_training' : 'ai_companion',
        explicitHelpSeeking: askedForHelp(text),
      }),
    });
    state.turns += 1;
    state.hintLevel = res.hint?.level ?? null;
    const message = String(res.message ?? '').trim()
      || (res.suppressed ? '（这一轮我先不打断你，留给你自己想。）' : '（我没有生成可显示的回复。）');
    state.messages.push({ role: 'ai', text: message });
    state.busy = false;
    persistSession();
    if (res.completion?.complete) showCongrats(res.completion);
    render();
  } catch (err) {
    state.busy = false;
    state.messages.push({ role: 'ai', text: `出错了：${err.message}` });
    render();
  }
}

function toast(text) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2000);
}

function bind() {
  $$('[data-action]').forEach((el) => {
    el.onclick = () => action(el.dataset.action);
  });
  $$('[data-tab]').forEach((el) => {
    el.onclick = () => {
      state.tab = el.dataset.tab;
      render();
    };
  });
  $$('[data-question]').forEach((el) => {
    el.onclick = () => selectSample(Number(el.dataset.question));
  });
  $$('[data-mode]').forEach((el) => {
    el.onclick = () => {
      state.mode = el.dataset.mode;
      render();
    };
  });
  $$('[data-chip]').forEach((el) => {
    el.onclick = () => {
      const chip = CHIPS[Number(el.dataset.chip)];
      state.draft = chip;
      const draft = $('#draft');
      if (draft) {
        draft.value = chip;
        draft.focus();
      }
    };
  });
  $$('[data-symbol]').forEach((el) => {
    el.onclick = () => {
      const draft = $('#draft');
      if (!draft) return;
      const symbol = el.dataset.symbol;
      const start = draft.selectionStart ?? draft.value.length;
      const end = draft.selectionEnd ?? start;
      draft.value = draft.value.slice(0, start) + symbol + draft.value.slice(end);
      const caret = start + symbol.length;
      draft.setSelectionRange(caret, caret);
      draft.focus();
      state.draft = draft.value;
    };
  });
  $$('[data-problem-view]').forEach((el) => {
    el.onclick = () => {
      state.problemView = el.dataset.problemView;
      render();
    };
  });
  $$('[data-related]').forEach((el) => {
    el.onclick = () => {
      const item = relatedProblems()[Number(el.dataset.related)];
      if (!item) return;
      if (item.id) {
        const index = state.problems.findIndex((p) => p.id === item.id);
        if (index >= 0) {
          state.mode = 'companion';
          selectSample(index).then(() => {
            state.step = 2;
            render();
          });
          return;
        }
      }
      state.problem = {
        subject: item.tag?.startsWith('数学') ? '数学' : '物理',
        tag: item.tag,
        topic: item.tag?.includes('二次函数') ? '二次函数' : item.tag?.includes('机械能') ? '机械能守恒' : '牛顿第二定律',
        text: item.text,
      };
      state.mode = 'companion';
      beginChat();
      state.step = 2;
      render();
    };
  });
  const textarea = $('#problem-text');
  if (textarea) {
    textarea.oninput = (event) => {
      state.text = event.target.value;
      state.selected = -1;
      $$('[data-question]').forEach((q) => {
        q.classList.remove('selected');
        q.setAttribute('aria-pressed', 'false');
        q.querySelector('.check')?.remove();
      });
      const confirm = $('[data-action="confirm"]');
      if (confirm) confirm.disabled = !validProblem();
    };
  }

  const draft = $('#draft');
  if (draft) {
    draft.oninput = (event) => {
      state.draft = event.target.value;
      if (state.autoReplace) applyShortcutAtCaret(draft);
    };
    draft.onblur = () => {
      if (state.autoReplace) applyShortcutAtCaret(draft, { flush: true });
    };
  }
  const autoBox = $('#auto-replace');
  if (autoBox) {
    autoBox.onchange = (event) => {
      state.autoReplace = event.target.checked;
    };
  }

  const modeSwitch = $('#mode-switch');
  if (modeSwitch) {
    modeSwitch.onchange = (event) => {
      state.mode = event.target.value;
      toast(`已切换为${state.mode === 'companion' ? 'AI 伴学' : '自主训练'}`);
    };
  }

  const historySearch = $('#history-search');
  if (historySearch) {
    historySearch.oninput = (event) => {
      const query = event.target.value.trim().toLowerCase();
      $$('#history-list li').forEach((li) => {
        li.hidden = Boolean(query) && !String(li.dataset.search ?? '').includes(query);
      });
    };
  }
  $$('[data-history]').forEach((el) => {
    el.onclick = () => {
      const store = readLearningStore();
      const snapshot = store.sessions.find((s) => s.sessionId === el.dataset.history);
      if (snapshot) {
        restoreSession(snapshot);
        toast('已恢复这条学习记录');
      }
    };
  });

  const problemFile = $('#problem-file');
  if (problemFile) {
    problemFile.onchange = async (event) => {
      const file = event.target.files?.[0];
      if (!file || !file.type.startsWith('image/')) {
        state.ocrNotice = '请选择图片文件（JPG / PNG）。';
        render();
        return;
      }

      state.ocrNotice = '';
      state.ocrStatus = '正在压缩图片…';
      render();

      const compressed = await compressImage(file);
      if (!compressed) {
        state.ocrImage = '';
        state.image = '';
        state.ocrStatus = '';
        state.ocrNotice = '浏览器无法读取或压缩这张图片。请换一张 JPG / PNG，或直接把题目文字粘贴到输入框。';
        render();
        return;
      }

      state.image = compressed.dataUrl;
      state.ocrImage = compressed.dataUrl;
      const kb = Math.round(base64Bytes(compressed.dataUrl) / 1024);
      state.ocrStatus = compressed.scaled
        ? `已压缩到 ${compressed.width}×${compressed.height}（${kb} KB）`
        : `图片 ${compressed.width}×${compressed.height}（${kb} KB）`;
      render();
    };
  }

  const chatFile = $('#chat-file');
  if (chatFile) {
    chatFile.onchange = () => toast('拍照上传会在第二步接入 OCR');
  }
}

/* ---------- 主题控制器 ---------- */
(function themeController() {
  const root = document.documentElement;
  const radios = $$('[data-theme-set]');
  const contrastBtn = $('#contrast-toggle');
  const LABEL = { light: '浅色', dark: '深色', system: '跟随系统' };

  function syncRadios(pref) {
    radios.forEach((b) => {
      const on = b.dataset.themeSet === pref;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
  }

  function syncContrast() {
    if (!contrastBtn) return;
    contrastBtn.setAttribute('aria-pressed', root.getAttribute('data-contrast') === 'high' ? 'true' : 'false');
  }

  function choose(pref) {
    window.Theme.set(pref, true);
    syncRadios(pref);
    toast(`主题：${LABEL[pref]}`);
  }

  radios.forEach((b) => {
    b.addEventListener('click', () => choose(b.dataset.themeSet));
    b.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const i = radios.indexOf(b);
      const next = radios[(i + (event.key === 'ArrowRight' ? 1 : radios.length - 1)) % radios.length];
      next.focus();
      choose(next.dataset.themeSet);
    });
  });

  contrastBtn?.addEventListener('click', () => {
    const next = root.getAttribute('data-contrast') === 'high' ? 'normal' : 'high';
    root.setAttribute('data-contrast', next);
    try {
      localStorage.setItem(window.Theme.CKEY, next);
    } catch (error) {
      /* localStorage 不可用时只影响下次打开 */
    }
    syncContrast();
    toast(next === 'high' ? '已开启高对比' : '已恢复标准对比');
  });

  const onSystemChange = () => {
    if (window.Theme.pref() === 'system') window.Theme.repaint();
  };
  if (window.Theme.mqDark.addEventListener) window.Theme.mqDark.addEventListener('change', onSystemChange);
  else if (window.Theme.mqDark.addListener) window.Theme.mqDark.addListener(onSystemChange);

  syncRadios(window.Theme.pref());
  syncContrast();
})();

/* ---------- 启动 ---------- */
$('#btn-done-close')?.addEventListener('click', () => {
  const overlay = $('#done-overlay');
  if (overlay) overlay.hidden = true;
});
$('#btn-done-report')?.addEventListener('click', () => {
  const overlay = $('#done-overlay');
  if (overlay) overlay.hidden = true;
  state.step = 4;
  state.report = null;
  state.reportError = '';
  render();
});

if (state.step >= 3) beginChat();
if (params.get('formula') === '1') {
  const lastAi = state.messages.map((m) => m.role).lastIndexOf('ai');
  state.formulaMessageIndex = lastAi >= 0 ? lastAi : null;
  state.formulaOpen = lastAi >= 0;
}
const demoPill = $('#demo-pill');
if (demoPill) demoPill.hidden = !state.demo;
render();
const hasDeepLink = state.demo || Boolean(params.get('step') || params.get('problem') || params.get('session') || params.get('demo'));
loadProblems(state.step !== 1).then(() => {
  if (!hasDeepLink) {
    const sessions = loadHistory();
    if (sessions.length) {
      restoreSession(sessions[0]);
      toast('已恢复上次学习进度');
      return;
    }
  }
  const requestedProblem = params.get('problem');
  if (!requestedProblem) return;
  const index = state.problems.findIndex((p) => p.id === requestedProblem);
  if (index < 0) return;
  selectSample(index).then(() => {
    if (state.step >= 3) {
      beginChat();
      render();
    }
  });
});
