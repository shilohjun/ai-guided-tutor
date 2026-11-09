/**
 * file 驱动：把数据写成一颗看得见、拷得走的目录树。
 *
 * ============================================================================
 * 为什么要它
 * ============================================================================
 * 内存驱动一重启就没了，试点期间"昨天那几个学生做到哪了"就没法回答；
 * 而本地和 CI 又装不了云 SDK（零运行时依赖）。file 驱动填的是中间这一档：
 * 不用装任何东西，`ls .data/` 就能看见数据，出问题直接拷目录发给别人复现。
 *
 * 落盘形状（集合名沿用设计稿 §5.2，Task 12 搬到 CloudBase 时集合名要对得上）：
 *
 *   <STORE_DIR>/test_user/<id>.json
 *   <STORE_DIR>/token/<tokenHash>.json               键是 token 的 sha256，不是 token
 *   <STORE_DIR>/batch/<id>.json
 *   <STORE_DIR>/batch_member/<batchId>__<userId>.json
 *   <STORE_DIR>/visit/<id>.json
 *   <STORE_DIR>/session/<id>.json
 *   <STORE_DIR>/events/<sessionId 或 visitId>.jsonl   一行一个事件，只追加
 *   <STORE_DIR>/events/_no-owner/events.jsonl         唯一没有归属的事件（login）
 *   <STORE_DIR>/counter/<key>.json
 *
 * ---------------------------------------------------------------------------
 * 两条硬规矩
 * ---------------------------------------------------------------------------
 * ① **不缓存**。每次读都读盘，每次写都整文件重写。
 *    所以同一进程里开两个实例指向同一目录，看到的就是同一份数据 ——
 *    测试就是靠"关掉 a、重开 b 再读"来证明数据真的落了盘。
 *    反过来，如果"有了就跳过写"那种优化被加进来，第二次写入就会静默丢掉。
 *
 * ② **写之前先 mkdir -p**。集合目录是第一次写入时才出现的；
 *    store 打开时整个 STORE_DIR 可能都不存在（测试给的就是空临时目录），
 *    不能指望它已经在那儿。
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** `login` 是唯一允许没有归属的事件 —— 这条例外只写在 events.js 一处（见 allowsNoOwner） */
import { allowsNoOwner } from '../events.js';

const USERS = 'test_user';
const TOKENS = 'token';
const BATCHES = 'batch';
const MEMBERS = 'batch_member';
const VISITS = 'visit';
const SESSIONS = 'session';
const EVENTS = 'events';
const COUNTERS = 'counter';

/**
 * 按若干字段升序排，比较用码位而不是 localeCompare。
 *
 * 为什么：localeCompare 的结果取决于运行机器的语言环境，
 * 而目录里读出来的文件顺序本来就不保证 —— 两个驱动必须给出同一个顺序，
 * 否则同一份数据在两台机器上导出的 CSV 行序会不同。
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
 * 事件的归属键：`sessionId` 非空就用它，否则用 `visitId`（排序与过滤都按它）。
 * 写入时由 `appendEvent` 检查它（缺归属且不是 login 就抛），读取与排序用这个（不抛）。
 * 与 memory.js 的 `ownerKey` 必须逐字一致：不一致的后果是同一个事件
 * 换一个驱动就少一半（见 test/store-equivalence.test.js 的文件头）。
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
 * 退化成目录的读取序 —— 那正是这个比较器要消掉的东西。
 * 与 memory.js 的同名逻辑必须逐字一致。
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
 * id / 计数器键 → 安全文件名。
 *
 * 为什么需要转义：
 *   - 计数器键里有冒号（`ocr:daily:2026-11-09`），冒号在 Windows 上根本不能做文件名；
 *   - id 有一部分来自前端（会话 id 是前端造的），带 `/` 或 `..` 时会写到 STORE_DIR 之外。
 * 正常的 id（字母、数字、`-`、`_`）转义后原样不变，所以目录看起来还是人读的样子。
 */
function nameOf(id) {
  return encodeURIComponent(String(id));
}

export async function openFileStore(env = {}) {
  /** 相对路径按进程工作目录解析：配置里写的 `.data` 就是"在当前目录下" */
  const root = resolve(env.STORE_DIR || '.data');

  /** 读不到返回 null；文件在但内容坏了就让它抛 —— 静默当空会把损坏藏起来 */
  function readJson(file) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  function readRecord(collection, key) {
    if (key === undefined || key === null || key === '') return null;
    return readJson(join(root, collection, `${nameOf(key)}.json`));
  }

  /**
   * 把一个集合整个读出来。
   *
   * 为什么不拿文件名还原 id：文件名是转义过的，而真相在文件内容里 ——
   * 读内容既省一次解码，也不会因为"文件名没转义"读出错误的 id。
   */
  function readAll(collection) {
    let names;
    try {
      names = readdirSync(join(root, collection));
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = readJson(join(root, collection, name));
      if (record) out.push(record);
    }
    return out;
  }

  /** 整文件重写 + 先建目录：短文件一次写完，比"边写边追加"少一半出错的机会 */
  function writeRecord(collection, key, record) {
    if (key === undefined || key === null || key === '') {
      throw new Error(`写入 ${collection} 的记录缺少键`);
    }
    const file = join(root, collection, `${nameOf(key)}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  function eventsFile(owner) {
    return join(root, EVENTS, `${nameOf(owner)}.jsonl`);
  }

  /**
   * 没有归属的事件落这里（目前只有 login）。
   *
   * 为什么用子目录而不是 `events/_no-owner.jsonl`：归属文件名是
   * `events/<encodeURIComponent(owner)>.jsonl`，如果某个真实 sessionId 恰好
   * 叫 `_no-owner`，两者就会写进同一个文件、互相混进对方的查询结果。
   * 子目录名永远不可能等于一个 `.jsonl` 文件名，从结构上排除了这个碰撞。
   */
  function unownedEventsFile() {
    return join(root, EVENTS, '_no-owner', 'events.jsonl');
  }

  function readEventFile(file) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
    return text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }

  function readEventLines(owner) {
    return readEventFile(eventsFile(owner));
  }

  /**
   * 把**所有**归属的事件读出来。
   *
   * 为什么需要它：`listEventsByBatch` 改成按事件自带的 batchId 过滤之后，
   * 就没法再"先查出批次里的 session/visit，再按名字读文件"了 —— 事件是散在
   * 各个归属文件里的，只能全量扫一遍。试点量级（一个班几十人、几节课）
   * 完全吃得下；Task 12 搬到 CloudBase 上时这是一次带索引的查询。
   */
  function readAllEvents() {
    let names;
    try {
      names = readdirSync(join(root, EVENTS));
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      /** 逐条 push 而不是 `out.push(...lines)`：展开一个几万行的数组会撞上调用栈参数上限 */
      for (const event of readEventFile(join(root, EVENTS, name))) out.push(event);
    }
    /** 没有归属的事件（唯一例外是 login）也要算进来，否则按批次查会漏掉它们 */
    for (const event of readEventFile(unownedEventsFile())) out.push(event);
    return out;
  }

  function counterFile(key) {
    return join(root, COUNTERS, `${nameOf(key)}.json`);
  }

  return {
    kind: 'file',

    async getUser(codeHash) {
      if (!codeHash) return null;
      for (const user of readAll(USERS)) {
        if (user.codeHash === codeHash) return user;
      }
      return null;
    },
    async getUserById(id) {
      return readRecord(USERS, id);
    },
    async putUser(user) {
      writeRecord(USERS, user?.id, user);
    },
    async listUsers(batchId) {
      // batches 是数组：同一个人可以同时在多个批次里（见设计稿 §5.1）
      return readAll(USERS)
        .filter((u) => (u.batches ?? []).includes(batchId))
        .sort(byFields('displayName', 'id'));
    },

    async getToken(tokenHash) {
      return readRecord(TOKENS, tokenHash);
    },
    async putToken(token) {
      // 键是 sha256 的十六进制串，本身就适合做文件名（见 nameOf 的注释）
      writeRecord(TOKENS, token?.tokenHash, token);
    },

    async getBatch(id) {
      return readRecord(BATCHES, id);
    },
    async putBatch(batch) {
      writeRecord(BATCHES, batch?.id, batch);
    },

    async addMember(batchId, userId) {
      const key = `${batchId}__${userId}`;
      /**
       * 已经有了就不再加一行：发号脚本会拿同一批人反复跑，
       * "加两次"应当还是一个人，而且不该把首次加入时间冲掉。
       */
      if (readRecord(MEMBERS, key)) return;
      writeRecord(MEMBERS, key, { batchId, userId, joinedAt: new Date().toISOString() });
    },
    async listMembers(batchId) {
      return readAll(MEMBERS)
        .filter((m) => m.batchId === batchId)
        .sort(byFields('userId'));
    },

    async getVisit(id) {
      return readRecord(VISITS, id);
    },
    async putVisit(visit) {
      writeRecord(VISITS, visit?.id, visit);
    },

    async getSession(id) {
      return readRecord(SESSIONS, id);
    },
    async putSession(session) {
      writeRecord(SESSIONS, session?.id, session);
    },
    async listSessionsByBatch(batchId) {
      return readAll(SESSIONS)
        .filter((s) => s.batchId === batchId)
        .sort(byFields('startedAt', 'id'));
    },
    async listSessionsByUser(userId) {
      return readAll(SESSIONS)
        .filter((s) => s.userId === userId)
        .sort(byFields('startedAt', 'id'));
    },

    async appendEvent(event) {
      /**
       * 事件挂在哪：一次会话或一次打开。两者都没有就没有地方可落 ——
       * 唯一例外是 login（设计稿 §5.3 的"挂在哪"是 —，见 events.js 的 allowsNoOwner）。
       * 用 `||` 而不是 `??`（见 ownerKey）：空的 sessionId 要让位给 visitId。
       */
      const owner = ownerKey(event);
      if (!owner && !allowsNoOwner(event)) throw new Error('事件必须带 sessionId 或 visitId（login 除外）');
      const file = owner ? eventsFile(owner) : unownedEventsFile();
      mkdirSync(dirname(file), { recursive: true });
      // 一行一个，只追加：这条链路上没有"改事件"这回事
      appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
    },
    /**
     * 按**归属键**取事件 —— 参数不叫 sessionId，因为它可能是 visitId。
     * 文件名就是归属键（见 eventsFile），所以传 visitId 天然取得到。
     * 仍然要排序：行序是写入序，而写入序不等于 seq 序（并发时可能颠倒）。
     */
    async listEventsBySession(ownerId) {
      if (!ownerId) return [];
      return readEventLines(ownerId).sort(byEventOrder);
    },
    /**
     * 按事件**自带的 batchId** 取，不回查会话/访问属于哪个批次。
     *
     * 为什么改掉回查：回查要读两张表（session + visit），两个驱动很容易各读各的
     * —— 事件上的 batchId 是写进去时就确定的事实，直接用它只有一条规则。
     */
    async listEventsByBatch(batchId) {
      if (!batchId) return [];
      return readAllEvents()
        .filter((e) => e.batchId === batchId)
        .sort(byEventOrder);
    },

    async incrCounter(key, n = 1) {
      if (key === undefined || key === null || key === '') throw new Error('计数器必须带 key');
      const file = counterFile(key);
      // 原键存在值里，文件名只是转义后的名字 —— 读回来不依赖文件名
      const next = Number(readJson(file)?.value ?? 0) + Number(n);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ key: String(key), value: next }, null, 2)}\n`, 'utf8');
      return next;
    },
    async getCounter(key) {
      return Number(readJson(counterFile(key))?.value ?? 0);
    },

    /**
     * 没有需要收尾的东西：每次写都当场落盘，没有缓冲区可刷。
     * 保留这个方法是为了端口三个驱动同签名；重复调用是安全的空操作。
     */
    async close() {},
  };
}
