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
 * ③ **限速是两个维度，只记在进程内存里。**
 *
 *    真实的数字（就是下面导出的四个常量，不是"大概很多次"）：
 *
 *      单口令：同一来源对**同一个口令** 5 次失败 / 15 分钟 → 这个口令从那里进不来了。
 *              换一个口令照常。这是"一个人反复打错自己那张纸条"。
 *      来源总量：同一 IP 60 次失败 / 60 分钟 → 那里的任何口令都不放行。
 *              这是**唯一的枚举防线**，而且**登录成功不清零**。
 *
 *    **成功只清掉这一对 (IP, 口令)**。上一版是成功清空整个 IP 的记录，
 *    这等于把防线交给攻击者自己按"我要不要重置"：
 *    手里有一张有效口令的学生可以"错 9 次 → 登自己的号 → 计数器归零 → 再来"，
 *    对着 1e6 的口令空间无限次猜。现在这条路被来源总量卡死：
 *    60 次/小时，爬完 1e6 要一年以上。
 *
 *    **它挡不住什么（写在明处）**：
 *      - 换来源 IP 就换一份配额。真正的分布式爆破（几十上百个出口 IP）会把
 *        "一小时 60 次"线性放大；试点防的是学生自己写的那几行脚本，不是僵尸网络。
 *        要进一步收，得在网关层按网段/账号维度再加一道，那不是这一层能做的。
 *      - 拿不到来源地址的请求（桶名 `'unknown'`）**不参与来源总量**：
 *        桶里坐着互不相干的人，锁它等于锁所有人。代价是这部分流量没有总量上限 ——
 *        正常部署里 socket 地址总是在的，这个桶极少命中；若命中，说明部署层
 *        没把地址交上来，该修的是部署。
 *      - 计数在进程里。多实例 = 每个实例各算一份（实际额度是 60 × 实例数）。
 *        反过来，若为了"精确"把计数写进库，每条请求都要多一次读写，
 *        而它拦的本来就是几秒钟几百次的脚本 —— 不值得。
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
 * 生产路径上没有人调它：登录是 `getUser(hashCode(code))` 直接按哈希查表，
 * 查不到就是查不到，不需要再比一次。留着它是给带盐的口令（将来若要改成
 * 每用户随机盐）与"拿到某条记录再验一次"的防守场景用的定时安全比较器。
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
 * 一次哈希，脚本照样能烧），所以它由调用方在调本函数前用 `checkLoginRate` 做完。
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
// 登录失败限速：两个维度
// ---------------------------------------------------------------------------

/**
 * `Map<'ip \0 code', 失败时间戳数组>` —— 单口令维度。
 *
 * 为什么键里带上口令：试点学校的正常形态是**整班一个出口 IP**。
 * 只按 IP 计数的话，第 5 个打错字的学生就会把全班锁在门外，
 * 而唯一的自动恢复途径是"登录成功清零" —— 恰好被锁挡住，只能干等窗口过期。
 * 带上口令之后，一个人反复试**同一个**口令才锁，别人手里的口令不受影响。
 */
const codeFailures = new Map();

/**
 * `Map<ip, 失败时间戳数组>` —— 来源维度。
 *
 * 这是**唯一的枚举防线**：脚本换着口令试，单口令维度一次也拦不住它。
 * 所以它**不因登录成功而清零**（见 `noteLoginSuccess`）。
 */
const ipFailures = new Map();

/**
 * 单一口令的上限：5 次 / 15 分钟。
 *
 * 5 次够不够：打错一位、看错行、把 O 当成 0 —— 正常人手误在这之内。
 * 15 分钟够不够：一节课 40 分钟，学生当场发现打不开就应该能重试，
 * 所以窗口必须短到"下课前一定能自己解决"，不能是"明天再来"。
 */
export const CODE_MAX_FAILURES = 5;
export const CODE_WINDOW_MS = 15 * 60 * 1000;

/**
 * 一个来源的总量上限：60 次 / 60 分钟。
 *
 * 为什么是 60 而不是 10：一个班 40 个人同在一个 NAT 后面，
 * 开学第一节课"一半人打错一次"是**正常事件**，不该锁任何人。
 * 60 次/小时 相当于"全班每人正常手误一次还有余量"，
 * 而对枚举脚本来说，1e6 的口令空间按 60 次/小时爬要一年以上。
 *
 * 为什么是 60 分钟而不是 15：这一维不动辄锁人，所以可以长；
 * 反过来，太短的窗口意味着脚本只要"停 15 分钟"就能重新拿到 60 次，
 * 折算下来还是 240 次/小时。让它一小时 — 更难被节奏利用。
 */
export const IP_MAX_FAILURES = 60;
export const IP_WINDOW_MS = 60 * 60 * 1000;

/**
 * 拿不到来源地址时的桶名。
 *
 * 它**不参与 IP 维度的锁**：桶里坐着一堆互不相干的人，
 * 锁它等于"谁犯错都算你头上"—— 受害者完全无辜，且无处申诉。
 * 它照常记录（口径一致、日志可看），只是不会把谁拦在门外。
 * 口令维度对它照常生效：那锁的是**一个具体口令**，不是所有人。
 */
const UNKNOWN_IP = 'unknown';

const SEP = '\u0000';

/** 上次全表清理的时刻（毫秒）。0 表示"还没扫过" */
let lastSweptAt = 0;

function ipKey(ip) {
  return String(ip ?? '').trim() || UNKNOWN_IP;
}

/** 一对 (来源, 口令) 的键。用 \0 分隔：IP 里不会出现 \0，口令也 trim 过，拼不出歧义 */
function pairKey(ip, code) {
  return `${ipKey(ip)}${SEP}${String(code ?? '').trim()}`;
}

/** 取出落在窗口内的失败时间戳，顺便把过期的清掉 */
function recentFailures(map, key, windowMs, now) {
  const cutoff = now - windowMs;
  const hits = (map.get(key) ?? []).filter((t) => t > cutoff);
  /** 空数组直接删键：留着不报错，但会让"到底有没有人正在被限"看不出 */
  if (hits.length === 0) map.delete(key);
  else map.set(key, hits);
  return hits;
}

/**
 * 定期把彻底过期的键扔掉。
 *
 * 单口令维度的键是 `(IP, 口令)`：枚举脚本一小时能攒出 60 个新键，
 * 而它**换了口令就再也不会读旧键** —— 光靠"读到的时候顺手删"清不掉它们。
 * 所以每过一个 15 分钟窗口全表扫一遍；摊到每次请求上是零成本。
 *
 * 只影响内存，不改变任何判定：清掉的一定是已经滑出窗口的记录。
 */
function sweep(now) {
  if (now - lastSweptAt < CODE_WINDOW_MS) return;
  lastSweptAt = now;
  for (const [key, hits] of codeFailures) {
    const kept = hits.filter((t) => t > now - CODE_WINDOW_MS);
    if (kept.length === 0) codeFailures.delete(key);
    else codeFailures.set(key, kept);
  }
  for (const [key, hits] of ipFailures) {
    const kept = hits.filter((t) => t > now - IP_WINDOW_MS);
    if (kept.length === 0) ipFailures.delete(key);
    else ipFailures.set(key, kept);
  }
}

/**
 * 这次尝试让不让进。**在哈希之前调**（被拒绝的那一次不该产生计算成本）。
 *
 * @param {string} ip 来源地址（`'unknown'`/空 都折进不可归因的桶）
 * @param {string} code 学生输入的口令
 * @param {number} [now] 毫秒时间戳（测试要能验窗口滑动）
 * @returns {'ok' | 'code_locked' | 'ip_locked'}
 */
export function checkLoginRate(ip, code, now = Date.now()) {
  sweep(now);
  const key = ipKey(ip);

  /**
   * 先判来源维度：它一旦锁上，**任何口令**都不放行。
   * 两维都锁着的时候，说"这个网络试错太多了"才是实话 ——
   * 反过来报"这个口令试错太多"，会让学生以为换张纸条就能进。
   */
  if (key !== UNKNOWN_IP) {
    const ipHits = recentFailures(ipFailures, key, IP_WINDOW_MS, now);
    if (ipHits.length >= IP_MAX_FAILURES) return 'ip_locked';
  }
  const pairHits = recentFailures(codeFailures, pairKey(ip, code), CODE_WINDOW_MS, now);
  if (pairHits.length >= CODE_MAX_FAILURES) return 'code_locked';
  return 'ok';
}

/**
 * 记一次失败。**只在真的验过一次且没通过时调**。
 *
 * 不要给 429 的拒绝记账：被拒的那次没有发生任何验证，
 * 记了会让锁自己续期（每被拒一次窗口就往后推一次），等于永不解锁。
 * 也不要给坏请求体（400）记账：那是网络问题，不是猜号。
 *
 * @param {string} ip
 * @param {string} code
 * @param {number} [now]
 */
export function noteLoginFailure(ip, code, now = Date.now()) {
  sweep(now);

  const pk = pairKey(ip, code);
  const pairHits = recentFailures(codeFailures, pk, CODE_WINDOW_MS, now);
  pairHits.push(now);
  codeFailures.set(pk, pairHits);

  // 不可归因的桶也照记（口径一致、日志可看），只是它不会锁住任何人
  const key = ipKey(ip);
  const ipHits = recentFailures(ipFailures, key, IP_WINDOW_MS, now);
  ipHits.push(now);
  ipFailures.set(key, ipHits);
}

/**
 * 登录成功：**只清这一对 (IP, 口令)**。
 *
 * 为什么不清来源维度：那是枚举防线。清了就等于
 * "错 59 次 → 用自己的有效口令登一次 → 计数器归零 → 再来 59 次"，
 * 一个手里有有效口令的学生就得到了无限次猜测。
 * 来源维度只能等窗口自己滑过去（1 小时），这是它防住枚举的原因。
 *
 * 为什么口令维度可以清：它记的是"这一对试错了 5 次"，
 * 而登录成功意味着这一对是**对的** —— 再攒着它只会误伤下一次正常登录。
 *
 * @param {string} ip
 * @param {string} code
 * @param {number} [now]
 */
export function noteLoginSuccess(ip, code, now = Date.now()) {
  sweep(now);
  codeFailures.delete(pairKey(ip, code));
}

/**
 * 清空全部进程内状态。**只给测试用**。
 *
 * 状态是模块级的，一个用例攒下的失败会算到下一个用例头上；
 * 没有这个钩子，限速用例就只能互相隔开或依赖执行顺序。
 */
export function resetLoginRateLimits() {
  codeFailures.clear();
  ipFailures.clear();
  lastSweptAt = 0;
}
