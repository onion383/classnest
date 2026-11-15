// =========================================================================
// dynamic-table-resize-quiet.test.js —— 容器尺寸变化时行高测量必须走「安静窗口」
//
// 背景（2026-11-15）：折叠侧栏时 Sidebar.vue 的 `transition: width 0.15s` 让
// 主内容区宽度逐帧变化，DynamicTable 的 ResizeObserver 每帧回调一次。回调原来
// 无条件 `nextTick(measureRows())`：对当前所有渲染行逐个 getBoundingClientRect
// （强制同步布局）+ 写响应式 rowHeights + 按 padTop 补 scrollTop，每帧一整套。
// 宽度变化还会让单元格换行、行高真的变 → 缓存失效 → 窗口重算 → 再测量。
//
// 触发源必须是 ResizeObserver 自己，**不能是 window.resize**：侧栏折叠不改窗口
// 尺寸。相册 usePhotoTimeline.js 的安静窗口挂的是 window.resize，因此折叠时
// 根本不触发（那边只靠 measure() 的 3px 台阶闸门兜着）。
//
// 判据：布局照旧跟手（不许冻结 DOM），只把「逐行测量」压成最后一次尺寸变化后
// 静默 RESIZE_IDLE_MS 补测一次；静默窗口必须 ≥ 侧栏过渡的 150ms，否则动画
// 没结束就补测，等于白等。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const FILE = 'student-frontend/src/components/tables/DynamicTable/DynamicTable.vue'

function read() {
  return fs.readFileSync(path.join(ROOT, FILE), 'utf8')
}

function sliceFn(src, name) {
  const at = src.indexOf(`function ${name}(`)
  assert.ok(at > 0, `${name} 必须存在`)
  const end = src.indexOf('\n}', at)
  assert.ok(end > at, `${name} 函数体必须能取到`)
  return src.slice(at, end + 2)
}

/** 对一份源码字符串逐条校验「安静窗口」的必要条件。变异反证复用同一个函数。 */
function assertQuietWindow(src) {
  // ① RO 回调只许委托：内联 measureRows = 回到每帧一整套整表测量
  const roAt = src.indexOf('new ResizeObserver(')
  const obsAt = src.indexOf('ctx._ro.observe(wrap)', roAt)
  assert.ok(roAt > 0 && obsAt > roAt, 'ResizeObserver 必须创建并 observe(wrap)')
  const roBody = src.slice(roAt, obsAt)
  assert.ok(
    !/measureRows/.test(roBody),
    'RO 回调里不许直接调 measureRows（会每帧一整套整表测量）',
  )
  assert.match(roBody, /onWrapperResize\(wrap\)/, 'RO 回调必须委托给 onWrapperResize')

  // ② 防抖调度器来自 utils/disposables.js 的 defer（自动取消上一次 + 卸载自动清理）
  assert.match(
    src,
    /const scheduleResizeMeasure = d\.defer\(\)/,
    '补测必须走 disposables 的 defer（不能是裸 setTimeout 或同步调用）',
  )
  assert.match(
    src,
    /import \{ useDisposables \} from '\.\.\/\.\.\/\.\.\/utils\/disposables\.js'/,
    '必须引入 useDisposables',
  )

  // ③ 补测必须排在防抖回调里，且静默窗口覆盖侧栏 150ms 过渡
  const body = sliceFn(src, 'onWrapperResize')
  const deferAt = body.indexOf('scheduleResizeMeasure(')
  assert.ok(deferAt > 0, 'onWrapperResize 必须调用防抖调度器')
  assert.ok(
    body.indexOf('ctx.measureRows()', deferAt) > deferAt,
    '补测必须排在防抖回调里（同步测等于没做安静窗口）',
  )
  assert.match(body, /RESIZE_IDLE_MS/, '补测延时必须引用 RESIZE_IDLE_MS')
  const idle = /const RESIZE_IDLE_MS = (\d+)/.exec(src)
  assert.ok(idle, 'RESIZE_IDLE_MS 常量必须存在')
  assert.ok(
    Number(idle[1]) >= 150,
    `静默窗口 ${idle[1]}ms 必须 ≥ 侧栏过渡 150ms，否则动画没结束就补测`,
  )

  // ④ 两条边界：关动画时立即测、KeepAlive 切走时不测 detached DOM
  assert.match(body, /no-animations/, '关掉动画效果时必须立即测，别白等静默窗口')
  assert.match(
    body,
    /const firstOfBurst = !scheduleResizeMeasure\.pending;[\s\S]*?if \(firstOfBurst && /,
    '立即测必须由 defer 的 pending 守住新一轮第一帧（否则拖窗口会退化回每帧测量）',
  )
  assert.match(body, /isConnected/, '必须挡住 KeepAlive 挪出文档后的 RO 回调')
}

test('DynamicTable 的 RO 回调必须走尺寸安静窗口', () => {
  assertQuietWindow(read())
})

// 变异反证：每条判据都要能抓到「改回老写法」。缺了这些，正则很容易写成假绿。
test('变异反证 M1：RO 回调内联无条件测量必须被抓', () => {
  const src = read()
  const mutated = src.replace(
    'new ResizeObserver(() => onWrapperResize(wrap))',
    'new ResizeObserver(() => { ctx._viewportH = wrap.clientHeight; ctx.recalcWindow(); nextTick(() => ctx.measureRows()) })',
  )
  assert.notEqual(mutated, src, 'M1 必须命中源码')
  assert.throws(() => assertQuietWindow(mutated), /RO 回调里不许直接调 measureRows/)
})

test('变异反证 M2：拆掉 defer 退化成同步调用必须被抓', () => {
  const src = read()
  const mutated = src.replace(
    'const scheduleResizeMeasure = d.defer();',
    'const scheduleResizeMeasure = (fn) => fn();',
  )
  assert.notEqual(mutated, src, 'M2 必须命中源码')
  assert.throws(() => assertQuietWindow(mutated), /disposables 的 defer/)
})

test('变异反证 M3：静默窗口短于侧栏过渡必须被抓', () => {
  const src = read()
  const mutated = src.replace('const RESIZE_IDLE_MS = 180;', 'const RESIZE_IDLE_MS = 40;')
  assert.notEqual(mutated, src, 'M3 必须命中源码')
  assert.throws(() => assertQuietWindow(mutated), /必须 ≥ 侧栏过渡 150ms/)
})

test('变异反证 M5：立即测不受 pending 守卫必须被抓', () => {
  const src = read()
  const mutated = src.replace(
    "if (firstOfBurst && document.documentElement.classList.contains('no-animations')) {",
    "if (document.documentElement.classList.contains('no-animations')) {",
  )
  assert.notEqual(mutated, src, 'M5 必须命中源码')
  assert.throws(() => assertQuietWindow(mutated), /pending 守住/)
})

test('变异反证 M4：补测挪出防抖回调必须被抓', () => {
  const src = read()
  const mutated = src.replace(
    /  scheduleResizeMeasure\(\(\) => \{\n    if \(!ctx\.scrollWrapper\.value \|\| !ctx\.scrollWrapper\.value\.isConnected\) return;\n    nextTick\(\(\) => ctx\.measureRows\(\)\);\n  \}, RESIZE_IDLE_MS\);/,
    '  nextTick(() => ctx.measureRows());\n  scheduleResizeMeasure(() => {}, RESIZE_IDLE_MS);',
  )
  assert.notEqual(mutated, src, 'M4 必须命中源码')
  assert.throws(() => assertQuietWindow(mutated), /补测必须排在防抖回调里/)
})
