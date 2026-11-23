// =========================================================================
// build.bundle.mjs —— 把后端打成单文件 app.bundle.js（v6 · 2-17）
//
// 为什么：后端启动期要 require 160+ 个模块。即使有 NODE_COMPILE_CACHE 省掉编译，
// 每个文件仍要 stat + 读取 + 建模块记录；实测单独跑 48ms 能跑完，和 Electron 启动高峰
// 叠加后会被拉长到 200~390ms，首屏 7 条请求的 accept 被推迟 100~165ms。
// 合成单文件后文件读取次数从 160+ 降到 1。
//
// 保持外置的依赖（必须留在 node_modules 里按需加载）：
//   - better-sqlite3-multiple-ciphers / sharp：原生 .node，esbuild 无法内联
//   - pdf-parse / mammoth / xlsx：自带 worker 或资源文件，且只在 AI 附件上传时懒加载
//   - yauzl：unzipSafe 静态 require + backupArchive 用 createRequire 动态解析
//
// 产物与 main.backend.js 的约定：生产模式优先 fork app.bundle.js，不存在则回退 app.js。
// =========================================================================

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'app.bundle.js');

const EXTERNAL = [
  'better-sqlite3-multiple-ciphers',
  'sharp',
  'pdf-parse',
  'mammoth',
  'xlsx',
  'yauzl',
  // MCP SDK（方向 B）：~20MB、含 zod 与多子路径导出，内联会撑大 bundle 且
  // 破坏子路径解析；且它只在首次 /mcp 请求才 require，留在 node_modules 按需加载。
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/node',
  '@modelcontextprotocol/core',
  'zod',
];

const result = await build({
  entryPoints: [path.join(HERE, 'app.js')],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: EXTERNAL,
  // 内联源码文字使用 UTF-8：日志里有大量中文，避免转义后体积膨胀
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});

const size = fs.statSync(OUT).size;
const modules = Object.keys(result.metafile.inputs).length;
console.log(`[bundle] app.bundle.js ${(size / 1024).toFixed(0)}KB，内联模块 ${modules} 个（外置：${EXTERNAL.join(', ')}）`);

// =========================================================================
// 防漏打包：bundle 必须内联全部业务源码
//
// esbuild 只跟随**静态** require。哪天有人写成 `require(`./${name}`)` 或把新文件挂在
// 运行时拼出的路径上，单文件产物会静默少一个模块 —— dev 直接跑源码永远复现不了，
// 只有打包版启动到那条路由时才 500。这里在构建期就对账，漏了直接失败。
//
// 按设计**不进** bundle 的文件：
//   · init.js           —— 独立脚本（手动建库/修库），不被 app.js 引用
//   · worker.scan.js    —— 相册扫描的子进程入口，由 fork 拉起，必须留在磁盘上
//   · mcp-forwarder.cjs —— 方向 B 的 stdio 转发器，由 Claude Desktop 直接拉起，留在磁盘上
//   · mcpForwarderDiscovery.cjs —— 上面那个转发器的依赖（端口发现），必须跟它一起留在磁盘上。
//                          转发器不进 bundle，它的 require 也就不会被 esbuild 跟到。
// 按**目录**整块排除的：
//   · migrations/       —— 迁移体系预置件，接入前没有任何代码 require 它。
//                          不能按文件名排除（这里的 index.js 和别处同名），只能按目录。
//                          将来接线时把它从 NOT_BUNDLED_DIRS 里去掉，漏打包检查会立刻抓到。
const NOT_BUNDLED = new Set([
  'init.js',
  'worker.scan.js',
  'mcp-forwarder.cjs',
  'mcpForwarderDiscovery.cjs',
]);
const NOT_BUNDLED_DIRS = ['migrations/'];

function listBackendSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { listBackendSources(full, out); continue; }
    if (!/\.(js|cjs|mjs)$/.test(entry.name)) continue;
    // 产物自身与构建脚本不是输入
    if (entry.name === 'app.bundle.js' || entry.name === 'build.bundle.mjs') continue;
    if (NOT_BUNDLED.has(entry.name)) continue;
    const rel = path.relative(HERE, full).split(path.sep).join('/');
    if (NOT_BUNDLED_DIRS.some((prefix) => rel.startsWith(prefix))) continue;
    out.push(path.relative(process.cwd(), full).split(path.sep).join('/'));
  }
  return out;
}

// =========================================================================
const inlined = new Set(Object.keys(result.metafile.inputs).map((p) => p.split(path.sep).join('/')));
const missing = listBackendSources(HERE).filter((rel) => !inlined.has(rel));
if (missing.length) {
  console.error('[bundle] 以下源码没有进 bundle（大概率是动态 require 导致 esbuild 没跟到）：');
  for (const rel of missing) console.error(`  - ${rel}`);
  console.error('[bundle] 要么改成静态 require，要么确认它确实不该进 bundle 后加进 NOT_BUNDLED。');
  process.exit(1);
}
console.log(`[bundle] 源码对账通过：${listBackendSources(HERE).length} 个文件全部内联`);
