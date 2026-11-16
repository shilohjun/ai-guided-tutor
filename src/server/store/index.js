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
 *   STORE=cloudbase → 云驱动（试点唯一在跑的）。**打开失败一律退回内存**并记一句
 *                     可读的原因：本地与 CI 的 dependencies 是 {}，永远没有云 SDK，
 *                     那不是故障而是预期；真正的故障（缺 TCB_ENV、库连不上）也在同一句日志里。
 *                     宁可降级到"数据只在进程里"，也不让本地开发因为一个云驱动起不来。
 *   其它（含没配）  → memory。没配必须退回内存：现有线上 Demo 一个字节都不该变。
 *
 * ----------------------------------------------------------------------------
 * 两种"没起来"要分得开（都写在 warn 那一行里）
 * ----------------------------------------------------------------------------
 *   ① 缺 SDK（本地、CI）→ 预期之内，不是问题，别去"修"它；
 *   ② 缺 TCB_ENV / 连不上库 → 真问题，部署时没人看日志就等于没有告警。
 * 所以降级日志带的是驱动自己抛出来的那一句中文原因，而不是统一的一句"失败了"。
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
 * @property {(event: object) => Promise<void>} appendEvent  事件原样追加；`seq` 由 events.js 在调用前盖好。只有 `login` 允许没有归属（B7），其余类型缺 sessionId/visitId 即抛
 * @property {(ownerId: string) => Promise<object[]>} listEventsBySession  参数是**归属键**（sessionId 或 visitId），按 seq 升序
 * @property {(batchId: string) => Promise<object[]>} listEventsByBatch  按事件自带的 batchId 过滤（不回查会话），按 seq 升序
 * @property {(key: string, n?: number) => Promise<number>} incrCounter
 * @property {(key: string) => Promise<number>} getCounter
 * @property {() => Promise<void>} close
 */

import { openCloudbaseStore } from './cloudbase.js';
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
  if (kind === 'cloudbase') {
    try {
      return await openCloudbaseStore(config);
    } catch (err) {
      /**
       * 降级到内存，而不是让进程起不来。
       *
       * 理由：①本地与 CI 根本没装云 SDK（dependencies 是 {}），抛错等于"想跑这个
       * 仓库先装一个云依赖"；②真正跑在云函数里时，缺 TCB_ENV 这种配置错也应当让
       * 站点先起来、把原因留在日志里，而不是整个函数 500 —— 那样连健康检查都打不开。
       *
       * 代价写在明处：降级之后数据只在进程内存里，重启即丢。所以这一行 warn 是
       * **唯一**的告警信号，文案必须能被值班的人读懂（原因来自驱动自己抛的那一句）。
       */
      console.warn(`云数据库驱动没起来，退回内存：${err?.message ?? err}`);
      return openMemoryStore();
    }
  }
  return openMemoryStore();
}
