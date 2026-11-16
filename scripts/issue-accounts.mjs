/**
 * 发号脚本：给一个批次造 N 个账号，并写出能直接发给学生的 CSV。
 *
 *   node scripts/issue-accounts.mjs --batch b2 --count 30 --out accounts-b2.csv
 *
 * 为什么是脚本而不是网页注册：
 *   试点要的是"老师发号、学生只登录"。开放注册会混进不认识的人，
 *   而一个没有登记真名的账号在看板上只是一个代号，事后没法核对是谁。
 *
 * ---------------------------------------------------------------------------
 * 两个容易踩的点，写在这里省得下次再踩
 * ---------------------------------------------------------------------------
 * ① **默认必须落盘。** 这个进程跑完就退，若沿用 `openStore()` 的默认（memory），
 *    刚发的号会随着进程一起消失，而 CSV 已经在手里了 —— 发出去的号谁也登不上。
 *    所以 `STORE` 没配时这里默认用 file 驱动写 `.data/`。
 *    线上（CloudBase）跑时显式配 `STORE=cloudbase` 即可，脚本不用改。
 *
 * ② **口令只进 CSV，不打印到终端。** 终端输出会进 CI 日志、tmux scrollback、
 *    截图里。号是要发给学生的，但它只该出现在那份 CSV 里。
 *
 * 导出的三个函数是给测试用的：脚本本身"能跑"和"内容对"是两件事，
 * 后者要能一条一条断言（BOM、列序、链接）。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { openStore } from '../src/server/store/index.js';
import { issueAccounts } from '../src/server/auth.js';
import { loadEnvFile } from '../src/core/env.js';

/** CSV 列头。改这里的顺序等于改老师手上的名单格式，别随手改。 */
const HEADER = ['序号', '代号', '口令', '登录链接'];

/**
 * 解析命令行参数。
 *
 * 不用第三方参数库：零依赖是产品前提。这里只认 `--key value` 这一种写法，
 * 认不出来就当场报错 —— 静默忽略一个拼错的参数，会变成"号发了但没写文件"。
 *
 * @param {string[]} argv
 * @returns {{ batchId: string|null, count: number, out: string|null, prefix: string, start: number }}
 */
export function parseArgs(argv) {
  const opts = { batchId: null, count: 0, out: null, prefix: 'S', start: 1 };
  const lookup = { '--batch': 'batchId', '--count': 'count', '--out': 'out', '--prefix': 'prefix', '--start': 'start' };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const key = lookup[flag];
    if (!key) throw new Error(`不认识的参数 ${flag}。可用：${Object.keys(lookup).join(' ')}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`参数 ${flag} 后面缺一个值`);
    }
    i += 1;
    if (key === 'count' || key === 'start') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw new Error(`参数 ${flag} 需要一个非负整数，收到 ${value}`);
      opts[key] = n;
    } else {
      opts[key] = value;
    }
  }

  if (!opts.batchId) throw new Error('缺少 --batch（例如 --batch b2）');
  if (!opts.count) throw new Error('缺少 --count，且必须大于 0（例如 --count 30）');
  if (!opts.out) throw new Error('缺少 --out（例如 --out accounts-b2.csv）');
  return opts;
}

/**
 * 一个 CSV 单元格。
 *
 * 只做最低限度的转义：含逗号、引号或换行时用双引号包起来、内部引号翻倍。
 * 链接里出现逗号（查询串里的列表）是唯一现实会触发的情况，
 * 但缺了它整行就会错位，而错位只有老师打开 Excel 时才发现。
 */
function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 造 CSV 文本。
 *
 * 三个硬要求：
 *   · **UTF-8 BOM 开头** —— 否则 Excel 打开中文列名是乱码（一定要有）；
 *   · 列序固定 `序号,代号,口令,登录链接`；
 *   · 行尾用 CRLF —— Excel 对 CSV 的默认预期就是它。
 *
 * `登录链接` 只放**站点地址**，绝不把口令拼进 URL：
 * 链接会被转发到班级群，一旦带上口令，等于把"可以单独停用某一个人"
 * 这个优势直接扔掉（设计稿 §5.1 选口令而不是一次性链接的理由）。
 *
 * @param {Array<{ displayName: string, code: string }>} rows
 * @param {string} [baseUrl] 站点地址（`PILOT_BASE_URL`），没配就留空
 * @returns {string}
 */
export function buildCsv(rows, baseUrl = '') {
  const link = String(baseUrl ?? '').trim();
  const lines = [HEADER.join(',')];
  rows.forEach((row, index) => {
    lines.push([index + 1, row.displayName, row.code, link].map(csvCell).join(','));
  });
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** 这一版的内容版本号。取不到 git（比如拷到别的机器上跑）就记 unknown，不编。 */
function gitShortSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    return sha || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 组装跑脚本用的配置。
 *
 * `STORE` 没配时默认 file：见文件头的理由，发号进程一退内存就没了。
 * `STORE_DIR` 一起定默认值，否则 file 驱动会写到别处去。
 */
function storeConfig(env) {
  const config = { ...(env ?? process.env) };
  if (!String(config.STORE ?? '').trim()) {
    config.STORE = 'file';
    if (!String(config.STORE_DIR ?? '').trim()) config.STORE_DIR = '.data';
  }
  return config;
}

/**
 * 建批次（若不存在）→ 发号 → 写 CSV。
 *
 * `questionIds` 留空是**故意的**：题单还没定，脚本不替人编一份看起来像真的清单。
 * 批次已存在就完全不碰它（不覆盖 label、不重启时间窗），
 * 老师改过的字段不该被一次重跑冲掉。
 *
 * @param {{ batchId: string, count: number, out: string, prefix?: string, start?: number, env?: object }} options
 * @returns {Promise<{ rows: Array<{ displayName: string, code: string }>, outPath: string }>}
 */
export async function issueBatch({ batchId, count, out, prefix = 'S', start = 1, env } = {}) {
  const config = storeConfig(env);
  const store = await openStore(config);

  try {
    const existing = await store.getBatch(batchId);
    if (!existing) {
      const nowIso = new Date().toISOString();
      await store.putBatch({
        id: batchId,
        /** 老师可以事后改成"高一 3 班 第一轮"，先给一个不会撞车的默认值 */
        label: batchId,
        versionSha: gitShortSha(),
        versionBuiltAt: nowIso,
        /** 题单还没定，留空由人工填 */
        questionIds: [],
        startsAt: nowIso,
        /** 结束时间未知：null 表示"还没结束"，不是"已经过期" */
        endsAt: null,
        /** 配额与时长先按设计稿 §5.2 的默认值，试点时再按班调 */
        ocrCap: 0,
        dailyCap: 0,
        idleMinutes: 8,
        abandonHours: 24,
        allowPhoto: false,
        createdAt: nowIso,
      });
    }

    const rows = await issueAccounts(store, { batchId, count, prefix, start });
    const outPath = resolve(out);

    try {
      /**
       * 先建目录再写：`--out /tmp/x.csv` 这种写法在 Windows 上会解析到
       * 当前盘符根下的 tmp，而那个目录通常不存在 —— 直接 writeFileSync 会 ENOENT。
       */
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buildCsv(rows, config.PILOT_BASE_URL), 'utf8');
    } catch (err) {
      /**
       * 这是发号里最难收尾的一种失败，所以错误必须自己把话说全。
       *
       * 明文口令只存在于这一次运行的 CSV 里，库里只有哈希 —— 文件没写出去，
       * 这批口令就永远找不回来了，而这批代号已经被占住（重跑会撞"代号已存在"）。
       * 抛一个光秃秃的 EACCES/EISDIR，操作的人只会反复重跑，越跑越乱。
       */
      throw new Error(
        `号已经写进库（批次 ${batchId}，共 ${rows.length} 个），但 CSV 没写出去：${err?.message ?? err}。` +
          `这批口令已经找不回来了。下一步：把这一批人从库里删掉` +
          `（file 驱动是 .data/test_user 与 .data/batch_member 里属于 ${batchId} 的记录），` +
          `再修好 --out 指向的路径后重跑。`,
      );
    }

    return { rows, outPath };
  } finally {
    /** 一定要走 close：云驱动后面可能要刷缓冲，不收尾等于偶尔丢几条 */
    await store.close();
  }
}

/**
 * 命令行入口。
 *
 * 只打印**路径与人数**，不打印口令本身（见文件头 ②）。
 *
 * @param {string[]} argv
 * @returns {Promise<string>} 写出的 CSV 绝对路径
 */
export async function main(argv) {
  const args = parseArgs(argv);
  const { rows, outPath } = await issueBatch(args);
  process.stdout.write(`已发出 ${rows.length} 个账号，批次 ${args.batchId}。\n`);
  process.stdout.write(`CSV（含口令，请勿外传）：${outPath}\n`);
  return outPath;
}

/**
 * 只在"被直接执行"时跑，被 import 时什么都不做 ——
 * 测试要 import 上面的纯函数，不能顺带写文件。
 *
 * 这里读 `.env`：本机的其他密钥都在那儿，`PILOT_CODE_PEPPER` 也会跟着去那儿。
 * 服务器（router.js 里也调 loadEnvFile）必须和发号用**同一个胡椒**，
 * 否则发出去的口令在本地一个都登不上 —— 而这种不一致从两边各自看都"正常"。
 * 放在这个分支里而不是文件顶层：被测试 import 时不该动 process.env。
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFile();
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`发号失败：${err?.message ?? err}\n`);
    process.exitCode = 1;
  });
}
