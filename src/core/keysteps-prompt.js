/**
 * 关键点抽取的提示词与回复解析。
 *
 * ============================================================================
 * 为什么单独一个文件、还要按题型分三套
 * ============================================================================
 * 第一版用一套提示词跑四道题，实测暴露两个问题（.tmp-rag/probe-keysteps*.mjs）：
 *
 * ① 粒度随题型漂移。实验题与选择题被抽成"判断选项 A / 判断选项 B"，
 *    六个关键点里三个是逐个选项排查 —— 那是答题动作，不是思维关卡。
 *    计算题抽出来的是推导链，两者不同构，接进同一个引擎会得到两种质量的提示。
 * ② 尾部截断。第六个关键点的式子字段丢失，因为 max_tokens 给少了。
 *
 * 所以：计算题问"推导链上的判断"，选择题问"主链 + 干扰项归因"，
 * 实验题问"操作规范 / 数据处理 / 误差来源"。三套话术，一个 JSON 契约。
 */

const SCHEMA = `严格输出一个 JSON 对象，不要有任何解释文字：
{"keysteps":[{"title":"...","type":"...","judge":"...","why":"...","do":"...","expr":"...","cues":["..."],"concepts":["..."]}]}

字段要求：
- title：这道坎叫什么，不超过 12 个字，不要写成"第二步"这种流水号
- type：只能取 ${'`前提判断 | 模型选择 | 关系建立 | 几何关系 | 数学处理 | 近似条件 | 临界条件 | 图像读取 | 实验操作 | 数据处理 | 误差分析 | 结论整理`'} 之一
- judge：这一步要求学生作出什么判断（一句话，写清楚"要判断什么"，不要写结论对错）
- why：为什么必须这么判断（依据的物理规律或题设条件）
- do：具体做什么动作（列哪个方程、读图哪一段、比较哪两个量）
- expr：这一步的关系式，用 LaTeX；没有式子就写空串
- cues：学生可能说出口的 2~4 个说法，每项 2~10 个字，要口语（"取整体""先看加速度"）。不许出现公式、字母符号或 LaTeX（"sinC=1/n""πr²""k="都不行）；数字要保留原样（"0.02 秒"不能写成"002 秒"）
- concepts：涉及的物理概念名词 1~3 个（"整体法""牛顿第二定律"）`;

export const KEYSTEPS_SYSTEM_PROMPT = `你是高中物理解题路径的分析师。你的工作不是解这道题，而是**把这道题解完所必须作出的关键判断逐个拆出来**。

什么叫关键判断：跳过它，这道题就做不下去或者一定做错；不跳过它，剩下的都是机械代入。
反例（不是关键判断）："代入数据计算""写出答案""根据题意分析"——这些每道题都有，等于没说。
正例："把小车和桶砂取整体，避开绳的内力"（选错了就要多解一个未知数），"只有 m 远小于 M 时拉力才近似等于 mg"（不取这个近似就得不到题目要的答案）。

数量：2~6 个。这道题有几道坎就写几个，不要为凑数拆分，也不要把两道坎揉成一个。

硬性禁止：
- 不要写出最终答案，不要写"故选 B/答案为 X"
- 不要逐个选项复述（"判断 A 正确""判断 B 错误"），干扰项只写它错在哪个判断上
- 如果某一问是"下列做法/操作/说法正确的是"这类多情形选择题（每个选项讲一个**不同**的实验或情形），
  也不要为每个选项单列关键点：把它压成一条"逐条检查每项说法是否满足它自己的前提"，
  把最容易错的那一条写进 why。三个选项讲三个不同的学生实验，仍然是**一道坎**，不是三道
- 不要写"认真审题""仔细计算"这类空话

${SCHEMA}`;

const TYPE_HINTS = {
  calc: `这道题是**计算题**。要点在推导链：从已知量到待求量，中间每一步靠哪个规律、哪个近似、哪个临界条件撑过去。
关键点 = 链上不能跳过的判断：选对象 / 选规律 / 定方向正负 / 取近似 / 找临界 / 联立消元 / 结果检验。
注意：同一道题里"选对象"和"选规律"常常是两个不同的坎，别合并。`,
  choice: `这道题是**选择题**。要点是选出正确项的那条主链，以及干扰项错在哪。
关键点 = 主链上的判断，不是逐项排查。干扰项的错误原因，压缩成对应关键点 why 里的一句话即可。
如果这道题的坎本来就只有两个（比如只需判断一个方向 + 一个大小关系），就写两个，不要拆成四个选项。`,
  lab: `这道题是**实验题**。要点是目的 → 器材与操作规范 → 数据读取与处理 → 结论与误差。
关键点 = 会直接影响结果的判断：实验原理怎么落地、哪个操作不能省（平衡摩擦力/调零/多次测量）、读数取哪一段、图像怎么化曲为直、误差从哪来。
"按步骤做实验"不是关键点。
某一问是"下列操作正确的是"（每项各讲一个不同实验）时，它只是一条坎：逐项核对前提，别拆成三个。`,
};

function typeKey(ty) {
  const t = String(ty ?? '');
  if (t === '实验') return 'lab';
  if (t === '计算') return 'calc';
  return 'choice'; // 单选 / 多选 / 填空
}

/**
 * 拼一道题的抽取提示。
 *
 * 题干与解析里的公式被题库替换成了 `⟨式⟩` 占位符，这是有意的：
 * 结构判断（选哪个对象、取什么近似）不依赖具体数值，
 * 而解析里的文字已经把"为什么"说清楚了。
 */
export function buildKeystepsPrompt(question) {
  const ty = String(question?.ty ?? '');
  const stem = String(question?.stem ?? '').trim();
  const opt = String(question?.opt ?? '').trim();
  const analysis = String(question?.analysis ?? '').trim();
  const difficulty = question?.difficulty ?? question?.d;

  return `【题型】${ty}（难度 ${difficulty}/4）
【题干】
${stem}
${opt ? `\n【选项】\n${opt}\n` : ''}
【官方解析】
${analysis}

${TYPE_HINTS[typeKey(ty)]}

现在把这道题的关键点拆出来。只输出 JSON。`;
}

function tryJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function sliceOut(text, open, close) {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

const ARRAY_KEYS = ['keysteps', '关键点链', '关键点', 'steps', 'keypoints', 'key_steps'];

function pickArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  for (const key of ARRAY_KEYS) {
    if (Array.isArray(value[key])) return value[key];
  }
  // 模型偶尔会再包一层：{"result":{"keysteps":[...]}}
  for (const v of Object.values(value)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = pickArray(v);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * 解析模型回复。
 *
 * 实测它会：给 ```json 围栏、在 JSON 前后写"分析如下"、把 keysteps 改名成中文 key。
 * 这些都能救，但"解析不出来"和"抽到空数组"必须抛错 ——
 * 835 题批量跑的时候，静默的空结果会被当成"这道题没有关键点"存进题库。
 */
export function parseKeystepsReply(reply) {
  const text = String(reply ?? '').replace(/```(?:json)?/gi, '').trim();
  if (!text) throw new Error('模型回复为空');

  const attempts = [text, sliceOut(text, '{', '}'), sliceOut(text, '[', ']')].filter(Boolean);
  let parsed = null;
  for (const attempt of attempts) {
    const r = tryJson(attempt);
    if (r.ok) {
      parsed = r.value;
      break;
    }
  }
  if (parsed === null) throw new Error('模型回复里找不到可解析的 JSON');

  const list = pickArray(parsed);
  if (!Array.isArray(list)) throw new Error('JSON 里没有关键点数组');
  if (!list.length) throw new Error('关键点数组是空的');

  return list.filter((k) => k && typeof k === 'object').map((k) => ({
    title: k.title ?? k.name ?? k['标题'],
    type: k.type ?? k['类型'],
    judge: k.judge ?? k.judgement ?? k['判断'],
    why: k.why ?? k.reason ?? k['依据'],
    do: k.do ?? k.action ?? k['动作'],
    expr: k.expr ?? k.formula ?? k['式子'],
    cues: k.cues ?? k.keywords ?? k['关键词'],
    concepts: k.concepts ?? k['概念'],
  }));
}
