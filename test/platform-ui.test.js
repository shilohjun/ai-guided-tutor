/**
 * 学生端 · 内测准入与学生端埋点（Task 10）。
 *
 * ============================================================================
 * 这个套件守什么
 * ============================================================================
 * 到本任务为止，`public/index.html` 是一个"谁打开谁就能做题"的页面：
 * 没有登录、没有进场说明、没有题单、没有续做。而前七个任务欠下的埋点义务
 * 是**看板与导出件的唯一分母**，欠一条，那一列就恒为 0，且不会报错。
 *
 * 所以这里钉三类东西：
 *   ① **准入契约** —— token 存在 `bsj-token`、只在一处注入请求头、401 回登录屏；
 *   ② **学生端埋点的一半** —— `chat_send` 只能由客户端发（它才知道消息长度与
 *      是否复制题干），`chat_reply` 只能由服务端发（它才知道耗时、层级、抑制）。
 *      两边各发一半，"有 send 无 reply"的一轮失败率才是有意义的数；
 *   ③ **访问记录回填（J6）** —— `session.visitId` 此前恒为 null，`metrics.js` 的
 *      visitId 档是死代码，页 1–2 的停留永远算不出来。这一层用真 HTTP 验：
 *      带 `visitId` 的 `/api/chat` 与 `/api/events` 必须把会话挂回那次打开。
 *
 * 前端那部分只能静态查（本项目零依赖，没有 jsdom）：断言的是一段能被读懂的
 * 契约字符串，而不是"跑一遍点一下"。真正会静默失效的恰恰是这些字符串。
 */

import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, assert, assertEquals, assertIncludes, assertNotIncludes } from './runner.js';
import { ROOT } from '../src/core/env.js';
import { summarizeSessions } from '../src/server/metrics.js';
import { validateEvent } from '../src/server/events.js';
import {
  handleApi,
  getStore,
  requestEnv,
  __resetStoreForTests,
} from '../src/server/router.js';

const html = () => readFileSync(join(ROOT, 'public/index.html'), 'utf8');
const routerSrc = () => readFileSync(join(ROOT, 'src/server/router.js'), 'utf8');

/** 单文件里的所有内联脚本 —— 学生端行为都在这里 */
function appJsOf(source) {
  return [...source.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
}

/** 去掉注释后的脚本：断言"代码里没有"时必须先剥注释，注释里写"这里不发 chat_reply"是正常的 */
function codeOf(source) {
  return appJsOf(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** 页面里唯一那一段内联样式 */
function styleOf(source) {
  return (source.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
}

/** 去掉注释与 style/script 之后学生真正看得到的文本 */
function visibleOf(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '');
}

/** 取一条 CSS 规则的声明体（只认首层；重名时取第一处） */
function ruleBody(css, selector) {
  const at = css.indexOf(selector + '{');
  if (at < 0) return '';
  const end = css.indexOf('}', at);
  return css.slice(at + selector.length + 1, end);
}

// ===========================================================================
// 1. 计划里逐字给出的四条契约
// ===========================================================================

describe('学生端 · 平台契约', () => {
  it('仍然只有四页（防止有人把第五页加回来）', () => {
    const s = html();
    assertIncludes(s, "var PAGES = ['题目', '方式', '解题', '报告']");
  });

  it('token 存在 bsj-token，且请求会带上 x-test-token', () => {
    const s = html();
    assertIncludes(s, "'bsj-token'");
    assertIncludes(s, 'x-test-token');
  });

  it('登录、开场说明、题单条、续做条四个入口都在', () => {
    const s = html();
    for (const k of ['login', 'intro', 'question-list', 'resume-bar']) {
      assertIncludes(s, `data-testid="${k}"`, `缺入口 ${k}`);
    }
  });

  it('埋点走 keepalive，且不因失败抛错', () => {
    const s = html();
    assertIncludes(s, 'keepalive');
    assertIncludes(s, '/api/events');
  });
});

// ===========================================================================
// 2. 准入（J1/J2）
// ===========================================================================

describe('学生端 · 准入（J1/J2）', () => {
  const source = html();
  const js = appJsOf(source);

  it('x-test-token 只在 API.req 这一处注入（每个调用点各写一次是必然漏的那种）', () => {
    const hits = [...source.matchAll(/x-test-token/g)].length;
    assertEquals(hits, 1, `x-test-token 应当只出现一次（唯一注入点），实际 ${hits} 次`);
    const reqAt = js.indexOf('req: function (path, opt)');
    const tokenAt = js.indexOf("headers['x-test-token']");
    assert(reqAt >= 0 && tokenAt > reqAt, '注入必须发生在 API.req 里，而不是各个调用点');
  });

  it('未登录时主干不可操作：body 带 data-locked，样式把主干藏起来', () => {
    const locked = (source.match(/<body([^>]*)>/) || [, ''])[1];
    assertIncludes(locked, 'data-locked="1"', '首屏默认锁住 —— 否则会先闪一下可操作的界面再弹登录');
    const css = styleOf(source);
    assertIncludes(css, 'body[data-locked="1"]', '锁住这件事必须真的有一套样式，而不是只有一个属性');
    assertIncludes(css, '#app', '被藏起来的应当是主干 #app');
  });

  it('401 → 清账号态并回登录屏，不自动重试', () => {
    assertIncludes(js, 'res.status === 401', '任何接口的 401 都要走同一条收尾');
    assertIncludes(js, 'function authLost(', '缺少"登录失效"的唯一收尾函数');
    assertIncludes(js, 'function clearAccount(', '缺少清账号态的函数');
    assertIncludes(js, '登录过期了，请重新输入口令', '这句话是给学生看的唯一解释');
    assertIncludes(js, 'sessionStorage.removeItem', 'visitId 也要一起清，否则下一次打开还挂在上一个人头上');
    assertNotIncludes(js, 'location.reload', '401 不许自动刷新重试（会变成连环请求）');
    assertNotIncludes(js, 'document.body.innerHTML', '不许用整页重写来"回登录屏"');
  });

  it('登录成功后 token / 代号 / 批次都落盘，且批次随键名走', () => {
    assertIncludes(js, 'AUTH.token', '身份要有一个内存投影，而不是每次现读 localStorage');
    for (const key of ["'bsj-token'", "'bsj-name'", "'bsj-batch'"]) {
      assertIncludes(js, key, `缺少登录态键 ${key}`);
    }
    assertIncludes(js, 'function saveAuth(', '登录成功要把身份落到 localStorage');
  });

  it('账号级缓存键带 displayName + batchId（一台机器上换个人不能看到上一个人的状态）', () => {
    assertIncludes(js, 'function acctKey(kind)', '缺少账号级键构造器');
    assertIncludes(js, "'bsj-' + kind + '-' + (AUTH.name || 'anon') + '-' + (AUTH.batch || 'nobatch')", '键里必须同时带代号与批次');
    assertIncludes(js, "acctKey('intro')", '开场说明按 displayName + batchId 记');
    assertIncludes(js, "acctKey('progress')", '题单进度按 displayName + batchId 记');
  });
});

// ===========================================================================
// 3. 开场说明（J3）
// ===========================================================================

describe('学生端 · 开场说明（J3）', () => {
  const source = html();
  const js = appJsOf(source);

  it('文案固定：三件事一次说清，题数取批次题单长度，拿不到写"几"', () => {
    assertIncludes(source, '这是步步解的内测。这一轮有', '开场说明的第一句是固定文案');
    assertIncludes(
      source,
      '道题，大概 15–25 分钟，可以分两次做；下次回来点『继续刚才那道题』就行。',
      '后半句也是固定文案（15–25 分钟与"分两次做"是产品的原话）',
    );
    assertIncludes(source, 'id="introCount"', '题数要有一个可替换的位置');
    assertIncludes(js, "|| '几'", '拿不到题单时写「几」，不许编一个数');
    assertIncludes(js, "acctKey('intro')", '见过一次就不再显示（按代号 + 批次记）');
    assertIncludes(source, 'id="introGo"', '「开始」按钮是唯一进第 1 页的入口');
  });

  it('说明屏自身记为 p0，第 1 页才是 page_enter{page:1}', () => {
    assertIncludes(js, 'pageEnter(0)', '说明屏的停留记 page: 0 —— 它不是第 1 页');
    assertIncludes(js, 'pageEnter(1)', '点「开始」之后才进第 1 页');
    assertIncludes(js, '{ page: page }', 'page_enter / page_exit 的 payload 必须带页号（第 7 个任务要的数）');
    assertIncludes(js, 'via: via', 'page_exit 必须说清"怎么离开的"');
  });
});

// ===========================================================================
// 4. 题单条与续做条（J4/J5）
// ===========================================================================

describe('学生端 · 题单条（J4）', () => {
  const source = html();
  const js = appJsOf(source);

  it('题单条写着「第 N 道 / 共 M 道」，题数来自批次记录', () => {
    assertIncludes(source, 'data-testid="question-list"');
    assertIncludes(js, "'第 ' + (QLIST.index + 1) + ' 道 / 共 ' + n + ' 道'", '题单条的位置文案');
    assertIncludes(js, 'd.questionIds', '题单从 /api/visit 的响应带下来（服务端那半边在 J6）');
    assertIncludes(source, 'id="qlistNext"', '题单条上要有「下一道」');
  });

  it('批次没配题单时不许报错：写一句话并把「下一道」置灰', () => {
    assertIncludes(js, '老师还没配题单，先随便挑一道', '空题单要说清楚现在能做什么');
    assertIncludes(js, 'next.disabled = true', '空题单时「下一道」置灰，而不是点了才报错');
  });

  it('题号落在账号级键里，刷新后不丢', () => {
    assertIncludes(js, 'function saveProgressIndex(', '题号要落盘');
    assertIncludes(js, 'acctKey(\'progress\')', '落盘键按代号 + 批次分开');
    assertIncludes(js, 'localStorage.getItem(progressStoreKey())', '刷新后从同一个键读回来');
  });
});

describe('学生端 · 续做条（J5）', () => {
  const source = html();
  const js = codeOf(source);

  it('文案是「继续刚才那道题 · N 天前 · 停在页 N」', () => {
    assertIncludes(source, 'data-testid="resume-bar"');
    assertIncludes(js, "'继续刚才那道题 · '", '续做条的固定开头');
    assertIncludes(js, "' · 停在页 '", '要写明停在哪一页');
    assertIncludes(js, 'idleText(', 'idleMinutes 要翻成人话');
  });

  it('idleMinutes 三档人话：分钟 / 小时 / 天', () => {
    assertIncludes(js, "' 分钟前'");
    assertIncludes(js, "' 小时前'");
    assertIncludes(js, "' 天前'");
    assertIncludes(js, 'm < 60', '一小时以内写分钟');
    assertIncludes(js, 'm < 24 * 60', '一天以内写小时');
  });

  it('没有可续做的会话时整条不显示（不是显示"没有"）', () => {
    assertIncludes(js, 'bar.hidden = true', '没有会话就藏起来');
    assertNotIncludes(visibleOf(source), '没有可续做', '不要用一句话占位');
    assertIncludes(js, "API.req('/api/session/resume')", '续做信息只能来自服务端（身份在令牌里）');
  });

  it('点续做条：接着原来那条会话回到第 3 页（服务端的层级不归零）', () => {
    assertIncludes(js, 'function openResume(', '缺少恢复入口');
    assertIncludes(js, 'S.sessionId = rec.id', '恢复要接着原来那条会话，否则服务端的层级会被当成新人');
    assertIncludes(js, 'S.resumed = true', '恢复要标出来（聊天区那行提示据此显示）');
    /**
     * 设计稿 §5.5 要求恢复记 `resume_click`，但 `src/server/events.js` 的字典里
     * **没有这一种**（14 种 = 设计稿 §5.3 的 13 种 + practice_pick）。
     * 发出去只会被 `validateEvent` 以 unknown_type 拒掉：页面看起来发了、库里一条没有。
     * 所以这里钉的是"不许假发"；字典补上第 15 种时，这条要改成正面的 emit 断言
     * （服务端那半边有一条 `resume_click 今天会被拒` 的用例盯着这件事）。
     */
    assertNotIncludes(js, "'resume_click'", 'resume_click 不在事件字典里，发出去只会被静默拒掉');
  });
});

// ===========================================================================
// 5. 埋点分工（J7/J8）
// ===========================================================================

describe('学生端 · 埋点分工（J7）', () => {
  const source = html();
  const js = codeOf(source);
  const server = routerSrc().replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');

  it('客户端只发一半：不发 chat_reply；服务端不发 chat_send', () => {
    assertNotIncludes(js, 'chat_reply', 'chat_reply 只有服务端算得出来（耗时 / 层级 / 抑制），客户端绝不能发');
    assertNotIncludes(server, "'chat_send'", '服务端不许发 chat_send —— 那会让一轮失败率的分母翻倍');
    assertIncludes(server, "'chat_reply'", '服务端必须发 chat_reply');
  });

  it('chat_send 在请求发出之前就先发出去（页面被杀也要留下证据）', () => {
    const sendAt = js.indexOf("'chat_send'");
    const chatAt = js.indexOf('API.chat(');
    assert(sendAt > 0, '找不到 chat_send 的发点');
    assert(chatAt > 0, '找不到 /api/chat 的调用点');
    assert(sendAt < chatAt, 'chat_send 必须先于 /api/chat 发出 —— 反过来的话超时/被杀的那一轮就没有证据了');
    assertIncludes(js, 'len: text.length', 'chat_send 要带消息长度（导出件的"首条消息字数"读它）');
    assertIncludes(js, 'copiedStem:', 'chat_send 要带 copiedStem（认真度粗筛）');
  });

  it('copiedStem 只发布尔：去掉空白、标点与〔式〕，长度门槛 8，相似度 0.8', () => {
    assertIncludes(js, 'function copiedStem(');
    assertIncludes(js, 'function stemNorm(');
    assertIncludes(js, ".replace(/〔式〕/g, '')", '公式占位符必须先去掉（题库题的纯文本里到处是它）');
    assertIncludes(js, '< 8', '首条不足 8 个字不算"复制题干"');
    assertIncludes(js, '> 0.8', '相似度门槛照设计稿 §5.3：0.8');
    assertNotIncludes(js, 'payload: { text', '埋点里不许出现题目或对话内容，只许布尔');
  });

  it('page_enter / page_exit 只在页真的变化时发', () => {
    assertIncludes(js, 'var changed = n !== S.page;', '页号没变就不该记一次进出');
    assertIncludes(js, 'if (changed) pageExit(', '离开前一页时才记 page_exit');
    assertIncludes(js, 'if (changed) pageEnter(', '进入新页时才记 page_enter');
    assertIncludes(js, "pageExit(n > S.page ? 'next' : 'back')", 'via 要能分清前进与后退');
  });

  it('客户端其余事件一个不少：入场 / 题单 / OCR / 读题 / 再练', () => {
    for (const type of [
      'visit_open',
      'login',
      'batch_open',
      'intake_choose',
      'ocr_call',
      'ocr_result',
      'import_result',
      'practice_pick',
    ]) {
      assertIncludes(js, `'${type}'`, `缺少客户端事件 ${type}`);
    }
    assertIncludes(js, 'questionCount', 'visit_open 要带题数');
    assertIncludes(js, "path: 'qbank'", '入场方式 qbank');
    assertIncludes(js, "path: 'paste'", '入场方式 paste');
    assertIncludes(js, "path: 'photo'", '入场方式 photo');
    assertIncludes(js, 'warningCount', 'import_result 要带警告数');
    assertIncludes(js, 'problemId: res.problem.id', 'practice_pick 要带题号');
  });

  it('埋点失败静默，且离开页面时 flush 一次', () => {
    assertIncludes(js, "addEventListener('visibilitychange'", '页面切到后台时要 flush 队列');
    assertIncludes(js, "document.visibilityState === 'hidden'", '只有 hidden 才 flush');
    assertIncludes(js, "keepalive: true", 'flush 必须 keepalive —— 页面正在被关掉');
    assertIncludes(js, 'T.flush()', 'flush 要有调用点');
    assertIncludes(js, '.catch(function () {})', '埋点失败不许抛出、不许打扰学生');
  });
});

// ===========================================================================
// 6. 375px（J10）
// ===========================================================================

describe('学生端 · 375px 不溢出（J10）', () => {
  const source = html();
  const css = styleOf(source);

  it('四个新块没有写死超过 375 的宽度，长文本能自己收住', () => {
    for (const selector of ['.lock', '.lock-card', '.qbar', '.resume']) {
      const body = ruleBody(css, selector);
      assert(body !== '', `找不到 ${selector} 的样式 —— 新块必须有一份自己的规则`);
      const fixed = [...body.matchAll(/(?:^|[^-])width:\s*(\d+)px/g)].map((m) => Number(m[1]));
      for (const px of fixed) {
        assert(px <= 375, `${selector} 写死了 ${px}px 宽 —— 375px 屏上会横向溢出`);
      }
    }
    assertIncludes(ruleBody(css, '.qbar'), 'flex-wrap:wrap', '题单条要能折行，否则窄屏挤成一条');
    assertIncludes(ruleBody(css, '.qbar-pos'), 'min-width:0', '省略号的前提是子项可以收缩');
    assertIncludes(ruleBody(css, '.resume'), 'flex-wrap:wrap', '续做条同理');
    assertIncludes(ruleBody(css, '.lock-card'), 'box-sizing:border-box', '内边距不能撑破卡片');
  });

  it('新块有一条窄屏规则，且既有的小屏规则一个字没动', () => {
    const media = (css.match(/@media\(max-width:600px\)\{([\s\S]*?)\n\}/) || [, ''])[1];
    assertIncludes(media, '.lock', '窄屏要收窄登录卡的内边距');
    assertIncludes(media, '.qbar', '窄屏要收题单条');
    assertIncludes(media, '.resume', '窄屏要收续做条');
    assertIncludes(css, '.set{\n    top:auto', 'settings.test.js 钉住的小屏抽屉规则必须原样还在');
  });
});

// ===========================================================================
// 7. 服务端那一半（J6：visitId 回填 + /api/visit 的 questionIds + chat_reply）
// ===========================================================================

const P1 = 'phy-emi-01';
const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

/** 起一个真 HTTP 服务，STORE 指到临时目录（模式照抄 session-persist.test.js） */
async function withRouterServer(fn) {
  const { createServer } = await import('node:http');
  const dir = mkdtempSync(join(tmpdir(), 'bsj-pui-http-'));
  const env = { ...process.env, STORE: 'file', STORE_DIR: dir };
  delete env.LLM_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.PILOT_REQUIRE_LOGIN;

  __resetStoreForTests();
  const store = await requestEnv.run(env, () => getStore());

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const handled = await requestEnv.run(env, () => handleApi(req, res, url));
    if (!handled) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'not handled' }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, store, env });
  } finally {
    await new Promise((r) => server.close(r));
    __resetStoreForTests();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function call(base, path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** 发一个号并登录（批次由调用方给，题单要提前写进批次记录） */
async function signIn(store, batchId) {
  const { issueAccounts, login } = await import('../src/server/auth.js');
  const batch = `b-${Math.random().toString(36).slice(2, 8)}`;
  const [account] = await issueAccounts(store, { batchId: batchId ?? batch, count: 1 });
  const session = await login(store, account.code);
  assert(session?.token, '发号后应当能登录拿到令牌');
  return { token: session.token, user: session.user, batchId: session.batchId };
}

/** 聊一轮（与前端调用同一个接口） */
function chat(base, { sessionId, visitId, utterance = '我想用安培力，但是不知道力怎么求', headers = {} }) {
  const body = { sessionId, problemId: P1, utterance, mode: 'self_training', explicitHelpSeeking: true };
  if (visitId !== undefined) body.visitId = visitId;
  return call(base, '/api/chat', { method: 'POST', body, headers });
}

describe('访问记录回填（J6）', () => {
  it('/api/visit 把该批次的题单一起带下来（J4 的数据源）', async () => {
    await withRouterServer(async ({ base, store }) => {
      const batchId = uid('batch');
      const me = await signIn(store, batchId);

      /** 还没配题单：诚实回一个空数组，不许报错 */
      const empty = await call(base, '/api/visit', {
        method: 'POST',
        body: {},
        headers: { 'x-test-token': me.token },
      });
      assertEquals(empty.status, 200);
      assertEquals(Array.isArray(empty.json.questionIds), true, 'questionIds 必须是数组');
      assertEquals(empty.json.questionIds.length, 0, '批次没配题单时是空数组');

      /** 配了题单：原样带下来 */
      await store.putBatch({ id: batchId, questionIds: [P1, 'phy-emi-02'] });
      const withList = await call(base, '/api/visit', {
        method: 'POST',
        body: {},
        headers: { 'x-test-token': me.token },
      });
      assertEquals(withList.json.questionIds.join(','), `${P1},phy-emi-02`);
    });
  });

  it('/api/chat 带 visitId → session.visitId 落库，且 sessionId 追加到 visit.sessionIds（去重）', async () => {
    await withRouterServer(async ({ base, store }) => {
      const me = await signIn(store);
      const visit = await call(base, '/api/visit', {
        method: 'POST',
        body: {},
        headers: { 'x-test-token': me.token },
      });
      const visitId = visit.json.visitId;

      const sessionId = uid('chat');
      const first = await chat(base, { sessionId, visitId, headers: { 'x-test-token': me.token } });
      assertEquals(first.status, 200, `离线桩下聊天应 200，实际 ${first.status} ${JSON.stringify(first.json)}`);

      const stored = await store.getSession(sessionId);
      assert(stored, '会话应当已经落库');
      assertEquals(stored.visitId, visitId, 'session.visitId 此前恒为 null —— 这一格必须真的写进去');

      const linked = await store.getVisit(visitId);
      assertEquals(linked.sessionIds.join(','), sessionId, '这次打开里做过哪些会话，靠这个数组对账');

      /** 第二轮：同一对 (visit, session) 不许重复追加 */
      await chat(base, { sessionId, visitId, utterance: '我还是不知道合力怎么算', headers: { 'x-test-token': me.token } });
      const again = await store.getVisit(visitId);
      assertEquals(again.sessionIds.length, 1, 'visit.sessionIds 要去重');
    });
  });

  it('不带 visitId 时什么都不做（老客户端与测试不受影响）', async () => {
    await withRouterServer(async ({ base, store }) => {
      const sessionId = uid('plain');
      const res = await chat(base, { sessionId });
      assertEquals(res.status, 200);
      const stored = await store.getSession(sessionId);
      assertEquals(stored.visitId, null, '没带 visitId 就不该凭空写一个');
    });
  });

  it('/api/events 带 visitId 也能回填（学生没开口就离开页面时，只有埋点这条路）', async () => {
    await withRouterServer(async ({ base, store }) => {
      const me = await signIn(store);
      const sessionId = uid('evt');
      /** 先在**没有** visitId 的情况下建会话（模拟"落地那次 visit 丢了"） */
      assertEquals((await chat(base, { sessionId, headers: { 'x-test-token': me.token } })).status, 200);
      assertEquals((await store.getSession(sessionId)).visitId, null, '前提：会话还没有 visitId');

      const visit = await call(base, '/api/visit', {
        method: 'POST',
        body: {},
        headers: { 'x-test-token': me.token },
      });
      const visitId = visit.json.visitId;

      const res = await call(base, '/api/events', {
        method: 'POST',
        headers: { 'x-test-token': me.token },
        body: { events: [{ type: 'page_enter', payload: { page: 3 }, sessionId, visitId }] },
      });
      assertEquals(res.status, 200);
      assertEquals(res.json.accepted, 1, `埋点应当被收下：${JSON.stringify(res.json)}`);

      assertEquals((await store.getSession(sessionId)).visitId, visitId, '埋点这条路也要把会话挂回这次打开');
      assertEquals((await store.getVisit(visitId)).sessionIds.join(','), sessionId);
    });
  });
});

describe('服务端那一半的埋点（J7）', () => {
  it('resume_click 今天会被字典拒掉 —— 这条用例是那个缺口的哨兵', () => {
    /**
     * 设计稿 §5.5 要求"恢复要记 resume_click"，而 `events.js` 的 14 种里没有它
     * （Task 7 之后字典被 `test/events.test.js` 逐条钉死，本任务无权扩）。
     * 这条用**纯函数**把现状写下来：谁把字典补上第 15 种，它会立刻变红，
     * 逼着同一次提交里把前端那条 emit 一起补上 —— 而不是让埋点永远静默丢失。
     */
    const verdict = validateEvent({ type: 'resume_click', at: '2026-11-09T10:00:00.000Z', sessionId: 's1' });
    assertEquals(verdict.ok, false, '如果字典已经支持 resume_click，把前端那条 emit 补上，并改掉这条断言');
    assertEquals(verdict.reason, 'unknown_type', '被拒的原因是"字典里没有这一种"，不是归属或体积');
  });

  it('/api/chat 成功后写一条 chat_reply：五个字段、带 seq、带归属与批次', async () => {
    await withRouterServer(async ({ base, store }) => {
      const me = await signIn(store);
      const sessionId = uid('reply');
      const res = await chat(base, { sessionId, headers: { 'x-test-token': me.token } });
      assertEquals(res.status, 200);

      const events = await store.listEventsBySession(sessionId);
      const replies = events.filter((e) => e.type === 'chat_reply');
      assertEquals(replies.length, 1, `一轮对话应当正好一条 chat_reply，实际 ${replies.length} 条`);

      const reply = replies[0];
      assertEquals(
        Object.keys(reply.payload).sort().join(','),
        'engine,level,ms,stuckKind,suppressed',
        'chat_reply 的 payload 就是设计稿 §5.3 那五个字段',
      );
      assertEquals(typeof reply.payload.ms, 'number', 'ms 是延迟，必须是数字');
      assert(Number.isFinite(reply.payload.ms), 'ms 必须是有限数');
      assertEquals(typeof reply.payload.level, 'number', 'level 是这一轮的提示层级');
      assertEquals(reply.payload.suppressed, false, 'suppressed 是布尔，不许写成字符串');
      assertEquals(typeof reply.payload.engine, 'string', 'engine 要说清这一轮是谁答的');
      assertEquals(typeof reply.seq, 'number', 'seq 是事件定序的唯一依据（recordEvent 盖的）');
      assertEquals(reply.sessionId, sessionId, '归属必须挂在 sessionId 上');
      assertEquals(reply.batchId, me.batchId, 'batchId 缺了的话看板与整批导出都读不到它');
      assert(typeof reply.at === 'string' && reply.at.length === 24, 'at 必须是服务端生成的 ISO 时间');

      /** 批次维度的读入口也要看得见它 —— 否则"写进去了"只是写在没人读的地方 */
      const byBatch = await store.listEventsByBatch(me.batchId);
      assert(
        byBatch.some((e) => e.type === 'chat_reply' && e.sessionId === sessionId),
        'chat_reply 必须能被 listEventsByBatch 读到',
      );
    });
  });

  it('一轮失败率的分母只数客户端那一半：send 之后有 reply 就是 0', async () => {
    await withRouterServer(async ({ base, store }) => {
      const me = await signIn(store);
      const sessionId = uid('turn');
      const headers = { 'x-test-token': me.token };

      /** 客户端那一半（前端在发 /api/chat 之前先发它） */
      const sent = await call(base, '/api/events', {
        method: 'POST',
        headers,
        body: { events: [{ type: 'chat_send', payload: { len: 18, copiedStem: false }, sessionId }] },
      });
      assertEquals(sent.json.accepted, 1);

      assertEquals((await chat(base, { sessionId, headers })).status, 200);

      const events = await store.listEventsBySession(sessionId);
      const sends = events.filter((e) => e.type === 'chat_send');
      const replies = events.filter((e) => e.type === 'chat_reply');
      assertEquals(sends.length, 1, 'chat_send 只有客户端发那一条（服务端再发一次就会翻倍）');
      assertEquals(replies.length, 1);
      assert(sends[0].seq < replies[0].seq, 'send 必须先落库，否则配对不上');

      const summary = summarizeSessions([{ id: sessionId, problemId: P1, events }], null, Date.now());
      assertEquals(summary.turnFailureRate, 0, '一轮有 send 有 reply：失败率必须是 0');
    });
  });
});
