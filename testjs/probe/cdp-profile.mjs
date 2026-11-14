// 渲染层启动 CPU 采样（CDP Profiler）
//
// 用途：被打点归因剩下的时间（例如「挂载完成 → 占位页移除」那约 100ms）已经拆不出归属了，
// 只知道主线程被占住、`setTimeout(0)` 要等 90ms 才跑。要再往下走只能看真实调用栈，
// 这里用 Chrome DevTools Protocol 的 Profiler 采一次，按「自身耗时」聚合出热点函数。
//
// 做法：给打包版加 --remote-debugging-port，连上后开 Profiler（默认 200µs 采样），
// 然后 Page.reload 重放一次首屏（重载 = 重新执行入口 JS 并重新挂载，主线程工作量同构），
// 等若干毫秒后 Profiler.stop，落盘 .cpuprofile 并打印 top 函数。
//
// 口径提醒：reload 是「热」启动（后端已就绪、磁盘缓存热），所以握手/等后端的耗时不可比；
// 这里只看渲染层主线程的 JS 工作量分布，不看整轮启动总耗时。要整轮数据请用 measure-startup.mjs。
//
// 用法：
//   node testjs/probe/cdp-profile.mjs                       # 用 release/win-unpacked 的副本
//   node testjs/probe/cdp-profile.mjs --exe=<path> --real   # 指定 exe / 用真实 userData
//   node testjs/probe/cdp-profile.mjs --wait=3000 --json    # 采样窗口 / 只输出 json 路径

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const TMP = join(ROOT, 'testjs/tmp')
const PORT = 9222

const opt = { exe: '', real: false, wait: 2500, cwd: '', onlyJson: false }
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--exe=')) opt.exe = a.slice(6)
  else if (a === '--real') opt.real = true
  else if (a.startsWith('--wait=')) opt.wait = Number(a.slice(7)) || 2500
  else if (a.startsWith('--cwd=')) opt.cwd = a.slice(6)
  else if (a === '--json') opt.onlyJson = true
  else if (a === '--help' || a === '-h') {
    console.log('用法: node testjs/probe/cdp-profile.mjs [--exe=<path>] [--real] [--wait=2500] [--cwd=<dir>] [--json]')
    process.exit(0)
  }
}

function findExe() {
  if (opt.exe) return resolve(opt.exe)
  const local = join(process.env.LOCALAPPDATA || '', 'ClassNestMeasurePkg', 'ClassNest.exe')
  if (existsSync(local)) return local
  const dev = join(ROOT, 'release/win-unpacked/ClassNest.exe')
  if (existsSync(dev)) return dev
  return ''
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 找到渲染进程的 page target（app://local 那个）
async function findPageTarget(deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find(
        (t) => t.type === 'page' && !String(t.url).startsWith('devtools://'),
      )
      if (page && page.webSocketDebuggerUrl) return page
    } catch (_) { /* 还没起来，继续等 */ }
    await sleep(120)
  }
  return null
}

// 极简 CDP 客户端：一连接就按 id 派发响应，事件走 onEvent
function connect(url) {
  return new Promise((resolveFn, rejectFn) => {
    const ws = new WebSocket(url)
    let seq = 0
    const pending = new Map()
    const events = []
    ws.addEventListener('open', () => {
      resolveFn({
        send(method, params = {}) {
          const id = ++seq
          ws.send(JSON.stringify({ id, method, params }))
          return new Promise((res, rej) => {
            pending.set(id, { res, rej })
            setTimeout(() => {
              if (pending.has(id)) { pending.delete(id); rej(new Error(`CDP 超时: ${method}`)) }
            }, 15000)
          })
        },
        events,
        close() { try { ws.close() } catch (_) { /* 忽略 */ } },
      })
    })
    ws.addEventListener('error', () => rejectFn(new Error('CDP 连接失败')))
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch (_) { return }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message || 'CDP 错误'))
        else res(msg.result)
      } else if (msg.method) {
        events.push(msg)
      }
    })
  })
}

// 把 samples/timeDeltas 聚合成「按函数自身耗时」的排名
function aggregate(profile, topN = 25) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map()
  let total = 0
  const samples = profile.samples || []
  const deltas = profile.timeDeltas || []
  for (let i = 0; i < samples.length; i++) {
    const us = deltas[i] || 0
    // 采样间隔异常值（暂停/回收）不计入
    if (us <= 0 || us > 200000) continue
    total += us
    const node = nodes.get(samples[i])
    if (!node) continue
    const cf = node.callFrame || {}
    const url = String(cf.url || '').replace(/^app:\/\/local\//, '').replace(/\?.*$/, '')
    const name = cf.functionName || '(anonymous)'
    const key = `${name} @ ${url || '(native)'}:${(cf.lineNumber ?? 0) + 1}`
    self.set(key, (self.get(key) || 0) + us)
  }
  const rows = [...self.entries()]
    .map(([key, us]) => ({ key, ms: us / 1000 }))
    .sort((a, b) => b.ms - a.ms)
  return { totalMs: total / 1000, rows: rows.slice(0, topN) }
}

async function main() {
  const exe = findExe()
  if (!exe) {
    console.error('未找到 ClassNest.exe：请用 --exe=<path> 指定')
    process.exit(1)
  }
  const cwd = opt.cwd ? resolve(opt.cwd) : dirname(exe)
  if (cwd.startsWith(ROOT)) {
    console.error(`拒绝从仓库目录启动（会被安全软件/文件锁干扰）：${cwd}`)
    process.exit(1)
  }
  mkdirSync(TMP, { recursive: true })

  const args = [`--remote-debugging-port=${PORT}`]
  if (!opt.real) args.push(`--user-data-dir=${join(process.env.LOCALAPPDATA || TMP, 'ClassNestProfileUserData')}`)

  // ELECTRON_RUN_AS_NODE 会让 Electron 退化成纯 Node（不建窗、无渲染进程），必须剥掉
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS

  console.log(`启动：${exe}`)
  console.log(`cwd：${cwd}`)
  const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: 'ignore' })
  let exited = false
  child.on('exit', () => { exited = true })

  try {
    const target = await findPageTarget(Date.now() + 30000)
    if (!target) throw new Error('30s 内没找到渲染进程（--remote-debugging-port 没生效？）')
    console.log(`已连接：${target.url}`)

    const cdp = await connect(target.webSocketDebuggerUrl)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
    // 重放一次首屏：清缓存重载，重新执行入口 JS 并重新挂载
    await cdp.send('Profiler.start')
    await cdp.send('Page.enable')
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(opt.wait)
    const { profile } = await cdp.send('Profiler.stop')
    cdp.close()

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const out = join(TMP, `cpuprofile-${stamp}.json`)
    writeFileSync(out, JSON.stringify(profile))
    const { totalMs, rows } = aggregate(profile, 25)

    if (opt.onlyJson) {
      console.log(out)
    } else {
      console.log(`\n采样窗口内 JS 执行合计约 ${totalMs.toFixed(0)}ms（self time 口径）`)
      console.log(`原始采样：${out}\n`)
      console.log('自身耗时 top 25：')
      for (const r of rows) console.log(`  ${r.ms.toFixed(1).padStart(7)}ms  ${r.key}`)
    }
  } finally {
    if (!exited) {
      try { child.kill() } catch (_) { /* 忽略 */ }
      // Windows 上子进程树可能还在，交给调用方 taskkill 兜底
    }
  }
}

main().catch((e) => {
  console.error(`失败：${e.message}`)
  process.exit(1)
})
