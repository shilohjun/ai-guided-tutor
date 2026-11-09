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
import { mkdtempSync, rmSync } from 'node:fs';
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
