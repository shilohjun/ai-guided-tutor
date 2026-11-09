/**
 * 四位陪学老师：谁在说话，以及说话的依据在哪。
 *
 * 这一层只回答两个问题：
 *   ① 模型该按哪一套规范、用谁的口气说话（personaPromptBlock）；
 *   ② 没有模型 Key 时，怎么在不改内容的前提下让四位仍然能听出区别（stylePersonaReply）。
 *
 * 它**不**决定提示层级、不决定给多少信息、不碰答案边界 ——
 * 那些在 route / guard / engine 里。人格是措辞，不是权限。
 *
 * 规范正文不写在这个文件里：教研维护在 `languages/*.md`，
 * 由 `scripts/build-persona-docs.mjs` 编译成 `personas.data.js`。
 * 这样"教研改稿"和"程序逻辑"是两件事，改稿不必碰代码。
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
 *
 * `quote` 与 `voiceSample` 只进提示词做口吻锚点，**不作为开场消息显示**——
 * 产品上决定进对话页不主动说话（自主训练不该一进来就被打断），
 * 所以它们的作用是让模型"听见"这位老师怎么开口，而不是替她开口。
 */
export const PERSONAS = Object.freeze({
  paimon: {
    id: 'paimon',
    name: '派蒙',
    tagline: '软萌亲切，温柔陪学',
    intro: '不催你，也不替你算；先把这一步的方向轻轻递过来。',
    quote: '诶，这一问用动能定理就能搞定哦～',
    voiceSample: '诶，先跟派蒙说说：这道题你的思路是什么呀？',
    avatar: '/characters/profile/paimon.png',
    fullBody: '/characters/body/paimon.png',
  },
  hermione: {
    id: 'hermione',
    name: '赫敏',
    tagline: '毒舌学姐，精准点拨',
    intro: '嘴上不饶人，指的地方却总是最省时间的那一处。',
    quote: '啧，这一问用动能定理就完事了，别绕远路。',
    voiceSample: '别急着写。先说说，这道题你打算怎么想？',
    avatar: '/characters/profile/hermione.png',
    fullBody: '/characters/body/hermione.png',
  },
  zhuge: {
    id: 'zhuge',
    name: '诸葛亮',
    tagline: '运筹帷幄，纵观全局',
    intro: '先替你看清这一局的关窍，再让你自己落子。',
    quote: '亮以为，此问之势，非动能定理不可。',
    voiceSample: '小友，先说说这一局你打算如何落子？',
    avatar: '/characters/profile/zhuge.png',
    fullBody: '/characters/body/zhuge.png',
  },
  jianhua: {
    id: 'jianhua',
    name: '建华教授',
    tagline: '严谨治学，一丝不苟',
    intro: '不夸你聪明，只在你站得住的时候点一下头。',
    quote: '嗯。这一问用动能定理，依据是只有重力和摩擦力做功。',
    voiceSample: '同学，先说说你对这道题的思路。',
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

/** 任何来源（请求体、localStorage、查询参数）都先过这一道，未知值回落到派蒙。 */
export function normalizePersona(value) {
  if (value && typeof value === 'object') value = value.id ?? value.persona;
  const key = String(value ?? '').trim().toLowerCase();
  return ALIASES.get(key) ?? DEFAULT_PERSONA;
}

export function personaById(value) {
  return PERSONAS[normalizePersona(value)];
}

/**
 * 模型侧的人格与规范提示块。
 *
 * 分工刻意做成两层：
 *   llm.js 的 DRAFT_SYSTEM_PROMPT  只写"不能做什么 + 怎么输出"（硬边界与 JSON 契约）；
 *   这里写"该怎么做 + 谁在说"（教研的四份规范 + 这位老师的语言风格）。
 *
 * 之所以把规范正文放在人格块而不是主提示词里：四份规范是教研的稿子，
 * 它必须能独立改、独立替换，而不是混在一段写死的提示词中间。
 */
export function personaPromptBlock(value) {
  const persona = personaById(value);
  return `【本轮说话的老师：${persona.name}（${persona.tagline}）】

下面是本产品的《教学规范》。它就是规范正文，「说什么、什么时候说、说多少」以它为准；
本提示词其余部分只补充两件事：输出格式，以及不泄题的硬边界。

${PERSONA_SHARED_DOC}

${PERSONA_LIMITS_DOC}

${PERSONA_SCAFFOLDING_DOC}

${PERSONA_PHYSICS_DOC}

【${persona.name}的语言风格】
以下只规定"怎么说"，不改变上面已经规定的"说什么、什么时候说、说多少"。
风格与规范冲突时，以规范为准；规范与硬边界冲突时，以硬边界为准。

${PERSONA_VOICE_DOCS[persona.id]}

【${persona.name}的口吻锚点】
下面是这位老师说话的样本。风格文稿有上万字，模型容易只读到"设定"而写不出"口气"，
所以在提示词最后再放两三句原文样本 —— 位置靠后，权重也靠后。
- ${persona.quote}
- ${persona.voiceSample}

【与本产品输出格式的接缝】
- 只输出一个 JSON：{"text":"...","nextAsk":null,"concepts":[...]}，不要输出 JSON 以外的任何内容。
- 层级由系统在用户消息里指定：L0 澄清 / L1 方向 / L2 公式或条件补课 / L3 排障聚焦。
  它对应规范里的「第 0/1/2/3 类」，不能自行升级，也不能降级。
- nextAsk 只用于探进度或澄清学生刚说的话。规范里"不要指派动作"同样约束 nextAsk：
  没有要问的填 null，不要为了填满而编一个任务出来。
  **text 里已经有问号时，nextAsk 必须为 null** —— 整条回复只允许一个问号。
- 规范给的篇幅上限优先于风格：人格措辞计入字数，写超了删风格，不许删物理信息。
- 硬边界优先于规范与风格：任何一处冲突，先满足不泄题、不编造、不超篇幅。
- 口癖宁少勿多，一轮最多一处；不要自报"我是 AI"，也不要解释自己在扮演谁。
- 学生受挫、连续卡住或情绪低落时，先收住毒舌、较真与古风，改用平实耐心的讲法。`;
}

// ---------------------------------------------------------------------------
// 离线语气层
// ---------------------------------------------------------------------------

/**
 * 离线桩的说法改写。
 *
 * 只在离线引擎上执行：真模型已经收到了上面的规范与风格，再套一层会重复。
 * 这里改的全是"怎么说"，一条物理结论都不增删 —— 这是它敢放在 guard 之后执行的原因。
 * 句首与句尾都按字数上限自动退让，退到最后一定保留原文。
 */

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

/** 离线语气不能每轮都同一个开场；按轮次轮换，最多四轮一个循环。 */
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

/** 确认轮的通用开场，先剥掉再换成老师自己的。 */
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
  // 连原样都放不下时，优先丢掉"下一步"，不丢正文里的物理信息。
  return { text: core, nextAsk: fits(core, null) ? nextAsk : null };
}

/**
 * 把一句已经通过 guard 的回复，换成某位老师的口气。
 *
 * 执行位置在 /api/chat 的可见投影层，只对离线桩生效。
 * guard 检查的是替换前的原文；这里只动措辞，不动物理结论。
 *
 * @param {string} personaId
 * @param {{ text: string, nextAsk?: string|null, form?: string, level?: number, turn?: number }} input
 */
export function stylePersonaReply(personaId, input) {
  const persona = normalizePersona(personaId);
  const form = String(input?.form ?? 'clarify');
  const turn = Math.max(0, Number(input?.turn ?? 0) || 0);
  let text = String(input?.text ?? '').trim();
  const nextAsk = input?.nextAsk ? String(input.nextAsk).trim() : null;

  /**
   * 静默要排在"没有正文"之前：被引擎抑制的那一轮本来就没有正文，
   * 而"我不打扰你"这句话恰恰是这一轮唯一的可见输出。
   */
  if (form === 'silent') {
    return { text: SILENT_LINES[persona], nextAsk: null };
  }
  if (!text) return { text, nextAsk };

  /**
   * 原文本身就超编时，原样返回。
   * 超编该由 guard / response-policy 判，不该由措辞层顺手"帮忙改成不超" ——
   * 那样等于在可见投影层悄悄删掉了物理信息。
   */
  if (!fits(text, nextAsk)) return { text, nextAsk };

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
    // 问句/感叹句后面不再硬接"～"；每隔一轮才软一次，避免每条都像在卖萌。
    const tail =
      /公式：/.test(text) || text.length > 90 || /[？?！!]$/.test(text) || turn % 2 === 1 ? '' : '～';
    const core = tail ? text.replace(/。$/, '') : text;
    return decorate(core, lead, tail, nextAsk);
  }

  return decorate(text, lead, '', nextAsk);
}
