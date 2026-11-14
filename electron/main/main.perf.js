// =========================================================================
// perf.js —— 性能面板相关 IPC 与内存采样
//
// 汇总主进程里性能面板用的一组请求-响应通道与后台采样：
//   perf-snapshot / perf-restart-frontend / perf-restart-widget / perf-relaunch-app / perf-gc / perf-startup
//   / perf-disk-usage（空间管理：磁盘占用归账）
//   以及 startMemSampling 后台「总计内存」定时采样。
//
// 依赖注入：窗口引用与后端进程句柄由 main.js 通过 registerPerfIpc 注入（均为 getter 闭包，
// 调用时取当前值）；本模块只读窗口/后端状态，唯一需要写回的是桌面小组件窗口引用（销毁重建），
// 通过注入的 setDesktopWidgetWindow 回写。
//
// 与后端消息的耦合：后端内存自报 / GC 的一次性等待者（memWaiter / gcWaiter）归本模块所有，
// 由 main.js 的 onBackendMessage 转发调用 handleBackendMemReport / handleBackendGcReport。
// =========================================================================

const { app } = require('electron')
const { CH, IPC } = require('./channels')
const { resolveLogsDir } = require('./main.config')
const fsp = require('node:fs/promises')
const { getPrivateWorkingSetKB } = require('./main.privateWorkingSet')
const { scanDiskUsage, logFilePaths } = require('./main.disk-usage')
const { clearLogFile } = require('./main.logRotator')
const { ok, fail } = require('./main.ipc-contract')
const startupTimer = require('./main.startup-timer')
const { startEventLoopSampling, readEventLoopStats, markEventLoopWindow } = require('./main.eventloop')

// 窗口 / 后端句柄出口：由 registerPerfIpc 注入
let getMainWindow = () => null
let getWidgetWindow = () => null
let getDesktopWidgetWindow = () => null
let setDesktopWidgetWindow = () => {}
let getMigrationWindow = () => null
let getSetupWindow = () => null
let getBackendProcess = () => null
let isBackendReady = () => false
let isDesktopEnabled = () => true
let hideWidgetWindow = () => {}
let showWidgetWindow = () => {}
let createDesktopWidgetWindow = () => {}
// 空间管理（磁盘占用）用的目录来源，同样由 registerPerfIpc 注入
let getInstallDir = () => ''
let getDataDir = () => ''
let getThumbsDir = () => ''

// 性能面板：后端内存自报 / GC 的一次性等待者（各自独立，别复用 probeWaiter）
let memWaiter = null
let gcWaiter = null

// 向后端发消息做一次性查询（内存自报 / GC），照 pingOnce 的一次性等待者写法，
// 但使用各自独立的 waiter 变量，避免与 probeWaiter / 心跳互相干扰。
function queryBackendMemory(timeout = 1500) {
  return new Promise((resolve) => {
    const proc = getBackendProcess()
    if (!proc || !isBackendReady()) return resolve(null)
    let timer = null
    const finish = (v) => {
      if (memWaiter !== finish) return
      memWaiter = null
      clearTimeout(timer)
      resolve(v)
    }
    memWaiter = finish
    timer = setTimeout(() => finish(null), timeout)
    try { proc.send({ type: 'mem-query' }) } catch (_) { finish(null) }
  })
}

// 串行化后端内存查询：内存历史采样与面板快照可能并发，而二者共用同一个 memWaiter，
// 不串行会让先发起的查询被覆盖而超时。这里用一条 Promise 链排队，保证同一时刻只有一个查询在途。
let memQueryChain = Promise.resolve()
function queryBackendMemorySerial(timeout = 1500) {
  const run = () => queryBackendMemory(timeout)
  const p = memQueryChain.then(run, run)
  memQueryChain = p.then(() => {}, () => {})
  return p
}

function queryBackendGc(timeout = 1500) {
  return new Promise((resolve) => {
    const proc = getBackendProcess()
    if (!proc || !isBackendReady()) return resolve(null)
    let timer = null
    const finish = (v) => {
      if (gcWaiter !== finish) return
      gcWaiter = null
      clearTimeout(timer)
      resolve(v)
    }
    gcWaiter = finish
    timer = setTimeout(() => finish(null), timeout)
    try { proc.send({ type: 'gc-request' }) } catch (_) { finish(null) }
  })
}

// onBackendMessage 转发入口：唤醒后端内存自报等待者
function handleBackendMemReport(mem) {
  if (memWaiter) memWaiter(mem || null)
}

// onBackendMessage 转发入口：唤醒后端 GC 等待者
function handleBackendGcReport(ok) {
  if (gcWaiter) gcWaiter(!!ok)
}

// 把 app.getAppMetrics() 的一条记录转成面板用的内存/CPU 结构。
// 注意：只能在 app ready 后调用；memory.workingSetSize / privateBytes 单位为 KB。
function metricToMem(m) {
  return {
    pid: m.pid,
    workingSetKB: m.memory?.workingSetSize ?? null,
    privateKB: m.memory?.privateBytes ?? null,
    cpu: m.cpu?.percentCPUUsage ?? null,
  }
}

// 通过 CDP 触发某个渲染进程的 GC；DevTools 已打开时 attach 会失败，整段吞掉异常
async function collectRendererGarbage(wc) {
  if (!wc || wc.isDestroyed()) return false
  try {
    wc.debugger.attach('1.3')
  } catch (_) {
    return false
  }
  try {
    await wc.debugger.sendCommand('HeapProfiler.collectGarbage')
    return true
  } catch (_) {
    return false
  } finally {
    try { wc.debugger.detach() } catch (_) { /* 断开失败忽略 */ }
  }
}

// Utility 进程名是 Chromium 给的英文：serviceName 是 non-localized name（可能是
// network.mojom.NetworkService 这类 Mojo 接口名），name 也只是 Network Service 等英文可读名，
// Electron 不做本地化。这里只做展示层翻译；两个字段任一命中即可，命中不了保留原名，
// 免得把冷门服务的身份信息丢掉。只改 name，不动 key / kind / pid / 内存数值。
const UTILITY_LABELS = [
  ['network', '网络服务'],
  ['audio', '音频服务'],
  ['storage', '存储服务'],
  ['decryption', '内容解密服务'],
  ['video', '视频采集服务'],
  ['proxy', '代理解析服务'],
  ['printing', '打印服务'],
]

function utilityLabel(m) {
  const both = [m.name, m.serviceName].filter(Boolean).join(' ').toLowerCase()
  const hit = UTILITY_LABELS.find(([kw]) => both.includes(kw))
  if (hit) return hit[1]
  return m.name || m.serviceName || '服务进程'
}

// 收集逐进程内存列表（主进程 / 各渲染窗口 / GPU / 各服务进程 / 后端）。
// 面板快照与内存历史采样共用，保证两处口径一致。
async function collectProcList() {
  // 渲染进程按所属窗口取友好名（同一 pid 后写覆盖，主窗口优先级最高）
  const labelByPid = new Map()
  const addWin = (label, win) => {
    try {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        labelByPid.set(win.webContents.getOSProcessId(), label)
      }
    } catch (_) { /* 忽略 */ }
  }
  addWin('迁移窗口', getMigrationWindow())
  addWin('引导窗口', getSetupWindow())
  addWin('桌面组件', getDesktopWidgetWindow())
  addWin('小组件', getWidgetWindow())
  addWin('前端窗口', getMainWindow())

  const procs = []
  let metrics = []
  try { metrics = app.getAppMetrics() } catch (_) { metrics = [] }

  // 主进程
  const browser = metrics.find((m) => m.type === 'Browser')
  if (browser) procs.push({ key: 'main', name: '主进程', kind: 'main', ...metricToMem(browser) })

  // 各渲染进程
  for (const m of metrics.filter((x) => x.type === 'Tab')) {
    procs.push({
      key: `tab-${m.pid}`,
      name: labelByPid.get(m.pid) || '渲染进程',
      kind: 'renderer',
      ...metricToMem(m),
    })
  }

  // GPU 进程
  for (const m of metrics.filter((x) => x.type === 'GPU')) {
    procs.push({ key: `gpu-${m.pid}`, name: 'GPU 进程', kind: 'gpu', ...metricToMem(m) })
  }

  // 各服务进程（网络/存储/音频等）：Chromium 只给英文名，展示层翻成中文
  for (const m of metrics.filter((x) => x.type === 'Utility')) {
    procs.push({
      key: `util-${m.pid}`,
      name: utilityLabel(m),
      kind: 'utility',
      ...metricToMem(m),
    })
  }

  // 后端：Node 子进程不在 getAppMetrics 里，由它用 process.memoryUsage() 自报（字节 → KB）
  const mem = await queryBackendMemorySerial()
  if (mem) {
    const backendProcess = getBackendProcess()
    procs.push({
      key: 'backend',
      name: '后端',
      kind: 'backend',
      pid: backendProcess?.pid ?? null,
      workingSetKB: Math.round((mem.rss || 0) / 1024),
      // Node 不直接暴露「私有提交量」，用 V8 堆 + external（native 分配）近似，
      // 以便与 Chromium 各进程的 privateBytes 口径对齐。
      privateKB: Math.round(((mem.heapUsed || 0) + (mem.external || 0)) / 1024),
      cpu: null,
    })
  }

  // 内存口径统一改为「专用工作集」（与任务管理器「进程」页一致），逐进程按 pid 覆盖。
  // 计数器不可用（非 Windows / koffi 缺失）时 privWsKB 留空，前端回退到 Electron 自带口径。
  // 查询在 worker 线程里跑（首次 provider 载入约 0.7s），故此处 await，不阻塞主线程。
  const pwMap = await getPrivateWorkingSetKB()
  if (pwMap) {
    for (const p of procs) {
      const kb = p.pid == null ? undefined : pwMap.get(p.pid)
      if (typeof kb === 'number') p.privWsKB = Math.round(kb)
    }
  }
  return procs
}

// 单个进程在面板采用的内存口径：优先专用工作集，回退私有提交量
function procMemKB(p) {
  if (typeof p.privWsKB === 'number') return p.privWsKB
  if (typeof p.privateKB === 'number') return p.privateKB
  return 0
}

// ========== 内存历史：总计 / 平均（近一分钟）/ 最高（自启动起）==========
// 由主进程定时采样，不依赖设置页是否打开——「最高」自程序启动即开始统计。
const MEM_SAMPLE_INTERVAL = 5000
const MEM_AVG_WINDOW = 60000
// 首采延后：启动瞬间与首屏并行会抢 worker/IPC；等首屏可见后再采第一次。
const MEM_FIRST_DELAY = 2000
// 启动后第一个事件循环观测窗口：覆盖建窗 + 后端 fork + 首屏渲染
const EVENT_LOOP_FIRST_MARK = 3000
let memHistory = []        // [{ t, kb }]，仅保留近一分钟的样本
let memMaxKB = 0           // 自启动以来的最高总计
let memSampleTimer = null
let memFirstTimer = null
let memSampling = false

function recordMemSample(kb) {
  if (!kb || kb <= 0) return
  const now = Date.now()
  memHistory.push({ t: now, kb })
  const cutoff = now - MEM_AVG_WINDOW
  while (memHistory.length && memHistory[0].t < cutoff) memHistory.shift()
  if (kb > memMaxKB) memMaxKB = kb
}

function memAvgKB() {
  if (!memHistory.length) return 0
  let sum = 0
  for (const h of memHistory) sum += h.kb
  return Math.round(sum / memHistory.length)
}

async function sampleMemTotal() {
  if (memSampling) return
  memSampling = true
  try {
    // 采集链路由 app.getAppMetrics + 后端 mem-report IPC + PDH worker 三段组成，
    // 任一段变慢都应能看见；>30ms 留一条日志，正常路径不刷屏。
    const t0 = process.hrtime.bigint()
    const procs = await collectProcList()
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    if (ms > 30) {
      try { console.log(`[perf] 内存采集 ${Math.round(ms)}ms`) } catch (_) { /* 日志失败静默 */ }
    }
    recordMemSample(procs.reduce((s, p) => s + procMemKB(p), 0))
  } catch (_) { /* 采样失败静默忽略 */ }
  finally { memSampling = false }
}

function startMemSampling() {
  if (memSampleTimer || memFirstTimer) return
  // 主进程事件循环观测：与内存采样一起启动，但读数独立（面板快照 / 启动窗口各读一次）。
  startEventLoopSampling()
  memFirstTimer = setTimeout(() => {
    memFirstTimer = null
    sampleMemTotal()
    memSampleTimer = setInterval(sampleMemTotal, MEM_SAMPLE_INTERVAL)
  }, MEM_FIRST_DELAY)
  setTimeout(() => markEventLoopWindow('启动后'), EVENT_LOOP_FIRST_MARK)
  // 2-16：首屏请求发生在 400~700ms，这里在 1s 时无条件读一次窗口分位数，
  // 判断 app:// 协议派发前的主进程事件循环是否被启动期同步工作占住。
  if (process.env.PERF_STARTUP === '1') {
    setTimeout(() => {
      try {
        const s = readEventLoopStats({ reset: true })
        console.log(s
          ? `[perf] 事件循环 启动后1s p50=${s.p50}ms p95=${s.p95}ms max=${s.max}ms 样本=${s.count}`
          : '[perf] 事件循环 启动后1s 不可用')
      } catch (_) { /* 打点失败静默 */ }
    }, 1000)
  }
}

function registerPerfIpc(opts = {}) {
  if (typeof opts.getMainWindow === 'function') getMainWindow = opts.getMainWindow
  if (typeof opts.getWidgetWindow === 'function') getWidgetWindow = opts.getWidgetWindow
  if (typeof opts.getDesktopWidgetWindow === 'function') getDesktopWidgetWindow = opts.getDesktopWidgetWindow
  if (typeof opts.setDesktopWidgetWindow === 'function') setDesktopWidgetWindow = opts.setDesktopWidgetWindow
  if (typeof opts.getMigrationWindow === 'function') getMigrationWindow = opts.getMigrationWindow
  if (typeof opts.getSetupWindow === 'function') getSetupWindow = opts.getSetupWindow
  if (typeof opts.getBackendProcess === 'function') getBackendProcess = opts.getBackendProcess
  if (typeof opts.isBackendReady === 'function') isBackendReady = opts.isBackendReady
  if (typeof opts.isDesktopEnabled === 'function') isDesktopEnabled = opts.isDesktopEnabled
  if (typeof opts.hideWidgetWindow === 'function') hideWidgetWindow = opts.hideWidgetWindow
  if (typeof opts.showWidgetWindow === 'function') showWidgetWindow = opts.showWidgetWindow
  if (typeof opts.createDesktopWidgetWindow === 'function') createDesktopWidgetWindow = opts.createDesktopWidgetWindow
  if (typeof opts.getInstallDir === 'function') getInstallDir = opts.getInstallDir
  if (typeof opts.getDataDir === 'function') getDataDir = opts.getDataDir
  if (typeof opts.getThumbsDir === 'function') getThumbsDir = opts.getThumbsDir

  // 内存快照：逐进程列表 + 前端/后端/小组件存活状态 + 总计/平均/最高汇总
  IPC.handle(CH.PERF_SNAPSHOT, async () => {
    const procs = await collectProcList()
    const total = procs.reduce((s, p) => s + procMemKB(p), 0)
    // 面板打开时也记一笔，让「平均/最高」与逐进程列表的当前值保持同步
    recordMemSample(total)
    // 按用途分组：前端（主窗口渲染进程）/ 后端 / 其他（主进程、GPU、其他渲染/服务进程）
    const frontKB = procs.reduce((s, p) => s + (p.name === '前端窗口' ? procMemKB(p) : 0), 0)
    const backendKB = procs.reduce((s, p) => s + (p.kind === 'backend' ? procMemKB(p) : 0), 0)
    const otherKB = Math.max(0, total - frontKB - backendKB)
    // 存活状态按窗口/进程本身判定，不依赖指标里能否匹配到 pid
    const mainWindow = getMainWindow()
    const widgetWindow = getWidgetWindow()
    const desktopWidgetWindow = getDesktopWidgetWindow()
    const alive = {
      front: !!(mainWindow && !mainWindow.isDestroyed()),
      widget: !!((widgetWindow && !widgetWindow.isDestroyed()) || (desktopWidgetWindow && !desktopWidgetWindow.isDestroyed())),
      backend: procs.some((p) => p.kind === 'backend'),
    }
    return { procs, alive, total, avg1min: memAvgKB(), max: memMaxKB, frontKB, backendKB, otherKB, eventLoop: readEventLoopStats({ reset: true }) }
  })

  // 重启前端：直接重载主窗口页面
  IPC.handle(CH.PERF_RESTART_FRONTEND, () => {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
    return { ok: true }
  })

  // 重启小组件：销毁并重建原本存在的窗口，并尊重用户开关（关掉的不重新拉起）
  IPC.handle(CH.PERF_RESTART_WIDGET, () => {
    // 工具箱浮窗：仅当原本存在时重建；重建后按会话级开关决定显隐
    const widgetWindow = getWidgetWindow()
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      // 隐藏态下窗口已被销毁，能进到这里说明当前可见；直接「销毁后重建」即完成重启
      hideWidgetWindow()
      showWidgetWindow()
    }
    // 桌面组件：仅当原本存在（说明当前已启用）时重建
    let desktopWidgetWindow = getDesktopWidgetWindow()
    if (desktopWidgetWindow && !desktopWidgetWindow.isDestroyed()) {
      try { desktopWidgetWindow.destroy() } catch (_) { /* 忽略 */ }
      setDesktopWidgetWindow(null)
      if (isDesktopEnabled()) createDesktopWidgetWindow()
    }
    return { ok: true }
  })

  // 全部重启（含 Electron 本体）：先调度 relaunch，再走正常退出流程。
  // 用 app.quit() 而非 app.exit()：quit 会触发 before-quit → shutdownBackend，
  // 干净停掉后端子进程后再退出并拉起新实例，避免后端残留。
  IPC.handle(CH.PERF_RELAUNCH_APP, () => {
    app.relaunch()
    app.quit()
    return { ok: true }
  })

  // 手动 GC：主进程 global.gc + 各渲染进程 CDP 回收 + 后端自报 GC
  IPC.handle(CH.PERF_GC, async () => {
    // 主进程
    let main = false
    try {
      if (typeof global.gc === 'function') { global.gc(); main = true }
    } catch (_) { /* 忽略 */ }

    // 渲染进程逐个回收（前端主窗口 + 工具箱/桌面组件）
    const mainWindow = getMainWindow()
    const widgetWindow = getWidgetWindow()
    const desktopWidgetWindow = getDesktopWidgetWindow()
    const front = await collectRendererGarbage(mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null)
    let widget = false
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widget = await collectRendererGarbage(widgetWindow.webContents)
    } else if (desktopWidgetWindow && !desktopWidgetWindow.isDestroyed()) {
      widget = await collectRendererGarbage(desktopWidgetWindow.webContents)
    }

    // 后端
    const backend = (await queryBackendGc()) === true

    return { main, front, widget, backend }
  })

  // 上次启动耗时与打点时间线
  IPC.handle(CH.PERF_STARTUP, () => startupTimer.getTimeline())

  // 空间管理：磁盘占用按四类归账（软件本体 / 该账号 / 其他账号 / 微缩图）+ 其他兜底。
  // 只读扫描、不进 1s 轮询链：由设置页进入时与手动「重新统计」触发。
  // 返回体走统一契约（ok / fail）：前端据 outcome 区分「扫到 0」与「扫失败」。
  IPC.handle(CH.PERF_DISK_USAGE, async (_event, payload) => {
    const slug = payload && typeof payload.slug === 'string' ? payload.slug : ''
    try {
      const usage = await scanDiskUsage({
        appDir: getInstallDir(),
        dataDir: getDataDir(),
        thumbsDir: getThumbsDir(),
        // v2 布局下 backend.log/startup.log/inp.log 都在 <数据根>/logs/；
        // desktop-layer.log 仍属应用级日志，留在 userData 根。扫描端按目录去重。
        logDirs: [resolveLogsDir(), app.getPath('userData')],
        slug,
      })
      return ok({ ...usage, at: Date.now() })
    } catch (err) {
      return fail(err)
    }
  })

  // 「日志」行的「清理」：把四个日志出口截断为 0。
  // 日志是主进程写的（backend.log 的写流、inp.log/desktop-layer.log 的追加），
  // 放后端路由反而够不到 userData 根那份，所以在这里直接动手；
  // 报数用清理前后的实际体积差 —— 并发写入导致没清干净时不会虚报。
  IPC.handle(CH.PERF_LOGS_CLEAR, async () => {
    try {
      const files = logFilePaths(getDataDir(), [
        resolveLogsDir(),
        app.getPath('userData'),
      ])
      let clearedBytes = 0
      let clearedFiles = 0
      for (const file of files) {
        let before = 0
        try {
          const st = await fsp.stat(file)
          if (!st.isFile()) continue
          before = st.size
        } catch (_) { continue }
        await clearLogFile(file)
        let after = 0
        try { after = (await fsp.stat(file)).size } catch (_) { after = 0 }
        if (before > after) {
          clearedBytes += before - after
          clearedFiles += 1
        }
      }
      return ok({ clearedBytes, files: clearedFiles, at: Date.now() })
    } catch (err) {
      return fail(err)
    }
  })
}

module.exports = {
  registerPerfIpc,
  startMemSampling,
  handleBackendMemReport,
  handleBackendGcReport,
}