/**
 * 学生可见消息的组装。
 *
 * 为什么把"组装"单独抽出来：
 *   提示文本本身合格，不等于"学生看到的整条消息"合格。
 *   复述、提示、下一步动作三段拼在一起后可能出现
 *   ① 语义重复（复述已经问了问题，提示又问一遍）
 *   ② 语气割裂（复述很长、提示很短）
 *   ③ 隐性泄题（复述里带出了诊断细节，如"你错在没检查前提"——  这等于告诉了他一部分答案）
 *   因此组装层也要做一次约束检查：诊断细节不出现在学生可见文本里。
 *
 * 这里还多了一道 **voice 关**（见 polishVoice）：
 *   守卫保证"不说答案"，voice 关保证"说的是有用的话"。
 *   两者都是确定性的，都不依赖模型自觉。
 */

import { normalize } from './text.js';
import { findUnstatedAnswers } from './verify.js';

/** 诊断内部信息中绝不能出现在学生可见文本里的措辞 */
const INTERNAL_LEAK_MARKERS = [
  '错因',
  'misconception',
  '卡点性质',
  'confidence',
  '置信',
  '定位到第',
  '路径图谱',
  'precondition_gap',
  'direction_lost',
  'execution_error',
  'knowledge_gap',
  'dead_end_path',
  // 下列是"教师视图 / 教研侧"的术语。它们本身不含答案，
  // 但一旦出现在学生消息里，学生就会开始反推系统在给他打标签。
  '答案指纹',
  '指纹',
  '教研标签',
  '教研视图',
  'referenceAnswer',
  '守门',
];

/**
 * 空话黑名单。
 *
 * 为什么要把"鼓励"也列进黑名单：
 *   一个卡住的学生收到的如果是"加油""相信你可以的"，
 *   他的真实感受是"这个 AI 没话可说"。
 *   空洞的鼓励与泄题是两种相反的失败，但都让产品失去可信度。
 *   因此这类话由代码直接删掉，而不是靠提示词里写一句"不要空话"。
 */
const VOICE_HYPE = [
  '加油',
  '相信你',
  '你可以的',
  '你真棒',
  '很棒',
  '别灰心',
  '不要气馁',
  '继续努力',
  '保持耐心',
  '仔细想想',
  '再仔细想想',
  '注意审题',
  '认真读题',
  '好好想想',
  '动动脑筋',
  '你一定行',
  '老师相信',
  '很简单',
  '显而易见',
  // 夸张与卖萌：资深教师不会这么说话
  '超级',
  '非常非常',
  '太棒了',
  '好厉害',
  '棒极了',
  '完美',
  '绝了',
  '无敌',
  'yyds',
];

/**
 * 语气词与拟声词 —— 直接删字符，不删整句。
 *
 * 与 VOICE_HYPE 的处理方式刻意不同：
 *   夸张词通常自成一个小句（"加油，你可以的"），连句删掉是干净的；
 *   而语气词是**句尾助词**（"我们先列一下啦"），删掉整句会丢掉有效信息，
 *   只需要把那个字去掉。
 *
 * 注意不包含「吗」「呢」—— 它们是正常的疑问助词，删了会破坏提问。
 */
const VOICE_PARTICLES = ['啦', '呀', '哦', '噢', '嗯', '哈', '诶', '哎', '唉', '咯', '嘛'];

/** 常见 emoji / 颜文字区间（按码点区间删，不逐个列举） */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;

/**
 * 说话方式把关（确定性）。
 *
 * 做三件事：
 *   ① 删掉空话与空洞鼓励；
 *   ② 收敛重复标点（"？？"→"？"）；
 *   ③ 标记"一句话里问了两个问题"—— 不擅自改写（会破坏语义），
 *      只把它报出来，让教师视图能看到"这句提示学生不知道该先答哪个"。
 *
 * 为什么不在这里自动删掉多余的问句：
 *   自动删问句很容易把"先确认 A，再想想 B？"改成一句没有落点的陈述句。
 *   宁可如实记录，也不做会改变语义的自动改写。
 *
 * @param {string} text
 * @returns {{ text: string, removed: string[], multiQuestion: boolean }}
 */
export function polishVoice(text) {
  let out = String(text ?? '');
  const removed = [];

  // ---- ① 空话与夸张：连所在小句一起删 ----
  for (const bad of VOICE_HYPE) {
    if (!out.includes(bad)) continue;
    removed.push(bad);
    const clauseRe = new RegExp(`[^，。；！？!?;\\n]{0,12}${escapeRe(bad)}[^，。；！？!?;\\n]{0,12}[，,、]?`, 'g');
    const next = out.replace(clauseRe, '');
    out = next.trim() ? next : out.replace(new RegExp(escapeRe(bad), 'g'), '');
  }

  // ---- ② 语气词：只删那个字（句尾助词，删整句会丢信息） ----
  for (const p of VOICE_PARTICLES) {
    if (!out.includes(p)) continue;
    removed.push(p);
    out = out.replace(new RegExp(`${p}(?=[，。！？!?\\s]|$)`, 'g'), '');
  }

  // ---- ③ emoji / 颜文字 ----
  if (EMOJI_RE.test(out)) {
    removed.push('emoji');
    out = out.replace(EMOJI_RE, '');
  }

  out = out
    .replace(/[？?]{2,}/g, '？')
    .replace(/[！!]{2,}/g, '！')
    .replace(/[~～]+/g, '')
    .replace(/。{2,}/g, '。')
    // 删掉一个小句后会留下孤零零的标点（"加油！我们先…" → "！我们先…"），
    // 以及"，。"这种"逗号紧跟终止符"的残迹。逐个收掉，否则学生看到的就是断头句。
    .replace(/[，,、]\s*([。；;！!？?])/g, '$1')
    .replace(/([。；;！!？?])\s*[。；;！!？?]+/g, '$1')
    .replace(/^[，,、。；;！!？?\s]+/, '')
    .replace(/\s+([，。；！？])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // 整句都是空话时会被删空 —— 交给调用方决定退回原文还是丢弃。
  // 这里只保证不会返回一串标点。
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(out)) out = '';

  // 中文问号与英文问号都算；超过 1 个即视为"同时问了两个问题"
  const questionCount = (out.match(/[？?]/g) ?? []).length;

  return { text: out, removed, multiQuestion: questionCount > 1 };
}

/**
 * 面向学生的层级名。
 *
 * 为什么不用 "L1 条件追问" 这种名字：
 *   那是教研语言。学生看到"条件追问"四个字，第一反应是"系统在给我分类"，
 *   而不是"我要去检查一个前提"。层级对内部有意义，对学生只该是一句人话。
 */
export const STUDENT_LEVEL_NOTE = {
  0: '先把问题说清楚',
  1: '我在问你一个前提',
  2: '给你一个方向',
  3: '我示范一步，剩下你来',
};

/**
 * @param {import('./types.js').Diagnosis} diagnosis
 * @param {import('./types.js').Hint} hint
 * @returns {string} 学生可见的完整消息
 */
export function composeStudentMessage(diagnosis, hint) {
  // 诊断复述仅供内部使用。公式和限定条件不做截断式压缩。
  const text = String(hint.text ?? '').trim();
  const nextAsk = String(hint.nextAsk ?? '').trim();
  const segments = text ? [`提示：${text}`] : [];
  if (nextAsk && nextAsk !== text) segments.push(`试一试：${nextAsk}`);
  return segments.join('\n');
}

/**
 * 组装"确认学生答对了"的那句话。
 *
 * 这条路径与提示路径**约束完全不同**，所以单独成函数：
 *   提示：引擎在引导学生 ⇒ 任何答案都不许出现（guard 强制）
 *   确认：引擎在回应学生已经说出的答案 ⇒ 不许出现**学生还没说**的答案
 * 后者由 findUnstatedAnswers() 检查，比 guard 更紧。
 *
 * 语域：确认场景是学生最需要被专业对待的时刻。不用"太棒了！""你真的好厉害"，
 * 而是**具体地说出他做对了什么** —— 这正是资深教师与鼓励机器人的区别。
 *
 * @param {{ verdict: import('./types.js').AnswerVerdict, problem: object }} input
 */
export function composeConfirmation({ verdict, problem }) {
  const left = verdict.remaining.length;

  const candidates = verdict.complete
    ? [
        '完全正确。这道题从头到尾是你自己推出来的 —— 每一步的判断都由你完成，我只在你停顿时问了一个前提。',
        '答案正确。回顾一下：这道题的关键关节都是你自己走通的，我只是把该想的地方指给了你。',
      ]
    : [
        `这一问的结果是对的。你已经独立解决了一部分 —— 还有 ${left} 个待求量没有着落，接着往下走。`,
        `对，这个结果是正确的。剩下的 ${left} 个量你继续推进，从你认为最有把握的那一个入手。`,
        `这一步结论正确。${left} 个待求量还没处理完，我们把它走完整。`,
      ];

  // 逐个候选做红线检查；全部不合格就退到完全不含数值的模板
  for (const text of candidates) {
    if (findUnstatedAnswers(text, problem, verdict).length === 0) return text;
  }
  return verdict.complete
    ? '完全正确。这道题是你自己推出来的。'
    : '这一问的结果是对的，剩下的部分继续推进。';
}

/** 确认轮的"接着做什么"—— 不催促，只给一个抓手 */
export function confirmationNextAsk(verdict) {
  if (verdict.complete) return '把这道题的思路用一句话总结给自己听，然后看学习报告。';
  return '先挑一个你最有把握的待求量算出来，告诉我结果。';
}

/**
 * 学生已经想对的地方（确认轮专用）。
 *
 * 与诊断里的 strengths 不同：那些是"用对了规律"这类过程性肯定，
 * 这里是**结果性**的 —— 学生自己算出的答案。两者都要有：
 * 只夸过程不认结果，学生会觉得"它没在看我算出来的东西"。
 */
export function confirmationStrengths(verdict) {
  const out = [];
  if (verdict.matched.length) {
    out.push(`自己算出了 ${verdict.matched.length} 个待求量：${verdict.matched.map((m) => m.raw).join('、')}`);
  }
  if (verdict.complete) out.push('把这道题的每一问都推进到了结果');
  return out;
}

/**
 * 组装后消息的 voice 体检结果（教师视图用）
 */
export function inspectVoice(message) {
  const { removed, multiQuestion } = polishVoice(message);
  return { emptyTalkRemoved: removed, multiQuestion };
}

/**
 * 引擎判断链路 —— **学生版投影**。
 *
 * 与教师版的 trace 是两次独立的投影，不是"同一份数据加打码"：
 *   学生版只说"我做了哪几个判断"，用来建立"它真的在读我的思路"的信任；
 *   教师版给完整 trace，用于教研复盘。
 *
 * 刻意**不**出现在学生版里的东西：
 *   错因标签、定位置信度、守卫违规类型、层级策略名（precondition_gap 之类）、
 *   路径名与步骤标题（那等于把解法告诉学生）。
 *
 * 也刻意**不**给学生看"防泄题"这一步：
 *   那是我们的工程内控，不是他的学习内容。学生需要的反馈是
 *   "我在看你的思路 / 你现在在哪 / 你需要回答什么"。
 *
 * @param {{
 *   imported: boolean, refusal: boolean, suppressed: boolean,
 *   observationLaws: string[], observationKnowns: string[],
 *   stepIndex: number|null, stepCount: number, confidence: number,
 *   level: import('./types.js').HintLevel, repaired: boolean,
 * }} ctx
 * @returns {import('./types.js').EnginePathEntry[]}
 */
export function buildStudentEnginePath(ctx) {
  const out = [];
  const {
    imported = false,
    refusal = false,
    suppressed = false,
    observationLaws = [],
    observationKnowns = [],
    stepIndex = null,
    stepCount = 0,
    confidence = 0,
    level = 1,
    repaired = false,
  } = ctx ?? {};

  if (imported) {
    out.push({ stage: 'intake', label: '读题：把这道题的条件与目标理清了', tone: 'ok' });
  }

  // ---- 听懂思路 ----
  if (refusal) {
    out.push({ stage: 'understand', label: '你说的是"直接要答案"——我听到了，但我不会替你算', tone: 'hold' });
  } else {
    const bits = [];
    if (observationLaws.length) bits.push(`你提到的「${observationLaws.slice(0, 2).join('、')}」`);
    if (observationKnowns.length) bits.push(`你说的已知量（${observationKnowns.slice(0, 2).join('、')}）`);
    out.push({
      stage: 'understand',
      label: bits.length ? `听懂思路：我抓到了${bits.join('和')}` : '听懂思路：这一段里我还没抓到可用的信息',
      tone: bits.length ? 'ok' : 'hold',
    });
  }

  // ---- 定位 ----
  if (!refusal) {
    if (stepIndex != null && stepCount > 0) {
      out.push({
        stage: 'locate',
        label: `定位：按你说的话，你大概走到第 ${stepIndex} 步（共 ${stepCount} 步）`,
        tone: confidence >= 0.7 ? 'ok' : 'info',
      });
    } else {
      out.push({ stage: 'locate', label: '定位：还看不出你停在哪一步，所以我先问一个更基础的问题', tone: 'info' });
    }
  }

  // ---- 决策 ----
  if (suppressed) {
    out.push({ stage: 'route', label: '决定：这次不打断你，我先看着', tone: 'info' });
  } else {
    out.push({
      stage: 'route',
      label: `决定：${STUDENT_LEVEL_NOTE[level] ?? '给你一句提示'}`,
      tone: 'info',
    });
  }

  // ---- 成文 ----
  if (!suppressed) {
    out.push({ stage: 'generate', label: '成文：把它写成一句你能直接回答的话', tone: 'ok' });
    if (repaired) {
      out.push({ stage: 'guard', label: '复核：换了一种问法，让它更贴近你现在的进度', tone: 'info' });
    }
  }

  return out;
}

function safeRestatement(restatement, hint) {
  if (!restatement) return null;
  let r = restatement.trim();

  // 复述与提示高度重合 ⇒ 丢掉复述，避免"问了两次同样的问题"
  if (isRedundant(r, [hint.text])) return null;

  // 复述里若含内部术语，直接丢弃（宁可少说，不可泄题/暴露诊断）
  if (INTERNAL_LEAK_MARKERS.some((m) => r.toLowerCase().includes(m.toLowerCase()))) {
    r = r.replace(/我感觉问题可能不在算，而在某个规律的前提条件上。?/g, '');
  }
  return r.trim() || null;
}

/** 粗略判重：字符集合重合率 > 0.6 视为重复 */
function isRedundant(candidate, existing) {
  const set = new Set(normalize(candidate).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').split(''));
  if (set.size < 8) return false;
  return existing.some((text) => {
    const other = new Set(normalize(text).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').split(''));
    if (other.size < 8) return false;
    let inter = 0;
    for (const c of set) if (other.has(c)) inter += 1;
    return inter / Math.min(set.size, other.size) > 0.6;
  });
}

/** 出口清洗：防止内部标记意外进入学生可见文本 */
export function sanitizeVisible(text) {
  let out = String(text);
  for (const marker of INTERNAL_LEAK_MARKERS) {
    // 只在标记出现在"括号内说明"时清理，避免误伤正常用词（如"错因"一般不会出现在提示里）
    out = out.replace(new RegExp(`（[^）]*${escapeRe(marker)}[^）]*）`, 'g'), '');
    out = out.replace(new RegExp(`\\([^)]*${escapeRe(marker)}[^)]*\\)`, 'g'), '');
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Prompt 规范的可读导出 —— 供 docs 生成与教研评审使用。
 * 放在代码里而不是文档里，是为了防止"文档与实现漂移"。
 */
export { OBSERVE_SYSTEM_PROMPT, DRAFT_SYSTEM_PROMPT, INTAKE_SYSTEM_PROMPT } from './llm.js';

export { INTERNAL_LEAK_MARKERS, VOICE_HYPE, VOICE_PARTICLES };
