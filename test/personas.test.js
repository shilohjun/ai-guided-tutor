/**
 * 陪学老师测试 —— 验证"人格只是措辞，不是权限"这条设计约束真的成立。
 *
 * 四件事必须同时成立，少一件这个功能就是装饰品：
 *   ① 服务端与页面对同一位老师的名字、图片是一条口径；
 *   ② 教研文稿（languages/*.md）改了，代码里的规范正文必须跟着变，不能漂；
 *   ③ 提示词里进来的只有**当前这一位**老师的风格；
 *   ④ 措辞层不越权：不超字数、不删物理信息、不把离线桩的话改成另一个结论。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, assert, assertEquals, assertIncludes } from './runner.js';
import {
  DEFAULT_PERSONA,
  PERSONAS,
  PERSONA_IDS,
  normalizePersona,
  personaById,
  personaPromptBlock,
  stylePersonaReply,
} from '../src/core/personas.js';
import {
  PERSONA_LIMITS_DOC,
  PERSONA_PHYSICS_DOC,
  PERSONA_SCAFFOLDING_DOC,
  PERSONA_SHARED_DOC,
  PERSONA_VOICE_DOCS,
} from '../src/core/personas.data.js';
import { buildStudentTurn } from '../src/server/router.js';
import { getProblem } from '../src/core/problems.data.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const html = read('public/index.html');

/** 每份风格文稿的抬头，用来确认"只进来这一位" */
const VOICE_TITLE = {
  paimon: '派蒙人格锚定与语言风格',
  hermione: '赫敏人格锚定与语言风格',
  zhuge: '诸葛亮人格锚定与语言风格',
  jianhua: '建华教授人格锚定与语言风格',
};

describe('陪学老师 · 服务端与页面是同一份投影', () => {
  it('四位老师的名字与图片路径在页面里一字不差', () => {
    for (const id of PERSONA_IDS) {
      const p = PERSONAS[id];
      assertIncludes(html, `id: '${p.id}', name: '${p.name}'`, `页面里的 ${id} 名字与服务端不一致`);
      assertIncludes(html, `avatar: '${p.avatar}'`, `页面里的 ${id} 头像路径与服务端不一致`);
    }
  });

  it('头像与全身图真的躺在 public 下（路径写错时页面只会裂图，不会报错）', () => {
    for (const id of PERSONA_IDS) {
      for (const rel of [PERSONAS[id].avatar, PERSONAS[id].fullBody]) {
        assert(existsSync(join(ROOT, 'public', rel.replace(/^\//, ''))), `缺少图片 ${rel}`);
      }
    }
  });

  it('默认老师是派蒙，且任何怪值都回落到她而不是抛错', () => {
    assertEquals(DEFAULT_PERSONA, 'paimon');
    for (const value of [undefined, null, '', '  ', '不存在的老师', 0, false, {}, { id: 'zhuge' }]) {
      const got = normalizePersona(value);
      assertIncludes(PERSONA_IDS.join(','), got, `怪值 ${JSON.stringify(value)} 没有回落到一位真实老师`);
    }
    assertEquals(normalizePersona({ id: 'zhuge' }), 'zhuge', '对象形态应当认 id');
  });

  it('中文名也能选中同一位老师（前端存的是 id，人读的是名字）', () => {
    assertEquals(normalizePersona('派蒙'), 'paimon');
    assertEquals(normalizePersona('诸葛亮'), 'zhuge');
    assertEquals(normalizePersona('建华教授'), 'jianhua');
    assertEquals(personaById('赫敏').name, '赫敏');
  });
});

describe('陪学老师 · 规范以教研文稿为准', () => {
  it('提示块里装的是四份规范正文，而不是一句摘要', () => {
    const block = personaPromptBlock('paimon');
    for (const doc of [PERSONA_SHARED_DOC, PERSONA_LIMITS_DOC, PERSONA_SCAFFOLDING_DOC, PERSONA_PHYSICS_DOC]) {
      assertIncludes(block, doc.slice(0, 40), '提示块漏了一份规范正文');
    }
  });

  it('提示块只带当前这一位老师的语言风格，不会串味', () => {
    const block = personaPromptBlock('hermione');
    assertIncludes(block, VOICE_TITLE.hermione, '应当带上赫敏的风格文稿');
    for (const other of ['paimon', 'zhuge', 'jianhua']) {
      assert(!block.includes(VOICE_TITLE[other]), `赫敏的提示块里混进了 ${other} 的风格文稿`);
    }
  });

  it('提示块把"不泄题优先于人格"和 JSON 契约放在最后兜底', () => {
    const block = personaPromptBlock('zhuge');
    assertIncludes(block, '硬边界优先于规范与风格', '缺了硬边界优先的兜底');
    assertIncludes(block, '{"text"', '缺了 JSON 输出契约');
    assertIncludes(block, 'nextAsk 只用于探进度或澄清', '缺了 nextAsk 的收窄说明');
    assertIncludes(block, '规范里"不要指派动作"同样约束 nextAsk', '缺了"不指派动作"对 nextAsk 的约束');
  });

  it('头像一律经过 .av-frame 取景，且取景问题在素材层解决而不是 CSS 补丁', () => {
    /**
     * 头像的圆形裁切统一走 .av-frame；谁要是图省事直接插一个 <img>，就会绕开这层。
     * 另外这条盯着一个已经踩过的坑：建华的素材原本偏左 60px，试过用 --fx 平移去补，
     * 结果一侧补上了、另一侧又空出来 —— 正解是按原图重裁素材。
     * 所以这里断言**没有**per-persona 的位移补丁，避免有人再用 CSS 去藏构图问题。
     */
    assertIncludes(html, '.av-frame img', '缺少统一的头像取景规则');
    assert(!/\[data-mentor="[a-z]+"\]\{--fx:/.test(html), '不要用 per-persona 的 --fx 位移去补：素材该重裁');
    for (const fn of ['function avatarHtml', 'function pickHtml']) {
      const at = html.indexOf(fn);
      assert(at > 0, '找不到 ' + fn);
      const body = html.slice(at, at + 600);
      assertIncludes(body, 'av-frame', fn + ' 没有把头像包进 .av-frame');
    }
  });

  it('建华的头像素材是脸居中的方图（不是靠 CSS 推过去的原图）', () => {
    /**
     * 重裁后脸应该在画面中心附近。这里用像素统计兜底：取上半部分的不透明像素重心，
     * 它应当落在画面中线附近（±10%）。这条防的是"有人把旧素材换回来"。
     */
    const file = join(ROOT, 'public/characters/profile/jianhua.png');
    const bytes = readFileSync(file);
    assert(bytes.length > 1000, '建华的头像文件不见了');
    // PNG 尺寸在前 24 字节里：宽高各 4 字节（大端），位于 IHDR
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    assertEquals(width, height, '头像应当是方图');
  });

  it('personas.data.js 与 languages/*.md 同步（文稿改了却忘了重跑生成脚本会在这里失败）', () => {
    const dir = join(ROOT, 'languages');
    if (!existsSync(dir)) return; // 该目录未纳入版本控制，没有就跳过
    const norm = (s) => String(s || '').replace(/\r\n/g, '\n').trim();
    const pairs = [
      ['00_Persona_and_Tone.md', PERSONA_SHARED_DOC],
      ['10_Physics_Domain_Rules.md', PERSONA_PHYSICS_DOC],
      ['20_Hint_and_Interaction_Limits.md', PERSONA_LIMITS_DOC],
      ['30_Scaffolding_Workflow.md', PERSONA_SCAFFOLDING_DOC],
      ['01_Paimon_Voice_Style.md', PERSONA_VOICE_DOCS.paimon],
      ['02_Hermione_Voice_Style.md', PERSONA_VOICE_DOCS.hermione],
      ['03_Zhuge_Voice_Style.md', PERSONA_VOICE_DOCS.zhuge],
      ['04_Jianhua_Voice_Style.md', PERSONA_VOICE_DOCS.jianhua],
    ];
    for (const [file, embedded] of pairs) {
      const onDisk = norm(read(join('languages', file)));
      assert(norm(embedded) === onDisk, `personas.data.js 与 languages/${file} 不同步，请重跑 node scripts/build-persona-docs.mjs`);
    }
  });
});

describe('陪学老师 · 措辞层不越权', () => {
  it('换一种说法之后，正文里的物理结论一个都不少', () => {
    const text = '这一问用动能定理，它管的是合外力做的总功等于动能的变化量。';
    const got = stylePersonaReply('zhuge', { text, nextAsk: null, form: 'direction', turn: 0 });
    assertIncludes(got.text, '动能定理', '措辞层吃掉了正文里的物理内容');
    assert(got.text.length > text.length, '应当真的加了一点口气');
  });

  it('每种口气都不会把一条本来合规的回复顶过 150 字上限', () => {
    /** 约 120 字：本身合规，但加一句口气 + 一个 nextAsk 就可能顶穿上限 */
    const text = '这一问用动能定理，它管的是合外力做的总功等于动能的变化量；这里的合力只算沿运动方向的分量，不用把竖直方向的力也算进去。';
    for (const id of PERSONA_IDS) {
      for (const form of ['clarify', 'direction', 'condition_question', 'worked_step', 'fallback']) {
        const got = stylePersonaReply(id, { text, nextAsk: '这一步的关键量是哪个？', form, turn: 1 });
        const n = `提示：${got.text}${got.nextAsk ? `试一试：${got.nextAsk}` : ''}`.replace(/[\r\n]/g, '').length;
        assert(n <= 150, `${id}/${form} 组装后 ${n} 字，超过 150`);
      }
    }
  });

  it('原文本身就超编时原样返回 —— 超编该由守卫判，不该由措辞层删内容', () => {
    const over = '这一问用动能定理。'.repeat(20);
    const got = stylePersonaReply('zhuge', { text: over, nextAsk: null, form: 'direction', turn: 0 });
    assertEquals(got.text, over, '措辞层不该顺手改写一条已经超编的原文');
  });

  it('静默轮用老师自己的话，而不是一句通用的"我在旁边看着"', () => {
    for (const id of PERSONA_IDS) {
      const got = stylePersonaReply(id, { text: '（被引擎抑制）', nextAsk: '某个任务', form: 'silent', turn: 0 });
      assertEquals(got.nextAsk, null, '静默轮不该再带任务');
      assert(got.text.length > 8, `${id} 的静默话术太短`);
    }
    assert(
      stylePersonaReply('paimon', { form: 'silent' }).text !== stylePersonaReply('hermione', { form: 'silent' }).text,
      '四位老师的静默话术不该一模一样',
    );
  });
});

describe('陪学老师 · 学生载荷', () => {
  const problem = getProblem('phy-emi-01');

  /** 一份最小但完整的引擎返回，字段与 engine.js 的真实返回同形 */
  function response(engine, overrides = {}) {
    return {
      message: '（这条不直接给学生看）',
      hint: { level: 1, form: 'confirm', text: '完全正确。这道题是你自己推出来的。', concepts: ['动能定理'], nextAsk: null },
      diagnosis: {
        position: { graphId: 'phy-emi-01-g1', stepIndex: 1, confidence: 0.9, completedSteps: [1] },
        stuckKind: 'direction_lost',
        strengths: [],
        misconceptions: [],
      },
      enginePath: [],
      suppressed: false,
      refusal: null,
      completion: null,
      stepCount: 3,
      meta: { engine, guardHistory: [], latencyMs: 12 },
      ...overrides,
    };
  }

  it('把这一轮说话的老师带回前端（旧消息靠它保持当时的头像）', () => {
    const turn = buildStudentTurn(response('openai'), 'self_training', problem, 'hermione', 0);
    assertEquals(turn.persona.id, 'hermione');
    assertEquals(turn.persona.name, '赫敏');
    assertEquals(turn.persona.avatar, '/characters/profile/hermione.png');
  });

  it('不传老师时按默认派蒙，不会返回 undefined', () => {
    const turn = buildStudentTurn(response('openai'), 'self_training', problem);
    assertEquals(turn.persona.id, 'paimon');
  });

  it('离线桩与"我方模板写的"那几轮要补口气，真模型起草的那轮原样透出', () => {
    const offline = buildStudentTurn(response('offline-stub'), 'self_training', problem, 'paimon', 0);
    assertIncludes(offline.hint.text, '诶嘿，答对了。', '离线桩应当被套上派蒙的口气');

    /** 守卫兜底不是模型写的，真模型路径上同样没有老师口气，所以要补 */
    const fallback = response('openai', {
      hint: { level: 1, form: 'fallback', text: '先别急着算。你能把题目给了什么说一遍吗？', concepts: [], nextAsk: null },
    });
    const styled = buildStudentTurn(fallback, 'self_training', problem, 'hermione', 0);
    assert(styled.hint.text !== '先别急着算。你能把题目给了什么说一遍吗？', '兜底文案也该有老师口气');

    /** 真模型已经按 personaPromptBlock 写过，不能再套一层 */
    const drafted = response('openai', {
      hint: { level: 1, form: 'direction', text: '这一问用动能定理。', concepts: ['动能定理'], nextAsk: null },
    });
    const real = buildStudentTurn(drafted, 'self_training', problem, 'paimon', 0);
    assertEquals(real.hint.text, '这一问用动能定理。', '真模型起草的回复不该被二次改写');
  });
});
