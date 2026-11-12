/**
 * 存储端口的契约测试。
 *
 * ============================================================================
 * 为什么先钉 file 驱动
 * ============================================================================
 * 后面 11 个任务（账号、埋点、续做、度量、导出）都只通过 `openStore()` 读写数据。
 * 端口形状一旦漂移，坏的不是一个功能，而是"每个人的数据各写各的地方"。
 * 所以这里用最苛刻的方式验它：**关掉进程里那一份，重开一个实例再读**。
 * 内存驱动无法通过这种测试 —— 它是这条测试的意义所在。
 *
 * 反过来说，`memory` 是默认驱动（线上 Demo 行为一个字节都不变），
 * 它的价值是"什么都没配时不会崩"，所以只钉两条：没配、配错，都得退回内存。
 */

import { describe, it, assertEquals, assert } from './runner.js';
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/server/store/index.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'bsj-store-')); }
async function fileStore(dir) { return openStore({ STORE: 'file', STORE_DIR: dir }); }

describe('存储 · 驱动选择', () => {
  it('不配置 STORE 时退回 memory（线上行为一个字节都不变）', async () => {
    const s = await openStore({});
    assertEquals(s.kind, 'memory', '没配 STORE 必须退回内存驱动');
  });
  it('配了未知驱动时也退回 memory，而不是抛错', async () => {
    const s = await openStore({ STORE: 'postgres' });
    assertEquals(s.kind, 'memory', '未知驱动应安全退回');
  });
});

describe('存储 · file 驱动落盘', () => {
  it('写入后重开仍能读回会话', async () => {
    const dir = tmp();
    const a = await fileStore(dir);
    await a.putSession({ id: 's1', userId: 'u1', batchId: 'b1', turns: [] });
    await a.close();
    const b = await fileStore(dir);
    const got = await b.getSession('s1');
    assertEquals(got.id, 's1', '重开后应读得到');
    rmSync(dir, { recursive: true, force: true });
  });
  it('事件按 sessionId 取回，且保持写入顺序', async () => {
    const dir = tmp();
    const s = await fileStore(dir);
    for (const t of ['visit_open', 'page_enter', 'chat_send']) {
      await s.appendEvent({ sessionId: 's1', at: '2026-11-09T10:00:00.000Z', type: t, payload: {} });
    }
    const list = await s.listEventsBySession('s1');
    assertEquals(list.map((e) => e.type).join(','), 'visit_open,page_enter,chat_send', '事件顺序必须等于写入顺序');
    rmSync(dir, { recursive: true, force: true });
  });
  it('计数器跨进程累计', async () => {
    const dir = tmp();
    const a = await fileStore(dir);
    assertEquals(await a.incrCounter('ocr:b1', 1), 1);
    await a.close();
    const b = await fileStore(dir);
    assertEquals(await b.incrCounter('ocr:b1', 2), 3, '计数器必须落盘');
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * 令牌集合。
 *
 * 为什么值得单独钉：登录态是唯一"丢了就全员重新登录"的数据。
 * 试点期间学生用的是 6 位数字口令，重新发号意味着要重新在微信里发一遍，
 * 所以令牌必须真的落盘，而不是靠进程还活着。
 */
describe('存储 · 令牌集合', () => {
  it('memory 驱动：按令牌哈希存取，读不到返回 null', async () => {
    const s = await openStore({});
    await s.putToken({ tokenHash: 'h1', userId: 'u1', expiresAt: '2027-01-01T00:00:00.000Z' });
    assertEquals((await s.getToken('h1')).userId, 'u1', '存进去的令牌应能按哈希取回');
    assertEquals(await s.getToken('nope'), null, '没有的令牌必须返回 null，与其它集合一致');
  });
  it('file 驱动：令牌重开实例仍能读回（登录态不能一重启就没了）', async () => {
    const dir = tmp();
    const a = await fileStore(dir);
    await a.putToken({ tokenHash: 'h2', userId: 'u2', expiresAt: '2027-01-01T00:00:00.000Z' });
    await a.close();
    const b = await fileStore(dir);
    assertEquals((await b.getToken('h2')).userId, 'u2', '令牌必须落盘');
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * 事件文件被写坏时，读的一端不能一起死。
 *
 * ============================================================================
 * 为什么这一条是"可用性"而不是"洁癖"
 * ============================================================================
 * 事件是**一行一个、只追加**的 JSONL：`appendFileSync` 写到一半断电、或者盘满了
 * （ENOSPC）时，最后一行就是半截 JSON —— 这不是臆想的场景，是磁盘写满时的标准形状。
 *
 * 原来的实现每行裸 `JSON.parse`，于是**一行坏数据 = 整次读取抛错**。而
 * `listEventsByBatch` 要扫**所有**归属文件，所以它的爆炸半径是"全批次"，
 * 不只那一个学生的那一次打开 —— 导出一份周报会因为某个人的一行残留而彻底打不开。
 *
 * 裁定：跳过读不出来的行、把条数计下来（`console.warn` 留痕），其余事件照旧返回。
 * 内存驱动没有序列化这一步，所以不需要跟着改。
 */
describe('存储 · file 驱动的事件文件被写坏', () => {
  it('有一行被截断时，按归属与按批次都还读得出来，且其余事件仍按 seq 返回', async () => {
    const dir = tmp();
    const s = await fileStore(dir);
    const batchId = 'b-torn';
    const at = '2026-11-09T10:00:00.000Z';
    /** 坏行会打一条 warn，这里收起来：既证明它没有被静默吞掉，又不污染测试输出 */
    const warnings = [];
    const realWarn = console.warn;
    try {
      await s.appendEvent({ sessionId: 's-torn', batchId, at, type: 'page_enter', seq: 1 });
      await s.appendEvent({ sessionId: 's-torn', batchId, at, type: 'page_exit', seq: 2 });

      /**
       * 文件名是**转义过的归属键**，所以按目录找那个 `.jsonl`，不在这里重抄一遍转义规则。
       *
       * 坏行分两种形状，两种都要活得下来：
       *   ① **中间**：半截 JSON 但**带换行**（这一行坏了，前后两行都是完整的）；
       *   ② **末尾**：连换行都没写进去（`appendFileSync` 断电时就是这样）——
       *      此时它后面的写入会接在同一行上，那部分是**真的救不回来**，
       *      但"读一次就抛"必须变成"前面的照样读得出来"。
       */
      const eventsDir = join(dir, 'events');
      const [name] = readdirSync(eventsDir).filter((n) => n.endsWith('.jsonl'));
      const file = join(eventsDir, name);
      appendFileSync(file, '{"type":"chat_se\n', 'utf8');

      /** 坏行**之后**写进去的那条也要读得到：一行坏数据不许把它后面的都截断 */
      await s.appendEvent({ sessionId: 's-torn', batchId, at, type: 'chat_send', seq: 3 });

      console.warn = (...args) => warnings.push(args.join(' '));
      assertEquals(
        (await s.listEventsBySession('s-torn')).map((e) => `${e.seq}:${e.type}`).join(','),
        '1:page_enter,2:page_exit,3:chat_send',
        '按归属读：中间那行坏了，前后两行仍按 seq 返回',
      );
      assertEquals(
        (await s.listEventsByBatch(batchId)).map((e) => `${e.seq}:${e.type}`).join(','),
        '1:page_enter,2:page_exit,3:chat_send',
        '按批次读要扫全部归属文件 —— 它才是最容易被一行坏数据毁掉的那条路',
      );

      /** ② 末尾半截、连换行都没有：读一次不许抛，前面的三条照旧 */
      appendFileSync(file, '{"type":"cha', 'utf8');
      assertEquals(
        (await s.listEventsBySession('s-torn')).map((e) => `${e.seq}:${e.type}`).join(','),
        '1:page_enter,2:page_exit,3:chat_send',
        '末尾的半截行（断电形状）只丢它自己，不许让整次读取抛错',
      );
      assertEquals(
        (await s.listEventsByBatch(batchId)).length,
        3,
        '按批次读同样只丢半截行',
      );

      assert(warnings.length > 0, '坏行必须留下痕迹：静默跳过等于把损坏藏起来');
    } finally {
      console.warn = realWarn;
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
