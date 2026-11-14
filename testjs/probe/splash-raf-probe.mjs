// =========================================================================
// splash-raf-probe.mjs —— 验证「rAF 被暂停时占位页仍能被移除」
//
// 背景（2026-11-14 两次实测）：页面处于 hidden 时 Chromium 会暂停 rAF。
// 同一时刻注册的 setTimeout(0) 在 +509ms 正常执行，rAF 回调却拖到 +1488ms。
// 占位页移除原本只挂在 rAF 上 → 开机自启 / 最小化到托盘启动时，占位页会一直
// 挂到窗口真正可见，用户恢复窗口先看到的是占位页而不是内容。
//
// 本探针不依赖「窗口可见性」这种难以稳定复现的条件，而是用 CDP
// `Page.addScriptToEvaluateOnNewDocument` 在文档创建前把 requestAnimationFrame
// 替换成永不回调 —— 等价于「rAF 被无限期暂停」，且确定性地复现。
//
// 判读：
//   splashStillThere = true  → 占位页移除只依赖 rAF（有缺陷的旧实现）
//   splashStillThere = false → 存在非 rAF 的兜底路径（已修复）
//
// 用法：
//   node testjs/probe/splash-raf-probe.mjs --exe=<exe> --cwd=<dir> [--wait=1500]
//   node testjs/probe/splash-raf-probe.mjs --exe=... --json
// =========================================================================

import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const PORT = 9224
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const opt = { exe: '', cwd: '', wait: 1500, json: false }
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--exe=')) opt.exe = a.slice(6)
  else if (a.startsWith('--cwd=')) opt.cwd = a.slice(6)
  else if (a.startsWith('--wait=')) opt.wait = Number(a.slice(7)) || 1500
  else if (a === '--json') opt.json = true
  else if (a === '--help' || a === '-h') {
    console.log('用法: node testjs/probe/splash-raf-probe.mjs --exe=<path> [--cwd=<dir>] [--wait=1500] [--json]')
    process.exit(0)
  }
}

async function findPageTarget(deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
      if (page && page.webSocketDebuggerUrl) return page
    } catch (_) { /* 还没起来 */ }
    await sleep(120)
  }
  return null
}

function connect(url) {
  return new Promise((resolveFn, rejectFn) => {
    const ws = new WebSocket(url)
    let seq = 0
    const pending = new Map()
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
      }
    })
  })
}

async function main() {
  const exe = resolve(opt.exe)
  if (!existsSync(exe)) {
    console.error(`找不到 exe：${exe}`)
    process.exit(1)
  }
  const cwd = opt.cwd ? resolve(opt.cwd) : dirname(exe)
  if (cwd.startsWith(ROOT)) {
    console.error(`拒绝从仓库目录启动（会被安全软件/文件锁干扰）：${cwd}`)
    process.exit(1)
  }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS

  const child = spawn(exe, [`--remote-debugging-port=${PORT}`], { cwd, env, windowsHide: true, stdio: 'ignore' })
  let exited = false
  child.on('exit', () => { exited = true })

  try {
    const target = await findPageTarget(Date.now() + 30000)
    if (!target) throw new Error('30s 内没找到渲染进程（--remote-debugging-port 没生效？）')

    const cdp = await connect(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')

    // 关键：在文档创建前把 rAF 换成空实现（返回一个假 handle，永不同调）。
    // 这精确复现「页面 hidden → Chromium 暂停 rAF」，且比控制窗口可见性确定得多。
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.requestAnimationFrame = function () { return 0; };
               window.cancelAnimationFrame = function () {};`,
    })

    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(opt.wait)

    const probe = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('.app-splash')
        return JSON.stringify({
          url: location.href,
          splashInDom: !!el,
          splashConnected: el ? el.isConnected : false,
          appHasChildren: !!(document.querySelector('#app') && document.querySelector('#app').children.length),
        })
      })()`,
      returnByValue: true,
    })
    cdp.close()

    let r
    try { r = JSON.parse(probe.result.value) } catch (_) { r = { raw: probe.result.value } }

    const verdict = r.splashInDom
      ? 'FAIL —— 占位页仍在：移除路径只依赖 rAF'
      : 'PASS —— 占位页已移除：存在非 rAF 兜底'

    if (opt.json) {
      console.log(JSON.stringify({ ...r, verdict }, null, 2))
    } else {
      console.log(`页面：${r.url}`)
      console.log(`等待：${opt.wait}ms（rAF 已被替换为永不回调）`)
      console.log(`占位页仍在 DOM：${r.splashInDom}`)
      console.log(`\n${verdict}`)
    }
    process.exitCode = r.splashInDom ? 1 : 0
  } finally {
    if (!exited) {
      try { child.kill() } catch (_) { /* 忽略 */ }
    }
  }
}

main().catch((e) => {
  console.error(`失败：${e.message}`)
  process.exit(1)
})
