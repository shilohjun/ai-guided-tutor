/**
 * 账号、6 位口令与登录限速。
 *
 * ============================================================================
 * 为什么这组用例是试点能不能开始的前提
 * ============================================================================
 * 试点发出去的是「代号 + 6 位数字口令」，学生手里的东西必须同时满足三件事：
 *
 *   ① **能查表**：服务端只能按口令哈希找人。所以哈希必须确定性 ——
 *      同一口令每次算出来必须是同一个串，否则 `getUser(codeHash)` 永远查不到人。
 *      （反过来，用每用户随机盐就无法按哈希查表，这条是整个登录的地基。）
 *
 *   ② **拿到库也猜不出口令**：6 位数字只有 100 万种，靠哈希本身是挡不住的，
 *      所以哈希里拌了胡椒（`PILOT_CODE_PEPPER`，不进数据库）。
 *
 *   ③ **必须配一道闸，而且是两个维度**：100 万种对脚本来说是几分钟的事。
 *      单一口令 15 分钟 5 次（一个人反复打错自己那张纸条），
 *      同一来源 60 分钟 120 次（枚举脚本，**成功不清零**；`PILOT_IP_MAX_FAILURES` 可配）；
 *      成功只清掉"这一对 (IP, 口令)"。
 *      一个班共用一个出口 IP 是产品的正常场景，所以单一口令被锁**不能**牵连别人。
 *
 * 另外还有一条现实约束：同一台电脑换账号是常态（家里共用一台机器）。
 * 两个人的 token 不能互指，否则后登录的人会看到前一个人的作答记录。
 */

import { describe, it, assertEquals, assert, assertIncludes } from './runner.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/server/store/index.js';
import {
  issueAccounts,
  login,
  resolveToken,
  hashCode,
  verifyCode,
  checkLoginRate,
  noteLoginFailure,
  noteLoginSuccess,
  resetLoginRateLimits,
  CODE_MAX_FAILURES,
  CODE_WINDOW_MS,
  IP_MAX_FAILURES,
  IP_WINDOW_MS,
  TOKEN_TTL_MS,
} from '../src/server/auth.js';
import { buildCsv, parseArgs, issueBatch } from '../scripts/issue-accounts.mjs';

/** 每个用例一份自己的库：共用一个库会让"哪些号已经发过"互相污染 */
async function setup() {
  return openStore({ STORE: 'file', STORE_DIR: mkdtempSync(join(tmpdir(), 'bsj-auth-')) });
}

/** 令牌记录的键：库里存的是这个，不是 token 本身 */
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

describe('账号 · 发号与校验', () => {
  it('发 3 个号，代号从 S01 起，口令是 6 位数字', async () => {
    const s = await setup();
    const list = await issueAccounts(s, { batchId: 'b1', count: 3 });
    assertEquals(list.map((a) => a.displayName).join(','), 'S01,S02,S03');
    assert(list.every((a) => /^\d{6}$/.test(a.code)), '口令必须是 6 位数字');
  });

  it('口令不存明文：库里拿不到 code 本身', async () => {
    const s = await setup();
    const [{ code }] = await issueAccounts(s, { batchId: 'b1', count: 1 });
    /**
     * 注意这里不是 `const { codeHash } = hashCode(code)`：
     * 计划正文那行来自"每人随机盐"的旧签名（返回 `{ codeHash, salt }`）。
     * 控制者补充 A1 把它改成了确定性哈希，返回值就是哈希串本身 ——
     * 否则 `getUser(codeHash)` 永远查不到人，登录从根上不成立。
     */
    const codeHash = hashCode(code);
    const user = await s.getUser(codeHash);
    assertEquals(user.code, undefined, '记录里不得有明文字段');
    assert(verifyCode(code, user), '正确口令应校验通过');
    assert(!verifyCode('000000' === code ? '111111' : '000000', user), '错误口令必须不通过');
  });

  it('同一个口令永远得到同一个 codeHash（确定性哈希，否则查不到人）', () => {
    assertEquals(hashCode('317482'), hashCode('317482'), '同一口令必须得到同一个哈希');
    assert(hashCode('317482') !== hashCode('317483'), '不同口令必须得到不同哈希');
    assert(/^[0-9a-f]{64}$/.test(hashCode('317482')), '哈希应是 64 位十六进制（sha256）');
  });

  it('PILOT_CODE_PEPPER 在模块加载之后设置也生效（本地 .env 是稍后才读的）', async () => {
    /**
     * 这条守的是一个**静默降级**，它比崩溃危险得多：
     *
     *   router.js 里 `loadEnvFile()` 是在文件体里调用的，而 ESM 的 import
     *   在这之前就全部求值完了。若胡椒在 auth.js 加载那一刻被冻进一个模块级常量，
     *   `.env` 里配的 PILOT_CODE_PEPPER 就永远读不到 —— 线上会安静地用开发默认值，
     *   而所有人都以为"库被盗也猜不出口令"。
     *
     * 用一个带查询串的 import 拿一份**全新的模块实例**，模拟"加载时环境里还没有它"。
     */
    const saved = process.env.PILOT_CODE_PEPPER;
    delete process.env.PILOT_CODE_PEPPER;
    try {
      const fresh = await import('../src/server/auth.js?late-env=1');
      const withDefault = fresh.hashCode('317482');
      assertEquals(
        withDefault,
        createHash('sha256').update('bsj-pilot-dev:317482').digest('hex'),
        '没配胡椒时用开发默认值',
      );

      process.env.PILOT_CODE_PEPPER = 'late-pepper';
      assertEquals(
        fresh.hashCode('317482'),
        createHash('sha256').update('late-pepper:317482').digest('hex'),
        '配了胡椒就必须用它 —— 否则等于没撒',
      );
    } finally {
      if (saved === undefined) delete process.env.PILOT_CODE_PEPPER;
      else process.env.PILOT_CODE_PEPPER = saved;
    }
  });

  it('学生记录带 batches 数组（按批次看人靠它，写成单值就永远查到空）', async () => {
    const s = await setup();
    await issueAccounts(s, { batchId: 'b1', count: 2 });
    const users = await s.listUsers('b1');
    assertEquals(users.length, 2, '按批次应能取到刚发的人');
    assert(users.every((u) => Array.isArray(u.batches) && u.batches.includes('b1')), 'batches 必须是数组');
    assert(users.every((u) => u.codeHash && /^[0-9a-f]{64}$/.test(u.codeHash)), '每人一条口令哈希');
    assert(users.every((u) => !('salt' in u)), '确定性哈希不再需要 salt 字段');
  });

  it('代号重复时当场报错，而不是静默发第二个 S01', async () => {
    /**
     * 为什么不是"跳过已有的、接着往下编"：发号是不可逆的 ——
     * CSV 一旦发到学生手里，"第 3 号是谁"就必须只有一个答案。
     * 重跑脚本时静默出两个 S01，事后没人能从数据里分出谁是谁。
     */
    const s = await setup();
    await issueAccounts(s, { batchId: 'b1', count: 1 });
    let caught = null;
    try {
      await issueAccounts(s, { batchId: 'b1', count: 1 });
    } catch (err) {
      caught = err;
    }
    assert(caught, '同批同前缀重号必须抛错');
    assert(/S01/.test(caught.message), `错误信息要说清撞的是哪个代号，实际：${caught.message}`);
  });
});

describe('账号 · 登录与 token', () => {
  it('登录拿 token，能解回同一个人', async () => {
    const s = await setup();
    const [{ code, displayName }] = await issueAccounts(s, { batchId: 'b1', count: 1 });
    const r = await login(s, code, '127.0.0.1');
    assert(r?.token, '应签发 token');
    assertEquals(r.user.displayName, displayName);
    const back = await resolveToken(s, r.token);
    assertEquals(back.user.id, r.user.id);
  });

  it('错口令返回 null，且不签发 token', async () => {
    const s = await setup();
    await issueAccounts(s, { batchId: 'b1', count: 1 });
    assertEquals(await login(s, '999999x', '127.0.0.1'), null);
  });

  it('过期 token 解不出来', async () => {
    const s = await setup();
    const [{ code }] = await issueAccounts(s, { batchId: 'b1', count: 1 });
    const r = await login(s, code, '127.0.0.1');
    assertEquals(await resolveToken(s, r.token, Date.now() + TOKEN_TTL_MS + 1), null, '过期必须解不出');
  });

  it('两个账号的 token 互不指向对方（共用电脑换账号）', async () => {
    const s = await setup();
    const [a, b] = await issueAccounts(s, { batchId: 'b1', count: 2 });
    const ra = await login(s, a.code, '10.0.0.1');
    const rb = await login(s, b.code, '10.0.0.2');
    assert(ra.token !== rb.token, '两个人的 token 不能相同');
    assertEquals((await resolveToken(s, ra.token)).user.id, ra.user.id);
    assertEquals((await resolveToken(s, rb.token)).user.id, rb.user.id);
  });

  it('库里只存 token 的 sha256，明文只在那一次响应里', async () => {
    const s = await setup();
    const [{ code }] = await issueAccounts(s, { batchId: 'b1', count: 1 });
    const r = await login(s, code, '10.0.0.3');
    const record = await s.getToken(sha256(r.token));
    assert(record, '按 sha256(token) 应能取到令牌记录');
    assertEquals(record.token, undefined, '记录里不得有明文 token');
    assert(!JSON.stringify(record).includes(r.token), '整条记录序列化后都不许出现明文 token');
    assertEquals(record.userId, r.user.id, '令牌要指向签发时的那个人');
  });

  it('乱造的 token 解不出来（不抛错）', async () => {
    const s = await setup();
    assertEquals(await resolveToken(s, 'not-a-real-token'), null);
    assertEquals(await resolveToken(s, ''), null, '空 token 不应命中任何人');
  });

  it('登录回填首次/最后出现时间（看板靠它判断"这个人来没来过"）', async () => {
    const s = await setup();
    const [{ code }] = await issueAccounts(s, { batchId: 'b1', count: 1 });

    const t1 = Date.parse('2026-11-09T08:00:00.000Z');
    const first = await login(s, code, '10.0.0.6', t1);
    assertEquals(first.user.firstSeenAt, '2026-11-09T08:00:00.000Z', '首次登录要记下时间');
    assertEquals(first.user.lastSeenAt, '2026-11-09T08:00:00.000Z');

    const t2 = Date.parse('2026-11-10T08:00:00.000Z');
    const second = await login(s, code, '10.0.0.6', t2);
    assertEquals(second.user.firstSeenAt, '2026-11-09T08:00:00.000Z', 'firstSeenAt 只写第一次');
    assertEquals(second.user.lastSeenAt, '2026-11-10T08:00:00.000Z', 'lastSeenAt 每次更新');

    /** 必须落库：只在返回值里改，重启后"来没来过"就回到 null 了 */
    const stored = await s.getUserById(first.user.id);
    assertEquals(stored.lastSeenAt, '2026-11-10T08:00:00.000Z', '时间要写进库');
    assertEquals(stored.firstSeenAt, '2026-11-09T08:00:00.000Z');
  });

  it('停用的账号不能登录，已签发的 token 也随之失效', async () => {
    /**
     * 「可以单独停用某一个人」是选口令而不是一次性链接的理由之一（设计稿 §5.1）：
     * 口令泄露时只改一个人，不影响全班。所以 disabled 必须在两处都生效 ——
     * 登录口，以及已经发出去的旧 token。
     */
    const s = await setup();
    const [{ code }] = await issueAccounts(s, { batchId: 'b1', count: 1 });
    const r = await login(s, code, '10.0.0.4');
    const user = await s.getUser(hashCode(code));
    await s.putUser({ ...user, disabled: true });

    assertEquals(await login(s, code, '10.0.0.5'), null, '停用后不得再登录');
    assertEquals(await resolveToken(s, r.token), null, '停用后旧 token 也不得再用');
  });
});

/**
 * 限速是两个维度，缺一个都不成立：
 *
 *   ① **(IP, 口令) 5 次 / 15 分钟** —— 一个人反复打错同一张纸条。
 *      为什么必须带上"口令"这一维：试点学校的正常形态是**整班一个出口 IP**。
 *      若只按 IP 计数，第 10 个打错字的学生会把全班锁在门外，
 *      而唯一的自动恢复途径是"登录成功清零" —— 恰好被锁挡住，只能等窗口过期。
 *
 *   ② **IP 总量 120 次 / 60 分钟（默认，`PILOT_IP_MAX_FAILURES` 可配）** —— 枚举脚本。
 *      这是唯一的枚举防线，所以**成功不清**：只要不清，任何"靠自己一张有效口令
 *      换一批新尝试"的循环都被这个总量卡住。
 *
 * 状态是进程级模块变量，用例之间必须自己 `resetLoginRateLimits()`。
 */
describe('账号 · 登录失败限速（两个维度）', () => {
  /** 清表并返回一个基准时刻；每个用例都从空表开始 */
  function fresh() {
    resetLoginRateLimits();
    return Date.now();
  }

  it(`同一个口令错 ${CODE_MAX_FAILURES} 次 → 只锁这一对 (IP, 口令)`, () => {
    const now = fresh();
    const ip = '203.0.113.50';
    const code = '123456';

    for (let i = 0; i < CODE_MAX_FAILURES - 1; i += 1) {
      assertEquals(checkLoginRate(ip, code, now), 'ok', `第 ${i + 1} 次之前应放行`);
      noteLoginFailure(ip, code, now);
    }
    assertEquals(checkLoginRate(ip, code, now), 'ok', `${CODE_MAX_FAILURES - 1} 次失败之后还放行`);
    noteLoginFailure(ip, code, now);
    assertEquals(
      checkLoginRate(ip, code, now),
      'code_locked',
      `第 ${CODE_MAX_FAILURES} 次失败之后这一对必须锁上`,
    );
  });

  it('同一 IP 换一个口令仍然放行（一个班一个出口 IP 的核心用例）', () => {
    const now = fresh();
    const ip = '203.0.113.51';
    for (let i = 0; i < CODE_MAX_FAILURES; i += 1) noteLoginFailure(ip, '111111', now);

    assertEquals(checkLoginRate(ip, '111111', now), 'code_locked', '被 hammer 的那个口令要锁');
    assertEquals(
      checkLoginRate(ip, '222222', now),
      'ok',
      '别的口令不受牵连 —— 否则一个人打错字就把全班锁在门外',
    );
  });

  it(`同一 IP 跨很多口令累计 ${IP_MAX_FAILURES} 次失败 → ip_locked（枚举脚本）`, () => {
    const now = fresh();
    const ip = '203.0.113.52';
    // 每个口令只错一次：单口令维度锁不到，只有 IP 总量能拦住这种"换着号试"
    for (let i = 0; i < IP_MAX_FAILURES; i += 1) noteLoginFailure(ip, String(100000 + i), now);

    assertEquals(checkLoginRate(ip, '999999', now), 'ip_locked', '换个口令也进不来');
    assertEquals(checkLoginRate('203.0.113.53', '999999', now), 'ok', '换一个来源 IP 不受牵连');
  });

  it('成功只清这一对：4 次失败 + 1 次成功之后，IP 总量仍然算那 4 次（再补满才锁）', () => {
    const now = fresh();
    const ip = '203.0.113.54';
    const code = '654321';

    for (let i = 0; i < 4; i += 1) noteLoginFailure(ip, code, now);
    noteLoginSuccess(ip, code, now);
    assertEquals(checkLoginRate(ip, code, now), 'ok', '成功必须清掉这一对');

    /**
     * 这一条是 finding 2 的回归：若成功把 IP 总量一起清了，
     * 那么"错 4 次 → 用自己那张有效口令登录 → 再错 4 次"就是无限次尝试。
     * 这里钉住"IP 总量从 4 继续数"：补到上限前一次还放行，再补一次就锁。
     * 数一律从 `IP_MAX_FAILURES` 推，不写死 —— 默认值是可配的（B5）。
     */
    for (let i = 0; i < IP_MAX_FAILURES - 5; i += 1) noteLoginFailure(ip, `3000${String(i).padStart(2, '0')}`, now);
    assertEquals(checkLoginRate(ip, '888888', now), 'ok', `4 + ${IP_MAX_FAILURES - 5} = ${IP_MAX_FAILURES - 1}，还没到上限`);
    noteLoginFailure(ip, '888888', now);
    assertEquals(checkLoginRate(ip, '999999', now), 'ip_locked', `补满到 ${IP_MAX_FAILURES} 就必须锁`);
  });

  it("未知来源那一桶永远不锁 IP（锁它等于锁所有人），但仍然记账", () => {
    const now = fresh();
    // 100 次、每次一个不同口令：单口令维度锁不到，唯一可能的锁就是 IP 维度
    for (let i = 0; i < 100; i += 1) noteLoginFailure('unknown', String(400000 + i), now);

    assertEquals(
      checkLoginRate('unknown', '999999', now),
      'ok',
      '没有可归因的身份就不该有"整个网络被锁"这种连带伤害',
    );
    assertEquals(
      checkLoginRate(undefined, '999999', now),
      'ok',
      '拿不到地址的请求一律折进同一桶，也不能锁',
    );
  });

  it('两个窗口都是滑动的：16 分钟前的口令失败不再锁，61 分钟前的 IP 失败不再计数', () => {
    const now = fresh();

    // ① 口令维度：锁上之后窗口内仍然锁，滑过去就放行
    const ipA = '203.0.113.60';
    for (let i = 0; i < CODE_MAX_FAILURES; i += 1) noteLoginFailure(ipA, '121212', now);
    assertEquals(checkLoginRate(ipA, '121212', now), 'code_locked');
    assertEquals(
      checkLoginRate(ipA, '121212', now + CODE_WINDOW_MS - 1000),
      'code_locked',
      '还没滑出窗口，必须仍然锁',
    );
    assertEquals(
      checkLoginRate(ipA, '121212', now + CODE_WINDOW_MS + 1),
      'ok',
      '过了 15 分钟必须自动恢复（这是学生唯一的自助出路）',
    );

    // ② IP 维度：上限前一次失败在 61 分钟后全部滑出窗口，再来一轮也不该累计
    const ipB = '203.0.113.61';
    for (let i = 0; i < IP_MAX_FAILURES - 1; i += 1) noteLoginFailure(ipB, String(600000 + i), now);
    const later = now + IP_WINDOW_MS + 1;
    for (let i = 0; i < IP_MAX_FAILURES - 1; i += 1) noteLoginFailure(ipB, String(700000 + i), later);
    assertEquals(
      checkLoginRate(ipB, '999999', later),
      'ok',
      '窗口外的旧失败不得累计（固定桶/累加计数会在这里变红）',
    );
  });
});

/**
 * ============================================================================
 * 阈值可配（B5，终审阻塞项）
 * ============================================================================
 * 上一版的 IP 总量是模块里的一个常量 60。而试点学校的正常形态是**整班一个出口 IP**：
 * 一个班第一节课的正常手误（看错行、把 O 当 0、纸条放错）加起来就有几十次，
 * 60 一次都不富余 —— 全班会被一起锁一小时，而提示语读起来像"平台坏了"。
 *
 * 现在：默认 120（安全的那一侧仍然有界），可以用 `PILOT_IP_MAX_FAILURES` 按学校调。
 * 每次调用现读而不是模块顶层取常量：部署里改一个环境变量就该生效，
 * 测试也才能注入一个小值来验"第 N 次就锁"（改常量做不到这件事）。
 *
 * 这一组把**默认数字**写死在断言里（120）：只写 `>= IP_MAX_FAILURES` 的话，
 * 退回 60 也照样绿 —— 而 60 正是那个会把全班锁死的值。
 */
describe('账号 · 来源总量阈值可配（PILOT_IP_MAX_FAILURES）', () => {
  /** 改环境变量跑一段，跑完一律还原（限速表也要清） */
  function withMaxFailures(value, fn) {
    const before = process.env.PILOT_IP_MAX_FAILURES;
    if (value === undefined) delete process.env.PILOT_IP_MAX_FAILURES;
    else process.env.PILOT_IP_MAX_FAILURES = value;
    resetLoginRateLimits();
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.PILOT_IP_MAX_FAILURES;
      else process.env.PILOT_IP_MAX_FAILURES = before;
      resetLoginRateLimits();
    }
  }

  it('默认是 120：119 次失败仍放行，第 120 次就锁', () => {
    withMaxFailures(undefined, () => {
      const now = Date.now();
      const ip = '203.0.113.90';
      assertEquals(IP_MAX_FAILURES, 120, '默认值必须是 120（60 会把一个正常手误的班锁死）');

      for (let i = 0; i < 119; i += 1) noteLoginFailure(ip, String(500000 + i), now);
      assertEquals(checkLoginRate(ip, '999999', now), 'ok', '119 次还在额度内');

      noteLoginFailure(ip, '999999', now);
      assertEquals(checkLoginRate(ip, '111111', now), 'ip_locked', '第 120 次必须锁');
    });
  });

  it('设成 3 就是第 3 次锁（每次调用现读，不必重启进程）', () => {
    withMaxFailures('3', () => {
      const now = Date.now();
      const ip = '203.0.113.91';

      noteLoginFailure(ip, 'a-1', now);
      noteLoginFailure(ip, 'a-2', now);
      assertEquals(checkLoginRate(ip, 'a-3', now), 'ok', '2 次还没到 3');
      noteLoginFailure(ip, 'a-3', now);
      assertEquals(checkLoginRate(ip, 'a-4', now), 'ip_locked', '设成 3，第 3 次就该锁');
    });
  });

  it('坏值（空 / 0 / 负数 / 非数字）一律退回默认 120：不能变成"永不锁"或"立刻锁"', () => {
    /**
     * 这四种都不是"更严或更松"，而是**换了一个意思**：
     *   空 / 非数字 → 若当成 0，`length >= 0` 恒真 → 所有人第一次请求就被锁；
     *   0         → 同上；
     *   负数      → `length >= -5` 也恒真 → 第一次请求就锁死全网。
     * 所以只认有限的正数，其余一律退回 120。
     */
    for (const value of ['', '0', '-5', 'abc']) {
      withMaxFailures(value, () => {
        const now = Date.now();
        const ip = `203.0.113.${value === '' ? 92 : 93}`;
        for (let i = 0; i < 119; i += 1) noteLoginFailure(ip, `${value}-${i}`, now);
        assertEquals(checkLoginRate(ip, 'x', now), 'ok', `PILOT_IP_MAX_FAILURES=${JSON.stringify(value)} 应当按默认 120 算`);
        noteLoginFailure(ip, 'x', now);
        assertEquals(checkLoginRate(ip, 'y', now), 'ip_locked', `坏值不能等于"永不锁"（${JSON.stringify(value)}）`);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 真实 HTTP 路由（起一个临时服务，端到端过一遍 /api/auth/login）
// ---------------------------------------------------------------------------

/**
 * 为什么这几条必须走真服务而不是直接调 login()：
 *   "429 的两句文案"、"429 带 Retry-After"、"被拒的那次不记账"、
 *   "错口令是 401 而不是 500"、"malformed body 不会炸出 500" ——
 *   这几件事**只发生在路由层**。它们是学生和家长能感知到的那一层，
 *   而 core 层全绿也说明不了这一层没坏。
 */
describe('账号 · 登录接口（真实 HTTP）', () => {
  async function withServer(fn) {
    const { createServer } = await import('node:http');
    const { handleApi } = await import('../src/server/router.js');
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const handled = await handleApi(req, res, url);
      if (!handled) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'not handled' }));
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      return await fn(base);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  /** 路由层用的是进程级单例存储；发号必须发进同一个库，否则登录查不到人 */
  async function freshAccount(batchId) {
    const { getStore } = await import('../src/server/router.js');
    const [{ code, displayName }] = await issueAccounts(await getStore(), { batchId, count: 1 });
    return { code, displayName };
  }

  const post = (base, body, headers = {}) =>
    fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('口令对 → 200，回 token 与代号', async () => {
    await withServer(async (base) => {
      const { code, displayName } = await freshAccount('route-b1');
      const res = await post(base, { code }, { 'x-forwarded-for': '198.51.100.1' });
      assertEquals(res.status, 200, '正确口令应 200');
      const json = await res.json();
      assert(/^[0-9a-f]{64}$/.test(json.token ?? ''), 'token 应是 32 字节十六进制');
      assertEquals(json.displayName, displayName);
      assertEquals(json.batchId, 'route-b1', '应回当前批次');
      assert(!Number.isNaN(Date.parse(json.expiresAt)), 'expiresAt 应是可解析的时间戳');
      assertEquals(json.code, undefined, '响应里不得回显口令');
    });
  });

  it('口令不对 → 401 口令不对（不泄露"有没有这个人"）', async () => {
    await withServer(async (base) => {
      const res = await post(base, { code: 'not-a-code' }, { 'x-forwarded-for': '198.51.100.2' });
      assertEquals(res.status, 401);
      const json = await res.json();
      assertEquals(json.error, '口令不对');
    });
  });

  it('请求体不是 JSON → 400，而不是 500', async () => {
    /**
     * 学生扫码之后可能什么都不点就断了网，请求体变成半截。
     * 这时候炸出 500 在页面上就是一句英文的"内部错误"，
     * 而真正该说的是"这次没提交成功，再试一次"。
     */
    await withServer(async (base) => {
      const res = await post(base, '这不是 JSON', { 'x-forwarded-for': '198.51.100.3' });
      assertEquals(res.status, 400, '坏请求体应是 400');
      const json = await res.json();
      assert(/JSON/.test(json.error ?? ''), `错误要指认是请求体的问题，实际：${json.error}`);
    });
  });

  it('同一个口令错 5 次 → 429（口令维度）带 Retry-After，同一网络里的别人照常登录', async () => {
    resetLoginRateLimits();
    await withServer(async (base) => {
      const headers = { 'x-forwarded-for': '198.51.100.10, 10.0.0.1' };
      for (let i = 1; i <= CODE_MAX_FAILURES; i += 1) {
        const res = await post(base, { code: '000001' }, headers);
        assertEquals(res.status, 401, `第 ${i} 次应是口令不对，而不是被限速`);
      }
      const blocked = await post(base, { code: '000001' }, headers);
      assertEquals(blocked.status, 429, '同一对 (IP, 口令) 第 6 次必须拒绝');
      assertEquals(
        (await blocked.json()).error,
        '这个口令试错太多次了，请核对老师发给你的 6 位数字，或稍后再试',
        '提示必须告诉学生下一步做什么',
      );
      assertEquals(blocked.headers.get('retry-after'), '900', '429 要带 Retry-After');

      /**
       * 这条是整个 finding 1 的回归：同一个出口 IP（一个班）里，
       * 别人手里正确的口令**不能**被牵连。旧实现里这里会是 429。
       */
      const { code } = await freshAccount('route-b2');
      const other = await post(base, { code }, headers);
      assertEquals(other.status, 200, '同一个网络里的别的学生必须照常登录');
    });
  });

  it('同一个网络里 12 个人同时用正确口令登录 → 全部 200（一个班一起点"登录"的形态）', async () => {
    resetLoginRateLimits();
    await withServer(async (base) => {
      const { getStore } = await import('../src/server/router.js');
      const accounts = await issueAccounts(await getStore(), { batchId: 'route-b7', count: 12 });

      /**
       * 这是 finding 1 的另一半：旧实现把"这次尝试"记在验证**之前**，
       * 于是同一个 NAT 下第 11 个并发请求不管口令对不对都撞 429，
       * 文案还说"试太多次了" —— 而每一次其实都是对的。
       * 现在只有失败才记账：全对就一次失败都没有，也没有任何理由拦。
       */
      const headers = { 'x-forwarded-for': '198.51.100.15' };
      const results = await Promise.all(accounts.map((a) => post(base, { code: a.code }, headers)));
      const statuses = results.map((r) => r.status);
      assert(
        statuses.every((s) => s === 200),
        `12 个正确口令都必须 200，实际：${statuses.join(',')}`,
      );
    });
  });

  it('429 是拒绝，不是一次验证尝试：被拒的那些不记入任何计数', async () => {
    resetLoginRateLimits();
    await withServer(async (base) => {
      const headers = { 'x-forwarded-for': '198.51.100.11' };
      for (let i = 0; i < CODE_MAX_FAILURES; i += 1) await post(base, { code: '000002' }, headers);
      for (let i = 0; i < IP_MAX_FAILURES; i += 1) {
        const res = await post(base, { code: '000002' }, headers);
        assertEquals(res.status, 429, '这一对已经锁上，每次都必须拒绝');
      }

      /**
       * 若那批被拒的请求也被记账，IP 总量就会超过上限，换一个正确口令也该 ip_locked。
       * 记账的后果不只是多算：锁会自己续期（每次被拒都把窗口往后推），永不解锁。
       */
      const { code } = await freshAccount('route-b3');
      const other = await post(base, { code }, headers);
      assertEquals(other.status, 200, '被拒绝的尝试不能记账（否则锁会自己续期）');
    });
  });

  it(`同一 IP 跨口令累计 ${IP_MAX_FAILURES} 次失败 → 429（网络维度）带 Retry-After`, async () => {
    resetLoginRateLimits();
    await withServer(async (base) => {
      const headers = { 'x-forwarded-for': '198.51.100.12' };
      for (let i = 0; i < IP_MAX_FAILURES; i += 1) {
        const res = await post(base, { code: String(800000 + i) }, headers);
        assertEquals(res.status, 401, `第 ${i + 1} 次应是正常的口令不对`);
      }
      const { code } = await freshAccount('route-b4');
      const blocked = await post(base, { code }, headers);
      assertEquals(blocked.status, 429, '这个网络的总量到顶了，正确的口令也进不来');
      assertEquals((await blocked.json()).error, '这个网络试错的次数太多了，请稍后再试');
      assertEquals(blocked.headers.get('retry-after'), '900');

      const other = await post(base, { code }, { 'x-forwarded-for': '198.51.100.13' });
      assertEquals(other.status, 200, '另一个来源 IP 不该被牵连');
    });
  });

  it(`成功登录不清 IP 总量：${IP_MAX_FAILURES - 1} 次失败 + 1 次成功之后，再错 1 次就锁网络`, async () => {
    resetLoginRateLimits();
    await withServer(async (base) => {
      const headers = { 'x-forwarded-for': '198.51.100.14' };
      for (let i = 0; i < IP_MAX_FAILURES - 1; i += 1) {
        await post(base, { code: String(900000 + i) }, headers);
      }
      const { code } = await freshAccount('route-b5');
      const ok = await post(base, { code }, headers);
      assertEquals(ok.status, 200, `${IP_MAX_FAILURES - 1} 次还没到上限，正确的口令要能登进来`);

      /**
       * 这条是 finding 2 的回归：旧实现里成功会清空这个 IP 的失败记录，
       * 于是"错几次 → 用自己那张有效口令登录 → 计数器归零"可以无限循环。
       * 现在成功只清 (IP, 口令) 这一对，IP 总量继续数。
       */
      const oneMore = await post(base, { code: '000003' }, headers);
      assertEquals(oneMore.status, 401, `第 ${IP_MAX_FAILURES} 次失败仍然是一次正常的 401`);

      const blocked = await post(base, { code }, headers);
      assertEquals(blocked.status, 429, '越过上限必须被网络维度拦住 —— 成功没有清零');
      assertEquals(blocked.headers.get('retry-after'), '900');
    });
  });
});

// ---------------------------------------------------------------------------
// 发号脚本
// ---------------------------------------------------------------------------

/**
 * 为什么脚本也要测：
 *   试点期间真正发到学生手里的就是这份 CSV。它的两个硬要求（带 BOM、
 *   列序固定）靠眼睛验不出来 —— 打开 Excel 看到乱码时，号已经发出去了。
 *   而"默认写进 file 驱动"这条更要钉住：发号脚本是跑一次就退的进程，
 *   用默认的内存驱动等于当场把刚发的号全丢掉。
 */
describe('发号脚本 · CSV 导出', () => {
  const tmpDir = () => mkdtempSync(join(tmpdir(), 'bsj-issue-'));

  it('CSV 带 BOM、列头是 序号,代号,口令,登录链接', () => {
    const csv = buildCsv([{ displayName: 'S01', code: '317482' }], 'https://pilot.example.com/');
    assert(csv.startsWith('\uFEFF'), 'CSV 必须以 BOM 开头，否则 Excel 打开中文列名是乱码');
    const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    assertEquals(lines[0], '序号,代号,口令,登录链接');
    assertEquals(lines[1], '1,S01,317482,https://pilot.example.com/', '一行一个学生，链接取自 PILOT_BASE_URL');
  });

  it('没有 PILOT_BASE_URL 时链接列留空（不是 undefined 也不是 null）', () => {
    const csv = buildCsv([{ displayName: 'S01', code: '317482' }], '');
    const line = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)[1];
    assertEquals(line, '1,S01,317482,', '没配就空着，留给人工补');
    assert(!/undefined|null/.test(csv), 'CSV 里不该出现 undefined/null');
  });

  it('解析 --batch / --count / --out，count 是数字', () => {
    const args = parseArgs(['--batch', 'b2', '--count', '3', '--out', '/tmp/x.csv']);
    assertEquals(args.batchId, 'b2');
    assertEquals(args.count, 3);
    assertEquals(args.out, '/tmp/x.csv');
    assertEquals(args.prefix, 'S', '前缀默认 S');
    assertEquals(args.start, 1, '起始号默认 1');
  });

  it('issueBatch：建批次、默认落到 file 驱动、写出 CSV', async () => {
    const dir = tmpDir();
    const out = join(dir, 'accounts-bx.csv');
    const res = await issueBatch({
      batchId: 'bx',
      count: 2,
      out,
      env: { STORE_DIR: dir, PILOT_BASE_URL: 'https://pilot.example.com' },
    });

    assertEquals(res.rows.length, 2, '应发出两个人');
    const text = readFileSync(out, 'utf8');
    assert(text.startsWith('\uFEFF'), '落盘的 CSV 也必须带 BOM');

    /**
     * 批次字段形状按设计稿 §5.2（控制者补充 A2）。
     * `questionIds` 故意留空：题单还没定，脚本不替人编。
     */
    const store = await openStore({ STORE: 'file', STORE_DIR: dir });
    const batch = await store.getBatch('bx');
    assert(batch, '批次必须已建好');
    assertEquals(batch.id, 'bx');
    assertEquals(batch.questionIds.length, 0, 'questionIds 留空由人工填');
    assertEquals(batch.ocrCap, 0);
    assertEquals(batch.dailyCap, 0);
    assertEquals(batch.idleMinutes, 8);
    assertEquals(batch.abandonHours, 24);
    assertEquals(batch.allowPhoto, false);
    /**
     * `versionSha` 取自 `git rev-parse --short HEAD`。取不到时脚本记 'unknown'
     * 而不是编一个 —— 本沙箱禁止脚本 spawn 子进程（EPERM），所以这里两种都接受。
     * 正常机器 / CI 上必然是真实 sha。
     */
    assert(
      /^([0-9a-f]{7,40}|unknown)$/.test(batch.versionSha),
      `versionSha 应是 git 短 sha 或 unknown，实际：${batch.versionSha}`,
    );
    assert(!Number.isNaN(Date.parse(batch.versionBuiltAt)), 'versionBuiltAt 应是时间戳');
    assert(!Number.isNaN(Date.parse(batch.createdAt)), 'createdAt 应是时间戳');

    rmSync(dir, { recursive: true, force: true });
  });

  it('CSV 写不出去时，错误必须说清"号已经进库了"（否则没人知道要清理）', async () => {
    /**
     * 这是发号里最难收尾的一种失败：明文口令只在那一次运行的 CSV 里，
     * 库里只有哈希。文件没写出去，口令就永远找不回来了，
     * 而这批代号已经被占住 —— 下次重跑会撞上"代号已存在"。
     * 所以错误必须把状态和下一步都说出来，而不是抛一个 EISDIR 了事。
     */
    const dir = tmpDir();
    let caught = null;
    try {
      // out 指向一个已存在的目录：mkdir 会过，写文件必失败
      await issueBatch({ batchId: 'bz', count: 1, out: dir, env: { STORE_DIR: dir } });
    } catch (err) {
      caught = err;
    }
    assert(caught, '写不进文件时必须抛错，不能假装成功');
    assertIncludes(caught.message, '已经写进库', `错误要说清库里已经有这批人了，实际：${caught.message}`);
    assertIncludes(caught.message, 'CSV', '错误要说清是哪一步失败');
    assertIncludes(caught.message, '重跑', '错误要给一句可操作的下一步');
    rmSync(dir, { recursive: true, force: true });
  });
});
