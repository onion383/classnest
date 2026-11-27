// =========================================================================
// widget.js —— 工具箱浮窗 + 桌面小组件
//
// 汇总主进程里与「工具箱浮窗 / 桌面小组件」相关的窗口生命周期与 IPC：
//   - 工具箱浮窗：创建/隐藏/显示、拖动、缩放、全屏、鼠标穿透、右键菜单、会话级显隐
//   - 桌面小组件：**窗口跑在主进程里**（与工具箱同一套生命周期），320 × 工作区 95%、
//     透明（圆角由页面 CSS 绘制）。设置里可开启「常驻最底层」，实现是把窗口的 z 序
//     插到「Progman 之上、所有可见窗口之下」（见 main.desktop-layer.js），**不是**
//     SetParent 子窗口 —— 子窗口形态下移动会让 Electron 原生崩溃（0xC000041D）。
//   - 相关 IPC：widgets-ready / desktop-widget-enabled / desktop-widget-content-ready /
//     desktop-widget-drag-* / desktop-widget-open-page / get-desktop-layer-state /
//     widget-* / to-widget / to-main 等
//
// 桌面小组件为什么从独立进程合并回来（v0.1.x）：独立进程原本只为隔离「跨进程子窗口
// 被移动 → 原生崩溃」这一类问题，而置底实现改成顶层窗口 + z 序之后该诱因已消失；
// 合并省掉一个 Chromium browser/GPU 进程与整套 spawn/重建/会话快照逻辑。
// 代价：browser 进程级原生崩溃不再隔离（与工具箱同等风险水平）。渲染进程崩溃仍隔离，
// 且这里用 render-process-gone 自动重载兜底。
//
// 依赖注入：窗口引用与「开发服务器就绪后再导航」工具由 main.js 通过 registerWidgetIpc 注入
// （getter/闭包，调用时取当前值）。本模块自有的可变状态（两个窗口引用、拖动/缩放/全屏临时态、
// 桌面组件开关、会话级工具箱开关）全部收敛在本模块内。
//
// 与本模块 __dirname 相关的路径：本文件位于 electron/main/，preload 在上一级。
// =========================================================================

const fs = require('fs')
const path = require('path')
const { app, BrowserWindow, Menu, screen } = require('electron')
const { CH, IPC } = require('./channels')
const startupTimer = require('./main.startup-timer')
const { buildWebPreferences } = require('./main.web-prefs')
// IPC 授权层：登记本模块创建的两个窗口（工具箱浮窗 / 桌面小组件）的角色。
const ipcAuth = require('./main.ipc-auth')
// Windows 置底：把组件窗口的 z 序插到「Progman 之上、所有可见窗口之下」
const desktopLayer = require('./main.desktop-layer')
const { relayToWidgetWindows } = require('./widget-relay')
const { appendWithRotation } = require('./main.logRotator')
const { atomicWriteJsonSync } = require('./main.atomic-write')
const ports = require('../../config/ports.cjs')

const { isDev } = require('./main.env')

// 窗口 / 工具出口：由 registerWidgetIpc 注入（均为调用时取当前值）
let getMainWindow = () => null
// 主窗口已关闭到托盘时，点击组件面板需要按原关闭策略重建主窗口（同样由 main.js 注入）
let createMainWindow = () => {}
// 开发模式下「等 Vite 就绪再导航」的重试加载器（定义在 main.js，供主/引导/迁移/工具箱共用）
let loadUrlWithRetry = () => {}

// ===== 窗口引用 =====
let widgetWindow = null
let desktopWidgetWindow = null

// widget 窗口当前是否处于「点击穿透」态。Electron 只能 set 不能 get，
// 所以凡是改动它的地方都要同步这个变量，否则临时流程（截屏）恢复不了原状态。
//
// ⚠️ 这个状态描述的是**某个窗口实例**，不是全局（审查 v4 · B01-08）：
//   原先是模块级变量，而浮窗是「隐藏即销毁、启用时重建」的（hideWidgetWindow → createWidgetWindow）。
//   销毁时变量不复位 → 重建后的新窗口**实际是不穿透的**（新窗口默认如此），
//   但变量还留着旧值 true → 截屏流程读到 wasIgnoreMouse=true，
//   截完屏把**新窗口** setIgnoreMouseEvents(true) → 浮窗变成点击穿透，图标点不动。
//   根因：状态的生命周期比它所描述的对象长。
// 改法：状态挂到窗口实例上（WeakMap），窗口销毁 → 状态随之消失，
// 新窗口天然从「未穿透」开始，不可能继承上一个窗口的残留态。
const widgetIgnoreMouseMap = new WeakMap()

// 取当前浮窗的穿透态：窗口不存在 → false（没有窗口就谈不上穿透）
function isWidgetIgnoreMouseNow() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return false
  return widgetIgnoreMouseMap.get(widgetWindow) === true
}

// 设置当前浮窗的穿透态（同时真正作用到窗口上）
function setWidgetIgnoreMouse(win, ignore) {
  if (!win || win.isDestroyed()) return
  widgetIgnoreMouseMap.set(win, !!ignore)
  try {
    win.setIgnoreMouseEvents(!!ignore, { forward: true })
  } catch (_) { /* best-effort: 不支持鼠标事件透传的平台忽略即可 */ }
}

// 小组件窗口四周留出的阴影绘制边距（px）。
// 渲染层用同值 padding 让「视觉内容」贴回原位置，因此窗口比内容大 2*M，且窗口位置相对视觉位置偏移 -M。
const WIDGET_SHADOW_MARGIN = 16
// 四向预留：窗口足够大，图标固定在正中心，面板往四个方向展开都在窗口内，
// 开合菜单永不 resize、永不挪窗口。内容区 520×784 = 左面板228+间隙8+图标48+间隙8+右面板228
// （高同理 360+8+48+8+360），加四周阴影 32。
const WIDGET_CONTENT_W = 520
const WIDGET_CONTENT_H = 784
// 主进程限位几何（图标偏移 / 初始位置）集中在 widgetLayout.cjs，
// 与渲染层同源；单测真跑那个模块，这里只做接线。
// 拖拽夹位只在渲染层做（window.screen.avail*），主进程不重复夹——
// 两边都夹会让 iconScreen 与窗口实际位置脱钩，累积成「面板和图标越来越远」。
const { initialWidgetPosition } = require('./widgetLayout.cjs')

// ===== 工具箱浮窗状态 =====
// 上次浮窗位置：销毁前记下，重建时恢复，避免「关掉再打开」跳回屏幕左侧中间
let lastWidgetBounds = null
// 居中前的位置：关闭工具后恢复用
let lastIconPosition = null
// 全屏（注释工具）前的窗口位置与尺寸
let preFullscreenBounds = null
// 「本次启用工具箱」会话级开关：仅影响本次运行浮窗显隐（不持久）。
// null = 尚未由浮窗初始化（浮窗会以持久「是否启用工具箱」作为本次默认注入）。
let sessionWidgetEnabled = null

// ===== 桌面小组件状态 =====
// 「桌面小组件按需创建」：主窗口渲染层延迟到「首帧真正空闲」才回报，主进程据此错峰创建窗口。
// 初值取 false：渲染层迟迟不回报（页面崩了/加载失败）时就不建窗，默认关闭是安全方向
let desktopEnabled = false
// 置底是**唯一形态**（不再有开关）：窗口是否已成功置底；attach 失败时退回普通顶层窗口
let desktopLayerOn = false
// 拖动起点：内容矩形 + 鼠标位置（均为 DIP）
let desktopDragBounds = null
let desktopDragMouse = null
// 上屏兜底与 z 序自愈定时器
let desktopShowTimer = null
let desktopLayerWatchdog = null
let desktopContentReady = false
// 渲染层迟迟不发就绪信号（页面加载失败等）时的兜底上屏时间
const DESKTOP_READY_TIMEOUT_MS = 8000

// 等主窗口加载完成（navigateMainWhenReady）的最长等待：超时即放弃这次导航。
// 正常情况是毫秒级（页面已就绪时立即发）；给 30s 覆盖「首次启动要加载整个应用」的慢场景。
const NAVIGATE_WAIT_TIMEOUT_MS = 30000

function createWidgetWindow() {
  widgetWindow = new BrowserWindow({
    // 四向预留的固定尺寸：图标居中、四周留足面板空间，开合菜单永不 resize/挪窗口。
    width: WIDGET_CONTENT_W + WIDGET_SHADOW_MARGIN * 2,
    height: WIDGET_CONTENT_H + WIDGET_SHADOW_MARGIN * 2,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // 渲染进程安全配置见 web-prefs.js。浮窗需持续重绘，关闭后台节流，
    // 避免失焦时亚克力/毛玻璃变灰
    webPreferences: buildWebPreferences({ backgroundThrottling: false, ipcRole: ipcAuth.ROLE.WIDGET })
  })
  // 登记窗口角色：浮窗只允许 widget 类通道（见 ipc-policy.json）
  ipcAuth.registerWindowRole(widgetWindow, ipcAuth.ROLE.WIDGET)

  // 初始位置：图标完整贴在屏幕左缘、垂直居中。旧公式多算了 16px 阴影留边，
  // 图标中心落到 x=-16，一大半在屏幕外；现按「窗口左上角 = 图标中心 - (260,392)」算。
  widgetWindow.setPosition(...initialWidgetPosition(screen.getPrimaryDisplay().workAreaSize))

  if (process.platform === 'darwin') {
    widgetWindow.setWindowButtonVisibility(false)
  }

  if (isDev) {
    loadUrlWithRetry(widgetWindow, ports.frontendOrigin + '/widget.html')
  } else {
    // B1：保持 app://local，API 由协议代理；origin 与主窗口一致，登录态共享。
    widgetWindow.loadURL('app://local/widget.html')
  }

  widgetWindow.on('blur', () => {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.webContents.send(CH.FROM_MAIN, { type: 'blur' })
    }
  })

  // 刻意不监听 moved 做「拉回主屏」：固定尺寸窗口 552×816、绝大部分透明穿透，
  // 图标贴边时窗口大半在屏外是**正常形态**（锚点是图标，不是整窗）。
  // 任何按「窗口中心 / 图标中心出界就拉回」的兜底都会在拖拽的某一帧误判，
  // 表现为图标碰到屏幕上下边时突然瞬移到屏幕中央。
  // 限位只在渲染层做（位置真源 iconScreen），WIDGET_MOVE_TO 原样落地，这里不二次改位置。

  // 身份守卫：重启小组件时旧窗口的 closed 可能晚于新窗口创建触发，
  // 若不加判断会把刚建好的新引用置空（mainWindow 已是这种写法）。
  const self = widgetWindow
  widgetWindow.on('closed', () => {
    if (widgetWindow === self) widgetWindow = null
  })

  // 启动耗时打点跟着「真正建窗」走：工具箱改为按需创建后，启动路径上通常不再建它
  startupTimer.mark('widget 创建完成')
}

// 工具箱浮窗的会话级显隐：隐藏即销毁，避免渲染进程常驻占用内存（约 20MB 量级）。
// 重新启用时按需重建并恢复上次位置；重建后浮窗自身会重新拉取状态，无需外部还原。
function hideWidgetWindow() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  try { lastWidgetBounds = widgetWindow.getBounds() } catch (_) { /* best-effort: 窗口已销毁时取边界失败可忽略 */ }
  try { widgetWindow.destroy() } catch (_) { /* best-effort: 窗口已销毁时销毁失败可忽略 */ }
  widgetWindow = null
}

function showWidgetWindow() {
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    createWidgetWindow()
    if (lastWidgetBounds && widgetWindow && !widgetWindow.isDestroyed()) {
      try { widgetWindow.setPosition(lastWidgetBounds.x, lastWidgetBounds.y) } catch (_) { /* best-effort: 恢复位置时窗口状态异常可忽略 */ }
    }
  }
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.show()
}

// 退出工具箱（右键菜单与菜单面板里的「退出工具箱」按钮共用）：
// 关闭浮窗 + 通知主窗口把持久化开关 toolboxEnabled 置 false。
// 主窗口负责调后端（后端 PUT 是整体覆盖，由它读完整设置再写回，避免清空保存路径），
// 因此设置页的「是否启用工具箱」会同步变为关闭，下次启动也不再出现。
function exitToolbox() {
  sessionWidgetEnabled = false
  hideWidgetWindow()
  const mainWindow = getMainWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(CH.FROM_MAIN, { type: 'toolbox-close-request' })
  }
}

// ===== 桌面小组件：窗口生命周期（主进程内）=====
// 窗口形态：320 × 工作区 95% 的**顶层窗口** + 透明（四角圆角由页面 CSS border-radius 绘制，
// 见 DesktopWidget.vue）。置底模式只是把它的 z 序插到「Progman 之上、所有可见窗口之下」，
// 由 main.desktop-layer.js 负责；**不要**改回 SetParent 子窗口（移动会原生崩溃）。
//
// 拖动：渲染层 pointerdown/pointermove 上报 screenX/screenY（CSS 像素 = DIP），这里用
// getContentBounds 记起点、每帧 setContentBounds **连宽高一起**搬（只改位置会让窗口越拖越大，
// 工具箱浮窗当年同一个坑），松手 setContentSize 兜底并把落点写进 desktop-widget-pos.json。

function desktopPosFile() {
  return path.join(app.getPath('userData'), 'desktop-widget-pos.json')
}
// 桌面组件的诊断日志：沿用原来的 desktop-layer.log（与 startup.log 放一起），
// 排查「没显示 / 没置底 / 拖动异常」先看它。主进程侧只记关键节点，不刷流水账。
// 仅开发模式写入：正式打包版不产出 desktop-layer.log。
function logWidget(msg) {
  if (!isDev) return
  // 1-1：与 inp.log 同一口径（1MB 封顶、保留最近 512KB），异步追加；旧实现无上限。
  appendWithRotation(
    path.join(app.getPath('userData'), 'desktop-layer.log'),
    '[' + new Date().toISOString() + '] ' + msg + '\n',
    { maxBytes: 1024 * 1024, keepBytes: 512 * 1024 },
  )
}
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (_) {
    return null
  }
}
function writeJsonFile(file, obj) {
  try {
    // 原子写：窗口位置这类状态文件写一半掉电会解析失败→回默认位置（E02-01）
    atomicWriteJsonSync(file, obj)
  } catch (e) {
    console.warn('[widget] 写状态文件失败：', file, e && e.message)
  }
}

function desktopWidgetUrl() {
  return isDev
    ? ports.frontendOrigin + '/desktop-widget.html'
    : 'app://local/desktop-widget.html'
}

function stopDesktopTimers() {
  if (desktopShowTimer) {
    clearTimeout(desktopShowTimer)
    desktopShowTimer = null
  }
  if (desktopLayerWatchdog) {
    clearInterval(desktopLayerWatchdog)
    desktopLayerWatchdog = null
  }
}

// 上屏：**先确认已贴到桌面之上，再显示**（反过来会先以普通顶层窗口浮到最前闪一下）
function showDesktopWidget() {
  const win = desktopWidgetWindow
  if (!win || win.isDestroyed() || win.isVisible()) return
  desktopLayerOn = desktopLayer.attach(win)
  if (desktopLayerOn) {
    win.showInactive()
    desktopLayer.reassert(win)
  } else {
    // attach 失败（非 Windows / koffi 缺失）：退回普通顶层窗口，只影响层级不影响可用性
    win.show()
  }
  logWidget('[widget] shown bottom=' + desktopLayerOn)
  startupTimer.mark('桌面组件上屏')
}

// 渲染层没发就绪信号（页面加载失败等）时仍要上屏，避免组件永远不出现
function scheduleDesktopShowFallback() {
  if (desktopContentReady || !desktopWidgetWindow) return
  if (desktopShowTimer) clearTimeout(desktopShowTimer)
  desktopShowTimer = setTimeout(() => {
    desktopShowTimer = null
    showDesktopWidget()
  }, DESKTOP_READY_TIMEOUT_MS)
}

// z 序自愈：Explorer 重启会重建 Progman，别的程序也可能插队，定时确认「仍在可见窗口之下」。
// 只调 z 序、不移动窗口，开销是几个 user32 调用。
function startDesktopLayerWatchdog() {
  if (desktopLayerWatchdog) return
  desktopLayerWatchdog = setInterval(() => {
    if (!desktopLayerOn) return
    const win = desktopWidgetWindow
    if (!win || win.isDestroyed()) return
    if (!desktopLayer.isJustAboveDesktop(win)) desktopLayer.reassert(win)
  }, 5000)
}

// 创建桌面小组件窗口（幂等）。已存在则只把它显示出来。
function createDesktopWidgetWindow() {
  if (desktopWidgetWindow && !desktopWidgetWindow.isDestroyed()) {
    showDesktopWidget()
    return desktopWidgetWindow
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  const widgetHeight = Math.round(screenH * 0.95)
  const saved = readJsonFile(desktopPosFile())
  const startX = Number.isFinite(saved && saved.x) ? saved.x : screenW - 340
  const startY = Number.isFinite(saved && saved.y)
    ? saved.y
    : Math.round((screenH - widgetHeight) / 2)

  const win = new BrowserWindow({
    width: 320,
    height: widgetHeight,
    x: Math.round(startX),
    y: Math.round(startY),
    frame: false,
    // 逐像素透明：四角圆角由页面 CSS 绘制，窗口本身不能有不透明底漆
    transparent: true,
    backgroundColor: '#00000000',
    backgroundMaterial: 'none',
    alwaysOnTop: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // 不能用 focusable:false：Windows 下会加 WS_EX_NOACTIVATE，窗口收不到任何鼠标输入。
    // show:false + 内容就绪后再 show：先建好并加载完，避免闪出空窗。
    show: false,
    webPreferences: buildWebPreferences({ backgroundThrottling: false, ipcRole: ipcAuth.ROLE.DESKTOP_WIDGET }),
  })
  desktopWidgetWindow = win
  // 登记窗口角色：桌面小组件只允许 desktop-widget 类通道（见 ipc-policy.json）
  ipcAuth.registerWindowRole(win, ipcAuth.ROLE.DESKTOP_WIDGET)
  desktopContentReady = false
  logWidget('[widget] created pos=' + Math.round(startX) + ',' + Math.round(startY) +
    ' size=320x' + widgetHeight)

  // 渲染层 console（仅开发模式）与硬故障：主进程没有 stdio，统一落到 desktop-layer.log
  if (isDev) {
    let lastMsg = ''
    let lastAt = 0
    win.webContents.on('console-message', (e) => {
      if (!e || !e.message) return
      const text = String(e.message)
      if (e.level === 'info' && text.startsWith('[dw-timing]')) { logWidget(text); return }
      if (e.level !== 'error' && e.level !== 'warning') return
      if (text === lastMsg && Date.now() - lastAt < 30000) return
      lastMsg = text
      lastAt = Date.now()
      logWidget('[renderer:' + e.level + '] ' + text.slice(0, 600))
    })
  }
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame) logWidget('主框架加载失败(' + code + ' ' + desc + '): ' + url)
  })

  // 渲染进程崩了（页面 OOM / GPU 掉驱动）别让窗口一直白着：自动重载一次。
  // 注意这只能兜住渲染进程级崩溃，browser 进程级崩仍会带走主应用（与工具箱同等风险）。
  win.webContents.on('render-process-gone', (e, details) => {
    console.warn('[widget] 桌面组件渲染进程退出：', JSON.stringify(details || {}))
    logWidget('[widget] render-process-gone ' + JSON.stringify(details || {}).slice(0, 300))
    if (desktopWidgetWindow !== win || win.isDestroyed()) return
    try {
      win.reload()
    } catch (_) { // best-effort: 窗口已销毁时重载失败可忽略

    }
  })
  win.webContents.on('did-finish-load', () => scheduleDesktopShowFallback())

  // 用户点击会把窗口激活并抬到最前：失焦/再获焦都重新压回底层
  win.on('focus', () => {
    if (desktopLayerOn) desktopLayer.reassert(win)
  })
  win.on('blur', () => {
    if (desktopLayerOn) desktopLayer.reassert(win)
  })
  win.on('closed', () => {
    if (desktopWidgetWindow === win) desktopWidgetWindow = null
    desktopLayerOn = false
    desktopDragBounds = null
    desktopDragMouse = null
    stopDesktopTimers()
  })

  if (isDev) loadUrlWithRetry(win, desktopWidgetUrl())
  else win.loadURL(desktopWidgetUrl())

  // 置底：先插层（隐藏状态也能设 z 序），上屏等 content-ready
  desktopLayerOn = desktopLayer.attach(win)
  logWidget('[widget] bottom mode at create = ' + desktopLayerOn)
  if (desktopLayerOn) startDesktopLayerWatchdog()
  startupTimer.mark('桌面组件创建完成')
  return win
}

function destroyDesktopWidgetWindow() {
  const win = desktopWidgetWindow
  desktopWidgetWindow = null
  desktopLayerOn = false
  desktopDragBounds = null
  desktopDragMouse = null
  stopDesktopTimers()
  if (win && !win.isDestroyed()) win.destroy()
}

function setDesktopEnabled(enabled) {
  desktopEnabled = !!enabled
  if (desktopEnabled) createDesktopWidgetWindow()
  else destroyDesktopWidgetWindow()
}

// 组件面板点击：窗口就在本进程里，直接唤醒/重建主窗口并推路由。
// 主窗口可能已关闭到托盘（引用被置空），此时先按原关闭策略重建，再等页面真正加载完成
// （开发模式还会先经过 data: 占位页）后推路由。

function openMainPage(page) {
  let mainWindow = getMainWindow()
  let created = false
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
    mainWindow = getMainWindow()
    created = true
  }
  if (!mainWindow || mainWindow.isDestroyed()) return
  // 新建窗口交给 createMainWindow 自己的出现时机（ready-to-show），避免提前露出空窗
  if (!created) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  navigateMainWhenReady(mainWindow, page)
}

// 等主窗口加载到真实页面再发 from-main：开发模式的 data: 占位页和加载中的页面都不能接。
// 主窗口已就绪时立即发；未就绪则挂到 did-finish-load，直到 URL 不再是 data: 为止。
//
// ⚠️ 监听器必须有必然的终点（审查 v4 · B01-12）：
//   原实现只在「成功发出」时 removeListener，失败路径不清理：
//     · URL 永远是 data:（开发模式 Vite 没起来）→ 每次调用都多挂一个监听，永远不移除；
//     · 主窗口在等待期间被销毁 → 监听挂在已死的 webContents 上。
//   桌面小组件每点一次面板就调一次 openMainPage → 监听无上限堆积，
//   每次 did-finish-load 都要跑一遍全部旧回调（白发 IPC、且可能发重复的 navigate）。
//
// 改法：把「等一次加载完成」收成一个有始有终的等待 ——
//   成功（URL 就绪）→ 发一次并收尾；
//   失败（webContents 销毁）→ 收尾；
//   超时 → 收尾（防止 Vite 一直没起来时无限等待）。
function navigateMainWhenReady(mainWindow, page) {
  const wc = mainWindow.webContents
  let done = false
  let timer = null
  const cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null }
    try { wc.removeListener('did-finish-load', send) } catch (_) { /* best-effort: 已销毁 */ }
    try { wc.removeListener('destroyed', onDestroyed) } catch (_) { /* best-effort: 已销毁 */ }
  }
  const send = () => {
    if (done || wc.isDestroyed()) return
    const url = wc.getURL()
    if (!url || url.startsWith('data:') || wc.isLoading()) return
    done = true
    cleanup()
    wc.send(CH.FROM_MAIN, { type: 'navigate', path: page })
  }
  // 主窗口在等待期间被销毁：不再等，直接收尾
  const onDestroyed = () => {
    if (done) return
    done = true
    cleanup()
  }
  wc.on('did-finish-load', send)
  wc.on('destroyed', onDestroyed)
  // 超时兜底：主窗口迟迟加载不出来（Vite 没启动）时不再无限挂着监听
  timer = setTimeout(() => {
    if (done) return
    done = true
    cleanup()
  }, NAVIGATE_WAIT_TIMEOUT_MS)
  // unref：这个定时器只是「兜底收尾」，不该阻止进程退出（也避免单测等满 30s）
  if (timer && typeof timer.unref === 'function') timer.unref()
  send()
}

function registerWidgetIpc(opts = {}) {
  if (typeof opts.getMainWindow === 'function') getMainWindow = opts.getMainWindow
  if (typeof opts.createMainWindow === 'function') createMainWindow = opts.createMainWindow
  if (typeof opts.loadUrlWithRetry === 'function') loadUrlWithRetry = opts.loadUrlWithRetry

  // 浮窗控制通道的统一发送方校验：只接受本进程创建的 widgetWindow 渲染层。
  // 各窗口同 origin，不校验时任何被注入的渲染层都能借这些通道移动/全屏/隐藏浮窗；
  // widget-exit 与 desktop-widget-* 早已有同等校验，这里把剩余通道补齐到同一强度。
  const fromWidgetWindow = (event) => {
    return !!widgetWindow && !widgetWindow.isDestroyed() && event.sender === widgetWindow.webContents
  }
  // 主窗口发送方：to-widget 这类「主应用 → 小组件」的中继只能由主窗口发起，
  // 不允许任何被注入的小组件渲染层反向扇出（E02-05）。
  const fromMainWindow = (event) => {
    const win = getMainWindow()
    return !!win && !win.isDestroyed() && event.sender === win.webContents
  }

  // 主窗口渲染层空闲回报：按启用状态创建/关闭「桌面小组件」窗口。
  // 工具箱**不在这里建**：它的开关存在后端库里，渲染层登录后读到才下发
  // （widget-set-session-visible）；未启用就根本不该有这个窗口 ——
  // 早先无条件建窗再让浮窗自己隐藏，屏幕上会先闪一下。
  IPC.on(CH.WIDGETS_READY, (event, enabled) => {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (event.sender !== mainWindow.webContents) return
    setDesktopEnabled(!!enabled)
  })

  // 设置页切换「桌面小组件」开关时实时建/关窗口（不依赖空闲时机）
  IPC.on(CH.DESKTOP_WIDGET_ENABLED, (event, enabled) => {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (event.sender !== mainWindow.webContents) return
    setDesktopEnabled(enabled)
  })

  // 读取置底的实际状态（渲染层只用于日志与拖动手柄样式；置底是唯一形态，没有开关）。
  // autoDisabled/faultStreak 是独立进程时代的字段，保留形状、恒为 false/0。
  IPC.handle(CH.GET_DESKTOP_LAYER_STATE, () => ({
    desktopLayerEnabled: desktopLayerOn,
    autoDisabled: false,
    faultStreak: 0,
  }))

  // ===== 桌面小组件窗口 IPC =====
  // 渲染层内容就绪：Vue 挂载完成且骨架 DOM 已生成。此时才显示窗口（置底模式下先插层再显示）。
  IPC.on(CH.DESKTOP_WIDGET_CONTENT_READY, (event) => {
    const win = desktopWidgetWindow
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return
    desktopContentReady = true
    logWidget('[widget] content ready')
    if (desktopShowTimer) {
      clearTimeout(desktopShowTimer)
      desktopShowTimer = null
    }
    showDesktopWidget()
  })

  // 拖动：起点缓存内容矩形，每帧连宽高一起传（只改位置会让窗口越拖越大）
  IPC.on(CH.DESKTOP_WIDGET_DRAG_START, (event, pos) => {
    const win = desktopWidgetWindow
    if (!win || win.isDestroyed() || event.sender !== win.webContents || !pos) return
    // 坐标必须是有限数：渲染层传来 undefined/字符串会让 dx/dy 变 NaN，setContentBounds 静默失效（E02-06）
    if (!Number.isFinite(pos.screenX) || !Number.isFinite(pos.screenY)) return
    try {
      desktopDragBounds = win.getContentBounds()
    } catch (_) {
      desktopDragBounds = null
      return
    }
    desktopDragMouse = [pos.screenX, pos.screenY]
  })

  IPC.on(CH.DESKTOP_WIDGET_DRAG_MOVE, (event, pos) => {
    const win = desktopWidgetWindow
    if (!win || win.isDestroyed() || event.sender !== win.webContents || !pos) return
    if (!Number.isFinite(pos.screenX) || !Number.isFinite(pos.screenY)) return
    if (!desktopDragBounds || !desktopDragMouse) return
    const { width, height } = desktopDragBounds
    const dx = pos.screenX - desktopDragMouse[0]
    const dy = pos.screenY - desktopDragMouse[1]
    // 用鼠标所在显示器的工作区：多屏时不会把窗口拽回主屏
    const wa = screen.getDisplayNearestPoint({
      x: Math.round(pos.screenX),
      y: Math.round(pos.screenY)
    }).workArea
    // 整窗必须留在工作区内，不再允许「只露一角」
    const nx = Math.max(
      wa.x,
      Math.min(Math.round(desktopDragBounds.x + dx), Math.round(wa.x + wa.width - width))
    )
    const ny = Math.max(
      wa.y,
      Math.min(Math.round(desktopDragBounds.y + dy), Math.round(wa.y + wa.height - height))
    )
    win.setContentBounds({ x: nx, y: ny, width, height })
  })

  IPC.on(CH.DESKTOP_WIDGET_DRAG_END, (event) => {
    const win = desktopWidgetWindow
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return
    if (desktopDragBounds) {
      try {
        // 松手兜底尺寸 + 记住落点（重建后回到这里）
        win.setContentSize(desktopDragBounds.width, desktopDragBounds.height)
        const b = win.getContentBounds()
        writeJsonFile(desktopPosFile(), { x: Math.round(b.x), y: Math.round(b.y) })
        logWidget('[widget] drag end pos=' + Math.round(b.x) + ',' + Math.round(b.y))
      } catch (_) { // best-effort: 拖拽结束位置落盘失败不影响窗口拖动

      }
    }
    desktopDragBounds = null
    desktopDragMouse = null
    // 松手后压回底层（拖动过程中可能被抬到前台）
    if (desktopLayerOn) desktopLayer.reassert(win)
  })

  // 点击组件面板（课程 / 值日 / 人数 / 倒计时）：唤醒主窗口并切路由。
  // 窗口就在本进程里，直接调用 openMainPage，不再需要父子进程消息中转。
  IPC.on(CH.DESKTOP_WIDGET_OPEN_PAGE, (event, page) => {
    const win = desktopWidgetWindow
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return
    if (typeof page === 'string' && page.startsWith('/')) openMainPage(page)
  })

  // 调整小组件窗口大小。
  // 固定尺寸方案：图标态(48×48)与菜单态(300×360)共用同一个窗口，尺寸恒定 MENU_SIZE+阴影，
  // 这两种请求一律不写 setContentBounds —— 实验证明透明窗 resize 那一帧会让图标消失。
  // 工具态（计时器/点名/截图等）仍按原逻辑 resize；工具态退出回图标态时也 resize 回固定尺寸。
  // 入参 [width, height] 为「视觉内容」尺寸；窗口实际比它大 2*M。
  IPC.on(CH.WIDGET_RESIZE, (event, payload) => {
    if (fromWidgetWindow(event)) {
      const [width, height] = Array.isArray(payload)
        ? payload
        : [payload && payload.width, payload && payload.height]
      const M = WIDGET_SHADOW_MARGIN
      const newW = width + M * 2
      const newH = height + M * 2
      const iconStateSize = (width === 48 && height === 48)
      const menuStateSize = (width === 300 && height === 360)

      if (iconStateSize || menuStateSize) {
        // 固定尺寸：不 resize、不挪位，仅回执让前端流程继续（工具态退出回图标态时这里把尺寸恢复）。
        const wantW = WIDGET_CONTENT_W + M * 2
        const wantH = WIDGET_CONTENT_H + M * 2
        const [cw, ch] = widgetWindow.getContentSize()
        if (cw !== wantW || ch !== wantH) {
          const b = widgetWindow.getContentBounds()
          widgetWindow.setContentBounds({ x: b.x, y: b.y, width: wantW, height: wantH })
        }
        try { widgetWindow.webContents.send(CH.FROM_MAIN, { type: 'widget-resized', width: wantW, height: wantH }) } catch (_) { /* best-effort */ }
        return
      }

      // 工具态：按「新尺寸」居中。旧逻辑用 before（552×816 大窗居中后的左上角）当小窗左上角，
      // 但 WIDGET_CENTER 先于 resize 执行、按大窗居中，导致小窗落在偏上偏左的位置，
      // 看着像「记住了上次位置」。直接按目标尺寸算工作区中心，每次打开工具都真正居中。
      // 主屏工作区为准（工具面板是临时面板，不必跟随多屏鼠标位置）。
      const wa = screen.getPrimaryDisplay().workArea
      const x = Math.round(wa.x + (wa.width - newW) / 2)
      const y = Math.round(wa.y + (wa.height - newH) / 2)
      widgetWindow.setContentBounds({ x, y, width: newW, height: newH })
      try { widgetWindow.webContents.send(CH.FROM_MAIN, { type: 'widget-resized', width: newW, height: newH }) } catch (_) { /* best-effort */ }
    }
  })

  // 移动窗口到指定左上角（DIP），**保持当前尺寸**。历史坑（见 3cf1af1 注释）：
  // Electron 透明无边框窗口只调 setPosition，每帧会让窗口「越拖越大」/ 内容漂移；
  // 必须每帧连宽高一起 setContentBounds。但宽高要取**当前实际值**，不能写死常量：
  // 图标/菜单态窗口 552×816，工具态被 resize 成 200×400 那类小窗，
  // 写死 552×816 会让工具面板一拖就「瞬间增大」成一坨。
  // **不夹位**：主进程再按 Electron screen 夹会和渲染层 window.screen.avail* 打架，
  // 两边不一致就会把 iconScreen 与窗口实际位置越拉越开。
  IPC.on(CH.WIDGET_MOVE_TO, (event, pos) => {
    if (!fromWidgetWindow(event) || !Array.isArray(pos)) return
    const [x, y] = pos
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      const b = widgetWindow.getContentBounds()
      widgetWindow.setContentBounds({
        x: Math.round(x),
        y: Math.round(y),
        width: b.width,
        height: b.height,
      })
    }
  })

  // 切换鼠标穿透：图标态整窗穿透，只让图标区域接收点击；菜单/工具态关闭穿透。
  IPC.on(CH.WIDGET_SET_IGNORE_MOUSE, (event, ignore) => {
    if (fromWidgetWindow(event) && typeof ignore === 'boolean') {
      setWidgetIgnoreMouse(widgetWindow, ignore)
    }
  })

  // 将窗口居中显示（同时保存居中前的位置，以便关闭工具后恢复）
  IPC.on(CH.WIDGET_CENTER, (event) => {
    if (fromWidgetWindow(event)) {
      lastIconPosition = widgetWindow.getPosition()
      widgetWindow.center()
    }
  })

  // 恢复图标之前保存的位置
  IPC.on(CH.WIDGET_RESTORE_POSITION, (event) => {
    if (fromWidgetWindow(event) && lastIconPosition) {
      widgetWindow.setPosition(lastIconPosition[0], lastIconPosition[1])
    }
  })

  // 全屏小组件（用于注释工具）
  IPC.on(CH.WIDGET_FULLSCREEN, (event) => {
    if (fromWidgetWindow(event)) {
      preFullscreenBounds = {
        pos: widgetWindow.getPosition(),
        size: widgetWindow.getContentSize()
      }
      const { x, y, width, height } = screen.getPrimaryDisplay().bounds
      widgetWindow.setPosition(x, y)
      widgetWindow.setContentSize(width, height)
      widgetWindow.setAlwaysOnTop(true)
      widgetWindow.focus()
    }
  })

  // 从全屏恢复
  IPC.on(CH.WIDGET_RESTORE, (event) => {
    if (fromWidgetWindow(event) && preFullscreenBounds) {
      widgetWindow.setPosition(preFullscreenBounds.pos[0], preFullscreenBounds.pos[1])
      widgetWindow.setContentSize(preFullscreenBounds.size[0], preFullscreenBounds.size[1])
      widgetWindow.setAlwaysOnTop(true)
      widgetWindow.focus()
      preFullscreenBounds = null
    }
  })

  // 设置工具箱可见性
  IPC.on(CH.WIDGET_SET_VISIBLE, (event, visible) => {
    if (fromWidgetWindow(event)) {
      if (visible) {
        widgetWindow.setOpacity(1)
        // 穿透态完全由渲染层 hover 检测驱动（见 widget-set-ignore-mouse）：
        // 这里不再改穿透，避免 checkToolboxEnabled 的重复 SET_VISIBLE 把它冲掉。
        widgetWindow.focus()
      } else {
        widgetWindow.setOpacity(0)
        setWidgetIgnoreMouse(widgetWindow, true)
      }
    }
  })

  // 工具箱浮窗右键菜单：「关闭工具箱」= 连同持久化开关一起关掉（设置页的「是否启用工具箱」
  // 会同步变为关闭，下次启动也不再出现）。
  // 注意：渲染层菜单面板里的「退出工具箱」按钮走同一个 exitToolbox（见下方 widget-exit）。
  IPC.on(CH.WIDGET_CONTEXT_MENU, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const menu = Menu.buildFromTemplate([
      {
        label: '关闭工具箱',
        click: () => exitToolbox(),
      },
    ])
    menu.popup({ window: win || undefined })
  })

  // 菜单面板里的「退出工具箱」按钮（二次确认在渲染层做，确认后才会发这条）
  IPC.on(CH.WIDGET_EXIT, (event) => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return
    if (event.sender !== widgetWindow.webContents) return
    exitToolbox()
  })

  // 会话级「本次启用工具箱」：仅影响本次运行浮窗显隐，不持久化。
  // 发送方限定主窗口或工具箱自身（策略表之外的第二道闸，E02-05）。
  IPC.on(CH.WIDGET_SET_SESSION_VISIBLE, (event, enabled) => {
    if (!fromMainWindow(event) && !fromWidgetWindow(event)) return
    sessionWidgetEnabled = !!enabled
    // 开启即按需重建并显示；关闭即销毁窗口释放渲染进程，位置由 lastWidgetBounds 记忆
    if (sessionWidgetEnabled) showWidgetWindow()
    else hideWidgetWindow()
  })

  // 读取会话级开关；未初始化（尚未注入本次默认值）返回 null
  IPC.handle(CH.GET_SESSION_WIDGET_VISIBLE, () => sessionWidgetEnabled)

  // 桌面组件与主窗口同 origin，token 直接读自己的 localStorage；
  // 原来的 get-main-token IPC 已随独立进程一起删除。

  // 拖动完全由渲染层通过 widget-move-to 驱动（实时夹紧图标到工作区后摆窗口）。
  // 原来的 widget-drag-start/move/end 三条通道已删除：固定大窗下按窗口左上角跟手
  // 与渲染层的图标夹紧打架，会把图标拖出屏幕。

  // 主应用 -> 所有小组件窗口（工具箱浮窗 + 桌面挂件）。
  // 桌面挂件此前收不到这条中继，业务数据变更只能等 5 分钟轮询；settings-changed
  // 与新增的 data-changed 共用这一条路，不新增 IPC 通道名。
  IPC.on(CH.TO_WIDGET, (event, data) => {
    // 只接受主窗口来源：否则任何小组件渲染层都能向所有窗口扇出任意消息（E02-05）
    if (!fromMainWindow(event)) return
    relayToWidgetWindows(data, [widgetWindow, desktopWidgetWindow])
  })

  // 「小组件 -> 主应用」通道（to-main / from-widget）已删除：
  //   整条链路无生产者也无消费者 —— 前端没有任何一处发 to-main，也没有任何一处收 from-widget。
  //   留着只是给人「浮窗能跟主窗口通信」的错觉，实际什么也传不过去（审查 v4 · B01-01）。
}

module.exports = {
  registerWidgetIpc,
  createWidgetWindow,
  hideWidgetWindow,
  showWidgetWindow,
  createDesktopWidgetWindow,
  getWidgetWindow: () => widgetWindow,
  getDesktopWidgetWindow: () => desktopWidgetWindow,
  // perf 面板关闭组件后会回写 null；同时清掉"已置底"标记，避免看门狗继续操作已销毁窗口
  setDesktopWidgetWindow: (w) => {
    desktopWidgetWindow = w
    if (!w) desktopLayerOn = false
  },
  isDesktopEnabled: () => desktopEnabled,
  // Electron 没有读取穿透态的 API，只能自己记：截屏等临时改状态的流程靠它恢复原样。
  // 状态挂在窗口实例上（WeakMap），窗口重建后自动回到「未穿透」（B01-08）。
  isWidgetIgnoreMouse: isWidgetIgnoreMouseNow,
  // 写入器：截屏流程用它把窗口恢复成进入前的穿透态（同时更新记录状态）
  setWidgetIgnoreMouse,
  isDesktopWidgetRunning: () => !!(desktopWidgetWindow && !desktopWidgetWindow.isDestroyed()),
  // 导出给单测：这两个函数原先埋在模块内部，测不到
  // （B01-12 的监听器终点、B01-08 的穿透态归属都需要直接跑真代码来验证）
  navigateMainWhenReady,
  NAVIGATE_WAIT_TIMEOUT_MS,
}