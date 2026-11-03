/**
 * 前端契约与保密测试。
 *
 * 这个套件守的是两类"只有在浏览器里才会炸"的问题 ——
 * 而它们恰恰是最容易漏测的，因为它们不属于引擎逻辑：
 *
 *   ① **DOM 契约**：app.js 里 $('  #xxx  ') 引用的每个 id，宿主页（classic.html）里必须真的存在。
 *      写错一个字母不会报错，只会静默地什么都不发生 ——
 *      表现为"点了按钮没反应"，而现场演示时才发现。
 *
 *   ② **密钥不外泄**：.env 里的 API Key 与教师口令，
 *      不允许出现在任何会被提交 / 会被部署 / 会被学生看到的文件里。
 *      （前端能读到的 Key = 公开的 Key；前端能读到的教师口令 = 没有口令。）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, assert, assertEquals, assertIncludes, assertNotIncludes } from './runner.js';
import { loadEnvFile, ROOT } from '../src/core/env.js';

/**
 * 学生看到的就是这一个文件：五页版的 markup、样式、脚本全在 public/index.html 里。
 * 旧壳 classic.html 只作为回退保留，不再参与契约核对。
 */
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
/** 单文件里的所有内联脚本 —— 渲染逻辑都在这里 */
const appJs = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');
/** 去掉 HTML 注释与 style/script 后的可见文本 —— 注释里写"这里不放防泄题面板"是正常的，学生看不到 */
const htmlVisible = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<script[\s\S]*?<\/script>/g, '');

/** 宿主页（classic.html）里声明的所有 id */
function htmlIds() {
  const ids = new Set();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  return ids;
}

/** app.js 里通过 $('#xxx') / $$('#xxx ...') 引用的 id */
function referencedIds() {
  const out = new Map(); // id -> 出现次数
  for (const m of appJs.matchAll(/\$\$?\(\s*['"]#([A-Za-z0-9_-]+)/g)) {
    out.set(m[1], (out.get(m[1]) ?? 0) + 1);
  }
  return out;
}

/**
 * 动态创建后再引用的 id。
 *
 * 这些不是笔误，而是 JS 渲染时生成的容器。列在这里是**有代价的** ——
 * 列进来就等于放弃了这几条的静态检查，所以每一条都要写清"谁创建它"，
 * 将来如果有人删了创建代码，这份名单就该跟着删。
 */
const DYNAMIC_IDS = new Set([
  // 新版把容器都写死在 markup 里：实测内联脚本引用的 62 个 id 全部能在 index.html 里找到，
  // 所以这份名单目前是空的。以后若有人改成"JS 现建容器再引用"，就得在这里登记谁创建它。
]);

describe('前端 · DOM 契约（防止"点了没反应"）', () => {
  /**
   * 新版五页是单文件：markup、样式、脚本都在 public/index.html 里。
   * 好处是不用再对两份文件，坏处一模一样 —— 脚本引用一个不存在的 id 不会报错，
   * 只会静默地什么都不发生。所以照旧从脚本里把 id 抓出来，回同一个文件里核对。
   */
  it('内联脚本引用的每个 id 都存在于 index.html（或是有意动态创建的）', () => {
    const declared = htmlIds();
    const missing = [];
    for (const [id, count] of referencedIds()) {
      if (declared.has(id) || DYNAMIC_IDS.has(id)) continue;
      missing.push(id + '（引用 ' + count + ' 次）');
    }
    assert(missing.length === 0, '以下 id 在 index.html 里不存在，运行时会静默失效：\n  ' + missing.join('\n  '));
  });

  it('学生解题页不含任何"防泄题 / 教研"面板（那些内容不该出现在学生面前）', () => {
    const start = htmlVisible.indexOf('data-page="3"');
    const end = htmlVisible.indexOf('data-page="4"');
    assert(start > 0 && end > start, '第 3 页（解题）的锚点应存在');
    const chatSection = htmlVisible.slice(start, end);
    assertNotIncludes(chatSection, '防泄题', '学生解题页不应出现"防泄题"面板');
    assertNotIncludes(chatSection, '守卫拦截', '学生解题页不应出现"守卫拦截"统计');
    assertNotIncludes(chatSection, '答案泄漏', '学生解题页不应出现"答案泄漏"字样');
    assertNotIncludes(chatSection, '参考答案', '学生解题页不应出现"参考答案"字样');
  });
});

describe('前端 · 布局不许出现"钉住的面板遮挡内容"', () => {
  /**
   * 反馈过的真实问题："向下浏览时，右侧那一栏固定住了，压住下面的内容"。
   * 新版把这条当成硬约束：整页走普通文档流，全站只有顶栏允许 sticky。
   */
  it('样式里除顶栏外没有 sticky 元素', () => {
    const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [null, ''])[1];
    const stripped = style.replace(/\/\*[\s\S]*?\*\//g, '');
    const offenders = [];
    for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/position:\s*sticky/.test(m[2])) continue;
      const sel = m[1].trim().split(/\s+/).join(' ');
      if (!sel.includes('.topbar')) offenders.push(sel);
    }
    assert(offenders.length === 0, '除顶栏外不应有 sticky 元素（会导致面板遮挡内容）：\n  ' + offenders.join('\n  '));
  });
});

describe('前端 · 文案不会被当成纯文本显示', () => {
  /**
   * 在 HTML / JS 模板字符串里写 \*\*加粗\*\* 不会生效，只会把星号原样显示出来。
   * 新版是单文件，所以可见文本与内联脚本各守一遍。
   */
  const starLines = (text) =>
    text
      .split(/\r?\n/)
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter((x) => x.line.includes('**'));

  it('index.html 的可见文本里没有 Markdown 星号', () => {
    const hits = starLines(htmlVisible);
    assert(
      hits.length === 0,
      'index.html 有 Markdown 星号会被原样显示：\n  ' + hits.map((h) => h.no + ': ' + h.line.slice(0, 80)).join('\n  '),
    );
  });

  it('内联脚本的渲染模板里没有 Markdown 星号（注释不算）', () => {
    const code = appJs
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    const hits = starLines(code);
    assert(
      hits.length === 0,
      '内联脚本里有 Markdown 星号，会被原样显示：\n  ' + hits.map((h) => h.no + ': ' + h.line.slice(0, 80)).join('\n  '),
    );
  });
});

describe('前端 · 五页流程契约（新版单文件）', () => {
  /**
   * 这一组守的是"用户点得到、且点了有正确反应"。
   * 之前守的是旧壳里的两张模式卡与一个开关；新版把口径换成了：
   * 五页随时可切、AI 伴学按能力位置灰、第 5 页三张卡。
   */
  const PAGE_NAMES = ['题目', '方式', '解题', '报告', '巩固'];
  const pageMarkup = (n) => {
    const start = html.indexOf('<section class="page" data-page="' + n + '"');
    const end = html.indexOf('<section class="page" data-page="' + (n + 1) + '"');
    return html.slice(start, end > start ? end : html.length);
  };
  const page2 = pageMarkup(2);
  const router = readFileSync(join(ROOT, 'src/server/router.js'), 'utf8');

  it('步骤条就是这五页，而且五页都能点（没有 disabled）', () => {
    assertIncludes(appJs, "var PAGES = ['题目', '方式', '解题', '报告', '巩固'];", '步骤条文案要与五页一致（第 5 页叫"巩固"）');
    const stepper = appJs.slice(appJs.indexOf('function renderStepper'), appJs.indexOf('function setPage'));
    assertIncludes(stepper, 'PAGES.map(', '步骤条要遍历 PAGES 渲染，而不是另抄一份页名');
    assertIncludes(stepper, 'data-goto=', '每个步骤按钮都要带 data-goto，点了才能切页');
    for (const label of PAGE_NAMES) assertIncludes(html, label, '页面标记里缺少 ' + label + ' 这一页');
    assert(!/disabled/.test(stepper), '步骤条不该再禁用任何一页 —— 没数据就进空态，不能把人弹回去');
  });

  it('第 2 页：自主训练默认选中并标"推荐"，AI 伴学禁用并标"暂未更新"', () => {
    const selfAt = page2.indexOf('data-mode="self"');
    const aiAt = page2.indexOf('data-mode="ai"');
    assert(selfAt > 0 && aiAt > 0, '两张模式卡都应存在');
    assert(selfAt < aiAt, '自主训练要排在前面（它是当前唯一能用的方式）');
    const selfBtn = page2.slice(Math.max(0, selfAt - 240), aiAt);
    assertIncludes(selfBtn, 'aria-pressed="true"', '自主训练应当默认选中');
    assertIncludes(selfBtn, '推荐', '自主训练要带"推荐"标签');
    const aiBtn = page2.slice(aiAt - 240, aiAt + 900);
    assertIncludes(aiBtn, 'disabled', 'AI 伴学必须是禁用态，而不是点了才报错');
    assertIncludes(aiBtn, '暂未更新', 'AI 伴学要说明为什么点不了');
    assertNotIncludes(aiBtn, '推荐', 'AI 伴学不该被推荐');
    assertIncludes(appJs, "mode: 'self'", '初始模式必须是自主训练');
  });

  it('能不能点由服务端能力位决定，不是前端写死', () => {
    assertIncludes(appJs, 'function applyModes(', '缺少按能力位渲染模式的 applyModes()');
    assertIncludes(appJs, 'capabilities && h.capabilities.modes', '应当从 /api/health 的 capabilities.modes 读可用模式');
    assertIncludes(router, "modes: ['self_training']", '能力位要如实只说自主训练');
    assertIncludes(router, "'MODE_UNAVAILABLE'", '没上线的模式要在服务端直接拒绝，别让它跑到引擎里');
  });

  it('五页都有空态说明（没数据时说清下一步，而不是弹回去）', () => {
    assertIncludes(appJs, 'pane-empty', '第 3 页左栏要有空态样式');
    assertIncludes(appJs, '还没有题目', '空态要写清"现在没有题"');
    assertIncludes(appJs, '还没有开始做题', '第 4 页空态要写清先去哪一步');
    assertIncludes(appJs, '题库里没有同知识点的其他题目', '第 5 页同类题为空时也要说清楚');
  });

  it('第 3 页左侧显示"做到第几步"，且只翻译走过的步骤（防泄题）', () => {
    assertIncludes(appJs, 'function renderXP()', '缺少步骤进度渲染');
    assertIncludes(appJs, "'第 ' + cur + ' / ' + total + ' 步'", '进度文案应当是"第 N / M 步"');
    assertIncludes(appJs, 'S.progress.labels', '步骤名称要取自服务端给的 stepLabels');
    assertIncludes(router, 'function stepLabelsFor(', '服务端要有 stepLabelsFor()');
    assertIncludes(router, 'safeStepRef', '步骤只允许翻译已经走过的，防提前泄题');
  });

  it('第 5 页是两张卡：重做 / 同类题', () => {
    for (const id of ['redoBtn', 'startRelated']) {
      assertIncludes(html, 'id="' + id + '"', '第 5 页缺少 ' + id);
    }
    assertIncludes(html, '重做这道题', '缺少"重做"卡');
    assertIncludes(html, '同类题再练', '缺少"同类题"卡');

    const seg = html.slice(
      html.indexOf('<section class="page" data-page="5"'),
      html.indexOf('<section class="page" data-page="5"') + 4000
    );
    const cards = (seg.match(/class="bar-card"/g) || []).length;
    assert(cards === 2, '第 5 页只保留两张卡，实际 ' + cards + ' 张');
  });

  it('同类题按题库的真实双轴标签筛，不再用 topics 字符串猜', () => {
    assertIncludes(html, 'id="relDrawer"', '第 5 页要有同类题抽屉');
    assertIncludes(appJs, 'function relCandidates(', '缺少同类题筛选函数');
    assertIncludes(appJs, 'q.leafId === cur.leafId', '同知识点要按叶子 id 对齐，不能按 topics 文字');
    assertIncludes(appJs, 'q.th2Id === cur.th2Id', '同思路要按思路方法 id 对齐');
    assertNotIncludes(appJs, "API.req('/api/related", '页五已经不再走服务端的 related 接口');
  });

  it('报告页的下一步是"巩固"，不是"迁移"', () => {
    assertIncludes(html, '下一步 · 巩固', '报告页的按钮要指向巩固');
    assertNotIncludes(htmlVisible, '迁移', '第 5 页已经不叫"迁移"了');
  });

  it('答案功能与教师功能在新版里一点入口都不留', () => {
    assertNotIncludes(html, '/api/demo/answer', '不该再有任何给答案的入口');
    assertNotIncludes(html, '/api/teacher', '教师端点已下线，前端不该还引用');
    assertNotIncludes(router, "'/api/teacher/", '服务端不该还留着教师端点');
    assertNotIncludes(router, "'/api/demo/answer'", '服务端不该还留着答案端点');
  });
});

describe('前端 · 密钥与口令不外泄', () => {
  it('.env 里的 Key 与口令不出现在任何交付文件里', () => {
    loadEnvFile();
    const apiKey = String(process.env.LLM_API_KEY ?? '').trim();
    const teacherKey = String(process.env.TEACHER_KEY ?? '').trim();
    /**
     * 拍照识题的 AppCode 也在这条防线里。
     *
     * 为什么必须加进来：它是本轮新增的第三份凭据，而"新增凭据时忘了加进这条检查"
     * 恰恰是这类防线失效的典型方式 —— 防线本身没问题，只是没人记得更新它。
     * 注意它**不能**用 sk- 那个模式兜住：AppCode 是 32 位十六进制，
     * 长得跟 git 短哈希一模一样，只能靠"与 .env 里的真实值逐字比对"来判断。
     */
    const ocrAppCode = String(process.env.ALIYUN_OCR_APPCODE ?? '').trim();

    const files = collectDeliverableFiles(ROOT);
    const hits = [];
    for (const file of files) {
      let content;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (apiKey && content.includes(apiKey)) hits.push(`${relative(ROOT, file)} 含 LLM_API_KEY`);
      if (teacherKey && content.includes(teacherKey)) hits.push(`${relative(ROOT, file)} 含 TEACHER_KEY`);
      if (ocrAppCode && content.includes(ocrAppCode)) hits.push(`${relative(ROOT, file)} 含 ALIYUN_OCR_APPCODE`);
      // 兜底：任何形如 sk-xxxxx（20 位以上）的字面量都不该出现在源码里
      const m = content.match(/sk-[A-Za-z0-9]{20,}/);
      if (m && !file.endsWith('.env')) hits.push(`${relative(ROOT, file)} 含疑似 API Key 字面量 ${m[0].slice(0, 7)}…`);
    }
    assert(hits.length === 0, `密钥/口令出现在不该出现的地方：\n  ${hits.join('\n  ')}`);
  });

  it('阿里云 AccessKey / AppSecret 这类凭据不该出现在仓库里', () => {
    /**
     * 这三类模式的共同点：一旦出现就**几乎一定是真的泄露**，没有良性误报。
     * （32 位十六进制不能这样查 —— 它和 git 短哈希撞脸，会天天误报，
     *   所以 AppCode 走上面那条"与 .env 实际值比对"的路子。）
     */
    const files = collectDeliverableFiles(ROOT);
    const patterns = [
      [/LTAI[0-9A-Za-z]{12,}/, '阿里云 AccessKey ID'],
      [/["']U2[A-Za-z0-9+/=]{28,}["']/, '疑似阿里云 AppSecret'],
    ];
    const hits = [];
    for (const file of files) {
      let content;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const [re, label] of patterns) {
        const m = content.match(re);
        if (m) hits.push(`${relative(ROOT, file)} 含${label}：${m[0].slice(0, 10)}…`);
      }
    }
    assert(hits.length === 0, `疑似云凭据：\n  ${hits.join('\n  ')}`);
  });

  it('.env 本身在 .gitignore 里（否则密钥会被提交）', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    const lines = ignore.split(/\r?\n/).map((l) => l.trim());
    assert(lines.includes('.env'), '.gitignore 必须单独有一行 .env（曾被写成 "注释?.env" 而失效过一次）');
  });

  it('.env.example 里不含真实密钥（它是要提交的）', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    assert(!/sk-[A-Za-z0-9]{20,}/.test(example), '.env.example 不能出现真实 Key');
    for (const line of example.split(/\r?\n/)) {
      if (line.trim().startsWith('TEACHER_KEY=')) {
        assert(line.trim() === 'TEACHER_KEY=', `.env.example 的 TEACHER_KEY 必须留空，实际：${line.trim()}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------

/** 会被提交 / 会被部署 / 会被学生下载到的文件 */
function collectDeliverableFiles(root) {
  const dirs = ['public', 'src', 'api', 'server', 'scripts', 'docs', 'share', 'showcase', 'test', '.github'];
  const rootFiles = ['README.md', 'package.json', 'vercel.json', '.env.example', '.gitignore', 'LICENSE'];
  const out = rootFiles.map((f) => join(root, f));

  for (const dir of dirs) {
    const abs = join(root, dir);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(abs, out);
  }
  return out;
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
}

describe('前端 · 超长题目在框内滚动，而不是把整页拉长', () => {
  /**
   * 需求原话："一个特别长的题目会把整个页面拉的特别长，
   * 我希望这个题目有一个恰当的显示区域，超出的部分可以滑动观看。"
   *
   * 新版把这条做进了结构里：第 3 页左右两栏都是 flex 容器，各自内部是
   * .pane-body.scroller（overflow-y:auto），页面本身不跟着变长。
   * 这与"面板不许 sticky"是两件事：不钉住防遮挡，内部滚动防拉长，两条可以同时成立。
   */
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [null, ''])[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const cssRule = (sel) => {
    const at = style.indexOf(sel + '{');
    if (at < 0) return '';
    const end = style.indexOf('}', at);
    return style.slice(at + sel.length + 1, end);
  };

  it('左右两栏都是内部滚动容器，页面本身不被拉长', () => {
    const start = html.indexOf('<section class="page" data-page="3"');
    const page3 = html.slice(start, html.indexOf('<section class="page" data-page="4"'));
    const scrollerCount = page3.split('scroller').length - 1;
    assert(scrollerCount >= 2, '第 3 页左右两栏都要是滚动容器（.scroller），实际 ' + scrollerCount + ' 处');
    assertIncludes(cssRule('.scroller'), 'overflow-y:auto', '.scroller 必须自己滚动');
    const body = cssRule('.pane-body');
    assertIncludes(body, 'flex:1', '.pane-body 要占满剩余高度');
    assertIncludes(body, 'min-height:0', 'min-height:0 是 flex 子里能出现内部滚动的前提');
  });

  it('不靠 100vh 的 max-height 硬顶高度（旧壳里那套会和页面滚动打架）', () => {
    assert(!/max-height:\s*calc\(100vh/.test(style), '不该再用 100vh 的 max-height 硬顶高度');
  });
});
