/**
 * 升级决策测试 —— 验证"AI 不自己决定给几级提示"这条设计约束真的成立。
 * 这些用例直接对应路演时最容易被质疑的几个问题：
 *   "学生一喊难，会不会直接给答案？"        → 禁止跳级测试
 *   "学生都快想通了，会不会反而剧透？"       → 已完成/尝试中抑制升级测试
 *   "自主训练模式下会不会乱插话？"           → 静默观测测试
 */

import { describe, it, assert, assertEquals } from './runner.js';
import { decideLevel, buildStrategy, buildForbidden, route } from '../src/core/route.js';
import { getProblem } from '../src/core/problems.data.js';

const P1 = getProblem('phy-emi-01');

function diag({ stepIndex = 3, confidence = 0.9, stuckKind = 'direction_lost', mis = [] } = {}) {
  return {
    position: { graphId: 'phy-emi-01-g1', stepIndex, confidence, completedSteps: [], divergedAt: [] },
    feasibility: 'partially_viable',
    misconceptions: mis,
    stuckKind,
    evidenceQuotes: ['我不知道力怎么求'],
    restatement: '',
    trace: [],
  };
}

function turn(role, text, level = null, metaStep = null) {
  return { role, text, at: new Date().toISOString(), level, metaStep };
}

describe('路由 · 首次求助从最低层级开始', () => {
  it('无历史时给 L1 而不是 L3', () => {
    const d = decideLevel({
      problem: P1,
      diagnosis: diag(),
      history: [],
      explicitHelpSeeking: true,
      mode: 'ai_companion',
    });
    assertEquals(d.level, 1, '首次提示必须是 L1 条件追问');
  });
});

describe('路由 · 禁止跳级', () => {
  it('学生反复喊难也不能一次跳到 L3', () => {
    const d = decideLevel({
      problem: P1,
      diagnosis: diag(),
      history: [
        turn('student', '不会'),
        turn('ai', '提示1', 1, 3),
        turn('student', '还是不会'),
      ],
      explicitHelpSeeking: true,
      mode: 'ai_companion',
    });
    assertEquals(d.level, 2, '只能从 L1 升到 L2');
  });

  it('已给过 L1、L2 后才允许 L3', () => {
    const d = decideLevel({
      problem: P1,
      diagnosis: diag(),
      history: [
        turn('ai', '提示1', 1, 3),
        turn('ai', '提示2', 2, 3),
        turn('student', '还是不会'),
      ],
      explicitHelpSeeking: true,
      mode: 'ai_companion',
    });
    assertEquals(d.level, 3, '满足前置条件后才允许 L3');
  });

  it('历史里只有 L2 没有 L1 时（异常数据）应回退', () => {
    const d = decideLevel({
      problem: P1,
      diagnosis: diag(),
      history: [turn('ai', '提示2', 2, 3), turn('student', '还是不会')],
      explicitHelpSeeking: true,
      mode: 'ai_companion',
    });
    assert(d.level <= 2, `不应越过 L1，实际 L${d.level}`);
  });
});

describe('路由 · 抑制过度帮助', () => {
  it('学生表示"我试试"时不应升级', () => {
    const d = decideLevel({
      problem: P1,
      diagnosis: diag(),
      history: [turn('ai', '提示1', 1, 3), turn('student', '我试试')],
      explicitHelpSeeking: false,
      mode: 'ai_companion',
    });
    assertEquals(d.level, 1, '学生正在尝试，应维持在 L1');
  });

  it('学生已走到末段且无错因 ⇒ 不给提示', () => {
    const d = decideLevel({
      problem: P1,
      diagnosis: diag({ stepIndex: 8, stuckKind: 'finished' }),
      history: [],
      explicitHelpSeeking: true,
      mode: 'ai_companion',
    });
    assert(d.suppressed, '应抑制输出');
    assertEquals(d.level, null);
  });

  it('自主训练模式 + 未求助 + 无高置信卡点 ⇒ 静默', () => {
    const d = decideLevel({
      problem: P1,
      diagnosis: diag({ confidence: 0.5 }),
      history: [],
      explicitHelpSeeking: false,
      mode: 'self_training',
    });
    assert(d.suppressed, '自主训练模式应保持静默');
  });

  it('自主训练模式 + 高置信卡点 ⇒ 允许一次介入', () => {
    const d = decideLevel({
      problem: P1,
      diagnosis: diag({
        confidence: 0.9,
        mis: [{ id: 'm-ignore-equilibrium', label: '忽略平衡条件', evidence: '不知道力怎么求', confidence: 0.9 }],
      }),
      history: [],
      explicitHelpSeeking: false,
      mode: 'self_training',
    });
    assert(!d.suppressed, '高置信卡点应允许介入');
    assertEquals(d.level, 1);
  });

  it('定位置信度过低时退到 L1 以确认位置', () => {
    const d = decideLevel({
      problem: P1,
      diagnosis: diag({ confidence: 0.2 }),
      history: [turn('ai', '提示1', 1, 3), turn('ai', '提示2', 2, 3), turn('student', '还是不会')],
      explicitHelpSeeking: true,
      mode: 'ai_companion',
    });
    assertEquals(d.level, 1, '低置信度时应退到 L1');
  });
});

describe('路由 · 执行错误不应有捷径', () => {
  it('思路对但算错 ⇒ 首次仍从 L1 自查邀请开始，不直接给 L3', () => {
    // 早期版本给执行错误开了"可直接 L3"的特例。
    // 那是一条捷径：学生只要声称"我算错了"就能拿到最强提示。
    // 现在统一从 L1 开始。
    const d = decideLevel({
      problem: P1,
      diagnosis: diag({ stuckKind: 'execution_error' }),
      history: [],
      explicitHelpSeeking: true,
      mode: 'ai_companion',
    });
    assertEquals(d.level, 1, '执行错误应从 L1 开始');
  });

  it('执行错误的 L1 使用"邀请自查"策略而不是"条件追问"', () => {
    const s = buildStrategy('execution_error', 1);
    assertEquals(s.key, 'self_check_invitation');
  });

  it('执行错误连续追问后仍按常规递进（可到 L3）', () => {
    const d = decideLevel({
      problem: P1,
      diagnosis: diag({ stuckKind: 'execution_error' }),
      history: [turn('ai', '提示1', 1, 3), turn('ai', '提示2', 2, 3), turn('student', '还是不会')],
      explicitHelpSeeking: true,
      mode: 'ai_companion',
    });
    assertEquals(d.level, 3, '走完 L1、L2 后应可到 L3');
  });
});

describe('路由 · 策略与禁止项', () => {
  it('precondition_gap 在 L1 使用条件追问策略', () => {
    const s = buildStrategy('precondition_gap', 1);
    assertEquals(s.key, 'condition_question');
  });

  it('not_started 在所有层级都只做澄清（不给物理方向）', () => {
    for (const level of [0, 1, 2, 3]) {
      const s = buildStrategy('not_started', level);
      assertEquals(s.key, 'clarify_goal_and_knowns', `L${level} 应保持澄清策略`);
    }
  });

  it('禁止项必须包含数值结果与收口句式', () => {
    const f = buildForbidden(P1, diag());
    assert(f.some((x) => x.includes('数值结果')), '必须禁止数值结果');
    assert(f.some((x) => x.includes('收口句式')), '必须禁止收口句式');
  });

  it('route() 被抑制时返回空策略而不是给个默认层级', () => {
    const r = route({
      problem: P1,
      diagnosis: diag({ stepIndex: 8, stuckKind: 'finished' }),
      history: [],
      explicitHelpSeeking: true,
      mode: 'ai_companion',
    });
    assert(r.suppressed, '应抑制');
    assertEquals(r.level, null, '抑制时 level 必须为 null');
    assertEquals(r.allowedConcepts.length, 0);
  });
});
