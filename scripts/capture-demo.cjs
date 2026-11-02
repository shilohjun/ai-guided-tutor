/**
 * 抓取一次完整演示会话的真实返回，固化为静态预览用的数据。
 *
 * 为什么不用手写假数据：预览版要和线上长得一样，返回结构稍有偏差就会
 * 在页面上表现为"某个字段空了"。所以这里直接驱动真实服务的离线引擎
 * （engine=offline-stub），把 8 步走完，连同报告一起存下来。
 *
 * 用法：
 *   1) 先起服务：npm start
 *   2) node scripts/capture-demo.js
 * 产物：scripts/demo-data.json
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.DEMO_BASE || 'http://127.0.0.1:5173';
const OUT = path.join(__dirname, 'demo-data.json');

/** 预览里"粘贴题目"入口用的示例文本（抓取时按它生成真实分析结果） */
const IMPORT_SAMPLE =
  '如图所示，水平放置的两条光滑平行金属导轨间距为 L = 0.5 m，处在竖直向下、垂直于导轨平面的匀强磁场中，B = 2 T。' +
  '一根质量 m = 0.2 kg、电阻 r = 0.2 Ω 的导体棒垂直搁在导轨上，导轨左端接有 R = 0.8 Ω 的电阻，导轨电阻不计。' +
  '现用水平向右的外力拉着导体棒，使导体棒沿导轨以恒定速度 v = 3 m/s 向右运动。求：(1) 感应电动势；(2) 感应电流；(3) 水平外力的大小。';

/**
 * 学生的话按步骤顺序推进。
 *
 * 第三步故意说成 "I=E/R ... 内阻不用管"：这是本题预置的错因之一
 * （把导体棒当外电路、漏掉内阻 r），报告页才有真实可归纳的卡点；
 * 否则整份报告只剩"方向没定下来"这种泛泛条目。
 *
 * 轮数控制在 5 轮：报告页按步骤升序取前 3 条卡点，轮数再多，
 * 中间那些泛泛的卡点会把这条有标签的错因挤出列表。
 */
const SCRIPT = [
  '先看回路吧，导体棒是电源，左边那个电阻是外电路',
  '这是导体棒切割磁感线，应该能用 E=BLv',
  '电流用欧姆定律算，I=E/R，内阻 r 应该不用管',
  '匀速说明合力为零，外力应该等于安培力',
  '代入数值得 E=0.4 V，I=1 A，F=0.2 N，P=0.4 W'
];

async function post(url, body) {
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(url + ' -> ' + res.status + ' ' + text.slice(0, 200));
  return JSON.parse(text);
}

async function get(url) {
  const res = await fetch(BASE + url);
  const text = await res.text();
  if (!res.ok) throw new Error(url + ' -> ' + res.status + ' ' + text.slice(0, 200));
  return JSON.parse(text);
}

async function main() {
  const health = await get('/api/health');
  const bank = await get('/api/problems');
  if (!bank.problems || !bank.problems.length) throw new Error('题库为空，无法抓取');

  const mainId = 'phy-emi-01';
  const full = {};
  for (const q of bank.problems) {
    const one = await get('/api/problem?id=' + encodeURIComponent(q.id));
    full[q.id] = one.problem;
  }

  const sessionId = 'demo-' + Date.now().toString(36);
  const turns = [];
  for (const line of SCRIPT) {
    const r = await post('/api/chat', {
      sessionId,
      problemId: mainId,
      utterance: line,
      mode: 'ai_companion',
      explicitHelpSeeking: false
    });
    turns.push({ say: line, res: r });
    const p = r.progress || {};
    console.log(
      '  第 ' + script_index(turns) + ' 轮 → step ' + p.stepIndex + '/' + p.stepCount +
      '  完成 [' + (p.completed || []).join(',') + ']' +
      (r.completion && r.completion.complete ? '  ✔答案完整' : '')
    );
  }

  const report = await get('/api/report?sessionId=' + encodeURIComponent(sessionId));

  /**
   * 导入链路也抓一份真实返回：预览版里"粘贴一道题"的入口不能是死链，
   * 而且导入题的结构（givens / asked / stepCount）和题库题不一样，
   * 手写容易漏字段。
   */
  const imported = await post('/api/problem/import', { rawText: IMPORT_SAMPLE });

  const out = {
    capturedAt: new Date().toISOString(),
    engine: health.engine,
    health: {
      ok: true,
      engine: health.engine,
      llmConfigured: Boolean(health.llmConfigured),
      ocr: { configured: false, provider: 'marketplace' }
    },
    bank: bank.problems,
    problems: full,
    imported,
    mainId,
    sessionId,
    turns,
    report
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log('\n写入 ' + OUT);
  console.log('  题库 ' + bank.problems.length + ' 题；对话 ' + turns.length + ' 轮');
  console.log('  报告卡点 ' + ((report.report && report.report.stuckPoints) || []).length + ' 条');
}

function script_index(list) {
  return String(list.length).padStart(2, '0');
}

main().catch((e) => {
  console.error('抓取失败：' + e.message);
  process.exit(1);
});
