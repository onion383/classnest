<template>
  <!-- 年份刻度尺：贴在照片网格右侧的细长滚动条。
       刻度按「内容高度占比」定位，所以照片越多的年份分到的刻度间距越大；
       拖动手柄时容器同步滚动，旁边浮出精确到日的日期提示。
       松手**不吸附**：拖到哪儿停哪儿（吸附会在大块的「未知时间」区间里把位置拽走）。 -->
  <div ref="trackRef" class="album-ruler select-none" @pointerdown="onTrackPointerDown">
    <!-- 轨道底色 -->
    <div class="album-ruler-track"></div>

    <!-- 年份刻度：短线 + 年份文字（间距够大才显示文字） -->
    <div v-for="m in yearMarks" :key="m.year">
      <div class="album-ruler-tick" :style="{ top: m.top + 'px', height: m.len + 'px' }" />
      <!-- 标签不能塞进刻度线里：那条线只有 2px 宽，标签的 right 会以它为定位基准，
           算出来的右边缘比预期偏一个轴心偏移（实测偏 16px，标签左边缘仍压照片 2.5px），
           而且可用宽度只剩 2px，两行文字会被挤成一字一行。这里让它直接以尺子定位。 -->
      <span
        v-if="m.showLabel"
        class="album-ruler-label"
        :style="{ top: m.top + m.len / 2 + 'px' }"
      >{{ m.lines.join('\n') }}</span>
    </div>

    <!-- 手柄：高度固定（THUMB_H），宽度细条 -->
    <div
      class="album-ruler-thumb"
      :class="{
        'album-ruler-thumb--active': dragging,
        'album-ruler-thumb--free': !maxScroll,
      }"
      :style="{ top: thumbTop + 'px', height: thumbH + 'px' }"
      @pointerdown.stop="onThumbPointerDown"
    ></div>

    <!-- 拖动时的日期提示（精确到日） -->
    <Transition name="ruler-tip">
      <div v-if="dragging && tipText" class="album-ruler-tip" :style="{ top: thumbTop + thumbH / 2 + 'px' }">
        {{ tipText }}
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'

const props = defineProps({
  // 时间轴分组的偏移表 [{ date, offset }]，与 usePhotoTimeline 的 layout 同源
  items: { type: Array, default: () => [] },
  // 内容总高度
  total: { type: Number, default: 0 },
  // 当前滚动位置与视口高度（由容器的 onScroll 驱动）
  scrollTop: { type: Number, default: 0 },
  clientH: { type: Number, default: 0 },
})
const emit = defineEmits(['seek'])

// 手柄固定高度：不随内容比例变化 —— 照片多少、窗口多高，长出来的都是同一个形状。
// 原来的写法是 clamp(clientH / total * trackH, 28, trackH)：照片一多就被压成 28px 的细针，
// 照片少又能糊满整条，抓取手感随内容漂移，这也正是「大小不固定」的来源。
const THUMB_H = 44
const MIN_GAP = 26 // 低于这个间距（px）的年份不显示文字

const trackRef = ref(null)
const trackH = ref(0)
const dragging = ref(false)

// 拖动期间只需记住一个量：grabOffset —— 按下瞬间指针相对手柄顶部的偏移，
// 保证从手柄任意位置按下都不会「弹到指针中心」。
let grabOffset = 0
let resizeObs = null

// 没有可滚动内容（相册只有一两张、一屏放得下）时的「自由位移」：
// 此时 maxScroll = 0，手柄位置本来是 scrollTop / 0，除不动 → 死死钉在顶部，
// 看起来像坏了（用户报过）。这里单独给一份位移，让手柄照样跟手；
// 松手时复位到 0，复位过程由 CSS 的 top 过渡补一段平滑滑回。
const manualTop = ref(0)

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

const maxScroll = computed(() => Math.max(0, (props.total || 0) - (props.clientH || 0)))

// 手柄高度固定（只有轨道本身比手柄还短时才退让，避免溢出轨道）
const thumbH = computed(() => Math.min(THUMB_H, Math.max(0, trackH.value)))

// 手柄能走的行程 = 轨道高度 − 手柄自身高度。手柄顶点的活动区间就是它，
// 顶格时手柄顶在轨道顶端，拖到底时手柄底边贴住轨道底边 —— 视觉上真的「完全」。
const thumbRange = computed(() => Math.max(0, trackH.value - thumbH.value))

// 手柄位置：滚动进度 → 行程区间。
// 没有可滚动内容时用 manualTop（纯手感，不影响任何滚动），否则跟真实滚动位置走。
const thumbTop = computed(() => {
  if (!thumbRange.value) return 0
  if (!maxScroll.value) return clamp(manualTop.value, 0, thumbRange.value)
  return clamp((props.scrollTop / maxScroll.value) * thumbRange.value, 0, thumbRange.value)
})

// 当前视口顶部所在的那一组（取偏移不超过 scrollTop 的最后一组）
const currentItem = computed(() => {
  const list = props.items || []
  if (!list.length) return null
  let hit = list[0]
  for (const it of list) {
    if (it.offset <= props.scrollTop) hit = it
    else break
  }
  return hit
})

// 拖动时浮出的日期。
// 内容不足一屏时手柄能被拖到任意位置，但那一刻**没有任何内容滚到对应日期**，
// 提示照常显示第一组日期就是在骗人，所以这种情况下不显示。
const tipText = computed(() => {
  if (!maxScroll.value) return ''
  return currentItem.value ? currentItem.value.date : ''
})

/* 刻度必须和手柄同源换算：同一个 maxScroll 分母、同一段行程，否则拖到某一年时
   手柄中心会和那年的刻度线对不上。原来刻度用的是 offset / total，
   而手柄用的是 scrollTop / maxScroll —— 越靠底部偏得越多，是一条真错位。 */
function markTop(offset) {
  const h = trackH.value
  if (!h) return 0
  const ms = maxScroll.value
  if (!ms) {
    // 内容不足一屏：没有可滚动行程，刻度按内容比例铺满轨道（此时手柄停在顶端）
    const t = props.total || 0
    return t ? clamp((offset / t) * h, 0, h) : 0
  }
  // + thumbH/2：滚到该位置时手柄中心落在哪儿，刻度就画在哪儿
  return clamp((offset / ms) * thumbRange.value + thumbH.value / 2, 0, h)
}

/* 年份标签换行：年份（如 2026）四位数字约 22px 宽；「未知时间」四个汉字一行要 40px，
   是整个尺子最宽的一项，单独为它加宽不值当。按两字折成「未知 / 时间」之后，
   每行 20px，和年份齐平 —— 尺子就不必为这一个标签让步。 */
function labelLines(text) {
  const s = String(text || '')
  if (s.length <= 2) return [s]
  const lines = []
  for (let i = 0; i < s.length; i += 2) lines.push(s.slice(i, i + 2))
  return lines
}

/* 年份刻度：按内容高度占比定位（照片多的年份自然占更大间距），
   刻度长度与自身间距成正比 —— 间距越大（照片越多）刻度画得越长。 */
const yearMarks = computed(() => {
  const list = props.items || []
  const total = props.total || 0
  const h = trackH.value
  if (!list.length || !total || !h) return []
  const marks = []
  let cur = null
  for (const it of list) {
    const d = String(it.date || '')
    // 「未知时间」组不是年份，它的刻度直接沿用后端给的标签
    const year = /^\d{4}/.test(d) ? d.slice(0, 4) : (d || '未知')
    if (year === cur) continue
    cur = year
    marks.push({ year, lines: labelLines(year), top: markTop(it.offset), label: it.date })
  }
  for (let i = 0; i < marks.length; i++) {
    const bottom = i + 1 < marks.length ? marks[i + 1].top : trackH.value
    const gap = Math.max(0, bottom - marks[i].top)
    marks[i].len = clamp(6 + gap * 0.12, 6, 18)
    marks[i].showLabel = gap >= MIN_GAP
  }
  return marks
})

function measure() {
  const el = trackRef.value
  if (!el) return
  // 轨道高度 = 元素自身高度（由父级 flex 拉伸决定）。
  // 这里原来还套了一层 Math.min(clientHeight, 420)：元素照旧是满高的，
  // 手柄却只在上半截活动，窗口一高就出现「条子铺到底、手柄拖到底不下去」。
  trackH.value = el.clientHeight
}

/* 轨道点击 / 拖动：按指针纵向位置换算成滚动位置 */
function applyFromEvent(e) {
  const el = trackRef.value
  if (!el) return
  const range = thumbRange.value
  if (range <= 0) return // 轨道比手柄还短，没有可走的行程
  const rect = el.getBoundingClientRect()
  // 想让手柄顶部落到的位置（扣掉按下时的抓取偏移，手柄就不会跳到指针中心）
  const top = clamp(e.clientY - rect.top - grabOffset, 0, range)
  // 内容不足一屏：没有可滚动量，只让手柄跟手，不产生任何滚动
  if (!maxScroll.value) {
    manualTop.value = top
    return
  }
  emit('seek', (top / range) * maxScroll.value)
}

function onTrackPointerDown(e) {
  if (e.button !== 0) return
  // 点轨道：手柄中心对齐指针位置
  grabOffset = thumbH.value / 2
  startDrag()
  applyFromEvent(e)
}

function onThumbPointerDown(e) {
  if (e.button !== 0) return
  const el = trackRef.value
  if (!el) return
  // 按住手柄的哪个位置就从哪儿拖起，不做「弹到中心」的跳变
  grabOffset = e.clientY - el.getBoundingClientRect().top - thumbTop.value
  startDrag()
}

function startDrag() {
  dragging.value = true
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
}

function onPointerMove(e) {
  if (!dragging.value) return
  applyFromEvent(e)
}

// 松手**不吸附**：拖到哪儿就停在哪儿。
// 之前这里会「吸到最近的一组日期」（候选 = 最顶 + 各分组起点 + 最底），观感就是一松手就跳：
//   · 分组粒度是「天」，末尾还有一行照片和间距 → 拖到底松手被拽回最后一组的日期；
//   · 相册里「未知时间」往往是一大块，那一组的 offset 覆盖面极宽，
//     手柄落到它范围内任意位置、只要松手都会被拽到那组起点，看起来像「被一根很大比例的条拉过去」。
// 手柄位置本来就是 scrollTop / maxScroll 的严格映射，拖动过程中已经逐帧 emit('seek')，
// 松手保持当前落点即可，不需要再做任何修正。
function onPointerUp() {
  if (!dragging.value) return
  dragging.value = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
  // 内容不足一屏：没有真实滚动位置可留，复位到顶部。
  // 复位不是瞬间跳回 —— `.album-ruler-thumb--free` 上挂了 top 过渡（拖动时由 --active 关掉，
  // 保证跟手不拖影），所以这里只把值改回 0，视觉上是一段平滑的滑回。
  if (!maxScroll.value) manualTop.value = 0
}

function onResize() {
  measure()
}

onMounted(() => {
  measure()
  window.addEventListener('resize', onResize)
  // 父容器高度变化（窗口缩放之外的场景：工具栏折行、侧栏开合）只有 ResizeObserver 看得到
  if (trackRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObs = new ResizeObserver(() => measure())
    resizeObs.observe(trackRef.value)
  }
})
onBeforeUnmount(() => {
  resizeObs?.disconnect()
  resizeObs = null
  window.removeEventListener('resize', onResize)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
})

// 数据到位 / 布局重算后轨道高度可能才拿到，补测一次
watch(() => [props.items.length, props.total], () => {
  requestAnimationFrame(measure)
})
</script>

<style scoped>
/* 尺子宽度 42px = 26px 标签区 + 16px 轨道与手柄区。
   原来是 26px、轴心在正中间，年份标签（right:14px）的右边缘正好落在 x=0 ——
   也就是整个标签都在尺子外面，横向压住照片约 22px（截图里的现象）。
   现在把轴心移到 x=34：手柄悬停宽 12px 时占 28~40，右侧留 2px；
   标签区 0~26，四位数字约 22px 放得下还余 4px 给字体差异，两行「未知 / 时间」20px 更宽松。
   代价是照片区少 16px 可用宽度（尺子 26 → 42），照片本身尺寸不变。 */
.album-ruler {
  position: relative;
  width: 42px;
  flex-shrink: 0;
  cursor: pointer;
  touch-action: none;
}

.album-ruler-track {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 34px;
  transform: translateX(-50%);
  width: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-border, #d1d5db) 70%, transparent);
}

/* 年份刻度线：压在轨道上，短横线；间距越大线越长 */
.album-ruler-tick {
  position: absolute;
  left: 34px;
  transform: translateX(-50%);
  width: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-muted, #9ca3af) 65%, transparent);
  pointer-events: none;
}

/* 标签区 = 尺子左侧 26px（left:0 到 right:16 之间），右边缘与悬停手柄（左边缘 28px）留 2px。
   宽度用 left+right 撑出来、不写死，尺子宽度调整时自动跟着变。 */
.album-ruler-label {
  position: absolute;
  left: 0;
  right: 16px;
  transform: translateY(-50%);
  font-size: 10px;
  line-height: 1.15;
  /* 标签可能是多行（「未知时间」按两字折行），pre-line 让文本里的 \n 生效 */
  white-space: pre-line;
  text-align: right;
  color: var(--color-text-muted, #9ca3af);
}

/* 手柄：细长条，高度由脚本按固定值下发（THUMB_H），hover / 拖动时只改宽度和高亮 */
.album-ruler-thumb {
  position: absolute;
  left: 34px;
  transform: translateX(-50%);
  width: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary, #3b82f6) 75%, transparent);
  transition: width 0.15s ease, background-color 0.15s ease;
  cursor: grab;
}
/* 没有可滚动内容时（相册一屏放得下）：松手复位走过渡 —— 手柄滑回顶部，不是瞬间跳上去。
   拖动中会同时带 --active，那条规则把 top 过渡关掉，保证严格跟手、不拖影。 */
.album-ruler-thumb--free {
  transition: width 0.15s ease, background-color 0.15s ease,
    top 0.24s cubic-bezier(0.22, 0.61, 0.36, 1);
}

.album-ruler-thumb:hover,
.album-ruler-thumb--active {
  width: 12px;
  background: var(--color-primary, #3b82f6);
}
.album-ruler-thumb--active {
  cursor: grabbing;
  /* 覆盖 --free 的 top 过渡：拖动期间 top 每帧都要跟手 */
  transition: width 0.15s ease, background-color 0.15s ease;
}

/* 日期提示：浮在手柄左侧的尺子外面（拖动时才出现，临时盖在照片上是可以接受的）。
   right 要跟着尺子宽度走：原来 26px 宽配 right:30px，气泡右边缘落在 x=-4；
   尺子加宽到 42px 后取 46px，保持同样的外置位置，不要让它挪进尺子里面。 */
.album-ruler-tip {
  position: absolute;
  right: 46px;
  transform: translateY(-50%);
  padding: 3px 8px;
  border-radius: var(--radius-control);
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  color: var(--color-text-inverse, #fff);
  background: color-mix(in srgb, var(--color-text, #111827) 88%, transparent);
  box-shadow: var(--shadow-card, 0 4px 12px rgba(0, 0, 0, 0.18));
  pointer-events: none;
}

.ruler-tip-enter-active,
.ruler-tip-leave-active {
  transition: opacity 0.15s ease;
}
.ruler-tip-enter-from,
.ruler-tip-leave-to {
  opacity: 0;
}
</style>