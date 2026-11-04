// 用法：env -u ELECTRON_RUN_AS_NODE npx electron testjs/probe/card-height-anim-probe.cjs
//
// 验证 composables/useCardHeightAnimation.js：内容增减时卡片高度是**平滑过渡**而不是瞬跳。
//
// 为什么必须真跑浏览器：这段逻辑的成败全在时序上 ——
//   · ResizeObserver 回调必须在 paint 之前起动画，否则用户先看到新高度再缩回去；
//   · WAAPI 的起始帧要到下一次渲染步骤才生效，所以回调里得先把高度钉回旧值；
//   · 窗口 show:false 时合成器不跑，动画会「瞬间跑到终点」——用隐藏窗口测会得到假结论
//     （第一版就是这么被骗过的：currentTime 直接是 260）。
// 所以这里开一个真窗口、逐帧采样 offsetHeight，看中间到底有没有过渡帧。
//
// 判据：两个方向都要有足够多的中间高度、终点正确、过程不越过终点。
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..', '..')
const OUT = path.join(ROOT, 'testjs', 'tmp', 'card-anim')
const DURATION = 260

const ENTRY = `
import { createApp, ref, h, nextTick } from 'vue'
import { useCardHeightAnimation } from '${path.join(ROOT, 'student-frontend/src/composables/useCardHeightAnimation.js').replace(/\\/g, '/')}'

const App = {
  setup() {
    const cardRef = ref(null)
    const show = ref(false)
    useCardHeightAnimation(cardRef, { duration: ${DURATION} })
    window.__toggle = async (v) => { show.value = v; await nextTick() }
    window.__heights = async (frames) => {
      const el = cardRef.value
      const out = [el.getBoundingClientRect().height]
      for (let i = 0; i < frames; i += 1) {
        await new Promise((r) => requestAnimationFrame(r))
        out.push(el.getBoundingClientRect().height)
      }
      return out
    }
    return () => h('div', { ref: cardRef, class: 'card' }, [
      h('p', { style: 'margin:0' }, '卡片内容'),
      show.value ? h('div', { class: 'extra' }, '多出来的一块') : null,
    ])
  },
}
createApp(App).mount('#app')
`

const HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<script type="importmap">{ "imports": { "vue": "./vue.esm-browser.js" } }</script>
<style>
  /* 必须 border-box：项目里 tailwind preflight 是 border-box，缺了它
     CSS height 与 offsetHeight 会差一个 padding，动画终点对不上（第一版踩过） */
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px; background: #eee; font: 14px/1.5 system-ui, sans-serif; }
  .card { background: #fff; border: 1px solid #ddd; border-radius: 10px; padding: 20px; min-width: 400px; max-width: 576px; }
  .extra { height: 120px; background: #eef; margin-top: 8px; }
</style></head>
<body><div id="app"></div><script type="module" src="./bundle.js"></script></body></html>
`

let failed = 0
function check(ok, msg) {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  if (!ok) failed += 1
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'entry.js'), ENTRY)
  fs.writeFileSync(path.join(OUT, 'index.html'), HTML)
  fs.copyFileSync(
    path.join(ROOT, 'student-frontend/node_modules/vue/dist/vue.esm-browser.js'),
    path.join(OUT, 'vue.esm-browser.js')
  )
  try {
    execFileSync('npx', ['esbuild', path.join(OUT, 'entry.js'), '--bundle', '--format=esm',
      '--external:vue', `--outfile=${path.join(OUT, 'bundle.js')}`, '--log-level=error'], {
      cwd: ROOT, stdio: 'inherit', shell: true,
    })
  } catch (e) {
    console.error('打包失败（需要 esbuild，npx 会自动取）：', e.message)
    app.exit(1)
    return
  }

  // show 必须为 true：隐藏窗口的合成器不跑，WAAPI 会瞬间跳到终点
  const win = new BrowserWindow({ width: 900, height: 700, show: true })
  const errors = []
  win.webContents.on('console-message', (_e, _lv, msg) => {
    if (/ResizeObserver loop|undelivered/i.test(msg)) errors.push(msg)
  })
  await win.loadFile(path.join(OUT, 'index.html'))
  await new Promise((r) => setTimeout(r, 600))

  const h0 = await win.webContents.executeJavaScript('window.__heights(1)')
  const before = Math.round(h0[0])

  await win.webContents.executeJavaScript('window.__toggle(true)')
  const grow = (await win.webContents.executeJavaScript('window.__heights(20)')).map(Math.round)
  await new Promise((r) => setTimeout(r, 400))
  await win.webContents.executeJavaScript('window.__toggle(false)')
  const shrink = (await win.webContents.executeJavaScript('window.__heights(20)')).map(Math.round)

  const uniq = (a) => new Set(a).size
  const growEnd = grow[grow.length - 1]
  const shrinkEnd = shrink[shrink.length - 1]

  console.log('\n高度动画（useCardHeightAnimation）')
  console.log('  初始', before, '| 变高', grow.join('→'))
  console.log('  变矮', shrink.join('→'))
  check(growEnd > before + 50, `变高后停在新高度（${before} → ${growEnd}）`)
  check(uniq(grow) > 5, `变高平滑：${uniq(grow)} 个不同高度（瞬跳只会是 2 个）`)
  check(!grow.some((h) => h > growEnd + 2), '变高过程不越过终点（不冲高再回落）')
  check(Math.abs(shrinkEnd - before) < 2, `变矮后回到初始高度（${growEnd} → ${shrinkEnd}）`)
  check(uniq(shrink) > 5, `变矮平滑：${uniq(shrink)} 个不同高度`)
  check(errors.length === 0, errors.length ? `ResizeObserver 循环告警 ${errors.length} 条` : '无 ResizeObserver 循环告警')

  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
  win.destroy()
  app.exit(failed === 0 ? 0 : 1)
})
