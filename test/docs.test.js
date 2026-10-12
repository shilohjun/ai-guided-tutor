/**
 * 文档与代码的一致性测试。
 *
 * ============================================================================
 * 为什么需要这个
 * ============================================================================
 * 写周报时我把"本周成果全景"列了 11 项新能力 ——
 * 读题链路、视图隔离、解析层、语音、符号输入……
 * **唯独漏掉了产品的三根柱子**：卡点分类体系、分层提示与两条硬护栏、防泄题的 7 类检查。
 *
 * 原因是我按"本轮新增"的视角去写，而这三项更早就完成了。
 * 结果是一份叫"成果全景"的表，让人以为这个产品的价值主要在那些新功能上 ——
 * 而它们是**描述性的事实错误**，不是排版问题。
 *
 * 靠人记得"别忘了写"是不可靠的。所以把这三项的**数量**钉在这里：
 * 从代码里实际数出来，再去文档里核对。
 * 以后谁加了第 8 类守卫检查、或者第 8 种卡点，这条测试会先失败，
 * 逼着文档同步 —— 而不是等下一次有人读周报时才发现对不上。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, assert, assertIncludes, totalRegistered } from './runner.js';
import { ROOT } from '../src/core/env.js';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** 从源码里数出真实的规模，而不是把数字写死在测试里 */
function actualCounts() {
  const types = read('src/core/types.ts');
  const stuckBlock = types.slice(types.indexOf('export type StuckKind ='));
  const stuckKinds = [...stuckBlock.slice(0, stuckBlock.indexOf(';')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

  const guard = read('src/core/guard.js');
  const guardFn = guard.slice(guard.indexOf('export function guard('));
  const guardChecks = [...guardFn.slice(0, guardFn.indexOf('if (violations.length')).matchAll(/\.\.\.(check[A-Za-z]+)\(/g)].map((m) => m[1]);

  const route = read('src/core/route.js');
  const hasRailingA = /禁止跳级/.test(route) && /reachable\s*\+\s*1/.test(route);
  const hasRailingB = /原地打转/.test(route) && /sameLevelSameStepCount/.test(route);

  const levels = ['L0', 'L1', 'L2', 'L3'].filter((l) => new RegExp(`\\b${l}\\b`).test(route));

  return { stuckKinds, guardChecks, hasRailingA, hasRailingB, levels };
}

describe('文档一致性 · 三根柱子必须与代码同步', () => {
  const counts = actualCounts();

  it('代码里确实是 7 种卡点、7 类守卫检查、4 个层级', () => {
    assert(
      counts.stuckKinds.length === 7,
      `卡点分类体系应当是 7 种，实际 ${counts.stuckKinds.length} 种：${counts.stuckKinds.join(', ')}`,
    );
    assert(
      counts.guardChecks.length === 7,
      `防泄题应当是 7 类检查，实际 ${counts.guardChecks.length} 类：${counts.guardChecks.join(', ')}`,
    );
    assert(counts.levels.length === 4, `提示层级应当是 L0–L3，实际 ${counts.levels.join('/')}`);
    assert(counts.hasRailingA, 'route.js 里应当有"禁止跳级"护栏（按连续前缀判断）');
    assert(counts.hasRailingB, 'route.js 里应当有"禁止原地打转"护栏');
  });

  it('周报的成果全景里必须有这三根柱子，且数量对得上', () => {
    const report = read('docs/周报.md');
    assertIncludes(report, '卡点分类体系', '周报漏了卡点分类体系');
    assertIncludes(report, '分层提示机制', '周报漏了分层提示机制');
    assertIncludes(report, '防泄题机制', '周报漏了防泄题机制');

    // 每一种卡点在周报里都要出现（否则分类体系被写残了）
    for (const kind of counts.stuckKinds) {
      assertIncludes(report, kind, `周报漏了卡点类型 ${kind}`);
    }
    // 每一类守卫检查都要出现
    for (const check of counts.guardChecks) {
      assertIncludes(report, check, `周报漏了守卫检查 ${check}`);
    }
    assertIncludes(report, '禁止跳级', '周报漏了护栏"禁止跳级"');
    assertIncludes(report, '禁止原地打转', '周报漏了护栏"禁止原地打转"');
  });

  it('README 也把这三根柱子讲清楚了（它是别人读到的第一份材料）', () => {
    const readme = read('README.md');
    for (const kind of counts.stuckKinds) {
      assertIncludes(readme, kind, `README 漏了卡点类型 ${kind}`);
    }
    for (const check of counts.guardChecks) {
      assertIncludes(readme, check, `README 漏了守卫检查 ${check}`);
    }
    assertIncludes(readme, '禁止跳级', 'README 漏了护栏"禁止跳级"');
    assertIncludes(readme, '禁止原地打转', 'README 漏了护栏"禁止原地打转"');
  });

  it('文档里写的用例数与真实数量一致（靠人记一定会忘）', () => {
    /**
     * 实测：README 里长期留着"182 个用例"，而当时已经是 214。
     * 这类数字没人会主动回头改，所以让测试去核对。
     *
     * 只在**全量跑**时核对：带过滤参数（`node test/run.js docs`）时只加载了一个套件，
     * 数量天然对不上 —— 那不是文档错了。全量跑是常规路径，也是 CI 的路径。
     */
    if (process.argv[2]) return;
    const total = totalRegistered();
    for (const [file, text] of [
      ['README.md', read('README.md')],
      ['docs/周报.md', read('docs/周报.md')],
    ]) {
      let checked = 0;
      for (const m of text.matchAll(/(\d+)\s*个(?:用例|测试)/g)) {
        /**
         * 两类数字不核对，因为它们在语义上就不是"当前总规模"：
         *
         * ① **区间里的历史值** —— 周报按轮次追加，像「测试 97 → 123 个用例」
         *    「本轮 152 → 182 个用例」，那是在记录**当时**的规模，本来就该是旧数字。
         * ② **单个套件的用例数** —— 像「`test/intake.test.js` 20 个用例」，
         *    它说的是那个套件有多少例，与总数无关。
         *
         * 排除这两类之后，剩下的都是"当前规模"的表述，必须等于真实总数。
         */
        const before = text.slice(Math.max(0, m.index - 4), m.index);
        if (/→|->/.test(before)) continue;
        const context = text.slice(Math.max(0, m.index - 40), m.index);
        if (/\.test\.js|test\/`/.test(context)) continue;
        checked += 1;
        const n = Number(m[1]);
        assert(n === total, `${file} 写的是 ${n} 个用例，实际注册了 ${total} 个 —— 数字该更新了`);
      }
      assert(checked > 0, `${file} 里应当有"当前规模"的用例数表述（不只是历史区间）`);
    }
  });
  it('接口契约文档里的守卫数量与代码一致（曾经写成"六类"，已更正）', () => {
    const contract = read('docs/01-hint-ontology-and-contract.md');
    assertIncludes(contract, '七类', '契约文档应写明七类检查');
    assert(!/六类检查/.test(contract), '契约文档里不该还留着"六类检查"的旧说法');
  });
});
