/**
 * 组装「腾讯云 CloudBase 云函数」的部署包。
 *
 * 为什么需要这一步：
 *   CloudBase 的 handler 是 `exports.main`（CommonJS），
 *   而本项目 `package.json` 是 `"type": "module"`，src/ 全是 ESM。
 *   直接把 src/ 丢上去，`require` 与 `import` 会互相打架。
 *
 * 解法（不改一行源码，也不引第三方打包器）：
 *   dist-cloudbase/bubujie-api/
 *     index.js          ← CommonJS 薄壳，动态 import 真正的处理函数
 *     package.json      ← {"type":"commonjs"}
 *     src/              ← 源码原样复制
 *       package.json    ← {"type":"module"}  让 src/*.js 仍是 ESM
 *
 * 这样 Node 会按「最近的一层 package.json」决定模块类型，
 * 两层各用各的，互不干扰。零依赖，跑 `node scripts/build-cloudbase.mjs` 即可。
 */

import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 递归复制目录。
 *
 * 为什么不用 fs.cpSync({recursive:true})：在这台机器的 Node v24.13.0 上
 * 它会直接以 0xC0000409（STATUS_STACK_BUFFER_OVERRUN）崩掉整个进程 ——
 * 不是抛异常，是进程级崩溃，连 try/catch 都接不住。
 * 手写这版只用 readdirSync / statSync / copyFileSync，行为稳定。
 */
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.isFile()) copyFileSync(src, dest);
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-cloudbase');
const FN_NAME = 'bubujie-api';
const FN_DIR = join(OUT, FN_NAME);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(FN_DIR, { recursive: true });

// ① 源码原样复制（src/ 自包含，不引用公共目录外的任何文件）
copyDir(join(ROOT, 'src'), join(FN_DIR, 'src'));

/**
 * ② 静态资源一起打进去。
 *
 * 为什么页面也由函数出：CloudBase 的静态托管域名（*.tcloudbaseapp.com）
 * 与 HTTP 访问服务域名（*.service.tcloudbase.com）是两个域，
 * 拆开就要跨域 + CORS + 前端记绝对地址。整站一共 8 个文件、0.33 MB，
 * 塞进函数包换来单域与零跨域，对演示站是划算的交换。
 */
copyDir(join(ROOT, 'public'), join(FN_DIR, 'public'));

// ② 内层：让 src/ 继续按 ESM 解析
writeFileSync(
  join(FN_DIR, 'src', 'package.json'),
  `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
  'utf8',
);

// ③ 外层：CommonJS 薄壳，handler 固定为 index.main
writeFileSync(
  join(FN_DIR, 'index.js'),
  `'use strict';

/**
 * CloudBase 云函数入口。
 *
 * 只有一句实事：把 CommonJS 的 main 桥接到 ESM 的 handleCloudbaseEvent。
 * 真正的翻译逻辑在 src/server/cloudbase-handler.js —— 与 Vercel、Cloudflare
 * 两个入口共用同一套口令门与业务代码。
 */

let loaded = null;

function load() {
  if (!loaded) loaded = import('./src/server/cloudbase-handler.js');
  return loaded;
}

exports.main = async function main(event) {
  const mod = await load();
  return mod.handleCloudbaseEvent(event);
};
`,
  'utf8',
);

writeFileSync(
  join(FN_DIR, 'package.json'),
  `${JSON.stringify(
    {
      name: FN_NAME,
      version: '1.0.0',
      private: true,
      type: 'commonjs',
      main: 'index.js',
      engines: { node: '>=18' },
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`已生成 ${FN_DIR}`);
