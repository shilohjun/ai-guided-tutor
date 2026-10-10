/**
 * 共享工具：文本归一化、中文数值词表、中文短语匹配、正则安全构造。
 *
 * 为什么单独成文件：离线桩、守卫、评测三方都要用同一套归一化，
 * 否则"线上认为没泄题、评测认为泄题"这种漂移会让整个验证失效。
 *
 * 本文件是整个引擎里最容易出错的地方 —— 它要处理真实学生的口语表达，
 * 而不是题库里那种规范写法。每次改动都必须跑 test/text.test.js：
 * 那里的用例全部来自评测场景，是踩过坑之后固化下来的。
 */

/** 全角 → 半角，去除零宽字符，压缩空白。中文场景必须做这一步。 */
export function normalize(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/[，、]/g, ',')
    .replace(/[。；]/g, '.')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 判断文本是否包含任一关键词（大小写不敏感的归一化匹配） */
export function containsAny(text, needles) {
  const t = normalize(text).toLowerCase();
  return needles.some((n) => t.includes(normalize(n).toLowerCase()));
}

/** 返回命中的关键词列表 */
export function matchAll(text, needles) {
  const t = normalize(text).toLowerCase();
  return needles.filter((n) => t.includes(normalize(n).toLowerCase()));
}

/** 安全构造正则：题库存的是字符串，避免在热路径里反复编译 */
const regexCache = new Map();
export function safeRegex(pattern, flags = 'i') {
  const key = `${flags}::${pattern}`;
  if (regexCache.has(key)) return regexCache.get(key);
  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    // 题库存量数据写错正则不应该让引擎崩，退化成字面量匹配
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
  regexCache.set(key, re);
  return re;
}

/**
 * 中文数字 → 阿拉伯数字。
 * 目的：学生说"电荷量是一库仑"与答案指纹 "1 C" 必须能对上，
 * 否则守卫会被自然语言绕过。
 */
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

export function chineseNumeralToArabic(text) {
  if (!text) return text;
  let out = String(text);
  // 十 / 十X / X十 / X十Y
  out = out.replace(/十([一二三四五六七八九])?/g, (m, u) => String(10 + (u ? CN_DIGIT[u] : 0)));
  // 单字数字（避免误伤"一般""一致"这类词，只在紧跟单位时替换）
  out = out.replace(
    /([零一二两三四五六七八九])(?=\s*(?:库仑|库|安培|安|伏特|伏|瓦特|瓦|牛顿|牛|焦耳|焦|米每秒|米每二次方秒|米|秒|特斯拉|特|欧姆|欧|法拉))/g,
    (m, c) => String(CN_DIGIT[c] ?? m),
  );
  return out;
}

/** 学生表述里常见的"等价说法"归一（用于提升关键词通道召回） */
export function canonicalize(text) {
  return normalize(chineseNumeralToArabic(text))
    // 数学符号归一：½ 与 "1/2" 要能互相命中，否则教师写的 cue 抓不到学生的手写习惯
    .replace(/½/g, '1/2')
    .replace(/¼/g, '1/4')
    .replace(/[［【]/g, '[')
    .replace(/[］】]/g, ']')
    .replace(/[×✕]/g, '×')
    .replace(/电磁感应定律|法拉第定律|法拉第电磁感应定律/g, '法拉第')
    .replace(/闭合电路欧姆定律|全电路欧姆定律/g, '欧姆定律')
    .replace(/牛二|牛顿第二运动定律/g, '牛顿第二定律')
    .replace(/动能定理|功能定理/g, '动能定理')
    .replace(/动量定理|冲量定理/g, '动量定理')
    .replace(/[ＡＢＣ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// ---------------------------------------------------------------------------
// 中文短语匹配（关键工具，踩过多个坑才写成这样）
// ---------------------------------------------------------------------------

/**
 * 中文短语匹配必须同时解决两个方向的问题，只做一边都会失效：
 *
 * 【漏判】中文修饰语会插进关键词中间。
 *   学生说"安培力**应该**向右"，签名"安培力向右"作为连续子串永远匹配不到。
 *   → 评测曾因此跑出 0% 的错因命中率，而单测全绿（单测用例都是从签名原文抄的）。
 *
 * 【误判】一旦为了召回而"拆词共现"，短词碎片又会到处命中。
 *   签名"只有R"拆成 ["只有","R"] 后会在"R的功率"里命中 —— 假阳性。
 *
 * 因此采用**分路径**策略，而不是一套规则打天下：
 *   路径 1（精确）：连续包含。适用于短签名、含符号/数字的精确指纹。
 *   路径 2（公式宽松）：去掉空格/括号后再找，处理"a=F/m 是恒定的"这类插入语。
 *   路径 3（拆词共现）：只对"长中文描述性签名"生效。
 *   路径 4（模糊兜底）：覆盖率 ≥ 50% 且至少含一个 ≥3 字的实词。
 */
export function splitSignature(sig) {
  const s = normalize(sig).replace(/[，,。.\s]/g, '');
  if (!s) return [];
  // 只按"书写系统"切分：ASCII/数字串整体保留，中文串整体保留。
  // 不切中文的原因：切块会造出"力向"这种不存在的片段，
  // 遇到被修饰语隔开的句子时，正确片段匹配不上而错误片段四处误命中。
  const raw = s.match(/[A-Za-z][A-Za-z0-9=+\-/*^²]*|\d+(?:\.\d+)?|[\u4e00-\u9fa5]+/g) ?? [];
  const out = [];
  for (const t of raw) {
    if (/^[\u4e00-\u9fa5]+$/.test(t) && t.length >= 8) {
      // 超长中文串才切块（这类签名本身就是描述句，不是词组）
      for (let i = 0; i < t.length; i += 2) {
        const c = t.slice(i, i + 2);
        if (c.length >= 2) out.push(c);
      }
    } else {
      out.push(t);
    }
  }
  return [...new Set(out)];
}

/**
 * 真正带否定的词。
 * 反向设计：不枚举"哪些是肯定"，而是枚举"不字只是构词成分、不表否定"的情形
 * （不变/不再/不仅/不只/不同/不是…）。
 * 早期版本试图枚举肯定情形，结果"不做功""没有电流"这类标准否定全部漏判。
 */
const NEGATOR_PATTERNS = [
  /没(?!有?变)/,
  /没有(?!变化)/,
  /[^变再仅只同是妨得]?不(?![变再仅只同是妨得])/,
  /勿/,
  /错误/,
  /并非/,
  /不对/,
];

/** 含符号或数字锚点 ⇒ 视为精确指纹，不做拆词匹配 */
function hasAnchor(sig) {
  return /[=＝0-9+\-/*^²Ω]/.test(sig);
}

/**
 * 词边界校验：命中的片段两侧不能直接紧贴字母/数字/数学运算符。
 * 目的：拦掉 "I=E/R" 命中 "I=E/(R+r)" 这类"子表达式误伤正确表达式"。
 * 中文相邻不算违规（中文没有分词空格，"电阻只有R"里 R 前面就是中文）。
 */
function isWordBoundaryMatch(text, index, length) {
  const before = index > 0 ? text[index - 1] : '';
  const after = index + length < text.length ? text[index + length] : '';
  const tight = /[A-Za-z0-9+\-*/^=（）()]/;
  return !tight.test(before) && !tight.test(after);
}

/**
 * 宽松匹配用文本：去掉空白、括号、逗号、下划线。
 * 用于公式类签名 —— 学生写 "a=F/m 是恒定的" 与签名 "a=F/m恒定" 应当等价。
 */
function looseFormulaText(text) {
  return normalize(text)
    .toLowerCase()
    .replace(/[\s_（）()，,\[\]]/g, '');
}

/**
 * 否定语境判定。
 *
 * 必须把"命中的词本身"也纳入检查窗口 —— 这一点踩过坑：
 * 只在词前后找否定词，会漏掉"**没有电流**"（否定在词内部）。
 * 因此签名是 (haystack, index, span)：span 是命中的原文。
 *
 * 重要限制（踩过更大的坑）：**含否定词的签名必须跳过本检查**。
 * 因为"磁通量没有变化""没有最大速度"这类签名本身就是学生的错误主张，
 * 对它做否定过滤会把最该命中的场景全部判掉（评测里实测过）。
 * 本检查只用于"极性为肯定"的签名，用于排除"X不做功"这类真正相反的说法。
 */
export function isNegated(haystack, index, span = '') {
  const rawText = typeof span === 'number' ? haystack.slice(index, index + span) : String(span);
  // 归一化 span 内部空白/标点，避免 "不做 功" 这类写法绕过检测
  const text = rawText.replace(/[\s，,。.]/g, '');
  const length = rawText.length || 1;
  // 回看一个字符：中文里"不X"是最短否定式；回看范围一放大，"速度不变"里的"不"会被误当否定词
  const before = haystack.slice(Math.max(0, index - 1), index);
  // 往后看 5 个字符，覆盖"力**不做**功"这类否定后置结构
  const after = haystack.slice(index + length, index + length + 5);
  const window = `${before}${text}${after}`;
  return NEGATOR_PATTERNS.some((re) => re.test(window));
}

/** 签名自身是否已含否定词（含则说明它本来就是"否定型"主张，不该再做否定过滤） */
function signatureIsNegative(sig) {
  return NEGATOR_PATTERNS.some((re) => re.test(normalize(sig)));
}

/**
 * 签名匹配：返回命中的签名原文（已排除否定语境）。
 * @param {string} haystack 已 canonicalize 的文本
 * @param {string[]} signatures
 */
export function matchSignatures(haystack, signatures) {
  const h = normalize(haystack).toLowerCase();
  const hits = [];

  for (const raw of signatures) {
    const sig = normalize(raw);
    if (!sig) continue;
    const key = sig.replace(/[，,。.\s]/g, '').toLowerCase();
    if (!key) continue;

    // 该签名本身是否"否定型"。否定型签名不做否定过滤 —— 见 isNegated 的说明。
    const negativeSig = signatureIsNegative(sig);
    const negatedIn = (text, at, span) => (negativeSig ? false : isNegated(text, at, span));

    // ---- 路径 1：连续包含（短签名 / 含符号的精确指纹） ----
    if (key.length <= 8 || hasAnchor(key) || key.includes('=')) {
      const flat = h.replace(/[，,。.\s]/g, '');
      const idx = flat.indexOf(key);
      if (idx >= 0) {
        // 词边界校验：避免 "I=E/R" 在 "I=E/(R+r)" 里误命中
        if (isWordBoundaryMatch(flat, idx, key.length)) {
          if (!negatedIn(flat, idx, flat.slice(idx, idx + key.length))) {
            hits.push(sig);
            continue;
          }
          continue; // 命中了但被否定 ⇒ 不算
        }
        // 边界不合法（被更长表达式包含）⇒ 继续尝试其它路径
      }
      if (key.length <= 8 && !hasAnchor(key)) continue; // 短纯中文签名不做拆词
    }

    const terms = splitSignature(sig);
    if (terms.length === 0) continue;

    // ---- 路径 2：公式类签名的"宽松文本"匹配 ----
    if (hasAnchor(sig) || sig.includes('=')) {
      const loose = looseFormulaText(haystack);
      const lkey = looseFormulaText(sig);
      const li = loose.indexOf(lkey);
      if (li >= 0 && isWordBoundaryMatch(loose, li, lkey.length) && !negatedIn(loose, li, loose.slice(li, li + lkey.length))) {
        hits.push(sig);
        continue;
      }
    }

    // ---- 路径 3：拆词共现（长中文描述性签名） ----
    const present = terms.filter((t) => h.includes(t.toLowerCase()));
    if (present.length === terms.length && terms.length >= 2) {
      const anyNegated = present.some((t) => {
        const i = h.indexOf(t.toLowerCase());
        return i >= 0 && negatedIn(h, i, t);
      });
      if (!anyNegated) {
        hits.push(sig);
        continue;
      }
    }

    // ---- 路径 4：模糊兜底（覆盖率 ≥ 50% 且至少一个 ≥3 字实词） ----
    if (terms.length >= 2) {
      const coverage = present.length / terms.length;
      const strong = present.some((t) => t.length >= 3);
      if (coverage >= 0.5 && strong) {
        const anyNegated = present.some((t) => {
          const i = h.indexOf(t.toLowerCase());
          return i >= 0 && negatedIn(h, i, t);
        });
        if (!anyNegated) hits.push(sig);
      }
    }
  }
  return hits;
}

/** 是否命中任一条签名 */
export function matchesAnySignature(haystack, signatures) {
  return matchSignatures(haystack, signatures).length > 0;
}

// ---------------------------------------------------------------------------
// 定位辅助
// ---------------------------------------------------------------------------

/**
 * 是否为"追问式"短发言（如"然后呢""还是不会"）。
 * 用途：这类发言不应覆盖已有的定位，否则学生一追问 AI 就"失忆"。
 */
export function isFollowUpUtterance(text) {
  const t = normalize(text).replace(/\s/g, '');
  if (!t) return true;
  if (t.length <= 12) return true;
  return /^(然后呢|接着呢|再呢|还是不会|不会|不懂|不明白|是吗|对吗|为什么|怎么办|继续|嗯|哦|然后|下一步呢|卡住了|想不出来)/.test(
    t,
  );
}

/** 零信息发言：学生什么实质内容都没说 */
const ZERO_INFO_ONLY = [
  '我不会',
  '不会',
  '不知道',
  '不知道啊',
  '不懂',
  '不明白',
  '没思路',
  '没有思路',
  '看不懂',
  '不会做',
  '想不出来',
  '想不出',
  '然后呢',
  '接着呢',
  '接下来怎么办',
  '下一步呢',
  '提示一下',
  '给点提示',
  '卡住了',
  '没有头绪',
];

/** 实质内容的信号词：出现任意一个就说明学生在讲思路，而不是在喊难 */
const SUBSTANCE_SIGNALS =
  /(?:定律|定理|守恒|公式|安培|电动势|电流|电压|电阻|磁场|磁通|功率|冲量|动量|能量|受力|平衡|电容|匀加速|匀速|等于|假设|反设|互质|偶数|奇数|平方|推导|代入|面积|速度|加速度|位移|质量|时间|力|电荷|磁|电|[=＝]|[0-9]\s*[A-Za-z]|[A-Za-z]\s*[=＝])/;

/**
 * 学生发言是否包含"可诊断的实质内容"。
 *
 * 这是"信息是否充足"的判定基准，必须是**发言的属性**，
 * 而不是从派生字段（reasoningChain / knowns）反推 —— 这一点踩过坑：
 *   离线桩会把任何发言按标点粗切成 reasoningChain，于是"我不会"也切出一段；
 *   而 knowns 是从题干的已知量反查出来的，跟学生说了什么无关。
 *   两者都会让 sufficientInfo 误判为 true，反问路径就永远不触发。
 */
export function hasSubstantiveContent(text) {
  const t = normalize(text).trim();
  if (!t) return false;
  const compact = t.replace(/\s/g, '');

  // 纯零信息发言（允许后面跟一个问号或标点）
  const bare = compact.replace(/[?？。.!！,，、~～]+$/, '');
  if (ZERO_INFO_ONLY.includes(bare)) return false;

  // 带实质信号词 ⇒ 有内容
  if (SUBSTANCE_SIGNALS.test(t)) return true;

  // 没有信号词，但说得足够长（>= 16 字）也算有内容
  return compact.length >= 16;
}

/** 截断到指定长度（用于日志与证据引用，避免超长） */
export function clip(text, max = 120) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
