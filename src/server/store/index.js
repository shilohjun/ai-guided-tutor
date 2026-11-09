/**
 * 存储端口 —— 后面每一个任务都只 import 这个文件，不 import 具体驱动。
 *
 * ============================================================================
 * 为什么要有这一层
 * ============================================================================
 * ① 本地与 CI 不能装云 SDK（这个仓库的运行时依赖是 {}，这是产品前提不是洁癖）；
 * ② 账号、埋点、续做、度量、导出这些逻辑需要一个"能跑在内存里"的存储才测得了；
 * ③ 线上要换驱动（试点只跑 CloudBase）时，改的是这里，不是十几个调用点。
 *
 * ============================================================================
 * 驱动选择规则（写死，不给配置项开新口子）
 * ============================================================================
 *   STORE=file      → file：<STORE_DIR>/<collection>/<id>.json，看得见、拷得走
 *   STORE=cloudbase → 云驱动：**现在调用即抛**。试点只跑 CloudBase，但驱动是 Task 12
 *                     才实现的；这时候静默退回内存，会让"账号写进去了"变成
 *                     一个只有重启后才发现是假的幻觉，宁可当场报错。
 *   其它（含没配）  → memory。没配必须退回内存：现有线上 Demo 一个字节都不该变。
 *
 * @typedef {object} Store
 * @property {'memory'|'file'|'cloudbase'} kind  驱动名（属性，不是方法）
 * @property {(codeHash: string) => Promise<object|null>} getUser
 * @property {(id: string) => Promise<object|null>} getUserById
 * @property {(user: object) => Promise<void>} putUser
 * @property {(batchId: string) => Promise<object[]>} listUsers
 * @property {(tokenHash: string) => Promise<object|null>} getToken
 * @property {(token: object) => Promise<void>} putToken
 * @property {(id: string) => Promise<object|null>} getBatch
 * @property {(batch: object) => Promise<void>} putBatch
 * @property {(batchId: string, userId: string) => Promise<void>} addMember
 * @property {(batchId: string) => Promise<object[]>} listMembers
 * @property {(id: string) => Promise<object|null>} getVisit
 * @property {(visit: object) => Promise<void>} putVisit
 * @property {(id: string) => Promise<object|null>} getSession
 * @property {(session: object) => Promise<void>} putSession
 * @property {(batchId: string) => Promise<object[]>} listSessionsByBatch
 * @property {(userId: string) => Promise<object[]>} listSessionsByUser
 * @property {(event: object) => Promise<void>} appendEvent
 * @property {(sessionId: string) => Promise<object[]>} listEventsBySession
 * @property {(batchId: string) => Promise<object[]>} listEventsByBatch
 * @property {(key: string, n?: number) => Promise<number>} incrCounter
 * @property {(key: string) => Promise<number>} getCounter
 * @property {() => Promise<void>} close
 */

import { openFileStore } from './file.js';
import { openMemoryStore } from './memory.js';

/**
 * 打开一个存储。
 *
 * @param {object} [env] 配置来源（`process.env` 或 CloudBase 函数收到的 env）
 * @returns {Promise<Store>}
 */
export async function openStore(env) {
  const config = env ?? {};
  const kind = String(config.STORE ?? '')
    .trim()
    .toLowerCase();

  if (kind === 'file') return openFileStore(config);
  if (kind === 'cloudbase') throw new Error('cloudbase 驱动在 Task 12 实现');
  return openMemoryStore();
}
