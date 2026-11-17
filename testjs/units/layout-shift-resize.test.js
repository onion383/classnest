// =========================================================================
// layout-shift-resize.test.js —— 拖窗口改大小必须复用同一套表格冻结窗口
//
// 背景（2026-11-16）：侧栏折叠那套「表格宽度钉在起始值 + 内容淡出露出现成玻璃」
// 实机观感通过，用户要求推广到「改变窗口大小」和「网状表格（GridView）」。
//
// 推广时的三点硬差异（写在 Sidebar.vue 的注释里，判据逐条锁住）：
//   ① resize 没有明确终点 → 「最后一次事件后静默 180ms」防抖，不能用折叠的 170ms 定时；
//   ② **不能跳过 no-animations** —— 关动画只压 CSS 过渡，拖窗口照样逐帧发 resize 事件；
//   ③ 起始宽度是实时值、纯 CSS 算不出 → 只在进入窗口的第一帧量一次写到
//      --win-freeze-w，之后每帧只重排期，绝不每帧读 getBoundingClientRect。
//   ④ 两种表格都要量/都要冻：列表型 .table-scroll-wrapper、网格型 .grid-view-container。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const FILES = {
  sidebar: 'student-frontend/src/components/layout/Sidebar.vue',
  css: 'student-frontend/src/styles/index.css',
}
function read(key) {
  return fs.readFileSync(path.join(ROOT, FILES[key]), 'utf8').replace(/\r\n/g, '\n')
}
function sources() {
  return { sidebar: read('sidebar'), css: read('css') }
}

function assertResizeFreeze(s) {
  const { sidebar, css } = s

  // ① 触发与生命周期
  assert.match(sidebar, /const WINDOW_IDLE_MS = 180/, '静默窗口必须是 180ms（与相册 RESIZE_IDLE_MS 同口径）')
  assert.match(sidebar, /const endWindowResize = d\.defer\(\)/,
    '连续 resize 必须靠 defer 自动取消上一次排期')
  assert.match(sidebar, /d\.listen\(window, 'resize', onWindowResize, \{ passive: true \}\)/,
    'resize 监听必须登记到 disposables（组件卸载自动摘除）')

  const fnAt = sidebar.indexOf('function onWindowResize(')
  assert.ok(fnAt > 0, 'onWindowResize 必须存在')
  const body = sidebar.slice(fnAt, sidebar.indexOf('\n}', fnAt) + 2)
  assert.match(body, /if \(!root\.classList\.contains\(WINDOW_CLASS\)\)/,
    '起始宽度只许在进入窗口的第一帧量一次')
  assert.match(body, /\.table-scroll-wrapper table, \.grid-view-container table/,
    '列表型 / 网格型表格都要量')
  assert.match(body, /setProperty\('--win-freeze-w'/, '必须写入起始宽度变量')
  assert.match(body, /root\.classList\.add\(WINDOW_CLASS\)/, '必须打上窗口标记')
  assert.match(body, /endWindowResize\(/, '必须排期收尾')
  assert.match(body, /WINDOW_IDLE_MS\)/, '收尾必须用静默窗口常量')
  assert.match(body, /removeProperty\('--win-freeze-w'\)/, '结束必须清掉变量，别留给下一次')
  assert.ok(!/no-animations/.test(body),
    '拖窗口不许跳过 no-animations（关动画只压 CSS 过渡，resize 事件照样逐帧来）')
  assert.ok(!/getBoundingClientRect/.test(body.slice(body.indexOf('root.classList.add(WINDOW_CLASS)'))),
    '打标记之后不许再读 DOM（每帧强制同步布局）')

  // ② CSS：resize 分支与 no-animations 兜底的边界
  const segAt = css.indexOf('布局变动窗口：表格冻结 + 内容淡出')
  assert.ok(segAt > 0, '布局变动窗口段必须存在')
  const seg = css.slice(segAt, css.indexOf('/* ====', segAt + 10) > 0
    ? css.indexOf('/* ====', segAt + 10)
    : css.length)
  assert.match(seg, /html\.window-resizing :is\(\.table-scroll-wrapper, \.grid-view-container\) table\s*\{\s*--table-freeze-w: var\(--win-freeze-w\)/,
    'resize 时起始宽度必须吃 JS 实测值')
  assert.match(seg, /html:is\(\.sidebar-collapsing, \.window-resizing\)/, '两个来源必须共用同一条冻结规则')
  assert.match(seg, /html\.no-animations:not\(\.window-resizing\)/,
    'no-animations 兜底必须排除 resize，否则拖窗口时表格不会淡出')
}

test('拖窗口改大小必须复用表格冻结窗口', () => {
  assertResizeFreeze(sources())
})

// 变异反证：每条判据都要能抓到「改回折叠那套 / 漏掉一种表格」。
test('变异反证 M1：去掉 resize 监听必须被抓', () => {
  const s = sources()
  s.sidebar = s.sidebar.replace("d.listen(window, 'resize', onWindowResize, { passive: true })", '')
  assert.notEqual(s.sidebar, read('sidebar'), 'M1 必须命中源码')
  assert.throws(() => assertResizeFreeze(s), /resize 监听必须登记到 disposables/)
})

test('变异反证 M2：静默窗口改短必须被抓', () => {
  const s = sources()
  s.sidebar = s.sidebar.replace('const WINDOW_IDLE_MS = 180', 'const WINDOW_IDLE_MS = 40')
  assert.notEqual(s.sidebar, read('sidebar'), 'M2 必须命中源码')
  assert.throws(() => assertResizeFreeze(s), /静默窗口必须是 180ms/)
})

test('变异反证 M3：每帧都量宽度必须被抓', () => {
  const s = sources()
  s.sidebar = s.sidebar.replace(
    'if (!root.classList.contains(WINDOW_CLASS)) {',
    'if (true) {',
  )
  assert.notEqual(s.sidebar, read('sidebar'), 'M3 必须命中源码')
  assert.throws(() => assertResizeFreeze(s), /起始宽度只许在进入窗口的第一帧量一次/)
})

test('变异反证 M4：resize 跳过 no-animations 必须被抓', () => {
  const s = sources()
  s.sidebar = s.sidebar.replace(
    'function onWindowResize() {\n  const root = document.documentElement',
    "function onWindowResize() {\n  if (document.documentElement.classList.contains('no-animations')) return\n  const root = document.documentElement",
  )
  assert.notEqual(s.sidebar, read('sidebar'), 'M4 必须命中源码')
  assert.throws(() => assertResizeFreeze(s), /拖窗口不许跳过 no-animations/)
})

test('变异反证 M5：漏掉网格型表格必须被抓', () => {
  const s = sources()
  s.sidebar = s.sidebar.replace(
    "'.table-scroll-wrapper table, .grid-view-container table'",
    "'.table-scroll-wrapper table'",
  )
  assert.notEqual(s.sidebar, read('sidebar'), 'M5 必须命中源码')
  assert.throws(() => assertResizeFreeze(s), /列表型 \/ 网格型表格都要量/)
})

test('变异反证 M6：结束不清变量必须被抓', () => {
  const s = sources()
  s.sidebar = s.sidebar.replace("    root.style.removeProperty('--win-freeze-w')\n", '')
  assert.notEqual(s.sidebar, read('sidebar'), 'M6 必须命中源码')
  assert.throws(() => assertResizeFreeze(s), /结束必须清掉变量/)
})

test('变异反证 M7：CSS 漏掉 resize 分支必须被抓', () => {
  const s = sources()
  s.css = s.css.replace('  --table-freeze-w: var(--win-freeze-w);', '  /* 没给起始宽度 */')
  assert.notEqual(s.css, read('css'), 'M7 必须命中源码')
  assert.throws(() => assertResizeFreeze(s), /resize 时起始宽度必须吃 JS 实测值/)
})
