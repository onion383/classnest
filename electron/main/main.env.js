// =========================================================================
// main.env.js —— 开发 / 打包模式判定（唯一口径）
//
// 【为什么不能直接用 app.isPackaged】
// 实测 Electron 45.2.3：用 `electron .`（源码模式）启动时 `app.isPackaged` 仍返回 **true**
// （同一时刻 `process.defaultApp === true`）。照它判分支，源码模式会走打包路径：
//   · `main.backend.js` 去 `resources/app.asar.unpacked/student-backend` 找入口 → spawn 失败；
//   · `main.updater.js` 在开发环境跑「检查 + 下载」；
//   · `main.dev-loader.js` 被禁用（不轮询 Vite，热更新流程失效）。
//
// 【判定口径】
// `process.defaultApp` 的语义是「Electron 把入口 JS 当参数启动」，即源码模式；
// 打包后恒为 undefined。两个条件任一命中即视为开发模式，任一都不依赖单一 API 的实现细节：
//   isDev = 显式以入口 JS 启动(process.defaultApp) 或 未被 electron-builder 打包(!app.isPackaged)
//
// 所有主进程模块统一从这里取，不要再各自写 `!app.isPackaged`（那是这次的根因）。
// =========================================================================

const { app } = require('electron')

const isDev = !!process.defaultApp || !app.isPackaged
const isPackaged = !isDev

module.exports = { isDev, isPackaged }
