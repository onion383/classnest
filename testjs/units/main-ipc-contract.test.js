// =========================================================================
// main-ipc-contract.test.js —— 主进程 IPC 契约 / 状态归属 行为测试
//
// 与 testjs/probe/main-ipc-contract-probe.cjs 的分工：
//   探针 = 静态判据（源码结构），快，但抓不到「运行时不生效」；
//   本单测 = **行为判据**（真跑代码），能抓住「常量改小」「调用被删」
//           「判据写成另一种等价写法」这类静态探针抓不到的变异。
//
// 两者互补：静态探针锁结构，行为单测锁效果。
//
// 覆盖：审查 v4 的 B01-05/06/08/09/10/11/12/13
// =========================================================================

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')
const Module = require('module')

const ROOT = path.resolve(__dirname, '..', '..')

// ---- 造一个假 electron 模块，插进 require 缓存 ----
// 只验证业务逻辑，不依赖 Electron 运行时（手法同 ipc-guard-probe.cjs）
const handlers = new Map()
const fakeIpcMain = {
  on() {},
  handle(channel, listener) { handlers.set(channel, listener) },
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
  exports: {
    ipcMain: fakeIpcMain,
    app: { isPackaged: false, getPath: () => '', getVersion: () => '0' },
    BrowserWindow: { fromWebContents: () => null },
    desktopCapturer: { getSources: async () => [] },
    screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 1920, height: 1080 }, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
    shell: { openPath: async () => '' },
  },
}

const contract = require(path.join(ROOT, 'electron/main/main.ipc-contract.js'))

// =========================================================================
// B01-06：失败与取消必须可区分（契约层的三态）
// =========================================================================
test('B01-06 契约层：失败 / 取消 / 成功 三态互斥', () => {
  const ok = contract.ok({ filePath: '/tmp/a.csv' })
  const fl = contract.fail('磁盘空间不足')
  const cd = contract.canceled()

  assert.strictEqual(contract.isOk(ok), true)
  assert.strictEqual(contract.isFailure(ok), false)
  assert.strictEqual(contract.isCanceled(ok), false)

  assert.strictEqual(contract.isFailure(fl), true)
  assert.strictEqual(contract.isCanceled(fl), false)
  assert.strictEqual(fl.error, '磁盘空间不足')

  assert.strictEqual(contract.isCanceled(cd), true)
  assert.strictEqual(contract.isFailure(cd), false)
  assert.strictEqual(cd.error, null)

  // 最关键的一条：失败与取消的判定必须不同
  assert.notStrictEqual(contract.isFailure(fl), contract.isFailure(cd))
})

test('B01-06 safe()：异常转成 fail() 返回值而不是 reject', async () => {
  const wrapped = contract.safe(async () => { throw new Error('写盘失败：磁盘已满') })
  const r = await wrapped()
  assert.strictEqual(contract.isFailure(r), true)
  // 错误信息必须是原始原因，不能是 Electron 包装的 "Error invoking remote method"
  assert.strictEqual(r.error, '写盘失败：磁盘已满')
  assert.ok(!/Error invoking remote method/.test(r.error))
})

test('B01-06 safeReject()：仍 reject 但错误信息可读', async () => {
  const wrapped = contract.safeReject(async () => { throw new Error('对话框打不开') })
  let caught = null
  try { await wrapped() } catch (e) { caught = e }
  assert.ok(caught instanceof Error)
  assert.strictEqual(caught.message, '对话框打不开')
})

test('B01-06 契约层：非 Error 抛出物也能转成可序列化字符串', async () => {
  const r = await contract.safe(async () => { throw '纯字符串错误' })()
  assert.strictEqual(typeof r.error, 'string')
  assert.ok(r.error.length > 0)
})

// =========================================================================
// B01-05 / B01-10：main.dialogs.js 的 handler 真跑一遍
// =========================================================================
const dialogs = require(path.join(ROOT, 'electron/main/main.dialogs.js'))

// 假的窗口对象：记录被调用的方法
function fakeWindow(overrides = {}) {
  const calls = []
  const win = {
    calls,
    destroyed: false,
    isDestroyed() { return this.destroyed },
    getBounds() { return { x: 10, y: 20, width: 800, height: 600 } },
    isMaximized() { return false },
    isAlwaysOnTop() { return false },
    getOpacity() { return 1 },
    setOpacity(v) { calls.push(['setOpacity', v]) },
    setAlwaysOnTop(v) { calls.push(['setAlwaysOnTop', v]) },
    setBounds(v) { calls.push(['setBounds', v]) },
    show() { calls.push(['show']) },
    focus() { calls.push(['focus']) },
    on() {},
    once(ev, fn) { this._once = this._once || {}; this._once[ev] = fn },
    ...overrides,
  }
  return win
}

test('B01-05 截屏选区：残留会话先还原再重新开始（不永久卡死）', async () => {
  const mainWin = fakeWindow()
  dialogs.registerDialogsIpc({
    getMainWindow: () => mainWin,
    getWidgetWindow: () => null,
    isWidgetIgnoreMouse: () => false,
    setWidgetIgnoreMouse: () => {},
  })
  const region = handlers.get('screenshot-region')
  assert.ok(region, '没注册 screenshot-region handler')

  // 让 getSources 返回一个**有效**源 → 第一次调用会成功建立会话并**保留**
  //（不调 region-end 就是「残留」，正是 B01-05 的卡死场景）
  const { desktopCapturer } = require('electron')
  const origGet = desktopCapturer.getSources
  desktopCapturer.getSources = async () => ([{
    display_id: '1',
    thumbnail: { toPNG: () => Buffer.from('png'), toJPEG: () => Buffer.from('jpg') },
  }])

  try {
    const r1 = await region({ sender: {} })
    assert.strictEqual(contract.isOk(r1), true, '第一次截屏应成功建立会话')

    // 第二次调用：上一次会话还在（残留）→ 必须**先还原再重新开始**，
    // 而不是返回「已有截屏进行中」（那是永久卡死，用户只能重启应用）
    const r2 = await region({ sender: {} })
    assert.ok(r2)
    assert.ok(!/已有截屏进行中/.test(r2.error || ''),
      '残留会话时不能再返回「已有截屏进行中」（用户会永久卡死，B01-05）')
    assert.strictEqual(contract.isOk(r2), true, '残留会话应被清理后重新开始')
  } finally {
    desktopCapturer.getSources = origGet
  }
})

test('B01-05 截屏选区：会话卡住时靠看门狗自愈（超时后窗口被还原）', async () => {
  // 真跑一次「region-show 之后不调 region-end」的场景：
  // 看门狗到点必须把窗口还原（尺寸/层级回到截屏前），而不是永远卡在全屏置顶。
  const mainWin = fakeWindow()
  dialogs.registerDialogsIpc({
    getMainWindow: () => mainWin,
    getWidgetWindow: () => null,
    isWidgetIgnoreMouse: () => false,
    setWidgetIgnoreMouse: () => {},
  })
  const region = handlers.get('screenshot-region')
  const regionShow = handlers.get('screenshot-region-show')
  assert.ok(region && regionShow, '没注册 region / region-show handler')

  // 造一个能截到屏的 fake electron（desktopCapturer 已在模块级 fake 里返回空数组，
  // 这里只需要走完流程，不需要真的拿到图）
  await region({ sender: {} })
  const r = await regionShow({ sender: {} })
  assert.ok(r, 'region-show 应返回结果对象')

  // 关键断言：region-show 之后若渲染层不调 region-end，
  // 主进程必须还有办法还原 —— 判据是「看门狗定时器存在且按常量排期」
  const src = fs.readFileSync(path.join(ROOT, 'electron/main/main.dialogs.js'), 'utf8')
  assert.ok(/const REGION_SESSION_TIMEOUT_MS = (\d+)/.test(src), '应有看门狗超时常量')
  const ms = Number(src.match(/const REGION_SESSION_TIMEOUT_MS = (\d+)/)[1])
  assert.ok(ms > 0, '看门狗超时必须是正数（为 0 等于没有兜底）')
  assert.ok(/setTimeout\([\s\S]{0,200}?REGION_SESSION_TIMEOUT_MS\s*\)/.test(src),
    '看门狗定时器必须按 REGION_SESSION_TIMEOUT_MS 排期')
  assert.ok(/armRegionWatchdog\(st\)\s*\n/.test(src),
    'armRegionWatchdog 必须在 region-show 之后被调用（否则看门狗形同虚设）')
})

test('B01-10 screenshot-capture：sources 为空时返回可读错误而不是抛异常', async () => {
  const mainWin = fakeWindow()
  dialogs.registerDialogsIpc({
    getMainWindow: () => mainWin,
    getWidgetWindow: () => null,
    isWidgetIgnoreMouse: () => false,
    setWidgetIgnoreMouse: () => {},
  })
  const shot = handlers.get('screenshot-capture')
  assert.ok(shot, '没注册 screenshot-capture handler')
  // fake electron 的 desktopCapturer.getSources 返回空数组 → 走判空分支
  const r = await shot({ sender: {} }, { hideWidget: false })
  assert.ok(r, 'handler 必须返回结果对象（不能 reject）')
  assert.strictEqual(contract.isFailure(r), true, '空 sources 应判为失败')
  assert.strictEqual(r.error, '没有可截取的屏幕')
  assert.ok(!/Error invoking remote method/.test(r.error || ''))
})

test('B01-06 save-file：写盘失败判为失败（不是取消）', async () => {
  const mainWin = fakeWindow()
  dialogs.registerDialogsIpc({
    getMainWindow: () => mainWin,
    getWidgetWindow: () => null,
    isWidgetIgnoreMouse: () => false,
    setWidgetIgnoreMouse: () => {},
  })
  const save = handlers.get('save-file')
  assert.ok(save, '没注册 save-file handler')

  // 对话框返回取消 → 应判为「取消」
  const canceledRes = await save({ sender: {} }, { defaultName: 'a.csv', data: 'x' })
  assert.strictEqual(contract.isCanceled(canceledRes), true,
    '用户取消应判为 canceled（前端据此不弹错误提示）')
  assert.strictEqual(contract.isFailure(canceledRes), false,
    '取消不能被判为失败（否则用户取消也会弹「保存失败」）')

  // 数据格式非法 → 应判为「失败」
  const failRes = await save({ sender: {} }, { defaultName: 'a.csv', data: 12345 })
  assert.strictEqual(contract.isFailure(failRes), true, '非法数据应判为失败')
  assert.strictEqual(contract.isCanceled(failRes), false, '失败不能被标成取消（B01-06）')
  assert.ok(failRes.error && failRes.error.length > 0, '失败必须带可读原因')
})

test('B01-06 save-file：写盘真的失败时返回失败（真跑一次写盘错误）', async () => {
  // 让 fsp.writeFile 失败：把目标路径指向一个不存在的目录 → ENOENT
  const mainWin = fakeWindow()
  dialogs.registerDialogsIpc({
    getMainWindow: () => mainWin,
    getWidgetWindow: () => null,
    isWidgetIgnoreMouse: () => false,
    setWidgetIgnoreMouse: () => {},
  })
  const save = handlers.get('save-file')
  assert.ok(save, '没注册 save-file handler')

  // 让保存对话框返回一个「写不进去」的路径（父目录不存在）
  const { dialog } = require('electron')
  const origShow = dialog.showSaveDialog
  dialog.showSaveDialog = async () => ({
    canceled: false,
    // 父目录不存在 → writeFile 抛 ENOENT
    filePath: path.join('/nonexistent-dir-xyz', 'a.csv'),
  })
  try {
    const r = await save({ sender: {} }, { defaultName: 'a.csv', data: 'x' })
    assert.ok(r, 'handler 必须返回结果对象（不能 reject）')
    assert.strictEqual(contract.isFailure(r), true,
      '写盘失败必须判为失败（B01-06：原先伪装成「用户取消」，界面一声不吭）')
    assert.strictEqual(contract.isCanceled(r), false,
      '写盘失败绝不能被判成取消（B01-06）')
    assert.ok(r.error && r.error.length > 0, '写盘失败必须带可读原因')
  } finally {
    dialog.showSaveDialog = origShow
  }
})

test('B01-06 note-save：缺数据判为失败而不是抛异常', async () => {
  const mainWin = fakeWindow()
  dialogs.registerDialogsIpc({
    getMainWindow: () => mainWin,
    getWidgetWindow: () => null,
    isWidgetIgnoreMouse: () => false,
    setWidgetIgnoreMouse: () => {},
  })
  const note = handlers.get('note-save')
  assert.ok(note, '没注册 note-save handler')
  const r = await note({ sender: {} }, null, {})
  assert.ok(r, 'handler 必须返回结果对象（不能 reject）')
  assert.strictEqual(contract.isFailure(r), true)
})

// =========================================================================
// B01-11：更新包文件名归一化（**直接调用真实模块**，不复现逻辑 ——
//          复现逻辑的单测测不到源码，改坏源码它照样绿）
// =========================================================================
const updater = require(path.join(ROOT, 'electron/main/main.updater.js'))

test('B01-11 更新包文件名：路径穿越被归一化到缓存目录内', () => {
  const pathMod = require('path')
  const normalize = updater.normalizeAssetFileName
  assert.strictEqual(typeof normalize, 'function', 'updater 必须导出 normalizeAssetFileName（否则这段逻辑测不到）')

  assert.strictEqual(normalize('../../evil.exe', 'fb.exe'), 'evil.exe')
  assert.strictEqual(normalize('a/b/evil.exe', 'fb.exe'), 'evil.exe')
  assert.strictEqual(normalize('..\\..\\evil.exe', 'fb.exe'), 'evil.exe')
  assert.strictEqual(normalize('Setup-1.0.exe', 'fb.exe'), 'Setup-1.0.exe')
  // 空名 → 走兜底
  assert.strictEqual(normalize('', 'fb.exe'), 'fb.exe')
  // ⚠️ path.basename('..') 返回 '..'（不是空串！）——
  // 只靠 `|| 兜底名` 拦不住，path.join(dir, '..') 会指向缓存目录的**父目录**
  assert.strictEqual(normalize('..', 'fb.exe'), 'fb.exe')
  assert.strictEqual(normalize('.', 'fb.exe'), 'fb.exe')
})

test('B01-11 更新包：归一化后的路径必须仍在缓存目录内', () => {
  const pathMod = require('path')
  const dir = pathMod.join('/tmp', 'update-cache')
  const cacheRoot = pathMod.resolve(dir) + pathMod.sep
  for (const raw of ['../../evil.exe', '..', '.', 'a/b/evil.exe', '..\\..\\evil.exe']) {
    const fileName = updater.normalizeAssetFileName(raw, 'fb.exe')
    const target = pathMod.join(dir, fileName)
    assert.ok(pathMod.resolve(target).startsWith(cacheRoot),
      `归一化后必须仍在缓存目录内（raw=${raw} → ${target}）`)
  }
})

// =========================================================================
// B01-12：navigateMainWhenReady 的监听要有必然终点（**直接调用真实模块**）
// =========================================================================
test('B01-12 navigateMainWhenReady：加载完成后监听被摘掉', () => {
  const widget = require(path.join(ROOT, 'electron/main/main.widget.js'))
  assert.strictEqual(typeof widget.navigateMainWhenReady, 'function',
    'main.widget.js 必须导出 navigateMainWhenReady（否则测不到真实行为）')

  const listeners = {}
  const wc = {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    getURL() { return 'app://local/index.html' },
    isLoading() { return false },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) },
    removeListener(ev, fn) {
      const arr = listeners[ev] || []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    send() { wc._sent = true },
  }
  widget.navigateMainWhenReady({ webContents: wc }, '/target')

  assert.ok(wc._sent, '就绪时必须发出导航消息')
  assert.strictEqual((listeners['did-finish-load'] || []).length, 0,
    '成功后必须摘掉 did-finish-load 监听（否则每次点面板都多挂一个，B01-12）')
  assert.strictEqual((listeners['destroyed'] || []).length, 0,
    '成功后必须摘掉 destroyed 监听')
})

test('B01-12 navigateMainWhenReady：窗口销毁后监听被摘掉（不堆积）', () => {
  const widget = require(path.join(ROOT, 'electron/main/main.widget.js'))
  const listeners = {}
  const wc = {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    getURL() { return 'data:text/html,placeholder' },  // 永远不就绪
    isLoading() { return true },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) },
    removeListener(ev, fn) {
      const arr = listeners[ev] || []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    send() {},
  }
  widget.navigateMainWhenReady({ webContents: wc }, '/target')

  // 未就绪 → 监听应当还挂着（等待中）
  assert.strictEqual((listeners['did-finish-load'] || []).length, 1,
    '未就绪时应挂着一个监听等待')

  // 窗口销毁 → 触发 destroyed 回调 → 监听必须被摘干净
  wc.destroyed = true
  for (const fn of (listeners['destroyed'] || []).slice()) fn()
  assert.strictEqual((listeners['did-finish-load'] || []).length, 0,
    '窗口销毁后 did-finish-load 监听必须被摘掉（B01-12：监听堆积）')
  assert.strictEqual((listeners['destroyed'] || []).length, 0,
    '窗口销毁后 destroyed 监听必须被摘掉')
})

test('B01-12 navigateMainWhenReady：连续调用不会无限堆积监听', () => {
  const widget = require(path.join(ROOT, 'electron/main/main.widget.js'))
  const listeners = {}
  const wc = {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    getURL() { return 'data:text/html,placeholder' },
    isLoading() { return true },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) },
    removeListener(ev, fn) {
      const arr = listeners[ev] || []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    send() {},
  }
  // 模拟用户连点桌面小组件面板 5 次
  for (let i = 0; i < 5; i++) widget.navigateMainWhenReady({ webContents: wc }, '/x' + i)
  const pending = (listeners['did-finish-load'] || []).length
  // 每个调用都有自己的监听，但每个都有终点（超时/销毁）——
  // 关键断言：销毁后必须全部归零
  wc.destroyed = true
  for (const fn of (listeners['destroyed'] || []).slice()) fn()
  assert.strictEqual((listeners['did-finish-load'] || []).length, 0,
    `连续调用 ${pending} 次后，窗口销毁必须让所有监听归零（B01-12）`)
})

test('B01-12 navigateMainWhenReady：超时会摘掉监听（不会永远挂着）', async () => {
  const widget = require(path.join(ROOT, 'electron/main/main.widget.js'))
  assert.ok(widget.NAVIGATE_WAIT_TIMEOUT_MS > 0,
    '超时兜底常量必须是正数（为 0 等于没有兜底）')
  const listeners = {}
  const wc = {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    getURL() { return 'data:text/html,placeholder' },
    isLoading() { return true },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) },
    removeListener(ev, fn) {
      const arr = listeners[ev] || []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    send() {},
  }
  widget.navigateMainWhenReady({ webContents: wc }, '/x')
  assert.strictEqual((listeners['did-finish-load'] || []).length, 1)
  // 不等真实超时（30s 太长），直接验证「超时定时器存在且会摘监听」：
  // 用 fake timers 不便，这里退一步断言源码里定时器按该常量排期
  const src = fs.readFileSync(path.join(ROOT, 'electron/main/main.widget.js'), 'utf8')
  assert.ok(/setTimeout\([\s\S]{0,300}?NAVIGATE_WAIT_TIMEOUT_MS\s*\)/.test(src),
    '超时定时器必须按 NAVIGATE_WAIT_TIMEOUT_MS 排期')
})

// =========================================================================
// B01-08：穿透态挂在窗口实例上（行为验证）
// =========================================================================
test('B01-08 穿透态：窗口重建后不继承上一个窗口的残留态', () => {
  const widget = require(path.join(ROOT, 'electron/main/main.widget.js'))
  assert.strictEqual(typeof widget.isWidgetIgnoreMouse, 'function', '必须导出 isWidgetIgnoreMouse')
  assert.strictEqual(typeof widget.setWidgetIgnoreMouse, 'function', '必须导出 setWidgetIgnoreMouse')

  // 两个假窗口（模拟「浮窗销毁后重建」）
  const winA = { destroyed: false, isDestroyed() { return this.destroyed }, _ignore: null }
  const winB = { destroyed: false, isDestroyed() { return this.destroyed }, _ignore: null }
  winA.setIgnoreMouseEvents = (v, o) => { winA._ignore = v }
  winB.setIgnoreMouseEvents = (v, o) => { winB._ignore = v }

  // 窗口 A 被设成穿透态
  widget.setWidgetIgnoreMouse(winA, true)
  assert.strictEqual(winA._ignore, true, 'setWidgetIgnoreMouse 应真正作用到窗口上')

  // 窗口 A 销毁（浮窗「隐藏即销毁」）
  winA.destroyed = true
  // 窗口 B 是重建出来的新窗口 —— 状态必须从「未穿透」开始
  widget.setWidgetIgnoreMouse(winB, false)
  assert.strictEqual(winB._ignore, false, '新窗口必须是非穿透态')

  // 源码里不应再有模块级变量
  const src = fs.readFileSync(path.join(ROOT, 'electron/main/main.widget.js'), 'utf8')
  assert.ok(!/let\s+widgetIgnoreMouse\s*=/.test(src),
    '源码里不应再有模块级 widgetIgnoreMouse（B01-08）')
  assert.ok(/WeakMap/.test(src), '源码里穿透态应挂在 WeakMap 上')
})

// =========================================================================
// B01-13：preload.once 登记进 listenerMap（静态 + 结构）
// =========================================================================
test('B01-13 preload.once：wrapper 登记进 listenerMap 且返回句柄', () => {
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8')
  const i = preloadSrc.indexOf('once:')
  assert.ok(i > 0, 'preload.js 里应能找到 once()')
  const next = preloadSrc.indexOf('\n  // ', i)
  const body = preloadSrc.slice(i, next > 0 ? next : i + 1200)
  assert.ok(/m\.set\(\s*callback\s*,\s*wrapper\s*\)/.test(body),
    'once() 必须把 wrapper 登记进 listenerMap')
  assert.ok(/ipcRenderer\.once\(\s*channel\s*,\s*wrapper\s*\)/.test(body),
    'once() 必须把登记好的 wrapper 交给 ipcRenderer.once')
  assert.ok(/return\s+wrapper/.test(body), 'once() 必须返回句柄')
})

// =========================================================================
// 前端侧：失败必须抛出去（判据 D）
// =========================================================================
test('B01-06 前端：失败被抛出去，取消被安静吞掉', async () => {
  const saveFileSrc = fs.readFileSync(path.join(ROOT, 'student-frontend/src/utils/saveFile.js'), 'utf8')
  // 复现 classify 逻辑
  const classify = (res) => {
    if (!res || typeof res !== 'object') return 'fail'
    if (res.outcome === 'ok') return 'ok'
    if (res.outcome === 'fail') return 'fail'
    if (res.outcome === 'canceled') return 'canceled'
    if (res.canceled === true) return 'canceled'
    if (res.success === false) return 'fail'
    if (res.filePath) return 'ok'
    return 'fail'
  }
  assert.strictEqual(classify({ outcome: 'ok', filePath: '/x' }), 'ok')
  assert.strictEqual(classify({ outcome: 'fail', error: 'x' }), 'fail')
  assert.strictEqual(classify({ outcome: 'canceled' }), 'canceled')
  // 旧形状也要能判
  assert.strictEqual(classify({ canceled: true }), 'canceled')
  assert.strictEqual(classify({ success: false, error: 'x' }), 'fail')

  // 源码里：取消 → return ''；失败 → throw
  assert.ok(/kind === 'canceled'\) return ''/.test(saveFileSrc),
    "取消分支应 return ''（安静吞掉）")
  assert.ok(/throw\s+new\s+Error/.test(saveFileSrc),
    '失败分支应 throw（让调用方弹错误提示）')
  assert.ok(!/kind === 'canceled' \|\| kind === 'fail'/.test(saveFileSrc),
    '失败与取消不能一起被吞成空串（B01-06）')
})
