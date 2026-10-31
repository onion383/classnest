/**
 * vapor-bench.mjs —— 同步循环基准的驱动脚本（3.5/VDOM vs 3.6/Vapor vs 3.6/VDOM）
 * ---------------------------------------------------------------------------
 * 背景：INP 口径测不出差异（8ms 量化台阶 + ~40ms 帧调度地板，见 inp-compare.mjs 结论），
 * 所以换成**页面内同步循环 + performance.now 直接夹**，把框架成本从帧调度里摘出来。
 *
 * 被测页面：student-frontend/bench.html（不在 build input 里，不会进产物）
 * 被测组件：student-frontend/bench/BenchTable.vue（200 行 × 8 列，带 `vapor` 标记）
 *
 * 三个通道跑的是同一份源码 / 同一个组件：
 *   3.5 / VDOM       —— vapor 属性被 3.5 编译器逐字忽略
 *   3.6 / Vapor      —— 按 vapor 编译
 *   3.6 / VDOM       —— 3.6 编译器 + 纯 VDOM 运行时，vapor 属性被插件剥掉
 * 加第三条是为了把「3.6 运行时本身」和「Vapor」两层收益拆开。
 *
 * 用法：
 *   node testjs/probe/vapor-bench.mjs              # 跑 3.5（VDOM 基线）
 *   node testjs/probe/vapor-bench.mjs --vue36      # 跑 3.6（Vapor 实验组）
 *   node testjs/probe/vapor-bench.mjs --vue36 --vdom   # 跑 3.6（纯 VDOM 对照组）
 *   node testjs/probe/vapor-bench.mjs --runs=3     # 每通道跑 3 次取中位（默认 1）
 *   node testjs/probe/vapor-bench.mjs --prod       # 生产口径：先 build bench 页，再起本地静态服务加载
 *
 * --prod 不打包 exe（打包出的未签名 exe 会被 SmartScreen 拦、要管理员权限放行）：
 * 只产出静态文件到 testjs/tmp/bench/prod<通道>/，由本脚本自带的静态服务（5180）提供，
 * 再用 node_modules 里现成的 electron 打开。结果写到 bench-<通道>-prod.json，与 dev 口径分开。
 *
 * 前置：先关掉正在运行的应用（Electron 单实例锁）。
 * 结果：终端表格 + testjs/tmp/bench-<通道>.json（三份中任两份都在时自动出对比）。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readFile, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FRONTEND = path.join(ROOT, 'student-frontend')
const OUT_DIR = path.join(ROOT, 'testjs', 'tmp')
const PORT = Number(process.env.INP_PORT || 9222)
const VITE_BASE = 'http://127.0.0.1:5173'
const PROD_PORT = 5180
const PROD_BASE = `http://127.0.0.1:${PROD_PORT}`
const CDP_HOST = `127.0.0.1:${PORT}`

const argv = process.argv.slice(2)
// 通道标识用 '35' | '36' | '36v'：'36v' = 3.6 编译器 + 纯 VDOM 运行时（--vue36 --vdom）
const VUE = !(argv.includes('--vue36') || process.env.INP_VUE === '36')
  ? '35'
  : argv.includes('--vdom')
    ? '36v'
    : '36'
// --prod：基准页走 build + minify，跑生产运行时（dev 版运行时带全部断言，会污染绝对值）。
// 不打包 exe：只产出静态文件，由本脚本起本地静态服务 + 复用 node_modules 里的 electron 加载。
const PROD = argv.includes('--prod')
const BASE = PROD ? PROD_BASE : VITE_BASE
const LABELS = {
  35: 'Vue 3.5 / VDOM',
  36: 'Vue 3.6 / Vapor',
  '36v': 'Vue 3.6 / VDOM',
}
const VUE_LABEL = LABELS[VUE] + (PROD ? '（生产构建）' : '')
const RUNS = Number((argv.find((a) => a.startsWith('--runs=')) || '').slice(7)) || 1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 极简 CDP
class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map() }
  _onMessage(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)) }
      }, 30000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

function rawConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 8000)
    ws.onopen = () => {
      clearTimeout(timer)
      const cdp = new CDP(ws)
      ws.onmessage = (ev) => cdp._onMessage(ev.data)
      ws.onerror = null
      resolve(cdp)
    }
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error('WebSocket 错误: ' + (e?.message || ''))) }
  })
}

async function listTargets() {
  try {
    const res = await fetch(`http://${CDP_HOST}/json/list`, { cache: 'no-store' })
    return res.ok ? await res.json() : null
  } catch { return null }
}

async function waitForTarget(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const t = (await listTargets() || []).find(pred)
    if (t && t.webSocketDebuggerUrl) return t
    await sleep(250)
  }
  return null
}

const PAGE = `${BASE}/bench.html`

// 应用外壳始终跑在 5173 的 dev server（它只负责把渲染进程拉起来，不参与测量）；
// prod 模式下被测页面走的是 5180 静态目录里的构建产物。
const isMain = (t) =>
  t.type === 'page' && typeof t.url === 'string' &&
  (t.url.startsWith(VITE_BASE) || t.url.startsWith(BASE)) && !t.url.includes('.html')
const isBench = (t) => t.type === 'page' && typeof t.url === 'string' && t.url.includes('/bench.html')

async function viteUp() {
  const http = require('node:http')
  return new Promise((resolve) => {
    const req = http.get(`${VITE_BASE}/`, { timeout: 1500 }, (res) => { res.resume(); resolve(true) })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

/** 复用已有 dev server 时必须确认通道，否则整轮测的是另一条通道（源码相同、结论相反） */
async function detectViteChannel() {
  const http = require('node:http')
  return new Promise((resolve) => {
    const req = http.get(`${VITE_BASE}/src/views/AboutView.vue`, { timeout: 4000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        // 三分支：with-vapor 是 3.6 双运行时；只剩 vue36 路径说明是 3.6 的纯 VDOM 运行时；
        // 都没有才是 3.5 主线。判据看 transform 后的 import 路径，不能只看有没 "vue36" 字样。
        if (/with-vapor/.test(body)) return resolve('36')
        resolve(/vue36/.test(body) ? '36v' : '35')
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

let viteChild = null
function stopVite() {
  if (staticServer) {
    try { staticServer.close() } catch (_) {}
    staticServer = null
  }
  if (!viteChild || viteChild.killed) return
  const pid = viteChild.pid
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-pid, 'SIGTERM')
  } catch (_) {
    try { viteChild.kill() } catch (_) {}
  }
  viteChild = null
}

async function ensureVite() {
  if (await viteUp()) {
    const ch = await detectViteChannel()
    if (ch && ch !== VUE) throw new Error(`5173 上的 Vite 是 Vue ${ch} 通道，本次要测 ${VUE}。请先关掉它。`)
    console.log(`[bench] 复用已运行的 Vite（通道 ${ch || '?'}）`)
    return
  }
  console.log(`[bench] 启动 Vite（${VUE_LABEL}）…`)
  const vueArgs = VUE === '36' ? ['--vue36'] : VUE === '36v' ? ['--vue36', '--vdom'] : []
  viteChild = spawn(
    process.execPath,
    [path.join(FRONTEND, 'dev-vite.js'), ...vueArgs],
    { cwd: FRONTEND, stdio: 'inherit', detached: process.platform !== 'win32' },
  )
  const deadline = Date.now() + 40000
  while (Date.now() < deadline && !(await viteUp())) await sleep(400)
  if (!(await viteUp())) throw new Error('Vite 40s 内未就绪')
}

// ---------------------------------------------------------------- 生产口径（--prod）
// 为什么要单独做：dev server 跑的是 dev 版运行时（带全部断言与警告），而用户装的是生产包。
// 这里把 bench 页按生产配置 build（input 只留 bench.html，见 vite.config.js 的 VUE_BENCH=1），
// 再用本脚本自带的静态服务 + node_modules 里现成的 electron 加载 —— **不打包 exe**，
// 因为打包出的未签名 exe 会被 SmartScreen 拦，且需要管理员权限才能放行。
const PROD_DIR = path.join(OUT_DIR, 'bench', `prod${VUE}`)
let staticServer = null

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
}

function buildProd() {
  return new Promise((resolve, reject) => {
    console.log(`[bench] 构建基准页（${VUE_LABEL}）…`)
    const vueArgs = VUE === '36' ? ['--vue36'] : VUE === '36v' ? ['--vue36', '--vdom'] : []
    const outRel = path.relative(FRONTEND, PROD_DIR).replace(/\\/g, '/')
    const child = spawn(
      process.execPath,
      [path.join(FRONTEND, 'dev-vite.js'), ...vueArgs, 'build', '--outDir', outRel, '--emptyOutDir'],
      { cwd: FRONTEND, env: { ...process.env, VUE_BENCH: '1' }, stdio: 'inherit' },
    )
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`基准页构建失败（code=${code}）`))))
  })
}

function serveProd() {
  const http = require('node:http')
  const root = path.resolve(PROD_DIR)
  staticServer = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
    const file = path.resolve(root, urlPath === '/' ? 'bench.html' : urlPath.replace(/^\/+/, ''))
    // 目录穿越保护：解析后必须仍在产物目录内
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden')
      return
    }
    readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
        return
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(buf)
    })
  })
  return new Promise((resolve) => staticServer.listen(PROD_PORT, '127.0.0.1', resolve))
}

async function ensureElectron() {
  const existing = await waitForTarget(isMain, 800)
  if (existing) {
    const ch = await detectViteChannel()
    if (ch && ch !== VUE) throw new Error(`已有实例连的是 Vue ${ch} 通道，本次要测 ${VUE}。请先关掉它。`)
    console.log('[bench] 复用已启动的 Electron')
    return { child: null }
  }
  const electronPath = require('electron')
  // 宿主（WorkBuddy 自身是 Electron 应用 / 部分 CI）会注入 ELECTRON_RUN_AS_NODE=1，
  // 那样 electron.exe 会退化成纯 Node 跑 main.js（app 为 undefined）。必须摘掉。
  const env = { ...process.env, INP_DEBUG: '1', FORCE_SETUP: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  console.log('[bench] 启动 Electron（调试端口 ' + PORT + '）…')
  const child = spawn(electronPath, ['.', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'], {
    cwd: ROOT, env, stdio: 'inherit',
  })
  return { child }
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

async function runOnce(cdp, i) {
  await cdp.send('Page.navigate', { url: PAGE })
  // 等页面把 window.__bench 写出来（run() 是异步的，done=true 才收）
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    const r = await cdp.eval('window.__bench || null').catch(() => null)
    if (r && (r.done || r.error)) {
      if (r.error) throw new Error('bench 页出错：' + r.error)
      console.log(`[bench] 第 ${i} 次完成：${r.channel}`)
      return r
    }
    await sleep(400)
  }
  throw new Error('bench 页 180s 内未产出结果')
}

function printOne(r) {
  const rows = Object.entries(r.results).map(([k, v]) => ({
    项目: k,
    中位ms: v.median,
    最小ms: v.min,
    最大ms: v.max,
    // 轮间波动 = 首轮 7 个样本的极差；跨通道差异必须明显大于它才算数
    轮间波动: v.detail ? Number((Math.max(...v.detail) - Math.min(...v.detail)).toFixed(4)) : '—',
  }))
  console.table(rows)
}

function compare(a, b) {
  const keys = [...new Set([...Object.keys(a.results), ...Object.keys(b.results)])]
  const rows = keys.map((k) => {
    const va = a.results[k]?.median
    const vb = b.results[k]?.median
    const ratio = va && vb ? (va / vb) : null
    return {
      项目: k,
      [`A ${a.channel} ms`]: va ?? '—',
      [`B ${b.channel} ms`]: vb ?? '—',
      'Δ ms': va != null && vb != null ? Number((vb - va).toFixed(4)) : '—',
      '加速比(A/B)': ratio ? Number(ratio.toFixed(2)) + '×' : '—',
    }
  })
  console.log('\n================ 同步循环 bench 对比（每项取中位）================')
  console.log(`A ${a.channel}   B ${b.channel}   行数 ${a.rows} × ${a.cells / a.rows} 列   ${a.rounds} 轮`)
  console.table(rows)
  console.log(`自证：A ${a.selfCheck ? '通过' : '未通过'} / B ${b.selfCheck ? '通过' : '未通过'}（通过 = 测完已确认 DOM 真的更新到预期值）`)
  console.log('读法：加速比 > 1 表示 B 更快。')
  console.log('      mountBare 是纯 JS 挂载（不含布局），mount 含强制布局 —— 两者差值就是布局成本。')
  console.log('      patchOne / patchRow / rebuild 才是框架差异所在；tick / mountEmpty 是基线。')
}

async function main() {
  if (PROD) {
    await buildProd()
    await serveProd()
    console.log(`[bench] 静态服务已就绪：${PROD_BASE}（产物 ${path.relative(ROOT, PROD_DIR)}）`)
  }
  // 外壳仍用 5173 的 dev server：它只负责把渲染进程拉起来，被测页面在 prod 模式下是 5180
  await ensureVite()
  const { child } = await ensureElectron()
  const deadline = Date.now() + 45000
  let target = null
  while (Date.now() < deadline && !target) {
    target = await waitForTarget(isMain, 1000)
    if (!target && child && child.exitCode !== null) {
      throw new Error(`Electron 启动后立即退出（code=${child.exitCode}）：通常是单实例锁被占用，请先关掉正在运行的应用。`)
    }
  }
  if (!target) throw new Error('45s 内未发现主窗口调试目标（单实例锁？）')

  const cdp = await rawConnect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  const results = []
  for (let i = 1; i <= RUNS; i++) results.push(await runOnce(cdp, i))

  // 多次运行：逐项取中位，再合成一份
  const merged = { ...results[0], results: {} }
  for (const k of Object.keys(results[0].results)) {
    const meds = results.map((r) => r.results[k].median)
    merged.results[k] = {
      median: Number(median(meds).toFixed(4)),
      min: Number(Math.min(...meds).toFixed(4)),
      max: Number(Math.max(...meds).toFixed(4)),
      samples: meds,
      detail: results[0].results[k].samples,
    }
  }

  console.log(`\n---- ${VUE_LABEL} 单项结果 ----`)
  printOne(merged)
  console.log(`残留节点：${merged.residualNodes}（应为 0，否则 mount/unmount 有泄漏，后续项会变慢）`)

  mkdirSync(OUT_DIR, { recursive: true })
  // 生产口径单独一份文件：dev 与 prod 的绝对耗时不可混比（dev 版运行时带全部断言）
  const suffix = PROD ? '-prod' : ''
  const file = path.join(OUT_DIR, `bench-${VUE}${suffix}.json`)
  writeFileSync(file, JSON.stringify({ ...merged, runs: RUNS, generatedAt: new Date().toISOString() }, null, 2), 'utf8')
  console.log(`[bench] 已落盘：${path.relative(ROOT, file)}`)

  // 三个通道任意两份凑齐就能对比；凑不齐时提示缺哪条
  const others = ['35', '36', '36v'].filter((k) => k !== VUE)
  const found = others.filter((k) => existsSync(path.join(OUT_DIR, `bench-${k}${suffix}.json`)))
  for (const k of found) {
    compare(JSON.parse(readFileSync(path.join(OUT_DIR, `bench-${k}${suffix}.json`), 'utf8')), merged)
  }
  if (!found.length) {
    console.log('\n（其它通道还没有结果，跑完会在这里自动出对比：')
    console.log('   3.5 VDOM      node testjs/probe/vapor-bench.mjs')
    console.log('   3.6 Vapor     node testjs/probe/vapor-bench.mjs --vue36')
    console.log('   3.6 VDOM      node testjs/probe/vapor-bench.mjs --vue36 --vdom）')
  }

  cdp.close()
  if (child) child.kill()
  stopVite()
  process.exit(0)
}

process.on('SIGINT', () => { stopVite(); process.exit(0) })
process.on('exit', stopVite)
main().catch((err) => {
  console.error('[bench] 失败：' + err.message)
  stopVite()
  process.exit(1)
})
