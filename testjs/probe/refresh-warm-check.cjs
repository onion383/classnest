// 刷新类按钮（.btn-refresh）淡暖色核查：验证「冲突已剔除」——
//   ① opbar 内 / opbar 外 / 卡片上 三处 btn-refresh 的计算样式**完全一致**；
//   ② 悬浮时底色不变（day 只允许文字深一档 + 内遮罩 50%→56%；night 连文字也不变）。
// 跑法（先 npx vite build）：
//   env -u ELECTRON_RUN_AS_NODE npx electron testjs/probe/refresh-warm-check.cjs
// 同时输出截图到 testjs/tmp/refresh-warm/。

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

const DIST = path.join(__dirname, '../../student-frontend/dist')
const OUT = path.join(__dirname, '../tmp/refresh-warm')

let failed = 0
const check = (name, ok, extra) => {
  if (ok) console.log(`  ✓ ${name}`)
  else { failed++; console.log(`  ✗ ${name}  ${extra || ''}`) }
}
const wait = (ms) => new Promise(r => setTimeout(r, ms))

function cssLinks() {
  const dir = path.join(DIST, 'assets')
  return fs.readdirSync(dir).filter(f => f.endsWith('.css'))
    .map(f => `<link rel="stylesheet" href="${pathToFileURL(path.join(dir, f)).href}">`).join('\n')
}

function htmlFor(theme, mode) {
  return `<!doctype html>
<html data-theme="${theme}" data-mode="${mode}">
<head><meta charset="utf-8">
${cssLinks()}
<style>
  body { margin: 0; padding: 20px; font-family: 'Microsoft YaHei', sans-serif; }
  main { padding: 20px; }
  .row { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .opbar { display: flex; align-items: center; gap: 12px; }
</style>
</head>
<body>
<main>
  <div class="row">
    <div style="display:flex;gap:12px">
      <button id="a-out" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded btn-refresh transition-theme">刷新A</button>
    </div>
  </div>
  <div class="row">
    <div class="opbar">
      <button id="b-in" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded btn-refresh transition-theme">刷新B</button>
    </div>
  </div>
  <div class="row">
    <div class="bg-surface border border-border rounded-xl p-4 flex gap-3">
      <button id="c-card" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded btn-refresh transition-theme">刷新C</button>
    </div>
  </div>
</main>
</body></html>`
}

function readStyle(win, id) {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById(${JSON.stringify(id)})
    const s = getComputedStyle(el)
    return { bg: s.backgroundColor, color: s.color, shadow: s.boxShadow }
  })()`)
}

async function run(win, theme, mode) {
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `page-${theme}-${mode}.html`)
  fs.writeFileSync(file, htmlFor(theme, mode))
  console.log(`\n===== glass / ${mode} =====`)
  {
    await win.loadURL(pathToFileURL(file).href)
    await wait(500)

    const a = await readStyle(win, 'a-out')
    const b = await readStyle(win, 'b-in')
    const c = await readStyle(win, 'c-card')
    console.log(`  opbar外 ${JSON.stringify(a)}`)
    console.log(`  opbar内 ${JSON.stringify(b)}`)
    console.log(`  卡片上 ${JSON.stringify(c)}`)

    check('opbar 内外的底色一致（说明 opbar 不再抢 btn-refresh）', a.bg === b.bg, `${a.bg} vs ${b.bg}`)
    check('opbar 内外的文字色一致', a.color === b.color, `${a.color} vs ${b.color}`)
    check('opbar 内外的阴影一致', a.shadow === b.shadow, `\n    外 ${a.shadow}\n    内 ${b.shadow}`)
    check('卡片上与其他两处一致', a.bg === c.bg && a.color === c.color && a.shadow === c.shadow)

    const isWarm = /rgba?\(25[01],\s*14[0-9]/.test(a.bg) // rgba(251, 146, 60, ...)
    check('底色是暖橙系（不是灰色）', isWarm, a.bg)

    // ---- 悬浮 ----
    const rect = await win.webContents.executeJavaScript(`(() => {
      const r = document.getElementById('b-in').getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 600, y: 380 })
    await wait(300)
    const restB = await readStyle(win, 'b-in')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y })
    await wait(320)  // > transition-theme(200ms)，避免读到过渡中间值
    const hovB = await readStyle(win, 'b-in')
    console.log(`  悬浮前 ${JSON.stringify(restB)}`)
    console.log(`  悬浮后 ${JSON.stringify(hovB)}`)

    check('悬浮时底色不变', restB.bg === hovB.bg, `${restB.bg} → ${hovB.bg}`)
    if (mode === 'night') {
      check('夜间悬浮时文字色也不变', restB.color === hovB.color, `${restB.color} → ${hovB.color}`)
    } else {
      check('白天悬浮时文字深一档（允许且期望）', restB.color !== hovB.color, `${restB.color} → ${hovB.color}`)
    }
    check('悬浮时阴影有变化（内遮罩加深）', restB.shadow !== hovB.shadow)

    await win.webContents.executeJavaScript(`window.scrollTo(0,0)`)
    await wait(200)
    const img = await win.webContents.capturePage()
    const out = path.join(OUT, `glass-${mode}.png`)
    fs.writeFileSync(out, img.toPNG())
    console.log('  saved', out)
  }
}

app.whenReady().then(async () => {
  // 复用同一个窗口：销毁窗口会进 Electron 退出流程，之后 loadURL 必然 ERR_FAILED
  const win = new BrowserWindow({
    width: 900, height: 420, show: true,
    webPreferences: { backgroundThrottling: false },
  })
  try {
    for (const mode of ['day', 'night']) await run(win, 'glass', mode)
  } catch (e) {
    console.error('探针异常：', e && e.message)
    failed++
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
  console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`)
  app.exit(failed === 0 ? 0 : 1)
})
