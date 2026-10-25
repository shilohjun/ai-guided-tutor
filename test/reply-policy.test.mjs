import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReplyFormat, countReplyChars } from '../src/core/response-policy.js';
import { composeStudentMessage, polishVoice } from '../src/core/prompt.js';
import { createEngine } from '../src/core/engine.js';
import { createOfflineAdapter, createOpenAIAdapter, normalizeObservation, buildDraftUserPrompt, DRAFT_SYSTEM_PROMPT } from '../src/core/llm.js';
import { getProblem } from '../src/core/problems.data.js';
import { decideLevel } from '../src/core/route.js';
import { guard } from '../src/core/guard.js';
const problem = getProblem('phy-emi-01');
const utterance = '我想用安培力，但是我不知道力的大小怎么求，只知道有安培力';
const request = { utterance, history: [], mode: 'ai_companion', explicitHelpSeeking: true };
const valid = { text: '先明确研究对象，再检查这一步涉及的量。当前只处理你提到的受力问题，保留后面的计算给你自己完成。', nextAsk: '研究对象受到的一个力叫什么？', concepts: ['安培力'] };
function adapterWithDraft(draft) {
  return { ...createOfflineAdapter(), kind: 'test-double', async draftHint(input) { return JSON.stringify(await draft(input)); } };
}
test('150字包含标签、公式、空格和标点，换行不计', () => {
  assert.equal(countReplyChars('提示：F=ma。\n试一试：a？'), 14);
  assert.equal(checkReplyFormat('物'.repeat(150)).passed, true);
  assert.equal(checkReplyFormat('物'.repeat(151)).passed, false);
});
test('多问句、四行和诊断复述不能出现在最终提示里', () => {
  for (const text of ['力是什么？加速度是什么？', '一\n二\n三\n四', '我理解你的意思是：不会。']) assert.equal(checkReplyFormat(text).passed, false);
});
test('不为凑够60字填充澄清，不删除公式限定条件', () => {
  const hint = { text: '质量不变时可用ΣF=ma；这里的F指合力。', nextAsk: '你指的是哪个物体？' };
  const message = composeStudentMessage({ restatement: '我理解你的意思是：很长的复述' }, hint);
  assert.ok(message.includes(hint.text));
  assert.ok(!message.includes('复述'));
  assert.equal(message.split('\n').length, 2);
});
test('哈勃与物理箭头不会被当作语气词和emoji误删', () => {
  assert.equal(polishVoice('哈勃定律中的方向→保留。').text, '哈勃定律中的方向→保留。');
});
test('证据不能只匹配前六个字、后半句却由模型编造', () => {
  const text = '我认为电流应该很小';
  const observation = normalizeObservation({ evidenceQuotes: ['我认为电流应该很大', '电流应该很小'] }, { problem, utterance: text });
  assert.deepEqual(observation.evidenceQuotes, ['电流应该很小']);
});
test('通用公式提醒可通过，题目禁区表达式仍拦截', () => {
  assert.equal(guard('恒定质量对象可用ΣF=ma，F表示合力。', problem, 1, {}).passed, true);
  assert.equal(guard('I=E/(R+r)', problem, 1, {}).passed, false);
});
test('draft实际接收上一轮提示和当前学生反馈', async () => {
  const result = await createEngine({ problem, adapter: createOfflineAdapter() }).handleTurn(request);
  const prompt = buildDraftUserPrompt({ problem, diagnosis: result.diagnosis, level: 2, allowedConcepts: [], forbidden: [], strategy: '补充变量含义', history: [{ role: 'ai', text: '上一轮只提到了受力方向' }], utterance: '我不会判断方向' });
  assert.ok(prompt.includes('上一轮只提到了受力方向'));
  assert.ok(prompt.includes('我不会判断方向'));
  assert.ok(!prompt.includes('内部校验码'));
});
test('nextAsk泄露答案时整条拒绝，重新生成，不沿用原先正文', async () => {
  let calls = 0;
  const adapter = adapterWithDraft(() => ++calls === 1 ? { ...valid, nextAsk: '电动势为0.4 V，你明白了吗？' } : valid);
  const result = await createEngine({ problem, adapter }).handleTurn(request);
  assert.equal(calls, 2);
  assert.ok(result.meta.guardHistory.some(g => !g.passed));
  assert.ok(!result.message.includes('0.4 V'));
  assert.ok(result.message.includes(valid.nextAsk));
});
test('正文未超限但加上下一步超150字，必须完整重新生成', async () => {
  let calls = 0;
  const adapter = adapterWithDraft(() => ++calls === 1 ? { ...valid, text: '研究对象'.repeat(30), nextAsk: '请说明你选择研究对象的原因，并给出一条相关的题干条件作为判断依据。' } : valid);
  const result = await createEngine({ problem, adapter }).handleTurn(request);
  assert.equal(calls, 2);
  assert.ok(countReplyChars(result.message) <= 150);
  assert.ok(result.message.includes(valid.text));
});
test('无效JSON不作为正文直接展示', async () => {
  let calls = 0;
  const adapter = { ...adapterWithDraft(() => valid), async draftHint() { return ++calls === 1 ? '模型无效输出：直接当正文' : JSON.stringify(valid); } };
  const result = await createEngine({ problem, adapter }).handleTurn(request);
  assert.equal(calls, 2);
  assert.ok(!result.message.includes('模型无效输出'));
});
test('观察故障不伪造学生卡点、不修改历史', async () => {
  const history = [{ role: 'student', text: '之前的真实步骤' }];
  const engine = createEngine({ problem, adapter: { ...createOfflineAdapter(), async observeStudent() { throw new Error('模拟网络故障'); } } });
  await assert.rejects(engine.handleTurn({ ...request, history }), { code: 'OBSERVATION_UNAVAILABLE', statusCode: 503 });
  assert.equal(history.length, 1);
});
const diagnosis = { sufficientInfo: true, stuckKind: 'direction_lost', position: { graphId: 'a', stepIndex: 2, confidence: 0.9 }, misconceptions: [] };
const turn = (level, overrides = {}) => ({ role: 'ai', level, metaStep: 2, metaGraphId: 'a', metaStuckKind: 'direction_lost', ...overrides });
const decide = history => decideLevel({ problem, diagnosis, history, mode: 'ai_companion', explicitHelpSeeking: true });
test('只有相同路径、步骤和卡点已交付提示才能支持升级', () => {
  assert.equal(decide([turn(1), turn(2)]).level, 3);
  for (const overrides of [{ metaStep: 1 }, { metaGraphId: 'b' }, { metaStuckKind: 'knowledge_gap' }]) assert.equal(decide([turn(1, overrides), turn(2, overrides)]).level, 1);
});
test('确认、拒绝、静默和兜底不能支撑升级', () => {
  for (const overrides of [{ form: 'confirm' }, { form: 'refusal' }, { form: 'fallback' }, { suppressed: true }]) assert.equal(decide([turn(1, overrides), turn(2, overrides)]).level, 1);
});
test('自主训练信息不足或高置信卡点均不能主动提示', () => {
  for (const sufficientInfo of [true, false]) {
    const result = decideLevel({ problem, diagnosis: { ...diagnosis, sufficientInfo, misconceptions: [{ confidence: 0.99 }] }, history: [], mode: 'self_training', explicitHelpSeeking: false });
    assert.equal(result.suppressed, true);
  }
});
test('示例JSON与运行时结构保持一致', () => {
  const examples = [...DRAFT_SYSTEM_PROMPT.matchAll(/^\{"text":.*$/gm)].map(match => JSON.parse(match[0]));
  assert.equal(examples.length, 3);
  for (const example of examples) {
    const message = composeStudentMessage({}, example);
    assert.ok(checkReplyFormat(message).passed);
    assert.ok(countReplyChars(message) >= 60 && countReplyChars(message) <= 100);
  }
});
test('模拟真实协议：即使JSON完整，finish_reason=length也不能采纳', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(valid) }, finish_reason: 'length' }] }) });
  try {
    const adapter = createOpenAIAdapter({ available: true, apiKey: 'test-only', baseUrl: 'https://example.invalid', model: 'test', timeoutMs: 1000 });
    const res = await createEngine({ problem, adapter: createOfflineAdapter() }).handleTurn(request);
    await assert.rejects(adapter.draftHint({ problem, diagnosis: res.diagnosis, level: 1, allowedConcepts: [], forbidden: [], history: [] }), error => error.truncated === true);
  } finally { globalThis.fetch = savedFetch; }
});
test('模拟真实协议：无效观察字段不能被转换成学生未形成思路', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }) });
  try {
    const adapter = createOpenAIAdapter({ available: true, apiKey: 'test-only', baseUrl: 'https://example.invalid', model: 'test', timeoutMs: 1000 });
    await assert.rejects(createEngine({ problem, adapter }).handleTurn(request), { code: 'OBSERVATION_UNAVAILABLE' });
  } finally { globalThis.fetch = savedFetch; }
});
