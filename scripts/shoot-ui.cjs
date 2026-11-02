/**
 * 截图核对：五页 + 深色 + 三档视口，零依赖（只用本机 Chrome 的 CDP）。
 * 用法：node scripts/shoot-ui.cjs [baseUrl] [--out dir]
 * 需要 Node ≥ 22（用到内置 WebSocket）；Node 20 上会直接说清原因，不会静默失败。
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
const OUT = path.resolve(outFlag >= 0 ? args[outFlag + 1] : path.join(__dirname, '..', 'preview'));
const PORT = Number(process.env.SHOT_PORT || 9333);

/** 视口档位：桌面演示走 1440，笔记本 1024，平板 768，手机 390 */
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'phone', width: 390, height: 844 }
];
/** 深色只截有代表性的三页，省时间也够看 */
const PAGES = [1, 2, 3, 4, 5];
const DARK_PAGES = [1, 3, 4];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (typeof WebSocket === 'undefined') {
  console.error('这个脚本要用 Node ≥ 22 的内置 WebSocket（当前 ' + process.version + '）。');
  console.error('升级 Node，或者手动截：chrome --headless=new --screenshot=x.png "' + BASE + '/?p=1"');
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
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, ready, send };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const userDataDir = path.join(os.tmpdir(), 'dsh-ui-shots-' + process.pid);
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
  for (const vp of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 1,
      mobile: vp.width < 500
    });
    for (const n of PAGES) {
      const list = vp.name === 'desktop' ? [null, 'dark'] : [null];
      for (const theme of list) {
        if (theme === 'dark' && !DARK_PAGES.includes(n)) continue;
        // 主题必须显式传：页面会把选择写进 localStorage，上一轮的深色会漏到下一轮的浅色
        const url = BASE + '/?p=' + n + '&theme=' + (theme || 'light');
        await cdp.send('Page.navigate', { url });
        await sleep(2200); // 等数据与入场动画落定
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const name = 'p' + n + (theme ? '-' + theme : '') + (vp.name === 'desktop' ? '' : '-' + vp.name) + '.png';
        const file = path.join(OUT, name);
        fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
        written.push(file);
      }
    }
  }

  // 顺带把关键计算值收一遍，确认令牌没有被意外继承
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: BASE + '/?p=1' });
  await sleep(2200);
  const probe = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const sel = ['.p1-hero h1', '.p1-hero p', '.composer', '.bank', '.q-item', '.btn-primary', '.tag', '.brand-name'];
      const out = { viewport: innerWidth + 'x' + innerHeight, docWidth: document.documentElement.scrollWidth };
      for (const s of sel) {
        const el = document.querySelector(s);
        if (!el) continue;
        const cs = getComputedStyle(el);
        out[s] = cs.fontSize + '/' + cs.fontWeight + ' r=' + cs.borderRadius + ' pad=' + cs.padding;
      }
      return out;
    })()`
  });

  cdp.ws.close();
  proc.kill();

  for (const f of written) console.log(path.relative(process.cwd(), f));
  console.log('\n计算值：');
  for (const [k, v] of Object.entries(probe.result.result.value)) console.log('  ' + k.padEnd(16) + v);
  console.log('\n截图写在 ' + OUT);
})().catch((e) => {
  console.error('截图失败：' + e.message);
  process.exit(1);
});
