// =========================================================================
// grid-row-drag-probe.cjs —— 在 electron 里打开探针页，收集 console 输出
//
// 不需要关掉正在运行的应用：
//   · 走独立的 electron 主进程（不 require 项目 main.js）→ 不吃单实例锁
//   · 调试端口单独用 9333 → 不与应用的 9222 冲突
//   · 页面是 vite dev server 上的 /drag-probe.html（复用已起的 5173）
//
// 用法：npx electron testjs/probe/grid-row-drag-probe.cjs
// =========================================================================
const { app, BrowserWindow } = require('electron')

const URL = process.env.PROBE_URL || 'http://127.0.0.1:5173/drag-probe.html'
const TIMEOUT = Number(process.env.PROBE_TIMEOUT || 45000)
let done = false

function finish(code) {
  if (done) return
  done = true
  setTimeout(() => app.quit(), 150)
  process.exitCode = code
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    // 必须可见：隐藏窗口里 getBoundingClientRect 宽高为 0，
    // createRowSliceGhost 会直接返回 null，拖动压根启动不了（探针会“什么都没发生”）
    show: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  })

  // Electron 新旧版本 console-message 的参数形态不同，两种都兼容
  win.webContents.on('console-message', (...args) => {
    let message = ''
    if (args[0] && typeof args[0] === 'object' && 'message' in args[0]) message = args[0].message
    else message = String(args[2] != null ? args[2] : args[1] != null ? args[1] : '')
    console.log(message)
    if (message.includes('__PROBE_DONE__')) finish(0)
  })

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.log(`[probe] load failed ${code} ${desc} (vite 是否在 5173？)`)
    finish(1)
  })

  win.loadURL(URL)
  setTimeout(() => { console.log('[probe] TIMEOUT'); finish(2) }, TIMEOUT)
})

app.on('window-all-closed', () => app.quit())
