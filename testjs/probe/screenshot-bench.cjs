// =========================================================================
// screenshot-bench.cjs —— 一键截屏链路的各段耗时实测
//
// 目的：搞清楚「感觉有点久」到底久在哪一段，而不是靠猜。
// 逐段计时（单位 ms）：
//   getSources(冷/热) → toPNG / toJPEG → 写盘
//
// 用法（Electron 里跑，不是 node）：
//   npx electron testjs/probe/screenshot-bench.cjs
// 结果写到 testjs/tmp/screenshot-bench.log
// =========================================================================

const { app, desktopCapturer, screen } = require('electron')
const fsp = require('fs/promises')
const path = require('path')

app.disableHardwareAcceleration()

const LOG = path.join(__dirname, '..', 'tmp', 'screenshot-bench.log')
const OUT_DIR = path.join(__dirname, '..', 'tmp', 'shot-bench')

const lines = []
function log(msg) {
  lines.push(msg)
  console.log(msg)
}

async function main() {
  await fsp.mkdir(OUT_DIR, { recursive: true })

  const d = screen.getPrimaryDisplay()
  const w = Math.round(d.size.width * (d.scaleFactor || 1))
  const h = Math.round(d.size.height * (d.scaleFactor || 1))
  log(`显示器：${d.size.width}x${d.size.height} @${d.scaleFactor}x → 抓取尺寸 ${w}x${h}`)

  // ---- 1) getSources 冷启动（首调，含 D3D 设备/显示器枚举初始化）----
  let t = Date.now()
  let sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: w, height: h },
  })
  const tColdFull = Date.now() - t
  log(`getSources 冷启动（全尺寸）: ${tColdFull} ms，源数 ${sources.length}`)

  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0]
  const img = src.thumbnail
  log(`  缩略图实际尺寸: ${img.getSize().width}x${img.getSize().height}`)

  // ---- 2) getSources 热调用 ----
  t = Date.now()
  sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: w, height: h },
  })
  const tHotFull = Date.now() - t
  log(`getSources 热调用（全尺寸）: ${tHotFull} ms`)

  // ---- 3) 用 1x1 预热（成本极低）后再取全尺寸 ----
  t = Date.now()
  await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
  const tTiny = Date.now() - t
  log(`getSources 1x1 小图: ${tTiny} ms`)

  t = Date.now()
  sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: w, height: h },
  })
  log(`getSources 紧接 1x1 之后取全尺寸: ${Date.now() - t} ms`)

  const image = (sources.find((s) => s.display_id === String(d.id)) || sources[0]).thumbnail

  // ---- 4) 编码 ----
  t = Date.now()
  const png = image.toPNG()
  const tPng = Date.now() - t
  log(`toPNG : ${tPng} ms，${(png.length / 1048576).toFixed(2)} MB`)

  t = Date.now()
  const jpg = image.toJPEG(90)
  const tJpg90 = Date.now() - t
  log(`toJPEG(90): ${tJpg90} ms，${(jpg.length / 1048576).toFixed(2)} MB`)

  t = Date.now()
  const jpg95 = image.toJPEG(95)
  log(`toJPEG(95): ${Date.now() - t} ms，${(jpg95.length / 1048576).toFixed(2)} MB`)

  // ---- 5) 写盘 ----
  const pPng = path.join(OUT_DIR, 'bench.png')
  t = Date.now()
  await fsp.writeFile(pPng, png)
  log(`写 PNG : ${Date.now() - t} ms`)

  const pJpg = path.join(OUT_DIR, 'bench.jpg')
  t = Date.now()
  await fsp.writeFile(pJpg, jpg)
  log(`写 JPEG: ${Date.now() - t} ms`)

  // ---- 6) 汇总「当前实现」 vs 「可优化实现」 ----
  // 旧：固定等 150ms + getSources + toPNG + writeFile
  const oldWay = 150 + tHotFull + tPng + 3
  // 新：渲染层隐藏等两帧(~33ms@60Hz) + getSources + toJPEG(90) + writeFile
  const newWay = 33 + tHotFull + tJpg90 + 1
  log('')
  log(`旧链路（实测各段相加）: ${oldWay} ms = 等150 + getSources热 ${tHotFull} + toPNG ${tPng} + 写盘3`)
  log(`新链路（实测各段相加）: ${newWay} ms = 等两帧33 + getSources热 ${tHotFull} + toJPEG(90) ${tJpg90} + 写盘1`)
  log(`合计省: ${oldWay - newWay} ms（${Math.round((1 - newWay / oldWay) * 100)}%）`)

  // ---- 7) 新链路整段实跑 3 次（不靠相加，直接掐表）----
  for (let k = 1; k <= 3; k++) {
    const t0 = Date.now()
    await new Promise((r) => setTimeout(r, 33)) // 渲染层「等两帧」的等价等待
    const ss = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: w, height: h },
    })
    const im = (ss.find((s) => s.display_id === String(d.id)) || ss[0]).thumbnail
    const jp = im.toJPEG(90)
    const pp = path.join(OUT_DIR, `e2e-${k}.jpg`)
    await fsp.mkdir(OUT_DIR, { recursive: true })
    await fsp.writeFile(pp, jp)
    log(`新链路整段第 ${k} 次: ${Date.now() - t0} ms（${(jp.length / 1048576).toFixed(2)} MB）`)
  }

  await fsp.writeFile(LOG, lines.join('\n') + '\n', 'utf8')
  app.quit()
}

app.whenReady().then(() =>
  main().catch(async (e) => {
    log('失败: ' + (e && e.stack))
    try { await fsp.mkdir(path.dirname(LOG), { recursive: true }) } catch (_) {}
    await fsp.writeFile(LOG, lines.join('\n') + '\n', 'utf8')
    app.quit()
  })
)
