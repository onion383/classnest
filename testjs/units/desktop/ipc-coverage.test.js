// =========================================================================
// ipc-coverage.test.js —— 档 C-5「IPC 包装层覆盖」
//
//   N3-05  ipcMain.once 也必须过 installIpcGuard（不能只包 handle/on）
//   N3-06  preload 内部调用（预取主密钥）必须走白名单包装，不能直连 ipcRenderer
//   N3-07  widget 两条通道必须有模块内第二道 sender 闸（与同模块其它通道一致）
//
// 手法：静态形态判据（去注释后匹配）+ 关键行为用假 ipcMain 真跑守卫。
// =========================================================================
const test = require('node:test')
const { abs, read } = require('#testjs/paths')
const assert = require('node:assert/strict')


function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const IPC_AUTH = 'electron/main/main.ipc-auth.js'
const PRELOAD = 'electron/preload.js'
const WIDGET = 'electron/main/main.widget.js'

test('[静态] N3-05 installIpcGuard 同时包装 handle / on / once，三条都过 checkSender', () => {
  const code = stripComments(read(IPC_AUTH))
  for (const m of ['handle', 'on', 'once']) {
    const re = new RegExp(`ipcMain\\.${m} = \\(channel, listener\\) => \\{[\\s\\S]{0,400}?checkSender\\(channel, event\\)`)
    // @pin electron/main/main.ipc-auth.js#checkSender
    assert.match(code, re, `ipcMain.${m} 的包装里必须调用 checkSender`)
  }
  // once 的拒绝路径与 on 一致：静默丢弃，不抛给渲染层
  assert.match(
    code,
    /ipcMain\.once = \(channel, listener\) => \{[\s\S]{0,400}?rawOnce\(channel, \(event, \.\.\.args\) => \{[\s\S]{0,160}?if \(!checkSender\(channel, event\)\) return undefined/
  )
})

test('[静态] N3-06 preload 里只有一处 ipcRenderer.invoke，且预取主密钥走白名单包装', () => {
  const code = stripComments(read(PRELOAD))
  const hits = code.match(/ipcRenderer\.invoke\(/g) || []
  assert.equal(hits.length, 1, `ipcRenderer.invoke 应只出现在 invokeWhitelisted 内，实际 ${hits.length} 处`)
  // @pin electron/preload.js#invokeWhitelisted
  assert.match(code, /const invokeWhitelisted = \(channel, \.\.\.args\) => \{[\s\S]{0,200}?validInvokeChannels\.includes\(channel\)/)
  assert.match(code, /invoke: invokeWhitelisted/)
  // 通道名只保留一份常量（preload 在 sandbox 里无法 require 本地 channels 模块），
  // 改通道时靠这条判据保证调用点跟着常量走，而不是在函数体里再写一遍字面量。
  assert.match(code, /const GET_MASTER_KEY_CHANNEL = 'get-master-key'/)
  assert.match(code, /invokeWhitelisted\(GET_MASTER_KEY_CHANNEL\)/)
  assert.equal((code.match(/'get-master-key'/g) || []).length, 1, 'get-master-key 字面量只应出现在常量定义处')
})

test('[静态] N3-07 WIDGET_SET_SESSION_VISIBLE / TO_WIDGET 都有第二道窗口身份闸', () => {
  const code = stripComments(read(WIDGET))
  const session = code.slice(
    code.indexOf('CH.WIDGET_SET_SESSION_VISIBLE'),
    code.indexOf('CH.WIDGET_SET_SESSION_VISIBLE') + 400
  )
  assert.match(session, /fromMainWindow\(event\)/, '会话开关必须限定主窗口来源')
  assert.match(session, /fromWidgetWindow\(event\)/, '会话开关必须允许浮窗自身来源')

  const relay = code.slice(code.indexOf('CH.TO_WIDGET'), code.indexOf('CH.TO_WIDGET') + 400)
  assert.match(relay, /fromMainWindow\(event\)/, 'TO_WIDGET 中继必须只接受主窗口来源')
})

test('[行为] installIpcGuard 装好后，once 注册的 listener 被未授权来源调用时不执行', () => {
  // 用假 ipcMain + 假策略表真跑守卫，避免只靠字符串判据。
  const Module = require('node:module')
  const authPath = abs(IPC_AUTH)
  const authSrc = read(IPC_AUTH)
  assert.match(authSrc, /function installIpcGuard/)

  const fakeHandlers = { handle: null, on: null, once: null }
  const fakeIpcMain = {
    handle(ch, fn) { fakeHandlers.handle = { ch, fn } },
    on(ch, fn) { fakeHandlers.on = { ch, fn } },
    once(ch, fn) { fakeHandlers.once = { ch, fn } },
  }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { ipcMain: fakeIpcMain }
    return originalLoad.call(this, request, parent, isMain)
  }
  delete require.cache[authPath]
  let guard
  try {
    guard = require(authPath)
    const installed = guard.installIpcGuard()
    assert.equal(installed, true, '守卫应安装成功')
    // 第二次安装应幂等
    assert.equal(guard.installIpcGuard(), false)
  } finally {
    Module._load = originalLoad
    delete require.cache[authPath]
  }

  // 未登记通道：once listener 不得执行
  let called = 0
  const wrapped = fakeIpcMain.once
  assert.ok(fakeHandlers.once === null, '假 ipcMain 的原始 once 还没被调用')
  const fakeEvent = { sender: { id: 1234 } }
  // 守卫包装后的 ipcMain.once 已替换了 fakeIpcMain.once
  fakeIpcMain.once('totally-unregistered-channel-xyz', () => { called++ })
  assert.ok(fakeHandlers.once, '包装后的 once 必须把原始调用转发给 rawOnce')
  // 直接调用原始注册进来的 listener（模拟事件到达）
  const rawOnce = fakeHandlers.once
  void wrapped
  assert.ok(rawOnce, '包装后的 once 必须仍然注册到原始 ipcMain.once')
  const origWarn = console.warn
  console.warn = () => {}
  try {
    rawOnce.fn(fakeEvent)
  } finally {
    console.warn = origWarn
  }
  assert.equal(called, 0, '未登记通道的 once listener 不能被执行')
})
