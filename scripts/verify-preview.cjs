/**
 * 验收单文件预览版：**用 file:// 打开**（模拟别人下载后双击），
 * 走一遍真实点击链路，确认不依赖服务端也能完整跑通。
 *
 * 用法：node scripts/verify-preview.cjs
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const WS = [
  'puppeteer-core',
  'C:/Users/liz20/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core'
].find((p) => { try { require.resolve(p); return true; } catch (e) { return false; } });
if (!WS) throw new Error('没装 puppeteer-core');
const puppeteer = require(WS);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].find((p) => fs.existsSync(p));

const SRC = path.join(__dirname, '..', 'preview', 'preview.html');
const OUT = path.join(__dirname, '..', 'preview');
const URL_BASE = pathToFileURL(SRC).href;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, extra) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!ok) failed += 1;
}

(async () => {
  if (!fs.existsSync(SRC)) throw new Error('先跑 node scripts/build-preview.cjs');
  if (!CHROME) throw new Error('找不到 Chrome / Edge');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  /* ---------- 页一 ---------- */
  await page.goto(URL_BASE + '?p=1', { waitUntil: 'load' });
  await sleep(800);

  check('mock 已接管 fetch', await page.evaluate(() => Boolean(window.__DEMO__ && window.__DEMO__.mocked)));
  const bankCount = await page.evaluate(() => document.querySelectorAll('#bankList .q-item').length);
  check('题库列表渲染', bankCount === 6, '题数=' + bankCount);

  await page.screenshot({ path: path.join(OUT, 'demo-p1.png') });

  /* 搜索过滤 */
  await page.click('.q-item');
  await sleep(200);

  /* ---------- 页一 → 页二 ---------- */
  await page.click('#go2');
  await sleep(700);
  const onP2 = await page.evaluate(() => document.body.dataset.page);
  check('点题进入模式页', onP2 === '2', 'page=' + onP2);
  const stemLen = await page.evaluate(() => (document.querySelector('#p2text').textContent || '').length);
  check('模式页显示题干', stemLen > 50, '字数=' + stemLen);
  await page.screenshot({ path: path.join(OUT, 'demo-p2.png') });

  /* ---------- 页二 → 页三 ---------- */
  await page.click('#go3');
  await sleep(700);
  check('进入解题页', (await page.evaluate(() => document.body.dataset.page)) === '3');

  /* 发一句话，确认 AI 有回复 */
  await page.click('#input3');
  await page.type('#input3', '我想先看回路，导体棒是电源', { delay: 8 });
  await page.click('#send3');
  await sleep(1400);
  const aiCount = await page.evaluate(() => document.querySelectorAll('#chatBody .msg.ai .bubble:not(.dots)').length);
  check('对话得到 AI 回复', aiCount >= 1, '气泡=' + aiCount);
  const bubble = await page.evaluate(() => {
    const el = document.querySelector('#chatBody .msg.ai .bubble');
    return el ? el.textContent.trim() : '';
  });
  check('回复非空且不是占位文案', bubble.length > 8 && !/本轮没有返回内容/.test(bubble), bubble.slice(0, 30));
  await page.screenshot({ path: path.join(OUT, 'demo-p3.png') });

  /* 左栏题干 */
  const leftLen = await page.evaluate(() => (document.querySelector('#leftBody').textContent || '').length);
  check('左栏题目详情', leftLen > 100, '字数=' + leftLen);

  /* ---------- 自动演示跑完 + 报告页 ---------- */
  await page.goto(URL_BASE + '?p=3&auto=1', { waitUntil: 'load' });
  await sleep(6800);
  // 自动演示跑到一半时抓一张，用来核对"多轮对话"的排版
  await page.screenshot({ path: path.join(OUT, 'demo-p3.png') });
  await sleep(5 * 1900 + 1500 - 6800);

  const autoTurns = await page.evaluate(() => document.querySelectorAll('#chatBody .msg').length);
  check('自动演示完成 5 轮', autoTurns >= 10, '消息=' + autoTurns);

  const onP4 = await page.evaluate(() => document.body.dataset.page);
  check('自动跳到报告页', onP4 === '4', 'page=' + onP4);

  const dur = await page.evaluate(() => document.querySelector('#durNum').textContent);
  check('报告用时非 0', Number(dur) >= 5, dur + ' 分钟');

  const wrongItems = await page.evaluate(() => document.querySelectorAll('#wrongList .wrong-item').length);
  check('报告有错因条目', wrongItems >= 1, '条数=' + wrongItems);
  const causes = await page.evaluate(() =>
    [...document.querySelectorAll('#wrongList .wrong-item')].map((el) => {
      const k = el.querySelectorAll('.k');
      const v = el.querySelectorAll('.v');
      const c = el.querySelector('.cause');
      return (k[0] ? k[0].textContent + '：' : '') + (v[0] ? v[0].textContent : '') +
        ' / 错因 ' + (c ? c.textContent : '');
    })
  );
  check('错因里出现"漏掉内阻"', causes.some((s) => /内阻/.test(s)), causes.join(' ‖ '));
  await page.screenshot({ path: path.join(OUT, 'demo-p4.png') });

  /* ---------- 页五 ---------- */
  await page.click('#go5');
  await sleep(600);
  const relCount = await page.evaluate(() => document.querySelectorAll('#dropList .q-item').length);
  check('迁移页有同类题', relCount >= 1, '题数=' + relCount);
  await page.screenshot({ path: path.join(OUT, 'demo-p5.png') });

  /* ---------- 深色 ---------- */
  await page.goto(URL_BASE + '?p=3&auto=1&theme=dark', { waitUntil: 'load' });
  await sleep(1500 + 5 * 1900);
  await page.screenshot({ path: path.join(OUT, 'demo-p3-dark.png') });

  check('没有 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(failed ? '\n有 ' + failed + ' 项未通过' : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
