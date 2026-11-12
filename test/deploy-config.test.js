/**
 * 部署脚本（`scripts/deploy-cloudbase.mjs`）的默认值契约（Task 13 · B4，终审阻塞项）。
 *
 * ============================================================================
 * 为什么这一组盯的是"默认值"，而不是"脚本能跑"
 * ============================================================================
 * 这个脚本是云函数环境变量的**唯一来源**，而更新是**全量覆盖**：少推一个变量，
 * 云上那个就被删掉。所以它的默认值就是"一个照着 README 做的人最终会部署出的形状"。
 *
 * 上一版的默认值站在**不安全的那一侧**：
 *
 *   ① `PILOT_REQUIRE_LOGIN` 在"可选开关"里 —— 不配就不推，于是部署出来是一个
 *      **谁打开链接都能对话**的站点。它不会报错，老师只会以为学生是登录后进来的。
 *   ② `PILOT_CODE_PEPPER` 一个都**没有推**，而 `scripts/issue-accounts.mjs` 在本机
 *      用 `.env` 里的胡椒算哈希。两边不一致时，学生每一个口令都"不对" ——
 *      失败率 100%，而这看起来像"学生不会用"。
 *
 * 三条断言各自对应上面的一处：
 *   · 干跑输出里必须**显式写出** `PILOT_REQUIRE_LOGIN=1（未登录一律 401）`，
 *     因为读的人不会去翻代码确认"1"是什么意思；
 *   · `PILOT_CODE_PEPPER` 必须在**注入清单**里（缺了 `--apply` 就拒绝）；
 *   · 目标环境跑 cloudbase 而守卫解析不出 `1` 时，`--apply` 必须**拒绝执行**。
 *
 * 断言全部落在脚本导出的**纯函数**上：真跑一次 `tcb` 会改云上环境，
 * 而这一组要证明的恰恰是"还没跑之前就会被挡住"。
 *
 * ============================================================================
 * 为什么用 `await import(...).catch()`
 * ============================================================================
 * 静态 import 一个导不出这些名字的模块，会让整个套件在**加载阶段**就挂掉：
 * 一条用例都跑不起来，RED 只能证明"文件里没有这个名字"。这里把加载失败记下来
 * 交给第一条用例报出来（同 admin-api.test.js）。
 */

import { describe, it, assert, assertIncludes, assertNotIncludes, assertEquals } from './runner.js';

const loadErrors = [];
const deployModule = await import('../scripts/deploy-cloudbase.mjs').catch((err) => {
  loadErrors.push(err);
  return {};
});
const { collect, renderReport, loginGuardRefusal } = deployModule;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 在一份临时环境里跑一段。
 *
 * `collect()` 读 `process.env`（并顺手 `loadEnvFile()`，它只补**缺失**的键）。
 * 所以断言前必须把要判的那几个键**显式赋值**（哪怕是空串：空串也算"已存在"，
 * 于是本机 `.env` 里的真值不会盖进来），用完一律还原。
 */
async function withEnv(patch, fn) {
  const before = {};
  for (const [key, value] of Object.entries(patch)) {
    before[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 一个最小的 cloudbaserc 形状：脚本只从它取 envId（函数名由调用方另给） */
const CONFIG = { envId: 'env-test-1' };

/** 干跑那一整段输出（表 + 总数 + 缺件提示），不碰文件系统、不跑 tcb */
function dryRun(overrides = {}) {
  const collected = collect(CONFIG);
  return {
    collected,
    text: renderReport({ fnName: 'bubujie-api', apply: false, warnings: [], ...collected, ...overrides }),
  };
}

// ---------------------------------------------------------------------------
// 一、注入清单
// ---------------------------------------------------------------------------

describe('部署配置 · 注入清单', () => {
  it('脚本能加载（加载失败时这一条会指出真正的原因）', () => {
    assertEquals(loadErrors.length, 0, `deploy-cloudbase.mjs 加载失败：${loadErrors[0]?.message ?? ''}`);
  });

  it('PILOT_CODE_PEPPER 是必推的机密：缺了要进 missing（--apply 才会拒绝）', async () => {
    await withEnv({ PILOT_CODE_PEPPER: '' }, () => {
      const { collected } = dryRun();
      assert(
        collected.missing.includes('PILOT_CODE_PEPPER'),
        `PILOT_CODE_PEPPER 必须在缺件清单里，实际：${collected.missing.join('、') || '（空）'}`,
      );
    });
  });

  it('给了 PILOT_CODE_PEPPER 就真的推送（它是发号脚本算哈希用的那一个胡椒）', async () => {
    await withEnv({ PILOT_CODE_PEPPER: 'pepper-for-test' }, () => {
      const { collected } = dryRun();
      assertEquals(collected.envVariables.PILOT_CODE_PEPPER, 'pepper-for-test');
      assert(!collected.missing.includes('PILOT_CODE_PEPPER'), '给了就不该再报缺');
      /** 机密只出现在机密那一栏（打码），别不小心落到非机密表里 */
      assertEquals(collected.plain.PILOT_CODE_PEPPER, undefined, '胡椒不是非机密默认值');
    });
  });

  it('PILOT_REQUIRE_LOGIN 不是"可选开关"：默认值就是 1', async () => {
    await withEnv({ PILOT_REQUIRE_LOGIN: '' }, () => {
      const { collected } = dryRun();
      assertEquals(collected.plain.PILOT_REQUIRE_LOGIN, '1', '默认值必须站在安全的那一侧');
      assertEquals(collected.envVariables.PILOT_REQUIRE_LOGIN, '1');
      assertEquals(collected.optional.PILOT_REQUIRE_LOGIN, undefined, '它不再属于"只有配了才推"的那一类');
    });
  });
});

// ---------------------------------------------------------------------------
// 二、干跑输出：读的人看到的是什么
// ---------------------------------------------------------------------------

describe('部署配置 · 干跑输出', () => {
  it('显式写出 PILOT_REQUIRE_LOGIN=1（未登录一律 401）——不能只丢一个 1 让人猜', async () => {
    await withEnv({ PILOT_REQUIRE_LOGIN: '' }, () => {
      const { text } = dryRun();
      assertIncludes(text, 'PILOT_REQUIRE_LOGIN=1', '干跑必须把守卫的取值与含义都写出来');
      assertIncludes(text, 'PILOT_REQUIRE_LOGIN=1（未登录一律 401）');
    });
  });

  it('被 .env 改成 0 时，干跑也说清后果（这一行不是 1，--apply 会拒绝）', async () => {
    await withEnv({ PILOT_REQUIRE_LOGIN: '0' }, () => {
      const { collected, text } = dryRun();
      assertEquals(collected.plain.PILOT_REQUIRE_LOGIN, '0', '.env 里显式写的值优先');
      assertIncludes(text, 'PILOT_REQUIRE_LOGIN=0');
      assertIncludes(text, '拒绝', '0 不是"默认关一下"，而是"这批部署是敞开的"，干跑要说出来');
      assertNotIncludes(text, 'PILOT_REQUIRE_LOGIN=0（未登录一律 401）', '不能把 0 也说成 401');
    });
  });

  it('机密一律打码：干跑不打印 Key / 口令原文', async () => {
    await withEnv(
      { LLM_API_KEY: 'sk-very-secret-key-value', ADMIN_CODE: 'admin-pass-9', PILOT_CODE_PEPPER: 'pepper-for-test' },
      () => {
        const { text } = dryRun();
        assertNotIncludes(text, 'sk-very-secret-key-value');
        assertNotIncludes(text, 'admin-pass-9');
        assertNotIncludes(text, 'pepper-for-test');
        assertIncludes(text, 'PILOT_CODE_PEPPER');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 三、缺守卫时 --apply 必须拒绝
// ---------------------------------------------------------------------------

describe('部署配置 · 拒绝执行', () => {
  const envOf = (patch) => ({ STORE: 'cloudbase', PILOT_REQUIRE_LOGIN: '1', ...patch });

  it('目标跑 cloudbase 且守卫不是 1 → 给出一句拒绝理由', () => {
    const reason = loginGuardRefusal(envOf({ PILOT_REQUIRE_LOGIN: '0' }), { apply: true });
    assert(typeof reason === 'string' && reason.trim().length > 0, '缺守卫时必须拒绝，不能静默继续');
    assertIncludes(reason, 'PILOT_REQUIRE_LOGIN');
    assertIncludes(reason, '未登录');
  });

  it('守卫是 1、或目标不是 cloudbase、或只是干跑 → 不拒绝', () => {
    assertEquals(loginGuardRefusal(envOf({}), { apply: true }), null, '守卫开着就该放行');
    assertEquals(
      loginGuardRefusal(envOf({ STORE: 'file', PILOT_REQUIRE_LOGIN: '0' }), { apply: true }),
      null,
      '不是 cloudbase 的部署没有公网入口，不该被这条卡住',
    );
    assertEquals(loginGuardRefusal(envOf({ PILOT_REQUIRE_LOGIN: '0' }), { apply: false }), null, '干跑照常');
  });

  it('"1" 之外的任何写法都不算开（空白、true、yes 一律按没配处理）', () => {
    for (const value of ['', ' ', '0', 'true', 'yes', 'on']) {
      const reason = loginGuardRefusal(envOf({ PILOT_REQUIRE_LOGIN: value }), { apply: true });
      assert(typeof reason === 'string', `PILOT_REQUIRE_LOGIN=${JSON.stringify(value)} 必须被拒绝`);
    }
  });
});
