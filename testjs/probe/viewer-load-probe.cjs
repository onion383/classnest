// 量「点开一张照片到它能看见」的端到端耗时，走真实接口而不是 file://。
//
// 上一支探针（viewer-open-probe）已经排除了 backdrop-filter 和遮罩合成本身
// （glass 与深色都是 ~16ms），所以这里专门测图片这一段：
//   HTTP 往返 → 传输 → JPEG 解码 → 首次绘制
// 并对比「先显示已缓存的缩略图」能把用户看到的空白缩短到多少。
//
// 跑法：env -u ELECTRON_RUN_AS_NODE npx electron testjs/probe/viewer-load-probe.cjs

const { app, BrowserWindow } = require('electron')
const path = require('path')
// 关服务要强制断开存量 keep-alive 连接，否则事件循环仍有活 handle → 脚本永不退出
const { closeServer } = require('../tools/closeServer.cjs')
const fs = require('fs')
const os = require('os')
const { makeTempDir, removeDirWithRetry } = require('../smoke/_tmpdir.cjs')

const BACKEND = path.join(__dirname, '..', '..', 'student-backend')
const BACKEND_MODULES = path.join(BACKEND, 'node_modules')

// 隔离环境：必须早于 require dbManager（它在加载时校验主密钥）
const DATA_DIR = makeTempDir('banji-viewer-load-')
process.env.DB_MASTER_KEY = 'viewer-load-probe-master-key'
process.env.DATA_DIR = DATA_DIR
process.env.ALBUM_THUMBS_DIR = path.join(DATA_DIR, 'album-thumbs')

const express = require(path.join(BACKEND_MODULES, 'express'))
const sharp = require(path.join(BACKEND_MODULES, 'sharp'))
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const albumRouter = require(path.join(BACKEND, 'routes', 'album'))

const USERNAME = 'viewer-load-probe'
const { slug } = dbManager.createTeacher(USERNAME, 'not-a-real-hash', 'teacher')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 造一张体积接近手机原图的 JPEG。纯色图会被压到几十 KB，解码几乎不耗时，
// 测不出真实体感，所以填一层伪噪声。
async function makeImages() {
  const W = 4032
  const H = 3024
  const raw = Buffer.allocUnsafe(W * H * 3)
  for (let i = 0, p = 0; i < raw.length; i += 3, p++) {
    const x = p % W
    const y = (p / W) | 0
    const n = ((x * 7919 + y * 104729) % 89) | 0
    const base = ((x * 255 / W) | 0) + (((y * 255 / H) | 0) >> 1)
    raw[i] = Math.min(255, base + n)
    raw[i + 1] = Math.min(255, base + ((n * 3) % 61))
    raw[i + 2] = Math.min(255, base + ((n * 7) % 43))
  }
  const big = path.join(DATA_DIR, 'big.jpg')
  await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 90 }).toFile(big)

  // 缩略图走真实接口生成，尺寸与 albumThumbs 的默认档一致
  const thumb = path.join(DATA_DIR, 'album-thumbs', '1.jpg')
  fs.mkdirSync(path.dirname(thumb), { recursive: true })
  await sharp(big).resize(600, 450, { fit: 'inside' }).jpeg({ quality: 78 }).toFile(thumb)
  return { big, thumb }
}

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#111}
  #pic{max-width:100%;max-height:100%;display:block;margin:auto}
  .wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px}
</style></head><body><div class="wrap"><img id="pic"></div>
<script>
// 测一次完整的「设 src → onload → decode → 画进一帧」
window.__load = async function (url, useCache) {
  const img = document.getElementById('pic')
  img.removeAttribute('src')
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  if (!useCache) {
    // 清掉 Resource Timing 里的旧记录，避免命中缓存时读到上一次的条目
    performance.clearResourceTimings()
  }
  const t0 = performance.now()
  img.src = url
  await new Promise((resolve) => {
    if (img.complete && img.naturalWidth > 0) return resolve()
    img.onload = () => resolve()
    img.onerror = () => resolve()
  })
  const tLoad = performance.now() - t0
  let tDecode = 0
  try {
    const t1 = performance.now()
    await img.decode()
    tDecode = performance.now() - t1
  } catch (_) { /* decode 不可用/已解码完 */ }
  // 强制等到下一帧真正画出来
  const t2 = performance.now()
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  const tPaint = performance.now() - t2

  const e = performance.getEntriesByName(url)[0] || {}
  return {
    loadMs: Math.round(tLoad),
    decodeMs: Math.round(tDecode),
    paintMs: Math.round(tPaint),
    totalMs: Math.round(performance.now() - t0),
    nat: img.naturalWidth + 'x' + img.naturalHeight,
    // Resource Timing 拆解
    ttfb: e.responseStart !== undefined ? Math.round(e.responseStart - e.startTime) : null,
    transfer: e.transferSize || null,
    encoded: e.encodedBodySize || null,
    resDur: e.duration !== undefined ? Math.round(e.duration) : null
  }
}
</script></body></html>`

app.whenReady().then(async () => {
  const log = (s) => console.log(s)
  const imgs = await makeImages()
  const bigMB = (fs.statSync(imgs.big).size / 1024 / 1024).toFixed(2)
  const thumbKB = (fs.statSync(imgs.thumb).size / 1024).toFixed(0)

  dbManager.withDb(slug, () => {
    const conn = dbManager.current()
    conn.prepare('INSERT INTO albums (id, name, folder_path, kind) VALUES (?, ?, ?, ?)')
      .run(1, '探针相册', DATA_DIR, 'virtual')
    conn.prepare('INSERT INTO album_photos (id, album_id, file_path, file_name, file_size) VALUES (?, ?, ?, ?, ?)')
      .run(1, 1, imgs.big, 'big.jpg', fs.statSync(imgs.big).size)
  })

  const web = express()
  const bind = (req, res, next) => {
    req.user = { username: USERNAME, role: 'teacher', dbSlug: slug }
    dbManager.withDb(slug, () => next())
  }
  web.get('/probe.html', (req, res) => res.type('html').send(HTML))
  web.use('/api/album', bind, albumRouter)
  const server = await new Promise((resolve) => {
    const s = web.listen(0, '127.0.0.1', () => resolve(s))
  })
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  const win = new BrowserWindow({ width: 1200, height: 800, show: true })
  await win.loadURL(base + '/probe.html')
  await wait(400)

  const FILE_URL = `${base}/api/album/photo/1/file`
  const THUMB_URL = `${base}/api/album/photo/1/thumb`

  log('')
  log('=== 样本 ===')
  log(`原图   : ${bigMB} MB  4032x3024`)
  log(`缩略图 : ${thumbKB} KB  600x450（后端按需生成，浏览器会缓存）`)

  const meas = async (url, label) => {
    const runs = []
    for (let i = 0; i < 4; i++) {
      runs.push(await win.webContents.executeJavaScript(`window.__load(${JSON.stringify(url)})`))
      await wait(120)
    }
    runs.sort((a, b) => a.totalMs - b.totalMs)
    const m = runs[0] // 取最快的一次=热路径，代表"已经用起来之后"的常态
    const first = runs[runs.length - 1] // 最慢=冷启动/争用时的上限
    log(`${label.padEnd(22)} 快 ${String(m.totalMs).padStart(4)}ms (load ${String(m.loadMs).padStart(3)} + decode ${String(m.decodeMs).padStart(3)} + paint ${String(m.paintMs).padStart(3)})  慢 ${first.totalMs}ms  ttfb ${m.ttfb}ms  transfer ${m.transfer}B  ${m.nat}`)
    return { fast: m, slow: first }
  }

  log('')
  log('=== A) 直接加载原图（现状）===')
  const big = await meas(FILE_URL, '原图 /file')
  log('')
  log('=== B) 缩略图（可预先拿到）===')
  const thumb = await meas(THUMB_URL, '缩略图 /thumb')

  // 模拟"先缩略图再换原图"：用户看到画面需要多久
  const both = await win.webContents.executeJavaScript(`(async () => {
    const img = document.getElementById('pic')
    const t0 = performance.now()
    img.src = ${JSON.stringify(THUMB_URL)}
    await new Promise(r => { if (img.complete) return r(); img.onload = r })
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    const thumbVisible = performance.now() - t0
    return { thumbVisible: Math.round(thumbVisible) }
  })()`)

  log('')
  log('=== 结论 ===')
  log(`直接上原图，到图可见：快 ${big.fast.totalMs}ms / 慢 ${big.slow.totalMs}ms`)
  log(`先上缩略图，到图可见：约 ${both.thumbVisible}ms（缩略图小且已被网格缓存）`)
  log(`两者差值 = 用户能直接感知的那段空白：约 ${big.fast.totalMs - both.thumbVisible}~${big.slow.totalMs - both.thumbVisible}ms`)

  // ---------------------------------------------------------------------------
  // C) 悬浮预取可行性：先 fetch 把字节拉进缓存，随后 img.src 能否命中？
  //    决定性变量是 /file 返回的 Cache-Control: no-cache（允许存，但用前必须验证）。
  //    若 fetch 后 img 仍走完整请求，那"悬浮预取"就是白花带宽 —— 必须先确认。
  // ---------------------------------------------------------------------------
  log('')
  log('=== C) 预取可行性：fetch 之后再 img.src ===')
  const ses = win.webContents.session
  await ses.clearCache()
  await wait(200)
  const cold = await win.webContents.executeJavaScript(`window.__load(${JSON.stringify(FILE_URL)})`)
  log(`① 清缓存后直接加载（冷启动基准）    : ${cold.totalMs}ms`)

  await ses.clearCache()
  await wait(200)
  const prefetched = await win.webContents.executeJavaScript(`(async () => {
    const url = ${JSON.stringify(FILE_URL)}
    const t0 = performance.now()
    // 只下载字节，不解码成位图
    const resp = await fetch(url, { cache: 'default' })
    await resp.blob()
    const fetchMs = Math.round(performance.now() - t0)
    const r = await window.__load(url)
    return { fetchMs, loadTotal: r.totalMs, nat: r.nat }
  })()`)
  log(`② 先 fetch(${prefetched.fetchMs}ms) 再 img.src : ${prefetched.loadTotal}ms  ${prefetched.nat}`)
  const hit = prefetched.loadTotal < cold.totalMs * 0.6
  log(hit
    ? `   → 命中：预取确实省掉了传输/读盘，只剩解码（${prefetched.loadTotal}ms vs 冷 ${cold.totalMs}ms）`
    : `   → 未命中：no-cache 让 img 重新走了完整请求，预取白花带宽（${prefetched.loadTotal}ms ≈ 冷 ${cold.totalMs}ms）`)

  // 补一个对照：同样文件加上 max-age 的响应头会怎样（判断"改后端缓存头"这条路是否值得）
  const cachedUrl = `${base}/api/album/photo/1/file`
  const recount = await win.webContents.executeJavaScript(`(async () => {
    const url = ${JSON.stringify(cachedUrl)}
    await fetch(url).then(r => r.blob())
    const r1 = await window.__load(url)
    const r2 = await window.__load(url)
    return { first: r1.totalMs, second: r2.totalMs }
  })()`)
  log(`③ 同 session 内连续两次加载同一原图     : 第一次 ${recount.first}ms，第二次 ${recount.second}ms`)
  log('   → 第二次变快说明 Chromium 的内存缓存对 no-cache 依然生效；')
  log('     这决定了"预取"只有在本页面存活期间才有效，重启后仍要重新读盘。')

  // ---------------------------------------------------------------------------
  // D) 换一种预取方式：new Image() 预热（走图片资源加载，而不是 fetch）
  //    Chromium 会把解码后的位图放进渲染进程的 image cache，img.src 直接复用。
  //    代价：每张 ~4032*3024*4 ≈ 48MB 位图常驻。
  // ---------------------------------------------------------------------------
  log('')
  log('=== D) new Image() 预热的实际效果 ===')
  // 关键：必须用从未加载过的 URL，否则 memory cache 里已有副本，"冷"和"热"都会被污染。
  // 真实场景里每张照片的 URL（id 不同）本来就是新的，用随机 query 模拟这一点。
  const coldNew = await win.webContents.executeJavaScript(`(async () => {
    const url = ${JSON.stringify(FILE_URL)} + '?probe=c' + Math.random()
    const r = await window.__load(url)
    return r.totalMs
  })()`)
  const warmNew = await win.webContents.executeJavaScript(`(async () => {
    const url = ${JSON.stringify(FILE_URL)} + '?probe=w' + Math.random()
    const t0 = performance.now()
    const pre = new Image()
    pre.src = url
    await pre.decode()
    const warmMs = Math.round(performance.now() - t0)
    const r = await window.__load(url)
    return { warmMs, loadTotal: r.totalMs, nat: pre.naturalWidth + 'x' + pre.naturalHeight,
             bytes: pre.naturalWidth * pre.naturalHeight * 4 }
  })()`)
  log(`对照：全新 URL 直接加载（= 首次点开一张没看过的照片） : ${coldNew}ms`)
  log(`预热 ${warmNew.warmMs}ms 后，img.src 到可见                     : ${warmNew.loadTotal}ms（${warmNew.nat}，位图约 ${(warmNew.bytes / 1024 / 1024).toFixed(0)}MB）`)
  log(warmNew.loadTotal < coldNew * 0.6
    ? `   → 有效：预热点开省 ${coldNew - warmNew.loadTotal}ms，代价是每张约 ${(warmNew.bytes / 1024 / 1024).toFixed(0)}MB 解码位图常驻`
    : `   → 效果有限（省 ${coldNew - warmNew.loadTotal}ms），不值得为此吃 ${(warmNew.bytes / 1024 / 1024).toFixed(0)}MB 内存`)
  log('')
  log('注：本地回环 + 本机磁盘，真实环境（机械盘、大图、杀软扫描）只会更慢。')

  await closeServer(server)
  win.destroy()
  // 临时目录要删：这个探针此前从不清理，每跑一次在系统 temp 留一个（实测已积 6 个）。
  // Electron 里 sqlite 句柄同样在进程内开着，删不掉就靠重试 + 明确告警，不再无声无息。
  await removeDirWithRetry(DATA_DIR)
  app.exit(0)
})
