// =========================================================================
// layout-shift-hint.test.js —— 表格冻结期间必须有「正在调整表格布局」状态提示
//
// 背景（2026-11-16）：表格内容淡出后只剩一块玻璃，用户反馈「不然感觉是坏掉了」。
// 于是按空态的竖排排版，在表格区域中央加一枚自转的 loading 图标 + 文案，
// 只在布局变动窗口（侧栏折叠 / 拖窗口）里显示，列表型与网格型表格都要有。
//
// 为什么用真实 DOM 而不是 CSS 伪元素：.table-scroll-wrapper.is-scrollable::after
// 已被渐变占用，且滚动容器的伪元素会跟着内容滚走；挂在非滚动的 relative 父级
// （.dynamic-table / .grid-view-container）上才稳。显示纯由 <html> class 驱动，
// 不进响应式、不参与表格逻辑。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const FILES = {
  dt: 'student-frontend/src/components/tables/DynamicTable/DynamicTable.vue',
  grid: 'student-frontend/src/components/tables/GridView/GridView.vue',
  css: 'student-frontend/src/styles/index.css',
}
function read(key) {
  return fs.readFileSync(abs(FILES[key]), 'utf8').replace(/\r\n/g, '\n')
}
function sources() {
  return { dt: read('dt'), grid: read('grid'), css: read('css') }
}

function assertHintBlock(src, label) {
  const at = src.indexOf('class="layout-shift-hint"')
  assert.ok(at > 0, `${label} 必须有 .layout-shift-hint 层`)
  const block = src.slice(at, src.indexOf('</div>', at))
  assert.match(block, /<IconGlyph name="loading"/, `${label} 必须用现成的 loading 图标`)
  assert.match(block, /glyph/, `${label} 必须带 glyph（否则 emoji 档会变成 🔄 而不是自转 SVG）`)
  assert.match(block, /正在调整表格布局/, `${label} 必须有状态文案`)
  assert.match(src.slice(at, at + 100), /aria-hidden="true"/,
    `${label} 提示层必须对读屏隐藏（窗口只有 150~180ms，播报反而干扰）`)
}

function assertHint(s) {
  // ① 两种表格都要有，且都用同一套文案 / 图标
  assertHintBlock(s.dt, '列表型表格')
  assertHintBlock(s.grid, '网格型表格')
  assert.match(s.grid, /import IconGlyph from '\.\.\/\.\.\/base\/IconGlyph\.vue'/,
    'GridView 原本没引入 IconGlyph，必须补 import')

  // ② 样式：居中竖排、不接管指针、默认隐藏、只在窗口里显示
  const segAt = s.css.indexOf('.layout-shift-hint {')
  assert.ok(segAt > 0, '全局样式里必须有 .layout-shift-hint 规则')
  const seg = s.css.slice(segAt, s.css.indexOf('html.no-animations .layout-shift-hint', segAt))
  assert.match(seg, /position: absolute/, '必须绝对定位（不占表格布局）')
  assert.match(seg, /inset: 0/, '必须铺满表格组件区域')
  assert.match(seg, /flex-direction: column/, '必须竖排：图标在上、文案在下')
  assert.match(seg, /pointer-events: none/, '不许拦截表格上的指针事件')
  assert.match(seg, /opacity: 0/, '平时必须隐藏')
  assert.match(seg, /transition: opacity 120ms ease/, '复原要有淡出')
  assert.match(seg, /html:is\(\.sidebar-collapsing, \.window-resizing\) \.layout-shift-hint\s*\{[\s\S]*?opacity: 1[\s\S]*?transition-duration: 0ms/,
    '只在布局变动窗口显示，且盖上要瞬时')
  assert.match(s.css, /html\.no-animations \.layout-shift-hint/, '关动画时不要淡入淡出')
}

test('表格冻结期间必须有状态提示', () => {
  assertHint(sources())
})

// 变异反证：每条判据都要能抓到「漏一个表格 / 改错形态」。
test('变异反证 M1：列表型表格漏掉提示必须被抓', () => {
  const s = sources()
  s.dt = s.dt.replace('class="layout-shift-hint"', 'class="layout-shift-hint-off"')
  assert.notEqual(s.dt, read('dt'), 'M1 必须命中源码')
  assert.throws(() => assertHint(s), /列表型表格 必须有/)
})

test('变异反证 M2：网格型表格漏掉提示必须被抓', () => {
  const s = sources()
  s.grid = s.grid.replace('class="layout-shift-hint"', 'class="layout-shift-hint-off"')
  assert.notEqual(s.grid, read('grid'), 'M2 必须命中源码')
  assert.throws(() => assertHint(s), /网格型表格 必须有/)
})

test('变异反证 M3：文案改掉必须被抓', () => {
  const s = sources()
  s.dt = s.dt.replace('正在调整表格布局', '加载中')
  assert.notEqual(s.dt, read('dt'), 'M3 必须命中源码')
  assert.throws(() => assertHint(s), /列表型表格 必须有状态文案/)
})

test('变异反证 M4：去掉 glyph 退化成 emoji 必须被抓', () => {
  const s = sources()
  s.grid = s.grid.replace(' tint="current" glyph :stroke-width="1.8"', ' tint="current" :stroke-width="1.8"')
  assert.notEqual(s.grid, read('grid'), 'M4 必须命中源码')
  assert.throws(() => assertHint(s), /网格型表格 必须带 glyph/)
})

test('变异反证 M5：提示层拦截指针事件必须被抓', () => {
  const s = sources()
  s.css = s.css.replace('  pointer-events: none;\n  transition: opacity 120ms ease;', '  transition: opacity 120ms ease;')
  assert.notEqual(s.css, read('css'), 'M5 必须命中源码')
  assert.throws(() => assertHint(s), /不许拦截表格上的指针事件/)
})

test('变异反证 M6：提示常驻不随窗口显隐必须被抓', () => {
  const s = sources()
  s.css = s.css.replace(
    'html:is(.sidebar-collapsing, .window-resizing) .layout-shift-hint {',
    'html .layout-shift-hint {',
  )
  assert.notEqual(s.css, read('css'), 'M6 必须命中源码')
  assert.throws(() => assertHint(s), /只在布局变动窗口显示/)
})
