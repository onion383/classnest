// =========================================================================
// widget-capture.test.js —— 浮窗截屏必须「自己先藏好」
//
// 回归 B12-11：便签窗口的注释背景里出现了它自己那张「加载中」卡片。
// 成因不是忘了隐藏，而是**隐藏方式对这类窗口无效**：
//   工具箱浮窗是 `transparent: true`（main.widget.js），Windows 上 setOpacity
//   对透明窗口不生效 —— 主进程的 hideWidget（setOpacity(0) + 等 150ms）等于没做。
// Screenshot.vue 早先就发现了这点，改成「自己把内容 visibility:hidden + 传 hideWidget:false」，
// 但 Note.vue 还在走那条无效的路。
//
// 这条判据锁的是「所有浮窗截屏调用方都用同一套自隐藏」，因为：
//   · 这类判据测不了画面（要真起 Electron 抓屏），只能锁调用形态；
//   · 将来再加第三个浮窗截屏入口时，它会因为「没走 captureHide」直接变红。
// 运行：npm run test:units
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const WIDGET_DIR = path.join(ROOT, 'student-frontend/src/subwindows/widget')

// 去注释：本文件的修复注释里就写着旧写法，不去注释会命中自己的说明文字
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'))

test('captureHide.js 是「藏/还原」的唯一实现', () => {
  const code = read('student-frontend/src/subwindows/widget/captureHide.js')
  const hide = code.match(/style\.visibility\s*=\s*'hidden'/g) || []
  const restore = code.match(/style\.visibility\s*=\s*''/g) || []
  assert.equal(hide.length, 1, 'captureHide 里应当只有一处隐藏')
  assert.equal(restore.length, 1, 'captureHide 里应当只有一处还原')
  assert.match(code, /requestAnimationFrame\(\(\) => requestAnimationFrame/, '必须等两帧再返回（合成器提交 + DWM 更新）')
})

test('浮窗里所有截屏调用方都自己藏、并传 hideWidget:false', () => {
  const files = fs.readdirSync(WIDGET_DIR).filter((f) => f.endsWith('.vue'))
  const callers = files.filter((f) => /SCREENSHOT_CAPTURE/.test(fs.readFileSync(path.join(WIDGET_DIR, f), 'utf8')))
  assert.ok(callers.length >= 2, `应至少有便签与一键截屏两个调用方，实际：${callers.join(',')}`)
  for (const f of callers) {
    const code = read(path.posix.join('student-frontend/src/subwindows/widget', f))
    assert.match(code, /from '\.\/captureHide\.js'/, `${f} 必须从 captureHide.js 引入隐藏逻辑`)
    assert.match(code, /hideForCapture\(\)/, `${f} 抓屏前没隐藏自己`)
    assert.match(code, /restoreAfterCapture\(\)/, `${f} 抓屏后没恢复显示（失败时窗口会一直隐身）`)
    assert.match(code, /hideWidget:\s*false/, `${f} 应传 hideWidget:false —— 主进程那段对透明窗口无效，白等 150ms`)
    // 不许自己再写一份 visibility 操作（否则「唯一实现」立刻失效）
    assert.ok(!/documentElement\.style\.visibility/.test(code),
      `${f} 不要自己操作 visibility，改用 captureHide.js`)
  }
})

test('主进程注释里说明了「setOpacity 对 transparent 窗口无效」这条坑', () => {
  // 判据看着"只是注释"，但它守的是一件事：以后有人想删掉 hideWidget 或反过来
  // 让渲染层别再自己藏，必须先看到这段原因。没有这段说明，注释一删，坑就重现。
  const raw = fs.readFileSync(path.join(ROOT, 'electron/main/main.dialogs.js'), 'utf8')
  assert.match(raw, /transparent[^\n]*setOpacity[^\n]*不生效|setOpacity[^\n]*对透明窗口不生效/,
    'main.dialogs.js 缺少「setOpacity 对透明窗口不生效」的说明')
})
