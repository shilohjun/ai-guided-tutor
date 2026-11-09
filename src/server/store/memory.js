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

export async function openMemoryStore() {
  const users = new Map();
  const batches = new Map();
  const members = new Map();
  const visits = new Map();
  const sessions = new Map();
  /** 事件只能追加，不更新 —— 数组顺序就是写入顺序 */
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
      // 事件总得挂在某一次会话或某一次打开上，否则它没有归属，落到哪个批次都是猜的
      if (!event?.sessionId && !event?.visitId) throw new Error('事件必须带 sessionId 或 visitId');
      events.push(structuredClone(event));
    },
    async listEventsBySession(sessionId) {
      if (!sessionId) return [];
      return events.filter((e) => e.sessionId === sessionId).map((e) => structuredClone(e));
    },
    async listEventsByBatch(batchId) {
      /**
       * 按归属取，不按 event.batchId 取：事件上的 batchId 可能漏填，
       * 而"这个事件属于哪次会话/哪次打开"是写进去时就确定的事实。
       * file 驱动只能这么算（事件是按 sessionId 分文件存的），两边保持一致。
       */
      const owners = new Set();
      for (const s of sessions.values()) if (s.batchId === batchId) owners.add(s.id);
      for (const v of visits.values()) if (v.batchId === batchId) owners.add(v.id);
      return events
        .filter((e) => owners.has(e.sessionId) || owners.has(e.visitId))
        .map((e) => structuredClone(e))
        .sort(byFields('at'));
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
