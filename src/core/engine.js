/**
 * 引导引擎 —— 对外唯一入口：handleTurn()
 *
 * 一次调用的完整链路：
 *   学生输入
 *     ├─ 0. 需求识别    索要答案/验证答案/元问题 → 走确定性拒绝或引导路径
 *     ├─ 1. observe     学生思路 → 结构化观察（LLM 或离线桩）
 *     ├─ 2. understand  双通道定位 + 可行性 + 卡点性质 → Diagnosis
 *     ├─ 3. route       层级决策 + 策略 + 白名单 + 禁止项（确定性）
 *     ├─ 4. generate    受限起草（可能重试）
 *     └─ 5. guard       出口把关；拦截则重写，二次失败则安全兜底
 *
 * 关键保证：**任何路径返回的 hint.text 都必然通过了 guard**。
 * 这一点由 test/engine.test.js 逐一断言，而不是靠代码审阅。
 */

import { createAdapter } from './llm.js';
import { buildDiagnosis, describePosition, findStepByPosition } from './locate.js';
import { route } from './route.js';
import { guard } from './guard.js';
import { composeStudentMessage } from './prompt.js';
import { isFollowUpUtterance } from './text.js';

/**
 * 从历史里取出最近一次 AI 轮次所依据的位置。
 * 这是"追问继承"的数据来源：Turn.metaStep / metaGraphId 由调用方写入。
 */
export function extractPriorPosition(history) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const t = history[i];
    if (t.role === 'ai' && t.metaStep != null) {
      return { stepIndex: t.metaStep, graphId: t.metaGraphId ?? null, confidence: 0.6 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 需求识别：学生主动索要答案的处理
// ---------------------------------------------------------------------------

/**
 * 明确索要答案的说法。
 * 顺序无关紧要（用 includes 判定），但要注意"短串被长串包含"的情形，
 * 例如"给我答案"被"把答案给我"部分覆盖 —— 两个都列上即可。
 */
const ASK_FOR_ANSWER = [
  '告诉我答案',
  '直接给答案',
  '给个答案',
  '给我答案',
  '把答案给我',
  '答案是什么',
  '答案是啥',
  '答案呢',
  '直接说结果',
  '直接说答案',
  '告诉我结果',
  '给我结果',
  '给个结果',
  '别提示了',
  '不要提示',
  '不用提示',
  '直接告诉我',
  '怎么做直接说',
  '讲一下完整过程',
  '给我完整步骤',
  '帮我写出来',
  '直接写答案',
  '直接写出',
];

/** 学生给出自己的候选答案、希望被验证 */
const ASK_FOR_VERIFY = [
  '是不是',
  '对吗',
  '对不对',
  '我算的是',
  '我得的是',
  '我得到',
  '这样对不对',
  '检查一下',
  '你看我这个',
  '是这个吗',
];

/**
 * 拒绝话术 —— 按次数递进。
 * 设计要点：拒绝之后必须给一个"低成本的下一步"，
 * 否则学生会认为"这个 AI 没用"而离开。拒绝不是终点，是转向。
 */
const REFUSAL_LADDER = [
  '答案我先不给。不过我可以保证：只要你自己走通一步，后面的会越来越快。我们先从最小的那一步开始——你说说这道题给了哪些条件？',
  '我还是不给答案。但如果你愿意把现在想到的写给我（哪怕只写对一个公式名），我能告诉你"卡在哪、该检查什么"。这比我报个数字对你考试有用得多。',
  '我理解你想要结果，但直接给你答案，下次换一道题你还是会卡。这样吧，我把这一步拆成两个更小的问题，你只要回答其中一个就行——先说题目里"匀速"这个条件在力学上意味着什么？',
];

export function classifyRequest(utterance) {
  const raw = utterance || '';
  const t = raw.replace(/\s+/g, '');
  const askAnswer = ASK_FOR_ANSWER.some((k) => t.includes(k));
  const askVerify = ASK_FOR_VERIFY.some((k) => t.includes(k));

  // 残余内容判定：把"索要答案"的关键词全删掉后，还剩多少实质内容？
  // 这条规则的来由：学生常说"我用欧姆定律算出了电流，但力不知道怎么求，答案是什么"，
  // 这明显带着自己的思路，把他当"纯索取者"拒绝掉是误伤 —— 会让学生觉得 AI 不听人说话。
  let residual = t;
  for (const k of ASK_FOR_ANSWER) residual = residual.split(k).join('');
  const hasSubstance =
    residual.length >= 25 ||
    /(?:定律|定理|守恒|公式|安培力|电动势|电流|电压|电阻|磁场|磁通|功率|冲量|动量|能量|受力|平衡|电容|匀加速|匀速)/.test(
      residual,
    ) ||
    /[0-9][^0-9]{0,3}[=＝]|[=＝][^0-9]{0,3}[0-9]/.test(residual);

  return {
    askAnswer,
    askVerify,
    /** 索要答案 且 没有同时给出自己的思路 ⇒ 纯索取 */
    pureSolicitation: askAnswer && !askVerify && !hasSubstance,
  };
}

// ---------------------------------------------------------------------------
// 引擎工厂
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {import('./types.js').LLMAdapter} [options.adapter] 不传则按环境自动选择
 * @param {import('./types.js').Problem} options.problem      当前题目（必填）
 * @param {(msg:string)=>void} [options.logger]
 */
export function createEngine({ adapter, problem, logger } = {}) {
  if (!problem) throw new Error('createEngine 需要 problem');
  const llm = adapter ?? createAdapter();
  /** 按会话记录拒绝次数，用于递进话术 */
  const refusalCount = new Map();

  async function handleTurn(request) {
    const startedAt = Date.now();
    const trace = [];
    const sessionKey = request.sessionId ?? 'default';
    const history = request.history ?? [];

    trace.push({
      stage: 'understand',
      message: `收到学生输入（${(request.utterance ?? '').length} 字），当前模式 ${request.mode}`,
    });

    // ---------------- 0. 需求识别 ----------------
    const reqKind = classifyRequest(request.utterance);

    if (reqKind.pureSolicitation) {
      const n = (refusalCount.get(sessionKey) ?? 0) + 1;
      refusalCount.set(sessionKey, n);
      const text = REFUSAL_LADDER[Math.min(n, REFUSAL_LADDER.length) - 1];
      trace.push({
        stage: 'route',
        message: `识别为"直接索要答案"（第 ${n} 次）⇒ 走确定性拒绝话术，不调用模型生成提示`,
      });
      // 拒绝路径也必须过 guard：话术本身要确保不含答案（这是防御性自检）
      const guardResult = guard(text, problem, 1, {});
      return assemble({
        problem,
        trace,
        startedAt,
        llm,
        diagnosis: makeSoftDiagnosis(problem, 'not_started', '学生直接索要答案，未提供可诊断的思路', trace),
        hint: {
          level: 1,
          form: 'condition_question',
          text: guardResult.passed ? text : guardResult.repairedText,
          concepts: [],
          touchesFinalAnswer: false,
          rationale: '反捷径策略：直接索取答案时不进入生成流程，改用确定性拒绝并把学生推回思考',
          nextAsk: '说出这道题给了哪些条件、要求什么。',
        },
        /**
         * 复述留空：拒绝路径下 diagnosis.restatement 装的是**给教研看的内部说明**，
         * 不能被 composeStudentMessage 当成"对学生说的话"输出。
         */
        restatementOverride: '',
        guardResult,
        guardHistory: guardResult.passed ? [] : [guardResult],
        allowedNextLevel: 1,
        refusal: { count: n, kind: 'answer_solicitation' },
      });
    }

    if (reqKind.askVerify) {
      trace.push({
        stage: 'understand',
        message: '识别为"学生给出候选答案希望验证"⇒ 不判对错，转为检查前提的引导',
      });
    }

    // ---------------- 1. observe ----------------
    let observation;
    try {
      observation = await llm.observeStudent({
        problem,
        utterance: request.utterance,
        history,
      });
    } catch (err) {
      trace.push({ stage: 'understand', message: `观察阶段失败，降级为"未形成思路"：${err.message}` });
      logger?.(`observe 失败：${err.message}`);
      observation = emptyObservation(request.utterance);
    }

    trace.push({
      stage: 'understand',
      message: `观察结果：规律=[${(observation.laws ?? []).join(',') || '无'}]，推理链 ${observation.reasoningChain.length} 段，候选错因 [${(observation.candidateMisconceptionIds ?? []).join(',') || '无'}]`,
      data: { observation },
    });

    // ---------------- 2. understand ----------------
    // 追问继承：学生只回了"然后呢/还是不会"时，本轮无法定位，
    // 但直接丢掉上一轮的定位会让 AI 表现得像失忆（这是很伤体验的细节）。
    const priorPosition = extractPriorPosition(history);
    const diagnosis = buildDiagnosis(problem, observation, request.utterance, trace, {
      priorPosition,
      allowCarryover: isFollowUpUtterance(request.utterance),
    });

    // ---------------- 3. route ----------------
    const routing = route({
      problem,
      diagnosis,
      history,
      explicitHelpSeeking: request.explicitHelpSeeking ?? false,
      mode: request.mode,
      pastViolations: [],
    });
    trace.push({
      stage: 'route',
      message: routing.suppressed
        ? `决策为"不介入"：${routing.reason}`
        : `决策层级 L${routing.level}，策略 ${routing.strategy}（${routing.reason}）`,
    });

    // 决策为不介入（自主训练静默观测 / 学生已完成）
    if (routing.suppressed) {
      const guardResult = { passed: true, violations: [] };
      const silent = composeSilentMessage(diagnosis, routing.reason);
      return assemble({
        problem,
        trace,
        startedAt,
        llm,
        diagnosis,
        hint: {
          level: 0,
          form: 'clarify',
          text: silent,
          concepts: [],
          touchesFinalAnswer: false,
          rationale: `按陪伴模式与状态决定不介入：${routing.reason}`,
          nextAsk: '继续你的思路，需要时再叫我。',
        },
        guardResult,
        guardHistory: [],
        allowedNextLevel: 1,
        suppressed: true,
      });
    }

    // ---------------- 4. generate + 5. guard（含一次重试闭环） ----------------
    const step = findStepByPosition(problem, diagnosis.position);
    const guardHistory = [];
    let draftMeta = null;
    let finalText = null;
    let finalGuard = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const forbidden = attempt === 0 ? routing.forbidden : accumulateForbidden(routing.forbidden, guardHistory);
      try {
        const drafted = await draftWithMeta(llm, {
          problem,
          diagnosis,
          level: routing.level,
          allowedConcepts: routing.allowedConcepts,
          forbidden,
          strategy: routing.strategyInstruction,
          /** 传层级统计给适配器：离线桩用它轮换话术，真模型也可用作 few-shot 选择依据 */
          l3Count: routing.l3Count ?? 0,
          history,
        });
        draftMeta = drafted.meta;
        const candidate = drafted.text;

        const g = guard(candidate, problem, routing.level, {
          step,
          conceptWhitelist: routing.allowedConcepts,
        });
        guardHistory.push(g);

        trace.push({
          stage: 'guard',
          message: g.passed
            ? `第 ${attempt + 1} 次生成通过守卫`
            : `第 ${attempt + 1} 次生成被拦截：${g.violations.map((v) => v.kind).join(',')} ⇒ 策略 ${g.repairStrategy}`,
          data: { violations: g.violations },
        });

        if (g.passed) {
          finalText = candidate;
          finalGuard = g;
          break;
        }
        // 未通过：若重写结果也干净，直接用重写结果（避免无谓多调一次模型）
        const rewritten = g.repairedText;
        const recheck = rewritten
          ? guard(rewritten, problem, routing.level, { step, conceptWhitelist: routing.allowedConcepts })
          : null;
        if (rewritten && recheck?.passed) {
          finalText = rewritten;
          finalGuard = recheck;
          trace.push({
            stage: 'guard',
            message: `采用守卫重写结果（策略 ${g.repairStrategy}）`,
          });
          break;
        }
        // 否则带着违规信息重试下一代
        finalGuard = g;
      } catch (err) {
        trace.push({ stage: 'generate', message: `第 ${attempt + 1} 次起草失败：${err.message}` });
        logger?.(`draft 失败：${err.message}`);
      }
    }

    // 两次都不通过 ⇒ 安全兜底模板（永不泄题优先于文采）
    if (finalText == null) {
      const fallbackDraft = {
        text: null,
        nextAsk: null,
        concepts: routing.allowedConcepts,
      };
      const safe = composeSafeFallback({
        problem,
        level: routing.level,
        step,
        allowedConcepts: routing.allowedConcepts,
      });
      finalText = safe.text;
      finalGuard = guard(finalText, problem, routing.level, { step, conceptWhitelist: routing.allowedConcepts });
      guardHistory.push(finalGuard);
      draftMeta = fallbackDraft;
      trace.push({
        stage: 'guard',
        message: '两次生成均未通过守卫 ⇒ 使用安全兜底模板（该路径保证不含答案）',
      });
    }

    // 最终断言：出口文本必然通过了守卫。失败说明守卫或兜底有 bug，必须显式暴露。
    if (!finalGuard?.passed) {
      const err = new Error(
        `引擎内部错误：出口提示未通过守卫但被放行 —— ${JSON.stringify(finalGuard?.violations ?? [])}`,
      );
      trace.push({ stage: 'guard', message: err.message });
      throw err;
    }

    const hint = {
      level: routing.level,
      form: formOfLevel(routing.level),
      text: finalText,
      concepts: draftMeta?.concepts ?? routing.allowedConcepts,
      touchesFinalAnswer: false,
      rationale: `层级 L${routing.level}（${routing.strategy}）；${routing.reason}`,
      nextAsk: draftMeta?.nextAsk ?? routingNextAsk(routing.level),
    };

    return assemble({
      problem,
      trace,
      startedAt,
      llm,
      diagnosis,
      hint,
      guardResult: finalGuard,
      guardHistory,
      allowedNextLevel: Math.min(3, (routing.level ?? 1) + 1),
    });
  }

  function resetSession(sessionKey = 'default') {
    refusalCount.delete(sessionKey);
  }

  return { handleTurn, resetSession, adapter: llm, problem };
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

function assemble({
  problem,
  trace,
  startedAt,
  llm,
  diagnosis,
  hint,
  guardResult,
  guardHistory,
  allowedNextLevel,
  suppressed = false,
  refusal,
  restatementOverride,
}) {
  trace.push({
    stage: 'generate',
    message: `最终交付：L${hint.level} ${hint.form} —— ${describePosition(problem, diagnosis.position)}`,
  });

  const visibleDiagnosis =
    restatementOverride === undefined ? diagnosis : { ...diagnosis, restatement: restatementOverride };

  return {
    diagnosis,
    hint,
    /** 面向学生的完整消息（含复述 + 提示 + 下一步动作） */
    message: composeStudentMessage(visibleDiagnosis, hint),
    allowedNextLevel,
    suppressed,
    refusal,
    meta: {
      engine: llm.kind,
      model: llm.model,
      latencyMs: Date.now() - startedAt,
      guard: guardResult,
      guardHistory,
    },
  };
}

async function draftWithMeta(llm, input) {
  const content = await llm.draftHint(input);
  if (typeof content === 'string') {
    // 离线桩返回 JSON 字符串；真模型也返回 JSON 字符串。统一解析。
    const parsed = safeParse(content);
    return {
      text: parsed?.text ?? content,
      meta: { concepts: parsed?.concepts ?? [], nextAsk: parsed?.nextAsk ?? null },
    };
  }
  return {
    text: content?.text ?? '',
    meta: { concepts: content?.concepts ?? [], nextAsk: content?.nextAsk ?? null },
  };
}

function safeParse(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : null;
  } catch {
    return null;
  }
}

function accumulateForbidden(base, guardHistory) {
  const out = [...base];
  for (const g of guardHistory) {
    for (const v of g.violations ?? []) {
      out.push(`上一轮被拦截【${v.kind}】：${v.detail}${v.match ? `（命中片段：${v.match}）` : ''}`);
    }
  }
  return out;
}

function formOfLevel(level) {
  return { 0: 'clarify', 1: 'condition_question', 2: 'direction', 3: 'worked_step' }[level] ?? 'clarify';
}

function routingNextAsk(level) {
  return {
    0: '把已知条件和目标各说一遍。',
    1: '检查这个规律的前提，然后告诉我哪一条最可疑。',
    2: '用一句话说出这一步涉及的两个量之间是什么关系。',
    3: '按示范的动作自己往下做一步，把结果说给我听。',
  }[level];
}

function composeSafeFallback({ problem, level, step, allowedConcepts }) {
  const concept = allowedConcepts?.[0] ?? step?.concepts?.[0] ?? '这一步';
  const texts = {
    0: '先别急着算。你能把题目给了什么、要求什么各说一遍吗？说完我们再定方向。',
    1: `你先看看：你打算用的这个规律，它成立需要满足什么前提？题目里的条件都满足了吗？`,
    2: `方向提示：这一步的关键在于${concept}和运动状态之间的联系。先想清楚这个联系是怎么建立的，再找式子。`,
    3: `我示范一个动作，你接着做：先把研究对象单独拎出来，按方向逐一列出它受到的各个力（只写方向和名字，不写数值）。列完之后告诉我哪一个力会随速度变化。`,
  };
  void problem;
  return { text: texts[level] ?? texts[1], nextAsk: routingNextAsk(level) };
}

function composeSilentMessage(diagnosis, reason) {
  if (diagnosis.stuckKind === 'finished') {
    return '你已经走到最后一步了，收尾就交给你自己完成——写完告诉我你的结论，我帮你核对思路。';
  }
  return '我在旁边看着，你先按自己的思路做。卡住了随时叫我。';
}

function emptyObservation(utterance) {
  return {
    knowns: [],
    goal: null,
    laws: [],
    reasoningChain: [],
    uncertainties: [],
    stuckPoint: null,
    hasComputationTrace: false,
    candidateStepIndex: null,
    candidateMisconceptionIds: [],
    evidenceQuotes: [],
    /** 观察失败 ⇒ 没有可诊断内容 ⇒ 走反问，不硬猜 */
    sufficientInfo: false,
    probeQuestion: null,
  };
}

function makeSoftDiagnosis(problem, stuckKind, note, trace) {
  return {
    position: {
      graphId: problem.solutionGraphs[0]?.id ?? null,
      stepIndex: null,
      confidence: 0.9,
      completedSteps: [],
      divergedAt: [],
    },
    feasibility: 'unclear',
    misconceptions: [],
    stuckKind,
    // 这条路径本来就没有可诊断的内容（拒绝给答案 / 观察失败），因此明确标记信息不足
    sufficientInfo: false,
    probeQuestion: note,
    strengths: [],
    evidenceQuotes: [],
    restatement: note,
    trace,
  };
}

export { emptyObservation, makeSoftDiagnosis, formOfLevel };
