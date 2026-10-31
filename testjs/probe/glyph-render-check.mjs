// 一次性校验：lucide → IconGlyph 收口后，两个图标主题下的渲染是否都符合预期。
//   断言 1（color 档）：导航图标是 SVG；侧边栏折叠按钮是 SVG。
//   断言 2（emoji 档）：导航图标变 emoji（span.icon-emoji，无 svg）；
//                      而 glyph 标记过的折叠按钮**仍然是 SVG**（这是本次改造的关键）
// 跑完会把 app-icon-style 恢复成原值，不留副作用。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FRONTEND = path.join(ROOT, 'student-frontend')
const BASE = 'http://127.0.0.1:5173'
const CDP = '127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class C {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map() }
  _on(d) {
    const m = JSON.parse(d)
    if (m.id && this.p.has(m.id)) { const { ok, no } = this.p.get(m.id); this.p.delete(m.id); ok ? ok(m.result) : no(new Error(m.error?.message)) }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((ok, no) => {
      this.p.set(id, { ok, no })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); no(new Error(method + ' 超时')) } }, 20000)
    })
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

async function connect() {
  const t = await (await fetch(`http://${CDP}/json/list`)).json()
  const page = t.find((x) => x.type === 'page' && String(x.url).startsWith(BASE) && !String(x.url).includes('.html'))
  if (!page) throw new Error('找不到主页面目标')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('ws 连接失败')) })
  const c = new C(ws)
  ws.onmessage = (e) => c._on(e.data)
  return c
}

async function viteUp() {
  try { const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(1500) }); return r.ok } catch { return false }
}

let vite = null, electron = null
async function main() {
  if (!(await viteUp())) {
    vite = spawn(process.execPath, [path.join(FRONTEND, 'dev-vite.js')], { cwd: FRONTEND, stdio: 'ignore', detached: process.platform !== 'win32' })
    for (let i = 0; i < 60 && !(await viteUp()); i++) await sleep(500)
    if (!(await viteUp())) throw new Error('Vite 未就绪')
  }

  const env = { ...process.env, INP_DEBUG: '1', FORCE_SETUP: '0' }
  delete env.ELECTRON_RUN_AS_NODE   // 有它会退化成纯 node，app 变 undefined
  electron = spawn(require('electron'), ['.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  // 主进程的输出必须收集：「连不上 CDP」时唯一能看出原因的地方就是它
  const out = []
  electron.stdout.on('data', (d) => out.push(String(d)))
  electron.stderr.on('data', (d) => out.push(String(d)))
  electron.on('exit', (code) => { out.push(`[electron exit ${code}]`) })

  let c = null
  for (let i = 0; i < 40; i++) {
    try { c = await connect(); break } catch { await sleep(1000) }
  }
  if (!c) {
    console.error('Electron 输出：\n' + out.join('').split('\n').slice(0, 25).join('\n'))
    throw new Error('连不上 CDP')
  }

  await sleep(6000) // 等首屏渲染

  const snapshot = `(() => {
    const nav = document.querySelectorAll('.nav-item')
    const navSvg = document.querySelectorAll('.nav-item svg').length
    const navEmoji = document.querySelectorAll('.nav-item .nav-emoji').length
    const btn = document.querySelector('button[title="折叠侧边栏"]')
    const btnSvg = btn ? btn.querySelectorAll('svg').length : -1
    const style = localStorage.getItem('app-icon-style') || 'color'
    return { style, nav: nav.length, navSvg, navEmoji, btnSvg }
  })()`

  const orig = await c.eval(`localStorage.getItem('app-icon-style')`)
  // 必须显式先置成 color 再 reload：否则上一轮失败留下的 emoji 状态会让「color 档」判据失真
  await c.eval(`localStorage.setItem('app-icon-style','color')`)
  await c.send('Page.enable')
  await c.send('Page.reload', { ignoreCache: false })
  await sleep(9000)
  c.close()
  c = await connect()
  await sleep(1500)
  const color = await c.eval(snapshot)
  console.log('【color 档】', JSON.stringify(color))

  // 切 emoji 档并要求整页重挂载
  await c.eval(`localStorage.setItem('app-icon-style','emoji')`)
  await c.send('Page.enable')
  await c.send('Page.reload', { ignoreCache: false })
  await sleep(9000)
  c.close()
  c = await connect()
  await sleep(2000)
  const emoji = await c.eval(snapshot)
  console.log('【emoji 档】', JSON.stringify(emoji))

  // 恢复
  if (orig === null) await c.eval(`localStorage.removeItem('app-icon-style')`)
  else await c.eval(`localStorage.setItem('app-icon-style', ${JSON.stringify(orig)})`)
  c.close()

  const fail = []
  if (!(color.nav > 0 && color.navSvg >= color.nav)) fail.push('color 档导航图标不是全 SVG')
  if (color.btnSvg < 1) fail.push('color 档折叠按钮没有 SVG')
  if (!(emoji.navEmoji >= emoji.nav)) fail.push('emoji 档导航图标没有变成表情')
  if (emoji.navSvg !== 0) fail.push(`emoji 档导航里还残留 ${emoji.navSvg} 个 svg`)
  if (emoji.btnSvg < 1) fail.push('emoji 档折叠按钮丢了 SVG（glyph 未生效）')

  console.log(fail.length ? '\n❌ 失败：\n  ' + fail.join('\n  ') : '\n✅ 两项断言全通过')
  process.exitCode = fail.length ? 1 : 0
}

main().catch((e) => { console.error('出错:', e.message); process.exitCode = 1 }).finally(async () => {
  await sleep(300)
  try { if (electron) process.platform === 'win32' ? spawn('taskkill', ['/pid', String(electron.pid), '/T', '/F'], { stdio: 'ignore' }) : electron.kill() } catch {}
  try { if (vite) process.platform === 'win32' ? spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }) : process.kill(-vite.pid) } catch {}
})
