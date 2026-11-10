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

import { loadEnvFile, ROOT } from '../src/core/env.js';

/** 机密：值只来自 `.env`（或进程环境）；缺一个 `--apply` 就拒绝执行 */
const SECRETS = ['LLM_API_KEY', 'ALIYUN_OCR_APPCODE', 'PILOT_DEV_CODE', 'ADMIN_CODE'];

/**
 * 非机密：脚本给出上线时的默认值，`.env` 里有同名变量就用 `.env` 的。
 *
 * `STORE=cloudbase` 不是可选项：试点只跑云数据库（设计稿 §5.10 / §10-10）。
 * 少了它，云函数会退回内存驱动 —— 试点数据重启即丢，而且**失败是静默的**
 * （只在冷启动日志里留一行 warn），没有比这更难发现的了。
 */
const PLAIN_DEFAULTS = {
  STORE: 'cloudbase',
  LLM_BASE_URL: 'https://api.deepseek.com/v1',
  LLM_MODEL: 'deepseek-chat',
  PUBLIC_DEMO_FORCE_OFFLINE: '0',
  PUBLIC_DEMO_ALLOW_OCR: '1',
};

/**
 * 可选的开关：`.env` 里有就推上去，没有就不推（等于保持"未配置"）。
 *
 * 为什么单独一类而不是塞进默认值：这几个开关一开就直接影响安全与花钱
 * （未登录能不能对话、一天最多烧多少张 OCR）。它们的值必须由人来定，
 * 脚本不替人决定 —— 但要在 `.env` 一个地方就能改，不必回来读源码。
 */
const OPTIONAL = ['PILOT_REQUIRE_LOGIN', 'OCR_DAILY_CAP', 'DEMO_ACCESS_CODE'];

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

/** 读 `.env` 并合成完整的一份环境变量；缺什么也一并报出来 */
function collect(config) {
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

function main() {
  const { config, fn } = readConfig();
  const { secrets, missing, plain, optional, envVariables } = collect(config);

  /**
   * 变量名那一列的宽度按最长的一个算。
   * 写死一个数会在大写长名（PUBLIC_DEMO_FORCE_OFFLINE，25 个字符）上挤成一团，
   * 而这一列要是看不齐，人就会去读错行 —— 那份表读错的代价是配错线上环境变量。
   */
  const names = [...SECRETS, ...Object.keys(plain), ...Object.keys(optional)];
  const width = Math.max(...names.map((name) => name.length)) + 2;
  const row = (name, value) => `    ${name.padEnd(width)}${value}\n`;

  process.stdout.write(`\n▶ CloudBase 环境变量注入 · ${fn.name}${APPLY ? '（--apply，真的执行）' : '（干跑，不做任何改动）'}\n\n`);

  process.stdout.write('  机密（来自 .env / 进程环境）：\n');
  for (const name of SECRETS) {
    const value = secrets[name];
    process.stdout.write(row(name, value ? mask(value) : '（缺失）'));
  }

  process.stdout.write('\n  非机密（默认值，可被 .env 覆盖）：\n');
  for (const [name, value] of Object.entries(plain)) process.stdout.write(row(name, value));

  process.stdout.write('\n  可选开关（只有 .env 里给了才推）：\n');
  if (Object.keys(optional).length === 0) {
    process.stdout.write('    （都没有配 —— 保持"未配置"：未登录可直接对话、OCR 日额度不限）\n');
  } else {
    for (const [name, value] of Object.entries(optional)) {
      // 这几个不是机密，但 DEMO_ACCESS_CODE 是口令，按机密一并打码
      process.stdout.write(row(name, name === 'DEMO_ACCESS_CODE' ? mask(value) : value));
    }
  }

  const total = Object.keys(envVariables).length;
  process.stdout.write(`\n  ▶ 实际推送 ${total} 个变量（全量覆盖：云上多出来的会被删掉）\n`);

  if (missing.length) {
    process.stdout.write(
      `\n  ✗ 缺 ${missing.length} 个机密：${missing.join('、')}\n` +
        '    全量覆盖下，缺一个就等于把云上那个删掉，所以 --apply 会拒绝执行。\n' +
        '    把它们写进 .env（或直接 export）之后再跑一次。\n',
    );
  }

  /**
   * 预检：函数包里有没有云 SDK。
   * 没有的话，函数跑起来会**静默退回内存驱动**（见 src/server/store/index.js），
   * 也就是"看起来部署成功了，数据却在重启后全没了"。
   */
  if (!existsSync(FUNCTION_PACKAGE)) {
    process.stdout.write(`\n  ！还没打包（找不到 ${FUNCTION_PACKAGE}）：先跑 node scripts/build-cloudbase.mjs\n`);
  } else if (!readFileSync(FUNCTION_PACKAGE, 'utf8').includes('@cloudbase/node-sdk')) {
    process.stdout.write('\n  ！函数包清单里没有 @cloudbase/node-sdk：重新跑一次 node scripts/build-cloudbase.mjs\n');
  }

  if (!APPLY) {
    process.stdout.write('\n  要执行的命令：\n');
    process.stdout.write(`    tcb config update fn ${fn.name} --config-file <临时文件>\n`);
    process.stdout.write('\n  ↑ 机密只写进临时文件（.cloudbase/，跑完即删），cloudbaserc.json 里不再有明文。\n');
    process.stdout.write('    加 --apply 才真的执行。\n\n');
    return;
  }

  if (missing.length) {
    process.stdout.write('\n  ✗ 已拒绝执行：先把上面缺的机密补齐。\n\n');
    process.exitCode = 1;
    return;
  }

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

try {
  main();
} catch (err) {
  process.stdout.write(`\n✗ ${err?.message ?? err}\n\n`);
  process.exitCode = 1;
}
