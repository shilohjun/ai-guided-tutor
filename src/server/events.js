/**
 * 事件字典与写入 —— 漏斗、看板、导出三条下游链路唯一的读取来源。
 *
 * ============================================================================
 * 为什么要有"字典"这个东西
 * ============================================================================
 * 埋点最贵的不是写，是**两年后没人知道某个 type 是什么意思**。
 * 所以这里只留 13 种（设计稿 §5.3 逐条对应）：加一种必须删一种，
 * 或者说明为什么非它不可。这条规矩的成本很低，收益是事件表永远小而可读。
 *
 * 字典同时是**写入口的闸门**：未知 type 直接拒，不让它进库 ——
 * 一旦脏事件落库，后面每一层都得自己判断"这个 type 我认不认识"，
 * 而那件事只要漏一处，看板上的分母就悄悄变了。
 *
 * ============================================================================
 * 校验为什么是纯函数、而且顺序被钉死
 * ============================================================================
 * `validateEvent` 不碰存储、不读环境，所以路由、脚本、测试可以用同一个判据，
 * 不会出现"路由放过了、脚本又拦下"的分叉。
 *
 * 四个理由的检查顺序是**契约**（不是随手排的）：
 *
 *   ① unknown_type     连类型都不认识，后面几条根本没有讨论的意义；
 *   ② missing_at       时间必须由服务端盖（见下），客户端没带说明这条埋点是半截的；
 *   ③ payload_too_big  体积问题 —— 先确认它是不是一条真事件，再量它多大；
 *   ④ missing_owner    归属是最后一道：没有 sessionId 也没有 visitId 的事件
 *                      不知道该挂到哪个学生/哪次打开上，落了也是孤儿。
 *
 * 一条事件可能同时犯几个错，先报哪一个决定了调用方拿到的是哪句可操作的话。
 * 顺序改了，测试会红 —— 这是故意的。
 *
 * ============================================================================
 * 时间（at）一律由服务端生成
 * ============================================================================
 * `recordEvent` 无视调用方给的 `at`，落库前换成 `new Date().toISOString()`。
 * 理由：学生手机的时钟不可信（改时间、时区错、省电模式跳秒都见过），
 * 而漏斗的每一格、每次停留时长、每条排序都建立在这个时间上。
 * 一个错的时钟能让"第 1 页停留 -3 分钟"这种数悄悄进到导出件里，
 * 而且**看不出异常**。所以客户端时间只可能作为 payload 里的线索，绝不进 `at`。
 *
 * 放在 `recordEvent` 而不是每个调用点：调用点以后会变多（路由、后台补记、
 * Task 4 的"先落库后调模型"），让 N 处各自 `new Date()` 是重复且漏得掉的活儿。
 */

/**
 * 13 种事件，与设计稿 §5.3 的表格逐条对应，顺序也照抄（便于人工对表）。
 *
 * 为什么不用对象/enum：这里唯一的用法是"取出全部"和"判断在不在",
 * 数组两件事都直接做得了，而对象还要多一层 `Object.keys`（顺序也不那么直观）。
 */
export const EVENT_TYPES = [
  'login',
  'visit_open',
  'batch_open',
  'page_enter',
  'page_exit',
  'intake_choose',
  'ocr_call',
  'ocr_result',
  'import_result',
  'chat_send',
  'chat_reply',
  'chat_error',
  'session_reset',
];

/**
 * 单条事件 payload 的上限：2KB。
 *
 * 为什么要有：payload 是最容易被塞东西的地方（整段题干、整张图的 base64、
 * 甚至是"顺手把对话历史带上"）。事件表是**按学生 × 每页 × 每一轮**增长的，
 * 一条超标的 payload 会被乘以成千上万倍，而它换来的信息量通常接近零。
 *
 * 2KB 的量级依据：现在最大的合法 payload 是 `chat_reply` 的
 * `{ ms, level, stuckKind, suppressed, engine }`，一百多字节；
 * 2KB 留了十几倍余量，足够以后加字段，又远小于"把内容带进去"的规模。
 */
const MAX_PAYLOAD_BYTES = 2048;

/**
 * 事件自增序号的计数器键。
 *
 * 为什么要在写入口拿一个全局序号（而不是前端/路由自己造）：
 * 同一毫秒内到达的多条事件，按 `at` 排序是**并列**的 —— 于是顺序退化成
 * "谁先被读出来"，两个驱动会给出不同的行序（内存是写入序，file 是目录读取序）。
 * 导出件是要给人看的，同一份数据在两台机器上导出不同的行序是无法解释的。
 * 有了全局序号，顺序在写的那一刻就定死了。
 */
const SEQ_COUNTER_KEY = 'seq:event';

/** 归属键：`sessionId` 非空就用它，否则用 `visitId`。三个驱动共用这一条规则。 */
function ownerOf(event) {
  const owner = event?.sessionId || event?.visitId;
  return owner ? String(owner) : '';
}

/**
 * payload 的字节数。
 *
 * 用 JSON 序列化后的 UTF-8 字节而不是字符数：库里存的就是这段 JSON，
 * 而中文一个字三字节 —— 按字符数算，学生一句中文长消息就能悄悄超标三倍。
 *
 * 序列化失败（循环引用、BigInt）当作超标处理：这条事件的 payload 无论如何
 * 都落不进库，而拒绝理由的词汇表只有四个（见文件头），没有"payload 坏了"这一项。
 */
function payloadBytes(payload) {
  if (payload === undefined || payload === null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 一条事件能不能进库。
 *
 * 返回值是 `{ ok: true }` 或 `{ ok: false, reason }` —— 不抛异常，
 * 因为"这条不收"是**正常结果**（弱网下前端发的半截埋点很常见），
 * 而异常只应该留给"代码写错了"。
 *
 * `at` 只判**有没有**，不判值：落库前它一定会被服务端时间覆盖（见文件头），
 * 判一个马上要被丢掉的值没有意义。而"有没有"是有意义的 ——
 * 缺 `at` 说明这条埋点是在网络中断/页面被杀时发出来的半截请求，
 * 这种事件通常还缺后面别的字段。
 *
 * @param {object} event
 * @returns {{ ok: true } | { ok: false, reason: 'unknown_type'|'missing_at'|'payload_too_big'|'missing_owner' }}
 */
export function validateEvent(event) {
  if (!EVENT_TYPES.includes(event?.type)) return { ok: false, reason: 'unknown_type' };

  const at = event?.at;
  if (typeof at !== 'string' || at.trim() === '') return { ok: false, reason: 'missing_at' };

  if (payloadBytes(event?.payload) > MAX_PAYLOAD_BYTES) return { ok: false, reason: 'payload_too_big' };

  if (!ownerOf(event)) return { ok: false, reason: 'missing_owner' };

  return { ok: true };
}

/**
 * 校验 + 盖时间 + 盖序号 + 落库。**服务端写事件的唯一入口。**
 *
 * 为什么校验放在这里而不是只放在路由：路由只是其中一个调用方。
 * 以后后台补记、脚本回放、Task 4 的"先落库后调模型"都会直接用它 ——
 * 判据只留一处，才不会出现"从这条路径写进去的事件没校验"的口子。
 *
 * 不合法就**抛**：调用方是服务端代码，把一条不认识的事件写进去是 bug，
 * 应当当场炸出来；而"HTTP 埋点不能因此 5xx"是路由的职责（它自己兜住并计数）。
 *
 * 注意 `missing_at` 在这里轮不到：`at` 就是在本函数里盖的。
 * 那个理由属于**HTTP 边界** —— 路由拿客户端的原样去校验（见 router.js 的 acceptEvents），
 * 用来识别"半截埋点"；到了这里，时间已经由服务端提供。
 *
 * 不修改调用方传进来的对象（构造新对象）：同一个事件对象可能被调用方留着，
 * 我们往里面塞 `seq` / `at` 会让它在别处看起来像"已经写过一次了"。
 *
 * @param {object} store 存储端口
 * @param {object} event 事件（可以带客户端时间，会被丢掉）
 * @returns {Promise<void>}
 */
export async function recordEvent(store, event) {
  if (!store || typeof store.appendEvent !== 'function') throw new Error('recordEvent 需要一个存储端口');

  /**
   * 时间先盖好再校验：校验的是**马上要落库的那一个对象**，
   * 而不是"客户端送来 + 我们脑子里补了时间"的中间态 —— 两者会慢慢分叉。
   */
  const record = { ...event, at: new Date().toISOString() };

  const verdict = validateEvent(record);
  if (!verdict.ok) throw new Error(`事件不合法（${verdict.reason}），未写入`);

  /**
   * 序号先拿再写。`incrCounter` 是端口里唯一保证"跨驱动都单调"的原子计数，
   * 两个并发请求不会拿到同一个 seq —— 而并列的 seq 会让排序重新退化成读序。
   * 放在校验之后：一条不合法的事件不该占掉一个号。
   */
  record.seq = await store.incrCounter(SEQ_COUNTER_KEY, 1);

  await store.appendEvent(record);
}
