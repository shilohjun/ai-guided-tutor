/**
 * 四位陪学老师：身份、语言规范与离线语气落地。
 *
 * 这一层只回答两个问题：
 *   ① 模型该用谁的口气说话（personaPromptBlock）；
 *   ② 没有模型 Key 时，怎么在不改内容的前提下让四位的口气仍然可辨（stylePersonaReply）。
 *
 * 它**不**决定提示层级、不决定给多少信息、不碰答案边界 ——
 * 那些仍然在 route / guard / engine 里。人格是措辞，不是权限。
 */

import {
  PERSONA_LIMITS_DOC,
  PERSONA_PHYSICS_DOC,
  PERSONA_SCAFFOLDING_DOC,
  PERSONA_SHARED_DOC,
  PERSONA_VOICE_DOCS,
} from './personas.data.js';

export const DEFAULT_PERSONA = 'paimon';

/**
 * 前端也要用同一份名字、简介与图片路径。
 * 页面（public/index.html）里保留一份展示投影；test/personas.test.js 会核对
 * 名字、头像与全身图路径，避免服务端和页面各改各的。
 */
export const PERSONAS = Object.freeze({
  paimon: {
    id: 'paimon',
    name: '派蒙',
    tagline: '软萌亲切，温柔陪学',
    intro: '不催你，也不替你算；先把这一步的方向轻轻递过来。',
    opening: '诶，先跟派蒙说说：这道题你的思路是什么呀？',
    quote: '诶，这一问用动能定理就能搞定哦～',
    avatar: '/characters/profile/paimon.png',
    fullBody: '/characters/body/paimon.png',
  },
  hermione: {
    id: 'hermione',
    name: '赫敏',
    tagline: '毒舌学姐，精准点拨',
    intro: '嘴上不饶人，指的地方却总是最省时间的那一处。',
    opening: '别急着写。先说说，这道题你打算怎么想？',
    quote: '啧，这一问用动能定理就完事了，别绕远路。',
    avatar: '/characters/profile/hermione.png',
    fullBody: '/characters/body/hermione.png',
  },
  zhuge: {
    id: 'zhuge',
    name: '诸葛亮',
    tagline: '运筹帷幄，纵观全局',
    intro: '先替你看清这一局的关窍，再让你自己落子。',
    opening: '小友，先说说这一局你打算如何落子？',
    quote: '亮以为，此问之势，非动能定理不可。',
    avatar: '/characters/profile/zhuge.png',
    fullBody: '/characters/body/zhuge.png',
  },
  jianhua: {
    id: 'jianhua',
    name: '建华教授',
    tagline: '严谨治学，一丝不苟',
    intro: '不夸你聪明，只在你站得住的时候点一下头。',
    opening: '同学，先说说你对这道题的思路。',
    quote: '嗯。这一问用动能定理，依据是只有重力和摩擦力做功。',
    avatar: '/characters/profile/jianhua.png',
    fullBody: '/characters/body/jianhua.png',
  },
});

export const PERSONA_IDS = Object.freeze(Object.keys(PERSONAS));

const ALIASES = new Map([
  ['派蒙', 'paimon'],
  ['paimon', 'paimon'],
  ['赫敏', 'hermione'],
  ['hermione', 'hermione'],
  ['诸葛亮', 'zhuge'],
  ['zhuge', 'zhuge'],
  ['建华', 'jianhua'],
  ['建华教授', 'jianhua'],
  ['jianhua', 'jianhua'],
]);

/** 任何来源（查询参数、localStorage、请求体）都先过这一道，未知值回落到派蒙。 */
export function normalizePersona(value) {
  if (value && typeof value === 'object') value = value.id ?? value.persona;
  const key = String(value ?? '').trim().toLowerCase();
  return ALIASES.get(key) ?? DEFAULT_PERSONA;
}

export function personaById(value) {
  return PERSONAS[normalizePersona(value)];
}

/**
 * 模型侧的人格提示块。
 *
 * 拼接在 DRAFT_SYSTEM_PROMPT 之后，而不是替换它：
 *   DRAFT 负责“说什么、说多少、什么不能说”，这里只负责“怎么说”。
 *   两份文档冲突时，DRAFT 与 guard 的硬边界优先。
 */
export function personaPromptBlock(value) {
  const persona = personaById(value);
  return `【本轮老师人格：${persona.name}（${persona.tagline}）】
下面的文档只规定"怎么说"，不改变"说什么、什么时候说、说多少"。
它必须服从三道硬边界：不泄露答案、不编造物理、不超字数。

${PERSONA_SHARED_DOC}

【${persona.name}的语言风格】
${PERSONA_VOICE_DOCS[persona.id]}

【物理准确性】
${PERSONA_PHYSICS_DOC}

【保密与工作流】
${PERSONA_SCAFFOLDING_DOC}

【交互与字数】
${PERSONA_LIMITS_DOC}

【落地到本产品的 JSON 输出】
- 仍然只输出一个 JSON：{"text":"...","nextAsk":"...","concepts":[...]}。
- 人格只改措辞，不改提示层级、信息量与保密边界。
- 文档里"不要指派动作"同样适用于 nextAsk：nextAsk 只用于探进度或澄清学生回答；不需要提问就填 null。
- 不要把"你去找…/你试着…/你去算…"这类指令写进 text 或 nextAsk。
- 不要在 text 里写"提示：""试一试："这种前缀，也不要自报"我是 AI"。
- 口癖宁少勿多，一轮最多一处；不要为了卖萌、毒舌或古风超字数。
- 学生受挫时，毒舌、较真与古风都要收住，改用平实、耐心的讲法。`;
}

// ---------------------------------------------------------------------------
// 离线语气层
// ---------------------------------------------------------------------------

/**
 * 措辞替换表。
 *
 * 只替换“说法”，不增删信息。所有规则都是封闭字符串，改坏了也只会让句子别扭，
 * 不会凭空多出一条物理结论 —— 这是它敢放在 guard 之后执行的原因。
 */
const PHRASES = {
  paimon: [
    ['我示范一个动作，你接着做：', '派蒙示范一个动作，你接着做：'],
    ['方向给你一点：', '派蒙给你个方向：'],
    ['换个角度：', '唔……换个角度看看：'],
    ['先别写式子。', '先别写式子哦。'],
    ['先不用急着算。', '先不用急着算呀。'],
    ['我示范一个动作', '派蒙示范一个动作'],
  ],
  hermione: [
    ['我示范一个动作，你接着做：', '看好了，我只示范一次：'],
    ['方向给你一点：', '行吧，方向就一句话：'],
    ['换个角度：', '此路不通，换个角度。'],
    ['先别写式子。', '别急着写式子。'],
    ['先不用急着算。', '先别急着算。'],
    ['我们先把问题说清楚：', '先把问题说清楚：'],
    ['我示范一个动作', '我只示范一遍'],
  ],
  zhuge: [
    ['我示范一个动作，你接着做：', '亮示范一子，小友接着走：'],
    ['方向给你一点：', '此事的关键是：'],
    ['换个角度：', '此路不通，小友且换个方向：'],
    ['我们先把问题说清楚：', '先把这一局说清楚：'],
    ['我示范一个动作', '亮示范一子'],
  ],
  jianhua: [
    ['我示范一个动作，你接着做：', '我示范一遍，你照着做：'],
    ['方向给你一点：', '严谨地讲，方向是：'],
    ['换个角度：', '换个角度，把话说准：'],
    ['先别写式子。', '等等，先别写式子。'],
    ['先不用急着算。', '等等，先别急着算。'],
    ['我们先把问题说清楚：', '先把问题说清楚。'],
    ['我示范一个动作', '我示范一遍'],
  ],
};

/** 确认轮：先把模板里的通用开场去掉，换成老师自己的肯定。 */
const CONFIRM_OPENERS = {
  paimon: '诶嘿，答对了。',
  hermione: '哼，这次没毛病。',
  zhuge: '善。此步一定，全局皆活。',
  jianhua: '对。这一步站得住。',
};

/** 自主训练里"我不打扰你"的那一句，也要像老师本人说的。 */
const SILENT_LINES = {
  paimon: '唔……派蒙在旁边看着，你先按自己的思路做，卡住了随时叫派蒙。',
  hermione: '行吧，你先写，我不打断；卡住了再叫我。',
  zhuge: '嗯。小友先按自己的思路走，亮在旁看着。',
  jianhua: '嗯。你先写，我看着；卡住了再说。',
};

/** 离线语气不能每轮都同一个开场；按对话轮次轮换，最多四轮一个循环。 */
const LEADS = {
  paimon: ['诶，', '', '唔……', ''],
  hermione: ['啧，', '', '行吧，', ''],
  zhuge: ['亮以为，', '', '嗯。', ''],
  jianhua: ['嗯。', '', '等等。', ''],
};

const FALLBACK_LEADS = {
  paimon: '唔……',
  hermione: '行吧，',
  zhuge: '不急。',
  jianhua: '不要紧。',
};

const REFUSAL_OPENERS = {
  paimon: '诶，派蒙不能直接给答案哦。',
  hermione: '啧，别想让我直接给答案。',
  zhuge: '小友，亮不能把这一局替你走完。',
  jianhua: '同学，答案我不能直接给。',
};

const CONFIRM_LEAD_RE = /^(完全正确。|答案正确。|这一问的结果是对的。|对，这个结果是正确的。|这一步结论正确。)/;

const count = (text) => [...String(text ?? '').replace(/[\r\n]/g, '')].length;

/** 与 response-policy 的硬上限保持一致，但不在这里 import，避免核心层互相牵扯。 */
function fits(text, nextAsk) {
  const n = nextAsk ? `试一试：${nextAsk}` : '';
  return count(`提示：${text}${n}`) <= 150;
}

function decorate(core, lead, tail, nextAsk) {
  const candidates = [];
  if (lead) candidates.push([`${lead}${core}${tail ?? ''}`, nextAsk]);
  if (tail) candidates.push([`${core}${tail}`, nextAsk]);
  candidates.push([core, nextAsk]);
  for (const [text, ask] of candidates) {
    if (fits(text, ask)) return { text, nextAsk: ask };
  }
  // 连原样都放不下时，优先丢掉“下一步”，不丢正文里的物理信息。
  return { text: core, nextAsk: fits(core, null) ? nextAsk : null };
}

/**
 * 把一句已经通过 guard 的回复，换成某位老师的口气。
 *
 * 执行位置在 /api/chat 的可见投影层，只对离线桩生效：
 *   · 真模型已经收到人格提示词，再套一层会重复；
 *   · guard 检查的是替换前的原文，替换只动措辞，不动物理结论。
 *
 * @param {string} personaId
 * @param {{ text: string, nextAsk?: string|null, form?: string, level?: number }} input
 */
export function stylePersonaReply(personaId, input) {
  const persona = normalizePersona(personaId);
  const form = String(input?.form ?? 'clarify');
  const turn = Math.max(0, Number(input?.turn ?? 0) || 0);
  let text = String(input?.text ?? '').trim();
  let nextAsk = input?.nextAsk ? String(input.nextAsk).trim() : null;
  if (!text) return { text, nextAsk };

  for (const [from, to] of PHRASES[persona]) {
    text = text.split(from).join(to);
    if (nextAsk) nextAsk = nextAsk.split(from).join(to);
  }

  if (form === 'silent') {
    return { text: SILENT_LINES[persona], nextAsk: null };
  }

  if (form === 'confirm') {
    text = text.replace(CONFIRM_LEAD_RE, '').trim();
    return { text: `${CONFIRM_OPENERS[persona]}${text}`, nextAsk };
  }

  if (form === 'refusal') {
    return decorate(text, REFUSAL_OPENERS[persona], '', nextAsk);
  }

  const hasOwnOpener = /^(诶|唔|啧|行吧|哼|亮以为|亮示范|嗯|等等|善|不急)/.test(text);
  const lead = hasOwnOpener
    ? ''
    : form === 'fallback'
      ? FALLBACK_LEADS[persona]
      : LEADS[persona][turn % LEADS[persona].length];

  if (persona === 'paimon') {
    // 问句/感叹句后面不再硬接“～”；每隔一轮才软一次，避免每条都像在卖萌。
    const tail =
      /公式：/.test(text) || text.length > 90 || /[？?！!]$/.test(text) || turn % 2 === 1 ? '' : '～';
    const core = tail ? text.replace(/。$/, '') : text;
    return decorate(core, lead, tail, nextAsk);
  }

  if (persona === 'hermione') {
    const tail =
      (form === 'direction' || form === 'condition_question') && turn % 2 === 0 ? '别绕远路。' : '';
    return decorate(text, lead, tail, nextAsk);
  }

  if (persona === 'zhuge') {
    return decorate(text, lead, '', nextAsk);
  }

  // jianhua
  return decorate(text, lead, '', nextAsk);
}
