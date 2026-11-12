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
