/**
 * 导出：zip 写入器与单条会话导出（设计稿 §5.7）。
 *
 * ============================================================================
 * 为什么要自己写 zip，而且要被逐字节钉住
 * ============================================================================
 * ① 运行时依赖必须是 `{}`（产品前提），而 Node 20 的标准库里**没有** zip 写入器。
 *    `zlib.deflateRawSync` 只解决"压缩"，不解决"容器"：中央目录、EOCD、CRC32
 *    仍然得自己写。这一版干脆走 store 模式（不压缩），少一个变量。
 * ② `zlib.crc32` 是 Node 22 才有的。本项目的下限是 Node 20（`package.json engines`），
 *    在 Node 20 上它直接是 `undefined`，而"那台机器"很可能就是学校的电脑。
 *    所以查表自己算，并且**拿已知向量钉住**：`abc` / 空串 / 那句 fox。
 * ③ 导出件是要发给外人打开的。结构错位**不会报错**，只会变成"这个 zip 打不开"，
 *    或者更糟：打得开、但内容是别的条目。所以这里不测"函数返回了一个 Buffer"，
 *    而是按规范把 EOCD → 中央目录 → 本地头走一遍，让三处偏移互相印证
 *    （这也正是真实解压软件的走法：只读本地头看不出中央目录写错了）。
 * ④ 固定的 DOS 时间戳（1980-01-01，时间 0 / 日期 0x0021）是刻意的：同一份会话
 *    导出两次必须**字节相同**。批量导出会被逐版本 diff，"内容一样但字节不同"
 *    会让每一版 diff 全是噪音，最后没人看 diff。
 * ⑤ 条目名要校验（控制者补充 E3）。导出件是给外人打开的，
 *    一条 `../../` 就是事故；**抛错**，不静默跳过。
 *
 * ============================================================================
 * Markdown 为什么强调"只写快照里的东西"
 * ============================================================================
 * 报告快照是学生当时看到的那一份（冻结一次，见 session-store.js 的边界 ③）。
 * 导出只允许写它，不允许回头再算一遍，也不允许把题目对象顺手塞进来 ——
 * 那里面是参考答案与解题路径。下面的用例里放了带答案的"引擎"当诱饵，
 * 就是为了证明导出件不碰它。
 */

import {
  describe,
  it,
  assert,
  assertEquals,
  assertIncludes,
  assertNotIncludes,
} from './runner.js';
import { createZip } from '../src/server/zip.js';
import { renderSessionMarkdown, exportSingle } from '../src/server/export.js';
import { snapshotSession } from '../src/server/session-store.js';

// ---------------------------------------------------------------------------
// 解包：把 zip 按符号表读回来
// ---------------------------------------------------------------------------

const u16 = (buf, at) => buf.readUInt16LE(at);
const u32 = (buf, at) => buf.readUInt32LE(at);

/**
 * EOCD → 中央目录 → 逐条本地头，三处偏移互相核对。
 *
 * 每一步都断言，而不是"尽力解析"：这个函数同时是解包器与结构检查器。
 * 名字长度、CRC、两个大小、本地头偏移在中央目录与本地头之间必须一致 ——
 * 只要有一处写错，这里就会指出是哪一条、哪一项对不上。
 */
function readZip(buf) {
  const eocd = buf.length - 22;
  assertEquals(u32(buf, eocd), 0x06054b50, 'EOCD 签名应当正好在最后 22 字节处');
  const total = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  assertEquals(cdOffset + cdSize, eocd, '中央目录的起点 + 长度必须正好接到 EOCD');

  const entries = [];
  let at = cdOffset;
  for (let i = 0; i < total; i += 1) {
    assertEquals(u32(buf, at), 0x02014b50, `第 ${i + 1} 条中央目录签名`);
    const flags = u16(buf, at + 8);
    const crc = u32(buf, at + 16);
    const size = u32(buf, at + 24);
    const nameLen = u16(buf, at + 28);
    const localAt = u32(buf, at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');

    assertEquals(u32(buf, localAt), 0x04034b50, `${name} 的本地头签名`);
    assertEquals(u16(buf, localAt + 6), flags, `${name} 的通用标志位两处必须一致`);
    assertEquals(u16(buf, localAt + 8), 0, `${name} 必须是 store 模式（不压缩）`);
    assertEquals(u32(buf, localAt + 14), crc, `${name} 的 CRC 两处必须一致`);
    assertEquals(u32(buf, localAt + 18), size, `${name} 的压缩后大小两处必须一致`);
    assertEquals(u32(buf, localAt + 22), size, `${name} 的解压后大小两处必须一致`);
    assertEquals(u16(buf, localAt + 26), nameLen, `${name} 的名字长度两处必须一致`);

    const dataAt = localAt + 30 + nameLen;
    entries.push({ name, flags, crc, data: buf.subarray(dataAt, dataAt + size), localAt });
    at += 46 + nameLen;
  }
  assertEquals(at, cdOffset + cdSize, '中央目录里的条目总长必须等于 EOCD 记录的长度');
  return { total, entries, cdOffset, cdSize };
}

/** 按名字取一条的内容（测试里用得最多的一句话） */
function entryText(buf, name) {
  const found = readZip(buf).entries.find((e) => e.name === name);
  assert(found, `zip 里应当有 ${name}`);
  return found.data.toString('utf8');
}

// ---------------------------------------------------------------------------
// zip 结构
// ---------------------------------------------------------------------------

describe('导出 · zip 结构', () => {
  it('以 PK\\x03\\x04 开头，以 PK\\x05\\x06 结尾', () => {
    const buf = createZip([{ name: 'a.md', data: 'hello' }]);
    assertEquals(buf.subarray(0, 4).toString('binary'), 'PK\x03\x04');
    assertEquals(buf.subarray(-22, -18).toString('binary'), 'PK\x05\x06');
  });

  it('EOCD 里的条目数等于传入的条目数', () => {
    const buf = createZip([
      { name: 'a.md', data: 'x' },
      { name: 'b.json', data: '{}' },
    ]);
    assertEquals(buf.readUInt16LE(buf.length - 12), 2, 'EOCD 中央目录条目数应为 2');
  });

  it('CRC32 与已知值一致（内容是 abc）', () => {
    const buf = createZip([{ name: 'a.txt', data: 'abc' }]);
    assertEquals(buf.readUInt32LE(14), 0x352441c2, 'abc 的 CRC32 是 0x352441C2');
  });

  it('CRC32 的另外三个已知向量也对得上（一条向量证明不了查表是对的）', () => {
    /** 空串、十一位 ASCII、一句 43 字节的英文：覆盖到表里的不同分支 */
    const crcOf = (data) => u32(createZip([{ name: 'a.txt', data }]), 14);
    assertEquals(crcOf(''), 0x00000000, '空内容的 CRC32 是 0');
    assertEquals(crcOf('hello world'), 0x0d4a1185, 'hello world 的 CRC32 是 0x0D4A1185');
    assertEquals(
      crcOf('The quick brown fox jumps over the lazy dog'),
      0x414fa339,
      'fox 那句的 CRC32 是 0x414FA339',
    );
  });

  it('两条条目都完整：名字与内容能从中央目录走回本地头取出来', () => {
    const zip = readZip(
      createZip([
        { name: 'session.md', data: '# 学习记录' },
        { name: 'session.json', data: '{"a":1}' },
      ]),
    );
    assertEquals(zip.total, 2);
    assertEquals(zip.entries.map((e) => e.name).join(','), 'session.md,session.json');
    assertEquals(zip.entries[0].data.toString('utf8'), '# 学习记录');
    assertEquals(zip.entries[1].data.toString('utf8'), '{"a":1}');
    assertEquals(zip.entries[0].localAt, 0, '第一条的本地头应当在文件开头');
    assert(zip.entries[1].localAt > zip.entries[0].localAt, '第二条的本地头应当排在第一条之后');
  });

  it('UTF-8 文件名标志位（bit 11）在本地头与中央目录都置上', () => {
    /** 现在文件名都是 ASCII，但别赌：导出件将来会带中文路径 */
    const buf = createZip([{ name: '报告/第一版.json', data: 'x' }]);
    const { entries } = readZip(buf);
    assertEquals(entries[0].flags, 0x0800, '通用标志位应当只有 bit 11（UTF-8）');
    assertEquals(entries[0].name, '报告/第一版.json', '中文名应当按 UTF-8 写进去、读得回来');
  });

  it('时间戳固定为 1980-01-01（同一输入才能字节相同）', () => {
    const buf = createZip([{ name: 'a.md', data: 'x' }]);
    const { cdOffset } = readZip(buf);
    assertEquals(u16(buf, 10), 0, 'DOS 时间字段应当固定为 0');
    assertEquals(u16(buf, 12), 0x0021, 'DOS 日期字段应当固定为 1980-01-01（0x0021）');
    assertEquals(u16(buf, cdOffset + 12), 0, '中央目录里的时间字段同样固定为 0');
    assertEquals(u16(buf, cdOffset + 14), 0x0021, '中央目录里的日期字段同样是 0x0021');
  });

  it('同一输入两次导出字节完全相同（批量 diff 的前提）', () => {
    const entries = [
      { name: 'session.md', data: '# 标题\n\n正文' },
      { name: 'session.json', data: '{"id":"s1"}' },
    ];
    const a = createZip(entries);
    const b = createZip(entries);
    assert(a.equals(b), '同样的条目必须产出同样的字节');
  });

  it('字符串与 Buffer 两种 data 都收，且按 UTF-8 对齐（CRC 算的是字节）', () => {
    const asText = createZip([{ name: 'a.txt', data: '你好' }]);
    const asBytes = createZip([{ name: 'a.txt', data: Buffer.from('你好', 'utf8') }]);
    assert(asText.equals(asBytes), '字符串应当按 UTF-8 编码后再算 CRC 与大小');
    assertEquals(u32(asText, 22), 6, '"你好" 是 6 个 UTF-8 字节，不是 2');
  });

  it('没有条目时也是一个合法的空 zip（Task 7 的批量导出会用到）', () => {
    const buf = createZip([]);
    assertEquals(buf.length, 22, '空 zip 就只有一条 EOCD');
    const { total } = readZip(buf);
    assertEquals(total, 0);
  });
});

// ---------------------------------------------------------------------------
// zip 条目名校验（E3）
// ---------------------------------------------------------------------------

/**
 * 抛错并返回那个错误。
 *
 * 为什么不用 assertThrows 就够了：占位实现（或任何"整个函数先抛一句未实现"）
 * 也能让 assertThrows 通过 —— 那条用例其实什么都没证明。导出的错误是给
 * 路由层与看日志的人看的，所以这里连**说了什么**一起钉住。
 */
function errorOf(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

describe('导出 · zip 拒绝危险条目名', () => {
  it('拒绝含 .. 的名字，并说清是哪个名字', () => {
    const err = errorOf(() => createZip([{ name: '../../etc/passwd', data: 'x' }]));
    assert(err, '含 .. 的名字必须抛错');
    assertIncludes(err.message, '../../etc/passwd', '错误里应当指出是哪个名字');
  });

  it('拒绝以 / 开头的名字', () => {
    const err = errorOf(() => createZip([{ name: '/abs.md', data: 'x' }]));
    assert(err, '绝对路径必须抛错');
    assertIncludes(err.message, '/abs.md', '错误里应当指出是哪个名字');
  });

  it('拒绝重名（后一条会静默盖掉前一条）', () => {
    const err = errorOf(() =>
      createZip([
        { name: 'a.md', data: '1' },
        { name: 'a.md', data: '2' },
      ]),
    );
    assert(err, '重名必须抛错');
    assertIncludes(err.message, 'a.md');
  });

  it('拒绝空名字', () => {
    for (const name of ['', '   ']) {
      const err = errorOf(() => createZip([{ name, data: 'x' }]));
      assert(err, `名字 ${JSON.stringify(name)} 必须抛错`);
      assertIncludes(err.message, '空', '错误里应当说清是名字为空');
    }
  });

  it('拒绝非字符串名字', () => {
    const err = errorOf(() => createZip([{ name: 42, data: 'x' }]));
    assert(err, '非字符串名字必须抛错');
    assertIncludes(err.message, '字符串', '错误里应当说清名字必须是字符串');
  });

  it('拒绝超过 65535 字节的名字（两字节长度字段装不下，写进去就是坏 zip）', () => {
    const err = errorOf(() => createZip([{ name: `${'长'.repeat(22000)}.md`, data: 'x' }]));
    assert(err, '超长名字必须抛错');
    assertIncludes(err.message, '65535', '错误里应当给出上限');
  });

  it('允许带目录的名字（批量导出的 reports/<id>.json 走这条路）', () => {
    const buf = createZip([{ name: 'reports/s1.json', data: '{}' }]);
    assertEquals(entryText(buf, 'reports/s1.json'), '{}');
  });
});

// ---------------------------------------------------------------------------
// 单条 Markdown
// ---------------------------------------------------------------------------

const SESSION = {
  id: 's1',
  problemId: 'qbank-1',
  startedAt: '2026-11-09T10:00:00.000Z',
  turns: [
    { role: 'student', text: '我先把力分解', at: '2026-11-09T10:01:00.000Z' },
    { role: 'ai', text: '分解之后,哪个方向没有加速度?', level: 1, at: '2026-11-09T10:01:20.000Z' },
  ],
  reportSnapshot: { level: '待巩固', stuckPoints: [], independence: 0.6 },
};

const render = (over = {}) =>
  renderSessionMarkdown({ session: SESSION, user: { displayName: 'S01' }, batch: { label: '第二版' }, ...over });

describe('导出 · 单条 Markdown', () => {
  it('含题目、每轮对话、报告三段', () => {
    const md = renderSessionMarkdown({
      session: SESSION,
      user: { displayName: 'S01' },
      batch: { label: '第二版' },
    });
    assertIncludes(md, 'S01');
    assertIncludes(md, '我先把力分解');
    assertIncludes(md, '分解之后');
    assertIncludes(md, '待巩固');
  });

  it('不含答案与解题路径', () => {
    const md = renderSessionMarkdown({
      session: SESSION,
      user: { displayName: 'S01' },
      batch: { label: '第二版' },
    });
    assertNotIncludes(md, '参考答案');
    assertNotIncludes(md, 'answerFingerprints');
    assertNotIncludes(md, 'solutionGraphs');
  });

  it('引擎里的答案就算挂在会话上，也一个字都进不了导出件', () => {
    /** 活会话是带 engine 的。渲染器只该读显式字段，不能顺手 JSON 化整条会话 */
    const withEngine = {
      ...SESSION,
      engine: { answer: '参考答案：a=2', solutionGraphs: [{ steps: ['先求合力再分解'] }] },
    };
    const md = render({ session: withEngine });
    assertNotIncludes(md, '参考答案');
    assertNotIncludes(md, 'a=2');
    assertNotIncludes(md, '先求合力再分解');
  });

  it('段落顺序固定：标题 → 题目 → 对话 → 报告', () => {
    const md = render();
    const at = (s) => md.indexOf(s);
    assert(at('# 学习记录') >= 0, '应当有一级标题');
    assert(at('## 题目') < at('## 对话'), '题目应当在对话之前');
    assert(at('## 对话') < at('## 报告'), '对话应当在报告之前');
    assert(at('# 学习记录') < at('## 题目'), '标题应当在最前');
  });

  it('标题里写明谁、哪一批、哪道题、何时开始', () => {
    const md = render();
    const head = md.slice(0, md.indexOf('\n## '));
    assertIncludes(head, 'S01');
    assertIncludes(head, '第二版');
    assertIncludes(head, 'qbank-1');
    assertIncludes(head, '2026-11-09T10:00:00.000Z');
  });

  it('对话用相对分钟，不写绝对时间（人读导出件不该换算时区）', () => {
    /** 自己的时间轴：+00 / +02 / +03 各出现一次，才好钉住"从开始算起"这个口径 */
    const clocked = {
      ...SESSION,
      turns: [
        { role: 'student', text: '我先把力分解', at: '2026-11-09T10:00:00.000Z' },
        { role: 'ai', text: '分解之后,哪个方向没有加速度?', level: 1, at: '2026-11-09T10:02:00.000Z' },
        { role: 'student', text: '竖直方向没有', at: '2026-11-09T10:03:00.000Z' },
      ],
    };
    const md = render({ session: clocked });
    assertIncludes(md, '+00 分钟', '第一轮就在开始时刻，应当是 +00');
    assertIncludes(md, '+02 分钟');
    assertIncludes(md, '+03 分钟');
    for (const turn of clocked.turns) {
      /** 开始时刻本身出现在标题里是对的，只查每轮自己的时间 */
      if (turn.at === clocked.startedAt) continue;
      assertNotIncludes(md, turn.at, '每轮对话不该出现绝对时间');
    }
  });

  it('老师的轮次带层级（给了多强的帮助是这个产品最要紧的信息）', () => {
    const md = render();
    assertIncludes(md, '老师');
    assertIncludes(md, 'L1');
  });

  it('某一轮的时间读不出来时写"时间未知"，不许出现 NaN', () => {
    /** 手写/迁移过来的记录可能没有 at。NaN 进了导出件比缺一行更糟 */
    const broken = {
      ...SESSION,
      turns: [{ role: 'student', text: '我先把力分解', at: '不是时间' }],
    };
    const md = render({ session: broken });
    assertIncludes(md, '时间未知');
    assertNotIncludes(md, 'NaN');
    assertNotIncludes(md, 'undefined');
  });

  it('没有报告快照时写明"未到达报告页"，而不是留空', () => {
    const md = renderSessionMarkdown({
      session: { ...SESSION, reportSnapshot: null },
      user: { displayName: 'S01' },
      batch: {},
    });
    assertIncludes(md, '未到达报告页');
  });

  it('报告按 buildReport 的真实形状渲染（层级、独立完成度、卡点）', () => {
    /** 真实快照的 independence 是对象、卡点带 safeStepRef 的 stepTitle —— 用例按真形状走一遍 */
    const snapshot = {
      stuckPoints: [
        {
          stepIndex: 2,
          stepTitle: '第 2 步（条件）',
          kind: 'precondition_gap',
          hintRounds: 2,
          maxLevel: 2,
          misconceptionLabels: ['漏看前提'],
          guardBlocked: 0,
        },
      ],
      independence: { score: 0.5, completedSteps: 3, totalSteps: 6, note: '你独立走过了 3 / 6 个关键步骤。' },
    };
    const md = render({ session: { ...SESSION, reportSnapshot: snapshot } });
    assertIncludes(md, '0.50');
    assertIncludes(md, '第 2 步（条件）');
    assertIncludes(md, '引导 2 轮');
    assertIncludes(md, '最高 L2');
    assertIncludes(md, '漏看前提');
    assertNotIncludes(md, 'precondition_gap', '导出件是给人看的，不写内部枚举名');
  });

  it('报告快照是空对象时也写清一句，不留空白', () => {
    /** 走到报告页但这一版什么都没记下来：留白会被读成"报告丢了"（同 E6 的理由） */
    const md = render({ session: { ...SESSION, reportSnapshot: {} } });
    assertIncludes(md, '报告快照是空的');
  });

  it('用户或批次查不到时写"未知"，不留空也不写 null', () => {
    const md = render({ user: null, batch: null });
    assertIncludes(md, '未知');
    assertIncludes(md, '未知批次');
    assertNotIncludes(md, 'undefined');
    assertNotIncludes(md, 'null');
  });

  it('没有对话时写明还没有对话，而不是留一片空白', () => {
    /** 留白会被读成"记录丢了"，而"只打开没说话"本身是有信息量的一条 */
    const md = render({ session: { ...SESSION, turns: [] } });
    assertIncludes(md, '还没有对话');
  });

  it('段落之间留空行（Markdown 里挨着写会被并成一个块）', () => {
    const md = render();
    assert(/^## /m.test(md), '二级标题应当独占一行');
    assertIncludes(md, '\n\n## 对话', '标题前应当有一个空行');
    assertIncludes(md, '\n\n## 报告', '标题前应当有一个空行');
  });
});

// ---------------------------------------------------------------------------
// 单条 zip（exportSingle）
// ---------------------------------------------------------------------------

const fakeStore = (over = {}) => ({
  async getSession() {
    return { id: 's1', problemId: 'qbank-1', turns: [], reportSnapshot: { level: '掌握' } };
  },
  async getUserById() {
    return { displayName: 'S02' };
  },
  async getBatch() {
    return { label: '第二版' };
  },
  ...over,
});

describe('导出 · 单条 zip', () => {
  it('两条目，且 md 内容是渲染出来的那份', async () => {
    const fake = fakeStore();
    const buf = await exportSingle(fake, 's1');
    assertEquals(buf.readUInt16LE(buf.length - 12), 2);
    assertIncludes(buf.toString('binary'), 'session.md');

    const { entries } = readZip(buf);
    assertEquals(entries.map((e) => e.name).join(','), 'session.md,session.json', '不多不少两份（E7）');
    assertIncludes(entryText(buf, 'session.md'), '掌握');
  });

  it('session.json 就是 snapshotSession 的结果（导出与落库同一份投影）', async () => {
    const session = {
      id: 's1',
      problemId: 'qbank-1',
      turns: [{ role: 'student', text: '我先把力分解', at: '2026-11-09T10:01:00.000Z' }],
      reportSnapshot: { level: '掌握' },
    };
    const buf = await exportSingle(fakeStore({ async getSession() { return session; } }), 's1');
    const parsed = JSON.parse(entryText(buf, 'session.json'));
    assertEquals(
      JSON.stringify(parsed),
      JSON.stringify(snapshotSession(session)),
      'session.json 必须原样是 snapshotSession 的结果',
    );
  });

  it('session.json 里没有引擎（凭据指纹与闭包都不该出现在导出件里）', async () => {
    const session = {
      id: 's1',
      problemId: 'qbank-1',
      turns: [],
      engine: { answerText: '标准答案是 2 m/s', adapterTag: 'llm' },
      adapterTag: 'llm:sk-…',
    };
    const buf = await exportSingle(fakeStore({ async getSession() { return session; } }), 's1');
    const json = entryText(buf, 'session.json');
    assertNotIncludes(json, '标准答案是');
    assertNotIncludes(json, 'engine');
    assertNotIncludes(json, 'sk-');
  });

  it('会话不存在时抛中文错误并带 code（路由层据此回 404，不去猜文案）', async () => {
    const fake = fakeStore({ async getSession() { return null; } });
    let err = null;
    try {
      await exportSingle(fake, 'nope');
    } catch (e) {
      err = e;
    }
    assert(err, '会话不存在必须抛错，不能返回一个空 zip');
    assertEquals(err.message, '无法导出：这条学习记录不存在');
    assertEquals(err.code, 'SESSION_NOT_FOUND');
  });

  it('读库失败不等于"没有这条"：坏库不许报成记录不存在', async () => {
    /**
     * 两者混成同一个答案的后果在 session-store.js 里写过：调用方会当成
     * "新学生第一次说话"，于是现造一条空会话写穿，把库里那份真记录盖掉。
     * 所以这里的 code 必须是"读失败"，不是"不存在"。
     */
    const fake = fakeStore({
      async getSession() {
        throw new Error('磁盘坏了');
      },
    });
    /** 读失败那层会 warn 一次（给运维看）。这里静音，免得测试输出里多一行噪音 */
    const warn = console.warn;
    console.warn = () => {};
    let err = null;
    try {
      await exportSingle(fake, 's1');
    } catch (e) {
      err = e;
    } finally {
      console.warn = warn;
    }
    assert(err, '读库失败必须抛错');
    assertEquals(err.code, 'SESSION_READ_FAILED');
  });

  it('人删了但记录还在：出件，名字写"未知"；批次查不到写"未知批次"', async () => {
    const fake = fakeStore({
      async getUserById() { return null; },
      async getBatch() { return null; },
    });
    const buf = await exportSingle(fake, 's1');
    const md = entryText(buf, 'session.md');
    assertIncludes(md, '未知');
    assertIncludes(md, '未知批次');
    assertEquals(readZip(buf).total, 2, '记录不全也得能出件');
  });

  it('会话没有归属时不白跑两次查询（也不该因为空 id 让驱动抛）', async () => {
    const asked = [];
    const fake = fakeStore({
      async getSession() { return { id: 's1', problemId: 'qbank-1', turns: [], reportSnapshot: null }; },
      async getUserById(id) { asked.push(id); return null; },
      async getBatch(id) { asked.push(id); return null; },
    });
    const buf = await exportSingle(fake, 's1');
    assertEquals(asked.length, 0, '没有 userId / batchId 时不该去查');
    assertIncludes(entryText(buf, 'session.md'), '未到达报告页');
  });
});
