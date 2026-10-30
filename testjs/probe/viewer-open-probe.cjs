// 量「打开相册查看器要多久」，把耗时拆成两段分别测量：
//   A) 合成段：插入全屏遮罩 → 首帧呈现。重点验证 glass 主题的全屏
//      backdrop-filter: blur(30px) 以及 0.35s 透明度淡入期间的重合成成本。
//   B) 图像段：原图从磁盘加载 + 解码要多久，以及「先缩略图后原图」能省多少。
//
// 这不是在跑真实组件，而是复刻关键 CSS（全屏遮罩 + opacity 过渡 + backdrop-filter）
// 和真实尺寸的图片（4032x3024，体积接近手机原图），把两个变量分开。
//
// 跑法：env -u ELECTRON_RUN_AS_NODE npx electron testjs/probe/viewer-open-probe.cjs

const { app, BrowserWindow, screen } = require('electron')
const path = require('path')
const fs = require('fs')

const { TMP, ensureSampleImages } = require('./_sample-big')

// 样本图生成已抽到 _sample-big.cjs（viewer-anim-probe / etag-revalidate-probe 共用）

function buildHtml(thumbName) {
  // 背景网格：48 张缩略图，模拟相册页在打开查看器时的静止画面。
  // backdrop-filter 要模糊的就是这一片，所以它必须真的有内容、有图层。
  const cells = Array.from({ length: 48 }, () =>
    `<img class="cell" src="${thumbName}">`).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: #f1f5f9; }
  .grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 12px; padding: 16px; }
  .cell { width: 100%; aspect-ratio: 4/3; object-fit: cover; border-radius: 8px; display: block; }

  /* 复刻 .album-viewer：全屏固定层。四种变体靠 inline style 控制 backdrop-filter / transition */
  .ov {
    position: fixed; inset: 0; z-index: 10004;
    display: flex; flex-direction: column;
    background: rgba(255, 255, 255, 0.682);
    opacity: 1;
  }
  .ov.fade { transition: opacity 0.35s ease; }
  .ov.fade-from { opacity: 0; }
  /* 变体：blur 放在不参与动画的内层，外层只做透明度 */
  .ov .blur-layer { position: absolute; inset: 0; }
  .ov-main { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .ov-media { max-width: 100%; max-height: 100%; }
  .ov-bar { height: 72px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.46); }
</style></head><body>
<div class="grid">${cells}</div>
<script>
window.__runOpen = async function (mode, imgSrc) {
  // 清掉上一轮
  document.querySelectorAll('.ov').forEach(n => n.remove())
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

  const BLUR = 'blur(30px) saturate(1.25)'
  const ov = document.createElement('div')
  ov.className = 'ov'

  if (mode === 'dark') {
    // 深色主题现状：无模糊 + 0.35s 淡入
    ov.style.background = 'rgba(0,0,0,0.9)'
    ov.classList.add('fade', 'fade-from')
  } else if (mode === 'glass') {
    // glass 主题现状：全屏模糊 + 0.35s 淡入（模糊层本身也在做透明度动画）
    ov.style.backdropFilter = BLUR
    ov.style.webkitBackdropFilter = BLUR
    ov.classList.add('fade', 'fade-from')
  } else if (mode === 'glassInstant') {
    // 同样模糊，但去掉淡入：只测模糊本身的合成成本
    ov.style.backdropFilter = BLUR
    ov.style.webkitBackdropFilter = BLUR
  } else if (mode === 'glassSplit') {
    // 模糊放在不参与动画的内层，外层只淡入
    const layer = document.createElement('div')
    layer.className = 'blur-layer'
    layer.style.backdropFilter = BLUR
    layer.style.webkitBackdropFilter = BLUR
    ov.appendChild(layer)
    ov.classList.add('fade', 'fade-from')
  }

  const main = document.createElement('div')
  main.className = 'ov-main'
  const img = document.createElement('img')
  img.className = 'ov-media'
  img.src = imgSrc
  main.appendChild(img)
  ov.appendChild(main)
  const bar = document.createElement('div')
  bar.className = 'ov-bar'
  bar.textContent = 'toolbar'
  ov.appendChild(bar)

  const t0 = performance.now()
  document.body.appendChild(ov)

  const frames = []
  const start = performance.now()
  await new Promise((resolve) => {
    function tick(ts) {
      frames.push(ts)
      if (ts - start >= 460) return resolve()
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const t1 = performance.now()

  // 首帧：第一帧时间戳 - t0（同属 performance 时间轴）
  const first = frames.length ? Math.round(frames[0] - t0) : -1
  const dts = frames.slice(1).map((t, i) => t - frames[i])
  const over25 = dts.filter(d => d > 25).length
  const over40 = dts.filter(d => d > 40).length
  const longest = dts.length ? Math.round(Math.max(...dts)) : 0
  const avg = dts.length ? Math.round(dts.reduce((a, b) => a + b, 0) / dts.length) : 0
  const decoded = img.complete && img.naturalWidth > 0

  document.querySelectorAll('.ov').forEach(n => n.remove())
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

  return {
    mode, first, frames: frames.length,
    avg, longest, over25, over40,
    windowMs: Math.round(t1 - start),
    decoded,
    imgSize: img.naturalWidth + 'x' + img.naturalHeight
  }
}

// 单独测「加载 + 解码」：不走遮罩，只看图片本身多快能画出来
window.__decode = async function (src) {
  const img = new Image()
  const t0 = performance.now()
  img.src = src
  await img.decode()
  const decodeMs = performance.now() - t0
  // 再插进 DOM 并强制一次绘制
  const t1 = performance.now()
  img.style.cssText = 'position:fixed;left:0;top:0;max-width:100%;max-height:100%'
  document.body.appendChild(img)
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  const paintMs = performance.now() - t1
  img.remove()
  return { decodeMs: Math.round(decodeMs), paintMs: Math.round(paintMs), size: img.naturalWidth + 'x' + img.naturalHeight }
}
</script>
</body></html>`
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const log = (s) => console.log(s)
  const imgs = await ensureSampleImages()
  log('')
  log('=== 样本 ===')
  log(`原图 big.jpg   : ${imgs.bigMB} MB  (4032x3024)`)
  log(`缩略图 thumb.jpg: ${imgs.thumbKB} KB (600x450)`)

  const htmlPath = path.join(TMP, 'probe.html')
  fs.writeFileSync(htmlPath, buildHtml('thumb.jpg'), 'utf8')

  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: Math.min(width, 1600), height: Math.min(height, 1000),
    show: true, backgroundColor: '#ffffff',
    webPreferences: { offscreen: false }
  })
  await win.loadFile(htmlPath)
  await wait(700) // 让 48 张背景缩略图解码、布局、稳定

  const run = (mode, src) => win.webContents.executeJavaScript(
    `window.__runOpen(${JSON.stringify(mode)}, ${JSON.stringify(src)})`)

  const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/')

  log('')
  log('=== A) 合成段：插入全屏遮罩 → 首帧呈现 ===')
  log('（first=首帧延迟ms  avg=平均帧间隔ms  longest=最长帧ms  >25/>40=掉帧次数  frames=帧数）')
  const rows = []
  for (const mode of ['dark', 'glass', 'glassInstant', 'glassSplit']) {
    // 每个场景跑 3 次取中位，单次抖动太大
    const runs = []
    for (let i = 0; i < 3; i++) {
      runs.push(await run(mode, fileUrl(imgs.thumb)))
      await wait(260)
    }
    runs.sort((a, b) => a.first - b.first)
    const mid = runs[1]
    rows.push({ mode, ...mid })
    log(`${mode.padEnd(13)} first=${String(mid.first).padStart(4)}  avg=${String(mid.avg).padStart(3)}  longest=${String(mid.longest).padStart(4)}  >25=${mid.over25}  >40=${mid.over40}  frames=${mid.frames}  首帧已解码=${mid.decoded}`)
  }

  log('')
  log('=== B) 图像段：原图加载 + 解码 ===')
  const dBig = await win.webContents.executeJavaScript(`window.__decode(${JSON.stringify(fileUrl(imgs.big))})`)
  await wait(300)
  const dThumb = await win.webContents.executeJavaScript(`window.__decode(${JSON.stringify(fileUrl(imgs.thumb))})`)
  log(`原图 4032x3024 (${imgs.bigMB}MB) : decode ${dBig.decodeMs} ms  + 首次绘制 ${dBig.paintMs} ms`)
  log(`缩略图 600x450 (${imgs.thumbKB}KB) : decode ${dThumb.decodeMs} ms  + 首次绘制 ${dThumb.paintMs} ms`)
  log(`原图 / 缩略图 解码倍数 : ${(dBig.decodeMs / Math.max(dThumb.decodeMs, 1)).toFixed(1)}x`)

  // 结论算术
  const dark = rows.find(r => r.mode === 'dark')
  const glass = rows.find(r => r.mode === 'glass')
  const split = rows.find(r => r.mode === 'glassSplit')
  log('')
  log('=== 结论 ===')
  log(`glass 相比深色，首帧多 ${glass.first - dark.first} ms；动画期最长帧 ${dark.longest} → ${glass.longest} ms`)
  log(`把 blur 挪到不参与动画的内层：首帧 ${split.first} ms、最长帧 ${split.longest} ms`)
  log(`原图解码 ${dBig.decodeMs} ms ≈ 深色主题整段首帧 ${dark.first} ms 的 ${(dBig.decodeMs / Math.max(dark.first, 1)).toFixed(1)} 倍`)
  log('')
  log('注：本机是静态页 + 本地文件，真实环境还要加 HTTP 往返与后端读盘；')
  log('    所以下面两个数都是下限，真实只会更慢。')

  win.destroy()
  app.exit(0)
})
