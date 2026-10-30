// 验证两个表格组件在 KeepAlive 切回后的滚动恢复：
//   A) DynamicTable —— 虚拟滚动，initVirtual() 开头会用 wrap.scrollTop 覆盖 _scrollTop，
//      所以「先恢复容器位置、再 initVirtual」才对；顺序反了窗口会回到第一行。
//   B) GridView —— 没有虚拟滚动，内容不会空白，但容器 scrollTop 同样被清 0，需要写回。
//
// 两个场景都在真实 DOM 里跑（scrollTop 归零是浏览器行为，不能靠公式模拟）。
//
// 跑法：env -u ELECTRON_RUN_AS_NODE npx electron testjs/probe/keepalive-table-restore-probe.cjs

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

const TMP = path.join(__dirname, '..', 'tmp', 'keepalive-probe')

function html() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#0f1720;color:#e6eef7;font:13px system-ui}
    .wrap{width:760px;height:400px;overflow:auto;background:#16202b;border:1px solid #2a3a4d;
      border-radius:10px;position:relative;margin:12px}
    .wrap2{width:760px;height:300px;overflow:auto;background:#16202b;border:1px solid #2a3a4d;
      border-radius:10px;margin:12px}
    .spacer{position:relative}
    .win{position:absolute;left:0;right:0}
    .row{height:33px;line-height:33px;padding-left:10px;border-bottom:1px solid #1e2a38}
  </style></head><body>
  <div id="hostA"></div><div id="hostB"></div>
  <script>
    // ===== A) DynamicTable 式：虚拟滚动 =====
    const ROW_H = 33, N = 2500
    const wrapA = document.createElement('div'); wrapA.className = 'wrap'
    const spacerA = document.createElement('div'); spacerA.className = 'spacer'
    spacerA.style.height = (N * ROW_H) + 'px'
    const winA = document.createElement('div'); winA.className = 'win'
    spacerA.appendChild(winA); wrapA.appendChild(spacerA)
    document.getElementById('hostA').appendChild(wrapA)
    const storageA = document.createElement('div')

    let _scrollTop = 0           // 复刻 ctx._scrollTop

    // 复刻 recalcWindow + 渲染（只渲染窗口内的行，绝对定位到对应位置）
    function recalcWindow() {
      const viewportH = wrapA.clientHeight || 400
      const start = Math.max(0, Math.floor(_scrollTop / ROW_H))
      const end = Math.min(N, Math.ceil((_scrollTop + viewportH) / ROW_H) + 2)
      let html = ''
      for (let i = start; i < end; i++) html += '<div class="row" data-i="' + i + '">行 ' + i + '</div>'
      winA.style.top = (start * ROW_H) + 'px'
      winA.innerHTML = html
      return start
    }

    // 复刻 initVirtual：restore=true 时先把容器滚回 _scrollTop（本次修复），否则被 0 覆盖
    function initVirtual(restore) {
      if (restore) {
        const max = Math.max(0, wrapA.scrollHeight - wrapA.clientHeight)
        wrapA.scrollTop = Math.min(_scrollTop, max)
      }
      _scrollTop = wrapA.scrollTop          // ← DynamicTable 原代码这一行会在不恢复时把真值抹掉
      return recalcWindow()
    }

    window.__setupA = async (pos) => {
      wrapA.scrollTop = pos
      _scrollTop = wrapA.scrollTop          // 模拟 onScroll
      const start = recalcWindow()
      await new Promise(r => setTimeout(r, 200))
      return { scrollTop: wrapA.scrollTop, startRow: start }
    }
    window.__detachA = async (ms) => {
      storageA.appendChild(wrapA)           // KeepAlive deactivate
      await new Promise(r => setTimeout(r, ms))
      return { scrollTopInStorage: wrapA.scrollTop, refStill: _scrollTop }
    }
    window.__attachA = async (restore) => {
      document.getElementById('hostA').appendChild(wrapA)   // KeepAlive activate
      await new Promise(r => setTimeout(r, 200))
      const before = { scrollTop: wrapA.scrollTop, refStill: _scrollTop }
      const start = initVirtual(restore)    // 复刻 onActivated 里的 nextTick
      await new Promise(r => setTimeout(r, 120))
      const first = winA.querySelector('.row')
      return {
        scrollTopBeforeInit: before.scrollTop,
        refBeforeInit: before.refStill,
        scrollTopAfterInit: wrapA.scrollTop,
        windowStartRow: start,
        firstVisibleRow: first ? Number(first.dataset.i) : -1,
      }
    }

    // ===== B) GridView 式：普通滚动容器 =====
    const wrapB = document.createElement('div'); wrapB.className = 'wrap2'
    const innerB = document.createElement('div')
    innerB.style.height = '4000px'
    for (let i = 0; i < 120; i++) {
      const r = document.createElement('div'); r.className = 'row'; r.dataset.i = i; r.textContent = '行 ' + i
      innerB.appendChild(r)
    }
    wrapB.appendChild(innerB)
    document.getElementById('hostB').appendChild(wrapB)
    const storageB = document.createElement('div')
    let _gridScrollTop = 0
    wrapB.addEventListener('scroll', () => { _gridScrollTop = wrapB.scrollTop })   // 复刻 onGridScroll

    window.__setupB = async (pos) => {
      wrapB.scrollTop = pos
      await new Promise(r => setTimeout(r, 200))
      return { scrollTop: wrapB.scrollTop, refVal: _gridScrollTop }
    }
    window.__detachB = async (ms) => {
      storageB.appendChild(wrapB)
      await new Promise(r => setTimeout(r, ms))
      return { scrollTopInStorage: wrapB.scrollTop, refStill: _gridScrollTop }
    }
    window.__attachB = async (restore) => {
      document.getElementById('hostB').appendChild(wrapB)
      await new Promise(r => setTimeout(r, 200))
      const before = wrapB.scrollTop
      if (restore) {
        const saved = _gridScrollTop || 0
        const max = Math.max(0, wrapB.scrollHeight - wrapB.clientHeight)
        wrapB.scrollTop = Math.min(saved, max)
      }
      await new Promise(r => setTimeout(r, 80))
      return { scrollTopBefore: before, scrollTopAfter: wrapB.scrollTop }
    }
  </script></body></html>`
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async () => {
  fs.mkdirSync(TMP, { recursive: true })
  const file = path.join(TMP, 'table-restore.html')
  fs.writeFileSync(file, html())
  const win = new BrowserWindow({ width: 900, height: 900, show: true, webPreferences: { backgroundThrottling: false } })
  const js = (c) => win.webContents.executeJavaScript(c)
  let failed = 0
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
    if (!ok) failed++
  }
  try {
    await win.loadURL(pathToFileURL(file).href)
    await wait(400)

    // ---------- A) DynamicTable ----------
    console.log('\n【A】DynamicTable 式虚拟滚动')
    const a0 = await js('window.__setupA(8250)')   // 250 行 x 33 = 8250
    // 注意：scrollTop 会按设备像素比落成小数（实测 8250.4），不能写 ===
    check('滚动到 8250（第 250 行）', Math.abs(a0.scrollTop - 8250) < 2, `startRow=${a0.startRow}`)

    await js('window.__detachA(600)')
    const a1 = await js('window.__attachA(false)')
    console.log('  不恢复（修复前的行为）：')
    check('容器被清零', a1.scrollTopBeforeInit === 0, `scrollTop=${a1.scrollTopBeforeInit}`)
    check('_scrollTop 被 0 覆盖', a1.refBeforeInit > 8000, `覆盖前 ref=${a1.refBeforeInit}`)
    check('窗口回到第一行（表格跳顶）', a1.windowStartRow === 0 && a1.firstVisibleRow === 0, `首行 ${a1.firstVisibleRow}`)

    await js('window.__setupA(8250)')
    await js('window.__detachA(600)')
    const a2 = await js('window.__attachA(true)')
    console.log('  恢复（修复后）：')
    check('容器滚回原位置', Math.abs(a2.scrollTopAfterInit - 8250) < 2, `scrollTop=${a2.scrollTopAfterInit}`)
    check('窗口仍在第 250 行附近', Math.abs(a2.windowStartRow - 250) <= 1, `首行 ${a2.firstVisibleRow}`)

    // ---------- B) GridView ----------
    console.log('\n【B】GridView 式普通滚动容器')
    const b0 = await js('window.__setupB(900)')
    check('滚动到 900', b0.scrollTop === 900, `scrollTop=${b0.scrollTop}`)

    await js('window.__detachB(600)')
    const b1 = await js('window.__attachB(false)')
    console.log('  不恢复（修复前的行为）：')
    check('切回后停在顶部（跳顶）', b1.scrollTopBefore === 0, `scrollTop=${b1.scrollTopBefore}`)

    await js('window.__setupB(900)')
    await js('window.__detachB(600)')
    const b2 = await js('window.__attachB(true)')
    console.log('  恢复（修复后）：')
    check('切回后回到 900', b2.scrollTopAfter === 900, `scrollTop=${b2.scrollTopAfter}`)
  } catch (e) {
    console.error('探针异常：', e && e.message)
    failed++
  } finally {
    win.destroy()
  }
  console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`)
  app.exit(failed === 0 ? 0 : 1)
})
