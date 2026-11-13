// =========================================================================
// viewer-pan.test.js —— 查看器「放大之后能拖动平移」
//
// 用户现象：照片查看器放大后超出的部分被 overflow-hidden 裁掉，鼠标拖不动，
// 边角永远看不到。修法是一条夹在可视余量内的 translate，由
// composables/useViewerPan.js 统一驱动两份查看器。
//
// 本文件钉住三层，缺一层都是假绿：
//   A. 纯函数算得对（余量 / 边界 / 旋转 90 度宽高互换）
//   B. 真 composable 拖得动、夹得住、缩回 1 倍会回正、卸载会撤监听
//   C. 两份查看器**真的接上了**（模板事件、ref、解构到顶层、复位调用、CSS）
//      ——「模块里有这个函数」≠「有人在用它」，Vapor 下漏解构是静默失效。
// 运行：npm run test:units
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '../..')
const FRONT = path.join(ROOT, 'student-frontend')
const UTIL = path.join(FRONT, 'src/utils/viewerPan.js')
const PAN = path.join(FRONT, 'src/composables/useViewerPan.js')
const ALBUM = path.join(FRONT, 'src/views/AlbumView.vue')
const MEDIA = path.join(FRONT, 'src/components/base/MediaViewer.vue')
const CSS = path.join(FRONT, 'src/styles/media-viewer.css')
const read = (p) => fs.readFileSync(p, 'utf8')
const { loadVue } = require('./_vue-loader.cjs')

let panBounds, clampPanValue, PAN_MIN_ZOOM, useViewerPan, vue

test.before(async () => {
  ;({ panBounds, clampPanValue, PAN_MIN_ZOOM } = await import(pathToFileURL(UTIL).href))
  ;({ useViewerPan } = await import(pathToFileURL(PAN).href))
  vue = await loadVue()
})

// ---------- A. 纯计算 ----------

const BASE = { mediaW: 800, mediaH: 450, stageW: 1000, stageH: 600, zoom: 1, rotation: 0 }

test('未放大且装得下：余量为 0，拖动不该产生位移', () => {
  assert.deepEqual(panBounds(BASE), { maxX: 0, maxY: 0 })
  assert.equal(PAN_MIN_ZOOM, 1)
})

test('放大 2 倍：可平移余量 = (缩放后尺寸 - 舞台尺寸) / 2', () => {
  assert.deepEqual(panBounds({ ...BASE, zoom: 2 }), { maxX: 300, maxY: 150 })
})

test('旋转 90 度时宽高互换：zoom=1 也可能被裁，仍要能上下平移', () => {
  assert.deepEqual(panBounds({ ...BASE, rotation: 90 }), { maxX: 0, maxY: 100 })
  assert.deepEqual(panBounds({ ...BASE, rotation: 270, zoom: 2 }), { maxX: 0, maxY: 500 })
  assert.deepEqual(panBounds({ ...BASE, rotation: 180, zoom: 2 }), { maxX: 300, maxY: 150 })
})

test('clampPanValue 双向夹住、非有限数归零、bounds 缺失不炸', () => {
  const b = { maxX: 300, maxY: 150 }
  assert.deepEqual(clampPanValue(120, -80, b), { x: 120, y: -80 })
  assert.deepEqual(clampPanValue(9999, -9999, b), { x: 300, y: -150 })
  assert.deepEqual(clampPanValue(Number.NaN, Infinity, b), { x: 0, y: 0 })
  assert.deepEqual(clampPanValue(50, 50, null), { x: 0, y: 0 })
})

// ---------- B. 真 composable ----------

async function withFakeWindow(fn) {
  const listeners = new Map()
  const saved = globalThis.window
  globalThis.window = {
    addEventListener: (t, h) => listeners.set(t, h),
    removeEventListener: (t) => listeners.delete(t),
  }
  try { return await fn(listeners) } finally {
    if (saved === undefined) delete globalThis.window
    else globalThis.window = saved
  }
}

function makePan({ zoom: z = 2, rotation: r = 0 } = {}) {
  const scope = vue.effectScope()
  const zoom = vue.ref(z)
  const rotation = vue.ref(r)
  const captured = []
  const stage = {
    clientWidth: 1000, clientHeight: 600,
    setPointerCapture: (id) => captured.push(['set', id]),
    releasePointerCapture: (id) => captured.push(['release', id]),
  }
  const media = { offsetWidth: 800, offsetHeight: 450 }
  const stageRef = vue.ref(stage)
  const mediaRef = vue.ref(media)
  const pan = scope.run(() => useViewerPan({ zoom, rotation, stageRef, mediaRef }))
  return { pan, zoom, rotation, stage, media, stageRef, mediaRef, scope, captured }
}

function ev(target, extra = {}) {
  return {
    pointerId: 1, button: 0, clientX: 0, clientY: 0,
    currentTarget: target, preventDefault() {},
    ...extra,
  }
}

test('放大后拖 100×50：图片跟手移动，transform 里 translate 在 rotate/scale 之前', () => withFakeWindow(() => {
  const { pan, stage, scope, captured } = makePan()
  try {
    assert.equal(pan.canPan.value, true)
    assert.equal(pan.stageClass.value, 'viewer-can-pan')
    pan.onPointerDown(ev(stage, { clientX: 200, clientY: 300 }))
    assert.deepEqual(captured, [['set', 1]], '必须捕获指针，否则甩出舞台就断连')
    assert.equal(pan.panning.value, true)
    assert.equal(pan.mediaClass.value, 'viewer-panning', '拖动期间 img 要掐掉补间')
    pan.onPointerMove(ev(stage, { clientX: 300, clientY: 350 }))
    assert.equal(pan.panX.value, 100)
    assert.equal(pan.panY.value, 50)
    assert.match(pan.style.value.transform,
      /^translate\(100px, 50px\) rotate\(0deg\) scale\(2\)$/,
      'translate 必须写在最外层（屏幕坐标系），否则位移会被 scale 再乘一遍')
    pan.onPointerUp(ev(stage))
    assert.equal(pan.panning.value, false)
    assert.deepEqual(captured, [['set', 1], ['release', 1]])
    // 松手后再动不该继续平移
    pan.onPointerMove(ev(stage, { clientX: 900, clientY: 900 }))
    assert.equal(pan.panX.value, 100)
  } finally { scope.stop() }
}))

test('拖到边界会被夹住，不会把整张图拖出舞台留白', () => withFakeWindow(() => {
  const { pan, stage, scope } = makePan()
  try {
    pan.onPointerDown(ev(stage))
    pan.onPointerMove(ev(stage, { clientX: 5000, clientY: 5000 }))
    assert.deepEqual([pan.panX.value, pan.panY.value], [300, 150])
    pan.onPointerMove(ev(stage, { clientX: -5000, clientY: -5000 }))
    assert.deepEqual([pan.panX.value, pan.panY.value], [-300, -150])
  } finally { scope.stop() }
}))

test('未放大不启动拖动；旋转 90 度即使 zoom=1 也能拖', () => withFakeWindow(() => {
  const a = makePan({ zoom: 1 })
  try {
    assert.equal(a.pan.canPan.value, false)
    a.pan.onPointerDown(ev(a.stage))
    a.pan.onPointerMove(ev(a.stage, { clientX: 200, clientY: 200 }))
    assert.deepEqual([a.pan.panX.value, a.pan.panY.value], [0, 0])
  } finally { a.scope.stop() }

  const b = makePan({ zoom: 1, rotation: 90 })
  try {
    assert.equal(b.pan.canPan.value, true)
    b.pan.onPointerDown(ev(b.stage))
    b.pan.onPointerMove(ev(b.stage, { clientX: 0, clientY: 60 }))
    assert.equal(b.pan.panY.value, 60)
    b.pan.onPointerMove(ev(b.stage, { clientX: 0, clientY: 999 }))
    assert.equal(b.pan.panY.value, 100, '旋转态的余量按互换后的高度算')
  } finally { b.scope.stop() }
}))

test('缩回 1 倍 / 复位 / 换图：平移量归零，缩放按钮不会留下歪图', async () => withFakeWindow(async () => {
  const { pan, zoom, stage, scope, captured } = makePan()
  try {
    pan.onPointerDown(ev(stage))
    pan.onPointerMove(ev(stage, { clientX: 200, clientY: 100 }))
    assert.equal(pan.panX.value, 200)
    zoom.value = 1
    await vue.nextTick()
    assert.deepEqual([pan.panX.value, pan.panY.value], [0, 0], 'zoom 变化要重新 clamp')

    zoom.value = 3
    await vue.nextTick()
    pan.onPointerDown(ev(stage))
    pan.onPointerMove(ev(stage, { clientX: 150, clientY: 0 }))
    assert.ok(pan.panX.value > 0)
    pan.reset()
    assert.deepEqual([pan.panX.value, pan.panY.value], [0, 0])
    assert.equal(pan.panning.value, false)
    assert.ok(captured.some(c => c[0] === 'release'), '拖动中被换图也要释放指针捕获')
  } finally { scope.stop() }
}))

test('pointercancel 与别的指针都不会留下半截拖动', () => withFakeWindow(() => {
  const { pan, stage, scope } = makePan()
  try {
    pan.onPointerDown(ev(stage))
    pan.onPointerMove(ev(stage, { clientX: 10, clientY: 10, pointerId: 2 }))
    assert.equal(pan.panX.value, 0, '别的 pointerId 不该参与')
    pan.onPointerCancel(ev(stage))
    assert.equal(pan.panning.value, false)
    pan.onPointerMove(ev(stage, { clientX: 200, clientY: 200 }))
    assert.equal(pan.panX.value, 0)
  } finally { scope.stop() }
}))

test('resize 会按新舞台尺寸重算余量；作用域结束会撤掉监听器', () => withFakeWindow((listeners) => {
  assert.ok(listeners.has('resize') === false, '还没创建 composable，不该有监听')
  const { pan, stage, scope } = makePan()
  try {
    assert.ok(listeners.has('resize'), '必须监听窗口尺寸变化，否则改窗口后平移量会越界')
    pan.onPointerDown(ev(stage))
    pan.onPointerMove(ev(stage, { clientX: 200, clientY: 100 }))
    assert.equal(pan.panX.value, 200)
    stage.clientWidth = 1600 // 窗口变宽变高，2 倍图刚好装下 → 两轴余量都归零
    stage.clientHeight = 900
    listeners.get('resize')()
    assert.deepEqual([pan.panX.value, pan.panY.value], [0, 0])
  } finally { scope.stop() }
  assert.equal(listeners.has('resize'), false, 'disposables 没撤掉 resize 监听（组件级资源泄漏）')
}))

// ---------- C. 接线源码判据 ----------

const TEMPLATE_PAN_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']

/** 模板区（<template> 到 </template>） */
function templateOf(src) {
  const start = src.indexOf('<template>')
  const end = src.lastIndexOf('</template>')
  assert.ok(start >= 0 && end > start, '找不到 template 区')
  return src.slice(start, end)
}

/** <script setup> 顶层可见的名字（含解构别名），Vapor 模板只认这些 */
function topLevelNames(src) {
  const names = new Set()
  for (const m of src.matchAll(/\b(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  // 解构 `const { style: viewerStyle, stageClass, ... } = useViewerPan(...)`：
  // 右侧别名和裸名都是顶层绑定，左侧属性名不是，但一起收进来不影响判据
  const hit = src.indexOf('} = useViewerPan(')
  assert.ok(hit > 0, '找不到 useViewerPan 的解构')
  const open = src.lastIndexOf('const {', hit)
  assert.ok(open > 0 && open < hit, '找不到解构开头')
  const block = src.slice(open, hit)
  for (const m of block.matchAll(/[A-Za-z_$][\w$]*/g)) names.add(m[0])
  return names
}

for (const [label, file, styleName] of [
  ['相册页内联查看器（Vapor）', ALBUM, 'viewerStyle'],
  ['MediaViewer 复用组件（收据弹窗）', MEDIA, 'mediaStyle'],
]) {
  test(`${label}：模板四个 pointer 事件、ref、class 都挂上了`, () => {
    const tmpl = templateOf(read(file))
    assert.match(tmpl, /class="[^"]*viewer-pan-surface/, '舞台缺 viewer-pan-surface 常量类')
    assert.match(tmpl, /ref="stageEl"/, '舞台缺 ref，量不到可视余量')
    assert.match(tmpl, /ref="mediaEl"/, 'img 缺 ref，量不到布局尺寸')
    assert.match(tmpl, /stageClass\]/, '舞台缺 :class 里的 stageClass')
    assert.match(tmpl, /:class="mediaClass"/, 'img 缺 mediaClass（拖动时补间掐不掉）')
    assert.match(tmpl, new RegExp(`:style="${styleName}"`), 'transform 没绑到 composable 产出的 style')
    for (const evt of TEMPLATE_PAN_EVENTS) {
      assert.match(tmpl, new RegExp(`@${evt}="onPan[A-Za-z]+"`), `模板缺 @${evt}`)
    }
  })

  test(`${label}：模板引用的 pan 名字全都解构到了 setup 顶层`, () => {
    const src = read(file)
    const visible = topLevelNames(src)
    const tmpl = templateOf(src)
    const used = new Set()
    for (const m of tmpl.matchAll(/@(?:pointerdown|pointermove|pointerup|pointercancel)="\s*([A-Za-z_$][\w$]*)\s*"/g)) used.add(m[1])
    for (const m of tmpl.matchAll(/:class="\[[^\]]*\b(stageClass|mediaClass)\b/g)) used.add(m[1])
    for (const m of tmpl.matchAll(/:class="(mediaClass)"/g)) used.add(m[1])
    for (const m of tmpl.matchAll(/:style="(viewerStyle|mediaStyle)"/g)) used.add(m[1])
    assert.ok(used.size >= 7, `解析出的模板绑定太少（${used.size}），提取规则可能失效`)
    const missing = [...used].filter(n => !visible.has(n)).sort()
    assert.deepEqual(missing, [],
      `这些名字在模板里用了、却不在 <script setup> 顶层 → Vapor 下静默失效（点了没反应）：\n  ${missing.join('\n  ')}`)
  })

  test(`${label}：换图 / 复位 / 关闭都调用了 resetPan，不留上一张的位移`, () => {
    const src = read(file)
    const hits = src.match(/resetPan\(\)/g) || []
    assert.ok(hits.length >= 2, `resetPan 只出现 ${hits.length} 次：换图、复位、关闭这些路径都要清`)
    assert.match(src, /resetView\(\) \{[\s\S]{0,160}resetPan\(\)/, '复位按钮没清平移量')
    if (file === ALBUM) {
      assert.match(src, /const reopening = !!viewer\.value\s*\r?\n\s*resetPan\(\)/, '换图/翻页没清平移量')
      assert.match(src, /function closeViewer\(\) \{ resetPan\(\);/, '关闭查看器没清平移量')
    } else {
      assert.match(src, /watch\(\(\) => \[props\.visible, props\.index\][\s\S]{0,160}resetPan\(\)/,
        'visible/index 变化（打开、换项、关闭）没清平移量')
    }
    assert.match(src, /useViewerPan\(\{ zoom, rotation, stageRef: stageEl, mediaRef: mediaEl \}\)/,
      'composable 没接上两个 ref')
    assert.doesNotMatch(src, /const (?:viewerStyle|mediaStyle) = computed\(/,
      '还在用旧的本地 computed 拼 rotate/scale，平移会丢失')
  })
}

test('transform 由 composable 单一产出，顺序是 translate → rotate → scale', () => {
  const code = read(PAN)
  assert.match(code, /transform: `translate\(\$\{panX\.value\}px, \$\{panY\.value\}px\) rotate\(\$\{rotation\.value\}deg\) scale\(\$\{zoom\.value\}\)`/,
    'translate 不在最外层 → 拖 1px 会被放大成 zoom 倍，手感失控')
  assert.match(code, /setPointerCapture\(e\.pointerId\)/, '没捕获指针，甩出舞台会断连')
  assert.match(code, /watch\(\[zoom, rotation\], \(\) => \{ clamp\(\) \}\)/, 'zoom/rotation 变化后没重新夹边界')
  assert.match(code, /d\.listen\(window, 'resize', \(\) => \{ clamp\(\) \}\)/, 'resize 没重新夹边界')
  assert.match(code, /useDisposables\(\)/, 'resize 监听器必须随组件作用域释放')
})

test('utils/viewerPan.js 是零依赖纯函数，且旋转按宽高互换算', () => {
  const code = read(UTIL)
  assert.doesNotMatch(code, /^\s*import /m, '纯函数文件不该 import Vue/DOM')
  assert.match(code, /const swapped = Math\.abs\(rotation % 180\) !== 0/, '旋转态没换宽高')
  assert.match(code, /Math\.min\(max, Math\.max\(-max,/, 'clamp 必须双向')
})

test('样式：未放大不给手型、拖动时掐掉 transition、触屏不被滚屏抢走', () => {
  const css = read(CSS)
  assert.match(css, /\.album-viewer \.viewer-pan-surface \{[\s\S]{0,120}touch-action: none;/,
    '缺 touch-action:none，触屏拖不动')
  assert.match(css, /\.album-viewer \.viewer-pan-surface\.viewer-can-pan \{\s*cursor: grab;/)
  assert.match(css, /\.album-viewer \.viewer-pan-surface\.viewer-panning \{\s*cursor: grabbing;/)
  assert.match(css, /\.album-viewer \.viewer-media\.viewer-panning \{\s*transition: none !important;/,
    '拖动时不掐掉 duration-100 会慢半拍')
})
