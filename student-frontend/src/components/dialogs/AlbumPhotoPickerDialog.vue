<template>
  <DialogShell :visible="visible" :z-index="10004" @overlay="$emit('close')">
    <div class="bg-surface rounded-xl w-[1100px] max-w-[96vw] h-[88vh] flex flex-col border border-border shadow-card dialog-card overflow-hidden">
      <!-- 标题 -->
      <div class="flex items-center justify-between px-6 pt-5 pb-3 flex-shrink-0">
        <h3 class="text-lg font-bold text-text truncate">选择 {{ albumName || '相册' }} 的照片</h3>
        <button @click="$emit('close')" class="dlg-close">✕</button>
      </div>

      <!-- 选择工具条 -->
      <div class="flex items-center gap-3 px-6 pb-3 flex-shrink-0">
        <button @click="selectAll" class="bg-surface-hover hover:bg-surface-hover text-text px-3 py-1.5 rounded border border-border text-sm transition-theme">全选</button>
        <button @click="clearSelection" class="bg-surface-hover hover:bg-surface-hover text-text px-3 py-1.5 rounded border border-border text-sm transition-theme">取消选择</button>
        <span class="text-sm text-text-secondary ml-auto">
          已经选择 <span class="text-text font-semibold tabular-nums">{{ selectedCount }}</span> 张
        </span>
      </div>

      <!-- 照片时间轴（按日期分组 + 窗口化虚拟滚动，与相册页同一套逻辑） -->
      <div class="flex-1 min-h-0 px-6">
        <p v-if="loading" class="text-sm text-text-muted py-6 text-center">正在读取照片…</p>
        <p v-else-if="!groups.length" class="text-sm text-text-muted py-6 text-center">这个相册里没有照片。</p>
        <div v-else ref="containerRef" class="h-full overflow-auto min-h-0 album-scroll" @scroll="onScroll">
          <div class="relative" :style="{ height: totalH + 'px' }">
            <div
              v-for="v in visibleGroups"
              :key="v.g.date"
              class="absolute left-0 right-0 mb-8"
              :style="{ top: v.offset + 'px' }"
            >
              <h2 class="text-lg font-semibold text-text mb-3 flex items-center gap-2">
                <span class="px-2 py-0.5 bg-info/10 text-info rounded text-sm">{{ v.g.date }}</span>
                <span class="text-xs text-text-muted">{{ groupCountOf(v.g) }} 张</span>
              </h2>
              <div class="flex flex-wrap gap-3">
                <!-- 分页加载中：高度已按张数预留，这里只占位提示 -->
                <div v-if="!v.g.photos" class="text-sm text-text-muted py-2">加载中…</div>
                <div
                  v-for="p in (v.g.photos || [])"
                  :key="p.id"
                  @click="toggle(p)"
                  class="rounded-lg overflow-hidden bg-bg border cursor-pointer group relative picker-cell"
                  :class="isSelected(p.id) ? 'border-info ring-2 ring-info' : 'border-border'"
                  :style="cellStyle"
                  :data-cell-id="p.id"
                >
                  <VideoThumb v-if="isVideo(p)" :src="thumbSrc(p)" />
                  <!-- 未就绪不渲染 <img> + 去掉 loading="lazy"，原因同 AlbumView：避免 src 二次赋值重解码导致闪。 -->
                  <img v-else-if="thumbSrc(p)" :src="thumbSrc(p)" :alt="p.file_name" class="w-full h-full object-cover" decoding="async" @error="onThumbError" />
                  <div class="picker-mask" :class="{ 'picker-mask--sel': isSelected(p.id) }"></div>
                  <!-- 左上角单选框 -->
                  <span
                    class="absolute top-1.5 left-1.5 w-5 h-5 rounded-md border-2 flex items-center justify-center text-[11px] leading-none"
                    :class="isSelected(p.id) ? 'bg-info border-info text-text-inverse' : 'bg-black/25 border-white/85 text-transparent'"
                  >✓</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部 -->
      <div class="flex items-center justify-end gap-2 px-6 py-4 border-t border-border flex-shrink-0 mt-2">
        <button @click="$emit('close')" class="px-4 py-2 rounded bg-surface-hover text-text border border-border transition-theme">取消</button>
        <button @click="confirm" :disabled="selectedCount === 0" class="px-4 py-2 rounded bg-primary text-text-inverse hover:bg-primary-hover transition-theme disabled:opacity-50">
          确认选择
        </button>
      </div>
    </div>
  </DialogShell>
</template>

<script setup vapor>
import { getToken } from '../../utils/authStorage.js'
import { reportError } from '../../utils/reportError.js'
import { createLatest } from '../../utils/latestOnly.js'
import { ref, computed, nextTick, watch } from 'vue'
import axios from 'axios'
import DialogShell from '../base/DialogShell.vue'
import VideoThumb from '../import-export/VideoThumb.vue'
import { usePhotoTimeline } from '../../composables/usePhotoTimeline.js'
import {
  pageBefore, groupCountOf, firstUnloadedIndex, mergePhotoGroups, buildGroupPlaceholders, selectionCount,
} from '../../composables/albumPhotoPages.js'
import { useThumbBatch } from '../../composables/useThumbBatch.js'
import { albumThumbUrl } from '../../utils/albumMedia'
import '../../styles/dialog-transition.css'

const props = defineProps({
  visible: { type: Boolean, default: false },
  albumId: { type: [Number, String, null], default: null },
  albumName: { type: String, default: '' },
  /* 上次的选择，再次打开同一相册时原样恢复。
   * 必须是一个「描述」而不是「照片 id 列表」：
   * 相册是分页加载的，回到弹窗时那些照片大概率还没加载 ——
   * 按 id 列表恢复的话，没加载的直接被过滤掉，勾选会静默丢失。 */
  initial: { type: Object, default: null },
})
// confirm：把「选择描述」交回给「新建相册」弹窗（见 confirm() 的注释）
const emit = defineEmits(['close', 'confirm'])

const loading = ref(false)
const groups = ref([])
/* 选中状态 = 一条「描述」，不依赖照片有没有加载：
 *   allOfAlbum=true  → 选了源相册全部，excluded 是要排除掉的那几张
 *   allOfAlbum=false → ids 是显式勾选的
 * 这样「整册全选」不需要前端先拿全部照片（一万张就是一万个 id 的传输 + 一万次 DOM 绑定）。 */
const allOfAlbum = ref(false)
const ids = ref(new Set())
const excluded = ref(new Set())

const { containerRef, cellStyle, totalH, visibleGroups, onScroll, reset } = usePhotoTimeline(groups)

/* 缩略图批量预取：可视区照片 id 变化时一次批量取回（少几百次 HTTP 往返），
 * 批量没取到的自动回落到单张 /thumb 接口，功能不变。 */
const visiblePhotoIds = computed(() => {
  const out = []
  for (const v of visibleGroups.value) {
    for (const p of (v.g.photos || [])) out.push(p.id)
  }
  return out
})
const {
  thumbUrlFor: batchThumbUrl,
  refresh: refreshThumbBatch,
  clear: clearThumbBatch,
} = useThumbBatch(() => visiblePhotoIds.value)

const token = () => getToken() || ''
const authHeaders = () => ({ Authorization: 'Bearer ' + token() })

const VIDEO_RE = /\.(mp4|webm|mov|avi|mkv|m4v|ogv)$/i
function isVideo(p) {
  return p && VIDEO_RE.test(p.file_name || '')
}
// 三态（undefined=还在拿 / ''=回落到单张接口 / blob=就绪），与 AlbumView 同一套逻辑：
// 一个 id 的地址只从 undefined 变成后两者之一，之后不再变，避免 <img> 的 src 二次赋值重解码。
function thumbSrc(p) {
  const u = batchThumbUrl(p.id)
  if (u === undefined) return ''
  return u || albumThumbUrl(p.id)
}
const THUMB_PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="100%" height="100%" fill="#f3f4f6"/><g fill="none" stroke="#d1d5db" stroke-width="4"><circle cx="80" cy="70" r="18"/><path d="M30 132 Q52 96 82 118 T160 100" fill="none"/></g></svg>`
)
function onThumbError(e) {
  if (e.target && e.target.src !== THUMB_PLACEHOLDER) e.target.src = THUMB_PLACEHOLDER
}

// 源相册总张数：由日期索引求和，不需要照片行就能算（「已选 N 张」靠它）
const totalCount = computed(() => groups.value.reduce((a, g) => a + groupCountOf(g), 0))
const selectedCount = computed(() => selectionCount({
  allOfAlbum: allOfAlbum.value, ids: ids.value, exclude: excluded.value,
}, totalCount.value))

function isSelected(id) {
  return allOfAlbum.value ? !excluded.value.has(id) : ids.value.has(id)
}

function toggle(p) {
  const target = allOfAlbum.value ? excluded : ids
  const next = new Set(target.value)
  if (next.has(p.id)) next.delete(p.id)
  else next.add(p.id)
  target.value = next
}

function selectAll() {
  // 整册：只记一个标记。真正展开在后端（POST /api/album 的 all_from）。
  allOfAlbum.value = true
  excluded.value = new Set()
  ids.value = new Set()
}

function clearSelection() {
  allOfAlbum.value = false
  ids.value = new Set()
  excluded.value = new Set()
}

// 读取守卫：快速换相册 / 关掉再开时，先发的请求后回来会把新相册的列表
// 覆盖成旧相册的内容（缩略图与勾选全对不上）。只认最后一次。
const loadGuard = createLatest()
const PAGE_DAYS = 8
const pageInFlight = new Set()
let loadEpoch = 0

// 与相册页同一套分页：先拿日期索引（含每组张数，布局一次算准），再按需补照片行。
async function ensureLoaded(fromIdx) {
  const gs = groups.value
  const j = firstUnloadedIndex(gs, fromIdx)
  if (j === -1) return
  const albumAtStart = props.albumId
  const epoch = loadEpoch
  const anchorDate = gs[j].date
  if (pageInFlight.has(anchorDate)) return
  pageInFlight.add(anchorDate)
  try {
    const res = await axios.get(`/api/album/${albumAtStart}/photos`, {
      params: { days: PAGE_DAYS, before: pageBefore(anchorDate) },
      headers: authHeaders(),
    })
    if (epoch !== loadEpoch || albumAtStart !== props.albumId) return
    if (mergePhotoGroups(groups.value, res.data && res.data.data)) {
      refreshThumbBatch()
      ensureVisibleLoaded()
    }
  } catch (err) {
    if (epoch !== loadEpoch) return
    reportError(err, { action: '读取照片' })
  } finally {
    pageInFlight.delete(anchorDate)
  }
}

function ensureVisibleLoaded() {
  const list = visibleGroups.value
  if (!list.length) return
  const miss = list.find((v) => !v.g.photos)
  if (!miss) return
  const gi = groups.value.indexOf(miss.g)
  if (gi >= 0) ensureLoaded(gi)
}

async function load() {
  if (!props.albumId) { groups.value = []; return }
  const token = loadGuard.begin()
  loading.value = true
  loadEpoch++
  pageInFlight.clear()
  // 换了相册 → 旧的 objectURL 全作废（照片 id 不同，留着会显示错图）
  clearThumbBatch()
  try {
    const res = await axios.get(`/api/album/${props.albumId}/dates`, { headers: authHeaders() })
    if (!loadGuard.isCurrent(token)) return
    groups.value = buildGroupPlaceholders(res.data && res.data.data)
    // 恢复上次的选择：原样采纳。**不能按「照片已加载」过滤** ——
    // 分页后这里绝大多数照片都还没加载，过滤等于把用户的勾选悄悄丢掉。
    const init = props.initial
    if (init && Number(init.albumId) === Number(props.albumId)) {
      allOfAlbum.value = !!init.allOfAlbum
      ids.value = new Set(init.ids || [])
      excluded.value = new Set(init.exclude || [])
    } else {
      clearSelection()
    }
    await nextTick()
    reset()
    await ensureLoaded(0)
  } catch (err) {
    if (!loadGuard.isCurrent(token)) return
    groups.value = []
    reportError(err, { action: '读取照片' })
  } finally {
    if (loadGuard.isCurrent(token)) loading.value = false
  }
}

// 视口里出现还没加载的分组就补上（滚动、跳转都靠这一条）
watch(visibleGroups, () => { ensureVisibleLoaded() }, { flush: 'post' })

/* 确认时交回的是「选择描述」，不是照片对象数组。
 * 原来交的是对象数组，而调用方只用到了 p.id —— 分页之后这个约定就行不通了：
 * 没加载的照片根本不在前端，拿不到对象。描述交给后端展开，一万张也不用传一万个 id。 */
function confirm() {
  emit('confirm', {
    albumId: props.albumId,
    allOfAlbum: allOfAlbum.value,
    ids: allOfAlbum.value ? [] : [...ids.value],
    exclude: allOfAlbum.value ? [...excluded.value] : [],
    total: totalCount.value,
  })
}

// immediate：弹窗随 v-if 挂载时 visible 直接为 true，不 immediate 会漏掉首次加载
watch(() => [props.visible, props.albumId], ([v]) => {
  if (v) load()
}, { immediate: true })
</script>

<style scoped>
/* 格子不再用 content-visibility 拆层：与毛玻璃主题的 backdrop-filter 叠加会触发
   「按 1x 光栅化再按 DPR 放大」，表现为图片清晰但显示发虚。可视区格子数量本来就有限。 */
/* 选中/悬停遮罩：不用 inset-0 + bg-black/* 工具类，避免被全局「弹窗遮罩模糊」规则命中
   （那条规则会给它加 backdrop-filter: blur，把下面的照片虚化） */
.picker-mask {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background-color: transparent;
  transition: background-color 0.2s ease;
  pointer-events: none;
}
.group:hover .picker-mask {
  background-color: rgba(0, 0, 0, 0.14);
}
.picker-mask--sel {
  background-color: color-mix(in srgb, var(--color-info, #38bdf8) 16%, transparent);
}

/* 隐藏滚动条（滚动能力保留），与相册页一致 */
.album-scroll {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.album-scroll::-webkit-scrollbar {
  display: none;
  width: 0;
}
</style>
