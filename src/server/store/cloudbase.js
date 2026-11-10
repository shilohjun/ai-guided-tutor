/**
 * cloudbase 驱动：把同一个存储端口落在**腾讯云开发数据库**上（试点唯一在跑的驱动）。
 *
 * ============================================================================
 * 为什么是"懒加载 SDK"而不是"装个依赖"
 * ============================================================================
 * 根 `package.json` 的 `dependencies` 必须是 `{}`：这个仓库要能在企业内网里
 * clone 下来直接 `node server/server.js`。云 SDK 只在**云函数包**里存在
 * （`dist-cloudbase/bubujie-api/package.json`，见 scripts/build-cloudbase.mjs）。
 * 所以这里用 `await import()` 在 `openCloudbaseStore()` 之内取它：
 * 没装的时候抛的是一条能读懂的错，而不是让整个进程在 import 阶段就起不来。
 * 那一抛由 `openStore()` 接住并降级到内存驱动（见 store/index.js）。
 *
 * ============================================================================
 * 三条对齐规则（换驱动只换实现，不换数据的形状）
 * ============================================================================
 * ① **集合名沿用设计稿 §5.2**：test_user / token / batch / batch_member /
 *    visit / session / event / counter。file 驱动的事件目录叫 `events`（复数），
 *    两个驱动各自的命名互不影响 —— 重要的是**逻辑上同一批数据**。
 * ② **排序在 JS 里做，不交给数据库**。byFields / byEventOrder 从 memory.js 与
 *    file.js 逐字抄来（那两处也各自抄了一份）。为什么不合并成一个模块：
 *    它是三个驱动唯一的"同一份语义"契约，合并要看住三个调用点；
 *    抄三份的代价是改一处要改三处，所以这里点名写死"必须逐字一致"。
 *    不去用 orderBy：数据库的排序规则（collation、空值位置、数字与字符串混排）
 *    与码位比较不一定一致，而同一份数据在两个驱动下必须给出同一个行序。
 * ③ **读一律走 where()，不走 doc().get()**。`doc().get()` 在文档不存在时
 *    可能是"抛错"也可能是"空数组"（各版本行为不一致），而端口约定读不到返回
 *    `null` 且不抛 —— 用 `where({id}).limit(1)` 把"不存在"表达成空数组，
 *    一条规则覆盖所有版本。
 *
 * ============================================================================
 * 【未验证】真连上云数据库的那条路
 * ============================================================================
 * 这个仓库里没有、也不会有真环境：测试只能证明"没装 SDK 时安全降级"。
 * 下面用到的 SDK 形状按 @cloudbase/node-sdk v3 的文档写，但**没有一条在真库上跑过**：
 *   · `init({ env })` 拿到 app，`app.database()` 拿到 db，`db.command.inc` / `db.command.neq`
 *   · `collection(x).where(cond).orderBy('_id','asc').skip(n).limit(n).get()` → `{ data: [...] }`
 *   · `collection(x).doc(id).set(record)` 整条覆盖或创建
 *   · `collection(x).doc(id).update({ value: _.inc(n) })` 原子自增
 * 换 SDK 版本或发现行为不符时，**要改的地方全在这一个文件里**：读到的地方是
 * `queryAll` / `queryOne` / `incrCounter` 三个函数，写到的只有 `putRecord`、
 * `appendEvent`、`incrCounter` 三处。别的地方都没有直接碰 SDK。
 */

import { createHash, randomUUID } from 'node:crypto';

/** `login` 是唯一允许没有归属的事件 —— 这条例外只写在 events.js 一处（见 allowsNoOwner） */
import { allowsNoOwner } from '../events.js';

const USERS = 'test_user';
const TOKENS = 'token';
const BATCHES = 'batch';
const MEMBERS = 'batch_member';
const VISITS = 'visit';
const SESSIONS = 'session';
const EVENTS = 'event';
const COUNTERS = 'counter';

/**
 * 一次查询取多少条。
 *
 * 云数据库服务端单次上限是 1000，**取满就必须再翻一页**：试点一批约 7 千条事件
 * （设计稿 §7 的估算），不翻页等于把整批导出静默截断成三分之一 ——
 * 而"导出件里少了几个人"不会报错，比导出失败难发现得多。
 */
const PAGE = 1000;

/**
 * 翻页上限（50 页 = 5 万条）。
 *
 * 为什么要有它：skip 分页在"查询条件恒定 + 数据只追加"的前提下才是安全的，
 * 万一某个版本的云数据库忽略 skip，没有这个上限就是**死循环**（函数超时被掐，
 * 而日志里只有一句网关超时）。到顶宁可抛错 —— 抛错能看见，少数据不能。
 */
const MAX_PAGES = 50;

/**
 * 按若干字段升序排，比较用码位而不是 localeCompare。
 *
 * 与 memory.js / file.js 的同名函数**逐字一致**（原因见文件头规则 ②）。
 */
function byFields(...keys) {
  return (a, b) => {
    for (const key of keys) {
      const x = String(a?.[key] ?? '');
      const y = String(b?.[key] ?? '');
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  };
}

/**
 * 事件的归属键：`sessionId` 非空就用它，否则用 `visitId`。
 *
 * 用 `||` 而不是 `??`：前端在第 1–2 页发事件时会带一个空的 sessionId，
 * 那时候真正的归属是 visitId。与 memory.js / file.js **逐字一致**。
 */
function ownerKey(event) {
  return String(event?.sessionId || event?.visitId || '');
}

/** 事件的全局序号；没有 seq 的老事件返回 null（统一排到有序号的之后） */
function seqOf(event) {
  return typeof event?.seq === 'number' && Number.isFinite(event.seq) ? event.seq : null;
}

/**
 * 事件顺序：seq 升序 → at → 归属键。
 *
 * 与 memory.js / file.js 的同名函数**逐字一致**（原因见文件头规则 ②）。
 * 这里是三个驱动里唯一"数据本来就没有顺序"的一份 —— 数据库不保证返回序，
 * 所以排序这一步在云驱动上是**语义的一部分**，不是优化。
 */
function byEventOrder(a, b) {
  const as = seqOf(a);
  const bs = seqOf(b);
  if (as !== bs) {
    if (as === null) return 1;
    if (bs === null) return -1;
    return as - bs;
  }
  const atA = String(a?.at ?? '');
  const atB = String(b?.at ?? '');
  if (atA !== atB) return atA < atB ? -1 : 1;
  const ownerA = ownerKey(a);
  const ownerB = ownerKey(b);
  if (ownerA !== ownerB) return ownerA < ownerB ? -1 : 1;
  return 0;
}

/**
 * 抹掉存储层的信封字段 `_id`。
 *
 * 为什么必须抹：导出把事件原样写进 `events.jsonl`，而 memory/file 驱动里
 * **没有** `_id` 这个字段。云驱动多带一个 `_id` 的后果是同一批数据换一个驱动
 * 导出的列就不一样了 —— 那种差异只会在对账时才发现。
 * 同时它也是写入前必须去掉的：`_id` 不可修改，原样写回会被服务端拒绝。
 */
function stripId(record) {
  if (!record || typeof record !== 'object') return record;
  const { _id, ...rest } = record;
  return rest;
}

/**
 * 取"一条"。不同版本的 SDK 里 `get()` 的 `data` 可能是数组、也可能是单个对象，
 * 两种都认 —— 这里只想知道"有没有那一条"，不该由版本决定成败。
 */
function firstOf(res) {
  const data = res?.data;
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

/** 取"一批"：同样对 `data` 的两种形状都认 */
function listOf(res) {
  const data = res?.data;
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

/**
 * 计数器那一格的文档 id。
 *
 * 为什么不用计数器键本身做 id：键里带冒号（`ocr:daily:2026-11-09`），
 * 而文档 id 允许的字符集各版本说法不一 —— 自己哈希成 `c_` + 32 位十六进制，
 * 一定合法，而且同一个键永远落在同一个文档上（不需要再靠查询找行）。
 */
function counterDocId(key) {
  return `c_${createHash('sha256').update(String(key)).digest('hex').slice(0, 32)}`;
}

/**
 * 取 SDK。
 *
 * 失败时换一句中文原因：Node 原文是 `ERR_MODULE_NOT_FOUND: Cannot find package
 * '@cloudbase/node-sdk' imported from …`，它会原样出现在 `openStore()` 的降级日志里，
 * 而读到那句英文的人第一反应是"仓库坏了"，实际只是"本地不装云 SDK"这件预期之内的事。
 */
async function loadSdk() {
  try {
    return await import('@cloudbase/node-sdk');
  } catch {
    throw new Error('本地没装 @cloudbase/node-sdk（它只打进 dist-cloudbase 的函数包，本地与 CI 都不装）');
  }
}

/**
 * 打开云开发数据库驱动。
 *
 * @param {object} [env] 配置来源（云函数收到的 env 或 process.env）
 * @returns {Promise<object>} Store 端口（见 store/index.js 的 typedef）
 */
export async function openCloudbaseStore(env = {}) {
  /**
   * 先看配置、再看依赖：缺环境 id 是**配置错**（下一步去填变量），
   * 缺 SDK 是**预期**（本地就是不装）。两种都值得说清，因为下一步动作完全不同。
   */
  const envId = String(env.TCB_ENV ?? '').trim();
  if (!envId) throw new Error('cloudbase 驱动需要 TCB_ENV（云开发环境 id）');

  const { init } = await loadSdk();
  const db = init({ env: envId }).database();
  const command = db.command;

  /**
   * 取一批，自动翻页。
   *
   * `orderBy('_id')` 只为让 skip 分页有稳定的顺序（否则"第 2 页"可能和第 1 页重叠），
   * **业务顺序一律在调用点用 byFields / byEventOrder 重排**（见文件头规则 ②）。
   */
  async function queryAll(collection, where, { keepId = false } = {}) {
    const out = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await db
        .collection(collection)
        .where(where)
        .orderBy('_id', 'asc')
        .skip(page * PAGE)
        .limit(PAGE)
        .get();
      const rows = listOf(res);
      /** keepId 只给"合并两次查询后要去重"的那一处用（见 listEventsBySession） */
      for (const row of rows) out.push(keepId ? row : stripId(row));
      if (rows.length < PAGE) return out;
    }
    throw new Error(`读取 ${collection} 超过 ${MAX_PAGES * PAGE} 条，需要加游标分页（先别拿半份数据去下结论）`);
  }

  /** 取一条；没有就是 null（端口约定：读不到返回 null，不抛） */
  async function queryOne(collection, where) {
    const res = await db.collection(collection).where(where).limit(1).get();
    const row = firstOf(res);
    return row ? stripId(row) : null;
  }

  /**
   * 整条覆盖或创建。
   *
   * 与 memory/file 的"整文件重写"是同一个语义 —— 端口里没有"部分更新"这回事，
   * 所以这里用 `set` 而不是 `update`：update 只改传进去的字段，旧字段会留下来，
   * 于是"把 batches 改成一个"这种写入在云上会变成"两个都在"。
   */
  async function putRecord(collection, key, record) {
    if (key === undefined || key === null || key === '') {
      throw new Error(`写入 ${collection} 的记录缺少键`);
    }
    await db.collection(collection).doc(String(key)).set(stripId(record));
  }

  return {
    kind: 'cloudbase',

    async getUser(codeHash) {
      if (!codeHash) return null;
      return queryOne(USERS, { codeHash: String(codeHash) });
    },
    async getUserById(id) {
      if (id === undefined || id === null || id === '') return null;
      return queryOne(USERS, { id: String(id) });
    },
    async putUser(user) {
      await putRecord(USERS, user?.id, user);
    },
    /**
     * 批次里的所有人。
     *
     * `batches` 是数组（同一个人可以同时在多个批次里），而"数组包含某个值"这件事
     * 在查询层是**各版本说法不一**的（对象形式 / in / all）。所以这里整表取回、
     * 在 JS 里按 `(u.batches ?? []).includes(batchId)` 过滤 —— 判据与 memory/file
     * 逐字相同，试点量级（一批几十人）也就几百条。
     */
    async listUsers(batchId) {
      const all = await queryAll(USERS, { id: command.neq('') });
      return all
        .filter((u) => (u.batches ?? []).includes(batchId))
        .sort(byFields('displayName', 'id'));
    },

    async getToken(tokenHash) {
      if (!tokenHash) return null;
      return queryOne(TOKENS, { tokenHash: String(tokenHash) });
    },
    async putToken(token) {
      await putRecord(TOKENS, token?.tokenHash, token);
    },

    async getBatch(id) {
      if (id === undefined || id === null || id === '') return null;
      return queryOne(BATCHES, { id: String(id) });
    },
    async putBatch(batch) {
      await putRecord(BATCHES, batch?.id, batch);
    },

    async addMember(batchId, userId) {
      /**
       * 已经有了就不再加一行：发号脚本会拿同一批人反复跑，
       * "加两次"应当还是一个人，而且不该把首次加入时间冲掉。
       *
       * 写入也走 putRecord（不直接碰 SDK）：文档 id 用 `<batchId>__<userId>`，
       * 这两个 id 都是我们自己发的（字母、数字、下划线、连字符），天然是合法的文档 id，
       * 而且键相同就意味着重复调用落在同一条上 —— 与 memory/file 同语义。
       */
      if (await queryOne(MEMBERS, { batchId: String(batchId), userId: String(userId) })) return;
      await putRecord(MEMBERS, `${batchId}__${userId}`, { batchId, userId, joinedAt: new Date().toISOString() });
    },
    async listMembers(batchId) {
      const rows = await queryAll(MEMBERS, { batchId: String(batchId) });
      return rows.sort(byFields('userId'));
    },

    async getVisit(id) {
      if (id === undefined || id === null || id === '') return null;
      return queryOne(VISITS, { id: String(id) });
    },
    async putVisit(visit) {
      await putRecord(VISITS, visit?.id, visit);
    },

    async getSession(id) {
      if (id === undefined || id === null || id === '') return null;
      return queryOne(SESSIONS, { id: String(id) });
    },
    async putSession(session) {
      await putRecord(SESSIONS, session?.id, session);
    },
    async listSessionsByBatch(batchId) {
      const rows = await queryAll(SESSIONS, { batchId: String(batchId) });
      return rows.sort(byFields('startedAt', 'id'));
    },
    async listSessionsByUser(userId) {
      const rows = await queryAll(SESSIONS, { userId: String(userId) });
      return rows.sort(byFields('startedAt', 'id'));
    },

    async appendEvent(event) {
      // 事件总得挂在某一次会话或某一次打开上，否则它没有归属，落到哪个批次都是猜的。
      // 唯一的例外是 login（见 events.js 的 allowsNoOwner）。
      if (!ownerKey(event) && !allowsNoOwner(event)) throw new Error('事件必须带 sessionId 或 visitId（login 除外）');
      // 只追加：新事件 = 新文档 id，没有"改事件"这回事
      await db.collection(EVENTS).doc(randomUUID()).set(stripId(event));
    },
    /**
     * 按**归属键**取事件 —— 参数可能是 sessionId，也可能是 visitId。
     *
     * 为什么要查两次再在 JS 里收一遍：端口的口径是 `sessionId || visitId === 键`
     * （见 ownerKey），而"或"在查询层要写成 `_.or([...])` —— 那是**超集**：
     * 一条既带 sessionId 又带 visitId 的事件，按 visitId 查也会被查出来。
     * 所以两次等值查询 + 在 JS 里用同一个 ownerKey 判据收一遍，结果才与
     * memory/file 逐条相同（收这一遍不是保险，是等价性的一部分）。
     */
    async listEventsBySession(ownerId) {
      if (!ownerId) return [];
      const key = String(ownerId);
      const [bySession, byVisit] = await Promise.all([
        queryAll(EVENTS, { sessionId: key }, { keepId: true }),
        queryAll(EVENTS, { visitId: key }, { keepId: true }),
      ]);
      /** 两次查询可能命中同一条（sessionId 与 visitId 恰好相同），按文档 id 去重 */
      const merged = new Map();
      for (const event of [...bySession, ...byVisit]) {
        const id = event?._id ?? JSON.stringify(event);
        if (!merged.has(id)) merged.set(id, event);
      }
      return [...merged.values()]
        .map(stripId)
        .filter((e) => ownerKey(e) === key)
        .sort(byEventOrder);
    },
    /**
     * 按事件**自带的 batchId** 取，不回查会话/访问属于哪个批次。
     * 事件上的 batchId 是写进去时就确定的事实，直接用它只有一条规则。
     */
    async listEventsByBatch(batchId) {
      if (!batchId) return [];
      const rows = await queryAll(EVENTS, { batchId: String(batchId) });
      return rows.sort(byEventOrder);
    },

    /**
     * 原子自增。
     *
     * 为什么不能"读 → 加 → 写回"：两个学生同时拍照时，后写的会把前一个盖掉，
     * 而计数器是额度闸的唯一口径 —— 少记一次就是多花一次钱。
     * 所以已经有这一格时走 `_.inc`（服务端原子自增），只在**第一次**才建行。
     *
     * 已知的窄缝：两个并发的"第一次"可能都看到空、都 set 成 step。
     * 云数据库没有 upsert 原语（`set` 会覆盖、`update` 命中 0 条时回执各版本不同），
     * 为它加一层分布式锁不值得：后果是当日计数少记一次、最多多放行一次。
     * 记在这里，而不是当成没想过。
     */
    async incrCounter(key, n = 1) {
      if (key === undefined || key === null || key === '') throw new Error('计数器必须带 key');
      const step = Number(n);
      const id = counterDocId(key);
      const row = await queryOne(COUNTERS, { key: String(key) });
      if (!row) {
        await db.collection(COUNTERS).doc(id).set({ key: String(key), value: step });
        return step;
      }
      await db.collection(COUNTERS).doc(id).update({ value: command.inc(step) });
      /** 读回真实值：回执里那个数各版本字段名不同，而计数器必须报准数 */
      const after = await queryOne(COUNTERS, { key: String(key) });
      return Number(after?.value ?? 0);
    },
    /**
     * 读计数。
     *
     * 求和而不是取第一条：万一并发首次插入留下两行（见 incrCounter 的窄缝），
     * 求和让读出来的仍然是真实次数，而不是其中一行的那一半。
     */
    async getCounter(key) {
      const rows = await queryAll(COUNTERS, { key: String(key) });
      return rows.reduce((sum, row) => sum + Number(row?.value ?? 0), 0);
    },

    /**
     * 没有需要收尾的东西：每次写都是一次已经完成的请求，没有缓冲区可刷。
     * 保留这个方法是为了端口三个驱动同签名；重复调用是安全的空操作。
     */
    async close() {},
  };
}
