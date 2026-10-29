/**
 * 把 public/index.html 打成**单文件、离线可开**的预览版。
 *
 * 只做三件事，不去改页面结构与样式：
 *   1. 内联 scripts/demo-data.json（真实抓取的接口返回）
 *   2. 在主脚本之前装一层 fetch 拦截，把 /api/* 就地应答
 *   3. 标题标注"演示预览"，并提供 ?p=N 深链与 ?auto=1 自动演示
 *
 * 为什么用拦截 fetch 而不是改业务代码：业务代码和线上完全同一份，
 * 预览版里看到的行为就是线上行为，不会出现"demo 里能点、线上不能点"。
 *
 * 用法：node scripts/build-preview.cjs
 * 产物：preview/preview.html
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'index.html');
const DATA = path.join(__dirname, 'demo-data.json');
const OUT_DIR = path.join(ROOT, 'preview');
const OUT = path.join(OUT_DIR, 'preview.html');

const demo = JSON.parse(fs.readFileSync(DATA, 'utf8'));

/* ---------- 1. 组装离线数据 ---------- */

// 题库只留题库里的题：抓取时导入过的题会进 imported 注册表，别混进列表
const bank = demo.bank.filter((q) => q.source === 'library');

const health = {
  ok: true,
  engine: 'demo-static',
  model: null,
  llmConfigured: false,
  problemCount: bank.length,
  // 预览版把拍照识题标成可用，否则相机按钮一点就弹"未启用"，演示会中断
  ocr: {
    configured: true,
    provider: 'demo',
    providerLabel: '演示模式（返回内置识别结果）',
    hint: '预览版不连识别服务，拍照后返回一段固定的题目文字'
  },
  capabilities: { intake: true, intakeFallback: true, ocr: true }
};

/**
 * 报告页的"用时"由 turns 的首尾时间差算出。
 * 抓取是几秒内跑完的，直接内联会显示"1 分钟"，和 8 步的推导过程不匹配，
 * 所以按 60 秒一轮重新铺开（只动时间戳，不动任何结论）。
 */
const reportTurns = (demo.report.turns || []).map((t, i) => ({
  ...t,
  at: new Date(Date.UTC(2026, 9, 28, 12, 0, 0) + i * 60000).toISOString()
}));

const payload = {
  health,
  bank,
  problems: demo.problems,
  imported: demo.imported,
  mainId: demo.mainId,
  turns: demo.turns,
  report: { ...demo.report, turns: reportTurns },
  ocrText:
    '如图所示，水平放置的两条光滑平行金属导轨间距为 L = 0.5 m，' +
    '处在竖直向上、垂直于导轨平面的匀强磁场中，B = 0.4 T。' +
    '导体棒电阻 r = 0.1 Ω，左端接 R = 0.3 Ω 的电阻，忽略摩擦，' +
    '导体棒以 v = 2 m/s 匀速向右运动。求感应电动势、感应电流、外力及其功率。'
};

/* ---------- 2. 拦截层 ---------- */

const MOCK = String.raw`
(function () {
  var node = document.getElementById('demo-data');
  var D = JSON.parse(node.textContent);
  var turnIdx = 0;
  var MOCKED = true;

  /* 全角 → 半角、去空白：和服务端 text.js 的归一化口径对齐，
     这样"把 AI 回复里引用的原话换成用户真正打的那句"才找得到 */
  function canon(s) {
    return String(s == null ? '' : s)
      .replace(/[\uFF01-\uFF5E]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xfee0); })
      .replace(/\s+/g, '');
  }

  /** 引擎回复会引用学生原话；预览里用户打的可能不是脚本那句，就地换掉 */
  function refit(res, utterance, scriptedSay) {
    var say = String(utterance || '').trim();
    if (!say || !res) return res;
    var copy = JSON.parse(JSON.stringify(res));
    var old = canon(scriptedSay || '');
    function fix(text) {
      if (!text) return text;
      var t = String(text);
      if (old) t = t.split(old).join(say);
      // 兜底：直接改"你的推理走到了「…」"里的那句
      return t.replace(/(你的推理走到了「)[^」]*(」)/, '$1' + say + '$2');
    }
    copy.message = fix(copy.message);
    if (copy.hint) {
      copy.hint.text = fix(copy.hint.text);
      copy.hint.nextAsk = fix(copy.hint.nextAsk);
    }
    return copy;
  }

  function reply(data, status) {
    var code = status || 200;
    var body = JSON.stringify(data);
    return Promise.resolve({
      ok: code < 400,
      status: code,
      statusText: code < 400 ? 'OK' : 'Error',
      json: function () { return Promise.resolve(JSON.parse(body)); },
      text: function () { return Promise.resolve(body); }
    });
  }

  function splitUrl(u) {
    var s = String(u == null ? '' : (typeof u === 'string' ? u : u.url || ''));
    s = s.replace(/^[a-z]+:\/\/[^/]+/i, '');
    var i = s.indexOf('?');
    return { path: i < 0 ? s : s.slice(0, i), query: i < 0 ? '' : s.slice(i + 1) };
  }

  window.fetch = function (input, init) {
    var u = splitUrl(input);
    var qs = new URLSearchParams(u.query);

    if (u.path === '/api/health') return reply(D.health);
    if (u.path === '/api/problems') return reply({ problems: D.bank });
    if (u.path === '/api/problem') {
      return reply({ problem: D.problems[qs.get('id')] || D.problems[D.mainId] });
    }
    if (u.path === '/api/problem/import') return reply(D.imported);
    if (u.path === '/api/ocr') return reply({ rawText: D.ocrText, provider: 'demo' });
    if (u.path === '/api/report') return reply(D.report);

    if (u.path === '/api/chat') {
      var body = {};
      try { body = JSON.parse((init && init.body) || '{}'); } catch (e) {}
      var t = D.turns[Math.min(turnIdx, D.turns.length - 1)];
      turnIdx += 1;
      // 模拟一点思考时间，否则气泡瞬间出现，看不出"在生成"
      return new Promise(function (done) {
        setTimeout(function () { done(reply(refit(t.res, body.utterance, t.say))); }, 520);
      });
    }

    return reply({ error: '预览版没有实现这个接口：' + u.path }, 404);
  };

  /* ---------- 3. 自动演示：?auto=1 ---------- */
  function auto() {
    if (!/(\?|&)auto=1(&|$)/.test(location.search)) return;
    if (!/(\?|&)p=3(&|$)/.test(location.search)) return;

    var box = document.getElementById('chatBody');
    var input = document.getElementById('input3');
    var btn = document.getElementById('send3');
    var i = 0;

    function step() {
      if (i >= D.turns.length) {
        var go = document.querySelector('.done-row [data-goto="4"]');
        if (go) setTimeout(function () { go.click(); }, 900);
        return;
      }
      var line = D.turns[i].say;
      i += 1;
      input.value = line;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
      var start = Date.now();
      var wait = setInterval(function () {
        var busy = box.querySelector('.bubble.dots');
        if ((!busy && Date.now() - start > 700) || Date.now() - start > 6000) {
          clearInterval(wait);
          setTimeout(step, 700);
        }
      }, 120);
    }

    setTimeout(step, 1200);
  }

  window.__DEMO__ = { mocked: MOCKED, turns: D.turns.length };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', auto);
  } else {
    auto();
  }
})();
`;

/* ---------- 3. 注入 ---------- */

let html = fs.readFileSync(SRC, 'utf8');

const appScriptAnchor = html.lastIndexOf('<script>');
if (appScriptAnchor < 0) throw new Error('没找到主脚本位置');

const inject =
  '<script id="demo-data" type="application/json">' +
  JSON.stringify(payload).replace(/</g, '\\u003c') +
  '</script>\n<script id="demo-mock">' +
  MOCK +
  '</script>\n';

html = html.slice(0, appScriptAnchor) + inject + html.slice(appScriptAnchor);
html = html.replace(
  '<title>步步解 · 引导解题工作台</title>',
  '<title>步步解 · 引导解题工作台（演示预览）</title>'
);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
console.log('写入 ' + OUT + '（' + kb + ' KB）');
console.log('  题库 ' + bank.length + ' 题 · 对话 ' + demo.turns.length + ' 轮 · 报告卡点 ' +
  demo.report.report.stuckPoints.length + ' 条');
