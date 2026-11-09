/**
 * 测试账号：发号、口令校验、登录令牌与失败限速。
 *
 * ============================================================================
 * 三个必须先讲清楚的取舍
 * ============================================================================
 * ① **口令哈希是确定性的（sha256 + 胡椒），不是每用户随机盐。**
 *    存储端口里查人的唯一入口是 `getUser(codeHash)` —— 学生只记得 6 位数字，
 *    没有 code 以外的任何标识可以拿来定位「他是谁」。若每人一个随机盐，
 *    服务端就必须先拿到这个人的盐才能算，而它拿不到，于是永远查不到人。
 *    所以：`codeHash = sha256(PEPPER + ':' + code)`，同一口令永远同一个串。
 *
 *    代价要说透：确定性哈希 + 6 位数字（100 万种）意味着**拿到库就能全量枚举**，
 *    唯一的防线是胡椒（`PILOT_CODE_PEPPER`，只存在环境变量里，不进数据库）。
 *    胡椒泄露 = 全班口令泄露，它必须和库分开保管。
 *
 * ② **令牌只存 sha256。** 令牌是 32 字节随机数（256 位），本身就是不可猜的，
 *    所以不需要胡椒；但明文绝不能落库 —— 一次备份外泄就等于全班登录态外泄。
 *    和口令不同，令牌**不能**用确定性反查，它天生就是"按哈希取记录"。
 *
 * ③ **限速只记在进程内存里。**
 *    它防的是枚举脚本，不是精确配额。多实例各自计数是可接受的；
 *    反过来，若为了"精确"把计数写进库，每条请求都要多一次写，
 *    而它拦的本来就是几秒钟几百次的脚本 —— 不值得。
 *
 * 时间戳一律 ISO 字符串（UTC，24 字符），与全局约束一致；
 * `now` 一律是可注入的毫秒数，测试才能验"过期"与"窗口过后恢复"。
 */

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { safeEqual } from './demo-gate.js';

/**
 * 胡椒。**唯一**让"库被盗也猜不出口令"的东西。
 *
 * 默认值只是为了让本地和测试能直接跑；线上必须配 `PILOT_CODE_PEPPER`。
 * 换胡椒 = 现有全部口令立刻失效（同一个 code 会算出不同的 codeHash），
 * 所以它一旦定下就不能随手改 —— 试点期间改它等于给全班重发一遍号。
 *
 * 为什么**每次调用现读**而不是在模块顶层取一个常量：
 *   `router.js` 里的 `loadEnvFile()` 是在文件体里调用的，而 ESM 的 import
 *   在文件体之前就全部求值完了。冻在模块顶层的话，`.env` 里的胡椒永远读不到 ——
 *   表现是"以为撒了胡椒，其实用的开发默认值"，而且**不报任何错**。
 *   读一次 `process.env` 是纳秒级，登录一次只做一次哈希，不值得为它缓存。
 *
 * 由此带来的唯一约束：运行期不要改这个变量（`loadEnvFile` 只补缺失的键，
 * 不会覆盖已有的值，所以正常路径上它不会变）。
 */
function pepper() {
  return String(process.env.PILOT_CODE_PEPPER || 'bsj-pilot-dev');
}

/** 令牌有效期 60 天，绑账号不绑批次（设计稿 §5.1） */
export const TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/** 限速窗口与阈值：15 分钟内 10 次 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

/** 6 位数字的取值空间：口令必须落在这个区间里，否则学生会拿到 7 位 */
const CODE_SPACE = 1_000_000;

// ---------------------------------------------------------------------------
// 口令与令牌的哈希
// ---------------------------------------------------------------------------

/**
 * 口令 → 库里存的那一串。
 *
 * 确定性：同一个口令永远得到同一个 `codeHash`，否则没法按哈希查表。
 * 胡椒来自环境变量，不进数据库。
 *
 * @param {string} code 6 位数字口令
 * @returns {string} 64 位十六进制
 */
export function hashCode(code) {
  return createHash('sha256').update(`${pepper()}:${String(code ?? '')}`).digest('hex');
}

/**
 * 定时安全地校验口令。
 *
 * 复用 demo-gate 的 `safeEqual` 而不是再写一个：两处比较的是同一种东西
 * （服务端秘密与用户输入），实现分家就会出现"一处改了、另一处忘了"。
 *
 * @param {string} code 学生输入
 * @param {object|null} user 库里的学生记录
 * @returns {boolean}
 */
export function verifyCode(code, user) {
  const stored = user?.codeHash;
  if (!stored) return false;
  return safeEqual(hashCode(code), stored);
}

/** 令牌 → 库里的键。与口令不同，这里不做胡椒：令牌本身有 256 位熵。 */
function tokenHash(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex');
}

/**
 * 当前批次：`batches` 是追加顺序，最后一个是最近加进来的那一批。
 *
 * 为什么取最后一个而不是第一个：改版测第二轮时，同一个学生会从 b1 追加进 b2
 * （设计稿 §5.1 的配对比较）。他此刻在做的显然是 b2，"当前批次"取最新才对。
 * 令牌本身不绑批次 —— 否则 v2 一开老 token 全失效，等于强制换人。
 */
function currentBatchId(user) {
  const batches = user?.batches;
  return Array.isArray(batches) && batches.length ? batches[batches.length - 1] : null;
}

// ---------------------------------------------------------------------------
// 发号
// ---------------------------------------------------------------------------

/**
 * 造一个库里还没有的口令。
 *
 * 为什么要真的与库比对：6 位数字在小批量里撞车概率很低，但**静默发两个同号
 * 是查不出来的事故** —— 两个学生会互相顶号，而数据上看不出异常。
 * 所以生成后按哈希去库里查一次，撞了就重生成。
 *
 * 单进程脚本，不加锁：两个发号进程并发跑本身就不该发生。
 */
async function freshCode(store, takenHashes) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const code = String(randomInt(0, CODE_SPACE)).padStart(6, '0');
    const hash = hashCode(code);
    if (takenHashes.has(hash)) continue;
    // 跨批次也要查：同一个人换批次的场景下，撞号会让人登进别人的账号
    if (await store.getUser(hash)) continue;
    takenHashes.add(hash);
    return code;
  }
  throw new Error('生成口令连续撞号，请先清理库里的账号，或换一个更大的口令空间');
}

/**
 * 给一个批次发 `count` 个号。
 *
 * 写进库的形状（设计稿 §5.1）：
 *   { id, displayName, codeHash, batches: [batchId], createdAt, disabled,
 *     firstSeenAt, lastSeenAt }
 * **没有 salt、没有明文 code**。`batches` 必须是数组：存储层的 `listUsers(batchId)`
 * 过滤的就是它，写成单值会让"按批次看人"永远返回空。
 *
 * 同时写 `batch_member`：批次与人的关系单独一个集合，
 * 因为同一个人可以同时在多个批次里，而"什么时候加进来的"不属于用户本身。
 *
 * @param {object} store
 * @param {{ batchId: string, count: number, prefix?: string, start?: number }} options
 * @returns {Promise<Array<{ displayName: string, code: string }>>}
 */
export async function issueAccounts(store, { batchId, count, prefix = 'S', start = 1 } = {}) {
  const batch = String(batchId ?? '').trim();
  if (!batch) throw new Error('发号必须指定批次（--batch）');

  const total = Math.max(0, Math.trunc(Number(count) || 0));
  if (!total) return [];

  /**
   * 先把这个批次里已有的代号读出来：重跑脚本时若不检查，
   * 会静默再发一个 S01，而 CSV 发出去之后没人能分清哪个 S01 是谁在说话。
   * 这里选择当场报错，而不是"跳过已有的接着编" —— 跳号同样让人对不上名单。
   */
  const takenNames = new Set((await store.listUsers(batch)).map((u) => u.displayName));
  const takenHashes = new Set();
  const nowIso = new Date().toISOString();
  const issued = [];

  for (let i = 0; i < total; i += 1) {
    // 两位数起（S01），三位以上自然变长（S100），不做截断
    const displayName = `${prefix}${String(start + i).padStart(2, '0')}`;
    if (takenNames.has(displayName)) {
      throw new Error(`批次 ${batch} 里已经有代号 ${displayName}，请换一个 --start，或换批次`);
    }
    takenNames.add(displayName);

    const code = await freshCode(store, takenHashes);
    const user = {
      id: `u_${randomBytes(8).toString('hex')}`,
      displayName,
      codeHash: hashCode(code),
      /** 数组，且此刻只有这一个批次；以后加批次是追加 */
      batches: [batch],
      createdAt: nowIso,
      /** 先留字段，停用一个号不需要改结构；登录与验令牌都会看它 */
      disabled: false,
      /** 由第一次成功登录回填；看板用它判断"这个人到底来没来过" */
      firstSeenAt: null,
      lastSeenAt: null,
    };

    await store.putUser(user);
    await store.addMember(batch, user.id);
    issued.push({ displayName, code });
  }

  return issued;
}

// ---------------------------------------------------------------------------
// 登录与令牌
// ---------------------------------------------------------------------------

/**
 * 用口令换令牌。
 *
 * 找不到人或口令不对一律返回 `null` —— 调用方只需要知道"不通过"，
 * 分成"用户不存在"与"口令错误"两种回答，等于给了枚举脚本一个免费的提示。
 * 停用的账号同样返回 `null`：登录口与旧令牌必须同时失效。
 *
 * `ip` 这一版**不参与判定**：限速必须在哈希之前完成（否则拒绝一次仍然做了
 * 一次哈希，脚本照样能烧），所以它由调用方在调本函数前用 enforceLoginRate 做完。
 * 保留这个参数是为了后面登录埋点能拿到来源，不必再改一次签名。
 *
 * @param {object} store
 * @param {string} code
 * @param {string} ip
 * @param {number} [now] 毫秒时间戳（测试要能验过期）
 * @returns {Promise<{ token: string, user: object, batchId: string|null, expiresAt: string } | null>}
 */
export async function login(store, code, ip, now = Date.now()) {
  const normalized = String(code ?? '').trim();
  // 空口令不必查库：库里没有谁的哈希会等于空串，但省一次全表扫描
  if (!normalized) return null;

  const found = await store.getUser(hashCode(normalized));
  if (!found || found.disabled) return null;

  const seenAt = new Date(now).toISOString();
  /**
   * 登录是唯一能观察到"这个人今天真的来了"的时刻，所以就在这里回填两个时间。
   * 看板与导出要的"首次登录 / 最后登录"都由它来，不靠翻事件表
   * （事件是页面级的，弱网下会掉；登录成功是账本级的事实）。
   * `firstSeenAt` 只写第一次：用 `??` 而不是直接覆盖，否则它会变成第二个 lastSeenAt。
   */
  const user = { ...found, firstSeenAt: found.firstSeenAt ?? seenAt, lastSeenAt: seenAt };
  await store.putUser(user);

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(now + TOKEN_TTL_MS).toISOString();

  await store.putToken({
    tokenHash: tokenHash(token),
    userId: user.id,
    /** 令牌**不存批次**：批次随时可能追加，冻进令牌里会让老 token 指向旧批次 */
    expiresAt,
    createdAt: seenAt,
  });

  return { token, user, batchId: currentBatchId(user), expiresAt };
}

/**
 * 令牌 → 这个人是谁。
 *
 * 读不到、过期、账号被停用：一律 `null`。
 * 失效判断是"失败关闭"的：`expiresAt` 解析不出来也当过期，
 * 而不是让一个坏字段变成永久有效的令牌。
 *
 * @param {object} store
 * @param {string} token 客户端带来的明文令牌
 * @param {number} [now] 毫秒时间戳
 * @returns {Promise<{ user: object, batchId: string|null, expiresAt: string } | null>}
 */
export async function resolveToken(store, token, now = Date.now()) {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw) return null;

  const record = await store.getToken(tokenHash(raw));
  if (!record) return null;

  const expiresAtMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return null;

  const user = await store.getUserById(record.userId);
  if (!user || user.disabled) return null;

  return { user, batchId: currentBatchId(user), expiresAt: record.expiresAt };
}

// ---------------------------------------------------------------------------
// 登录失败限速
// ---------------------------------------------------------------------------

/**
 * `Map<IP, 失败时间戳数组>`。
 *
 * 为什么用数组而不是计数器：窗口是**滑动**的。计数器要么需要定时清零
 * （多实例下谁清、什么时候清都是问题），要么会在窗口边界上把
 * "第 10 次在 14:59、第 11 次在 15:01"这种正常重试也拦掉。
 */
const loginFailures = new Map();

function ipKey(ip) {
  const key = String(ip ?? '').trim();
  return key || 'unknown';
}

/** 取出这个 IP 落在窗口内的失败记录，顺便把过期的清掉 */
function recentFailures(ip, now) {
  const key = ipKey(ip);
  const cutoff = now - LOGIN_WINDOW_MS;
  const hits = (loginFailures.get(key) ?? []).filter((t) => t > cutoff);
  /**
   * 空数组直接删键：这张表按 IP 生长，试点期间公网地址可能非常多。
   * 留着一堆 `[]` 不会出错，但会让"到底有没有人正在被限"变得看不出。
   */
  if (hits.length === 0) loginFailures.delete(key);
  else loginFailures.set(key, hits);
  return { key, hits };
}

/**
 * 记一次失败，并回答"还没到上限吧"。
 *
 * 第 10 次失败起返回 `false`（第 1–9 次 `true`）：调用方拿到 `false`
 * 就可以直接告诉学生"稍后再试"，不必再算一次窗口。
 *
 * @param {string} ip
 * @param {number} [now]
 * @returns {boolean}
 */
export function noteLoginFailure(ip, now = Date.now()) {
  const { key, hits } = recentFailures(ip, now);
  hits.push(now);
  loginFailures.set(key, hits);
  return hits.length < LOGIN_MAX_ATTEMPTS;
}

/**
 * 这次尝试放不放行（放行时同时记一笔）。
 *
 * 为什么放行时也要记：调用它的时候还没有验完口令，我们不能假设这次会成功；
 * 成功之后由调用方 `resetLoginFailures(ip)` 清空 ——
 * 这样"连续 10 次尝试"在**有没有一次成功**两种情况下都算得对。
 * 这条形状是测试唯一能验的：同一进程里连调 11 次 = true×10, false×1。
 *
 * @param {string} ip
 * @param {number} [now]
 * @returns {boolean} `false` 表示拒绝
 */
export function enforceLoginRate(ip, now = Date.now()) {
  const { hits } = recentFailures(ip, now);
  if (hits.length >= LOGIN_MAX_ATTEMPTS) return false;
  noteLoginFailure(ip, now);
  return true;
}

/**
 * 登录成功时清空这个 IP 的记录。
 *
 * 不按"全局成功"清零：A 登录成功不该把 B 的失败记录一起抹掉。
 *
 * @param {string} ip
 */
export function resetLoginFailures(ip) {
  loginFailures.delete(ipKey(ip));
}
