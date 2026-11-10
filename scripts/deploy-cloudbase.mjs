/**
 * 把云函数的环境变量从 `.env` 注入 CloudBase —— 让 `cloudbaserc.json` 里不再有明文凭据。
 *
 * ============================================================================
 * 为什么要有这个脚本
 * ============================================================================
 * 改造前，`LLM_API_KEY` / `ALIYUN_OCR_APPCODE` 直接写在 `cloudbaserc.json` 里。
 * 那个文件虽然进了 `.gitignore`，但它**躺在工作树里**：一次"帮我看看这个配置"的
 * 截图、一次打包发给自己，就是一份明文副本。密钥只该有一个来源（`.env`），
 * 而 `cloudbaserc.json` 只描述**非机密的部署形状**。
 *
 * ============================================================================
 * 为什么不是"直接跑一条命令带上密钥"
 * ============================================================================
 * CloudBase CLI 3.8 里没有 `--envVariables` 这样的命令行参数：环境变量**只能**
 * 从 `cloudbaserc.json` 的 `functions[].envVariables` 推上去（`tcb config update fn`）。
 * 所以脚本干的是这件事：
 *
 *   ① 从 `.env` 读出机密，与非机密默认值合成**完整**的一份环境变量；
 *   ② 把这份完整结果写进一个**临时配置文件**（放在 `.cloudbase/`，跑完即删）；
 *   ③ 用 `tcb config update fn <名字> --config-file <临时文件>` 推上去；
 *   ④ 无论成功失败，临时文件都在 finally 里删掉。
 *
 * 因此 `cloudbaserc.json` 自始至终不含凭据，临时文件只在这一次执行里存在。
 *
 * ----------------------------------------------------------------------------
 * 全量覆盖：这是整个脚本里最危险的一条
 * ----------------------------------------------------------------------------
 * 云端的环境变量更新是**全量覆盖**，不是合并 —— 少推一个就等于把云上那个删掉。
 * 所以：
 *   · 机密缺一个，`--apply` 直接拒绝执行（干跑照常，好让人看见缺什么）；
 *   · 这个脚本是函数环境变量的**唯一来源**：它列出的就是要推上去的全部，
 *     不读云端现值再合并（否则"线上多出一个谁也不知道谁加的变量"会变成常态）。
 *
 * ----------------------------------------------------------------------------
 * 默认值站在安全的那一侧（B4，终审阻塞项）
 * ----------------------------------------------------------------------------
 * 上一版的默认值是反的，照着它做会部署出一个**敞开的**站点：
 *   · `PILOT_REQUIRE_LOGIN` 在"可选开关"里：不配就不推 → 谁打开链接都能对话。
 *     它不报错，老师只会以为学生是登录之后进来的；
 *   · `PILOT_CODE_PEPPER` **一个都不推**，而 `scripts/issue-accounts.mjs` 在本机
 *     用 `.env` 里的胡椒算口令哈希。两边不一致 → 学生每个口令都"不对"，
 *     失败率 100%，而它看起来像"学生不会用"。
 *
 * 现在：`PILOT_REQUIRE_LOGIN` 默认 `1`（要关得显式写 `0`），胡椒进机密清单，
 * 而"目标跑 cloudbase 却没开守卫"会**拒绝执行**并把后果写出来 ——
 * 一个能打开的试点网址会被转发到班级群，而"存在但谁都能进"不会留下任何痕迹。
 *
 * 用法：
 *   node scripts/deploy-cloudbase.mjs            # 干跑：打印要执行什么，机密一律打码
 *   node scripts/deploy-cloudbase.mjs --apply    # 真的执行
 *
 * 部署顺序（顺序反了会出问题，见下面的"注意"）：
 *   1) node scripts/build-cloudbase.mjs                                  拼函数包
 *   2) tcb fn deploy bubujie-api --install-dependency true --force      只推代码
 *   3) node scripts/deploy-cloudbase.mjs --apply                        最后注入环境变量
 *
 * 注意：`tcb fn deploy` 也会应用 `cloudbaserc.json` 里的 `envVariables`（现在里面
 * 已经没有机密了）。先部署代码、最后注入变量，就不会把刚推上去的机密再清掉。
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadEnvFile, ROOT } from '../src/core/env.js';

/**
 * 机密：值只来自 `.env`（或进程环境）；缺一个 `--apply` 就拒绝执行。
 *
 * `PILOT_CODE_PEPPER` 为什么必须在这一栏（B4）：口令哈希是
 * `sha256(PEPPER + ':' + code)`，而 `scripts/issue-accounts.mjs` 是在本机用
 * `.env` 里的胡椒算的。云函数拿不到同一个胡椒时，每一个口令都算不出那个哈希 ——
 * 表现是全班 100% "口令不对"，而不是任何一条报错。它也是"库被盗也猜不出口令"
 * 的唯一防线（见 src/server/auth.js 的文件头），所以它必须和库分开保管、单独推送。
 */
const SECRETS = ['LLM_API_KEY', 'ALIYUN_OCR_APPCODE', 'PILOT_DEV_CODE', 'ADMIN_CODE', 'PILOT_CODE_PEPPER'];

/**
 * 非机密：脚本给出上线时的默认值，`.env` 里有同名变量就用 `.env` 的。
 *
 * `STORE=cloudbase` 不是可选项：试点只跑云数据库（设计稿 §5.10 / §10-10）。
 * 少了它，云函数会退回内存驱动 —— 试点数据重启即丢，而且**失败是静默的**
 * （只在冷启动日志里留一行 warn），没有比这更难发现的了。
 *
 * `PILOT_REQUIRE_LOGIN=1` 也不是可选项（B4）：默认值必须是安全的那一侧。
 * 试点入口挂在公网上，而"不配"= "未登录也能直接对话"，且它不会报错 ——
 * 老师只会以为学生是登录后进来的。要关掉这个守卫，得在 `.env` 里**显式写 0**，
 * 那时 `--apply` 会拒绝执行并说明原因（见 `loginGuardRefusal`）。
 */
const PLAIN_DEFAULTS = {
  STORE: 'cloudbase',
  PILOT_REQUIRE_LOGIN: '1',
  LLM_BASE_URL: 'https://api.deepseek.com/v1',
  LLM_MODEL: 'deepseek-chat',
  PUBLIC_DEMO_FORCE_OFFLINE: '0',
  PUBLIC_DEMO_ALLOW_OCR: '1',
};

/**
 * 可选的开关：`.env` 里有就推上去，没有就不推（等于保持"未配置"）。
 *
 * 为什么单独一类而不是塞进默认值：这几个开关一开就直接影响花钱
 * （一天最多烧多少张 OCR）。它们的值必须由人来定，脚本不替人决定 ——
 * 但要在 `.env` 一个地方就能改，不必回来读源码。
 *
 * `PILOT_REQUIRE_LOGIN` **不在**这里：它是安全开关，不配不能等于"关"（B4）。
 */
const OPTIONAL = ['OCR_DAILY_CAP', 'DEMO_ACCESS_CODE'];

const APPLY = process.argv.includes('--apply');
const CONFIG_PATH = join(ROOT, 'cloudbaserc.json');
const FUNCTION_PACKAGE = join(ROOT, 'dist-cloudbase', 'bubujie-api', 'package.json');

/**
 * 只露尾 2 位与长度：够确认"是不是那把钥匙"，不够还原它。
 * 长度也一并给出 —— 光看 `****9f` 分不清"填对了"和"填了个只剩两位的残值"。
 */
function mask(value) {
  const text = String(value ?? '');
  if (!text) return '（空）';
  const tail = text.length > 6 ? text.slice(-2) : '';
  return `******${tail}（共 ${text.length} 位）`;
}

/**
 * 读 `.env` 并合成完整的一份环境变量；缺什么也一并报出来。
 *
 * 导出是为了让 `test/deploy-config.test.js` 直接断言"注入清单里有哪几个"，
 * 而不必起一份 cloudbaserc.json、更不必真跑 `tcb`。它只读环境与一份配置对象，
 * 没有副作用（除 `loadEnvFile` 补缺失的键，那是既有行为）。
 */
export function collect(config) {
  loadEnvFile();
  /** 进程环境优先（CI 里直接 export 同名变量即可，不必落盘 .env） */
  const read = (name) => String(process.env[name] ?? '').trim();

  const secrets = {};
  const missing = [];
  for (const name of SECRETS) {
    const value = read(name);
    if (value) secrets[name] = value;
    else missing.push(name);
  }

  const plain = {};
  for (const [name, fallback] of Object.entries(PLAIN_DEFAULTS)) plain[name] = read(name) || fallback;

  /**
   * 环境 id 直接从 `cloudbaserc.json` 取：它是部署形状的一部分（非机密），
   * 已经在那里了，不该再让人在 `.env` 里抄一份（抄错就是连到别的环境）。
   * 平台一般会自动注入 `TCB_ENV`，这里显式给一份，是为了"本地直连云库调试"
   * 那种不走云函数入口的场合也有值。
   */
  const envId = String(config?.envId ?? '').trim();
  if (!envId) throw new Error('cloudbaserc.json 里没有 envId —— 不知道该注入到哪个环境，先把它补上');
  plain.TCB_ENV = envId;

  const optional = {};
  for (const name of OPTIONAL) {
    const value = read(name);
    if (value) optional[name] = value;
  }

  return { secrets, missing, plain, optional, envVariables: { ...plain, ...optional, ...secrets } };
}

function readConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      '找不到 cloudbaserc.json（它在 .gitignore 里，需要本机放一份）。最少要有 envId 与 functions[0].name —— 参考 README 的部署一节',
    );
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const fn = config?.functions?.[0];
  if (!fn?.name) throw new Error('cloudbaserc.json 的 functions[0].name 是空的 —— 不知道要更新哪个函数');
  return { config, fn };
}

/**
 * 临时配置：把现有配置抄一份，只换掉 `envVariables`。
 *
 * 为什么不复用真文件再还原：那会让凭据在工作树里存在一段时间，而"临时文件跑完即删"
 * 连那一段窗口也没有。`functionRoot` 改成绝对路径 —— 配置文件换到 `.cloudbase/` 之后，
 * 相对路径的解析基准也跟着变了。
 */
function writeTempConfig(config, fn, envVariables) {
  const dir = join(ROOT, '.cloudbase');
  mkdirSync(dir, { recursive: true });
  const name = `env-${randomUUID()}.json`;
  const file = join(dir, name);
  const temp = {
    ...config,
    functionRoot: resolve(ROOT, 'dist-cloudbase'),
    functions: [{ ...fn, envVariables }],
  };
  writeFileSync(file, `${JSON.stringify(temp, null, 2)}\n`, 'utf8');
  return { file, relative: join('.cloudbase', name) };
}

/**
 * 守卫检查：返回一句**拒绝理由**，或者 `null`（可以继续）。
 *
 * ============================================================================
 * 为什么"缺守卫"要拒绝执行，而不是打一句警告
 * ============================================================================
 * 全量覆盖的注入是**一次成功**的操作：跑完云上就是那个状态，退出码 0，
 * 日志里一个字都不会留。而"未登录也能对话"在页面上完全看不出来 ——
 * 老师会以为学生是登录之后进来的，数据里也看不出少了谁。
 * 一个能打开的试点网址会被转发到班级群，所以这一条必须挡住。
 *
 * 为什么只判 `STORE=cloudbase`：那是"真的有公网入口"的唯一标志
 * （试点只跑云数据库，见 `PLAIN_DEFAULTS`）。本地 / 内存库的 `--apply`
 * 不该被这条卡住 —— 那只会教人把这个脚本当成障碍绕过去。
 *
 * 判据是**严格等于 `'1'`**，与 `router.js` 的 `loginGuardBlocks` 同一口径：
 * `true` / `yes` / `on` 在那边都不算开，这里放行就等于推上去一个打不开的守卫。
 *
 * @param {Record<string,string>} envVariables 这次要推上去的那份变量
 * @param {{apply?: boolean}} [options]
 * @returns {string|null} 拒绝理由（中文，含后果与下一步）；可以继续时是 `null`
 */
export function loginGuardRefusal(envVariables, { apply = false } = {}) {
  if (!apply) return null;
  if (String(envVariables?.STORE ?? '').trim() !== 'cloudbase') return null;

  const guard = String(envVariables?.PILOT_REQUIRE_LOGIN ?? '').trim();
  if (guard === '1') return null;

  const actual = guard === '' ? '空' : `"${guard}"`;
  return (
    `目标环境跑 cloudbase（公网可访问），但 PILOT_REQUIRE_LOGIN 不是 1（实际：${actual}）。\n` +
    '    这一行不是 1，含义就是"任何人打开链接都能直接对话"：试点入口一旦被转发到班级群，\n' +
    '    未登录的对话不会留下任何能看出来的痕迹（老师只会以为学生是登录后进来的）。\n' +
    '    要开试点，就在 .env 里写 PILOT_REQUIRE_LOGIN=1（学生口令由发号脚本发，见 README）。\n' +
    '    确认这个部署本来就不需要登录时，把 STORE 换成非 cloudbase 再跑 —— 不要靠删掉这一行绕过。'
  );
}

/**
 * 干跑 / 执行前那一段给人看的输出。
 *
 * 为什么抽成纯函数：`test/deploy-config.test.js` 要断言"读的人到底看到了什么"
 * （尤其守卫那一行），而在本机放一份 cloudbaserc.json、甚至真跑一次 `tcb`，
 * 都不是这一组该做的事 —— 它要证明的正是"还没跑就会被挡住"。
 *
 * @param {{fnName?: string, apply?: boolean, secrets?: object, missing?: string[],
 *          plain?: object, optional?: object, envVariables?: object,
 *          warnings?: string[]}} [input]
 * @returns {string}
 */
export function renderReport({
  fnName = '',
  apply = false,
  secrets = {},
  missing = [],
  plain = {},
  optional = {},
  envVariables = {},
  warnings = [],
} = {}) {
  /**
   * 变量名那一列的宽度按最长的一个算。
   * 写死一个数会在大写长名（PUBLIC_DEMO_FORCE_OFFLINE，25 个字符）上挤成一团，
   * 而这一列要是看不齐，人就会去读错行 —— 那份表读错的代价是配错线上环境变量。
   */
  const names = [...SECRETS, ...Object.keys(plain), ...Object.keys(optional)];
  const width = Math.max(...names.map((name) => name.length), 0) + 2;
  const row = (name, value) => `    ${name.padEnd(width)}${value ?? ''}\n`;

  let out = `\n▶ CloudBase 环境变量注入 · ${fnName}${apply ? '（--apply，真的执行）' : '（干跑，不做任何改动）'}\n\n`;

  out += '  机密（来自 .env / 进程环境）：\n';
  for (const name of SECRETS) {
    const value = secrets[name];
    out += row(name, value ? mask(value) : '（缺失）');
  }

  out += '\n  非机密（默认值，可被 .env 覆盖）：\n';
  for (const [name, value] of Object.entries(plain)) out += row(name, value);

  /**
   * 守卫单独说一句（B4）：表里只有一个 `1` 时，读的人得回去翻代码才知道 1 是"开"，
   * 而这一个值决定了整个部署是不是谁都能进。干跑就要把后果说出来，
   * 不能等到 `--apply` 那一刻才第一次出现"未登录"三个字。
   */
  const guard = String(plain.PILOT_REQUIRE_LOGIN ?? '').trim();
  out +=
    guard === '1'
      ? '\n  登录守卫：PILOT_REQUIRE_LOGIN=1（未登录一律 401）\n'
      : `\n  登录守卫：PILOT_REQUIRE_LOGIN=${guard === '' ? '（空）' : guard}（不是 1：未登录也能直接对话，--apply 会拒绝）\n`;

  out += '\n  可选开关（只有 .env 里给了才推）：\n';
  if (Object.keys(optional).length === 0) {
    out += '    （都没有配 —— 保持"未配置"：OCR 日额度不限、没有口令门）\n';
  } else {
    for (const [name, value] of Object.entries(optional)) {
      // 这几个不是机密，但 DEMO_ACCESS_CODE 是口令，按机密一并打码
      out += row(name, name === 'DEMO_ACCESS_CODE' ? mask(value) : value);
    }
  }

  out += `\n  ▶ 实际推送 ${Object.keys(envVariables).length} 个变量（全量覆盖：云上多出来的会被删掉）\n`;

  if (missing.length) {
    out +=
      `\n  ✗ 缺 ${missing.length} 个机密：${missing.join('、')}\n` +
      '    全量覆盖下，缺一个就等于把云上那个删掉，所以 --apply 会拒绝执行。\n' +
      '    把它们写进 .env（或直接 export）之后再跑一次。\n';
  }

  for (const line of warnings) out += line;

  return out;
}

/**
 * 函数包预检：没有云 SDK 的话，函数跑起来会**静默退回内存驱动**
 * （见 src/server/store/index.js），也就是"看起来部署成功了，数据却在重启后全没了"。
 */
function packageWarnings() {
  if (!existsSync(FUNCTION_PACKAGE)) {
    return [`\n  ！还没打包（找不到 ${FUNCTION_PACKAGE}）：先跑 node scripts/build-cloudbase.mjs\n`];
  }
  if (!readFileSync(FUNCTION_PACKAGE, 'utf8').includes('@cloudbase/node-sdk')) {
    return ['\n  ！函数包清单里没有 @cloudbase/node-sdk：重新跑一次 node scripts/build-cloudbase.mjs\n'];
  }
  return [];
}

function main() {
  const { config, fn } = readConfig();
  const collected = collect(config);
  const { missing, envVariables } = collected;

  process.stdout.write(renderReport({ fnName: fn.name, apply: APPLY, warnings: packageWarnings(), ...collected }));

  if (!APPLY) {
    process.stdout.write('\n  要执行的命令：\n');
    process.stdout.write(`    tcb config update fn ${fn.name} --config-file <临时文件>\n`);
    process.stdout.write('\n  ↑ 机密只写进临时文件（.cloudbase/，跑完即删），cloudbaserc.json 里不再有明文。\n');
    process.stdout.write('    加 --apply 才真的执行。\n\n');
    return;
  }

  /**
   * 守卫**先于**"缺机密"判（B4）：缺机密时脚本什么都不做，
   * 而守卫没开时脚本会**成功** —— 那才是真正会把一个敞开的站点推上去的那条路。
   */
  const refusal = loginGuardRefusal(envVariables, { apply: APPLY });
  if (refusal) {
    process.stdout.write(`\n  ✗ 已拒绝执行：${refusal}\n\n`);
    process.exitCode = 1;
    return;
  }

  if (missing.length) {
    process.stdout.write('\n  ✗ 已拒绝执行：先把上面缺的机密补齐。\n\n');
    process.exitCode = 1;
    return;
  }

  const total = Object.keys(envVariables).length;

  const { file, relative } = writeTempConfig(config, fn, envVariables);
  try {
    /**
     * 命令拼成一条字符串交给 shell，而不是 `execFileSync(带参数数组, { shell: true })`：
     * 后者从 Node 20 起会发 DEP0190 警告（参数不转义、只拼接），而这条命令的参数里
     * 没有任何需要转义的东西 —— 函数名来自 cloudbaserc.json（有空格直接拒绝，见下），
     * 临时路径是 `.cloudbase/env-<uuid>.json`。**不要**把用户输入拼进来。
     */
    if (!/^[A-Za-z0-9_-]+$/.test(fn.name)) {
      throw new Error(`函数名 ${fn.name} 里出现了字母数字与 -_ 之外的字符，这条命令不敢拼`);
    }
    const command = `tcb config update fn ${fn.name} --config-file ${relative}`;
    process.stdout.write(`\n  ▸ 执行：${command}\n\n`);
    execSync(command, { cwd: ROOT, stdio: 'inherit' });
    process.stdout.write(`\n  ✓ 已推送 ${total} 个变量到 ${fn.name}\n`);
  } catch (err) {
    process.stdout.write(
      `\n  ✗ 注入失败：${err?.message ?? err}\n` +
        '    常见原因：没登录（tcb login）、envId 不对、或没有该环境的操作权限。\n' +
        '    云端变量此时可能仍是覆盖前的值 —— 先确认再重试，别连跑两次不同配置。\n',
    );
    process.exitCode = 1;
  } finally {
    /**
     * 无论成败都删：这是这个脚本存在的全部意义（凭据不留副本）。
     *
     * 用 unlinkSync 而不是 rmSync(force)：在 Windows 上这里有环境让 rmSync
     * **静默地什么都不删**（不抛错、文件还在），而那是"看起来删了"的最坏形状。
     * 真删不掉就明说，不假装删掉了 —— 那个路径最后会打到屏幕上，人自己删得掉。
     */
    try {
      unlinkSync(file);
    } catch {
      process.stdout.write(`\n  ！临时文件没删掉，请手动删除（里面有本次的机密）：${file}\n`);
    }
  }

  process.stdout.write(
    '\n  ▸ 下一步：node scripts/build-cloudbase.mjs → tcb fn deploy bubujie-api --install-dependency true\n' +
      '    顺序别反：tcb fn deploy 也会应用 cloudbaserc.json 的 envVariables（那里已经没有机密了）。\n\n',
  );
}

/**
 * 只在**直接执行**时真的跑。
 *
 * 为什么要有这个判断：`test/deploy-config.test.js` 会 import 这个文件来断言
 * 默认值与拒绝逻辑 —— 一 import 就去读 cloudbaserc.json、打一屏表、（有人手滑加了
 * --apply 时）甚至改云上环境变量，那是测试里最不该发生的事。
 * 判据取 `process.argv[1]` 的 file URL，而不是"有没有被 import"这种猜法。
 */
const ENTRY = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (ENTRY && ENTRY === import.meta.url) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`\n✗ ${err?.message ?? err}\n\n`);
    process.exitCode = 1;
  }
}
