/**
 * 云数据库驱动（cloudbase）—— 只验"没装 SDK 时安全降级"，以及依赖该放在哪。
 *
 * ============================================================================
 * 为什么这个套件不连真库
 * ============================================================================
 * 试点环境是 CloudBase，但**这个仓库里不该有、也不会有那个 SDK**：
 * 根 `package.json` 的 `dependencies` 是 `{}`，这是产品前提（企业内网里
 * clone 下来 `node server/server.js` 就要能开）。SDK 只出现在
 * `dist-cloudbase/bubujie-api/package.json` 里，也就是云函数包那一份。
 *
 * 于是本地与 CI 永远走的是这条路：`STORE=cloudbase` 配上了，但 SDK 不在。
 * 它要的结果**不是崩**，而是退回内存驱动并留一句人看得懂的原因 ——
 * 否则"本地跑不起来"会被误读成"云驱动写错了"，而真实原因只是没装依赖。
 *
 * 【明确未验证】真连上云开发数据库的那条路（增删改查、分页、原子自增）这里一条都没测：
 * 没有测试环境，也不该在测试里连生产库。见任务报告"仍未验证"一节。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, assert, assertEquals, assertIncludes } from './runner.js';
import { openStore } from '../src/server/store/index.js';
import { ROOT } from '../src/core/env.js';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * 把 `console.warn` 收进数组再还给调用方。
 *
 * 为什么不留着它直接打到终端：降级日志是**证据**（要断言它确实是一句中文原因，
 * 而不是 Node 那句英文的 ERR_MODULE_NOT_FOUND），不是为了污染测试输出。
 */
async function captureWarn(fn) {
  const real = console.warn;
  const lines = [];
  console.warn = (msg) => lines.push(String(msg));
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.warn = real;
  }
}

describe('存储 · cloudbase 驱动在没装 SDK 时安全降级', () => {
  it('本地没装 @cloudbase/node-sdk 时，openStore 退回 memory 而不是崩', async () => {
    const { value: store } = await captureWarn(() => openStore({ STORE: 'cloudbase', TCB_ENV: 'x' }));
    assertEquals(store.kind, 'memory', '没装 SDK 必须安全降级，否则本地与 CI 全红');

    /**
     * 退回的那个 memory 必须是**能用的**驱动，而不是"kind 对、方法全抛"的壳子。
     * 只验一条写入 + 读取：证明降级之后账号、埋点这些功能照常可跑。
     */
    await store.putUser({ id: 'u1', codeHash: 'h1', displayName: '甲' });
    const got = await store.getUserById('u1');
    assertEquals(got?.displayName, '甲', '降级之后的驱动要能真的存东西');
  });

  it('降级时留一句可读的中文原因（不是静默退回，也不是 Node 的英文报错）', async () => {
    const { lines } = await captureWarn(() => openStore({ STORE: 'cloudbase', TCB_ENV: 'x' }));
    assertEquals(lines.length, 1, '只留一行，不刷屏');
    assertIncludes(lines[0], '退回内存', '日志要说清发生了什么');
    assertIncludes(lines[0], '@cloudbase/node-sdk', '日志要点名缺的是哪个包 —— 否则读者不知道该装什么');
    assertIncludes(lines[0], 'dist-cloudbase', '还要说清它本该在哪（只打进函数包），否则会被当成"仓库少了个依赖"');
  });

  it('配了 cloudbase 但没给环境 id 时，也退回 memory 并指出缺 TCB_ENV', async () => {
    /**
     * 这条不是重复：缺 TCB_ENV 是**配置错**，缺 SDK 是**预期**（本地就是不装）。
     * 两种都要能读出来，因为它们的下一步动作完全不同：一个去填环境变量，一个去云函数包部署。
     */
    const { value: store, lines } = await captureWarn(() => openStore({ STORE: 'cloudbase' }));
    assertEquals(store.kind, 'memory');
    assertIncludes(lines[0], 'TCB_ENV', '缺环境 id 时必须点名 TCB_ENV');
  });

  it('云 SDK 只写进云函数包，不写进根 package.json（零运行时依赖是产品前提）', () => {
    const rootManifest = JSON.parse(read('package.json'));
    const deps = rootManifest.dependencies ?? {};
    assertEquals(Object.keys(deps).length, 0, `根 package.json 的 dependencies 必须还是空的，实际 ${JSON.stringify(deps)}`);
    assert(
      !JSON.stringify(rootManifest).includes('@cloudbase/node-sdk'),
      '根清单里不该出现云 SDK —— 源码一律用动态 import() 懒加载',
    );

    /**
     * 依赖该在的地方：打包脚本写出的函数包清单。
     * 只读源码、不跑打包：跑一遍会重写 dist-cloudbase/，而测试不该改动工作树。
     */
    const build = read('scripts/build-cloudbase.mjs');
    assertIncludes(build, "'@cloudbase/node-sdk': '^3'", '打包脚本要给函数包写上云 SDK 的版本');
  });
});
