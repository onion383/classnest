// 验证「加了 ETag 之后，Chromium 到底会不会真的发条件请求、并复用已下载的图」。
//
// 冒烟测试（testjs/smoke/album-file-etag-test.cjs）只证明服务端语义对；服务端对 ≠ 前端受益。
// 但缓存有两层，必须先分清，否则测出来的结论是错的：
//   · 渲染进程内存缓存（MemoryCache）：同一个页面内重复请求同一个 URL，直接命中，**一个字节都不发**。
//     所以「关掉查看器再打开同一张」本来就不慢，ETag 在这条路径上根本用不上。
//   · 磁盘缓存（HTTP cache）：换页面 / 换窗口 / 进程重启 / 内存缓存被挤掉之后才轮到它，
//     这时 no-cache 会强制再验证 —— 有没有 ETag 决定了是「回传 3.38MB」还是「回 304」。
//
// 本探针跑两段，把两层分开量：
//   段 A：同一页面连续加载两次同一 URL → 期望第二次 0 请求（证明内存缓存，与 ETag 无关）
//   段 B：新窗口加载同一 URL（模拟内存缓存失效）→ 期望带 If-None-Match、服务端回 304
//
// 跑法：env -u ELECTRON_RUN_AS_NODE npx electron testjs/probe/etag-revalidate-probe.cjs
//   样本图由 _sample-big.cjs 按需生成（4032x3024），首次运行会等几秒。

const { app, BrowserWindow } = require('electron')
const http = require('http')
const path = require('path')
const fs = require('fs')

app.on('window-all-closed', () => { /* 保持进程活着，等探针跑完 */ })

const { BIG: SRC, ensureSampleImages } = require('./_sample-big')

// 记下服务端收到的每一次图片请求
const hits = []

function pageHtml(times) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#111">
<script>
  // 每次都用新的 Image 元素，避免命中「同一个 img 元素」这种更浅的复用
  window.__r = { times: [], ok: false }
  const load = () => new Promise((resolve) => {
    const t = performance.now()
    const im = new Image()
    im.onload = () => resolve(Math.round(performance.now() - t))
    im.onerror = () => resolve(-1)
    im.src = '/img'
    document.body.appendChild(im)
  })
  ;(async () => {
    const r = window.__r
    for (let i = 0; i < ${times}; i++) r.times.push(await load())
    r.ok = true
  })()
</script></body></html>`
}

function startServer() {
  const img = fs.readFileSync(SRC)
  // 与 album.js 同款指纹：size + mtime，16 进制
  const etag = `"${img.length.toString(16)}-${Math.round(fs.statSync(SRC).mtimeMs).toString(16)}"`

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0]
    if (url === '/page') {
      const times = Number((req.url.split('times=')[1] || '1').split('&')[0])
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(pageHtml(times))
    }
    if (url === '/img') {
      const ine = req.headers['if-none-match'] || ''
      const matched = ine.split(',').some((t) => t.trim() === etag)
      hits.push({ ifNoneMatch: ine, matched })
      if (matched) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
        return res.end()
      }
      // 与 album.js 同款头；本探针不实现 Range，只看缓存再验证
      res.writeHead(200, {
        'Content-Length': img.length,
        'Content-Type': 'image/jpeg',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        ETag: etag,
      })
      return res.end(img)
    }
    res.writeHead(404).end()
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, etag }))
  })
}

function waitFor(win, ms) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = async () => {
      try {
        const r = await win.webContents.executeJavaScript('window.__r || null')
        if (r && r.ok) return resolve(r)
      } catch { /* 页面还没就绪 */ }
      if (Date.now() - started > ms) return reject(new Error('超时'))
      setTimeout(tick, 60)
    }
    tick()
  })
}

async function runPage(url, times) {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true, // 隐藏窗口会被节流，测耗时必须真可见
    webPreferences: { backgroundThrottling: false },
  })
  try {
    await win.loadURL(`${url}?times=${times}`)
    return await waitFor(win, 20000)
  } finally {
    win.destroy()
  }
}

app.whenReady().then(async () => {
  await ensureSampleImages()

  const { server, port, etag } = await startServer()
  const base = `http://127.0.0.1:${port}/page`
  console.log(`样本图：4032x3024 / ${(fs.statSync(SRC).size / 1048576).toFixed(2)}MB`)
  console.log(`服务端 ETag：${etag}\n`)

  let a = null
  let b = null
  const hitsAfterA = []
  try {
    // ---------- 段 A：同页两次 ----------
    a = await runPage(base, 2)
    hitsAfterA.push(...hits)
    console.log(`段 A（同一页面连续两次）：第 1 次 ${a.times[0]}ms，第 2 次 ${a.times[1]}ms`)
    console.log(`  服务端收到 ${hitsAfterA.length} 次请求 ← 两次加载只发一次，第二次是渲染进程内存缓存`)

    // 磁盘缓存是异步落盘的，稍等一下再开新窗口，否则会读到「还没写完」的状态
    await new Promise((r) => setTimeout(r, 600))

    // ---------- 段 B：新窗口（内存缓存失效，只能靠磁盘缓存 + 再验证）----------
    hits.length = 0
    b = await runPage(base, 1)
    console.log(`\n段 B（新窗口，模拟内存缓存被挤掉）：${b.times[0]}ms`)
    hits.forEach((h) => {
      console.log(`  If-None-Match=${h.ifNoneMatch || '(无)'} → ${h.matched ? '304' : '200 全量'}`)
    })
  } catch (e) {
    console.error('执行失败：', e.message)
  } finally {
    server.close()
  }

  let pass = 0
  const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
    if (ok) pass++
  }
  console.log('')
  // 段 A 第二次是 0ms（同一帧内命中内存缓存），所以用 >= 0 而不是 > 0
  check('段 A 两次加载都成功显示', !!(a && a.times[0] > 0 && a.times[1] >= 0), a && `times=${a.times.join(',')}`)
  check('段 A 只发了 1 次请求（内存缓存直接命中，ETag 未参与）', hitsAfterA.length === 1, `实际 ${hitsAfterA.length} 次`)
  check('段 B 发了请求（内存缓存已失效）', hits.length >= 1, `实际 ${hits.length} 次`)
  check('段 B 带上了 If-None-Match', !!(hits[0] && hits[0].ifNoneMatch), hits[0] && hits[0].ifNoneMatch)
  check('段 B 命中 ETag → 服务端回 304', !!(hits[0] && hits[0].matched))
  check('段 B 图片仍正常显示（304 后浏览器用磁盘副本）', !!(b && b.times[0] > 0), b && `${b.times[0]}ms`)

  console.log(`\n结果：${pass}/6`)
  app.exit(pass === 6 ? 0 : 1)
})
