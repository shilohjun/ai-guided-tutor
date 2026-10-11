/**
 * 前端契约与保密测试。
 *
 * 这个套件守的是两类"只有在浏览器里才会炸"的问题 ——
 * 而它们恰恰是最容易漏测的，因为它们不属于引擎逻辑：
 *
 *   ① **DOM 契约**：app.js 里 $('  #xxx  ') 引用的每个 id，index.html 里必须真的存在。
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
import { teacherMode, checkTeacherAuth } from '../src/server/router.js';

const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
const appJs = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
/** 去掉 HTML 注释后的版本 —— 注释里写"这里不放防泄题面板"是正常的，学生看不到注释 */
const htmlVisible = html.replace(/<!--[\s\S]*?-->/g, '');

/** index.html 里声明的所有 id */
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
  'chat-empty', // renderEmptyState() 每次重建消息区时创建
  'btn-goto-chat-2', // loadReport() 的空状态里创建
  'btn-run-eval', // renderTeacherEval() 的模板里创建
  'eval-result', // 同上，评测结果的容器
  'toast', // toast() 首次调用时创建
  'kg-wrap', // renderAnalysis() 的解析面板里创建，知识图谱的挂载点
  'kg-wrap-teacher', // renderTeacherProblem() 的教师解析区里创建
  'kg-detail', // renderKnowledgeGraph() 内部创建，点节点后的详情气泡
  'teacher-path', // renderTeacherSession() 的"路径进度"卡里创建
  'teacher-path-track', // renderPathList() 内部创建，教师版路径轨道
]);

describe('前端 · DOM 契约（防止"点了没反应"）', () => {
  it('app.js 引用的每个 id 都存在于 index.html（或是有意动态创建的）', () => {
    const declared = htmlIds();
    const missing = [];
    for (const [id, count] of referencedIds()) {
      if (declared.has(id) || DYNAMIC_IDS.has(id)) continue;
      missing.push(`${id}（引用 ${count} 次）`);
    }
    assert(missing.length === 0, `以下 id 在 index.html 里不存在，运行时会静默失效：\n  ${missing.join('\n  ')}`);
  });

  it('学生视图不含任何"防泄题 / 教研"面板（那些内容不该出现在学生面前）', () => {
    // 说明：教师视图的容器允许存在（它是一个独立页面、且服务端会拦数据），
    // 但学生对话页里不允许再出现"守卫拦截/防泄题"这类工程内控面板。
    const start = htmlVisible.indexOf('id="page-chat"');
    const end = htmlVisible.indexOf('id="page-report"');
    assert(start > 0 && end > start, '页面锚点应存在');
    const chatSection = htmlVisible.slice(start, end);
    assertNotIncludes(chatSection, '防泄题', '学生对话页不应出现"防泄题"面板');
    assertNotIncludes(chatSection, '守卫拦截', '学生对话页不应出现"守卫拦截"统计');
    assertNotIncludes(chatSection, '答案泄漏', '学生对话页不应出现"答案泄漏"字样');
  });

  it('学生页与教师页是两个独立页面，学生页不内嵌教研数据容器', () => {
    assertIncludes(html, 'id="page-teacher"', '教师视图必须是独立页面');
    assertIncludes(html, 'id="teacher-key"', '教师视图必须有口令入口');
    // 教师口令绝不能写死在页面里
    assertNotIncludes(html, 'TEACHER_KEY=', '口令不能写进 HTML');
  });
});

describe('视图隔离 · 教师端点鉴权（三种形态）', () => {
  const save = { key: process.env.TEACHER_KEY, lock: process.env.DSH_FORCE_TEACHER_LOCK };
  const restore = () => {
    if (save.key === undefined) delete process.env.TEACHER_KEY;
    else process.env.TEACHER_KEY = save.key;
    if (save.lock === undefined) delete process.env.DSH_FORCE_TEACHER_LOCK;
    else process.env.DSH_FORCE_TEACHER_LOCK = save.lock;
  };
  const req = (key) => ({ headers: key ? { 'x-teacher-key': key } : {} });
  const url = new URL('http://localhost/api/teacher/overview');

  it('本地未配口令 ⇒ open：不带口令也能进（演示时"点一下直接进"）', () => {
    process.env.TEACHER_KEY = '';
    delete process.env.DSH_FORCE_TEACHER_LOCK;
    assertEquals(teacherMode(), 'open', '本地默认应为开放模式');
    assert(checkTeacherAuth(req(), url).ok, 'open 模式下不带口令应放行');
    restore();
  });

  it('配了口令 ⇒ key：不带口令 401，带对口令放行', () => {
    process.env.TEACHER_KEY = 'unit-test-key';
    delete process.env.DSH_FORCE_TEACHER_LOCK;
    assertEquals(teacherMode(), 'key');
    const denied = checkTeacherAuth(req(), url);
    assert(!denied.ok && denied.status === 401, `不带口令应 401，实际 ${JSON.stringify(denied)}`);
    const wrong = checkTeacherAuth(req('nope'), url);
    assert(!wrong.ok && wrong.status === 401, '错口令应 401');
    assert(checkTeacherAuth(req('unit-test-key'), url).ok, '对口令应放行');
    restore();
  });

  it('公网形态（强制锁死）⇒ off：即使没配口令也一律 403', () => {
    process.env.TEACHER_KEY = '';
    process.env.DSH_FORCE_TEACHER_LOCK = '1';
    assertEquals(teacherMode(), 'off', '公网部署应锁死教师视图');
    const denied = checkTeacherAuth(req(), url);
    assert(!denied.ok && denied.status === 403, `应 403，实际 ${JSON.stringify(denied)}`);
    assert(
      String(denied.hint ?? '').includes('TEACHER_KEY'),
      '拒绝时要说清怎么才能开 —— 否则线上没人知道该配什么',
    );
    restore();
  });

  it('公网形态但配了口令 ⇒ 回到 key 模式（留一条正经的开放路径）', () => {
    process.env.TEACHER_KEY = 'unit-test-key';
    process.env.DSH_FORCE_TEACHER_LOCK = '1';
    assertEquals(teacherMode(), 'key', '配了口令应回到口令模式，而不是继续锁死');
    assert(checkTeacherAuth(req('unit-test-key'), url).ok);
    restore();
  });

  it('api/index.js 会在没有口令时强制锁死（这条是"部署时忘了配"的唯一防线）', () => {
    const apiEntry = readFileSync(join(ROOT, 'api/index.js'), 'utf8');
    assertIncludes(apiEntry, 'DSH_FORCE_TEACHER_LOCK', '公网入口必须显式锁死教师视图');
    assertIncludes(apiEntry, 'TEACHER_KEY', '锁死逻辑必须给"配了口令"留出口');
  });
});

describe('前端 · 布局不许出现"钉住的面板遮挡内容"', () => {
  /**
   * 反馈过的真实问题："向下浏览时，右侧那一栏固定住了，压住下面的内容"。
   *
   * 根因是侧栏同时用了 `position: sticky` + `max-height: calc(100vh-…)` + 内部 `overflow` ——
   * 这个组合会产生"钉住的面板盖住后续内容"的观感，而钉住本身只是个锦上添花的效果。
   * 去掉之后整页按普通文档流滚动，遮挡在结构上就不可能发生。
   *
   * 这条断言防的是"以后有人觉得侧栏跟着滚很酷，又把它改回 sticky"。
   */
  it('只有顶栏允许 sticky，侧栏一律普通文档流', () => {
    const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8');
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const stickyBlocks = [];
    // 抓 "选择器 { ... position: sticky ... }" 这种块
    for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/position:\s*sticky/.test(m[2])) stickyBlocks.push(m[1].trim().split(/\s+/).join(' '));
    }
    const offenders = stickyBlocks.filter((sel) => !sel.includes('.topbar'));
    assert(
      offenders.length === 0,
      `除 .topbar 外不应有 sticky 元素（会导致面板遮挡内容）：\n  ${offenders.join('\n  ')}`,
    );
    assert(stickyBlocks.some((s) => s.includes('.topbar')), '顶栏应该保留 sticky —— 那是它该有的行为');
  });

  it('侧栏不再用 max-height + overflow 自己滚（那会和页面滚动打架）', () => {
    const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const sel of ['.study-panel', '.side-panel', '.study-body']) {
      const m = css.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`));
      if (!m) continue;
      const body = m[1];
      assert(!/max-height:\s*calc\(100vh/.test(body), `${sel} 不应再有 100vh 的 max-height`);
      assert(!/overflow:\s*auto/.test(body), `${sel} 不应再是内部滚动容器`);
    }
  });
});

describe('前端 · 文案不会被当成纯文本显示', () => {
  /**
   * 在 HTML / JS 模板字符串里写 `**加粗**` 不会生效，只会把星号原样显示出来。
   *
   * 这个坑我自己踩过一次：模式卡下面那句"两种模式**都不会**给你答案"
   * 在页面上就是带着星号的样子 —— 截图里一眼能看到。
   * 同一份文档习惯（Markdown）被带进了渲染层，改起来只要一处，但很容易再犯。
   */
  it('index.html 的可见文本里没有 Markdown 星号', () => {
    const hits = htmlVisible
      .split(/\r?\n/)
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter((x) => x.line.includes('**'));
    assert(hits.length === 0, `index.html 有 Markdown 星号会被原样显示：\n  ${hits.map((h) => `${h.no}: ${h.line.slice(0, 80)}`).join('\n  ')}`);
  });

  it('app.js 的渲染模板里没有 Markdown 星号（注释不算）', () => {
    const code = appJs
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    const hits = code
      .split(/\r?\n/)
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter((x) => x.line.includes('**'));
    assert(hits.length === 0, `app.js 渲染模板里还有 Markdown 星号：\n  ${hits.map((h) => `${h.no}: ${h.line.slice(0, 80)}`).join('\n  ')}`);
  });
});

describe('前端 · 陪伴模式的两个控件必须同步', () => {
  /**
   * 首页有一对模式卡、对话页有一个模式开关，两者共用 state.mode。
   *
   * 这是典型的"同一份状态两个控件"场景，也是最容易出现
   * "首页显示自主训练、对话页显示学伴陪伴"这种自相矛盾状态的地方 ——
   * 而且它不会报错，只会让用户觉得这个产品不可信。
   */
  it('两个控件都存在，且都覆盖两种模式', () => {
    const cardModes = [...html.matchAll(/class="mode-card[^"]*"\s+data-mode="([^"]+)"/g)].map((m) => m[1]);
    const switchModes = [...html.matchAll(/class="seg-btn[^"]*"\s+data-mode="([^"]+)"/g)].map((m) => m[1]);
    for (const m of ['self_training', 'ai_companion']) {
      assert(cardModes.includes(m), `首页模式卡缺少 ${m}`);
      assert(switchModes.includes(m), `对话页模式开关缺少 ${m}`);
    }
    assertEquals(cardModes.length, 2, '首页模式卡应恰好两张（多一张就说明有别的元素蹭了 data-mode）');
  });

  it('setMode() 同时更新两个控件（改单边就会漂移）', () => {
    const fn = appJs.slice(appJs.indexOf('function setMode('), appJs.indexOf('function setMode(') + 900);
    assertIncludes(fn, '#mode-switch', 'setMode 必须更新对话页开关');
    assertIncludes(fn, '#mode-cards', 'setMode 必须更新首页模式卡，否则两处会显示不同的模式');
  });

  it('模式卡讲的是"什么时候开口"，而引擎确实按这套规则执行', () => {
    // 卡片里必须出现"求助"这个触发条件 —— 它是自主训练模式下唯一的主动开口理由之一
    const picker = htmlVisible.slice(htmlVisible.indexOf('id="mode-cards"'), htmlVisible.indexOf('id="mode-cards"') + 1600);
    assertIncludes(picker, '卡住', '模式卡要说清"你求助时我会出声"这个触发条件');
    // 引擎侧对应的规则由 route.test.js 覆盖（self_training + 未求助 ⇒ 静默）
  });
});

describe('前端 · 密钥与口令不外泄', () => {
  it('.env 里的 Key 与口令不出现在任何交付文件里', () => {
    loadEnvFile();
    const apiKey = String(process.env.LLM_API_KEY ?? '').trim();
    const teacherKey = String(process.env.TEACHER_KEY ?? '').trim();

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
      // 兜底：任何形如 sk-xxxxx（20 位以上）的字面量都不该出现在源码里
      const m = content.match(/sk-[A-Za-z0-9]{20,}/);
      if (m && !file.endsWith('.env')) hits.push(`${relative(ROOT, file)} 含疑似 API Key 字面量 ${m[0].slice(0, 7)}…`);
    }
    assert(hits.length === 0, `密钥/口令出现在不该出现的地方：\n  ${hits.join('\n  ')}`);
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

describe('前端 · 超长题目要在框内滚动，而不是把整页拉长', () => {
  /**
   * 需求原话："一个特别长的题目会把整个页面拉的特别长，
   * 我希望这个题目有一个恰当的显示区域，超出的部分可以滑动观看。"
   *
   * 注意这与"面板不许 sticky"是两件不同的事，别混：
   *   面板：普通文档流（不钉住、不设 100vh 上限）—— 防遮挡
   *   题干：有边界的阅读区（内部滚动）—— 防页面被拉长
   * 两者可以同时成立，下面的断言把这两条边界都钉住。
   */
  const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('题干有高度上限，并且是它自己在滚动', () => {
    const m = css.match(/\.stem\s*\{([^}]*)\}/);
    assert(m, '应当有 .stem 规则');
    const body = m[1];
    assert(/max-height:\s*min\(/.test(body), `.stem 必须有 max-height（当前：${body}）`);
    assert(/overflow-y:\s*auto/.test(body), '.stem 必须是自己的滚动容器');
  });

  it('上限取得保守：不会矮到把中等长度的题也塞进滚动框', () => {
    const m = css.match(/\.stem\s*\{([^}]*)\}/);
    const vh = Number((m[1].match(/min\((\d+)vh/) ?? [])[1]);
    assert(vh >= 30 && vh <= 60, `46vh 左右比较合适，当前 ${vh}vh`);
  });

  it('"还有内容"的提示只在真的被截断时出现（由 JS 判定，不靠 CSS 猜）', () => {
    assertIncludes(appJs, 'enhanceStemBoxes', '应有溢出检测函数');
    const fn = appJs.slice(appJs.indexOf('function enhanceStemBoxes'));
    assertIncludes(fn.slice(0, 1200), 'scrollHeight - stem.clientHeight', '必须按真实溢出量判断');
    assertIncludes(fn.slice(0, 1200), 'hint.hidden = !overflow', '没溢出就必须把提示收起来');
  });

  it('溢出测量必须发生在页面可见之后（隐藏时 clientHeight 为 0）', () => {
    /**
     * 踩到的坑：selectProblem 的顺序是 applyProblemToChat → showPage('page-chat')，
     * 而 applyProblemToChat 里就调了测量函数 —— 那时页面还是 display:none，
     * clientHeight 为 0，函数按"量不出来就不判断"提前返回，
     * 于是长题目的滚动提示**永远不出现**（截图里验证过）。
     *
     * 所以测量入口必须挂在页面切换的必经之路上。
     */
    const showPageFn = appJs.slice(appJs.indexOf('function showPage('), appJs.indexOf('function showPage(') + 1200);
    assertIncludes(showPageFn, 'enhanceStemBoxes', 'showPage 里必须有测量入口');
    assertIncludes(showPageFn, 'requestAnimationFrame', '要等一帧让布局落定再量');
    const fn = appJs.slice(appJs.indexOf('function enhanceStemBoxes'), appJs.indexOf('function enhanceStemBoxes') + 900);
    assertIncludes(fn, 'if (!stem.clientHeight) return', '隐藏状态下必须跳过，不能误判成"没有溢出"');
  });
  it('面板本身仍然不许 sticky（两条边界不能互相打架）', () => {
    for (const sel of ['.study-panel', '.side-panel']) {
      const m = css.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`));
      if (!m) continue;
      assert(!/position:\s*sticky/.test(m[1]), `${sel} 不该为了题干滚动又改回 sticky`);
    }
  });
});