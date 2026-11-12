// 后端根目录（student-backend/）的唯一来源。
//
// 为什么需要：打包时后端会被 esbuild 合成单文件（见 build.bundle.mjs），
// 合批后所有模块共用**一个** __dirname，源码态那种 `path.resolve(__dirname, '..')`
// 会整体上移一级，把 .env / data / resources 指到错误的位置。
// 因此凡是「相对后端根目录」的路径一律走这里：
//   - 源码态：本文件在 utils/ 下，上一级就是 student-backend/
//   - bundle 态：主进程 fork 时注入 BACKEND_ROOT（= student-backend/ 绝对路径）
const path = require('path');

const BACKEND_ROOT = process.env.BACKEND_ROOT
  ? path.resolve(process.env.BACKEND_ROOT)
  : path.resolve(__dirname, '..');

module.exports = { BACKEND_ROOT };
