// =========================================================================
// dev-loader.js —— 开发模式加载器（Vite 就绪轮询 / inline loading 页 / 重试导航）
//
// 由 main.js 在模块加载期 require 后调用：devLoadingHtml() / pollViteAndNavigate(win) /
// loadUrlWithRetry(win, url)（后者同时注入给 widget.js 的 registerWidgetIpc）。
// 依赖 backend.setBootStatus 与 startupTimer.mark；原函数内嵌于 main.js，此处为等价的纯搬运。
// =========================================================================

const path = require('path')
const fs = require('fs')
const backend = require('./main.backend')
const startupTimer = require('./main.startup-timer')
const ports = require('../../config/ports.cjs')

// 首屏占位共享来源：index.html / setup.html 由 Vite 注入同一份（splash/），
// dev 下主进程先加载的 inline loading 页也复用这两份文件，避免同款加载画面维护多份。
// 本模块位于 electron/main/，student-frontend 在工程根目录下，故向上两级。
const SPLASH_CSS_PATH = path.join(__dirname, '..', '..', 'student-frontend', 'splash', 'splash.css')
const SPLASH_HTML_PATH = path.join(__dirname, '..', '..', 'student-frontend', 'splash', 'splash.html')

// 等待开发服务器就绪后再让窗口导航。
// 关键点：先用轻量 http 探测目标地址（不改变窗口显示内容），命中后才真正 loadURL，
// 避免每次重试都导航一次、失败时窗口停在错误页（表现为白屏/报错闪现）。
// 重试间隔 200ms（原来 1000ms），Vite 一就绪几乎立刻跳转。
function loadUrlWithRetry(win, url, retries = 150, intervalMs = 200) {
  if (!win || win.isDestroyed()) return
  const http = require('http')
  const retry = (label) => {
    if (win.isDestroyed()) return
    if (retries > 0) {
      // 200ms 一次的高频重试不再逐条打日志，每 25 次提示一次进度（约 5s）
      if (retries % 25 === 0) console.log(`[Electron] 等待 ${url} 就绪，剩余重试 ${retries}...`)
      setTimeout(() => loadUrlWithRetry(win, url, retries - 1, intervalMs), intervalMs)
    } else {
      console.error(`[Electron] 无法加载 ${url}: ${label}`)
    }
  }
  const req = http.get(url, (res) => {
    let body = ''
    res.setEncoding('utf8')
    // dev 子页面只有几 KB：读够判据就停止累积，但仍继续消费流（避免占着 socket）
    res.on('data', (chunk) => { if (body.length < 16 * 1024) body += chunk })
    res.on('end', () => {
      // 只认 HTTP 200 会在 dev 端口被别的程序占住时把**第三方页面**加载进来，
      // 而 preload 已注入 window.electron（含 get-master-key）—— 能力暴露给陌生页面。
      // 各 dev 子页面都带 Vite 的 /src/... 模块入口，第三方页面一般没有；
      // 校验不过就继续等，绝不导航过去（与主窗口 pollViteAndNavigate 同一条防线）。
      if (res.statusCode !== 200 || !looksLikeOurVitePage(body)) {
        retry(`HTTP ${res.statusCode}，但不是本项目的开发页面（端口可能被占用）`)
        return
      }
      if (win.isDestroyed()) return
      console.log(`[Electron] 开发服务器就绪，开始加载 ${url}`)
      backend.setBootStatus('开发服务器已就绪，正在加载界面…')
      win.loadURL(url).catch((err) => {
        console.error(`[Electron] 加载 ${url} 失败:`, err.message)
      })
    })
  })
  req.on('error', () => retry('开发服务器未就绪'))
  req.end()
}

// 开发模式：先加载本地 inline loading 页面，不等 Vite 就绪。
// 这样窗口能在 < 1s 内弹出（显示 loading 动画），
// 后台轮询 Vite 就绪后自动跳转到热更新页面。
// 样式与结构直接读取 splash/ 下的共享文件（与 index.html / setup.html 注入的是同一份），
// 保证 dev 下 loading 页与正式首屏占位只出现「一个画面」。
function devLoadingHtml() {
  let css = ''
  let body = ''
  try {
    css = fs.readFileSync(SPLASH_CSS_PATH, 'utf8')
    body = fs.readFileSync(SPLASH_HTML_PATH, 'utf8')
  } catch (_) { /* 读不到共享文件时退化为最小占位，至少不出白屏 */ }
  if (!body) {
    body = '<div class="app-splash"><span class="logo">班集</span><span class="tip" id="boot-tip">加载中，请稍候…</span></div>'
  }
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
<style>
html,body{margin:0;height:100%}
body{background:linear-gradient(160deg,#eef2ff 0%,#e2e8ff 100%)}
${css}
</style></head>
<body>${body}
<script>
(function(){
  var el=document.getElementById('boot-tip');
  if(!el) return;
  var api=window.electron;
  if(api&&api.on){api.on('from-main',function(m){if(m&&m.type==='boot-status'&&m.text){el.textContent=m.text}})}
  if(api&&api.invoke){api.invoke('boot-status').then(function(t){if(t){el.textContent=t}}).catch(function(){})}
})();
</script>
</body></html>`
}

// 轮询 Vite 开发服务器：用 http.get 轻量探测，不阻塞渲染进程。
// Vite 就绪后导航到首页并打开 DevTools。
// 重试上限留足 ~4s 预算（轮询在创建窗口后立刻开始）。
//
// 为什么快轮询用尽后还要转低速轮询：Electron 窗口常常比 Vite 先起（Vite 冷启动要预编译依赖，
// 实测可到 5s+），原来 40 次 ×100ms 用尽就静默放弃，窗口会永远停在 inline loading 页上，
// 只能靠手动重启整个 dev 进程才能恢复。现在快轮询（100 次 ≈10s）用尽后转入 1s/次的低速轮询，
// 窗口活着就一直等，Vite 迟到多久都能接上。
// 判据：本项目的 dev 入口一定同时含 Vue 挂载点和 /src/main.js 引用。
// 只判断「有响应」是不够的 —— 端口若被别的程序占着，Electron 会把**别人的页面**
// 加载进来，而 preload 已经把 window.electron 桥暴露给该页面：既不安全，现象也
// 极难归因（窗口里跑着别的应用）。宁可当作未就绪继续等，也不导航过去。
function looksLikeOurVite(html) {
  return /id=["']app["']/.test(html) && /\/src\/main\.js/.test(html)
}

// 子窗口（setup / migration / widget / desktop-widget）加载的是各自的子页面，
// 没有 id="app"，但有共同的 Vite 开发入口：type="module" src="/src/..."。
// 用它挡住「dev 端口被占 → 把第三方页面加载进来 + preload 已注入 window.electron」。
function looksLikeOurVitePage(html) {
  return /<script[^>]+type=["']module["'][^>]+src=["']\/src\//.test(html)
}

function pollViteAndNavigate(win, retries = 100, slow = false) {
  const http = require('http')
  const scheduleRetry = () => {
    if (!win || win.isDestroyed()) return
    if (retries > 0) {
      // 快轮询阶段每 100 次（约 10s）报一次进度，方便在启动日志里看出「Vite 到底起多慢」
      if (!slow && retries % 100 === 0) console.log(`[Electron] 等待开发服务器就绪，剩余重试 ${retries}...`)
      setTimeout(() => pollViteAndNavigate(win, retries - 1, slow), slow ? 1000 : 100)
    } else if (!slow) {
      console.log('[Electron] 开发服务器 10s 内未就绪，转入 1s/次的低速轮询继续等待…')
      // 3600 次 ≈1 小时： finite 而不是 Infinity，这样下面的取余日志能正常打点
      pollViteAndNavigate(win, 3600, true)
    } else if (retries % 30 === 0) {
      console.log('[Electron] 仍在等待开发服务器就绪（1s/次）…')
    }
  }

  const req = http.get(ports.frontendOrigin + '/', (res) => {
    let body = ''
    res.setEncoding('utf8')
    // dev 的 index.html 只有几 KB：读够判据就停止累积，但仍继续消费流（避免占着 socket）
    res.on('data', (chunk) => { if (body.length < 16 * 1024) body += chunk })
    res.on('end', () => {
      if (res.statusCode !== 200 || !looksLikeOurVite(body)) {
        // 只在首次与每 30 次提示：端口长期被别的服务占着时，这条会按 1s/次 的节奏
        // 一直重试，逐次打印会把开发日志刷爆。
        if (retries === 100 || retries % 30 === 0) {
          console.error(
            `[Electron] ${ports.frontendOrigin} 有响应（HTTP ${res.statusCode}），但不是本项目的开发服务器。` +
            '可能被别的程序占用，不会导航过去；请关闭占用该端口的程序，或用 FRONTEND_PORT 指定别的端口。'
          )
        }
        scheduleRetry()
        return
      }
      startupTimer.mark('Vite 就绪，开始跳转')
      backend.setBootStatus('开发服务器已就绪，正在加载界面…')
      if (win && !win.isDestroyed()) {
        // 必须接 catch：loadURL 失败会 reject，不接就是 unhandled rejection（仅开发模式）
        win.loadURL(ports.frontendOrigin + '/').catch((err) => {
          console.error('[Electron] 开发界面加载失败:', err && err.message)
        })
        // INP 测量时不开 DevTools：停靠的 DevTools 会改变内容区尺寸并叠加额外 CDP 开销，
        // 干扰布局与交互耗时，导致测量失真。
        if (!process.env.INP_DEBUG) win.webContents.openDevTools()
        win.webContents.once('did-finish-load', () => {
          startupTimer.mark('Vite 页面加载完成')
        })
      }
    })
  })
  req.on('error', scheduleRetry)
  req.end()
}

module.exports = { devLoadingHtml, pollViteAndNavigate, loadUrlWithRetry }
