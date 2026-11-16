/**
 * memory 驱动：进程内 Map，进程一退就全丢。
 *
 * ============================================================================
 * 为什么它必须是默认驱动
 * ============================================================================
 * 现在线上跑着的 Demo 是不存数据的。接上存储端口的第一个要求是
 * **"什么都没配时，线上行为一个字节都不变"** —— 所以 `STORE` 没配、
 * 或者配了个手滑的未知值时，一律退回这里，而不是报错拒绝启动。
 * 本地开发、单元测试、Vercel/Workers 上的公网 Demo 都走这一条。
 *
 * ---------------------------------------------------------------------------
 * 为什么读写都做一次结构化克隆
 * ---------------------------------------------------------------------------
 * file 驱动每次读都从磁盘反序列化，拿到的永远是**新的**对象；
 * 如果内存驱动直接把内部那一份递出去，"改一下返回值"这种写法
 * 在内存里生效、在 file 里不生效 —— 这种差异专挑测试环境和线上不一致时才暴露。
 * 两个驱动给出同样的语义，比省这一次克隆重要得多。
 */

/** `login` 是唯一允许没有归属的事件 —— 这条例外只写在 events.js 一处（见 allowsNoOwner） */
import { allowsNoOwner } from '../events.js';

/**
 * 按若干字段升序排，比较用码位而不是 localeCompare。
 *
 * 为什么：localeCompare 的结果取决于运行机器的语言环境，
 * 而 file 驱动是从目录里读文件、顺序本来就不保证 ——
 * 两个驱动必须给出同一个顺序，否则同一份数据在两台机器上导出的 CSV 行序会不同。
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
 * 为什么用 `||` 而不是 `??`：前端在第 1–2 页发事件时会带一个空的 sessionId，
 * 那时候真正的归属是 visitId —— `??` 会选中那个空串，把"有 visitId 的事件"
 * 当成没有归属。这条规则与 `file.js` 的 `ownerKey` 必须逐字一致：
 * 不一致的后果是同一个事件换一个驱动就少一半（见 test/store-equivalence.test.js）。
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
 * 为什么不能只按 `at` 排：同一毫秒里的多条事件在内存驱动里保留写入序、
 * 在 file 驱动里取决于 `readdirSync` 的顺序 —— 同一份数据在两台机器上导出的
 * 行序会不同，而导出件是要给人看的。`seq` 在写的那一刻就把顺序定死了。
 *
 * 后两档（at、归属键）存在的意义是"没有 seq 的老数据也要有确定顺序"：
 * 它们排在有序号的之后，内部按 at、再按归属键。少了这两档，顺序就会
 * 退化成数组/目录的读取序 —— 那正是这个比较器要消掉的东西。
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

export async function openMemoryStore() {
  const users = new Map();
  /** 登录令牌：键是 token 的 sha256，**库里没有明文 token** */
  const tokens = new Map();
  const batches = new Map();
  const members = new Map();
  const visits = new Map();
  const sessions = new Map();
  /** 事件只能追加，不更新 —— 数组顺序就是写入顺序；读取时再按 seq 排（见 byEventOrder） */
  const events = [];
  const counters = new Map();

  /** 取一份拷贝出去；没有就是 null（端口约定：读不到返回 null，不抛） */
  const read = (map, id) => {
    const record = map.get(id);
    return record === undefined ? null : structuredClone(record);
  };

  /** 存进去之前先拷贝：调用方随后改自己手上那个对象，不该改到库里的数据 */
  const write = (map, collection, key, record) => {
    if (key === undefined || key === null || key === '') {
      throw new Error(`写入 ${collection} 的记录缺少键`);
    }
    map.set(key, structuredClone(record));
  };

  return {
    kind: 'memory',

    async getUser(codeHash) {
      if (!codeHash) return null;
      for (const user of users.values()) {
        if (user.codeHash === codeHash) return structuredClone(user);
      }
      return null;
    },
    async getUserById(id) {
      return read(users, id);
    },
    async putUser(user) {
      write(users, 'test_user', user?.id, user);
    },
    async listUsers(batchId) {
      // batches 是数组：同一个人可以同时在多个批次里（见设计稿 §5.1）
      return [...users.values()]
        .filter((u) => (u.batches ?? []).includes(batchId))
        .sort(byFields('displayName', 'id'))
        .map((u) => structuredClone(u));
    },

    async getToken(tokenHash) {
      return read(tokens, tokenHash);
    },
    async putToken(token) {
      write(tokens, 'token', token?.tokenHash, token);
    },

    async getBatch(id) {
      return read(batches, id);
    },
    async putBatch(batch) {
      write(batches, 'batch', batch?.id, batch);
    },

    async addMember(batchId, userId) {
      const key = `${batchId}__${userId}`;
      /**
       * 已经有了就不再加一行：发号脚本会拿同一批人反复跑，
       * "加两次"应当还是一个人，而且不该把首次加入时间冲掉。
       */
      if (members.has(key)) return;
      write(members, 'batch_member', key, { batchId, userId, joinedAt: new Date().toISOString() });
    },
    async listMembers(batchId) {
      return [...members.values()]
        .filter((m) => m.batchId === batchId)
        .sort(byFields('userId'))
        .map((m) => structuredClone(m));
    },

    async getVisit(id) {
      return read(visits, id);
    },
    async putVisit(visit) {
      write(visits, 'visit', visit?.id, visit);
    },

    async getSession(id) {
      return read(sessions, id);
    },
    async putSession(session) {
      write(sessions, 'session', session?.id, session);
    },
    async listSessionsByBatch(batchId) {
      return [...sessions.values()]
        .filter((s) => s.batchId === batchId)
        .sort(byFields('startedAt', 'id'))
        .map((s) => structuredClone(s));
    },
    async listSessionsByUser(userId) {
      return [...sessions.values()]
        .filter((s) => s.userId === userId)
        .sort(byFields('startedAt', 'id'))
        .map((s) => structuredClone(s));
    },

    async appendEvent(event) {
      // 事件总得挂在某一次会话或某一次打开上，否则它没有归属，落到哪个批次都是猜的。
      // 唯一的例外是 login（设计稿 §5.3 的"挂在哪"是 —，见 events.js 的 allowsNoOwner）。
      if (!ownerKey(event) && !allowsNoOwner(event)) throw new Error('事件必须带 sessionId 或 visitId（login 除外）');
      events.push(structuredClone(event));
    },
    /**
     * 按**归属键**取事件 —— 参数不叫 sessionId，因为它可能是 visitId。
     *
     * 与 file 驱动对齐：file 是按归属键分文件存的，传 visitId 自然取得到；
     * 这一版之前内存驱动只比 `e.sessionId`，于是"第 1 页的事件"在内存里查不到。
     * 同一个前端数据换一个驱动就少一半，是这次评审点名的分叉。
     */
    async listEventsBySession(ownerId) {
      if (!ownerId) return [];
      const key = String(ownerId);
      return events
        .filter((e) => ownerKey(e) === key)
        .map((e) => structuredClone(e))
        .sort(byEventOrder);
    },
    /**
     * 按事件**自带的 batchId** 取，不回查会话/访问属于哪个批次。
     *
     * 为什么改掉回查：回查要读两张表（session + visit），两个驱动很容易各读各的
     * —— 事件上的 batchId 是写进去时就确定的事实，直接用它只有一条规则。
     */
    async listEventsByBatch(batchId) {
      if (!batchId) return [];
      return events
        .filter((e) => e.batchId === batchId)
        .map((e) => structuredClone(e))
        .sort(byEventOrder);
    },

    async incrCounter(key, n = 1) {
      if (key === undefined || key === null || key === '') throw new Error('计数器必须带 key');
      const next = Number(counters.get(key) ?? 0) + Number(n);
      counters.set(key, next);
      return next;
    },
    async getCounter(key) {
      return Number(counters.get(key) ?? 0);
    },

    /**
     * 没有需要收尾的东西：数据就在内存里，写入当场生效。
     * 保留这个方法是为了端口三个驱动同签名；重复调用是安全的空操作。
     */
    async close() {},
  };
}
