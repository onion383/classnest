// =========================================================================
// album-resize-throttle.test.js —— 拖动窗口时别把「正在生成的缩略图」反复掐断
//
// 用户现象：「加载生成微缩图的时候改变窗口大小会卡死」「图片特别多时改窗口也会卡死」。
// 虚拟滚动只裁剪到「日期分组」，组内 v-for 是全量渲染，所以 DOM 里可能几百上千个格子。
// 改窗口宽度 → visibleGroups 每帧变 → measureViewportIds 每 80ms 扫一遍所有格子的
// getBoundingClientRect → viewportPhotoIds 变 → useThumbBatch 当成「用户滑走了」
// → abort 正在生成的批量请求 → 后端 clientGone 停手 → 前端再发 → 原图从头解码。
//
// 修法不是冻结布局（试过，观感差），而是冻结「视口里有哪些格子」这个判断：
//   usePhotoTimeline 暴露 resizing（最后一次 resize 后静默 N ms 才归零），
//   AlbumView 的 scheduleMeasure 在 resizing 期间不测，松手后 watch 补测一次。
//
// 本文件同时验行为（真 composable）与接线（源码判据）——「存在 X ≠ 有人用」。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '../..')
const FRONT = path.join(ROOT, 'student-frontend')
const VITE_ENTRY = path.join(FRONT, 'node_modules', 'vite', 'dist', 'node', 'index.js')
const TIMELINE = path.join(FRONT, 'src/composables/usePhotoTimeline.js')
const VIEW = path.join(FRONT, 'src/views/AlbumView.vue')
const BATCH = path.join(FRONT, 'src/composables/useThumbBatch.js')

const { loadVue } = require('./_vue-loader.cjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = (p) => fs.readFileSync(p, 'utf8')

let viteServer = null
let usePhotoTimeline = null
let vue = null

test.before(async () => {
  globalThis.window = globalThis.window || { __SECURE_CHANNEL__: false }
  const { createServer } = await import(pathToFileURL(VITE_ENTRY).href)
  viteServer = await createServer({
    root: FRONT, configFile: false, server: { middlewareMode: true },
    appType: 'custom', logLevel: 'silent',
  })
  ;({ usePhotoTimeline } = await viteServer.ssrLoadModule('/src/composables/usePhotoTimeline.js'))
  vue = await loadVue()
})
test.after(async () => { if (viteServer) await viteServer.close() })

function makeTimeline(resizeIdleMs = 60, width = 1000) {
  const scope = vue.effectScope()
  const groups = vue.ref([])
  const tl = scope.run(() => usePhotoTimeline(groups, { resizeIdleMs }))
  // 最小 DOM 替身：measure 只读这几个字段；groups 为空所以 FLIP/anchor 不会遍历节点
  tl.containerRef.value = {
    isConnected: true,
    clientWidth: width,
    clientHeight: 600,
    scrollTop: 0,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    offsetHeight: 600,
  }
  return { tl, scope, el: tl.containerRef.value }
}

test('onResize 打开安静窗口，静默期满后自动关闭', async () => {
  const { tl, scope } = makeTimeline(60)
  try {
    assert.equal(tl.resizing.value, false, '初始不该在安静窗口里（否则首次进相册会白等）')
    tl.onResize()
    assert.equal(tl.resizing.value, true, '改窗口必须立刻进入安静窗口')
    await sleep(90)
    assert.equal(tl.resizing.value, false, '松手后必须退出，否则永远不再重测视口')
  } finally { scope.stop() }
})

test('连续 resize 是防抖语义：中途不许提前退出', async () => {
  const { tl, scope } = makeTimeline(70)
  try {
    tl.onResize()
    await sleep(40)
    tl.onResize()
    await sleep(40)
    assert.equal(tl.resizing.value, true, '最后一次 resize 才起算静默期，中途不能放开')
    tl.onResize()
    await sleep(40)
    assert.equal(tl.resizing.value, true)
    await sleep(60)
    assert.equal(tl.resizing.value, false)
  } finally { scope.stop() }
})

test('安静窗口只冻结视口判断，布局照旧跟手（不许退化成「松手才落位」）', () => {
  const { tl, scope, el } = makeTimeline(60, 1000)
  try {
    tl.measure()
    const w0 = tl.viewW.value
    assert.ok(w0 > 0, '首次测量应该生效')
    el.clientWidth = 1300
    tl.onResize()
    assert.equal(tl.resizing.value, true)
    assert.ok(tl.viewW.value > w0, 'onResize 必须同时调 measure：窗口变宽了格子尺寸就得跟上')
  } finally { scope.stop() }
})

test('AlbumView 的重测在安静窗口里真的被挡住，且松手后会补测', () => {
  const code = read(VIEW)
  const at = code.indexOf('function scheduleMeasure()')
  assert.ok(at > 0, '找不到 scheduleMeasure')
  const body = code.slice(at, code.indexOf('watch(resizing', at))
  assert.match(body, /if \(resizing\.value \|\| viewportTimer\) return/,
    'scheduleMeasure 入口必须挡住 resizing —— 否则每 80ms 仍会扫几千个 rect')
  assert.match(body, /viewportTimer = 0\s*\n\s*if \(resizing\.value\) return/,
    '定时器是在拖动前排的，回调里还要再判一次')
  // 「存在 resizing」不够，必须真的 watch 它并在归零时补一次
  assert.match(code, /watch\(resizing, \(v\) => \{ if \(!v\) scheduleMeasure\(\) \}\)/,
    '松手后不补测 → 改完窗口新露出的格子永远不请求缩略图')
  assert.match(code, /visibleGroups, layout, resizing,/, '解构里必须拿到 resizing')
})

test('usePhotoTimeline 把安静窗口接到 window resize，而不是只写在模块里', () => {
  const code = read(TIMELINE)
  const body = code.slice(code.indexOf('function onResize()'), code.indexOf('// ===== 盯住容器自身尺寸'))
  assert.match(body, /beginResize\(\)/, 'onResize 必须调 beginResize（只 schedule 等于没冻结）')
  assert.match(body, /schedule\(\)/, '布局仍要跟手')
  assert.match(code, /if \(resizeIdleTimer\) \{ clearTimeout\(resizeIdleTimer\); resizeIdleTimer = 0 \}/,
    '卸载时必须清掉静默期定时器')
  assert.match(code, /cellStyle, layout, totalH, visibleGroups, resizing,/, 'resizing 必须导出')
})

test('下游确实会因视口序列变化而 abort（这条链存在，所以冻结是必需的）', () => {
  const code = read(BATCH)
  assert.match(code, /return ids\.length \? ids\.join\(','\) : ''/,
    'watch 用完整序列做依赖：resize 导致的重排序也会触发 load()')
  assert.match(code, /if \(inflightCtl\) inflightCtl\.abort\(\)/,
    'load 开头会掐断上一批 —— 不冻结视口判断就会把生成任务反复掐死')
})
