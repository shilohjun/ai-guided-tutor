/**
 * 题目导入与理解（intake）—— "任意题目文字 → 结构化题目"。
 *
 * ============================================================================
 * 这个模块解决什么问题
 * ============================================================================
 * 题库里的题（problems.data.js）是教研手写的：路径、前提、错因、指纹都有人审过。
 * 但一个真实产品里，学生拿来的题 99% 不在题库里。
 * 所以必须有第三条链路：**现场读懂一道没见过的题**。
 *
 * ============================================================================
 * 它的三条设计红线
 * ============================================================================
 * ① **解题路径对学生隐藏。**
 *    学生看到的只有题干原文 + 一句"我已经读完这道题了"。
 *    路径是引擎判断"他走到哪一步"的内部基准（见 types.ts 的 StudentTurnPayload / TeacherPayload）。
 *
 * ② **题目必须带指纹，否则守卫对它等于不存在。**
 *    守卫（guard.js）是拿 Problem 当基准做比对的：
 *    没有 answerFingerprints 就拦不住数值答案，没有 formulaFingerprints 就拦不住解法式，
 *    没有 solutionInsights 就拦不住"把结论说破"。
 *    所以三道兜底：模型给 → 从参考答案反推 → 仍然缺失就记 warning（教师视图可见）。
 *    这是本模块最容易被忽略、后果最严重的一项。
 *
 * ③ **读不懂就降级，不装作读懂了。**
 *    模型调用失败 / JSON 解析失败 / 结构不合法 ⇒ 退到启发式骨架，
 *    并在 warnings 里写清楚"现在这张图谱是通用骨架，不是这道题的图谱"。
 *    教师视图会把它显示出来 —— 让"图谱质量"这件事可被审计，而不是被掩盖。
 *
 * ============================================================================
 * 为什么降级逻辑写在这里，而不是写在 llm.js 的离线桩里
 * ============================================================================
 * "没有读题能力"与"读题调用失败"应该走同一条降级路径。
 * 如果离线桩实现一遍、真模型 catch 再实现一遍，就会有两条降级逻辑，
 * 而两条逻辑一定会漂移 —— 最后"离线能跑"和"真模型挂了能跑"变成两回事。
 */

import { canonicalize, clip, normalize, stripEnumerators } from './text.js';
import { extractValueUnits, fingerprintMatches, unitAlternatives } from './guard.js';

const ALLOWED_KINDS = ['setup', 'identify', 'precondition', 'apply', 'derive', 'interpret', 'conclude'];
const SUBJECTS = ['physics', 'math', 'chemistry'];

/** 题干最少字数：少于这个长度不可能是一道完整的题 */
export const MIN_STEM_LENGTH = 8;

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 读一道新题。
 *
 * @param {string} rawText 学生粘贴的题干原文
 * @param {{ adapter?: object, subjectHint?: string|null }} [options]
 * @returns {Promise<import('./types.js').IntakeResult>}
 */
export async function understandProblem(rawText, options = {}) {
  const startedAt = Date.now();
  const text = String(rawText ?? '').trim();
  if (text.length < MIN_STEM_LENGTH) {
    throw new Error(`题干太短（${text.length} 字），至少需要 ${MIN_STEM_LENGTH} 个字才能读题`);
  }

  const warnings = [];
  let parsed = null;
  let usedModel = false;

  const adapter = options.adapter;
  if (adapter && typeof adapter.understandProblem === 'function') {
    try {
      parsed = await adapter.understandProblem({ rawText: text, subjectHint: options.subjectHint ?? null });
      usedModel = true;
    } catch (err) {
      warnings.push(`模型读题失败，已降级为通用骨架：${clip(err?.message ?? err, 160)}`);
    }
  } else {
    warnings.push(
      '当前适配器没有读题能力（离线规则桩），已降级为启发式骨架：只抽取已知量与待求量，路径为通用六步，定位精度明显低于真模型。',
    );
  }

  const source = parsed && typeof parsed === 'object' ? parsed : heuristicSkeleton(text, options.subjectHint ?? null);
  const { problem, analysis } = normalizeIntake(source, text, {
    subjectHint: options.subjectHint ?? null,
    warnings,
  });

  return {
    problem,
    analysis,
    /**
     * 模型读题的原始输出。
     *
     * 为什么要把"已经归一化过的 Problem"之外的原始对象也带出去：
     *   解析面板要用的 keyConditions / knowledgeGraph / variables 属于**展示层数据**，
     *   不该塞进 Problem 这一个共享契约里（engine / guard / locate 都不需要它们，
     *   加进去只会让"题目"这个结构继续膨胀）。
     *   所以它们留在这里，由 registry 存起来，交给 analysis.js 去用与派生。
     */
    modelRaw: usedModel ? source : null,
    warnings,
    usedModel,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * 从题干文本派生一个稳定的题目 id。
 *
 * 为什么用内容哈希而不是随机 id：
 *   同一道题被粘贴两次应该命中同一个题目与同一张图谱，
 *   否则学生会发现"我明明发过这道题，它又说不认识"。
 */
export function fingerprintProblemId(rawText) {
  const input = canonicalize(rawText).replace(/\s+/g, '');
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `imp-${h.toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------
// 归一化与校验（纯函数，便于不联网测试）
// ---------------------------------------------------------------------------

/**
 * 把"模型输出 / 启发式骨架"归一化成合法的 Problem。
 *
 * 这里做的不是格式美化，而是**把不可信输入变成可守卫的题目**：
 *   - 步骤号重排（模型经常给 0 起或跳号，而 locate 依赖 index 的连续性）
 *   - kind 白名单（一个拼错的 kind 会让 route 的按步派发全部失效）
 *   - cues 兜底（没有 cues ⇒ 关键词通道永久失效 ⇒ 定位只能靠模型，一错就全错）
 *   - 指纹兜底（见文件头红线 ②）
 *
 * @returns {{ problem: import('./types.js').Problem, analysis: import('./types.js').IntakeResult['analysis'] }}
 */
export function normalizeIntake(source, rawText, opts = {}) {
  const warnings = opts.warnings ?? [];
  const src = source && typeof source === 'object' ? source : {};

  // ---- 学科 ----
  let subject = String(src.subject ?? '').trim().toLowerCase();
  if (!SUBJECTS.includes(subject)) {
    if (subject) warnings.push(`模型给出的学科「${src.subject}」不在支持范围，已按题干推断`);
    subject = opts.subjectHint && SUBJECTS.includes(opts.subjectHint) ? opts.subjectHint : inferSubject(rawText);
  }

  // ---- 已知量 / 待求量 ----
  const givens = stringList(src.givens).length ? stringList(src.givens) : extractGivens(rawText);
  const asked = stringList(src.asked).length ? stringList(src.asked) : extractAsked(rawText);
  if (!givens.length) warnings.push('未能从题干里抽出已知量，提示中无法引用具体条件');
  if (!asked.length) warnings.push('未能从题干里抽出待求量，收尾引导会偏泛');

  // ---- 解题路径 ----
  const graphs = normalizeGraphs(src.solutionGraphs, rawText, warnings);
  const topicSource = stringList(src.topics).length
    ? stringList(src.topics)
    : deriveTopics(graphs, subject);
  if (!stringList(src.topics).length) warnings.push('模型未给出知识点，已从路径步骤的概念反推');

  // ---- 错因 ----
  const misconceptions = normalizeMisconceptions(src.misconceptions, warnings);
  if (!misconceptions.length) {
    warnings.push('本题没有可用错因库 ⇒ 引擎无法把学生的话归类到具体认知缺口，报告里的"深层问题"会变泛');
  }

  // ---- 参考答案（服务端内部） ----
  const referenceAnswer = String(src.referenceAnswer ?? '').trim();
  if (!referenceAnswer) {
    warnings.push(
      '模型未给出参考答案 ⇒ 守卫失去了"从答案反推数值"这条兜底通道，本题的数值防泄题只能依赖 answerFingerprints',
    );
  }

  // ---- 三道指纹（红线 ②） ----
  const answerFingerprints = mergeFingerprints(
    // 关键一步：把"能匹配题干本身"的答案指纹全部丢掉。
    // 判据很短但极有效：**一个能匹配题干的指纹，不可能是这道题的答案。**
    // 实测踩到的坑：模型把"落地前 1 s 内"里的 "1 s" 写进 answerFingerprints，
    // 结果引擎连"题目里的 1 秒"都不许说，所有提示都被拦成兜底模板 ——
    // 护栏过激和护栏失效一样是故障，而且更难被发现（表现为"AI 答非所问"而不是"AI 泄题"）。
    dropFingerprintsMatchingStem(
      sanitizeFingerprints(src.answerFingerprints, warnings, 'answerFingerprints'),
      rawText,
      warnings,
    ),
    dropFingerprintsMatchingStem(deriveAnswerFingerprints(referenceAnswer, givens, rawText), rawText),
  );
  if (!answerFingerprints.length) {
    warnings.push('本题没有答案指纹，也没有可反推的参考答案数值 —— 数值型答案的守卫对这道题失效，教师视图已标记');
  }

  const formulaFingerprints = sanitizeFingerprints(src.formulaFingerprints, warnings, 'formulaFingerprints');
  const solutionInsights = sanitizeFingerprints(src.solutionInsights, warnings, 'solutionInsights');
  if (!formulaFingerprints.length && !solutionInsights.length) {
    warnings.push('本题没有解法指纹与结论指纹 ⇒ L0–L2 只能拦住"给出完整表达式"，拦不住"把结论说破"');
  }

  const problem = {
    id: fingerprintProblemId(rawText),
    source: 'imported',
    createdAt: new Date().toISOString(),
    subject,
    topics: topicSource.slice(0, 8),
    difficulty: normalizeDifficulty(src.difficulty),
    /** 关键：题干一律用**学生粘贴的原文**，不用模型改写过的版本 */
    stem: rawText.trim(),
    givens,
    asked,
    solutionGraphs: graphs,
    misconceptions,
    answerFingerprints,
    formulaFingerprints,
    solutionInsights,
    referenceAnswer,
  };

  return { problem, analysis: buildAnalysis(problem, src, warnings) };
}

function buildAnalysis(problem, src, warnings) {
  const keySteps = [];
  for (const g of problem.solutionGraphs) {
    for (const s of g.steps) {
      if (s.kind === 'precondition' || s.kind === 'identify') {
        keySteps.push({ index: s.index, title: s.title, kind: s.kind });
      }
    }
  }
  const picked = (keySteps.length ? keySteps : problem.solutionGraphs[0]?.steps.slice(0, 3) ?? []).slice(0, 4);

  return {
    summary: String(src.summary ?? '').trim() || `${problem.subject === 'math' ? '数学' : problem.subject === 'chemistry' ? '化学' : '物理'}题：${clip(problem.stem, 60)}`,
    topics: problem.topics,
    paths: problem.solutionGraphs.map((g) => ({
      id: g.id,
      name: g.name,
      stepCount: g.steps.length,
      preconditions: g.preconditions,
    })),
    keySteps: picked,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 路径归一化
// ---------------------------------------------------------------------------

function normalizeGraphs(rawGraphs, rawText, warnings) {
  const list = Array.isArray(rawGraphs) ? rawGraphs.filter((g) => g && typeof g === 'object') : [];
  if (!list.length) {
    warnings.push('模型未给出解题路径 ⇒ 使用通用六步骨架代替（定位会明显变粗）');
    return heuristicSkeleton(rawText, null).solutionGraphs;
  }

  const graphs = [];
  list.slice(0, 3).forEach((g, gi) => {
    const rawSteps = Array.isArray(g.steps) ? g.steps.filter((s) => s && typeof s === 'object') : [];
    if (!rawSteps.length) return;

    const steps = rawSteps.slice(0, 12).map((s, si) => {
      const kind = ALLOWED_KINDS.includes(String(s.kind)) ? String(s.kind) : 'apply';
      const title = String(s.title ?? `第 ${si + 1} 步`).trim() || `第 ${si + 1} 步`;
      const concepts = stringList(s.concepts);
      const cues = ensureCues(stringList(s.cues), title, concepts);
      return {
        index: si + 1,
        title,
        kind,
        intent: String(s.intent ?? title).trim(),
        concepts,
        cues,
        forks: [],
      };
    });

    // 末步必须是 conclude —— route 与 report 都依赖"最后一步=收尾"这个不变量。
    // 模型经常把最后一步写成 derive，导致引擎永远不认为学生"接近完成"。
    const last = steps[steps.length - 1];
    if (last && last.kind !== 'conclude' && last.kind !== 'interpret') {
      last.kind = 'conclude';
    }

    graphs.push({
      id: slugify(String(g.id ?? `g${gi + 1}`), `g${gi + 1}`),
      name: String(g.name ?? `路径 ${gi + 1}`).trim() || `路径 ${gi + 1}`,
      preconditions: stringList(g.preconditions),
      steps,
    });
  });

  if (!graphs.length) {
    warnings.push('模型给出的路径里没有任何有效步骤 ⇒ 使用通用六步骨架代替');
    return heuristicSkeleton(rawText, null).solutionGraphs;
  }
  return graphs;
}

/**
 * cues 兜底。
 *
 * 为什么必须兜底：cues 是关键词定位通道**唯一**的输入。
 * 一条路径如果没有 cues，定位就 100% 依赖模型通道，
 * 而双通道交叉校验（locate.js 的核心机制）会退化成单通道 ——
 * 模型一旦误判就没有第二意见，这正是"错误的提示比不给提示伤害更大"的场景。
 */
function ensureCues(cues, title, concepts) {
  const clean = cues.map((c) => normalize(c).replace(/[，,。.\s]/g, '')).filter((c) => c.length >= 2 && c.length <= 10);
  if (clean.length >= 2) return [...new Set(clean)].slice(0, 6);

  // 从标题与概念里派生：按标点切成短语，取 2~8 字的片段
  const derived = [];
  for (const chunk of `${title} ${concepts.join(' ')}`.split(/[\s、,，/（）()：:；;]+/)) {
    const t = normalize(chunk).replace(/[，,。.\s]/g, '');
    if (t.length >= 2 && t.length <= 8) derived.push(t);
  }
  return [...new Set([...clean, ...derived])].slice(0, 6);
}

// ---------------------------------------------------------------------------
// 错因归一化
// ---------------------------------------------------------------------------

function normalizeMisconceptions(raw, warnings) {
  const list = Array.isArray(raw) ? raw.filter((m) => m && typeof m === 'object') : [];
  const out = [];
  const seen = new Set();

  list.slice(0, 6).forEach((m, i) => {
    const label = String(m.label ?? '').trim();
    const signature = stringList(m.signature);
    if (!label || !signature.length) return;

    let id = slugify(String(m.id ?? `m-${i + 1}`), `m-${i + 1}`);
    if (!id.startsWith('m-')) id = `m-${id}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);

    out.push({
      id,
      label,
      signature,
      rootCause: String(m.rootCause ?? label).trim(),
      hintSeeds: (stringList(m.hintSeeds).length
        ? stringList(m.hintSeeds)
        : [`你说的这个情况，和「${clip(label, 24)}」有没有关系？先自己判断一下。`]
      ).slice(0, 3),
      highLeakRisk: false,
    });
  });

  if (!out.length && list.length) {
    warnings.push('模型给出的错因缺少 label 或 signature（无法匹配学生说法），已全部丢弃');
  }
  return out;
}

// ---------------------------------------------------------------------------
// 指纹
// ---------------------------------------------------------------------------

/**
 * 丢掉"能匹配题干本身"的答案指纹。
 *
 * 为什么这条规则成立：题干里已经写出来的数值，是**已知量**，不是答案。
 * 把它当答案指纹，会让引擎连念题干都不允许 —— 提示会被系统性地拦成兜底模板。
 *
 * 这不是"降低安全"，恰恰相反：它让 answerFingerprints 恢复成
 * "只在答案位置才命中"的精确指纹，守卫才能把拦截预算花在真正的泄漏上。
 */
export function dropFingerprintsMatchingStem(fingerprints, stem, warnings = []) {
  const list = fingerprints ?? [];
  if (!list.length) return [];
  const text = normalize(stem);
  const kept = [];
  const dropped = [];
  for (const fp of list) {
    let hit = false;
    try {
      hit = new RegExp(fp, 'i').test(text);
    } catch {
      hit = false;
    }
    if (hit) dropped.push(fp);
    else kept.push(fp);
  }
  if (dropped.length) {
    warnings.push(
      `answerFingerprints 里有 ${dropped.length} 条能匹配题干本身（说明它其实是已知量，不是答案），已丢弃：${dropped.slice(0, 3).join(' / ')}`,
    );
  }
  return kept;
}

/** 从参考答案里反推"数值 + 单位"指纹，并排除题干已给的已知量 */
export function deriveAnswerFingerprints(referenceAnswer, givens = [], stem = '') {
  if (!referenceAnswer) return [];
  /**
   * 排除基准用**题干全文**，不只是 givens。
   * 为什么：intake 从模型拿到的 givens 可能漏掉题干里的某个数
   * （例如"落地前 1 s 内"里的 1 s 不是"已知量"格式，模型通常不会列进 givens），
   * 而那个数一旦进了指纹，就会把正常提示全部拦掉。
   */
  const knownNumbers = new Set(
    [...givens, stripEnumerators(stem)]
      .flatMap((g) => normalize(g).match(/-?\d+(?:\.\d+)?/g) ?? [])
      .map((n) => String(Number(n))),
  );

  const out = [];
  for (const { value, unit } of extractValueUnits(referenceAnswer)) {
    if (knownNumbers.has(String(Number(value)))) continue; // 题干出现过的数值 ⇒ 已知量，不是答案
    const alt = unitAlternatives(unit);
    out.push(`${escapeRe(value)}\\s*(?:${alt})`);
  }
  return [...new Set(out)].slice(0, 12);
}

/**
 * 指纹清洗。
 *
 * 两件事：
 *   ① 丢掉编译不过的正则（safeRegex 会退化成字面量，但那等于指纹被静默削弱，
 *      不如在这里明确丢弃并记 warning）；
 *   ② 丢掉"过短 / 过泛"的指纹。
 *      一个形如 `\d` 的 answerFingerprint 会把学生说的每一个数字都判成泄题，
 *      守卫会疯狂拦截 —— 护栏过激和护栏失效一样是故障。
 */
export function sanitizeFingerprints(raw, warnings = [], fieldName = 'fingerprints') {
  const list = stringList(raw);
  const out = [];
  let droppedInvalid = 0;
  let droppedTooBroad = 0;

  for (const fp of list) {
    const p = fp.trim();
    if (!p) continue;
    try {
      // eslint-disable-next-line no-new
      new RegExp(p, 'i');
    } catch {
      droppedInvalid += 1;
      continue;
    }
    // 过泛判定：去掉所有正则元字符后还剩不到 2 个实义字符 ⇒ 会误伤正常提示
    const literal = p.replace(/[\\^$.*+?()[\]{}|]/g, '');
    if (literal.length < 2) {
      droppedTooBroad += 1;
      continue;
    }
    out.push(p);
  }

  if (droppedInvalid) warnings.push(`${fieldName} 里有 ${droppedInvalid} 条正则无法编译，已丢弃`);
  if (droppedTooBroad) warnings.push(`${fieldName} 里有 ${droppedTooBroad} 条过于宽泛（会误伤正常提示），已丢弃`);
  return [...new Set(out)];
}

function mergeFingerprints(a, b) {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

// ---------------------------------------------------------------------------
// 启发式骨架（无模型 / 模型失败时的降级）
// ---------------------------------------------------------------------------

/**
 * 通用六步骨架。
 *
 * 诚实地说：这不是"读懂了这道题"，只是"把流程撑起来"。
 * 它的 cues 是通用词（"代入""前提"这类），定位精度远低于真模型读题，
 * 但比"没有题目"好：学生仍然能拿到分层提示，守卫仍然能守住答案数值
 * （只要参考答案里有数值，deriveAnswerFingerprints 就能反推出指纹）。
 *
 * 这个取舍写在这里，是为了让后续看到 warnings 的人不会误以为
 * "离线也能读懂任意题目" —— 那是错的。
 */
export function heuristicSkeleton(rawText, subjectHint) {
  const subject = subjectHint && SUBJECTS.includes(subjectHint) ? subjectHint : inferSubject(rawText);
  const givens = extractGivens(rawText);
  const asked = extractAsked(rawText);

  return {
    subject,
    difficulty: 3,
    summary: `（通用骨架）${clip(canonicalize(rawText), 50)}`,
    givens,
    asked,
    referenceAnswer: '',
    solutionGraphs: [
      {
        id: 'g-general',
        name: '通用解题路径',
        preconditions: ['先把已知条件与目标对齐，再选择规律'],
        steps: [
          {
            index: 1,
            title: '读清条件与目标',
            kind: 'setup',
            intent: '分清题目给了什么、要求什么',
            concepts: ['已知条件', '待求量'],
            cues: ['已知', '条件', '要求', '求', '给了'],
          },
          {
            index: 2,
            title: '判断该用哪个规律',
            kind: 'identify',
            intent: '从题目描述的过程里选出适用的规律',
            concepts: ['规律选择'],
            cues: ['规律', '定律', '定理', '公式', '方法'],
          },
          {
            index: 3,
            title: '核对规律成立的前提',
            kind: 'precondition',
            intent: '检查题目条件是否满足所选规律的前提',
            concepts: ['适用前提'],
            cues: ['前提', '满足', '成立', '适用', '条件'],
          },
          {
            index: 4,
            title: '写出对应的关系式',
            kind: 'apply',
            intent: '把规律写成符号关系式',
            concepts: ['关系式'],
            cues: ['列式', '关系式', '方程', '式子'],
          },
          {
            index: 5,
            title: '代入数据并运算',
            kind: 'derive',
            intent: '把已知量代入并做代数运算',
            concepts: ['代入求解'],
            cues: ['代入', '计算', '化简', '解出'],
          },
          {
            index: 6,
            title: '得出结果并检查',
            kind: 'conclude',
            intent: '写出结果并检查单位与合理性',
            concepts: ['结果检查'],
            cues: ['结果', '单位', '检查', '所以'],
          },
        ],
      },
    ],
    misconceptions: [],
    answerFingerprints: [],
    formulaFingerprints: [],
    solutionInsights: [],
  };
}

// ---------------------------------------------------------------------------
// 题干抽取（不含模型时的兜底）
// ---------------------------------------------------------------------------

/** 抽 "符号 = 数值 单位" 形式的已知量 */
export function extractGivens(rawText) {
  const text = normalize(rawText);
  const out = [];
  const re = /([A-Za-zα-ωΑ-ΩΔ][A-Za-z0-9_]{0,3})\s*=\s*(-?\d+(?:\.\d+)?(?:\s*[×x]\s*10\s*\^?-?\d+)?)\s*([A-Za-zΩμ°²³/·]+)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const piece = `${m[1]} = ${m[2]}${m[3] ? ` ${m[3]}` : ''}`.trim();
    if (!out.includes(piece)) out.push(piece);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * 抽"求… / 问… / 证明…"形式的待求量。
 *
 * 两种形态都要覆盖，因为真实题目两种都常见：
 *   ① 单问：「求小球落地时的速度大小。」
 *   ② 分问：「求：(1) 落地速度；(2) 最后 1 s 内的高度。」
 *
 * 早期实现只处理了 ①（捕获组里禁止数字，用来避免把数值当待求量），
 * 结果 ② 里的 "(1)" 让捕获组第一个字符就是数字，整段失配 ——
 * 表现为"导入带小问的题，引擎完全不知道要求什么"。
 * 现在改成：允许数字，但在结果里剥掉编号前缀。
 */
export function extractAsked(rawText) {
  const text = normalize(rawText);
  const out = [];

  for (const m of text.matchAll(/(?:求|问|计算|证明|试证|求解)\s*[:：]?\s*([^。;；？?]{2,40})/g)) {
    out.push(m[1]);
  }
  for (const m of text.matchAll(/[(（]\s*\d+\s*[)）]\s*([^。;；？?]{4,60})/g)) {
    out.push(m[1]);
  }

  const cleaned = [];
  for (const raw of out) {
    const piece = raw
      .replace(/^[(（]?\s*\d+\s*[)）]?\s*/, '')
      .replace(/[(（]\s*\d+\s*[)）].*$/, '') // 小问之间的粘连部分丢掉
      .replace(/[。.;；,，]\s*$/, '')
      .trim();
    if (piece.length >= 2 && !cleaned.includes(piece)) cleaned.push(piece);
    if (cleaned.length >= 6) break;
  }
  return cleaned;
}

export function inferSubject(rawText) {
  const t = canonicalize(rawText);
  const score = { physics: 0, math: 0, chemistry: 0 };
  const kw = {
    physics: ['磁场', '电流', '电场', '电压', '电阻', '力', '速度', '加速度', '能量', '动量', '功', '功率', '质量', '摩擦', '重力', '电容', '光', '波长'],
    math: ['函数', '方程', '证明', '数列', '不等式', '整数', '质数', '无理数', '三角形', '导数', '极值', '向量', '概率', '面积', '集合'],
    chemistry: ['化学', '摩尔', '溶液', '反应', '氧化', '离子', '浓度', '质量分数', '气体摩尔', '方程式', 'mol', 'pH'],
  };
  for (const [k, words] of Object.entries(kw)) {
    for (const w of words) if (t.includes(w)) score[k] += 1;
  }
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'physics';
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function stringList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (v == null || v === '') return [];
  return [String(v).trim()].filter(Boolean);
}

function normalizeDifficulty(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

function slugify(v, fallback) {
  const s = String(v)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

function deriveTopics(graphs, subject) {
  const concepts = graphs.flatMap((g) => g.steps.flatMap((s) => s.concepts)).filter(Boolean);
  const uniq = [...new Set(concepts)].slice(0, 6);
  if (uniq.length) return uniq;
  return [subject === 'math' ? '数学综合' : subject === 'chemistry' ? '化学综合' : '物理综合'];
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
