// =========================================================================
// gdi-shot-bench.cjs —— 用 koffi 直接调 GDI BitBlt 抓屏，实测速度与像素一致性
//
// 回答三个问题（全部打印实测值，不靠推断）：
//   1) 速度：GetDC→BitBlt→GetDIBits 整段多少 ms，分段各占多少。
//      对照：同一时刻 desktopCapturer.getSources 多少 ms（就绪速率差一个数量级？）
//   2) 一致：GDI 抓到的 BGRA 与 desktopCapturer 的 toBitmap() 逐像素比，
//      差多少（完全相同的像素占比 / 平均绝对差 / 最大差及其位置）。
//      比对区域限定在一个自己创建的静态窗口内，避免桌面内容变动污染结论。
//   3) 自检可行性：「抽样判空图」这套兜底要花多少 ms、判据是否稳定。
//      这是 GDI 方案在 HDR 下「宁可退回也不要出坏图」的关键安全网。
//
// 用法（必须在 Electron 里跑，不是 node）：
//   env -u ELECTRON_RUN_AS_NODE npx electron testjs/probe/gdi-shot-bench.cjs
// 结果写到 testjs/tmp/gdi-shot-bench.log
//
// 注意：GDI 对象必须成对释放（SelectObject 还原 / DeleteObject / DeleteDC /
// ReleaseDC）。泄漏累积到进程句柄上限会让整个 Electron 花屏且极难定位，
// 这里每次抓完都严格清理，最后再重复 200 次验证句柄没有净增长。
// =========================================================================

const { app, BrowserWindow, desktopCapturer, screen } = require('electron')
const fsp = require('fs/promises')
const path = require('path')
const koffi = require('koffi')

const LOG = path.join(__dirname, '..', 'tmp', 'gdi-shot-bench.log')
const OUT_DIR = path.join(__dirname, '..', 'tmp', 'gdi-bench')

const lines = []
function log(msg) {
  lines.push(msg)
  console.log(msg)
}

const nowMs = () => Number(process.hrtime.bigint()) / 1e6
const r2 = (n) => Math.round(n * 100) / 100

// ---------------------------------------------------------------------------
// Win32 声明。结构体必须先注册，func() 里按名字引用才不会抛 unknown type。
// ---------------------------------------------------------------------------
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32',
  biWidth: 'int32',
  biHeight: 'int32',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'int32',
  biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32',
})

// HDC / HBITMAP / HGDIOBJ 都是内核句柄，用 void* 传递即可
let f = null
function bind() {
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  f = {
    GetCurrentProcess: kernel32.func('void *GetCurrentProcess()'),
    GetDC: user32.func('void *GetDC(void *hWnd)'),
    ReleaseDC: user32.func('int ReleaseDC(void *hWnd, void *hDC)'),
    GetSystemMetrics: user32.func('int GetSystemMetrics(int nIndex)'),
    GetDesktopWindow: user32.func('void *GetDesktopWindow()'),

    CreateCompatibleDC: gdi32.func('void *CreateCompatibleDC(void *hdc)'),
    CreateDCW: gdi32.func('void *CreateDCW(str16 pwszDriver, str16 pwszDevice, void *pdm, void *pdmPrint)'),
    CreateCompatibleBitmap: gdi32.func('void *CreateCompatibleBitmap(void *hdc, int cx, int cy)'),
    CreateDIBSection: gdi32.func(
      'void *CreateDIBSection(void *hdc, _In_ BITMAPINFOHEADER *pbmi, uint32 usage, void *ppvBits, void *hSection, uint32 offset)'
    ),
    SelectObject: gdi32.func('void *SelectObject(void *hdc, void *h)'),
    BitBlt: gdi32.func(
      'int BitBlt(void *hdcDest, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32 rop)'
    ),
    GetDIBits: gdi32.func(
      'int GetDIBits(void *hdc, void *hbm, uint32 start, uint32 cLines, _Out_ uint8_t *lpvBits, _Inout_ BITMAPINFOHEADER *lpbmi, uint32 usage)'
    ),
    GetDeviceCaps: gdi32.func('int GetDeviceCaps(void *hdc, int nIndex)'),
    DeleteObject: gdi32.func('int DeleteObject(void *ho)'),
    DeleteDC: gdi32.func('int DeleteDC(void *hdc)'),
    GetGuiResources: user32.func('uint32 GetGuiResources(void *hProcess, uint32 uiFlags)'),
  }
}

const SM_CXSCREEN = 0
const SM_CYSCREEN = 1
const SRCCOPY = 0x00cc0020
const CAPTUREBLT = 0x40000000
const DIB_RGB_COLORS = 0
// GetDeviceCaps 索引
const HORZRES = 8
const VERTRES = 10
const BITSPIXEL = 12
const PLANES = 14

// ---------------------------------------------------------------------------
// GDI 抓一帧。返回 BGRA Buffer（top-down，第 0 个像素是左上角）+ 分段耗时。
// ---------------------------------------------------------------------------
function captureGDI(w, h, opts = {}) {
  const rop = opts.captureBlt ? SRCCOPY | CAPTUREBLT : SRCCOPY
  const t = {}
  const buf = Buffer.alloc(w * h * 4)
  let hdcScreen = null
  let hdcMem = null
  let hbm = null
  let hOld = null
  let bitbltOk = 0
  let linesCopied = 0
  let caps = null

  const tAll = nowMs()
  try {
    let t0 = nowMs()
    hdcScreen = f.GetDC(null)
    t.getdc = nowMs() - t0
    if (!hdcScreen) throw new Error('GetDC(NULL) 返回 NULL')

    if (opts.probeCaps) {
      caps = {
        horzres: f.GetDeviceCaps(hdcScreen, HORZRES),
        vertres: f.GetDeviceCaps(hdcScreen, VERTRES),
        bitsPixel: f.GetDeviceCaps(hdcScreen, BITSPIXEL),
        planes: f.GetDeviceCaps(hdcScreen, PLANES),
      }
    }

    t0 = nowMs()
    hdcMem = f.CreateCompatibleDC(hdcScreen)
    // 关键：位图必须以「屏幕 DC」为模板创建，不能以刚建的内存 DC（其初值是 1x1 单色位图）
    hbm = f.CreateCompatibleBitmap(hdcScreen, w, h)
    if (!hdcMem || !hbm) throw new Error('CreateCompatibleDC / CreateCompatibleBitmap 失败')
    hOld = f.SelectObject(hdcMem, hbm)
    t.setup = nowMs() - t0

    t0 = nowMs()
    bitbltOk = f.BitBlt(hdcMem, 0, 0, w, h, hdcScreen, 0, 0, rop)
    t.bitblt = nowMs() - t0

    const bmi = {
      biSize: 40,
      biWidth: w,
      biHeight: -h, // 负值 = top-down，否则位图行序自下而上
      biPlanes: 1,
      biBitCount: 32,
      biCompression: 0, // BI_RGB
      biSizeImage: 0,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    }
    t0 = nowMs()
    linesCopied = f.GetDIBits(hdcMem, hbm, 0, h, buf, bmi, DIB_RGB_COLORS)
    t.getdibits = nowMs() - t0
  } finally {
    const t0 = nowMs()
    if (hdcMem && hOld) f.SelectObject(hdcMem, hOld) // 先还原，再删位图
    if (hbm) f.DeleteObject(hbm)
    if (hdcMem) f.DeleteDC(hdcMem)
    if (hdcScreen) f.ReleaseDC(null, hdcScreen)
    t.cleanup = nowMs() - t0
  }

  t.total = nowMs() - tAll
  return { buf, t, bitbltOk, linesCopied, caps }
}

// ---------------------------------------------------------------------------
// 变体：CreateDIBSection。位图的像素存储直接映射在进程地址空间里，
// BitBlt 直接写进去，理论上不需要 GetDIBits 那次整块拷贝。
// 这里分两种计时：只 blit（不读回）与 blit + 读回成 Buffer。
// ---------------------------------------------------------------------------
function captureGDIDib(w, h, readBack) {
  const t = {}
  let hdcScreen = null
  let hdcMem = null
  let hbm = null
  let hOld = null
  let bitbltOk = 0
  let bitsPtr = null
  let outBuf = null
  let readMs = 0

  const bmi = {
    biSize: 40,
    biWidth: w,
    biHeight: -h,
    biPlanes: 1,
    biBitCount: 32,
    biCompression: 0,
    biSizeImage: 0,
    biXPelsPerMeter: 0,
    biYPelsPerMeter: 0,
    biClrUsed: 0,
    biClrImportant: 0,
  }

  const tAll = nowMs()
  try {
    let t0 = nowMs()
    hdcScreen = f.GetDC(null)
    t.getdc = nowMs() - t0

    t0 = nowMs()
    hdcMem = f.CreateCompatibleDC(hdcScreen)
    // void** 出参：先分配一个指针槽，调用后从槽里读回指针
    const slot = koffi.alloc(koffi.pointer('void'), 1)
    hbm = f.CreateDIBSection(hdcScreen, bmi, DIB_RGB_COLORS, slot, null, 0)
    if (!hbm) throw new Error('CreateDIBSection 失败')
    bitsPtr = koffi.decode(slot, 'void *', 1)[0]
    hOld = f.SelectObject(hdcMem, hbm)
    t.setup = nowMs() - t0

    t0 = nowMs()
    bitbltOk = f.BitBlt(hdcMem, 0, 0, w, h, hdcScreen, 0, 0, SRCCOPY)
    t.bitblt = nowMs() - t0

    if (readBack) {
      t0 = nowMs()
      const arr = koffi.decode(bitsPtr, 'uint8', w * h * 4)
      outBuf = Buffer.from(arr.buffer ? arr : Uint8Array.from(arr))
      readMs = nowMs() - t0
    }
  } finally {
    const t0 = nowMs()
    if (hdcMem && hOld) f.SelectObject(hdcMem, hOld)
    if (hbm) f.DeleteObject(hbm)
    if (hdcMem) f.DeleteDC(hdcMem)
    if (hdcScreen) f.ReleaseDC(null, hdcScreen)
    t.cleanup = nowMs() - t0
  }

  t.readback = readMs
  t.total = nowMs() - tAll
  return { buf: outBuf, bitsPtr, t, bitbltOk }
}

// ---------------------------------------------------------------------------
// 「判空图」自检：等距抽样算亮度分布。这是 HDR 全黑场景的兜底手段。
// 判据：暗点占比 > 0.99 且方差 < 1 → 视为空图。
// ---------------------------------------------------------------------------
function blankCheck(buf, samples = 4096) {
  const t0 = nowMs()
  const px = buf.length / 4
  const step = Math.max(1, Math.floor(px / samples))
  let n = 0
  let dark = 0
  let sum = 0
  let sum2 = 0
  for (let k = 0; k < px; k += step) {
    const i = k * 4
    // BGRA → 亮度（Rec.601 权重，够判别用）
    const lum = (buf[i + 2] * 299 + buf[i + 1] * 587 + buf[i] * 114) / 1000
    if (lum < 8) dark++
    sum += lum
    sum2 += lum * lum
    n++
  }
  const mean = sum / n
  const variance = sum2 / n - mean * mean
  const ms = nowMs() - t0
  return {
    samples: n,
    darkRatio: dark / n,
    mean: r2(mean),
    variance: r2(variance),
    isBlank: dark / n > 0.99 && variance < 1,
    ms: r2(ms),
  }
}

// ---------------------------------------------------------------------------
// 两张 BGRA 图在指定矩形内比对
// ---------------------------------------------------------------------------
function compare(a, b, w, rect, stride = 2) {
  let total = 0
  let same = 0
  let sumAbs = 0
  let maxDiff = 0
  let worst = null
  for (let y = rect.y1; y < rect.y2; y += stride) {
    for (let x = rect.x1; x < rect.x2; x += stride) {
      const i = (y * w + x) * 4
      const db = Math.abs(a[i] - b[i])
      const dg = Math.abs(a[i + 1] - b[i + 1])
      const dr = Math.abs(a[i + 2] - b[i + 2])
      const d = Math.max(db, dg, dr)
      if (d <= 2) same++
      total++
      sumAbs += db + dg + dr
      if (d > maxDiff) {
        maxDiff = d
        worst = { x, y, gdi: [a[i + 2], a[i + 1], a[i]], cap: [b[i + 2], b[i + 1], b[i]] }
      }
    }
  }
  return {
    total,
    sameRatio: total ? same / total : 0,
    meanAbs: total ? r2(sumAbs / (total * 3)) : 0,
    maxDiff,
    worst,
  }
}

// ---------------------------------------------------------------------------

async function makeStaticWindow() {
  const win = new BrowserWindow({
    width: 700,
    height: 420,
    x: 120,
    y: 140,
    frame: false,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#ffffff',
  })
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;font-family:Segoe UI,sans-serif;background:#ffffff}
    .bar{height:80px;display:flex}
    .c{flex:1}
    .t{padding:16px 20px;font-size:22px;color:#1a1a1a}
    .s{font-size:13px;color:#666;padding:0 20px}
    .g{display:grid;grid-template-columns:repeat(8,1fr);gap:8px;padding:12px 20px}
    .g div{height:46px;border-radius:4px}
  </style></head><body>
  <div class="bar">
    <div class="c" style="background:#e5484d"></div>
    <div class="c" style="background:#30a46c"></div>
    <div class="c" style="background:#3e63dd"></div>
    <div class="c" style="background:#f5d90a"></div>
    <div class="c" style="background:#8e4ec6"></div>
    <div class="c" style="background:#0d9488"></div>
    <div class="c" style="background:#888888"></div>
    <div class="c" style="background:#111111"></div>
  </div>
  <div class="t">GDI BitBlt 像素一致性参照图</div>
  <div class="s">固定内容，用于逐像素比对；细线条用于暴露缩放/插值差异</div>
  <div class="g">
    ${Array.from({ length: 16 }, (_, i) => {
      const v = i * 16
      return `<div style="background:rgb(${v},${v},${v})"></div>`
    }).join('')}
  </div>
  </body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 900))
  return win
}

async function main() {
  await fsp.mkdir(OUT_DIR, { recursive: true })
  bind()

  const d = screen.getPrimaryDisplay()
  const scale = d.scaleFactor || 1
  const gdiW = f.GetSystemMetrics(SM_CXSCREEN)
  const gdiH = f.GetSystemMetrics(SM_CYSCREEN)
  const capW = Math.round(d.size.width * scale)
  const capH = Math.round(d.size.height * scale)

  log('=== 0) 尺寸与位深 ===')
  try {
    const gi = await app.getGPUInfo('basic')
    const names = [...new Set((gi.gpuDevice || []).map((g) => g.deviceString).filter(Boolean))]
    log(`GPU                    : ${names.join(' / ') || '(未报告)'}`)
  } catch (_) {
    log('GPU                    : 读取失败（不影响后续测量）')
  }
  log(`Display.size(DIP)      : ${d.size.width}x${d.size.height} @${scale}x`)
  log(`scaleFactor 换算的物理 : ${capW}x${capH}`)
  log(`GetSystemMetrics 物理  : ${gdiW}x${gdiH}`)
  log(`两者一致               : ${gdiW === capW && gdiH === capH ? '是 ✓' : '否 ✗'}`)

  const W = gdiW
  const H = gdiH

  log('')
  log('=== 1) GDI 首调（含 DLL/函数绑定冷启动）===')
  const cold = captureGDI(W, H, { probeCaps: true })
  log(`分段(ms): GetDC ${r2(cold.t.getdc)} | setup ${r2(cold.t.setup)} | BitBlt ${r2(cold.t.bitblt)} | GetDIBits ${r2(cold.t.getdibits)} | cleanup ${r2(cold.t.cleanup)}`)
  log(`整段(ms): ${r2(cold.t.total)}`)
  log(`BitBlt 返回: ${cold.bitbltOk}（非 0 = 成功）  GetDIBits 行数: ${cold.linesCopied}`)
  log(
    `设备能力: HORZRES ${cold.caps.horzres} VERTRES ${cold.caps.vertres} BITSPIXEL ${cold.caps.bitsPixel} PLANES ${cold.caps.planes}`
  )
  log(`像素缓冲: ${cold.buf.length} bytes = ${W}x${H}x4 → ${(cold.buf.length / (W * H)) * 8} bit/px`)

  log('')
  log('=== 2) GDI 热调用（预热后连测 10 次）===')
  const times = []
  const stage = { getdc: [], setup: [], bitblt: [], getdibits: [], cleanup: [] }
  let last = null
  for (let k = 0; k < 10; k++) {
    const r = captureGDI(W, H)
    times.push(r.t.total)
    for (const key of Object.keys(stage)) stage[key].push(r.t[key])
    last = r
  }
  const avg = (a) => r2(a.reduce((s, v) => s + v, 0) / a.length)
  const med = (a) => r2([...a].sort((x, y) => x - y)[Math.floor(a.length / 2)])
  const mn = (a) => r2(Math.min(...a))
  const mx = (a) => r2(Math.max(...a))
  log(`整段 avg ${avg(times)} | median ${med(times)} | min ${mn(times)} | max ${mx(times)}`)
  log(`分段 avg: GetDC ${avg(stage.getdc)} | setup ${avg(stage.setup)} | BitBlt ${avg(stage.bitblt)} | GetDIBits ${avg(stage.getdibits)} | cleanup ${avg(stage.cleanup)}`)

  log('')
  log('=== 2b) 变体对比：CreateCompatibleBitmap+GetDIBits  vs  CreateDIBSection ===')
  // 先预热一次
  captureGDIDib(W, H, false)
  const dibBlit = []
  const dibAll = []
  for (let k = 0; k < 5; k++) {
    const a = captureGDIDib(W, H, false)
    dibBlit.push(a.t.bitblt)
    dibAll.push(a.t.total)
  }
  log(`DIB 方案 只 blit 不读回 : BitBlt avg ${avg(dibBlit)} | min ${mn(dibBlit)} | max ${mx(dibBlit)}（整段 avg ${avg(dibAll)}）`)

  const dibRead = []
  const dibReadTotal = []
  let dibShot = null
  for (let k = 0; k < 3; k++) {
    const r = captureGDIDib(W, H, true)
    dibRead.push(r.t.readback)
    dibReadTotal.push(r.t.total)
    dibShot = r
  }
  log(`DIB 方案 blit+读回 Buffer: 读回 avg ${avg(dibRead)} | 整段 avg ${avg(dibReadTotal)}`)
  log(`  读回长度 ${dibShot.buf ? dibShot.buf.length : 0} bytes（应为 ${W * H * 4}）`)
  log(`  对照：兼容位图方案 BitBlt avg ${avg(stage.bitblt)} + GetDIBits avg ${avg(stage.getdibits)} = ${r2(avg(stage.bitblt) + avg(stage.getdibits))}`)

  log('')
  log('=== 2c) BitBlt 耗时是否随像素量线性变化（判断是固定开销还是逐像素成本）===')
  for (const [tw, th] of [[480, 300], [960, 600], [1920, 1200]]) {
    const s = []
    for (let k = 0; k < 5; k++) s.push(captureGDI(tw, th).t.bitblt)
    const mpx = (tw * th) / 1e6
    log(
      `${String(tw).padStart(4)}x${String(th).padStart(4)} (${mpx.toFixed(2)} MPx): BitBlt median ${med(s)} ms → ${r2(med(s) / mpx)} ms/MPx`
    )
  }

  log('')
  log('=== 2d) 关键验证：固定开销是「首次访问」还是「每次都付」？===')
  log('    思路：DC 与位图保持常驻，在同一对象上连续 BitBlt 多次，看第一次之后是否变快。')
  log('    若第 2 次起骤降 → 可在工具箱打开时预热，把成本移出用户等待路径。')

  function benchReuse(w, h, useCreateDC) {
    let hdcScreen = null
    let hdcMem = null
    let hbm = null
    let hOld = null
    const s = []
    try {
      hdcScreen = useCreateDC ? f.CreateDCW('DISPLAY', null, null, null) : f.GetDC(null)
      if (!hdcScreen) throw new Error('取屏幕 DC 失败')
      hdcMem = f.CreateCompatibleDC(hdcScreen)
      hbm = f.CreateCompatibleBitmap(hdcScreen, w, h)
      hOld = f.SelectObject(hdcMem, hbm)
      for (let k = 0; k < 6; k++) {
        const t0 = nowMs()
        f.BitBlt(hdcMem, 0, 0, w, h, hdcScreen, 0, 0, SRCCOPY)
        s.push(r2(nowMs() - t0))
      }
    } finally {
      if (hdcMem && hOld) f.SelectObject(hdcMem, hOld)
      if (hbm) f.DeleteObject(hbm)
      if (hdcMem) f.DeleteDC(hdcMem)
      if (hdcScreen) {
        if (useCreateDC) f.DeleteDC(hdcScreen)
        else f.ReleaseDC(null, hdcScreen)
      }
    }
    return s
  }

  const reuseGetDC = benchReuse(W, H, false)
  log(`复用对象 GetDC(NULL)     : 6 次 = [${reuseGetDC.join(', ')}] ms`)
  let reuseCreateDC = null
  try {
    reuseCreateDC = benchReuse(W, H, true)
    log(`复用对象 CreateDC(DISPLAY): 6 次 = [${reuseCreateDC.join(', ')}] ms`)
  } catch (e) {
    log(`CreateDC(DISPLAY) 调用失败: ${e.message}`)
  }

  const firstDrop = reuseGetDC.slice(1).some((v) => v < reuseGetDC[0] * 0.3)
  log(`第 2 次起是否明显变快（可预热）: ${firstDrop ? '是 ✓ 有预热门路' : '否 ✗ 每次都付固定成本'}`)

  log('')
  log('=== 3) 对照：desktopCapturer 同尺寸（热调用 3 次）===')
  const capTimes = []
  let capImg = null
  await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: W, height: H } }) // 预热
  for (let k = 0; k < 3; k++) {
    const t0 = nowMs()
    const ss = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: W, height: H } })
    capTimes.push(nowMs() - t0)
    capImg = ss[0].thumbnail
  }
  log(`getSources avg ${avg(capTimes)} | median ${med(capTimes)} | min ${mn(capTimes)} | max ${mx(capTimes)}`)

  const capSize = capImg.getSize()
  log(`缩略图尺寸: ${capSize.width}x${capSize.height}`)

  // ---- 4) 静态窗口 + 逐像素比对 ----
  log('')
  log('=== 4) 像素一致性（在本探针创建的静态窗口区域内比对）===')
  const win = await makeStaticWindow()
  const b = win.getBounds()
  // bounds 是 DIP，换算成物理像素并夹到屏幕范围
  const rect = {
    x1: Math.max(0, Math.round(b.x * scale) + 8),
    y1: Math.max(0, Math.round(b.y * scale) + 8),
    x2: Math.min(W, Math.round((b.x + b.width) * scale) - 8),
    y2: Math.min(H, Math.round((b.y + b.height) * scale) - 8),
  }
  log(`窗口 bounds(DIP): ${b.x},${b.y} ${b.width}x${b.height} → 比对物理区域: x ${rect.x1}~${rect.x2}, y ${rect.y1}~${rect.y2}`)

  await new Promise((r) => setTimeout(r, 350))
  const gdiShot = captureGDI(W, H)
  const ss2 = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: W, height: H } })
  const capShot = ss2[0].thumbnail.toBitmap()
  log(`GDI 缓冲 ${gdiShot.buf.length} bytes / desktopCapturer 缓冲 ${capShot.length} bytes`)

  if (capShot.length === gdiShot.buf.length) {
    const cmp = compare(gdiShot.buf, capShot, W, rect)
    log(`抽样像素: ${cmp.total}`)
    log(`完全相同(容差2): ${r2(cmp.sameRatio * 100)}%`)
    log(`平均绝对差: ${cmp.meanAbs}（0~255）`)
    log(`最大通道差: ${cmp.maxDiff}`)
    if (cmp.worst) log(`最大差位置: (${cmp.worst.x},${cmp.worst.y}) GDI[RGB ${cmp.worst.gdi}] vs CAP[RGB ${cmp.worst.cap}]`)

    // 窗口内区域和整屏都看一遍，判断是否只有窗口区一致
    const cmpAll = compare(gdiShot.buf, capShot, W, { x1: 0, y1: 0, x2: W, y2: H }, 4)
    log(`整屏抽样完全相同(容差2): ${r2(cmpAll.sameRatio * 100)}%，平均绝对差 ${cmpAll.meanAbs}`)
  } else {
    log('缓冲长度不同，无法逐像素比对')
  }

  // ---- 5) 判空自检的成本与判据 ----
  log('')
  log('=== 5) 空图自检（HDR 全黑兜底）===')
  const chkGdi = blankCheck(gdiShot.buf)
  log(`GDI 图 : 抽样 ${chkGdi.samples} 点，暗点占比 ${r2(chkGdi.darkRatio * 100)}%，亮度均值 ${chkGdi.mean}，方差 ${chkGdi.variance}，判定空图=${chkGdi.isBlank}，耗时 ${chkGdi.ms} ms`)
  const chkCap = blankCheck(capShot)
  log(`CAP 图 : 暗点占比 ${r2(chkCap.darkRatio * 100)}%，亮度均值 ${chkCap.mean}，方差 ${chkCap.variance}，判定空图=${chkCap.isBlank}，耗时 ${chkCap.ms} ms`)
  // 用全黑图验证判据本身能命中（否则「判空」就是摆设）
  const black = Buffer.alloc(W * H * 4, 0)
  const chkBlack = blankCheck(black)
  log(`纯黑样本: 暗点占比 ${r2(chkBlack.darkRatio * 100)}%，方差 ${chkBlack.variance}，判定空图=${chkBlack.isBlank} ← 必须为 true`)
  const white = Buffer.alloc(W * H * 4, 0xff)
  const chkWhite = blankCheck(white)
  log(`纯白样本: 暗点占比 ${r2(chkWhite.darkRatio * 100)}%，方差 ${chkWhite.variance}，判定空图=${chkWhite.isBlank} ← 必须为 false`)

  // ---- 6) GDI 句柄泄漏压测 ----
  log('')
  log('=== 6) GDI/USER 句柄泄漏压测（连抓 200 次）===')
  const gdiBefore = f.GetGuiResources(f.GetCurrentProcess(), 0) // 0 = GR_GDIOBJECTS
  const usrBefore = f.GetGuiResources(f.GetCurrentProcess(), 1) // 1 = GR_USEROBJECTS
  for (let k = 0; k < 200; k++) captureGDI(W, H)
  const gdiAfter = f.GetGuiResources(f.GetCurrentProcess(), 0)
  const usrAfter = f.GetGuiResources(f.GetCurrentProcess(), 1)
  log(`GDI 对象: ${gdiBefore} → ${gdiAfter}（净增 ${Number(gdiAfter) - Number(gdiBefore)}）`)
  log(`USER 对象: ${usrBefore} → ${usrAfter}（净增 ${Number(usrAfter) - Number(usrBefore)}）`)
  log(`结论: ${Number(gdiAfter) - Number(gdiBefore) <= 5 ? '无泄漏 ✓' : '疑似泄漏 ✗'}`)

  // ---- 7) 汇总 ----
  log('')
  log('=== 7) 汇总 ===')
  const gdiMed = med(times)
  const capMed = med(capTimes)
  log(`GDI 抓屏（含 GetDIBits）      : ${gdiMed} ms`)
  log(`desktopCapturer.getSources    : ${capMed} ms`)
  log(`倍数                          : ${r2(capMed / gdiMed)}x`)
  log(`接上 JPEG 编码 15ms 后整段估算 : GDI ${r2(gdiMed + 15)} ms vs CAP ${r2(capMed + 15)} ms`)

  await fsp.writeFile(LOG, lines.join('\n') + '\n', 'utf8')
  win.destroy()
  app.quit()
}

app.whenReady().then(() =>
  main().catch(async (e) => {
    log('失败: ' + (e && e.stack))
    try {
      await fsp.mkdir(path.dirname(LOG), { recursive: true })
    } catch (_) {
      /* 忽略 */
    }
    await fsp.writeFile(LOG, lines.join('\n') + '\n', 'utf8')
    app.quit()
  })
)
