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

import { checkReplyFormat } from './response-policy.js';
import { createAdapter } from './llm.js';
import { buildDiagnosis, describePosition, findStepByPosition, totalSteps } from './locate.js';
import { route } from './route.js';
import { guard, safeFallbackHint } from './guard.js';
import {
  buildStudentEnginePath,
  composeStudentMessage,
  composeConfirmation,
  confirmationNextAsk,
  confirmationStrengths,
} from './prompt.js';
import { verifyAnswer, findUnstatedAnswers } from './verify.js';
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
  '我可以帮你拆解当前一步，先保留由你自己求出结果的机会。',
  '先定位卡住的具体位置，我会按需要逐层增加提示，不一次展开整题。',
  '我们把任务缩小到当前一步，先补足你缺少的那一条知识或关系。',
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
    /**
     * 这道题是不是"现场读出来的"（intake 导入）。
     * 用途只有一个：学生版判断链路里要不要加一句"读题"。
     * 注意它**不参与任何教学决策** —— 导入题的每一句话术走的是与题库题完全相同的 route + guard。
     */
    const imported = problem.source === 'imported';

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
          form: 'refusal',
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
        enginePath: buildStudentEnginePath({ imported, refusal: true, level: 1 }),
      });
    }

    if (reqKind.askVerify) {
      trace.push({
        stage: 'understand',
        message: '识别为"学生给出候选答案希望验证"⇒ 不判对错，转为检查前提的引导',
      });
    }

    // ---------------- 0.5 答案判定（只判定，不决定路径） ----------------
    /**
     * 先算一次确定性判定，但**不在这里返回** —— 关键设计。
     *
     * 第一版实现是把确认路径放在最前面、直接 return，跳过了 observe 与定位。
     * 后果被评测指标当场抓到：定位命中率与错因命中率同时下降 ——
     * 因为"学生报出答案"的那一轮不再产生任何诊断信息。
     *
     * 而那恰好是最不该丢信息的一轮：学生说"E = 0.4 V"时，
     *   · E 这个结果**确实是对的**（E = BLv 与内阻无关）⇒ 该确认
     *   · 但他可能同时漏了内阻（下一步算电流才会踩到）⇒ 该记下来
     * 两件事并不冲突。所以结论是：
     *   **确认只替代"提示"，不替代"观察"。**
     *
     * 代价是确认轮也会调一次 observe（一次 LLM 调用）。这个代价换来的，
     * 是教师视图里"学生答对了那一轮他在第几步、有没有错因"仍然看得到。
     */
    const verdict = verifyAnswer(problem, request.utterance ?? '');
    const isConfirmation = verdict.matched.length > 0 || verdict.complete;

    // ---------------- 1. observe ----------------
    let observation;
    try {
      observation = await llm.observeStudent({
        problem,
        utterance: request.utterance,
        history,
      });
    } catch (err) {
      logger?.(`observe 失败：${err.message}`);
      const failure = new Error('暂时未能读取你的思路，请重试；已完成的步骤会保留。');
      failure.code = 'OBSERVATION_UNAVAILABLE';
      failure.statusCode = 503;
      failure.cause = err;
      throw failure;
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

    // 简短追问沿用同一位置的卡点类型，不能把“还是不会”重新诊断成新卡点。
    const priorHint = [...history].reverse().find(t => t.role === 'ai' && !t.suppressed && t.form !== 'confirm' && t.metaStuckKind);
    if (isFollowUpUtterance(request.utterance) && priorHint &&
        priorHint.metaStep === diagnosis.position.stepIndex &&
        priorHint.metaGraphId === diagnosis.position.graphId) {
      diagnosis.stuckKind = priorHint.metaStuckKind;
    }

    // ---------------- 2.5 确认路径（在定位之后、决策之前） ----------------
    if (isConfirmation) {
      trace.push({
        stage: 'route',
        message: verdict.complete
          ? `答案判定：学生自己给出了全部 ${verdict.expectedCount} 个待求量 ⇒ 宣布完成，不给提示`
          : `答案判定：学生答对了 ${verdict.matched.length}/${verdict.expectedCount} ⇒ 先确认，不给提示`,
      });
      return assembleConfirmation({ problem, trace, startedAt, llm, verdict, diagnosis, imported });
    }

    // ---------------- 3. route ----------------
    const routing = route({
      problem,
      diagnosis,
      history: [...history, { role: 'student', text: request.utterance ?? '' }],
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
        enginePath: buildStudentEnginePath({
          imported,
          suppressed: true,
          stepIndex: diagnosis.position.stepIndex,
          stepCount: totalSteps(problem, diagnosis.position.graphId),
          confidence: diagnosis.position.confidence,
          level: 0,
        }),
      });
    }

    // ---------------- 4. generate + 5. guard（含一次重试闭环） ----------------
    const step = findStepByPosition(problem, diagnosis.position);
    const guardHistory = [];
    let draftMeta = null;
    let finalText = null;
    let finalGuard = null;
    let usedFallback = false;

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
          utterance: request.utterance,
        });
        draftMeta = drafted.meta;
        const candidate = drafted.text;

        const visible = composeStudentMessage(diagnosis, { text: candidate, nextAsk: drafted.meta.nextAsk });
        const g = guard(visible, problem, routing.level, {
          step,
          conceptWhitelist: routing.allowedConcepts,
        });
        const format = checkReplyFormat(visible);
        g.violations.push(...format.violations);
        g.passed = g.passed && format.passed;
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

        // 不采用删公式、截断或模板重写。把完整违规原因带回模型重新生成。
        finalGuard = g;
      } catch (err) {
        trace.push({ stage: 'generate', message: `第 ${attempt + 1} 次起草失败：${err.message}` });
        logger?.(`draft 失败：${err.message}`);
      }
    }

    // 两次都不通过 ⇒ 安全兜底模板（永不泄题优先于文采）
    if (finalText == null) {
      usedFallback = true;
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
      finalGuard = guard(composeStudentMessage(diagnosis, { text: finalText, nextAsk: null }), problem, routing.level, { step, conceptWhitelist: routing.allowedConcepts });
      const format = checkReplyFormat(composeStudentMessage(diagnosis, { text: finalText, nextAsk: null }));
      finalGuard.violations.push(...format.violations);
      finalGuard.passed = finalGuard.passed && format.passed;
      guardHistory.push(finalGuard);
      // 题目概念也可能误含结果式，不能因模板来源可信就跳过复检。
      if (!finalGuard.passed) {
        finalText = '本轮提示暂时无法可靠生成。请指出你看不懂的一个符号，我会从这里重新尝试。';
        const visible = composeStudentMessage(diagnosis, { text: finalText, nextAsk: null });
        finalGuard = guard(visible, problem, routing.level, { step, conceptWhitelist: routing.allowedConcepts });
        const lastFormat = checkReplyFormat(visible);
        finalGuard.violations.push(...lastFormat.violations);
        finalGuard.passed = finalGuard.passed && lastFormat.passed;
        guardHistory.push(finalGuard);
      }
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
      form: usedFallback ? 'fallback' : formOfLevel(routing.level),
      text: finalText,
      concepts: draftMeta?.concepts ?? routing.allowedConcepts,
      touchesFinalAnswer: false,
      rationale: `层级 L${routing.level}（${routing.strategy}）；${routing.reason}`,
      nextAsk: draftMeta?.nextAsk ?? null,
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
      enginePath: buildStudentEnginePath({
        imported,
        observationLaws: observation.laws ?? [],
        observationKnowns: observation.knowns ?? [],
        stepIndex: diagnosis.position.stepIndex,
        stepCount: totalSteps(problem, diagnosis.position.graphId),
        confidence: diagnosis.position.confidence,
        level: routing.level,
        /** 真实发生过"被拦下并重写"时，学生版只说"换了一种问法"，不暴露违规类型 */
        repaired: guardHistory.some((g) => !g.passed),
      }),
    });
  }

  function resetSession(sessionKey = 'default') {
    refusalCount.delete(sessionKey);
  }

  return { handleTurn, resetSession, adapter: llm, problem };
}

// ---------------------------------------------------------------------------
// 确认路径的组装
// ---------------------------------------------------------------------------

/**
 * 确认轮的响应。
 *
 * 与提示路径的三个关键差别：
 *   ① `hint.form = 'confirm'` —— 它不是提示，不能混进层级统计
 *      （否则报告里"L0 澄清 N 次"会掺进一堆确认轮，教研看到的分布就是错的）。
 *   ② `hint.text` 不过守卫的"答案泄漏"检查 —— 因为它按构造就不可能含未说出的答案
 *      （`findUnstatedAnswers` 是比守卫更紧的判据）。但仍留一道断言。
 *   ③ **带上真实诊断**。确认只替代提示，不替代观察：
 *      学生答对了这一问，同时"他在第几步""有没有错因"仍然要记下来 ——
 *      教师视图要看，报告也要用。所以这里接收的是真正的 diagnosis，
 *      只把 restatement 清掉（学生刚给了结果，再复述一遍是啰嗦）。
 */
function assembleConfirmation({ problem, trace, startedAt, llm, verdict, diagnosis, imported }) {
  const text = composeConfirmation({ verdict, problem });

  // 断言：确认文本里不许出现学生还没说出的答案。
  // 失败说明模板写错了 —— 这是比守卫更紧的一条，必须显式暴露而不是静默放过。
  const leaked = findUnstatedAnswers(text, problem, verdict);
  if (leaked.length) {
    const err = new Error(`引擎内部错误：确认文本泄漏了学生未说出的答案 —— ${leaked.join('、')}`);
    trace.push({ stage: 'guard', message: err.message });
    throw err;
  }

  const total = totalSteps(problem, diagnosis.position.graphId);
  const position = verdict.complete
    ? {
        ...diagnosis.position,
        stepIndex: total,
        completedSteps: range(1, total - 1),
        confidence: 0.95,
        divergedAt: [],
      }
    : diagnosis.position;

  const hint = {
    level: 0,
    form: 'confirm',
    text,
    concepts: [],
    touchesFinalAnswer: false,
    rationale: verdict.complete
      ? `答案判定：学生自己给出了全部 ${verdict.expectedCount} 个待求量`
      : `答案判定：学生答对 ${verdict.matched.length}/${verdict.expectedCount}，先确认再继续`,
    nextAsk: confirmationNextAsk(verdict),
  };

  const confirmedDiagnosis = {
    ...diagnosis,
    position,
    /**
     * 卡点性质：全部答完 ⇒ finished（学生会看到"收尾交给你自己"以外的正常反馈）。
     * 部分答对时**保留真实判定** —— 不要为了配合"确认"这个动作去改诊断结论，
     * 那会让报告失去意义（学生答对了第一问，但他可能确实漏了内阻）。
     */
    stuckKind: verdict.complete ? 'finished' : diagnosis.stuckKind,
    /** 结果性肯定（"你自己算出了 X"）与过程性肯定（"选对了规律"）合并 */
    strengths: [...confirmationStrengths(verdict), ...(diagnosis.strengths ?? [])].slice(0, 4),
    /** 证据：学生这一轮说出的答案原话，放在最前面 */
    evidenceQuotes: [...verdict.matched.map((m) => m.quote).filter(Boolean), ...(diagnosis.evidenceQuotes ?? [])].slice(0, 4),
    /** 确认轮不复述 —— 学生刚给了结果 */
    restatement: '',
  };

  trace.push({
    stage: 'generate',
    message: `最终交付：确认（${verdict.complete ? '全部完成' : `部分正确 ${verdict.matched.length}/${verdict.expectedCount}`}），定位 ${describePosition(problem, position)}`,
  });

  return {
    diagnosis: confirmedDiagnosis,
    hint,
    message: text,
    enginePath: buildStudentEnginePath({
      imported,
      observationLaws: [],
      observationKnowns: verdict.matched.map((m) => m.raw),
      stepIndex: position.stepIndex,
      stepCount: total,
      confidence: position.confidence,
      level: 0,
    }),
    allowedNextLevel: verdict.complete ? 3 : 1,
    suppressed: false,
    refusal: undefined,
    completion: {
      complete: verdict.complete,
      matched: verdict.matched.map((m) => ({ value: m.value, unit: m.unit, raw: m.raw, quote: m.quote })),
      remainingCount: verdict.remaining.length,
      expectedCount: verdict.expectedCount,
    },
    meta: {
      engine: llm.kind,
      model: llm.model,
      latencyMs: Date.now() - startedAt,
      /** 没有经过 generate → guard 这条路，所以守卫结果显式标为"未参与" */
      guard: { passed: true, violations: [], skipped: 'confirmation' },
      guardHistory: [],
    },
  };
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
  enginePath = [],
}) {
  const message = composeStudentMessage(diagnosis, hint);
  if (!suppressed && !checkReplyFormat(message).passed) {
    const error = new Error('暂时未能生成合适的简短提示，请重试；已有步骤会保留。');
    error.code = 'REPLY_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  trace.push({
    stage: 'generate',
    message: `最终交付：L${hint.level} ${hint.form} —— ${describePosition(problem, diagnosis.position)}`,
  });

  return {
    diagnosis,
    hint,
    /** 已检查的完整消息（提示 + 一个下一步动作，不拼接诊断复述） */
    message,
    /**
     * 引擎判断链路的学生版投影（见 prompt.js 的 buildStudentEnginePath）。
     * 教师版不等价于它 —— 教师版是 diagnosis.trace 的完整内容，由教师端点单独返回。
     */
    enginePath,
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
  const parsed = typeof content === 'string' ? safeParse(content) : content;
  if (!parsed || typeof parsed.text !== 'string' || !parsed.text.trim() ||
      !(parsed.nextAsk == null || typeof parsed.nextAsk === 'string') || !Array.isArray(parsed.concepts) ||
      !parsed.concepts.every(value => typeof value === 'string')) {
    throw new Error('提示输出必须是含text、nextAsk、concepts的有效JSON');
  }
  return { text: parsed.text, meta: { concepts: parsed.concepts, nextAsk: parsed.nextAsk ?? null } };
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

/**
 * 引擎层的安全兜底。
 *
 * 为什么不在这里另写一套文案：guard 的 safeFallbackHint 已经是
 * "不依赖题目数值、按 step.kind 分派 L3"的兜底模板，两处各写一套必然漂移 ——
 * 漂移的表现是"守卫重写出来的话"和"引擎兜底的话"风格不一致，
 * 而这两句对学生的可见度完全一样。所以这里只补上 nextAsk，文案一律复用。
 */
function composeSafeFallback({ problem, level, step, allowedConcepts }) {
  const text = safeFallbackHint(problem, level, {
    step,
    conceptWhitelist: allowedConcepts,
    other: (step?.concepts ?? []).find((c) => c !== allowedConcepts?.[0]),
  });
  return { text, nextAsk: routingNextAsk(level) };
}

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
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
