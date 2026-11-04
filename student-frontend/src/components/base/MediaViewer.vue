<template>
  <!-- 媒体查看器：图片缩放/旋转、视频播放、翻页。外观与相册页完全一致（样式在 styles/media-viewer.css） -->
  <Teleport to="body">
    <Transition name="preview">
      <div v-if="visible" class="fixed inset-0 z-[10004] flex flex-col album-viewer" @click.self="close">
        <div class="viewer-main flex-1 flex min-h-0">
          <div class="viewer-stage flex-1 min-w-0 relative">
            <button class="z-20 w-10 h-10 rounded-full viewer-btn viewer-close text-lg flex items-center justify-center transition-theme" title="关闭" @click="close">✕</button>
            <button
              v-if="items.length > 1"
              class="z-20 w-11 h-11 rounded-full viewer-btn viewer-nav viewer-nav-prev text-xl flex items-center justify-center transition-theme"
              title="上一个"
              @click="step(-1)"
            >‹</button>
            <button
              v-if="items.length > 1"
              class="z-20 w-11 h-11 rounded-full viewer-btn viewer-nav viewer-nav-next text-xl flex items-center justify-center transition-theme"
              title="下一个"
              @click="step(1)"
            >›</button>

            <!-- 视频 -->
            <div
              v-if="current && current.isVideo"
              class="absolute inset-0 flex items-center justify-center p-6 overflow-hidden preview-media"
              :class="mediaReady ? 'media-in' : 'media-waiting'"
            >
              <video
                ref="videoEl"
                class="max-w-full max-h-full bg-black outline-none viewer-media"
                :src="current.src"
                @timeupdate="onTimeupdate"
                @loadedmetadata="onLoadedmetadata"
                @loadeddata="mediaReady = true"
                @play="playing = true"
                @pause="playing = false"
                @ended="playing = false"
              ></video>
            </div>
            <!-- 图片：滚轮缩放只挂在外层容器上 -->
            <div
              v-else
              class="absolute inset-0 flex items-center justify-center p-6 overflow-hidden preview-media"
              :class="mediaReady ? 'media-in' : 'media-waiting'"
              @wheel.prevent="onWheel"
            >
              <img
                :src="current ? current.src : ''"
                class="max-w-full max-h-full select-none transition-transform duration-100 viewer-media"
                :style="mediaStyle"
                draggable="false"
                decoding="async"
                @load="mediaReady = true"
                @error="mediaReady = true"
              />
            </div>
          </div>

          <!-- 侧栏（相册页用来放照片信息） -->
          <slot name="aside" :current="current" />
        </div>

        <!-- 底部工具条：媒体控制固定在前，业务按钮由调用方通过 #toolbar 追加 -->
        <div class="flex items-center justify-center gap-3 p-4 flex-wrap viewer-bar">
          <template v-if="current && current.isVideo">
            <button class="w-10 h-10 rounded-full viewer-btn text-sm transition-theme" :title="playing ? '暂停' : '播放'" @click="togglePlay">{{ playing ? '⏸' : '▶' }}</button>
            <button class="h-10 px-3 rounded-full viewer-btn text-xs transition-theme" title="后退 10 秒" @click="skip(-10)">« -10s</button>
            <div class="flex items-center gap-2 min-w-[260px] max-w-full">
              <span class="viewer-fg text-xs tabular-nums w-12 text-right">{{ fmtTime(currentTime) }}</span>
              <input
                type="range"
                class="flex-1 accent-info"
                min="0"
                :max="duration || 0"
                step="0.1"
                :value="currentTime"
                @input="onSeekInput"
                @pointerdown="dragging = true"
                @pointerup="dragging = false"
              />
              <span class="viewer-fg text-xs tabular-nums w-12">{{ fmtTime(duration) }}</span>
            </div>
            <button class="h-10 px-3 rounded-full viewer-btn text-xs transition-theme" title="前进 10 秒" @click="skip(10)">+10s »</button>
            <AppSelect
              v-model="playbackRate"
              class="w-20"
              title="播放倍数"
              :options="RATE_OPTIONS"
              @change="changeRate"
            />
          </template>
          <template v-else>
            <button class="w-10 h-10 rounded-full viewer-btn text-sm transition-theme" title="向左旋转" @click="rotate(-1)">⟲</button>
            <button class="w-10 h-10 rounded-full viewer-btn text-sm transition-theme" title="向右旋转" @click="rotate(1)">⟳</button>
            <button class="w-10 h-10 rounded-full viewer-btn transition-theme" title="缩小" @click="zoomOut">−</button>
            <span class="viewer-fg text-xs w-14 text-center">{{ Math.round(zoom * 100) }}%</span>
            <button class="w-10 h-10 rounded-full viewer-btn transition-theme" title="放大" @click="zoomIn">＋</button>
            <button class="px-3 h-10 rounded-full viewer-btn text-xs transition-theme" @click="resetView">复位</button>
          </template>
          <slot name="toolbar" :current="current" />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import AppSelect from '../base/AppSelect.vue'

defineOptions({ name: 'MediaViewer' })

const props = defineProps({
  visible: { type: Boolean, default: false },
  // [{ src, name, isVideo }]
  items: { type: Array, default: () => [] },
  index: { type: Number, default: 0 },
})
const emit = defineEmits(['update:visible', 'update:index'])

const RATE_OPTIONS = [
  { value: 0.5, label: '0.5x' }, { value: 0.75, label: '0.75x' }, { value: 1, label: '1x' },
  { value: 1.25, label: '1.25x' }, { value: 1.5, label: '1.5x' }, { value: 2, label: '2x' },
]

const rotation = ref(0)
const zoom = ref(1)
// 首帧就绪才播放进入动画：冷加载时 img 要下载+解码才撑开，动画提前跑会变成「先空一下再硬砸出来」
const mediaReady = ref(false)
const videoEl = ref(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const playbackRate = ref(1)
const dragging = ref(false)

const current = computed(() => props.items[props.index] || null)
const mediaStyle = computed(() => ({ transform: `rotate(${rotation.value}deg) scale(${zoom.value})` }))

// 换项/打开时复位视角；翻页不重播进入动画。
// 注意不能写成 ([v], [oldV]) => —— immediate 首次调用时 oldValue 是 undefined，
// 直接解构会抛「undefined is not iterable」，组件一挂载就炸。
watch(() => [props.visible, props.index], (val, oldVal) => {
  const v = val[0]
  const prevVisible = Array.isArray(oldVal) ? oldVal[0] : false
  if (!v) {
    mediaReady.value = false
    return
  }
  mediaReady.value = false
  rotation.value = 0
  zoom.value = 1
  currentTime.value = 0
  duration.value = 0
  playing.value = false
  playbackRate.value = 1
  // 翻页（visible 未变）时直接视为就绪，保持「直接替换」的手感
  if (prevVisible === true) mediaReady.value = true
}, { immediate: true })

function close() { emit('update:visible', false) }

function step(dir) {
  if (props.items.length < 2) return
  const next = (props.index + dir + props.items.length) % props.items.length
  emit('update:index', next)
}

function rotate(dir) {
  // +360 再取模：往回转（dir = -1）时不会得到负角度
  rotation.value = ((rotation.value + dir * 90) % 360 + 360) % 360
}
function zoomIn() { zoom.value = Math.min(5, zoom.value + 0.25) }
function zoomOut() { zoom.value = Math.max(0.2, zoom.value - 0.25) }
function resetView() { rotation.value = 0; zoom.value = 1 }
function onWheel(e) {
  zoom.value = Math.min(5, Math.max(0.2, zoom.value + (e.deltaY < 0 ? 0.1 : -0.1)))
}

function fmtTime(t) {
  if (!isFinite(t) || t < 0) return '0:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${s < 10 ? '0' : ''}${s}`
}

function onTimeupdate() {
  if (dragging.value || !videoEl.value) return
  currentTime.value = videoEl.value.currentTime || 0
}
function onLoadedmetadata() {
  duration.value = videoEl.value ? (videoEl.value.duration || 0) : 0
}
function togglePlay() {
  const v = videoEl.value
  if (!v) return
  if (v.paused) v.play()
  else v.pause()
}
function skip(sec) {
  const v = videoEl.value
  if (!v) return
  const max = v.duration || 0
  v.currentTime = Math.max(0, Math.min(max, (v.currentTime || 0) + sec))
  currentTime.value = v.currentTime || 0
}
function onSeekInput(e) {
  const v = videoEl.value
  if (!v) return
  const t = Number(e.target.value) || 0
  v.currentTime = t
  currentTime.value = t
}
function changeRate() {
  const v = videoEl.value
  if (v) v.playbackRate = playbackRate.value
}

// 切换媒体时把待播放的视频状态重置（复用同一个 <video> 元素，src 变了要重新载入）
watch(current, () => {
  nextTick(() => {
    if (videoEl.value) {
      videoEl.value.load()
      videoEl.value.playbackRate = playbackRate.value
    }
  })
})

defineExpose({ close })
</script>
