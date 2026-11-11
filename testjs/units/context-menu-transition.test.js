// =========================================================================
// context-menu-transition.test.js —— 右键菜单过渡动画
// 运行：npm run test:units
//
// 为什么要有这个文件（不是「grep 一下 Transition 在不在」那么简单）：
//   ContextMenu 用 inline `visibility: hidden` 先量尺寸再显示，避免贴边时溢出。
//   加 <Transition> 后，如果在 visible=false 时立刻把 measured 重置为 false，
//   离场动画期间元素会被 inline visibility 藏起来 —— 代码里明明有 leave 动画，
//   用户却一帧都看不到。这是本组件特有的时序坑，必须钉住。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const MENU = path.join(__dirname, '../../student-frontend/src/components/base/ContextMenu.vue')

// 取 watch(() => props.visible, ...) 回调体，按「关闭分支 / 打开分支」切开
function watchParts(src) {
  const start = src.indexOf('watch(() => props.visible')
  assert.ok(start > 0, 'visible 监听必须存在')
  const end = src.indexOf('onBeforeUnmount', start)
  assert.ok(end > start, '监听体结尾没找到')
  const body = src.slice(start, end)
  const ifAt = body.indexOf('if (!v) {')
  const retAt = body.indexOf('    return;', ifAt)
  assert.ok(ifAt > 0 && retAt > ifAt, '关闭分支没找到')
  return { close: body.slice(ifAt, retAt), open: body.slice(retAt) }
}

test('模板：v-if 菜单被 Transition 包住，且组件仍用 visibility 量尺寸', () => {
  const src = fs.readFileSync(MENU, 'utf8')
  const t = src.indexOf('<Transition name="ctx-menu">')
  const v = src.indexOf('v-if="visible"')
  const close = src.indexOf('</Transition>', t)
  assert.ok(t > 0 && v > t && close > v, 'Transition 必须真的包住 v-if 元素')
  assert.match(src, /visibility: measured\.value \? 'visible' : 'hidden'/,
    '量尺寸机制还在（下面的时序判据就是为它写的）')
})

test('样式：入场/离场都有过渡，离场不接管指针，且尊重 reduced-motion', () => {
  const src = fs.readFileSync(MENU, 'utf8')
  const style = src.slice(src.indexOf('<style scoped>'))
  for (const cls of ['.ctx-menu-enter-active', '.ctx-menu-leave-active',
    '.ctx-menu-enter-from', '.ctx-menu-leave-to']) {
    assert.ok(style.includes(cls), `缺 ${cls}`)
  }
  assert.match(style, /\.ctx-menu-leave-active\s*\{[^}]*pointer-events: none/,
    '淡出期间要放开指针，否则会挡住紧接着弹出的确认框 / 点击')
  assert.match(style, /\.ctx-menu-leave-active\s*\{[^}]*transition: opacity/, '离场要有过渡')
  assert.match(style, /@media \(prefers-reduced-motion: reduce\)/, '要有 reduced-motion 兜底')
})

test('时序：measured 只在「再次打开」时重置，关闭分支不能碰它', () => {
  const { close, open } = watchParts(fs.readFileSync(MENU, 'utf8'))
  assert.ok(!close.includes('measured.value = false'),
    '关闭时重置 measured 会把 inline visibility 改成 hidden，离场动画一帧都看不见')
  assert.match(open, /measured\.value = false/,
    '下次打开仍要先隐藏再重新量尺寸（items 变了宽度也会变）')
  assert.match(open, /nextTick\(/, '量尺寸仍要在渲染后进行')
})
