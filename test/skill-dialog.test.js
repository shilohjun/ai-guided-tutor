/**
 * 最新对话 skill 的对话契约。
 *
 * 这一组守的是用户实际看到的那几句话：
 *   - 学生说"不知道这道题要干什么"，AI 不能还在问"这道题给了哪些条件"；
 *   - 学生答"是电功率"，AI 不能静默成"我在旁边看着"；
 *   - 学生点名"我想先算电动势"，AI 要接住这个量，而不是继续讲上一问。
 */

import { describe, it, assert, assertIncludes, assertNotIncludes } from './runner.js';
import { createEngine } from '../src/core/engine.js';
import { createOfflineAdapter } from '../src/core/llm.js';
import { getProblemById } from '../src/core/registry.js';

const P1 = getProblemById('phy-emi-01');

function push(history, student, res) {
  history.push({ role: 'student', text: student, at: '' });
  history.push({
    role: 'ai',
    text: res.hint.text,
    at: '',
    level: res.hint.level,
    metaStep: res.diagnosis.position.stepIndex,
    metaGraphId: res.diagnosis.position.graphId,
    metaStuckKind: res.diagnosis.stuckKind,
    form: res.hint.form,
  });
}

async function turn(student, history = []) {
  const engine = createEngine({ adapter: createOfflineAdapter(), problem: P1 });
  const res = await engine.handleTurn({
    problemId: P1.id,
    utterance: student,
    history,
    mode: 'self_training',
    explicitHelpSeeking: false,
    persona: 'paimon',
  });
  return res;
}

describe('最新 skill · 老师先问思路，再按学生的话接', () => {
  it('学生说"不知道这道题要干什么"：先摆出待求量，再问先做哪一个', async () => {
    const res = await turn('我不知道这道题要干什么');
    assertIncludes(res.hint.text, '感应电动势', '应把题目要的量说清楚');
    assertIncludes(res.hint.text, '先', '应把选择权交回学生');
    assertNotIncludes(res.hint.text, '给了哪些条件', '不能退回旧的"列条件"话术');
    assert(res.hint.nextAsk == null, '新规范不再附加"试一试"任务');
  });

  it('学生问"这一步该用哪条规律"但还没说哪一问：先问清是哪一问', async () => {
    const history = [];
    const first = await turn('我不知道这道题要干什么', history);
    push(history, '我不知道这道题要干什么', first);
    const res = await turn('这一步该用哪条规律', history);
    assertIncludes(res.hint.text, '做到哪一步', '没有定位时应先问进度，而不是让学生自选一个量');
    assertNotIncludes(res.hint.text, '这一问用这一步', '不能生成空泛的占位话术');
  });

  it('学生答"是电功率"：指出题目问的是外力功率，而不是静默', async () => {
    const history = [];
    const first = await turn('我不知道这道题要干什么', history);
    push(history, '我不知道这道题要干什么', first);
    const res = await turn('是电功率', history);
    assert(!res.suppressed, '老师问完思路后，学生的回答必须被接住');
    assertIncludes(res.hint.text, '外力做功的功率', '应纠正成题目真正问的量');
    assertNotIncludes(res.hint.text, '我在旁边看着', '不能把回答当成"没在求助"而静默');
  });

  it('学生点名"我想先算电动势"：方向要落在电动势这一步', async () => {
    const history = [];
    const first = await turn('我不知道这道题要干什么', history);
    push(history, '我不知道这道题要干什么', first);
    const res = await turn('我想先算电动势，但不知道用什么公式', history);
    assertIncludes(res.hint.text, '电动势', '应接住学生点名的量');
    assertIncludes(res.hint.text, '切割磁感线', '应给电动势这一步的方向');
    assertNotIncludes(res.hint.text, '你去找', '方向之后不追加动作指令');
    assertNotIncludes(res.hint.text, '你试着', '方向之后不追加动作指令');
  });
});
