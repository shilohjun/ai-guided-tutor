/**
 * 截图核对：5 个页面 + 深色，1440x900。
 * 用法：node scripts/shoot-ui.cjs [baseUrl]
 * 依赖：puppeteer-core + 本机 Chrome
 */
const fs = require('fs');
const path = require('path');

const WS = [
  'puppeteer-core',
  'C:/Users/liz20/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core'
].find((p) => { try { require.resolve(p); return true; } catch (e) { return false; } });
if (!WS) throw new Error('没装 puppeteer-core：npm i -D puppeteer-core');
const puppeteer = require(WS);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].find((p) => fs.existsSync(p));

const BASE = process.argv[2] || 'http://127.0.0.1:5173';
const OUT = path.join(__dirname, '..', 'preview');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  if (!CHROME) throw new Error('找不到 Chrome / Edge');
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=2']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

  const shots = [
    [1, 'light'], [2, 'light'], [3, 'light'], [4, 'light'], [5, 'light'],
    [1, 'dark'], [3, 'dark'], [4, 'dark']
  ];
  for (const [p, theme] of shots) {
    const url = `${BASE}/?p=${p}&theme=${theme}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise((r) => setTimeout(r, 700)); // 等页面动画
    const file = path.join(OUT, `p${p}-${theme}.png`);
    await page.screenshot({ path: file });
    console.log(path.relative(path.join(__dirname, '..'), file));
  }

  // 顺带把计算后的字号/圆角收一遍，确认没有意外继承
  await page.goto(`${BASE}/?p=1`, { waitUntil: 'networkidle2' });
  const report = await page.evaluate(() => {
    const sel = ['.p1-hero h1', '.p1-hero p', '.composer', '.bank', '.q-item', '.btn-primary', '.tag', '.brand-name'];
    const out = {};
    for (const s of sel) {
      const el = document.querySelector(s);
      if (!el) continue;
      const cs = getComputedStyle(el);
      out[s] = `${cs.fontSize}/${cs.fontWeight} r=${cs.borderRadius} pad=${cs.padding}`;
    }
    return out;
  });
  console.log('\n计算值：');
  for (const [k, v] of Object.entries(report)) console.log('  ' + k.padEnd(16) + v);

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
