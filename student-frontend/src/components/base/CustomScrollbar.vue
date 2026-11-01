<template>
  <div
    v-show="visible"
    ref="rootRef"
    class="custom-scrollbar"
    :class="{ 'is-compact': compact, 'is-fixed': fixed, 'is-idle': isIdle }"
    :style="rootStyle"
    @pointerdown.prevent="onTrackPointerDown"
    @pointerenter="onBarEnter"
    @pointerleave="onBarLeave"
    @wheel.prevent="onWheel"
  >
    <button
      v-if="arrows"
      type="button"
      class="custom-scrollbar-btn is-up"
      title="向上滚动"
      @pointerdown.stop
      @click.stop="scrollByStep(-1)"
    >
      <svg class="custom-scrollbar-arrow" viewBox="0 0 12 9" aria-hidden="true">
        <path d="M2.5 7.5 L6 2.5 L9.5 7.5 Z" />
      </svg>
    </button>

    <div
      class="custom-scrollbar-thumb"
      :style="thumbStyle"
      @pointerdown.stop="onThumbPointerDown"
    ></div>

    <button
      v-if="arrows"
      type="button"
      class="custom-scrollbar-btn is-down"
      title="向下滚动"
      @pointerdown.stop
      @click.stop="scrollByStep(1)"
    >
      <svg class="custom-scrollbar-arrow" viewBox="0 0 12 9" aria-hidden="true">
        <path d="M2.5 7.5 L6 2.5 L9.5 7.5 Z" />
      </svg>
    </button>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'

/* 轨道宽度必须与 <style> 里的 .custom-scrollbar / .is-compact 保持一致：
   fixed 模式要靠它算 left（right - 轨道宽）。 */
const FULL_WIDTH = 12
const COMPACT_WIDTH = 8

const props = defineProps({
  /* 目标滚动容器。组件只负责画滚动条，不接管内容布局 */
  target: { type: Object, default: null },
  /* 是否显示上下箭头（默认 true：侧栏 / 主内容 / 表格 / 弹窗正文） */
  arrows: { type: Boolean, default: true },
  /* 细滑块变体：8px 轨道、透明底、无箭头（下拉候选 / AI 列表 / 页面内小列表） */
  compact: { type: Boolean, default: false },
  /* 悬停淡入：平时隐藏，鼠标靠近目标右缘、滚动或拖拽时淡入 */
  autoHide: { type: Boolean, default: false },
  /* 目标用 position: fixed 定位（如 Teleport 到 body 的下拉菜单）：
     此时按视口坐标定位覆盖层，而不是 offsetTop */
  fixed: { type: Boolean, default: false },
  /* 覆盖层 z-index。fixed 目标通常有很高的层级（如 Teleport 菜单），需要调用方传入更高值 */
  zIndex: { type: Number, default: 0 },
  /* 上下箭头占位高度，和样式里的按钮高度保持一致 */
  arrowHeight: { type: Number, default: 14 },
  /* 点击箭头的滚动步长 */
  scrollStep: { type: Number, default: 40 },
  /* 滑块最小高度，避免长列表里变成一条细线 */
  minThumb: { type: Number, default: 28 },
})

const rootRef = ref(null)
const visible = ref(false)
const thumbHeight = ref(0)
const thumbTop = ref(0)
const offsetTop = ref(0)
const offsetLeft = ref(0)
const trackHeight = ref(0)
/* 悬停 / 滚动 / 拖拽三个来源分别记录，任意一个成立就不进入 idle */
const hoverBar = ref(false)
const hoverTarget = ref(false)
const dragging = ref(false)
const scrolling = ref(false)

let boundEl = null
let resizeObserver = null
let mutationObserver = null
let observedChild = null
let rafId = 0
let hideTimer = 0
let dragState = null

const isIdle = computed(() => (
  props.autoHide && !hoverBar.value && !hoverTarget.value && !dragging.value && !scrolling.value
))

const thumbStyle = computed(() => ({
  height: `${thumbHeight.value}px`,
  transform: `translateY(${thumbTop.value}px)`,
}))

const rootStyle = computed(() => {
  const style = { top: `${offsetTop.value}px`, height: `${trackHeight.value}px` }
  if (props.fixed) style.left = `${offsetLeft.value}px`
  if (props.zIndex > 0) style.zIndex = `${props.zIndex}`
  return style
})

function trackWidth() {
  return props.compact ? COMPACT_WIDTH : FULL_WIDTH
}

/* 箭头占位与内容区起点：有箭头时滑块从 arrowHeight 开始，没有时从 0 开始 */
function metrics() {
  const reserved = props.arrows ? props.arrowHeight * 2 : 0
  return { reserved, inset: props.arrows ? props.arrowHeight : 0 }
}

function updateThumb() {
  const el = props.target
  if (!el || !rootRef.value) {
    visible.value = false
    return
  }
  if (props.fixed) {
    /* fixed 目标（Teleport 菜单）：offsetTop 相对视口，left 贴住目标右缘 */
    const rect = el.getBoundingClientRect()
    offsetTop.value = rect.top
    offsetLeft.value = rect.right - trackWidth()
  } else {
    /* 覆盖层与目标滚动容器是同级元素，父级必须是 position: relative；
       offsetTop 相对这个父级计算，高度直接取滚动容器的可视高度。 */
    offsetTop.value = el.offsetTop
  }
  trackHeight.value = el.clientHeight

  const view = el.clientHeight
  const content = el.scrollHeight
  if (view <= 0 || content <= view + 1) {
    visible.value = false
    return
  }

  const { reserved, inset } = metrics()
  const available = view - reserved
  if (available <= 0) {
    visible.value = false
    return
  }

  visible.value = true
  thumbHeight.value = Math.min(
    available,
    Math.max(props.minThumb, available * (view / content)),
  )
  const maxTop = available - thumbHeight.value
  const maxScroll = content - view
  thumbTop.value = maxScroll > 0
    ? inset + (el.scrollTop / maxScroll) * maxTop
    : inset
}

function observeFirstChild() {
  const el = props.target
  if (!el || !resizeObserver) return
  const first = el.firstElementChild
  if (first === observedChild) return
  if (observedChild) resizeObserver.unobserve(observedChild)
  observedChild = first
  if (first) resizeObserver.observe(first)
}

/* MutationObserver / ResizeObserver 可能一次触发很多条，统一用 rAF 合并 */
function scheduleUpdate() {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    updateThumb()
    observeFirstChild()
  })
}

/* 悬停淡入的三种触发来源 -------------------------------------------------- */

function showTemporarily() {
  if (!props.autoHide) return
  scrolling.value = true
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => { scrolling.value = false }, 700)
}

function onTargetScroll() {
  showTemporarily()
  scheduleUpdate()
}

/* 只在鼠标靠近目标右缘时淡入，避免「鼠标一进入列表滚动条就冒出来」 */
function onTargetPointerMove(e) {
  if (!props.autoHide) return
  const el = props.target
  if (!el) return
  const rect = el.getBoundingClientRect()
  hoverTarget.value = e.clientX >= rect.right - 18
}

function onTargetPointerLeave() {
  hoverTarget.value = false
}

function onBarEnter() {
  hoverBar.value = true
}

function onBarLeave() {
  hoverBar.value = false
}

function bind(el) {
  unbind()
  if (!el) {
    updateThumb()
    return
  }
  boundEl = el
  /* 滚动 / 尺寸变化都走 rAF 合并：滚动事件本身每帧一次，再叠加 mutation 回调时
     如果各自同步读 scrollHeight，会把一帧里的多次布局读取放大。 */
  el.addEventListener('scroll', onTargetScroll, { passive: true })
  if (props.autoHide) {
    el.addEventListener('pointermove', onTargetPointerMove, { passive: true })
    el.addEventListener('pointerleave', onTargetPointerLeave)
  }
  resizeObserver = new ResizeObserver(scheduleUpdate)
  resizeObserver.observe(el)
  /* 只观察直接子节点增删（如表格 ↔ 空态切换）：深层内容变化会改变首个子元素的高度，
     交给上面的 ResizeObserver 处理，避免大表格/AI 流式输出时每帧触发一次布局读取。 */
  mutationObserver = new MutationObserver(scheduleUpdate)
  mutationObserver.observe(el, { childList: true })
  observeFirstChild()
  updateThumb()
}

function unbind() {
  if (boundEl) {
    boundEl.removeEventListener('scroll', onTargetScroll)
    boundEl.removeEventListener('pointermove', onTargetPointerMove)
    boundEl.removeEventListener('pointerleave', onTargetPointerLeave)
  }
  if (resizeObserver) resizeObserver.disconnect()
  if (mutationObserver) mutationObserver.disconnect()
  resizeObserver = null
  mutationObserver = null
  observedChild = null
  boundEl = null
}

function scrollByStep(direction) {
  const el = props.target
  if (!el) return
  el.scrollBy({ top: direction * props.scrollStep, behavior: 'smooth' })
}

/* 滚轮落在滚动条覆盖层上时，转交给目标容器。
   覆盖层是滚动容器的兄弟节点，不做转发的话在右侧 12px 上滚轮会去滚整页/弹窗。 */
function onWheel(e) {
  const el = props.target
  if (!el) return
  el.scrollTop += e.deltaY
}

function onThumbPointerDown(e) {
  if (e.button !== 0) return
  const el = props.target
  if (!el) return
  dragState = { y: e.clientY, top: thumbTop.value }
  dragging.value = true
  e.preventDefault()
  window.addEventListener('pointermove', onThumbPointerMove)
  window.addEventListener('pointerup', onThumbPointerUp, { once: true })
}

function onThumbPointerMove(e) {
  const el = props.target
  if (!el || !dragState) return
  const { reserved, inset } = metrics()
  const available = el.clientHeight - reserved
  const maxTop = available - thumbHeight.value
  if (maxTop <= 0) return
  const nextTop = Math.min(
    inset + maxTop,
    Math.max(inset, dragState.top + (e.clientY - dragState.y)),
  )
  const maxScroll = el.scrollHeight - el.clientHeight
  const ratio = (nextTop - inset) / maxTop
  el.scrollTop = ratio * maxScroll
}

function onThumbPointerUp() {
  dragState = null
  dragging.value = false
  window.removeEventListener('pointermove', onThumbPointerMove)
  window.removeEventListener('pointerup', onThumbPointerUp)
}

function onTrackPointerDown(e) {
  if (e.button !== 0) return
  const el = props.target
  const root = rootRef.value
  if (!el || !root) return
  const { reserved, inset } = metrics()
  const available = root.clientHeight - reserved
  const maxTop = available - thumbHeight.value
  if (maxTop <= 0) return
  const clickTop = e.clientY - root.getBoundingClientRect().top - inset - thumbHeight.value / 2
  const nextTop = Math.min(inset + maxTop, Math.max(inset, clickTop))
  const maxScroll = el.scrollHeight - el.clientHeight
  el.scrollTop = ((nextTop - inset) / maxTop) * maxScroll
}

onMounted(() => {
  nextTick(() => bind(props.target))
  window.addEventListener('resize', scheduleUpdate)
  /* fixed 目标会随页面滚动改变视口位置，需要跟着重算 */
  if (props.fixed) window.addEventListener('scroll', scheduleUpdate, true)
})

watch(() => props.target, (el) => {
  nextTick(() => bind(el))
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', scheduleUpdate)
  if (props.fixed) window.removeEventListener('scroll', scheduleUpdate, true)
  window.removeEventListener('pointermove', onThumbPointerMove)
  window.removeEventListener('pointerup', onThumbPointerUp)
  clearTimeout(hideTimer)
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  unbind()
})
</script>

<style scoped>
/* 外层胶囊轨道 + 上下箭头 + 中间 8px 滑块，几何与原生滚动条对齐。
   颜色沿用 --sidebar-* 变量，base / glass / glass2 三个主题不用重复写组件样式。
   compact（细滑块）变体：8px 透明轨道，无箭头，用于下拉候选 / AI 列表 / 页面内小列表。 */
.custom-scrollbar {
  position: absolute;
  right: 0;
  width: 12px;
  z-index: 5;
  touch-action: none;
  background: var(--sidebar-track, rgba(100, 116, 139, 0.08));
  border-radius: 6px;
  transition: opacity 0.18s ease;
}

/* 细滑块：轨道完全透明，只留一条很细的滑块 */
.custom-scrollbar.is-compact {
  width: 8px;
  border-radius: 4px;
  background: transparent;
}

/* 悬停淡入：idle 时透明且不拦截事件（鼠标穿过时落到下面的内容上） */
.custom-scrollbar.is-idle {
  opacity: 0;
  pointer-events: none;
}

/* 目标为 fixed 定位（Teleport 菜单）：覆盖层也用 fixed，left 由内联样式给 */
.custom-scrollbar.is-fixed {
  position: fixed;
  right: auto;
}

.custom-scrollbar-btn {
  position: absolute !important;
  left: 0;
  width: 100%;
  height: 14px;
  padding: 0 !important;
  margin: 0;
  border: 0 !important;
  border-radius: 2px !important;
  background: transparent !important;
  box-shadow: none !important;
  appearance: none;
  -webkit-appearance: none;
  color: var(--sidebar-arrow, rgba(100, 116, 139, 0.7));
  cursor: pointer;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.18s ease, color 0.18s ease;
}

/* 关掉 glass 主题给 button::before 加的荧光描边环 */
.custom-scrollbar-btn::before {
  display: none !important;
  content: none !important;
}

.custom-scrollbar-arrow {
  width: 12px;
  height: 9px;
  display: block;
  fill: currentColor;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linejoin: round;
  pointer-events: none;
}

.custom-scrollbar-btn.is-up {
  top: 0;
}

.custom-scrollbar-btn.is-down {
  bottom: 0;
}

.custom-scrollbar-btn.is-down .custom-scrollbar-arrow {
  transform: rotate(180deg);
}

.custom-scrollbar-btn:hover {
  color: var(--sidebar-arrow-hover, rgba(71, 85, 105, 0.95));
  background: var(--sidebar-arrow-bg-hover, rgba(100, 116, 139, 0.12)) !important;
}

.custom-scrollbar-thumb {
  position: absolute;
  left: 2px;
  top: 0;
  width: calc(100% - 4px);
  border-radius: 4px;
  background: var(--sidebar-thumb, rgba(100, 116, 139, 0.35));
  transition: background-color 0.24s ease;
  cursor: pointer;
  z-index: 1;
  /* 滑块每帧只改 transform：提前提成一个合成层，滚动时由合成器平移，避免主线程重绘。
     尺寸很小（8×几十 px），每个滚动条多一层显存开销可忽略。 */
  will-change: transform;
}

/* 细滑块：6px 宽、圆角更小，左右只留 1px */
.custom-scrollbar.is-compact .custom-scrollbar-thumb {
  left: 1px;
  width: calc(100% - 2px);
  border-radius: 3px;
}

.custom-scrollbar:hover .custom-scrollbar-thumb {
  background: var(--sidebar-thumb-hover, rgba(71, 85, 105, 0.55));
}
</style>
