/**
 * 极简 zip 写入器（store 模式，不压缩）。
 *
 * ============================================================================
 * 为什么要自己写
 * ============================================================================
 * 运行时依赖必须保持 `{}`（这是产品前提：交到教研/企业手里时"clone 下来就能跑"
 * 比"先装一堆包"重要），而 Node 20 的标准库里**没有** zip 写入器。
 * `zlib.deflateRawSync` 只解决"压缩"，不解决"容器"：本地头、中央目录、EOCD、
 * CRC32 仍然得自己拼。这一版干脆不压缩（method = 0）：导出件里有对话正文，
 * 压缩率本来也不高，少一个变量就少一类"解压软件打得开、Excel 打不开"的怪事。
 *
 * ============================================================================
 * 三条刻意写死的东西
 * ============================================================================
 * ① **CRC32 自己算**（控制者补充 E1）。`zlib.crc32` 是 Node 22 才有的，
 *    本项目的下限是 Node 20（`package.json` 的 engines）。在 Node 20 上它直接是
 *    `undefined`，而"那台机器"很可能就是学校机房的那台。
 * ② **时间戳固定 1980-01-01**（`DOS_TIME = 0`、`DOS_DATE = 0x0021`）。
 *    zip 的时间戳字段没有时区信息，用"现在"就等于把本机时区写进导出件；
 *    更要紧的是批量导出会逐版本 diff，同样的内容每次字节不同，diff 就全是噪音，
 *    最后没人看 diff。固定之后，同一输入必然产出同一串字节。
 * ③ **文件名标 UTF-8**（`FLAG_UTF8`，通用标志位 bit 11，控制者补充 E2）。
 *    当前条目名都是 ASCII（`session.md` / `session.json`），但导出件将来会带
 *    中文路径（批次名、学生代号）。不置这一位，Windows 上的解压软件会按 GBK
 *    去猜，猜错就是一片乱码文件名 —— 而那种 bug 只有中文用户看得到。
 *
 * ============================================================================
 * 条目名要校验（控制者补充 E3）
 * ============================================================================
 * 导出件是要发给外人打开的，一条 `../../` 就是事故（解压时写到导出目录之外）。
 * 所以这里对 `..`、绝对路径、重名、空名、超长名**一律抛错**，不静默跳过：
 * 静默跳过的结果是"导出件看起来正常，但少了一份东西"，而少的那份没人知道。
 *
 * ============================================================================
 * 本版不处理的两件事（都不属于试点量级）
 * ============================================================================
 *   · zip64：单条会话、一个批次的导出件远小于 4 GB，用不着。
 *   · 条目数上限：EOCD 的条目数是两字节，超过 65535 条会被截断。批量导出是
 *     "固定几份 + 每个会话一份"，试点量级到不了这个数。
 */

/** 四种结构签名（小端写的 ASCII：PK\x03\x04 等） */
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** 需要的解压版本 2.0。store 模式用不着更高，写小一点兼容性更好 */
const VERSION = 20;

/** 通用标志位 bit 11：文件名是 UTF-8（E2） */
const FLAG_UTF8 = 0x0800;

/** 固定的 DOS 时间戳：1980-01-01 00:00（见文件头 ② ） */
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;

/** 方法 0 = store（不压缩）。store 模式的两个大小字段必须相等 */
const METHOD_STORE = 0;

/** 本地头 30 字节、中央目录条目 46 字节、EOCD 22 字节 */
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;

/** 名字长度字段是两字节 */
const MAX_NAME_BYTES = 0xffff;

/**
 * CRC32 查表（多项式 0xEDB88320，zip 用的就是它）。
 *
 * 表在模块加载时生成一次：256 项，每项 8 轮移位。逐位算也对，但导出批次时
 * 要对每个条目算一遍，查表是白拿的性能。
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * CRC32。**不要换成 `zlib.crc32`**：那是 Node 22 才有的，本项目的下限是 Node 20。
 */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 校验条目名（只校验，不改写）。
 *
 * 每条错都带上"是哪个名字、错在哪、上限是多少"：导出失败时看到这句话的人
 * 往往是在命令行里跑脚本的人，他需要知道该改哪一行。
 */
function checkName(name, seen) {
  if (typeof name !== 'string') {
    throw new Error(`zip 条目名必须是字符串，收到 ${typeof name}`);
  }
  if (name.trim() === '') {
    throw new Error('zip 条目名不能为空');
  }
  if (name.startsWith('/')) {
    throw new Error(`zip 条目名不能以 / 开头（那是绝对路径）：${name}`);
  }
  if (name.includes('..')) {
    throw new Error(`zip 条目名不能包含 ".."（那是上级目录的写法）：${name}`);
  }
  if (seen.has(name)) {
    throw new Error(`zip 条目名重复：${name}`);
  }
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes > MAX_NAME_BYTES) {
    throw new Error(`zip 条目名太长（${bytes} 字节，上限 ${MAX_NAME_BYTES}）：${name.slice(0, 20)}…`);
  }
}

/**
 * 把若干条目打成一个 zip（store 模式）。
 *
 * @param {Array<{ name: string, data: string | Buffer }>} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('createZip 收到的是条目数组');
  }

  /**
   * 先归一化成"名字的字节 + 数据字节 + CRC"。
   *
   * 为什么不边写边算：本地头与中央目录都要这三样，两处各算一遍的话
   * `crc32` 会把每个条目扫两次（导出批次时是成倍的），更要紧的是
   * "两处各写一遍"正是偏移/长度写错的温床。算一次，两处都用它。
   */
  const seen = new Set();
  const files = entries.map((entry) => {
    const name = entry?.name;
    checkName(name, seen);
    seen.add(name);
    const raw = entry?.data ?? '';
    const data = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
    return { nameBuf: Buffer.from(name, 'utf8'), data, crc: crc32(data) };
  });

  /** 本地头 + 名字 + 数据，按顺序首尾相接 */
  const localParts = [];
  /** 中央目录的条目 */
  const centralParts = [];
  /** 当前写到的位置：既是本条的本地头偏移，全部写完之后也是中央目录的起点 */
  let offset = 0;

  for (const file of files) {
    const nameBytes = file.nameBuf.length;
    const size = file.data.length;

    const local = Buffer.alloc(LOCAL_HEADER_SIZE);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_STORE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(file.crc, 14);
    local.writeUInt32LE(size, 18); // 压缩后大小（store 模式 = 原样）
    local.writeUInt32LE(size, 22); // 解压后大小
    local.writeUInt16LE(nameBytes, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    localParts.push(local, file.nameBuf, file.data);

    /** 中央目录里这一条：偏移量回指它自己的本地头 */
    const central = Buffer.alloc(CENTRAL_HEADER_SIZE);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(VERSION, 4); // 写盘版本（这里与解压版本同值）
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(METHOD_STORE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(file.crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes, 28);
    central.writeUInt16LE(0, 30); // 扩展字段
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 起始盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, file.nameBuf);

    offset += LOCAL_HEADER_SIZE + nameBytes + size;
  }

  const central = Buffer.concat(centralParts);

  /** EOCD 是解压软件的入口：条目数、中央目录的大小与起点都在这里 */
  const eocd = Buffer.alloc(EOCD_SIZE);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // 本盘号
  eocd.writeUInt16LE(0, 6); // 中央目录所在盘号
  eocd.writeUInt16LE(files.length, 8); // 本盘条目数
  eocd.writeUInt16LE(files.length, 10); // 总条目数
  eocd.writeUInt32LE(central.length, 12); // 中央目录大小
  eocd.writeUInt32LE(offset, 16); // 中央目录起点
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...localParts, central, eocd]);
}
