// 证明「KeepAlive 切回后不恢复 scrollTop = 视口内看不到任何照片」这条因果，
// 并验证「恢复 scrollTop 后照片立刻回来」。
//
// 复刻 usePhotoTimeline 的窗口化逻辑（以分组为窗口单元 + 绝对定位占位），
// 做一次 detach（KeepAlive 缓存）→ attach（切回），然后：
//   A) 什么都不做：统计视口内可见的 <img> 数量（预期 0）
//   B) 写回 scrollTop：再统计（预期 > 0）
//
// 跑法：env -u ELECTRON_RUN_AS_NODE npx electron testjs/probe/keepalive-restore-probe.cjs

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

const BACKEND = path.join(__dirname, '..', '..', 'student-backend')
const sharp = require(path.join(BACKEND, 'node_modules', 'sharp'))

const TMP = path.join(__dirname, '..', 'tmp', 'keepalive-probe')
const IMG_DIR = path.join(TMP, 'imgs')

async function makeImages(count) {
  fs.mkdirSync(IMG_DIR, { recursive: true })
  for (let i = 0; i < count; i++) {
    const f = path.join(IMG_DIR, `t${i}.jpg`)
    if (fs.existsSync(f)) continue
    const raw = Buffer.allocUnsafe(512 * 512 * 3)
    for (let p = 0, j = 0; p < 512 * 512; p++, j += 3) {
      const x = p % 512
      raw[j] = (x + i * 13) % 256
      raw[j + 1] = (p / 512 + i * 7) % 256
      raw[j + 2] = (x + i * 31) % 256
    }
    await sharp(raw, { raw: { width: 512, height: 512, channels: 3 } }).jpeg({ quality: 82 }).toFile(f)
  }
}

function html() {
  // 分组参数与 usePhotoTimeline 默认值一致
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#101820;color:#fff;font:14px system-ui}
    #host{padding:20px}
    #stage{width:1100px;height:700px;overflow:auto;background:#18212c;border-radius:16px;
      padding:20px;box-sizing:border-box;position:relative}
    /* 复刻模板：外层撑总高，内部分组 absolute + translateY */
    #spacer{position:relative}
    .grp{position:absolute;left:0;right:0}
    .h{height:40px;line-height:40px;font-weight:600;color:#9fb3c8}
    .grid{display:flex;flex-wrap:wrap;gap:12px}
    .cell{width:160px;height:160px;border-radius:8px;object-fit:cover;display:block;background:#243040}
  </style></head><body>
  <div id="host"><div id="stage">
    <div id="spacer"></div>
  </div></div>
  <script>
    // ---- 复刻 usePhotoTimeline ----
    const GAP = 12, HEADER = 40, GROUP_GAP = 32, BUFFER = 900
    const GROUP_N = 40            // 分组数
    const PER_GROUP = 12          // 每组照片数（2 行 x 6 列）
    const COLS = 6, CELL = 160
    const groups = []
    for (let i = 0; i < GROUP_N; i++) groups.push({ date: '2026-01-' + String(i + 1).padStart(2, '0'), photos: Array.from({ length: PER_GROUP }, (_, k) => i * PER_GROUP + k) })
    const gh = HEADER + 2 * CELL + GAP
    const items = []
    let off = 0
    for (const g of groups) { items.push({ g, offset: off, h: gh }); off += gh + GROUP_GAP }
    const total = off

    const stage = document.getElementById('stage')
    const spacer = document.getElementById('spacer')
    spacer.style.height = total + 'px'
    const storage = document.createElement('div')

    let scrollTop = 0
    let clientH = 700
    function render() {
      clientH = stage.clientHeight || clientH
      const top = scrollTop - BUFFER
      const bottom = scrollTop + clientH + BUFFER
      const vis = items.filter(v => v.offset + v.h >= top && v.offset <= bottom)
      spacer.innerHTML = vis.map(v => {
        const imgs = v.g.photos.map(id =>
          '<img class="cell" data-id="' + id + '" src="./imgs/t' + id + '.jpg" loading="lazy" decoding="async">'
        ).join('')
        return '<div class="grp" style="transform:translateY(' + v.offset + 'px)">' +
          '<div class="h">' + v.g.date + '</div><div class="grid">' + imgs + '</div></div>'
      }).join('')
    }
    // 与真实页面一致：scroll 走 rAF 回写
    let raf = 0
    stage.addEventListener('scroll', () => {
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; scrollTop = stage.scrollTop; render() })
    })

    // 视口内可见的图片数（判断「用户能不能看到照片」）
    window.__visibleImgs = () => {
      const sr = stage.getBoundingClientRect()
      let n = 0
      for (const im of stage.querySelectorAll('img')) {
        const r = im.getBoundingClientRect()
        if (r.bottom > sr.top + 4 && r.top < sr.bottom - 4 && r.right > sr.left + 4 && r.left < sr.right - 4) n++
      }
      return n
    }

    window.__setup = async () => {
      stage.scrollTop = 8000
      await new Promise(r => setTimeout(r, 200))
      scrollTop = stage.scrollTop
      render()
      await new Promise(r => setTimeout(r, 600))
      return { scrolledTo: stage.scrollTop, visible: window.__visibleImgs(), groups: spacer.children.length }
    }

    window.__detach = async (ms) => {
      storage.appendChild(stage)         // KeepAlive deactivate
      await new Promise(r => setTimeout(r, ms))
      return { scrollTopInStorage: stage.scrollTop }
    }

    window.__attach = async () => {
      document.getElementById('host').appendChild(stage)  // KeepAlive activate
      await new Promise(r => setTimeout(r, 300))
      return {
        scrollTopAfterAttach: stage.scrollTop,
        refStillSays: scrollTop,
        visibleWithoutRestore: window.__visibleImgs(),
      }
    }

    window.__restore = async (saved) => {
      stage.scrollTop = saved
      scrollTop = saved
      await new Promise(r => setTimeout(r, 300))
      return { scrollTopNow: stage.scrollTop, visibleAfterRestore: window.__visibleImgs() }
    }
  </script></body></html>`
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async () => {
  await makeImages(40 * 12)
  fs.mkdirSync(TMP, { recursive: true })
  const file = path.join(TMP, 'restore.html')
  fs.writeFileSync(file, html())
  const win = new BrowserWindow({ width: 1240, height: 860, show: true, webPreferences: { backgroundThrottling: false } })
  const js = (code) => win.webContents.executeJavaScript(code)
  let failed = 0
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
    if (!ok) failed++
  }
  try {
    await win.loadURL(pathToFileURL(file).href)
    await wait(500)
    const a = await js('window.__setup()')
    console.log('\n【S0】滚动到中部（模拟用户正在看大相册）')
    check('已滚到 8000 附近', a.scrolledTo > 7000, `scrollTop=${a.scrolledTo}`)
    check('视口内能看到照片', a.visible > 0, `${a.visible} 张`)

    const d = await js('window.__detach(900)')
    console.log('\n【S1】KeepAlive 缓存（切到别的页面，停 900ms）')
    check('容器 scrollTop 被重置为 0', d.scrollTopInStorage === 0, `scrollTop=${d.scrollTopInStorage}`)

    const b = await js('window.__attach()')
    console.log('\n【S2】切回来（尚未恢复滚动位置）')
    check('容器 scrollTop 仍是 0', b.scrollTopAfterAttach === 0, `scrollTop=${b.scrollTopAfterAttach}`)
    check('scrollTop 引用仍指向旧值（状态不一致）', b.refStillSays > 7000, `ref=${b.refStillSays}`)
    check('视口内看不到照片（就是用户说的「空白」）', b.visibleWithoutRestore === 0, `${b.visibleWithoutRestore} 张`)

    const c = await js(`window.__restore(${b.refStillSays})`)
    console.log('\n【S3】写回 scrollTop（本次修复做的事）')
    check('容器回到原位置', Math.abs(c.scrollTopNow - b.refStillSays) < 2, `scrollTop=${c.scrollTopNow}`)
    check('照片立刻出现在视口里', c.visibleAfterRestore > 0, `${c.visibleAfterRestore} 张`)
  } catch (e) {
    console.error('探针异常：', e && e.message)
    failed++
  } finally {
    win.destroy()
  }
  console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`)
  app.exit(failed === 0 ? 0 : 1)
})
