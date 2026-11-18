/**
 * iPhone 视口核对：P0「查看报告」入口。
 * 用法：node scripts/shoot-ios-p0.cjs [baseUrl] [--out dir]
 * 只打本机。完成态用页面上的 ?simDone=1（不改服务端结论）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/usr/local/bin/google-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith('http')) || 'http://127.0.0.1:5199';
const outFlag = args.indexOf('--out');
const OUT = path.resolve(outFlag >= 0 ? args[outFlag + 1] : path.join(__dirname, '..', 'artifacts', 'ios-p0'));
const PORT = Number(process.env.SHOT_PORT || 9334);
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (typeof WebSocket === 'undefined') {
  console.error('需要 Node ≥ 22 的内置 WebSocket（当前 ' + process.version + '）。');
  process.exit(1);
}
const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome。');
  process.exit(1);
}

async function waitForDebugger(port) {
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 浏览器还没起来 */ }
  }
  throw new Error('CDP 在 15 秒内没就绪');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('WebSocket 连不上 CDP')));
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, (msg) => {
      if (msg.error) rej(new Error(method + ': ' + JSON.stringify(msg.error)));
      else res(msg);
    });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, ready, send };
}

async function evaluate(cdp, expression) {
  const msg = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  const r = msg.result && msg.result.result;
  if (!r) throw new Error('evaluate 没有结果：' + expression.slice(0, 80));
  if (r.subtype === 'error' || msg.result.exceptionDetails) {
    const d = msg.result.exceptionDetails;
    throw new Error((d && d.text) || r.description || 'evaluate 失败');
  }
  return r.value;
}

async function waitUntil(cdp, expression, label, ms) {
  const deadline = Date.now() + (ms || 20000);
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, '(() => { try { return (' + expression + '); } catch (e) { return "ERR " + e.message; } })()');
    if (last === true) return;
    await sleep(200);
  }
  throw new Error('等待超时：' + (label || expression) + ' 最后=' + JSON.stringify(last));
}

async function shot(cdp, file) {
  const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'));
}

async function setPhone(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 3, mobile: true, screenWidth: width, screenHeight: height
  });
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'iPhone' });
}

async function setDesktop(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false
  });
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    platform: 'MacIntel'
  });
}

const MEASURE = `(() => {
  const frame = document.querySelector('#frame');
  const doc = frame && frame.contentDocument;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fr = frame ? frame.getBoundingClientRect() : null;
  function pack(el, origin) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = (origin ? origin.x : 0) + r.x;
    const y = (origin ? origin.y : 0) + r.y;
    const box = { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(x + r.width), bottom: Math.round(y + r.height) };
    box.inside = box.w > 0 && box.h > 0 && box.x >= -1 && box.y >= -1 && box.right <= vw + 1 && box.bottom <= vh + 1;
    return box;
  }
  const btn = doc && doc.querySelector('#viewReportBtn');
  const step = doc && doc.querySelector('.pstep[data-goto="4"]');
  const note = doc && doc.querySelector('#solveReportNote');
  const hint = doc && doc.querySelector('#solveDoneHint');
  const input = doc && doc.querySelector('#input3');
  const mode = doc && doc.querySelector('#modeSwitch');
  const setMode = doc && doc.querySelector('#setMode');
  return {
    viewport: vw + 'x' + vh,
    parentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    frameOverflow: doc ? doc.documentElement.scrollWidth - doc.documentElement.clientWidth : null,
    page: doc && doc.body.getAttribute('data-page'),
    reportHidden: doc ? doc.querySelector('#solveReport').hidden : null,
    reportText: btn ? btn.textContent.trim() : null,
    reportPrimary: btn ? btn.classList.contains('btn-primary') : null,
    noteHidden: note ? note.hidden : null,
    noteText: note ? note.textContent.trim() : null,
    hintHidden: hint ? hint.hidden : null,
    hintText: hint ? hint.textContent.trim() : null,
    inputDisabled: input ? input.disabled : null,
    modeDisplay: mode ? getComputedStyle(mode).display : null,
    setModeDisplay: setMode ? getComputedStyle(setMode).display : null,
    report: pack(btn, fr),
    step4: pack(step, fr),
    stemH: doc ? (doc.documentElement.style.getPropertyValue('--stem-h') || '').trim() : null,
    problemH: doc && doc.querySelector('#problemPane') ? Math.round(doc.querySelector('#problemPane').getBoundingClientRect().height) : null,
    chatH: doc && doc.querySelector('#chatPane') ? Math.round(doc.querySelector('#chatPane').getBoundingClientRect().height) : null,
    viewportH: vh
  };
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const userDataDir = path.join(os.tmpdir(), 'bsj-ios-p0-' + process.pid);
  const proc = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDataDir,
    'about:blank'
  ], { stdio: 'ignore' });

  const cdp = connect(await waitForDebugger(PORT));
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const written = [];
  const measures = {};

  async function save(name) {
    const file = path.join(OUT, name);
    await shot(cdp, file);
    written.push(file);
  }

  async function openPilotAndChat() {
    await cdp.send('Page.navigate', { url: BASE + '/pilot.html' });
    await waitUntil(cdp, "!!document.querySelector('#helloSkip')", '问候屏');
    await evaluate(cdp, "document.querySelector('#helloSkip').click()");
    await waitUntil(cdp, "!!document.querySelector('#frame')", '产品页 iframe');
    await evaluate(cdp, "document.querySelector('#frame').src = '/index.html?p=3&theme=light&guide=0&simDone=1'");
    await waitUntil(
      cdp,
      "(() => { const d = document.querySelector('#frame').contentDocument; return !!(d && d.body && d.body.getAttribute('data-page') === '3' && d.querySelector('#leftBody') && !d.querySelector('#leftBody .pane-empty') && (d.querySelector('#leftBody').innerText || '').length > 20); })()",
      '解题页已载入题目'
    );
    await evaluate(cdp, "document.querySelector('#frame').contentDocument.querySelector('#sugs .sug').click()");
    await waitUntil(
      cdp,
      "(() => { const d = document.querySelector('#frame').contentDocument; const bar = d.querySelector('#solveReport'); const ai = d.querySelector('#chatBody .msg.ai .bubble'); return !!(bar && !bar.hidden && ai && !ai.classList.contains('dots')); })()",
      '一轮真实对话后的查看报告'
    );
  }

  await setPhone(cdp, 390, 844);
  await openPilotAndChat();
  measures['pilot-390-after-chat'] = await evaluate(cdp, MEASURE);
  await save('A-pilot-solve-390.png');

  await setPhone(cdp, 360, 780);
  await sleep(400);
  measures['pilot-360-after-chat'] = await evaluate(cdp, MEASURE);
  await save('B-pilot-solve-360.png');

  await setPhone(cdp, 414, 896);
  await sleep(300);
  measures['pilot-414-after-chat'] = await evaluate(cdp, MEASURE);

  await setPhone(cdp, 430, 932);
  await sleep(300);
  measures['pilot-430-after-chat'] = await evaluate(cdp, MEASURE);

  await setPhone(cdp, 390, 844);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await sleep(300);
  const beforeDrag = await evaluate(cdp, `(() => {
    const frame = document.querySelector('#frame').getBoundingClientRect();
    const doc = document.querySelector('#frame').contentDocument;
    const s = doc.querySelector('#splitter').getBoundingClientRect();
    const p = doc.querySelector('#problemPane').getBoundingClientRect();
    return { x: frame.x + s.x + s.width / 2, y: frame.y + s.y + s.height / 2, problemH: p.height };
  })()`);
  const dragTo = beforeDrag.y + 140;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: beforeDrag.x, y: beforeDrag.y, id: 1 }] });
  await sleep(80);
  for (let step = 1; step <= 7; step++) {
    const y = beforeDrag.y + (140 * step) / 7;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: beforeDrag.x, y, id: 1 }] });
    await sleep(40);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
  measures['pilot-390-before-drag'] = beforeDrag;
  measures['pilot-390-after-drag'] = await evaluate(cdp, MEASURE);
  const afterH = measures['pilot-390-after-drag'].problemH;
  if (!(afterH > beforeDrag.problemH + 40)) {
    throw new Error('触摸拖拽没有把题目拉高：' + beforeDrag.problemH + ' -> ' + afterH);
  }
  await save('G-pilot-stem-dragged-390.png');

  await evaluate(cdp, "document.querySelector('#frame').contentDocument.querySelector('#stemOpen').click()");
  await waitUntil(cdp, "!document.querySelector('#frame').contentDocument.querySelector('#stemPop').hidden", '题目弹层');
  await sleep(300);
  measures['pilot-390-stem-pop'] = await evaluate(cdp, `(() => {
    const doc = document.querySelector('#frame').contentDocument;
    const body = doc.querySelector('#stemPopBody').innerText || '';
    return { hasStepDots: !!doc.querySelector('#stemPopXp') || !!doc.querySelector('#stemPop .xp-dot'), text: body.slice(0, 80) };
  })()`);
  await save('F-pilot-stem-pop-390.png');
  await evaluate(cdp, "document.querySelector('#frame').contentDocument.querySelector('#stemPopClose').click()");
  await waitUntil(cdp, "document.querySelector('#frame').contentDocument.querySelector('#stemPop').hidden", '关上题目弹层');

  await evaluate(cdp, "document.querySelector('#out').click()");
  await waitUntil(cdp, "!document.querySelector('#endAsk').hidden", '结束确认');
  measures['pilot-390-end-ask'] = await evaluate(cdp, `(() => {
    const card = document.querySelector('#endAskCard').getBoundingClientRect();
    const report = document.querySelector('#endAskReport').getBoundingClientRect();
    const end = document.querySelector('#endAskEnd').getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    function inside(r) { return r.width > 0 && r.x >= -1 && r.y >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1; }
    return {
      title: document.querySelector('#endAskTitle').textContent,
      report: document.querySelector('#endAskReport').textContent,
      end: document.querySelector('#endAskEnd').textContent,
      reportInside: inside(report),
      endInside: inside(end),
      cardInside: inside(card),
      parentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  })()`);
  await save('C-pilot-end-ask-390.png');

  await evaluate(cdp, "document.querySelector('#endAskReport').click()");
  await waitUntil(
    cdp,
    "(() => { const d = document.querySelector('#frame').contentDocument; const load = d.querySelector('#reportLoad'); return d.body.getAttribute('data-page') === '4' && load && load.hidden && d.querySelector('#mCount') && d.querySelector('#mCount').textContent.trim() !== '—'; })()",
    '报告页'
  );
  await sleep(400);
  measures['pilot-390-report'] = await evaluate(cdp, MEASURE);
  await save('D-pilot-report-390.png');

  await evaluate(cdp, "(() => { const w = document.querySelector('#frame').contentWindow; const d = w.document; d.querySelector('.pstep[data-goto=\"3\"]').click(); w.__bsjMarkDone(); return true; })()");
  await waitUntil(
    cdp,
    "(() => { const d = document.querySelector('#frame').contentDocument; const hint = d.querySelector('#solveDoneHint'); const input = d.querySelector('#input3'); const btn = d.querySelector('#viewReportBtn'); return d.body.getAttribute('data-page') === '3' && input.disabled && hint && !hint.hidden && btn.classList.contains('btn-primary'); })()",
    '完成态'
  );
  await sleep(700);
  measures['pilot-390-done'] = await evaluate(cdp, MEASURE);
  await save('E-pilot-done-390.png');

  // 裸产品页 / ：同一套入口，不套试点壳
  await setPhone(cdp, 390, 844);
  await cdp.send('Page.navigate', { url: BASE + '/?p=3&theme=light&guide=0&simDone=1' });
  await waitUntil(
    cdp,
    "document.body.getAttribute('data-page') === '3' && !document.querySelector('#leftBody .pane-empty')",
    '裸页解题'
  );
  await evaluate(cdp, "document.querySelector('#sugs .sug').click()");
  await waitUntil(
    cdp,
    "(() => { const bar = document.querySelector('#solveReport'); const ai = document.querySelector('#chatBody .msg.ai .bubble'); return !!(bar && !bar.hidden && ai && !ai.classList.contains('dots')); })()",
    '裸页一轮对话'
  );
  measures['index-390-after-chat'] = await evaluate(cdp, MEASURE.replace("document.querySelector('#frame')", 'null').replace('const doc = frame && frame.contentDocument;', 'const doc = document;').replace('const fr = frame ? frame.getBoundingClientRect() : null;', 'const fr = {x:0,y:0};'));
  await save('index-solve-390.png');

  await setPhone(cdp, 360, 780);
  await sleep(300);
  measures['index-360-after-chat'] = await evaluate(cdp, MEASURE.replace("document.querySelector('#frame')", 'null').replace('const doc = frame && frame.contentDocument;', 'const doc = document;').replace('const fr = frame ? frame.getBoundingClientRect() : null;', 'const fr = {x:0,y:0};'));

  await evaluate(cdp, "document.querySelector('#viewReportBtn').click()");
  await waitUntil(cdp, "document.body.getAttribute('data-page') === '4'", '裸页报告');
  measures['index-360-report-opened'] = true;

  await setDesktop(cdp);
  await cdp.send('Page.navigate', { url: BASE + '/?p=3&theme=light&guide=0' });
  await waitUntil(cdp, "document.body.getAttribute('data-page') === '3'", '桌面解题页');
  await sleep(500);
  measures.desktop = await evaluate(cdp, `(() => {
    const mode = document.querySelector('#modeSwitch');
    const setMode = document.querySelector('#setMode');
    const step = document.querySelector('.pstep[data-goto="4"]').getBoundingClientRect();
    return {
      viewport: innerWidth + 'x' + innerHeight,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      modeDisplay: getComputedStyle(mode).display,
      modeHiddenAttr: mode.hidden,
      setModeDisplay: getComputedStyle(setMode).display,
      step4Right: Math.round(step.right),
      step4Inside: step.right <= innerWidth + 1 && step.x >= -1
    };
  })()`);
  await save('desktop-solve-1280.png');

  fs.writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify(measures, null, 2));
  cdp.ws.close();
  proc.kill();
  for (const f of written) console.log(path.relative(process.cwd(), f));
  console.log('measurements: ' + path.join(OUT, 'measurements.json'));
})().catch((e) => {
  console.error('截图失败：' + (e && e.stack || e));
  process.exit(1);
});
