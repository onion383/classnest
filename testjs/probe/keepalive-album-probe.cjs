// 量「相册页被 KeepAlive 缓存后再切回，照片要多久才重新出现」。
//
// 现象：大相册里切到别的页面一会儿，切回来要好久才看到照片。
//
// 不是在猜，而是复刻 KeepAlive 的真实行为：Vue 3 的 KeepAlive 在 deactivate 时
// 把组件根 DOM **appendChild 到一个未插入文档的内存 div**，activate 时再插回原位。
// 元素本身没销毁，但脱离文档树 → 浏览器会丢弃解码后的位图、失效布局。
//
// 本探针把这个「移出 → 等一会 → 插回」的动作做一遍，逐帧记录：
//   · 第 1 帧（首帧绘制）距插回多少 ms
//   · 所有 <img> decode() 完成距插回多少 ms（= 画面真正齐了）
//   · 期间最长的一次帧间隔（是不是卡住了主线程）
//
// 变量分离（每个变体单独跑，互不干扰）：
//   A) 容器带 backdrop-filter（相册现在的外层毛玻璃）vs 不带
//   B) 图片数量 30 / 60 / 120
//   C) <img> 的 decoding 属性：async vs sync
//
// 跑法：env -u ELECTRON_RUN_AS_NODE npx electron testjs/probe/keepalive-album-probe.cjs

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

const BACKEND = path.join(__dirname, '..', '..', 'student-backend')
const sharp = require(path.join(BACKEND, 'node_modules', 'sharp'))

const TMP = path.join(__dirname, '..', 'tmp', 'keepalive-probe')
const IMG_DIR = path.join(TMP, 'imgs')

// 缩略图规格与后端一致（THUMB_VERSION=4 → 512px / q82），否则解码成本不可比
const THUMB = 512
const Q = 82

async function makeImages(count) {
  fs.mkdirSync(IMG_DIR, { recursive: true })
  const files = []
  for (let i = 0; i < count; i++) {
    const f = path.join(IMG_DIR, `t${i}.jpg`)
    files.push(f)
    if (fs.existsSync(f)) continue
    // 每张内容不同，避免浏览器对相同内容做去重优化
    const raw = Buffer.allocUnsafe(THUMB * THUMB * 3)
    for (let p = 0, j = 0; p < THUMB * THUMB; p++, j += 3) {
      const x = p % THUMB
      const y = (p / THUMB) | 0
      const n = ((x * 7919 + y * 104729 + i * 3571) % 97) | 0
      raw[j] = (x + i * 13) % 256
      raw[j + 1] = (y + i * 7 + n) % 256
      raw[j + 2] = (x + y + i * 31) % 256
    }
    await sharp(raw, { raw: { width: THUMB, height: THUMB, channels: 3 } }).jpeg({ quality: Q }).toFile(f)
  }
  return files
}

function htmlFor({ count, glass, decoding }) {
  // 布局复刻相册：滚动容器内按「分组」绝对定位，每组一行标题 + 若干方形格子。
  // 格子 200px、gap 12、一行 6 列 —— 与 usePhotoTimeline 的目标格宽一致。
  const cell = 180
  const gap = 12
  const cols = 6
  const rows = Math.ceil(count / cols)
  const imgs = []
  for (let i = 0; i < count; i++) {
    imgs.push(
      `<img data-i="${i}" src="./imgs/t${i}.jpg" ` +
      `style="width:${cell}px;height:${cell}px;object-fit:cover;border-radius:8px;display:block" ` +
      `decoding="${decoding}">`
    )
  }
  const gridCls = glass ? 'stage glass' : 'stage'
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#0d1520;color:#fff;font:14px system-ui}
    #host{padding:20px}
    .stage{width:1200px;height:760px;overflow:auto;border-radius:20px;
      border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);
      padding:20px;box-sizing:border-box}
    /* 与 theme-glass.css 的 main .bg-surface 同款配方 */
    .glass{backdrop-filter:blur(24px) saturate(1.4);
      background:rgba(255,255,255,.35);contain:paint}
    .grid{display:flex;flex-wrap:wrap;gap:${gap}px}
    .h{height:40px;font-size:18px;padding-top:8px}
    #bg{position:fixed;inset:0;z-index:-1;
      background:linear-gradient(135deg,#1a2233 0%,#2d3a52 40%,#3a2f42 100%)}
  </style></head><body>
    <div id="bg"></div>
    <div id="host"><div id="stage" class="${gridCls}">
      <div class="h">2026-10-30</div>
      <div class="grid">${imgs.join('')}</div>
    </div></div>
    <script>
      const stage = document.getElementById('stage')
      const host = document.getElementById('host')
      // KeepAlive 的真实做法：组件 DOM 移到这个不在文档里的 div
      const storage = document.createElement('div')
      window.__storage = storage

      window.__run = () => new Promise((resolve) => {
        const t0 = performance.now()
        // ---- 插回文档（activate）----
        host.appendChild(stage)
        const frames = []
        let last = t0
        let settledAt = 0
        let stableFrames = 0
        const imgs = [...stage.querySelectorAll('img')]

        function tick() {
          const now = performance.now()
          frames.push(+(now - t0).toFixed(1))
          const gapMs = now - last
          last = now
          // 连续 4 帧间隔 < 25ms 且有画面 → 视为稳定
          if (gapMs < 25) stableFrames++
          else stableFrames = 0
          if (stableFrames >= 4 && !settledAt) settledAt = now - t0
          if (frames.length > 240 || (settledAt && frames.length > 8)) return done()
          requestAnimationFrame(tick)
        }
        // 同时量「所有图片解码完成」的时刻
        Promise.all(imgs.map(im => im.decode().catch(() => {}))).then(() => {
          window.__decodeAll = +(performance.now() - t0).toFixed(1)
        })
        requestAnimationFrame(tick)

        function done() {
          const maxGap = frames.reduce((m, v, i) => i ? Math.max(m, v - frames[i - 1]) : m, 0)
          resolve({
            firstFrame: frames[0] || 0,
            frames: frames.slice(0, 12),
            maxGap: +maxGap.toFixed(1),
            settled: settledAt ? +settledAt.toFixed(1) : -1,
            decodeAll: window.__decodeAll ?? -1,
            imgCount: imgs.length,
          })
        }
      })

      // ---- 移出文档（deactivate），然后等 ms 毫秒 ----
      window.__detach = (ms) => new Promise((resolve) => {
        storage.appendChild(stage)
        setTimeout(resolve, ms)
      })
    </script>
  </body></html>`
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))

async function runOne(win, cfg, label) {
  const file = path.join(TMP, `page-${label}.html`)
  fs.mkdirSync(TMP, { recursive: true })
  fs.writeFileSync(file, htmlFor(cfg))
  await win.loadURL(pathToFileURL(file).href)
  // 等首屏图片完全加载并解码（模拟「用户已经看了一会儿相册」的正常状态）
  await wait(1200)
  await win.webContents.executeJavaScript(
    `Promise.all([...document.querySelectorAll('img')].map(i => i.decode().catch(()=>{})))`
  )
  await wait(200)
  const r = await win.webContents.executeJavaScript(`window.__detach(900)`).then(() =>
    win.webContents.executeJavaScript(`window.__run()`)
  )
  return r
}

app.whenReady().then(async () => {
  const CASES = [
    { label: 'glass-60', count: 60, glass: true, decoding: 'async' },
    { label: 'plain-60', count: 60, glass: false, decoding: 'async' },
    { label: 'glass-30', count: 30, glass: true, decoding: 'async' },
    { label: 'glass-120', count: 120, glass: true, decoding: 'async' },
    { label: 'glass-60-sync', count: 60, glass: true, decoding: 'sync' },
  ]
  await makeImages(120)

  const win = new BrowserWindow({
    width: 1320, height: 900, show: true, // 隐藏窗口 rAF 被节流，测不出真实帧
    webPreferences: { backgroundThrottling: false },
  })
  console.log('\n变体            图片数  首帧(ms)  全部解码(ms)  最长帧间隔(ms)  稳定(ms)')
  console.log('─'.repeat(78))
  const rows = []
  try {
    for (const c of CASES) {
      const r = await runOne(win, c, c.label)
      rows.push({ label: c.label, ...r })
      console.log(
        c.label.padEnd(16),
        String(r.imgCount).padStart(5),
        String(r.firstFrame).padStart(9),
        String(r.decodeAll).padStart(13),
        String(r.maxGap).padStart(14),
        String(r.settled).padStart(9)
      )
    }
    console.log('\n前 12 帧时间点：')
    for (const r of rows) console.log('  ' + r.label.padEnd(16), r.frames.join(', '))
  } catch (e) {
    console.error('探针异常：', e && e.message)
  } finally {
    win.destroy()
  }
  app.exit(0)
})
