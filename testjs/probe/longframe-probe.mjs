// =========================================================================
// longframe-probe.mjs —— 测「顺不顺」：连续帧间隔分布
//
// 为什么需要它：INP 只量单次交互的延迟，且被 ~40ms 帧调度地板淹没，测不出框架差异。
// 用户说的「流畅/卡手」实际是**连续帧是否均匀**（有没有突然掉一帧、间隔波动多大），
// 这个维度只能用 requestAnimationFrame 连续采样相邻帧间隔。
//
// 测两件事（都在相册页，因为 AlbumView 是最重的可迁视图）：
//   1. 连续滚动  —— 每帧 scrollTop 推进，采样帧间隔（反映布局+绘制成本）
//   2. 年份尺拖动 —— 真实鼠标事件驱动，采样帧间隔（反映交互响应下的帧稳定性）
//
// 用法：
//   node testjs/probe/longframe-probe.mjs            # 3.5 通道
//   node testjs/probe/longframe-probe.mjs --vue36    # 3.6 通道（Vapor）
//   node testjs/probe/longframe-probe.mjs --vue36 --vdom   # 3.6 纯 VDOM 对照
//   node testjs/probe/longframe-probe.mjs --rounds=3 --ms=2000
//
// 产出：testjs/tmp/longframe-35.json / longframe-36.json / longframe-36v.json。
// =========================================================================
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// 结束子进程树（Electron / vite 都会再起孙进程，只杀直接子进程会残留）
const { killTree } = require('../tools/killTree.cjs')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FRONTEND = path.join(ROOT, 'student-frontend')
const CDP_PORT = 9222   // 主进程写死（main.js 用 INP_DEBUG=1 开 remote-debugging-port 9222）
const BASE = 'http://127.0.0.1:5173'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const argv = process.argv.slice(2)
const useVue36 = argv.includes('--vue36')
const useVdom = argv.includes('--vdom')   // 仅与 --vue36 同用：3.6 编译器 + 纯 VDOM 运行时
const ROUNDS = Number((argv.find((a) => a.startsWith('--rounds=')) || '').split('=')[1] || 3)
const DUR_MS = Number((argv.find((a) => a.startsWith('--ms=')) || '').split('=')[1] || 2000)
const STRESS = argv.includes('--stress')   // 暴力模式：滚动大跳 + 年份尺全轨道反复来回
const CHANNEL = useVue36 ? (useVdom ? '36v' : '36') : '35'

// ---------------------------------------------------------------- CDP 客户端
class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map() }
  _onMessage(data) {
    const msg = JSON.parse(typeof data === 'string' ? data : data.toString())
    if (!msg.id) return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message))
    else p.resolve(msg.result)
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
  close() { try { this.ws.close() } catch { /* ignore */ } }
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
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { cache: 'no-store' })
    return res.ok ? await res.json() : null
  } catch { return null }
}

async function waitMainTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ts = await listTargets()
    const t = Array.isArray(ts) && ts.find((x) => x.type === 'page' && typeof x.url === 'string'
      && x.url.startsWith(BASE) && !x.url.includes('.html'))
    if (t && t.webSocketDebuggerUrl) return t
    await sleep(300)
  }
  return null
}

async function viteUp() {
  try {
    const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch { return false }
}

// ---------------------------------------------------------------- 统计
function stats(gaps) {
  const v = [...gaps].sort((a, b) => a - b)
  const q = (p) => v[Math.min(v.length - 1, Math.floor(v.length * p))]
  const mean = v.reduce((a, b) => a + b, 0) / v.length
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length)
  return {
    n: v.length,
    p50: +q(0.5).toFixed(2),
    p95: +q(0.95).toFixed(2),
    max: +v[v.length - 1].toFixed(2),
    sd: +sd.toFixed(2),
    over167: v.filter((x) => x > 16.7).length,
    over33: v.filter((x) => x > 33).length,
  }
}

// ---------------------------------------------------------------- 页面内测量
/**
 * 连续滚动：每帧推进 scrollTop，往返避免滚到边界后空转。
 * stress=true 时改为「大跳」——每 6 帧直接甩到另一个百分比位置（跨度可达上百万 px），
 * 强制大规模格子卸载/挂载；平滑滚动只走 0.1% 的高度，压不到重排路径。
 */
const scrollScript = (durMs, stress) => `(async () => {
  const el = document.querySelector('.album-scroll')
  if (!el) throw new Error('找不到 .album-scroll')
  el.scrollTop = 0
  await new Promise(r => requestAnimationFrame(r))
  const gaps = []
  let last = performance.now()
  const t0 = last
  let dir = 1
  const targets = [0, 0.5, 1, 0.25, 0.75, 0.08, 0.92, 0.35, 0.65, 0.15, 0.85]
  let ti = 0, i = 0
  const max = () => Math.max(1, el.scrollHeight - el.clientHeight)
  return await new Promise((res) => {
    function tick(now) {
      gaps.push(now - last); last = now
      if (${stress ? 'true' : 'false'}) {
        if (i % 6 === 0) el.scrollTop = targets[ti++ % targets.length] * max()
      } else {
        el.scrollTop += 36 * dir
        if (el.scrollTop >= el.scrollHeight - el.clientHeight - 1) dir = -1
        else if (el.scrollTop <= 0) dir = 1
      }
      i++
      if (now - t0 < ${durMs}) requestAnimationFrame(tick)
      else res(gaps.slice(2))
    }
    requestAnimationFrame(tick)
  })
})()`

/** 通用：采 durMs 的帧间隔，外部同时用真实鼠标事件驱动交互 */
const sampleScript = (durMs) => `(async () => {
  const gaps = []
  let last = performance.now()
  const t0 = last
  return await new Promise((res) => {
    function tick(now) {
      gaps.push(now - last); last = now
      if (now - t0 < ${durMs}) requestAnimationFrame(tick)
      else res(gaps.slice(2))
    }
    requestAnimationFrame(tick)
  })
})()`

async function dragThumb(cdp, from, to, steps = 30, stepMs = 16) {
  const press = (type, x, y, buttons, clickCount = 1) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount })
  await press('mousePressed', from.x, from.y, 1)
  for (let i = 1; i <= steps; i++) {
    const y = from.y + ((to.y - from.y) * i) / steps
    await press('mouseMoved', from.x, y, 1)
    await sleep(stepMs)
  }
  await press('mouseReleased', to.x, to.y, 0)
}

/** 暴力拖动：按住不放，在整条轨道上来回甩，持续到 durMs 用完 */
async function dragThumbRange(cdp, geo, durMs, stepMs = 14) {
  const press = (type, x, y, buttons) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 })
  const t0 = Date.now()
  await press('mousePressed', geo.x, geo.y, 1)
  let cur = geo.y
  let dir = -1
  let sweeps = 0
  while (Date.now() - t0 < durMs) {
    const to = dir < 0 ? geo.top : geo.bottom
    const steps = 14
    for (let i = 1; i <= steps; i++) {
      const y = cur + ((to - cur) * i) / steps
      await press('mouseMoved', geo.x, y, 1)
      await sleep(stepMs)
      if (Date.now() - t0 >= durMs) break
    }
    cur = to
    dir = -dir
    sweeps++
  }
  await press('mouseReleased', geo.x, cur, 0)
  return sweeps
}

// ---------------------------------------------------------------- 主流程
let viteChild = null
let electronChild = null

async function main() {
  if (!(await viteUp())) {
    console.log(`[lf] 启动 Vite（${CHANNEL} 通道）…`)
    const vueArgs = useVue36 ? (useVdom ? ['--vue36', '--vdom'] : ['--vue36']) : []
    viteChild = spawn(process.execPath, [path.join(FRONTEND, 'dev-vite.js'), ...vueArgs], {
      cwd: FRONTEND, stdio: 'ignore',
    })
    for (let i = 0; i < 60 && !(await viteUp()); i++) await sleep(500)
  } else {
    console.log('[lf] Vite 已在运行（注意：复用旧实例时通道由它自己决定）')
  }

  console.log('[lf] 启动 Electron…')
  const env = { ...process.env, INP_DEBUG: '1', FORCE_SETUP: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  electronChild = spawn(require('electron'), ['.'], { cwd: ROOT, env, stdio: 'ignore' })

  const target = await waitMainTarget(40000)
  if (!target) throw new Error('等不到主窗口的调试目标')
  const cdp = await rawConnect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await sleep(1500)

  // 导航到相册页：按 href 定位（侧边栏折叠时 .nav-label 不渲染，按文案会匹配不到）
  let navWait = 'no-nav'
  for (let i = 0; i < 50; i++) {
    navWait = await cdp.eval(`(() => {
      const byHref = document.querySelector('a.nav-item[href="/album"]')
      if (byHref) { byHref.click(); return 'href' }
      const byText = [...document.querySelectorAll('a.nav-item')]
        .find(e => (e.getAttribute('title') || e.textContent || '').includes('班级相册'))
      if (byText) { byText.click(); return 'text' }
      return document.querySelectorAll('a.nav-item').length ? 'not-found' : 'no-nav'
    })()`)
    if (navWait === 'href' || navWait === 'text') break
    await sleep(300)
  }
  if (navWait !== 'href' && navWait !== 'text') throw new Error(`导航失败（${navWait}）`)

  // 等相册内容（5 万张的首屏会更久，放宽到 30s）
  let ready = false
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    ready = await cdp.eval(`!!document.querySelector('.album-scroll') && !!document.querySelector('.photo-cell')`)
    if (ready) break
  }
  if (!ready) throw new Error('相册页没渲染出照片单元格')
  const geo = await cdp.eval(`(() => {
    const el = document.querySelector('.album-scroll')
    const cells = document.querySelectorAll('.photo-cell').length
    return { cells, scrollH: el.scrollHeight, clientH: el.clientHeight }
  })()`)
  console.log('[lf] 相册页就绪:', JSON.stringify(geo))

  const scrollRounds = []
  const dragRounds = []
  for (let r = 0; r < ROUNDS; r++) {
    scrollRounds.push(stats(await cdp.eval(scrollScript(DUR_MS, STRESS))))
    await sleep(300)

    // 拖动：先起采样，再派发真实鼠标事件
    const thumb = await cdp.eval(`(() => {
      const t = document.querySelector('.album-ruler-thumb')
      if (!t) return null
      const b = t.getBoundingClientRect()
      const tb = t.parentElement.getBoundingClientRect()
      return {
        x: b.left + b.width / 2,
        y: b.top + b.height / 2,
        h: b.height,
        top: tb.top + 4,
        bottom: tb.bottom - 4,
      }
    })()`)
    if (!thumb) throw new Error('找不到 .album-ruler-thumb')
    const sampling = cdp.eval(sampleScript(DUR_MS))   // 不 await，先跑起来
    await sleep(120)
    if (STRESS) {
      const sweeps = await dragThumbRange(cdp, thumb, DUR_MS - 150)
      console.log(`[lf]   本轮全轨道来回 ${sweeps} 趟（轨道 ${Math.round(thumb.top)}→${Math.round(thumb.bottom)}）`)
    } else {
      await dragThumb(cdp, thumb, { x: thumb.x, y: thumb.y + Math.min(160, thumb.h * 0.6) })
    }
    dragRounds.push(stats(await sampling))
    await sleep(300)
    console.log(`[lf] 第 ${r + 1}/${ROUNDS} 轮完成`)
  }

  const med = (key, arr) => {
    const v = arr.map((s) => s[key]).sort((a, b) => a - b)
    return v[Math.floor(v.length / 2)]
  }
  const out = {
    channel: CHANNEL,
    stress: STRESS,
    rounds: ROUNDS,
    durMs: DUR_MS,
    cells: geo.cells,
    scroll: {
      每轮: scrollRounds,
      中位: { p50: med('p50', scrollRounds), p95: med('p95', scrollRounds), max: Math.max(...scrollRounds.map((s) => s.max)), over167: med('over167', scrollRounds), over33: med('over33', scrollRounds), sd: med('sd', scrollRounds) },
    },
    drag: {
      每轮: dragRounds,
      中位: { p50: med('p50', dragRounds), p95: med('p95', dragRounds), max: Math.max(...dragRounds.map((s) => s.max)), over167: med('over167', dragRounds), over33: med('over33', dragRounds), sd: med('sd', dragRounds) },
    },
  }

  fs.mkdirSync(path.join(ROOT, 'testjs', 'tmp'), { recursive: true })
  const file = path.join(ROOT, 'testjs', 'tmp', `longframe-${CHANNEL}${STRESS ? '-stress' : ''}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))

  console.log(`\n================ 长帧测量（${CHANNEL} 通道${STRESS ? ' · 暴力模式' : ''}，${ROUNDS} 轮 × ${DUR_MS}ms）================`)
  console.table([
    { 场景: '连续滚动', p50: out.scroll.中位.p50, p95: out.scroll.中位.p95, 最大: out.scroll.中位.max, '>16.7ms': out.scroll.中位.over167, '>33ms': out.scroll.中位.over33, 标准差: out.scroll.中位.sd },
    { 场景: '年份尺拖动', p50: out.drag.中位.p50, p95: out.drag.中位.p95, 最大: out.drag.中位.max, '>16.7ms': out.drag.中位.over167, '>33ms': out.drag.中位.over33, 标准差: out.drag.中位.sd },
  ])
  console.log(`[lf] 已落盘: testjs/tmp/longframe-${CHANNEL}${STRESS ? '-stress' : ''}.json`)
  cdp.close()
  return 0
}

function cleanup() {
  // 用 killTree 而不是 child.kill()：Electron 与 vite 都会再起孙进程
  // （渲染进程 / GPU 进程 / vite 子进程），只杀直接子进程会**残留**它们
  // → 端口被占（下次跑 EADDRINUSE）+ 进程泄漏。
  if (electronChild) killTree(electronChild)
  if (viteChild) killTree(viteChild)
}

main()
  .then(async (code) => { cleanup(); await sleep(600); process.exit(code) })
  .catch(async (e) => { console.error('[lf] 失败:', e.message); cleanup(); await sleep(400); process.exit(1) })
