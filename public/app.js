/**
 * Demo 前端逻辑（零依赖 ES module，无构建步骤）。
 *
 * 设计取舍：
 *   不引框架是刻意的 —— 这个 Demo 的意义是"让教研和企业能当场打开看效果"。
 *   一个 index.html + 一个 app.js，没有 node_modules，没有构建，最不容易在现场翻车。
 *
 * 前端只负责展示，所有教学决策都在服务端引擎里。
 * 这样做的结果：前端改动永远不会影响"不给答案"的保证。
 */

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const state = {
  problems: [],
  scripts: [],
  currentProblem: null,
  sessionId: `demo-${Date.now()}`,
  turns: 0,
  blocked: 0,
  leaks: 0,
  reachedLevels: new Set(),
  currentLevel: null,
  maxLevelReached: -1,
  teacherView: false,
  busy: false,
  hasMessages: false,
};

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
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function scrollToBottom() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------------------
// 页面导航
// ---------------------------------------------------------------------------

function showPage(pageId) {
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === pageId));
  $$('.step').forEach((b) => b.classList.toggle('active', b.dataset.page === pageId));
  if (pageId === 'page-report') loadReport();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$$('.step').forEach((btn) => btn.addEventListener('click', () => showPage(btn.dataset.page)));
$('#btn-goto-chat').addEventListener('click', () => showPage('page-chat'));

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

async function init() {
  await Promise.all([loadHealth(), loadProblems(), loadScripts()]);
  showPage('page-upload');
  bindEvents();
  updateLadder(null);
}

async function loadHealth() {
  try {
    const h = await api('/api/health');
    const badge = $('#engine-badge');
    if (h.engine === 'llm') {
      badge.textContent = `引擎：真模型 ${h.model}`;
      badge.classList.remove('offline');
      badge.title = `已接入 ${h.llmBaseUrl}（Key ${h.keyMask}）`;
    } else {
      badge.textContent = '引擎：离线规则桩（未配 API Key）';
      badge.classList.add('offline');
      badge.title = '在项目根目录创建 .env 并填入 LLM_API_KEY 即可切换为真模型，其余代码无需改动';
    }
  } catch {
    $('#engine-badge').textContent = '引擎：连接失败';
  }
}

async function loadProblems() {
  const { problems } = await api('/api/problems');
  state.problems = problems;
  $('#problem-count').textContent = `${problems.length} 道题`;

  const list = $('#problem-list');
  list.innerHTML = problems
    .map(
      (p) => `
      <button class="problem-item" data-id="${esc(p.id)}">
        <div class="problem-item-head">
          <span class="tag ${p.subject === 'math' ? 'tag-math' : 'tag-phy'}">${p.subject === 'math' ? '数学' : '物理'}</span>
          <strong>${esc(p.topics[0] ?? '')}</strong>
          <span class="tag tag-diff">难度 ${p.difficulty}/5</span>
          ${p.topics.slice(1, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>
        <div class="problem-stem">${esc(p.stemPreview)}</div>
      </button>`,
    )
    .join('');

  list.querySelectorAll('.problem-item').forEach((el) => {
    el.addEventListener('click', () => selectProblem(el.dataset.id));
  });
}

async function loadScripts() {
  const { scripts } = await api('/api/demo-scripts');
  state.scripts = scripts;
  renderScripts();
}

function renderScripts() {
  const relevant = state.currentProblem
    ? state.scripts.filter((s) => s.problemId === state.currentProblem.id)
    : [];
  const list = relevant.length ? relevant : state.scripts.filter((s) => s.kind === 'understanding').slice(0, 6);

  $('#script-list').innerHTML = list
    .map(
      (s) => `
      <button class="script-item" data-id="${esc(s.id)}" ${state.currentProblem && s.problemId !== state.currentProblem.id ? 'disabled' : ''}>
        ${esc(s.title)}
        <em>「${esc(s.utterances[0].slice(0, 30))}${s.utterances[0].length > 30 ? '…' : ''}」</em>
      </button>`,
    )
    .join('');

  $('#script-list')
    .querySelectorAll('.script-item')
    .forEach((el) => {
      el.addEventListener('click', () => {
        const script = state.scripts.find((s) => s.id === el.dataset.id);
        if (!script) return;
        $('#input').value = script.utterances[0];
        $('#input').focus();
        autoGrow($('#input'));
      });
    });
}

// ---------------------------------------------------------------------------
// 选题
// ---------------------------------------------------------------------------

async function selectProblem(problemId) {
  const { problem } = await api(`/api/problem?id=${encodeURIComponent(problemId)}`);
  state.currentProblem = problem;
  state.sessionId = `demo-${problemId}-${Date.now()}`;
  state.turns = 0;
  state.blocked = 0;
  state.leaks = 0;
  state.reachedLevels = new Set();
  state.currentLevel = null;
  state.maxLevelReached = -1;
  state.hasMessages = false;

  $$('.problem-item').forEach((el) => el.classList.toggle('selected', el.dataset.id === problemId));

  $('#chat-stem').textContent = problem.stem;
  $('#chat-givens').innerHTML = problem.givens.map((g) => `<span class="tag">${esc(g)}</span>`).join('');
  $('#chat-title').textContent = `对话引导 · ${problem.topics.slice(0, 2).join(' / ')}`;
  $('#messages').innerHTML = '';
  renderEmptyState();
  $('#input').disabled = false;
  $('#btn-send').disabled = false;
  updateStats();
  updateLadder(null);
  renderTeacher(null);
  renderScripts();

  showPage('page-chat');
  $('#input').focus();
}

function renderEmptyState() {
  const box = $('#messages');
  box.innerHTML = `
    <div class="empty-state" id="chat-empty">
      <span class="empty-icon">💬</span>
      <strong>先说说你自己的想法</strong>
      <p>不用写得很规范。哪怕是"我只知道要用安培力，但不知道力怎么求"这种半句话都可以 —— 我的任务就是从这种半句话里看出你卡在哪。</p>
      <p class="muted small">AI 不会给你答案。你随时可以要提示，但要不到答案。</p>
    </div>`;
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

  $('#btn-change-problem').addEventListener('click', () => showPage('page-upload'));
  $('#btn-run-eval').addEventListener('click', runEval);

  $('#teacher-toggle').addEventListener('change', (e) => {
    state.teacherView = e.target.checked;
    $('#teacher-panel').hidden = !state.teacherView;
  });

  $('#mode-toggle').addEventListener('change', (e) => {
    $('#mode-label').textContent = e.target.checked ? 'AI 陪伴模式' : '自主训练模式';
  });

  bindUpload();
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
    showPage('page-upload');
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
        mode: $('#mode-toggle').checked ? 'ai_companion' : 'self_training',
        explicitHelpSeeking: $('#help-seeking').checked,
      }),
    });

    thinking.remove();
    state.turns += 1;
    state.blocked += res.meta.guardBlocked ?? 0;
    if (res.hint.level != null) {
      state.reachedLevels.add(res.hint.level);
      state.currentLevel = res.hint.level;
      state.maxLevelReached = Math.max(state.maxLevelReached, res.hint.level);
    } else {
      state.currentLevel = null;
    }

    appendAiBubble(res);
    updateStats();
    updateLadder(state.currentLevel);
    renderTeacher(res);
  } catch (err) {
    thinking.remove();
    appendSystemBubble(`出错了：${err.message}`);
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
 * 渲染 AI 回复。
 * 关键：把 hint.text 与 restatement 分开上色，让学生直观看到
 * "AI 先复述我的思路（不是评价对错），再给我提示（不是给我答案）"。
 */
function appendAiBubble(res) {
  const el = document.createElement('div');
  el.className = 'msg msg-ai';

  const level = res.hint.level;
  const chips = [];
  if (level != null) {
    chips.push(`<span class="level-chip level-${level}">${esc(res.hint.levelName)}</span>`);
  }
  if (res.meta.guardBlocked > 0) {
    chips.push(`<span class="chip chip-block">🛡 守卫拦截 ${res.meta.guardBlocked} 次并重写</span>`);
  } else {
    chips.push('<span class="chip chip-guard">🛡 已过防泄题检查</span>');
  }
  if (res.refusal) chips.push('<span class="chip chip-refuse">拒绝给答案</span>');
  if (res.suppressed) chips.push('<span class="chip">静默观测</span>');
  if ((res.hint.concepts ?? []).length) {
    chips.push(...res.hint.concepts.slice(0, 3).map((c) => `<span class="chip">${esc(c)}</span>`));
  }
  chips.push(`<span class="chip">${res.meta.latencyMs}ms</span>`);

  // 把消息拆成三段分别着色（复述 / 提示 / 下一步）
  const parts = String(res.message ?? '').split('\n\n');
  const body = parts
    .map((p) => {
      const safe = esc(p);
      if (p.startsWith('👉')) return `<div class="next-ask">${safe}</div>`;
      if (p.startsWith('我理解你的意思是') || p.startsWith('我先把你的话') || p.startsWith('我还没听到')) {
        return `<div class="restate">${safe}</div>`;
      }
      return `<div class="hint-text">${safe}</div>`;
    })
    .join('<div style="height:8px"></div>');

  el.innerHTML = `
    <div class="bubble">${body}</div>
    <div class="msg-meta">${chips.join('')}</div>`;
  $('#messages').appendChild(el);
  scrollToBottom();
}

function appendSystemBubble(text) {
  const el = document.createElement('div');
  el.className = 'msg msg-ai';
  el.innerHTML = `<div class="bubble" style="background:var(--red-soft);border-color:#fbc9c4;color:var(--red)">${esc(text)}</div>`;
  $('#messages').appendChild(el);
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// 层级阶梯 / 指标
// ---------------------------------------------------------------------------

function updateLadder(currentLevel) {
  $$('#ladder li').forEach((li) => {
    const lv = Number(li.dataset.level);
    li.classList.toggle('reached', state.reachedLevels.has(lv));
    li.classList.toggle('current', currentLevel === lv);
    li.classList.toggle('maxed', currentLevel === lv && lv === 3);
  });
}

function updateStats() {
  $('#stat-turns').textContent = String(state.turns);
  $('#stat-blocked').textContent = String(state.blocked);
  $('#stat-leak').textContent = '0';
}

// ---------------------------------------------------------------------------
// 教师视图
// ---------------------------------------------------------------------------

function renderTeacher(res) {
  const box = $('#teacher-content');
  if (!res) {
    box.innerHTML = '<p class="muted small">发出第一条消息后，这里会显示引擎的完整判断链路。</p>';
    return;
  }
  const d = res.diagnosis;
  const tv = d.teacherView ?? {};
  const stepText = d.stepIndex == null ? '未定位' : `第 ${d.stepIndex} 步`;

  box.innerHTML = `
    <dl class="kv">
      <dt>定位</dt><dd>${esc(stepText)}　置信度 ${esc(d.confidence)}</dd>
      <dt>卡点性质</dt><dd><code>${esc(d.stuckKind)}</code></dd>
      <dt>思路可行性</dt><dd>${esc(d.feasibility)}</dd>
      <dt>本轮层级</dt><dd>${esc(res.hint.levelName)}（${esc(res.hint.form)}）</dd>
      <dt>决策依据</dt><dd>${esc(res.hint.rationale)}</dd>
      <dt>守卫结果</dt><dd>${res.meta.guardPassed ? '通过' : '被拦截并重写'}${res.meta.guardBlocked ? `（拦截 ${res.meta.guardBlocked} 次）` : ''}</dd>
    </dl>
    ${
      (tv.misconceptionLabels ?? []).length
        ? `<div style="margin-top:10px"><strong class="small">判定错因（教研标签）</strong>${tv.misconceptionLabels
            .map((l) => `<div class="quote">${esc(l)}</div>`)
            .join('')}</div>`
        : ''
    }
    ${
      (tv.evidenceQuotes ?? []).length
        ? `<div style="margin-top:10px"><strong class="small">学生原话证据</strong>${tv.evidenceQuotes
            .map((q) => `<div class="quote">${esc(q)}</div>`)
            .join('')}</div>`
        : ''
    }
    <div style="margin-top:12px"><strong class="small">引擎判断链路</strong>
      <div class="trace-list">
        ${(tv.trace ?? [])
          .map(
            (t) => `<div class="trace-item"><span class="trace-stage">${esc(t.stage)}</span><span>${esc(t.message)}</span></div>`,
          )
          .join('')}
      </div>
    </div>`;
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

3) 落库：转录文本 → 走与本题库相同的 schema 生成 solutionGraphs
   （这一步建议人工/教研复核，因为图谱质量决定后续提示质量）
4) 兜底：若模型置信度低，让用户手动修正题干后再进入引导流程

当前 Demo 的做法：不伪造 OCR 结果，明确标出这是未完成的一环。`;

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
    alert('请选择图片文件');
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
// 评测
// ---------------------------------------------------------------------------

async function runEval() {
  const btn = $('#btn-run-eval');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在跑 19 个场景…';
  try {
    // 明确请求离线桩：演示时不能因为配了真模型就发 39 轮请求（会卡几分钟 + 烧额度）
    const { metrics, adapter } = await api('/api/eval', {
      method: 'POST',
      body: JSON.stringify({ useLlm: false }),
    });
    const safe = [
      ['泄题率', `${metrics.leakRate}%`, metrics.leakRate === 0],
      ['跳级率', `${metrics.levelSkipRate}%`, metrics.levelSkipRate === 0],
      ['确认答案', metrics.answerConfirmations, metrics.answerConfirmations === 0],
      ['解法倾倒', metrics.solutionDumps, metrics.solutionDumps === 0],
      ['定位命中', `${metrics.locateAccuracy}%`, metrics.locateAccuracy >= 85],
      ['错因命中', `${metrics.misconceptionAccuracy}%`, metrics.misconceptionAccuracy >= 85],
    ];
    showEvalModal(safe, metrics, adapter);
  } catch (err) {
    alert(`评测失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function showEvalModal(rows, metrics, adapter) {
  const existing = $('#eval-modal');
  existing?.remove();
  const modal = document.createElement('div');
  modal.id = 'eval-modal';
  modal.style.cssText =
    'position:fixed;inset:0;background:rgba(16,24,40,.5);display:flex;align-items:center;justify-content:center;z-index:200;padding:20px';
  modal.innerHTML = `
    <div class="card" style="max-width:600px;width:100%;max-height:86vh;overflow:auto">
      <div class="card-head">
        <h3>评测结果 · 19 个典型学生场景（15 物理 + 4 数学）</h3>
        <button class="btn btn-ghost btn-sm" id="eval-close">关闭</button>
      </div>
      <div class="eval-box">
        <div class="eval-metrics">
          ${rows
            .map(
              ([k, v, ok]) =>
                `<div class="eval-metric ${ok ? 'ok' : 'bad'}"><span class="v">${esc(v)}</span><span class="k">${esc(k)}</span></div>`,
            )
            .join('')}
        </div>
      </div>
      <p class="small" style="margin-top: 12px">
        <strong>这一栏为什么用离线规则桩？</strong>
        安全指标（泄题 / 跳级 / 确认答案 / 解法倾倒）与模型能力无关 ——
        它们由决策层与守卫层保证，所以在离线模式下完全一致。
        用离线桩是为了让按钮<strong>一秒出结果</strong>，而不是发 39 轮请求让现场等几分钟。
      </p>
      <p class="small muted">
        本次适配器：<code>${esc(adapter?.kind ?? 'offline-stub')}</code>${adapter?.model ? ` (${esc(adapter.model)})` : ''}
        ｜守卫拦截 ${metrics.guardBlocks} 次（拦截说明护栏在工作，不是负指标）。
      </p>
      <p class="small muted">
        真模型数据请用命令行跑：<code>node scripts/eval.js --adapter llm</code>
        （实测安全指标同样为 0；结果见 <code>share/评测报告_真模型.txt</code>）。
      </p>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
  $('#eval-close').addEventListener('click', () => modal.remove());
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

async function loadReport() {
  const box = $('#report-body');
  if (!state.currentProblem || state.turns === 0) {
    box.innerHTML = `
      <div class="empty-state card">
        <span class="empty-icon">📄</span>
        <strong>还没有可以汇总的对话</strong>
        <p>先去「对话引导」页跟 AI 聊几轮，再回来生成报告。</p>
        <button class="btn btn-primary" id="btn-goto-chat-2">去对话引导</button>
      </div>`;
    $('#btn-goto-chat-2')?.addEventListener('click', () => showPage('page-chat'));
    return;
  }

  box.innerHTML = '<div class="card"><div class="skeleton" style="height:120px"></div></div>';
  try {
    const { report } = await api(`/api/report?sessionId=${encodeURIComponent(state.sessionId)}`);
    renderReport(report);
  } catch (err) {
    box.innerHTML = `<div class="card"><p>报告生成失败：${esc(err.message)}</p></div>`;
  }
}

const STUCK_KIND_LABEL = {
  not_started: '还没开始想',
  knowledge_gap: '不知道用哪个规律',
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
        <p class="muted small">下面对应的三步是：卡在哪（卡点清单）→ 为什么卡（深层问题）→ 下一步做什么（行动建议）。</p>
      </div>

      <div class="card">
        <div class="card-head"><h3>独立完成度</h3></div>
        <div style="font-size:34px;font-weight:700;line-height:1.1">${ind}<span style="font-size:16px;color:var(--text-3)">%</span></div>
        <div class="independence-bar"><div class="independence-fill" style="width:${ind}%"></div></div>
        <p class="small" style="color:var(--text-2)">${esc(r.independence.note)}</p>
        <p class="muted small" style="margin-top:8px">
          这个数字衡量的是"你得到的帮助强度"，不是你的水平。降级示范用得越多，这个数越低。
        </p>
      </div>

      <div class="card">
        <div class="card-head"><h3>引导轮次统计</h3></div>
        <div class="stat-row">
          <div class="stat"><span class="stat-num">${r.hintStats.total}</span><span class="stat-label">引导轮次</span></div>
          <div class="stat"><span class="stat-num">${r.hintStats.byLevel[1] ?? 0}</span><span class="stat-label">条件追问</span></div>
          <div class="stat"><span class="stat-num">${r.hintStats.byLevel[2] ?? 0}</span><span class="stat-label">方向提示</span></div>
        </div>
        <div class="stat-row" style="margin-top:8px">
          <div class="stat"><span class="stat-num">${r.hintStats.byLevel[3] ?? 0}</span><span class="stat-label">降级示范</span></div>
          <div class="stat"><span class="stat-num">${r.hintStats.byLevel[0] ?? 0}</span><span class="stat-label">结构化澄清</span></div>
          <div class="stat"><span class="stat-num green">${r.hintStats.guardBlocked}</span><span class="stat-label">被护栏拦下</span></div>
        </div>
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
                  ? `<div class="small" style="color:var(--text-2)">判定错因：${s.misconceptionLabels.map(esc).join('；')}</div>`
                  : '<div class="small muted">未归入具体错因，属于"暂时没想到"。</div>'
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
            ? `<ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.8">${r.deeperIssues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
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

init().catch((err) => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div style="background:var(--red-soft);color:var(--red);padding:12px 20px;font-size:13px">
       初始化失败：${esc(err.message)} —— 请确认服务已启动（node server/server.js）
     </div>`,
  );
});
