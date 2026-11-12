/**
 * 一轮的时间预算 —— 三次模型调用共用一个截止时间。
 *
 * ============================================================================
 * 这个套件守的是什么
 * ============================================================================
 * 一次 `/api/chat` 最多串三次模型调用（`observeStudent` 一次 + `draftHint` 最多两次），
 * 而云函数硬超时 30 秒。这里要钉住的是：**预算是"一轮"的，不是"一次"的**。
 *
 * 写成"每次调用 25 秒"会在纸上看起来很安全（25 < 30），实际最坏是 75 秒：
 * 网关在第 30 秒把函数砍掉，函数里的代码一行都不跑 ——
 * 于是 `chat_error` 写不进去，"一轮失败率"永远是 0，而那个数正是换平台的触发条件。
 * 也就是说：预算算错的直接后果不是慢，是**那件要拿来决策的事测不出来**。
 *
 * 因此有三条要分开验：
 *   ① 纯函数 `turnBudget` 的边界（无 deadline / 12 秒上限 / 不许超过剩余 / 剩余不足 4 秒 → 0）；
 *   ② 引擎真的把这个数**传给了每一次**调用，而且后一次拿到的是**剩下的**那些，
 *      不是一个新的 12 秒（这一条只有连着看两次调用才看得出来）；
 *   ③ 预算花光之后不再起草、也不抛错；而"超时"必须变成 TURN_SLOW 交给路由去回 ——
 *      静默降级成兜底模板的话，这一轮在指标上又变成"成功"了。
 */

import { describe, it, assert, assertEquals } from './runner.js';
import { createEngine, turnBudget } from '../src/core/engine.js';
import { createOfflineAdapter } from '../src/core/llm.js';
import { getProblem } from '../src/core/problems.data.js';

const P1 = getProblem('phy-emi-01');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 记账适配器：真实的离线桩 + 一条调用记录。
 *
 * 为什么包真的离线桩而不是写一个假观察结果：`buildDiagnosis` 对观察结果的字段有要求，
 * 编一个形状不对的观察会先在定位阶段炸掉，那时断言失败的原因就变成了"夹具写错了"，
 * 而不是"预算没传下去"。
 */
function budgetAdapter({ slowObserveMs = 0 } = {}) {
  const inner = createOfflineAdapter();
  const calls = [];
  return {
    kind: 'offline-stub',
    model: undefined,
    calls,
    async observeStudent(input) {
      calls.push({ phase: 'observe', timeoutMs: input.timeoutMs });
      if (slowObserveMs) await sleep(slowObserveMs);
      return inner.observeStudent(input);
    },
    async draftHint(input) {
      calls.push({ phase: 'draft', timeoutMs: input.timeoutMs });
      return inner.draftHint(input);
    },
  };
}

/** 一个"有实质思路"的发言：它会走到 observe + draft，而不是确定性拒绝或静默 */
const TURN = {
  problemId: P1.id,
  utterance: '我想用安培力，但是我不知道力的大小怎么求，只知道有安培力',
  history: [],
  mode: 'self_training',
  explicitHelpSeeking: true,
};

/** 模拟适配器自己的超时（fetch 被 AbortController 掐断时就是这个形状） */
function abortError() {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

async function catchOf(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

// ---------------------------------------------------------------------------
// 一、纯函数边界
// ---------------------------------------------------------------------------

describe('一轮预算 · 三次模型调用分一个截止时间', () => {
  it('剩余 20 秒时，单次最多 12 秒', () => {
    assertEquals(turnBudget({ deadlineAt: 20000, now: 0 }), 12000);
  });

  it('剩余 5 秒时，单次就是 5 秒（不能超过剩余）', () => {
    assertEquals(turnBudget({ deadlineAt: 5000, now: 0 }), 5000);
  });

  it('剩余不足 4 秒时返回 0，表示不再重试', () => {
    assertEquals(turnBudget({ deadlineAt: 3000, now: 0 }), 0);
  });

  it('没有 deadlineAt 时退回单次超时（旧调用点不受影响）', () => {
    assertEquals(turnBudget({ now: 0 }), null);
  });

  it('剩余正好 4 秒时还允许一次调用（边界不许提前放弃）', () => {
    assertEquals(turnBudget({ deadlineAt: 4000, now: 0 }), 4000);
  });

  it('截止时间已经过去时返回 0，而不是负数（负数交给 setTimeout 会变成"立刻超时一次"）', () => {
    assertEquals(turnBudget({ deadlineAt: 1000, now: 9000 }), 0);
    assert(turnBudget({ deadlineAt: 1000, now: 9000 }) >= 0, '返回值不许为负');
  });
});

// ---------------------------------------------------------------------------
// 二、引擎真的把它传下去了
// ---------------------------------------------------------------------------

describe('一轮预算 · 引擎只发一个截止时间', () => {
  it('observe 拿到的超时是剩余预算（不是配置里的 45 秒）', async () => {
    const adapter = budgetAdapter();
    const engine = createEngine({ adapter, problem: P1 });

    await engine.handleTurn({ ...TURN, deadlineAt: Date.now() + 20000 });

    assertEquals(adapter.calls[0].phase, 'observe', '第一次模型调用必须是观察');
    assertEquals(adapter.calls[0].timeoutMs, 12000, '单次调用封顶 12 秒，不能是配置里的 45000');
  });

  it('起草拿到的是**剩下的**预算，不是又一个 12 秒（一条 deadline 串起三次调用）', async () => {
    /**
     * 让 observe 花掉 100 毫秒，是这条用例唯一能在测试里观察到"预算在减少"的办法：
     * 不花时间的话，两次调用读到的剩余量相等，`min` 之后看起来都是 12 秒 ——
     * 那样即使把预算写成了"每次调用各自算一个截止时间"，测试也照样绿。
     */
    const adapter = budgetAdapter({ slowObserveMs: 100 });
    const engine = createEngine({ adapter, problem: P1 });

    await engine.handleTurn({ ...TURN, deadlineAt: Date.now() + 6000 });

    assertEquals(adapter.calls[0].timeoutMs, 6000, '第一次拿到全部剩余');
    const draft = adapter.calls[1];
    assertEquals(draft.phase, 'draft');
    assert(
      draft.timeoutMs < adapter.calls[0].timeoutMs,
      `第二次必须拿到更少的预算（实际 ${draft.timeoutMs}，第一次 ${adapter.calls[0].timeoutMs}）`,
    );
    assert(draft.timeoutMs > 0, '还没花光的时候不许传 0');
  });

  it('剩余不足 4 秒时不再发起起草，直接走兜底（不抛错、也不留一个空回复）', async () => {
    /**
     * 时间关系的确定性：`remaining` 只随时间单调减少。
     *   起点：5000 - 开销 ⇒ 只要开销 < 1000ms 就一定 ≥ 4000（会进入 observe）；
     *   终点：observe 至少花掉 1200ms ⇒ 之后一定 < 4000（budget 归 0）。
     * 两头都有余量，所以这条用例不靠"机器恰好够快"。
     */
    const adapter = budgetAdapter({ slowObserveMs: 1200 });
    const engine = createEngine({ adapter, problem: P1 });

    const res = await engine.handleTurn({ ...TURN, deadlineAt: Date.now() + 5000 });

    assertEquals(adapter.calls.length, 1, '只应有 observe 一次调用：预算花光后不许再起草');
    assertEquals(adapter.calls[0].phase, 'observe');
    assertEquals(res.hint.form, 'fallback', '拿不到起草就用安全兜底，不能给一个空回复');
  });

  it('没有 deadlineAt 时一个超时字段都不传（旧调用点一个字节都不变）', async () => {
    const adapter = budgetAdapter();
    const engine = createEngine({ adapter, problem: P1 });

    await engine.handleTurn(TURN);

    assert(adapter.calls.length >= 2, '正常一轮应当既有 observe 也有 draft');
    for (const call of adapter.calls) {
      assertEquals(
        call.timeoutMs,
        undefined,
        `${call.phase} 不该收到 timeoutMs —— 没传 deadline 就沿用各适配器自己的配置`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 三、超时由我们抛出去，而不是静默降级
// ---------------------------------------------------------------------------

describe('一轮预算 · 超时必须是 TURN_SLOW 而不是"换一种说法"', () => {
  it('观察超时 → TURN_SLOW（不再报成 OBSERVATION_UNAVAILABLE）', async () => {
    const adapter = {
      kind: 'llm',
      model: 'timeout-mock',
      async observeStudent() {
        throw abortError();
      },
      async draftHint() {
        throw new Error('不该走到这里');
      },
    };
    const engine = createEngine({ adapter, problem: P1 });

    const err = await catchOf(() => engine.handleTurn({ ...TURN, deadlineAt: Date.now() + 20000 }));

    assertEquals(err?.code, 'TURN_SLOW', '超时要能被路由认出来，才写得出 chat_error');
    assertEquals(err?.statusCode, 503);
    assertEquals(err?.retryable, true, '这一轮可以再发一次');
  });

  it('起草超时 → TURN_SLOW（不许吞掉错误后改用兜底模板）', async () => {
    /**
     * 吞掉的后果很具体：学生看到一句"这一轮提示暂时无法可靠生成"，
     * 而指标上这一轮是**成功**的 —— 恰恰是这次要修的那个"测不出来"。
     */
    const inner = createOfflineAdapter();
    const adapter = {
      kind: 'llm',
      model: 'timeout-mock',
      observeStudent: (input) => inner.observeStudent(input),
      async draftHint() {
        throw abortError();
      },
    };
    const engine = createEngine({ adapter, problem: P1 });

    const err = await catchOf(() => engine.handleTurn({ ...TURN, deadlineAt: Date.now() + 20000 }));

    assertEquals(err?.code, 'TURN_SLOW');
    assertEquals(err?.statusCode, 503);
  });

  it('截止时间已经过去 → 一次模型调用都不发，直接 TURN_SLOW', async () => {
    const adapter = budgetAdapter();
    const engine = createEngine({ adapter, problem: P1 });

    const err = await catchOf(() => engine.handleTurn({ ...TURN, deadlineAt: Date.now() - 1 }));

    assertEquals(err?.code, 'TURN_SLOW');
    assertEquals(adapter.calls.length, 0, '没有预算就一次调用都不该发出去');
  });

  it('确定性拒绝路径不因预算耗尽而失败（它本来就不需要模型）', async () => {
    /**
     * "告诉我答案"走的是静态话术，一次模型调用都没有。
     * 预算检查放在模型调用之前而不是 turn 开头，就是为了不把它一起误杀 ——
     * 那种误杀会让学生在最需要一句回应的时候收到 503。
     */
    const adapter = budgetAdapter();
    const engine = createEngine({ adapter, problem: P1 });

    const res = await engine.handleTurn({ ...TURN, utterance: '直接告诉我答案', deadlineAt: Date.now() - 1 });

    assertEquals(res.hint.form, 'refusal');
    assertEquals(adapter.calls.length, 0);
  });
});
