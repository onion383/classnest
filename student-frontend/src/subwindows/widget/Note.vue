<template>
  <div class="note-root">
    <!-- ====== 加载界面 ====== -->
    <div v-if="noteState === 'loading'" class="screenshot">
      <div class="header">
        <IconGlyph name="note" :size="16" />
        <span>屏幕注释</span>
      </div>
      <div class="content">
        <div class="result-area">
          <div class="icon-wrapper">
            <div class="spinner"></div>
          </div>
          <div class="status-text">注释加载中...</div>
        </div>
      </div>
      <div class="actions">
        <button class="btn-primary" @click="close">取消</button>
      </div>
    </div>

    <!-- ====== 保存中 / 已保存 ====== -->
    <div v-else-if="noteState === 'saving' || noteState === 'saved' || noteState === 'saveError'" class="screenshot">
      <div class="header">
        <IconGlyph name="note" :size="16" />
        <span>屏幕注释</span>
      </div>
      <div class="content">
        <div class="result-area">
          <div class="icon-wrapper">
            <div v-if="noteState === 'saving'" class="spinner"></div>
            <svg v-else-if="noteState === 'saved'" class="status-icon flat-check" viewBox="0 0 24 24" width="36" height="36">
              <path fill="none" stroke="var(--color-primary, #22c55e)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="M4 12.5l5 5L20 6.5" />
            </svg>
            <IconGlyph v-else name="error" :size="36" class="status-icon" />
          </div>
          <div class="status-text">{{ saveStatusText }}</div>
          <div class="file-path" :title="saveFilePath">{{ saveDisplayPath }}</div>
        </div>
      </div>
      <div class="actions">
        <button
          class="btn-primary"
          :disabled="noteState === 'saving'"
          @click="confirmSave"
        >完成</button>
      </div>
    </div>

    <!-- ====== 编辑界面 ====== -->
    <template v-else>
      <div class="canvas-area" ref="canvasArea" @pointerdown="onCanvasPointerDown">
        <canvas ref="bgCanvas" class="bg-canvas"></canvas>
        <canvas ref="hlCanvas" class="hl-canvas" :style="{ opacity: HL_OPACITY }"></canvas>
        <canvas
          ref="drawCanvas"
          class="draw-canvas"
          :style="{ cursor: eraserCursor }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @lostpointercapture="onPointerUp"
          @contextmenu.prevent
        ></canvas>
      </div>

      <!-- 浮动工具栏 -->
      <div
        class="note-toolbar"
        ref="toolbarRef"
        :style="{ left: toolbarPos.x + 'px', top: toolbarPos.y + 'px' }"
      >
        <div class="tb-drag-bar" @pointerdown="onToolbarDragStart">
          <div class="tb-drag-dot"></div>
        </div>
        <div class="tb-body">
          <!-- 主按钮行 -->
          <div class="tb-group">
            <button
              class="tb-btn"
              :class="{ active: !isEraser }"
              @click.stop="toggleSub('brush')"
            >
              <IconGlyph name="brush" :size="16" class="tb-icon" />
              <span class="tb-label">画笔</span>
            </button>
            <button
              class="tb-btn"
              :class="{ active: isEraser }"
              @click.stop="toggleSub('eraser')"
            >
              <IconGlyph name="eraser" :size="16" class="tb-icon" />
              <span class="tb-label">橡皮擦</span>
            </button>
            <button class="tb-btn" @click="startSave">
              <IconGlyph name="save" :size="16" class="tb-icon" />
              <span class="tb-label">保存</span>
            </button>
            <button class="tb-btn" @click="close">
              <IconGlyph name="close" :size="16" class="tb-icon" />
              <span class="tb-label">关闭</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 浮动二级菜单（悬浮在工具栏上方，从工具栏一侧浮现/收回） -->
      <Transition name="tb-sub-pop">
      <div
        v-if="subTool"
        :key="subTool"
        class="tb-sub-float"
        ref="subRef"
        :style="subStyle"
        @pointerdown.stop
      >
        <!-- 画笔二级菜单 -->
        <template v-if="subTool === 'brush'">
          <div class="tb-sub-row">
            <button
              v-for="t in brushTools"
              :key="t.id"
              class="tb-btn-sub"
              :class="{ active: currentTool === t.id }"
              @click="currentTool = t.id"
            >
              <IconGlyph :name="t.id" :size="14" class="tb-icon-sm" />
              <span class="tb-label">{{ t.name }}</span>
            </button>
          </div>
          <div class="tb-sub-row">
            <span class="tb-sub-label">粗细</span>
            <input type="range" min="1" max="30" v-model.number="brushSize" class="tb-slider" />
            <span class="tb-size">{{ brushSize }}</span>
          </div>
          <div class="tb-sub-row">
            <ColorSwatch v-model="brushColor" :presetColors="['#ef4444', '#000000', '#3b82f6']" />
          </div>
        </template>

        <!-- 橡皮擦二级菜单 -->
        <template v-if="subTool === 'eraser'">
          <div class="tb-sub-row">
            <span class="tb-sub-label">大小</span>
            <input type="range" min="5" max="40" v-model.number="eraserSize" class="tb-slider" />
            <span class="tb-size">{{ eraserSize }}</span>
          </div>
        </template>
      </div>
      </Transition>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue'
import ColorSwatch from '../../components/base/ColorSwatch.vue'
import IconGlyph from '../../components/base/IconGlyph.vue'
import axios from 'axios'
import { calcW, drawCurveSegment } from './Note.curve.js'
import { INVOKE } from '../../electronChannels.js'
import { hideForCapture, restoreAfterCapture } from './captureHide.js'
import { useDisposables } from '../../utils/disposables.js'

const emit = defineEmits(['close', 'ready', 'shrink'])

// 荧光笔的不透明度**只在合成时生效**，必须两端用同一个值：
//   · 屏幕上是 CSS opacity（整层一起变淡，笔画交叠处不会越描越黑）
//   · 导出时要把同一层叠到临时画布上，CSS opacity 不进位图 —— 不补 globalAlpha
//     导出的 PNG 里高亮就是全不透明的实色，盖住底下的字。
// 值写在这里、模板 inline style 与导出两处都引用它，避免改一处忘另一处。
const HL_OPACITY = 0.35

const canvasArea = ref(null)
const bgCanvas = ref(null)
const hlCanvas = ref(null)
const drawCanvas = ref(null)
const toolbarRef = ref(null)
const subRef = ref(null)
const toolbarPos = reactive({ x: 20, y: Math.max(0, window.innerHeight - 60 - 20) })

const noteState = ref('loading')
const saveFilePath = ref('')
const saveError = ref('')
let autoCloseTimer = null

// 资源登记表：拖拽期挂在 document 上的监听器、截屏加载链、收尾定时器都登记在这里，
// 组件卸载时统一释放（原先拖拽中途卸载 → 监听器永久留在 document 上）。
const disposables = useDisposables()
// 卸载标志：截屏/保存是异步链，卸载后仍会往下走；每一步 await 之后都要先看它。
let disposed = false

const saveStatusText = computed(() => {
  if (noteState.value === 'saving') return '正在保存...'
  if (noteState.value === 'saveError') return saveError.value || '保存失败'
  return '注释已保存'
})

const saveDisplayPath = computed(() => {
  if (saveFilePath.value) {
    const parts = saveFilePath.value.split(/[\\/]/)
    if (parts.length <= 3) return saveFilePath.value
    return '...' + parts.slice(-2).join('/')
  }
  return '保存至：图片/screenshots/'
})

const currentTool = ref('ballpoint')
const brushColor = ref('#ef4444')
const brushSize = ref(3)
const eraserSize = ref(20)
const subTool = ref(null) // null | 'brush' | 'eraser'

const isEraser = computed(() => currentTool.value === 'eraser')

// 橡皮擦光标：灰色半透明圆形
const eraserCursor = computed(() => {
  if (!isEraser.value) return 'crosshair'
  const s = Math.max(eraserSize.value, 12)
  const r = s / 2
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><circle cx="${r}" cy="${r}" r="${r - 1}" fill="rgba(128,128,128,0.2)" stroke="rgba(128,128,128,0.4)" stroke-width="1"/></svg>`
  return `url(data:image/svg+xml;base64,${btoa(svg)}) ${r} ${r}, auto`
})

// id 同时作为 IconGlyph 的图标 key（见 IconGlyph.vue 的 MAP）
const brushTools = [
  { id: 'ballpoint', name: '圆珠笔' },
  { id: 'pen', name: '钢笔' },
  { id: 'highlighter', name: '荧光笔' },
]

// 二级菜单悬浮样式：位于工具栏上方，用 bottom 定位避免遮挡
const subStyle = computed(() => {
  if (!toolbarRef.value) return { display: 'none' }
  const tbW = toolbarRef.value.offsetWidth
  const gap = 8
  return {
    left: toolbarPos.x + 'px',
    bottom: (window.innerHeight - toolbarPos.y + gap) + 'px',
    minWidth: tbW + 'px',
  }
})

function toggleSub(tool) {
  if (tool === 'eraser') {
    currentTool.value = 'eraser'
  } else if (currentTool.value === 'eraser') {
    currentTool.value = 'ballpoint'
  }
  subTool.value = subTool.value === tool ? null : tool
}

// 多指同时书写：每根手指/笔各一套独立缓冲，按 pointerId 分桶。
// 原先的 isDrawing / pointBuffer / widthSmooth 是模块级单例 —— 第二根手指按下会把
// 第一根的缓冲重置掉，所以只能画一条。改成 Map 后，按下的指针互不干扰。
// 桶内字段：
//   cfg      下笔瞬间的工具快照（粗细/颜色/是否橡皮）——不能每帧现读 currentTool，
//            否则一指在画、另一指去点工具栏切橡皮，正在画的笔画下一段会变成橡皮
//   buf      Catmull-Rom 点缓冲 [{x, y, w, time}]
//   widths   宽度平滑缓冲，减少钢笔笔锋抖动
//   target   该笔落到哪块画布（荧光笔 → hlCanvas，其余 → drawCanvas）
//   scale    canvas 内部分辨率 / CSS 显示尺寸，move 时用来把距离换算回 CSS 像素
const strokes = new Map()
// 画布的显示矩形（CSS 像素）。每笔起始时刷新一次，move 高频阶段复用：
// 多指 × 60~120Hz 每次 move 都 getBoundingClientRect 会连续触发强制布局。
let canvasRect = null
let bgImage = null
let canvasW = 0, canvasH = 0

// 工具栏拖拽
let tbDragging = false, tbStart = { x: 0, y: 0 }, tbPosStart = { x: 0, y: 0 }
let toolbarPlaced = false

function onToolbarDragStart(e) {
  if (e.target.tagName === 'INPUT') return
  if (tbDragging) return
  if (e.pointerType === 'mouse' && e.button !== 0) return
  e.preventDefault()
  tbDragging = true
  // document 上的 pointermove 会收到**所有**指针的移动：多指时另一根手指在画布上
  // 滑动不该把工具栏一起拖走，所以只认发起拖拽的那个 pointerId。
  const pid = e.pointerId
  tbStart = { x: e.clientX, y: e.clientY }
  tbPosStart = { x: toolbarPos.x, y: toolbarPos.y }
  // 监听器登记到资源表：鼠标松开时正常移除，但**拖拽途中组件被卸载**时，
  // onUp 永远不会执行 → 原先这两个监听器会永久留在 document 上。
  let cancelMove = null
  let cancelUp = null
  let cancelCancel = null
  const onMove = (ev) => {
    if (!tbDragging || ev.pointerId !== pid || !toolbarRef.value) return
    const w = toolbarRef.value.offsetWidth
    const h = toolbarRef.value.offsetHeight
    let nx = tbPosStart.x + ev.clientX - tbStart.x
    let ny = tbPosStart.y + ev.clientY - tbStart.y
    nx = Math.max(0, Math.min(nx, window.innerWidth - w))
    ny = Math.max(0, Math.min(ny, window.innerHeight - h))
    toolbarPos.x = nx
    toolbarPos.y = ny
  }
  const onUp = (ev) => {
    if (ev && ev.pointerId !== pid) return
    tbDragging = false
    toolbarPlaced = true
    if (cancelMove) cancelMove()
    if (cancelUp) cancelUp()
    if (cancelCancel) cancelCancel()
    cancelMove = null
    cancelUp = null
    cancelCancel = null
  }
  cancelMove = disposables.listen(document, 'pointermove', onMove)
  cancelUp = disposables.listen(document, 'pointerup', onUp)
  // 触摸被系统手势/窗口切换打断时没有 pointerup，只有 pointercancel → 不收尾就永远卡在拖拽态
  cancelCancel = disposables.listen(document, 'pointercancel', onUp)
}

// 绘制
function toolCfg() {
  const s = eraserSize.value
  const b = brushSize.value
  switch (currentTool.value) {
    case 'ballpoint': return { w: b, minW: b, maxW: b, color: brushColor.value, alpha: 1 }
    case 'pen': return { w: b, minW: Math.max(1, b / 4), maxW: b, color: brushColor.value, alpha: 1 }
    case 'highlighter': return { w: b, minW: b, maxW: b, color: brushColor.value, alpha: 1 }
    case 'eraser': return { w: s, minW: s, maxW: s, color: '#000', alpha: 1, isEraser: true }
    default: return { w: 3, minW: 3, maxW: 3, color: '#000', alpha: 1 }
  }
}


function pos(e) {
  // canvasRect 在 pointerdown 时刷新一次，move 阶段直接复用（多指高频 move 每次
  // getBoundingClientRect 都会强制布局）
  const r = canvasRect || drawCanvas.value.getBoundingClientRect()
  const cssX = e.clientX - r.left
  const cssY = e.clientY - r.top
  // CSS 显示尺寸和 canvas 内部分辨率可能不同，需要缩放坐标
  return {
    x: cssX * (canvasW / r.width),
    y: cssY * (canvasH / r.height)
  }
}

// 橡皮擦同时擦两层：荧光笔层在导出时才叠到 drawCanvas 之下，必须一起擦
function eraseAt(x, y, w) {
  const layers = [drawCanvas.value, hlCanvas.value]
  layers.forEach(c => {
    const ec = c.getContext('2d')
    ec.globalCompositeOperation = 'destination-out'
    ec.beginPath()
    ec.arc(x, y, w / 2, 0, Math.PI * 2)
    ec.fill()
    ec.globalCompositeOperation = 'source-over'
  })
}

// 画一段曲线。多指共用同一个 canvas context 是安全的：这里每次都重设
// strokeStyle / globalAlpha / lineCap，lineWidth 由 drawCurveSegment 逐段设置并
// 自己 beginPath，不存在跨指针的状态残留（所以别在这条链上引入 rAF 延迟批处理，
// 一旦跨越帧，多指针的上下文状态就会互相污染）。
function drawSegment(st, p0, p1, p2, p3) {
  if (st.isEraser) {
    const layers = [drawCanvas.value, hlCanvas.value]
    layers.forEach(c => {
      const ec = c.getContext('2d')
      ec.globalCompositeOperation = 'destination-out'
      ec.strokeStyle = 'rgba(0,0,0,1)'
      ec.lineCap = 'round'; ec.lineJoin = 'round'
      drawCurveSegment(ec, p0, p1, p2, p3)
      ec.globalCompositeOperation = 'source-over'
    })
    return
  }
  const ctx = st.target.getContext('2d')
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.strokeStyle = st.cfg.color
  ctx.globalAlpha = st.cfg.alpha
  drawCurveSegment(ctx, p0, p1, p2, p3)
  ctx.globalAlpha = 1
}

// 起笔：为一根手指/笔建一套独立状态
function onPointerDown(e) {
  if (!bgImage) return
  // 同一指针重复 down（浏览器合成事件重发）不能把新建的缓冲重置掉
  if (strokes.has(e.pointerId)) return
  // 鼠标只认左键；触摸/笔的 button 恒为 0，不做限制
  if (e.pointerType === 'mouse' && e.button !== 0) return

  // 每笔起始刷新一次显示矩形：窗口位置/尺寸变化（全屏切换、居中）后旧矩形会失效
  const r = drawCanvas.value.getBoundingClientRect()
  canvasRect = { left: r.left, top: r.top, width: r.width, height: r.height }

  const p = pos(e)
  // 工具配置在下笔瞬间快照：多指时另一根手指可能去点工具栏切换工具，
  // 若 move 里现读 currentTool，正在画的这一笔会被中途改成别的笔/橡皮
  const cfg = toolCfg()
  const isHL = currentTool.value === 'highlighter'
  const st = {
    cfg,
    isEraser: !!cfg.isEraser,
    target: isHL ? hlCanvas.value : drawCanvas.value,
    buf: [
      { x: p.x, y: p.y, w: cfg.w, time: e.timeStamp },
      { x: p.x, y: p.y, w: cfg.w, time: e.timeStamp }
    ],
    widths: [cfg.w],
    // canvas 内部分辨率 = 截图原始分辨率，高分辨率下坐标被放大，
    // 若直接用画布像素算速度，测得的速度会被放大数十倍，钢笔笔锋会立刻衰减到最细。
    // 这里预先存好换算系数，move 时统一换算回 CSS 像素再算速度。
    scale: r.width > 0 ? canvasW / r.width : 1
  }
  strokes.set(e.pointerId, st)

  // 捕获指针：手指滑出画布（甚至滑到工具栏下方）仍能收到 move，笔画不断；
  // 不捕获的话触摸一离开元素就只剩 pointercancel，线直接断掉。
  try {
    drawCanvas.value.setPointerCapture(e.pointerId)
  } catch (_) {
    // 指针已失效（极短触碰），忽略即可，后续靠 pointercancel 收尾
  }

  if (st.isEraser) {
    eraseAt(p.x, p.y, cfg.w)
  } else {
    const ctx = st.target.getContext('2d')
    ctx.beginPath()
    ctx.fillStyle = cfg.color
    ctx.arc(p.x, p.y, cfg.w / 2, 0, Math.PI * 2)
    ctx.fill()
  }
}

function onPointerMove(e) {
  const st = strokes.get(e.pointerId)
  if (!st) return
  const p = pos(e)
  const now = e.timeStamp
  const lastPt = st.buf[st.buf.length - 1]
  const dt = Math.max(now - lastPt.time, 1)
  const dist = Math.hypot(p.x - lastPt.x, p.y - lastPt.y) / st.scale
  const speed = dist / dt

  // 宽度平滑：移动平均，减少速度突变导致的笔锋抖动
  let width = calcW(speed, st.cfg)
  st.widths.push(width)
  if (st.widths.length > 4) st.widths.shift()
  width = st.widths.reduce((a, b) => a + b, 0) / st.widths.length

  // 追加采样点到缓冲
  st.buf.push({ x: p.x, y: p.y, w: width, time: now })

  // 绘制只用到最后 4 个点（收尾用最后 3 个），所以缓冲裁到 5 个即可。
  // 不裁的话：单手画 10 秒就是 1200 个点，十指同时画是 12000 个 —— 全是没人再读的死数据。
  if (st.buf.length > 5) st.buf.shift()

  // 缓冲满 4 个点时，用 Catmull-Rom 绘制倒数第 3→倒数第 2 点之间的平滑曲线
  if (st.buf.length >= 4) {
    const n = st.buf.length
    drawSegment(st, st.buf[n - 4], st.buf[n - 3], st.buf[n - 2], st.buf[n - 1])
  }
}

// pointerup / pointercancel / lostpointercapture 三个都会派发到这里（浏览器会连着发），
// 用「strokes 里还有没有这个 id」保证只收尾一次，缓冲随删随释放。
function onPointerUp(e) {
  const st = strokes.get(e.pointerId)
  if (!st) return
  strokes.delete(e.pointerId)

  const n = st.buf.length
  if (n < 3) return
  // 用最后 3 个点绘制末尾曲线段，P3 镜像 P2 作为终点
  drawSegment(st, st.buf[n - 3], st.buf[n - 2], st.buf[n - 1], st.buf[n - 1])
}

// 点击画布区域关闭二级菜单
function onCanvasPointerDown(e) {
  if (toolbarRef.value && toolbarRef.value.contains(e.target)) return
  if (subRef.value && subRef.value.contains(e.target)) return
  subTool.value = null
}

// 保存流程
async function startSave() {
  if (!bgImage) return
  // 先提取画布数据（此时编辑模板还在，canvas 引用有效）
  const tc = document.createElement('canvas')
  tc.width = canvasW; tc.height = canvasH
  const tctx = tc.getContext('2d')
  tctx.drawImage(bgImage, 0, 0, canvasW, canvasH)
  // 荧光笔那一层在屏幕上是靠 CSS opacity 变淡的，CSS 不会进图 —— 这里必须补上同样的 alpha，
  // 否则导出的 PNG 里高亮是全不透明的实色（文字被盖住）。整层一次 alpha，不要逐笔改，
  // 否则笔画交叠处会叠加变深，与屏幕所见不一致。
  tctx.globalAlpha = HL_OPACITY
  tctx.drawImage(hlCanvas.value, 0, 0)
  tctx.globalAlpha = 1
  tctx.drawImage(drawCanvas.value, 0, 0)

  // 切换到保存界面（白色），再收缩窗口，避免黑色 canvas 闪现
  noteState.value = 'saving'
  emit('shrink')
  await new Promise(r => setTimeout(r, 200))
  if (disposed) return

  try {
    const blob = await new Promise(r => tc.toBlob(r, 'image/png'))
    if (disposed) return
    if (!blob) {
      saveError.value = '保存失败：画布未初始化'
      noteState.value = 'saveError'
      return
    }
    const buf = await blob.arrayBuffer()
    const arr = new Uint8Array(buf)

    // 获取自定义保存路径
    let saveDir = ''
    try {
      const settingsRes = await axios.get('/api/widget-settings')
      if (disposed) return
      if (settingsRes.data.success) {
        saveDir = settingsRes.data.data.noteSavePath
      }
    } catch (_) { /* 读取设置失败则使用默认路径 */ }

    // 直接传 Uint8Array：IPC 走结构化克隆的二进制路径（内存紧凑），
    // 避免 Array.from 将每个字节装箱成 Number（全屏 PNG 会膨胀 8~16 倍）。
    const res = await window.electron.invoke(INVOKE.NOTE_SAVE, arr, { saveDir })
    if (disposed) return
    if (res.success) {
      saveFilePath.value = res.filePath
      noteState.value = 'saved'
      // 收尾定时器登记到资源表：卸载时自动清掉，不必再各自 clearTimeout
      autoCloseTimer = disposables.timeout(() => emit('close'), 3000)
    } else {
      saveError.value = '保存失败，请重试'
      noteState.value = 'saveError'
    }
  } catch (err) {
    if (disposed) return
    saveError.value = err.message || '保存失败'
    noteState.value = 'saveError'
  }
}

function confirmSave() {
  if (autoCloseTimer) {
    autoCloseTimer()
    autoCloseTimer = null
  }
  emit('close')
}

function close() {
  if (autoCloseTimer) {
    autoCloseTimer()
    autoCloseTimer = null
  }
  emit('close')
}

// 加载截图
async function loadScreenshot() {
  await new Promise(resolve => setTimeout(resolve, 500))
  // 卸载后不再往下走：后续会写 ref、emit、动 DOM，全是给已销毁的组件擦屁股
  if (disposed) return
  // 自己先藏好再抓屏。
  // 不能指望主进程的 hideWidget：浮窗是 transparent 窗口，Windows 上 setOpacity(0)
  // 对它不生效，抓出来的图里会带上本窗口「加载中」的卡片（它就成了注释的背景）。
  // 见 captureHide.js。
  await hideForCapture()
  let res
  try {
    res = await window.electron.invoke(INVOKE.SCREENSHOT_CAPTURE, { hideWidget: false })
  } finally {
    restoreAfterCapture()
  }
  if (disposed) return
  if (!res || !res.success || !res.dataUrl) {
    noteState.value = 'saveError'
    saveError.value = '截屏失败，请重试'
    return
  }
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = async () => {
      if (disposed) return
      bgImage = img
      emit('ready')
      // 先在小窗口渲染 canvas，ResizeObserver 会在全屏扩展后自动重绘
      noteState.value = 'editing'
      await nextTick()
      await new Promise(r => requestAnimationFrame(r))
      fitCanvas()
      await nextTick()
      placeToolbar()
      resolve()
    }
    img.onerror = () => {
      noteState.value = 'saveError'
      saveError.value = '图片加载失败'
      reject(new Error('Image load failed'))
    }
    img.src = res.dataUrl
  })
}

function fitCanvas() {
  if (!canvasArea.value || !bgImage) return
  const iw = bgImage.naturalWidth
  const ih = bgImage.naturalHeight
  const area = canvasArea.value
  const aw = area.clientWidth, ah = area.clientHeight

  // canvas 内部分辨率 = 截图原始分辨率（保证清晰度）
  canvasW = iw
  canvasH = ih

  // CSS 显示尺寸 = 等比缩放到适配窗口
  const scale = Math.min(aw / iw, ah / ih)
  const displayW = Math.floor(iw * scale)
  const displayH = Math.floor(ih * scale)
  const ox = Math.floor((aw - displayW) / 2)
  const oy = Math.floor((ah - displayH) / 2)

  ;[bgCanvas.value, hlCanvas.value, drawCanvas.value].forEach(c => {
    if (!c) return
    // 只有内部分辨率变化时才重设 width/height：给 canvas 赋 width/height 会清空位图，
    // 窗口缩放/布局变化时无脑重设会把用户已画的标注与笔迹全部抹掉。
    if (c.width !== canvasW || c.height !== canvasH) {
      c.width = canvasW
      c.height = canvasH
    }
    c.style.width = displayW + 'px'
    c.style.height = displayH + 'px'
    c.style.left = ox + 'px'
    c.style.top = oy + 'px'
  })
  bgCanvas.value.getContext('2d').drawImage(bgImage, 0, 0, canvasW, canvasH)
}

function placeToolbar() {
  if (toolbarPlaced || !toolbarRef.value) return
  const h = toolbarRef.value.offsetHeight
  toolbarPos.x = 20
  toolbarPos.y = Math.max(0, window.innerHeight - h - 20)
  toolbarPlaced = true
}

let ro = null
// ResizeObserver 也登记到资源表：卸载时统一断开
disposables.add(() => { if (ro) { ro.disconnect(); ro = null } })
onMounted(async () => {
  // onMounted 的 async 回调返回值无人接收：loadScreenshot 一旦抛错就是未处理的 Promise 拒绝。
  // 这里显式捕获并留日志，画布/工具栏照常初始化（没有截图时只是空画布）。
  try {
    await loadScreenshot()
  } catch (e) {
    console.error('[note] 加载截屏失败', e)
  }
  if (canvasArea.value) {
    ro = new ResizeObserver(() => {
      if (bgImage) fitCanvas()
      placeToolbar()
    })
    ro.observe(canvasArea.value)
  }
})
onUnmounted(() => {
  // 先置位：异步链每一步 await 之后都要先看它，避免卸载后继续写 ref / emit / 动 DOM
  disposed = true
  // 截屏隐藏途中被卸载（切页/关窗）时，document 上会残留 visibility:hidden，
  // 下次打开浮窗整块内容都看不见。这里补一次恢复兜底（restoreAfterCapture 幂等）。
  restoreAfterCapture()
  // 拖拽监听器、ResizeObserver、收尾定时器由资源表统一释放
})
</script>

<style scoped>
/* 作为 .tool-panel（纵向 flex）的弹性子项：加载/保存卡片（.screenshot）因此被限制在
   面板内，与其它小工具一致——能透出面板的背景图/模糊与白色薄纱，圆角随面板一起裁切。
   编辑态的画布与工具栏都是 position:fixed 的独立层（相对视口），不依赖这里的定位。 */
.note-root {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

/* ====== 和截屏一模一样的加载 / 保存界面 ====== */
.screenshot {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 与截屏窗口保持一致：标题贴顶、按钮贴底，各与毛玻璃上下边界留出固定内边距 */
  justify-content: space-between;
  /* 撑满面板剩余高度（父级 .tool-panel 已是纵向 flex），避免 height:100% 把拖动条算进去 */
  flex: 1 1 auto;
  min-height: 0;
  padding: 16px;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--color-surface, #ffffff);
}

.header {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text, #111827);
  margin-bottom: 10px;
}

.content {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 10px;
  width: 100%;
}

.result-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.icon-wrapper {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--color-border, #e5e7eb);
  border-top-color: var(--color-primary, #22c55e);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.status-icon {
  font-size: 36px;
  line-height: 44px;
}

.status-text {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text, #111827);
  height: 20px;
  line-height: 20px;
}

.file-path {
  font-size: 11px;
  color: var(--color-text-muted, #9ca3af);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: var(--color-bg, #f9fafb);
  padding: 4px 8px;
  border-radius: var(--radius-control);
  height: 24px;
  line-height: 16px;
  box-sizing: border-box;
}

.actions {
  display: flex;
  justify-content: center;
}

.btn-primary {
  padding: 6px 20px;
  border-radius: var(--radius-control);
  border: none;
  background: var(--color-primary, #22c55e);
  color: white;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.btn-primary:disabled {
  background: var(--color-text-muted, #9ca3af);
  cursor: not-allowed;
  opacity: 0.7;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

/* ====== 编辑界面 ====== */
.canvas-area {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  overflow: hidden;
  background: #000;
  /* 触屏书写的关键：不声明 none，触摸一移动就被判成滚动/捏合手势，
     浏览器直接发 pointercancel 把笔画掐断，两指还会把整个页面缩放掉。 */
  touch-action: none;
  user-select: none;
}

.bg-canvas,
.hl-canvas,
.draw-canvas {
  position: absolute;
}

.hl-canvas {
  z-index: 2;
  /* opacity 由模板 inline style 从 HL_OPACITY 注入：导出时要按同一个值合成，
     写死在 CSS 里两处会漂移（改了 CSS 忘了导出，PNG 就又不透明了） */
  pointer-events: none;
}

.draw-canvas {
  z-index: 3;
  touch-action: none;
}

/* ====== 工具栏 ====== */
.note-toolbar {
  position: fixed;
  z-index: 100;
  background: var(--color-surface, #fff);
  border-radius: var(--radius-card);
  box-shadow: 0 4px 24px rgba(0,0,0,0.35);
  border: 1px solid var(--color-border, #e5e7eb);
  user-select: none;
}

.tb-drag-bar {
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  padding-top: 4px;
  /* 触摸拖工具栏时不要被系统判成滚动手势（否则只有 pointercancel，拖不动） */
  touch-action: none;
}
.tb-drag-bar:active { cursor: grabbing; }
.tb-drag-dot {
  width: 28px; height: 3px;
  border-radius: var(--radius-xs);
  background: var(--color-text-muted, #d1d5db);
}

.tb-body {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
}

.tb-group { display: flex; align-items: center; gap: 4px; }

.tb-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  border-radius: var(--radius-control);
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  min-width: 44px;
}
.tb-btn:hover { background: var(--color-bg, #f9fafb); }
.tb-btn.active { background: var(--color-primary, #22c55e); border-color: var(--color-primary, #22c55e); }
.tb-btn.active .tb-icon,
.tb-btn.active .tb-label { color: #fff; }

.tb-icon { font-size: 16px; line-height: 1; }
.tb-label { font-size: 10px; color: var(--color-text-secondary, #6b7280); white-space: nowrap; }

/* ====== 浮动二级菜单 ====== */
.tb-sub-float {
  position: fixed;
  z-index: 101;
  background: var(--color-surface, #fff);
  border-radius: var(--radius-card);
  box-shadow: 0 4px 24px rgba(0,0,0,0.35);
  border: 1px solid var(--color-border, #e5e7eb);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  user-select: none;
  /* 浮现/收回以贴着工具栏的下边为锚点，从工具栏一侧长出来 */
  transform-origin: bottom left;
}

/* 二级菜单浮现 / 收回：直接复用工具箱面板的弹出动画（同曲线、同缩放 0.86），
   只是锚点放在下边，让菜单从工具栏一侧向上长出来 */
.tb-sub-pop-enter-active {
  transition:
    transform 0.1s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.1s ease;
}
.tb-sub-pop-leave-active {
  transition:
    transform 0.1s cubic-bezier(0.4, 0, 1, 1),
    opacity 0.1s ease;
}
.tb-sub-pop-enter-from,
.tb-sub-pop-leave-to {
  transform: scale(0.86);
  opacity: 0;
}

.tb-sub-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tb-btn-sub {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 3px 6px;
  border-radius: var(--radius-control);
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  min-width: 36px;
}
.tb-btn-sub:hover { background: var(--color-bg, #f9fafb); }
.tb-btn-sub.active { background: var(--color-primary, #22c55e); border-color: var(--color-primary, #22c55e); }
.tb-btn-sub.active .tb-icon-sm,
.tb-btn-sub.active .tb-label { color: #fff; }

.tb-icon-sm { font-size: 14px; line-height: 1; }

.tb-sub-label {
  font-size: 11px;
  color: var(--color-text-secondary, #6b7280);
  white-space: nowrap;
}

.tb-size {
  font-size: 11px;
  color: var(--color-text-secondary, #6b7280);
  min-width: 20px;
  text-align: center;
}

.tb-slider {
  width: 80px; height: 4px;
  accent-color: var(--color-primary, #22c55e);
  cursor: pointer;
}
</style>
