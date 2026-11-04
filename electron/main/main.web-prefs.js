// =========================================================================
// web-prefs.js —— BrowserWindow 的 webPreferences 公共模板
//
// 应用内所有窗口（主窗口 / 引导窗口 / 迁移窗口 / 工具箱浮窗 / 桌面组件）采用同一套
// 渲染进程安全配置：contextIsolation + sandbox + 关闭 nodeIntegration + 预加载脚本，
// 生产环境开启 webSecurity。差异只有三点：是否开启 devTools、是否关闭后台节流
// （需要持续重绘的浮窗类），以及预加载脚本路径（所有窗口共用同一份，故无需传参）。
// =========================================================================

const path = require('path')
const { app } = require('electron')

// IPC 通道名单一来源（与渲染层 src/electronChannels.js 共用同一份 JSON）。
// preload 运行在 sandbox 里，无法 require 本地文件，故由主进程读取后经 additionalArguments
// 以字符串形式注入渲染进程 argv，preload 再从 process.argv 解析（见 preload.js）。
const ipcChannels = require('../ipc-channels.json')

// IPC 授权表（通道 → 允许的窗口角色）。与名单分开：名单是「有哪些通道」，
// 授权表是「谁能调」。裁剪后的名单按角色注入 preload —— 渲染层拿不到越权通道，
// 比等到主进程拒绝更早一步（审查 v4 · B01-01/02/03/04、C01-07 的根因修复）。
const ipcAuth = require('./main.ipc-auth')

// 统一构造 webPreferences。
// devTools：是否允许开发者工具（默认随环境：生产关闭、开发开启）。
// backgroundThrottling：传入时写入该项（浮窗类传 false 以保持后台绘帧）。
// webviewTag：是否允许该窗口使用 <webview> 内嵌网页（仅主窗口的右侧网页抽屉需要，默认关闭，
//             避免给其余窗口无谓地多开一项渲染能力）。
// ipcRole：该窗口的角色（main/widget/desktop-widget/setup/migration）——
//          决定注入 preload 的 IPC 白名单范围；不传则给全量名单（不裁剪）。
function buildWebPreferences({ devTools, backgroundThrottling, webviewTag, ipcRole } = {}) {
  const isDev = !app.isPackaged
  // 按角色裁剪通道名单；角色未知时退回全量（不因裁剪把功能掐死），
  // 但主进程侧的运行时校验仍然生效（fail-closed）。
  const allowed = ipcRole
    ? ipcAuth.channelsForRole(ipcRole, ipcChannels)
    : { send: ipcChannels.send, invoke: ipcChannels.invoke, receive: ipcChannels.receive }
  const prefs = {
    preload: path.join(__dirname, '..', 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    // 开启 OS 级沙箱：即使注入成功也跑不出渲染进程安全边界。
    // contextIsolation + nodeIntegration:false 仍是软件层兜底。
    sandbox: true,
    // 注入渲染进程 argv：--secure-channel 供 preload 暴露 window.__SECURE_CHANNEL__；
    // --ipc-channels 传 IPC 通道白名单（sandbox 下 preload 不能 require 本地文件，只能这样传）。
    additionalArguments: ['--secure-channel', '--ipc-channels=' + JSON.stringify(allowed)],
    // webSecurity 仅开发模式关闭（用于加载自签名 https 的 Vite 服务）；
    // 生产环境必须保持开启，禁止在打包后关闭网页安全策略。
    webSecurity: !isDev,
    spellcheck: false,
    devTools: devTools === undefined ? isDev : devTools,
  }
  if (backgroundThrottling !== undefined) prefs.backgroundThrottling = backgroundThrottling
  if (webviewTag !== undefined) prefs.webviewTag = webviewTag
  return prefs
}

module.exports = { buildWebPreferences }