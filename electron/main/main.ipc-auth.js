// =========================================================================
// ipc-auth.js —— IPC 授权层（单一事实来源）
//
// 存在的原因（审查 v4 · B01-01/02/03/04、C01-07）：
//   此前「哪个渲染层能调哪条 IPC」这件事散落在各 handler 内手写 if
//   （widget.js 的 fromWidgetWindow、main.js 的 event.sender !== mainWindow.webContents …），
//   同一份语义有两套写法，于是 12 条通道里 5 条漏校验 —— 漏的是最危险的那批
//   （set-data-dir / set-db-encryption / get-master-key / update-install / shutdown-action）。
//
// 本模块把这件事收口成**一张表 + 两个执行点**：
//
//   表：electron/ipc-policy.json —— 通道 → 允许的窗口角色。
//       由 testjs/probe/ipc-policy-gen.mjs 从渲染层静态 import 图推导，
//       探针 ipc-policy-probe.cjs 保证它不与真实调用方脱节。
//
//   执行点 1（渲染层）：main.web-prefs.js 按窗口角色把白名单裁剪后注入 preload，
//       渲染层根本调不到越权通道。
//   执行点 2（主进程）：installIpcGuard() 包装 ipcMain.handle / ipcMain.on，
//       **所有**注册自动带上发送方校验 —— 包括将来新加的通道。
//
//   表里没有的通道 → 一律拒绝（fail-closed）。新增通道若忘了登记，
//   会在开发期立刻表现为「调用没生效」，而不是像以前那样「忘了写 if 就等于放行」。
//
// 角色取值：
//   main            主窗口（唯一持有完整 UI 与业务写权限的窗口）
//   widget          工具箱浮窗（widget.html）
//   desktop-widget  桌面小组件（desktop-widget.html）
//   setup           首次安装引导窗口（setup.html）
//   migration       数据库迁移/加密进度窗口（migration.html）
//
// 注：所有窗口同 origin（app://local 或 dev 的 127.0.0.1:5173），
//     所以「同源」不构成任何边界 —— 边界只由这张表 + 渲染层不加载外部内容构成。
// =========================================================================

// 注意：electron 全部**惰性** require（写在函数体内，不在模块顶层）。
//   原因：本模块的授权表与裁剪逻辑是纯数据/纯函数，必须能在普通 node 下被单测加载
//   （require('electron') 只在 Electron 主进程里可用，顶层 require 会让探针直接崩）。
const policy = require('../ipc-policy.json')

const ROLE = {
  MAIN: 'main',
  WIDGET: 'widget',
  DESKTOP_WIDGET: 'desktop-widget',
  SETUP: 'setup',
  MIGRATION: 'migration',
}
const ALL_ROLES = Object.values(ROLE)

// 通道 → 允许角色（表外 = 拒绝）
const CHANNEL_ROLES = {}
for (const [channel, roles] of Object.entries(policy)) {
  if (channel.startsWith('_')) continue
  CHANNEL_ROLES[channel] = Array.isArray(roles) ? roles.slice() : []
}

function allowedRoles(channel) {
  return CHANNEL_ROLES[channel] || null
}

// =========================================================================
// 角色登记
//
// 窗口创建后调 registerWindowRole(win, role)。登记信息挂在 webContents 上，
// 不用另维护一张 id→role 表（窗口销毁时 webContents 一起销毁，不会留脏数据）。
// =========================================================================
const ROLE_KEY = '__ipcRole'

function registerWindowRole(win, role) {
  if (!win || win.isDestroyed()) return false
  if (!ALL_ROLES.includes(role)) throw new Error(`未知的 IPC 角色：${role}`)
  try {
    win.webContents[ROLE_KEY] = role
    return true
  } catch (err) {
    // 挂不上角色 = 该窗口的所有 IPC 都会被 fail-closed 拒绝。静默返回 false 会让
    // 「界面所有按钮都没反应」变成一个无从排查的哑故障，至少留下一条日志
    // （审查 v5 · V5-052）。
    console.error('[ipc-auth] 窗口角色登记失败，该窗口的 IPC 将全部被拒绝：', role, err)
    return false
  }
}

// 取事件来源窗口的角色；取不到 → null（= 不放行）
function roleOf(event) {
  try {
    const sender = event && event.sender
    if (!sender) return null
    return sender[ROLE_KEY] || null
  } catch (_) {
    return null
  }
}

// 核心判定：来源窗口角色是否在允许集合内。
//   通道未登记 → 拒绝（fail-closed）
//   角色不在集合 → 拒绝
function isAllowed(channel, event) {
  const roles = allowedRoles(channel)
  if (!roles || !roles.length) return false
  const role = roleOf(event)
  if (!role) return false
  return roles.includes(role)
}

// 判定 + 拒绝日志。返回布尔值；拒绝时打一行 warn（便于事后查“谁在越权调用”）。
function checkSender(channel, event) {
  if (isAllowed(channel, event)) return true
  const role = roleOf(event) || '未登记窗口'
  const allow = allowedRoles(channel)
  console.warn(
    `[ipc-auth] 拒绝越权 IPC「${channel}」：来源角色=${role}` +
    (allow && allow.length ? `，允许角色=${allow.join('/')}` : '（该通道未登记授权，默认拒绝）')
  )
  return false
}

// =========================================================================
// 执行点 2：主进程侧统一拦截
//
// 包装 ipcMain.handle / ipcMain.on，让**每一次**注册自动带发送方校验。
// 这样做而不是逐个 handler 加 if，有三个好处：
//   1) 不会再漏 —— 新加通道自动受控，不依赖作者记得写校验；
//   2) 不会再有两套写法 —— 原来 widget.js 一套、main.js 另一套，语义还不完全一致；
//   3) 授权表是唯一判据 —— 改一处即可，不必同步 N 个 handler。
//
// 必须在所有模块 require 并注册 IPC **之前**调用（main.js 顶部）。
// =========================================================================
let guardInstalled = false

function installIpcGuard() {
  if (guardInstalled) return false
  const { ipcMain } = require('electron')
  const rawHandle = ipcMain.handle.bind(ipcMain)
  const rawOn = ipcMain.on.bind(ipcMain)

  ipcMain.handle = (channel, listener) => {
    if (typeof listener !== 'function') return rawHandle(channel, listener)
    return rawHandle(channel, (event, ...args) => {
      if (!checkSender(channel, event)) return undefined
      return listener(event, ...args)
    })
  }

  ipcMain.on = (channel, listener) => {
    if (typeof listener !== 'function') return rawOn(channel, listener)
    return rawOn(channel, (event, ...args) => {
      if (!checkSender(channel, event)) return undefined
      return listener(event, ...args)
    })
  }

  guardInstalled = true
  return true
}

// =========================================================================
// 执行点 1：渲染层侧白名单裁剪
//
// 给定窗口角色，返回该角色可用的通道名单。主进程按此裁剪后注入 preload，
// 渲染层调不到越权通道 —— 比主进程拒绝更早一步拦下。
//
// 说明：ipc-channels.json 是「有哪些通道」的名单（preload 白名单 + 前端常量表共用），
//       ipc-policy.json 是「谁能调」的名单。两者分开：前者是 API 清单，后者是权限。
// =========================================================================
function channelsForRole(role, channelsJson) {
  const src = channelsJson || require('../ipc-channels.json')
  const pick = (list) => (list || []).filter((c) => {
    const roles = CHANNEL_ROLES[c]
    return Array.isArray(roles) && roles.includes(role)
  })
  return {
    send: pick(src.send),
    invoke: pick(src.invoke),
    // receive 方向是主进程推给渲染层，不涉及“谁有资格发起”，故不按角色裁剪。
    receive: (src.receive || []).slice(),
  }
}

module.exports = {
  ROLE,
  ALL_ROLES,
  CHANNEL_ROLES,
  allowedRoles,
  registerWindowRole,
  roleOf,
  isAllowed,
  checkSender,
  installIpcGuard,
  channelsForRole,
}
