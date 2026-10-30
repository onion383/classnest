// 量「点击相册缩略图 → 大图动画真正开跑」中间那段死时间到底花在哪。
//
// 背景：用户报「点开相册查看器要等一会才有动画出来」。第一版怀疑是「动画从元素插入就计时，
// 图还没解码完，动画白跑」。本探针把四种写法并排量，看谁的死时间最短：
//   old        旧版：动画挂在过渡容器的子元素上（= .preview-enter-active .preview-media），插入即开跑
//   load       新版：media-waiting 隐形，img onload 后才换 media-in 触发动画（当前已落地）
//   load-async 新版 + img decoding="async"（让解码别占渲染主线程）
//   decode     先 img.decode() 把解码做在插入之前，再把「已解码的同一个 img」塞进遮罩
//
// 指标（都以点击时刻为 0）：
//   insert   遮罩插入时刻          imgLoad  图片字节就绪
//   animStart 动画真正起跑（animationstart 事件时刻 —— 主线程被解码占住时它会明显滞后）
//   gap      insert → animStart，就是用户感知的「点了没反应」那段
//   animEnd  动画结束
//
// 判读：谁把 gap 压小、且 animStart 与图片可显示对齐，谁就解决了「等一会才有动画」。
//
// 跑法：env -u ELECTRON_RUN_AS_NODE npx electron testjs/probe/viewer-anim-probe.cjs
//   （沙箱注入 ELECTRON_RUN_AS_NODE=1 会让 electron 退化成 node，必须 env -u 去掉）
//   样本图由 _sample-big.cjs 按需生成（4032x3024），首次运行会等几秒。

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

const { BIG: SRC, ensureSampleImages } = require('./_sample-big')
const TMP = path.join(__dirname, '..', 'tmp', 'viewer-anim-probe')

// 探针里会连续关窗，默认行为是「最后一个窗口关了就直接退出」，第二个窗口就 load 不起来了
app.on('window-all-closed', () => { /* 保持进程活着，等探针跑完 */ })

const CSS = `
  html, body { margin: 0; padding: 0; background: #111; }
  .overlay { position: fixed; inset: 0; }
  .preview-media {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    padding: 24px; overflow: hidden;
  }
  .preview-media img { max-width: 100%; max-height: 100%; }
  /* 旧写法：等价于 .preview-enter-active .preview-media —— 插入即开跑 */
  .preview-enter-active .preview-media { animation: previewMediaIn 0.28s cubic-bezier(0.22, 0.61, 0.36, 1); }
  /* 新写法：由 load 换类触发 */
  .preview-media.media-waiting { opacity: 0; }
  .preview-media.media-in { animation: previewMediaIn 0.28s cubic-bezier(0.22, 0.61, 0.36, 1); }
  @keyframes previewMediaIn {
    0% { opacity: 0; transform: scale(0.82); }
    100% { opacity: 1; transform: scale(1); }
  }
`

function htmlFor(variant, imgSrc) {
  // 每个变体的差异都写成布尔，页面里只跑一条分支，避免四份重复脚本
  const cfg = {
    old: { waitLoad: false, asyncDecode: false, preDecode: false },
    load: { waitLoad: true, asyncDecode: false, preDecode: false },
    'load-async': { waitLoad: true, asyncDecode: true, preDecode: false },
    decode: { waitLoad: true, asyncDecode: true, preDecode: true },
  }[variant]

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${CSS}</style></head>
<body>
<script>
(async () => {
  const cfg = ${JSON.stringify(cfg)}
  const r = { variant: '${variant}', pre: 0, insert: 0, imgLoad: 0, animStart: 0, animEnd: 0, ok: false }
  window.__r = r
  const url = '${imgSrc}'
  const c0 = performance.now()
  const rel = (t) => Math.round(t - c0)

  const img = document.createElement('img')
  img.src = url
  if (cfg.asyncDecode) img.decoding = 'async'

  // 把解码提前到插入之前：复用【同一个】img 元素，这样解码结果不会白做
  if (cfg.preDecode) {
    try { await img.decode() } catch (e) { /* 解码失败也别卡住，后面 onload 会兜底 */ }
  } else {
    // 非预解码分支：先让 img 开始下载（设置 src 已触发），但不等
  }
  const tInsert = performance.now()
  r.pre = rel(tInsert)

  const overlay = document.createElement('div')
  overlay.className = 'overlay' + (cfg.waitLoad ? '' : ' preview-enter-active')
  const media = document.createElement('div')
  media.className = 'preview-media' + (cfg.waitLoad ? ' media-waiting' : '')

  media.addEventListener('animationstart', (e) => {
    if (e.animationName !== 'previewMediaIn' || r.animStart) return
    r.animStart = rel(performance.now())
  })
  media.addEventListener('animationend', (e) => {
    if (e.animationName !== 'previewMediaIn' || r.animEnd) return
    r.animEnd = rel(performance.now())
    r.ok = true
  })
  img.addEventListener('load', () => {
    if (!r.imgLoad) r.imgLoad = rel(performance.now())
    if (cfg.waitLoad) {
      media.classList.remove('media-waiting')
      media.classList.add('media-in')
    }
  }, { once: true })

  media.appendChild(img)
  overlay.appendChild(media)
  document.body.appendChild(overlay)
  r.insert = rel(performance.now())

  // 兜底：万一 load 在监听挂上之前就完成（内存缓存），补一次
  if (img.complete && !r.imgLoad) {
    r.imgLoad = rel(performance.now())
    if (cfg.waitLoad) { media.classList.remove('media-waiting'); media.classList.add('media-in') }
  }
  // 安全阀：8 秒还没跑完就交卷，别让探针挂死
  setTimeout(() => { r.ok = true }, 8000)
})()
</script>
</body></html>`
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

async function runOne(variant, imgPath) {
  const imgSrc = pathToFileURL(imgPath).href // Windows 反斜杠塞进 JS 字符串会被当转义吃掉，必须转 URL
  const file = path.join(TMP, `anim-${variant}.html`)
  fs.writeFileSync(file, htmlFor(variant, imgSrc))
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true, // 隐藏窗口 rAF 会被节流，测动画必须真可见
    webPreferences: { backgroundThrottling: false },
  })
  try {
    await win.loadFile(file)
    return await waitFor(win, 12000)
  } catch (e) {
    console.error(`  [${variant}] 失败：${e.message}`)
    return null
  } finally {
    win.destroy()
  }
}

app.whenReady().then(async () => {
  await ensureSampleImages()
  fs.mkdirSync(TMP, { recursive: true })
  const sizeMB = (fs.statSync(SRC).size / 1048576).toFixed(2)
  console.log(`样本图：4032x3024 / ${sizeMB}MB，每个变体各拷一份 → 全部冷加载\n`)

  const variants = ['old', 'load', 'load-async', 'decode']
  const rows = []
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]
    const copy = path.join(TMP, `cold-${i}.jpg`)
    fs.copyFileSync(SRC, copy)
    const r = await runOne(v, copy)
    if (r) rows.push(r)
  }

  const pad = (s, n) => String(s).padEnd(n)
  console.log(pad('变体', 12), pad('插入', 8), pad('图片就绪', 10), pad('动画起跑', 10), pad('死时间 gap', 12), '动画结束')
  for (const r of rows) {
    console.log(
      pad(r.variant, 12),
      pad(r.insert + 'ms', 8),
      pad(r.imgLoad + 'ms', 10),
      pad(r.animStart + 'ms', 10),
      pad((r.animStart - r.insert) + 'ms', 12),
      r.animEnd + 'ms'
    )
  }
  console.log('\n判读：')
  for (const r of rows) {
    const gap = r.animStart - r.insert
    const verdict = gap <= 40 ? '几乎立刻起跑' : gap <= 90 ? '轻微滞后' : '明显滞后（用户感知就是「点了没反应」）'
    console.log(`  ${pad(r.variant, 12)} 插入到动画起跑 ${gap}ms → ${verdict}`)
  }

  const best = rows.slice().sort((a, b) => (a.animStart - a.insert) - (b.animStart - b.insert))[0]
  console.log(`\n死时间最短：${best ? best.variant : '无数据'}`)
  app.exit(rows.length === variants.length ? 0 : 1)
})
