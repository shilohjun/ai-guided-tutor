/**
 * 设置面板截图：主题 × 字号档位 × 视口，零依赖（只用本机 Chrome 的 CDP）。
 * 用法：node scripts/shoot-settings.cjs [baseUrl] [--out dir]
 * 需要 Node ≥ 22（内置 WebSocket）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
];

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith('http')) || 'http://127.0.0.1:5173';
const outFlag = args.indexOf('--out');
const OUT = path.resolve(outFlag >= 0 ? args[outFlag + 1] : path.join(__dirname, '..', '.tmp-shots', 'settings'));
const PORT = Number(process.env.SHOT_PORT || 9334);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (typeof WebSocket === 'undefined') {
  console.error('这个脚本要用 Node ≥ 22 的内置 WebSocket（当前 ' + process.version + '）。');
  process.exit(1);
}
const CHROME = process.env.CHROME || CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome / Edge。装一个，或用 CHROME 环境变量指过去。');
  process.exit(1);
}

async function waitForDebugger(port) {
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 浏览器还没起来 */
    }
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
      if (msg.error) rej(new Error(method + ' → ' + (msg.error.message || JSON.stringify(msg.error))));
      else res(msg);
    });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, ready, send };
}

/** 一组要拍的组合：page / theme / ux / 视口 */
const SHOTS = [
  { name: 'desktop-light-m', page: 1, theme: 'light', ux: 'm', vp: 'desktop', open: true },
  { name: 'desktop-dark-m', page: 1, theme: 'dark', ux: 'm', vp: 'desktop', open: true },
  { name: 'desktop-light-s', page: 1, theme: 'light', ux: 's', vp: 'desktop', open: true },
  { name: 'desktop-light-l', page: 1, theme: 'light', ux: 'l', vp: 'desktop', open: true },
  { name: 'desktop-dark-l', page: 1, theme: 'dark', ux: 'l', vp: 'desktop', open: false },
  { name: 'p3-light-l', page: 3, theme: 'light', ux: 'l', vp: 'desktop', open: false },
  { name: 'p3-dark-l', page: 3, theme: 'dark', ux: 'l', vp: 'desktop', open: true },
  { name: 'phone-dark-m', page: 1, theme: 'dark', ux: 'm', vp: 'phone', open: true },
  { name: 'phone-light-l', page: 1, theme: 'light', ux: 'l', vp: 'phone', open: true },
  { name: 'phone-light-m', page: 3, theme: 'light', ux: 'm', vp: 'phone', open: false }
];

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, mobile: false },
  phone: { width: 390, height: 844, mobile: true }
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const userDataDir = path.join(os.tmpdir(), 'dsh-set-shots-' + process.pid);
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
  const probes = [];
  for (const shot of SHOTS) {
    const vp = VIEWPORTS[shot.vp];
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile
    });
    // 主题与档位都从地址栏传，否则上一轮的 localStorage 会漏到下一轮
    await cdp.send('Page.navigate', {
      url: BASE + '/?p=' + shot.page + '&theme=' + shot.theme + '&ux=' + shot.ux
    });
    await sleep(2000);
    if (shot.open) {
      await cdp.send('Runtime.evaluate', { expression: "document.getElementById('setBtn').click()" });
      await sleep(320);
    }
    const probe = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const root = document.documentElement;
        const cs = getComputedStyle(root);
        const tb = document.querySelector('.topbar').getBoundingClientRect();
        const pop = document.getElementById('setPop').getBoundingClientRect();
        const h1 = document.querySelector('.p1-hero h1') || document.querySelector('.pane-head strong');
        return {
          ux: root.getAttribute('data-ux'), theme: root.getAttribute('data-theme'), pref: root.getAttribute('data-theme-pref'),
          fsBody: cs.getPropertyValue('--fs-body').trim(),
          topbar: Math.round(tb.height),
          docW: document.documentElement.scrollWidth, winW: innerWidth,
          hOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          popRect: Math.round(pop.width) + 'x' + Math.round(pop.height) + '@' + Math.round(pop.left) + ',' + Math.round(pop.top),
          h1: h1 ? getComputedStyle(h1).fontSize : null
        };
      })()`
    });
    probes.push({ name: shot.name, ...probe.result.result.value });
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, shot.name + '.png');
    fs.writeFileSync(file, Buffer.from(png.result.data, 'base64'));
    written.push(file);
  }

  cdp.ws.close();
  proc.kill();

  for (const f of written) console.log(path.relative(process.cwd(), f));
  console.log('\n探针：');
  for (const p of probes) {
    console.log(
      '  ' + p.name.padEnd(18) +
      'ux=' + p.ux + ' theme=' + p.theme + '(' + p.pref + ')' +
      ' fs-body=' + p.fsBody + ' h1=' + p.h1 +
      ' topbar=' + p.topbar +
      ' pop=' + p.popRect +
      (p.hOverflow ? '  ✗ 横向溢出 docW=' + p.docW + ' winW=' + p.winW : '  横向 OK')
    );
  }
})().catch((e) => {
  console.error('截图失败：' + e.message);
  process.exit(1);
});
