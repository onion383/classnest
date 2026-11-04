// =========================================================================
// ipc-guard-probe.cjs —— 主进程 IPC 拦截层回归探针
//
// 验证 installIpcGuard() 真的做到了「每一次注册都带发送方校验」：
//   1) 授权内的角色 → handler 被调用；
//   2) 授权外的角色 → handler **不被调用**，且调用方拿到 undefined；
//   3) 未登记窗口 → 同样被拒；
//   4) 表外通道 → 被拒（fail-closed）；
//   5) installIpcGuard 幂等（重复安装不会套两层校验）。
//
// 用假 ipcMain 顶替真 electron：只验证包装逻辑，不依赖 Electron 运行时。
//
// 运行：node testjs/probe/ipc-guard-probe.cjs
// =========================================================================

const path = require('path')
const Module = require('module')

const ROOT = path.resolve(__dirname, '..', '..')

// ---- 造一个假 electron 模块，插进 require 缓存 ----
const registered = { on: {}, handle: {} }
const fakeIpcMain = {
  on(channel, listener) { registered.on[channel] = listener },
  handle(channel, listener) { registered.handle[channel] = listener },
}
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron'
  return origResolve.call(this, request, ...rest)
}
require.cache.electron = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: { ipcMain: fakeIpcMain, app: { isPackaged: false, getPath: () => '', getVersion: () => '0' } },
}

const auth = require(path.join(ROOT, 'electron/main/main.ipc-auth.js'))

let failed = 0
const failures = []
function assert(cond, msg) {
  if (!cond) { failed++; failures.push(msg) }
}

// ---- 安装拦截 ----
assert(auth.installIpcGuard() === true, '首次 installIpcGuard 应返回 true')
assert(auth.installIpcGuard() === false, '重复 installIpcGuard 应返回 false（幂等）')

// ---- 注册一批通道，验证包装行为 ----
// 注意：fakeIpcMain.on/handle 用「同通道覆盖」的语义（和真 ipcMain 一致），
// 所以每个通道只能注册一次 —— 之前这里注册了两次 set-data-dir，
// 第二次把第一次的 wrapper 换掉，导致 handler 计数错位（探针自身的 bug，不是实现的 bug）。
//
// 关键：越权时 handler **根本不该被调用**。所以用「一个通道 + 一个计数器」，
// 而不是靠 handler 内部区分来源 —— 那样 handler 照样会跑，测不出拦截。
let mainCalls = 0
const { ipcMain } = require('electron')
ipcMain.on('set-data-dir', () => { mainCalls++; return 'main-ok' })

const fakeEvent = (role) => ({ sender: role ? { __ipcRole: role } : {} })

// 1) 授权内 → handler 被调用
const mainResult = registered.on['set-data-dir'](fakeEvent(auth.ROLE.MAIN))
assert(mainCalls === 1, `主窗口调用 set-data-dir 应触发 handler（实际调用 ${mainCalls} 次）`)
assert(mainResult === 'main-ok', '主窗口调用应返回 handler 的返回值')

// 2) 授权外 → handler 不被调用
const widgetResult = registered.on['set-data-dir'](fakeEvent(auth.ROLE.WIDGET))
assert(mainCalls === 1, `工具箱浮窗调用 set-data-dir 不应触发 handler（实际累计调用 ${mainCalls} 次）`)
assert(widgetResult === undefined, '越权调用应返回 undefined')

// 3) 未登记窗口 → 被拒
registered.on['set-data-dir'](fakeEvent(null))
assert(mainCalls === 1, '未登记窗口调用不应触发 handler')

// 4) 表外通道 → 被拒（fail-closed）
let unknownCalls = 0
ipcMain.on('绝对不存在的通道-zzz', () => { unknownCalls++ })
registered.on['绝对不存在的通道-zzz'](fakeEvent(auth.ROLE.MAIN))
assert(unknownCalls === 0, '表外通道即使来自主窗口也不应触发 handler')

// 5) handle 型同样被拦
let handleCalls = 0
ipcMain.handle('set-data-dir', () => { handleCalls++; return 'h' })
const hRes = registered.handle['set-data-dir'](fakeEvent(auth.ROLE.WIDGET))
assert(handleCalls === 0, 'invoke 型通道的越权调用不应触发 handler')
assert(hRes === undefined, 'invoke 型越权调用应返回 undefined')
registered.handle['set-data-dir'](fakeEvent(auth.ROLE.MAIN))
assert(handleCalls === 1, 'invoke 型通道的主窗口调用应触发 handler')

// 6) 授权表里角色齐全：每个角色对每条通道的行为自洽
for (const [channel, roles] of Object.entries(auth.CHANNEL_ROLES)) {
  for (const role of auth.ALL_ROLES) {
    const allowed = roles.includes(role)
    const actual = auth.isAllowed(channel, fakeEvent(role))
    assert(allowed === actual, `通道「${channel}」对角色「${role}」的判定与授权表不一致`)
  }
}

if (failed) {
  console.error(`\n✗ ipc-guard-probe：${failed} 条断言失败\n`)
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('✓ ipc-guard-probe：拦截层断言全过（授权内放行 / 越权拒绝 / 表外 fail-closed / 幂等）')
