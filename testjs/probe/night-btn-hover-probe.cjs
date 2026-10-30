// 验证「夜间模式按钮悬浮不变色」是否真的生效。
//
// 为什么不能靠读 CSS 判断：按钮底色来自模板里的 hover:bg-* 工具类，
// 而 CSS 级联的胜出方要综合考虑特异性、!important、加载顺序，
// 静态推理很容易漏掉一条更特异的规则，所以这里用真实渲染 + 真实指针移动来量。
//
// 跑法（必须先 npx vite build，脚本读的是 dist 产物）：
//   env -u ELECTRON_RUN_AS_NODE npx electron testjs/probe/night-btn-hover-probe.cjs
//
// 判定：同一按钮「静止」与「鼠标悬浮」两次读到的 background-color 必须完全一致。
// 反例对照：view-switch-btn（背景由组件 scoped 样式决定、class 不含 bg-）
// 本就不在冻结范围内，它变色是正常的，不能因此判失败。

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

const DIST = path.join(__dirname, '../../student-frontend/dist')
const TMP = path.join(__dirname, '../tmp/night-btn-probe')

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
}

// 抓 dist 里所有 CSS（主样式 + 每个组件 chunk 的 scoped 样式 + 主题独立 chunk）
function cssFiles() {
  const dir = path.join(DIST, 'assets')
  return fs.readdirSync(dir).filter(f => f.endsWith('.css')).map(f => path.join(dir, f))
}

// 被测按钮：id / class / 说明。class 尽量取真实模板里的组合。
const CASES = [
  { id: 'b-primary', cls: 'bg-primary hover:bg-primary-hover text-text-inverse px-4 py-2 rounded', note: '主色按钮（gb-primary）' },
  { id: 'b-warning', cls: 'bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded', note: '警告色按钮' },
  { id: 'b-danger', cls: 'bg-danger hover:bg-danger/80 text-text-inverse px-4 py-2 rounded', note: '危险色按钮（hover:bg-danger/80）' },
  { id: 'b-danger-hover', cls: 'bg-danger hover:bg-danger-hover text-text-inverse px-4 py-2 rounded', note: '危险色（hover:bg-danger-hover）' },
  { id: 'b-red700', cls: 'bg-danger hover:bg-red-700 text-text-inverse px-2.5 py-0.5 rounded text-xs', note: '危险色小按钮（hover:bg-red-700）' },
  { id: 'b-muted', cls: 'bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded', note: '灰色按钮' },
  { id: 'b-refresh', cls: 'bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded btn-refresh', note: '带 .btn-refresh 的灰按钮' },
  { id: 'b-surface', cls: 'bg-surface-hover hover:bg-border text-text px-4 py-2 rounded', note: '浅玻璃按钮' },
  { id: 'b-small', cls: 'bg-primary/10 text-primary hover:bg-primary/20 px-4 py-2 rounded', note: '浅主色底小按钮' },
  // 下面三条是「文字色 / 透明底」类：上一版只冻结了 hover:bg-*，这类被漏掉，夜间会变红
  { id: 'b-icon-muted', cls: 'text-text-muted hover:text-danger text-sm leading-none', note: '✕ 图标按钮（静止 text-muted）' },
  { id: 'b-icon-secondary', cls: 'text-text-secondary hover:text-danger leading-none', note: '✕ 图标按钮（静止 text-secondary）' },
  { id: 'b-danger10', cls: 'text-danger hover:bg-danger/10 rounded px-1.5 py-0.5 text-sm', note: '删除文字按钮（hover:bg-danger/10）' },
]

function htmlFor(theme) {
  const links = cssFiles().map(f => `<link rel="stylesheet" href="${'file:///' + f.replace(/\\/g, '/')}">`).join('\n')
  const btns = CASES.map(c => `<button id="${c.id}" class="${c.cls}">${c.id}</button>`).join('\n')
  return `<!doctype html>
<html data-theme="${theme}" data-mode="night">
<head><meta charset="utf-8">
${links}
<style>
  /* 只做排版，不碰按钮配色 —— 不能干扰被测样式 */
  body { margin: 0; padding: 24px; display: flex; flex-direction: column; gap: 10px;
         background: #10151f; font-family: sans-serif; }
  button { align-self: flex-start; }
  #spacer { height: 60px; }
</style>
</head>
<body>
${btns}
<button id="b-switch" class="view-switch-btn">view-switch</button>
<div id="spacer"></div>
</body></html>`
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

async function measure(win, id) {
  // 先把指针挪到空白处，确保按钮处于静止态。
  // 等待必须超过 glass2 的 background-color 过渡时长（0.18s），否则读到的是过渡中间值。
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 600, y: 560 })
  await wait(260)
  const rest = await readStyle(win, id)
  // 再把指针移到按钮中心
  const rect = await win.webContents.executeJavaScript(
    `(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`
  )
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(rect.x), y: Math.round(rect.y) })
  await wait(260)
  const hovered = await readStyle(win, id)
  return { rest, hovered }
}

// 背景与文字都读：只比背景会漏掉 hover:text-* 那类（夜间「✕」按钮变红就是这么漏的）
async function readStyle(win, id) {
  return win.webContents.executeJavaScript(
    `(() => { const s = getComputedStyle(document.getElementById('${id}'));
      return { bg: s.backgroundColor, color: s.color } })()`
  )
}

async function runTheme(win, theme) {
  fs.mkdirSync(TMP, { recursive: true })
  const file = path.join(TMP, `hover-${theme}.html`)
  fs.writeFileSync(file, htmlFor(theme))
  console.log(`\n===== data-theme="${theme}" data-mode="night" =====`)
  // 复用同一个窗口：销毁窗口后立刻新建，Electron 会走进退出流程导致 loadURL 报 ERR_FAILED
  await win.loadURL(pathToFileURL(file).href)
  await wait(300)
  win.focus()
  win.webContents.focus()
  for (const c of CASES) {
    const { rest, hovered } = await measure(win, c.id)
    const bgSame = rest.bg === hovered.bg
    const colorSame = rest.color === hovered.color
    check(
      `${c.note} 悬浮不变色`,
      bgSame && colorSame,
      `背景 ${rest.bg} → ${hovered.bg}${bgSame ? '（同）' : '（变）'} ; 文字 ${rest.color} → ${hovered.color}${colorSame ? '（同）' : '（变）'}`
    )
  }
  // 对照：这一条应当**变**色（证明不是所有按钮都被一刀切）
  const sw = await measure(win, 'b-switch')
  console.log(`  （对照）view-switch 静止 ${sw.rest.bg} / 悬浮 ${sw.hovered.bg}`)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    show: true, // 隐藏窗口下 :hover 与 rAF 会被节流，测不出结果
    webPreferences: { backgroundThrottling: false },
  })
  try {
    for (const t of ['glass', 'glass2']) await runTheme(win, t)
  } catch (e) {
    failed++
    console.error('探针异常：', e && e.message)
  } finally {
    win.destroy()
  }
  console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`)
  app.exit(failed === 0 ? 0 : 1)
})
