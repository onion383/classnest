<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div
        v-if="visible"
        class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10001] pointer-events-auto no-dialog-pulse"
        @click.self="$emit('close')"
      >
        <div class="bg-surface p-5 rounded-xl w-[600px] max-w-full shadow-lg dialog-card relative">
          <!-- 搜索框：沿用弹窗表单输入框规格（与添加学生等弹窗一致），左侧放大镜 -->
          <div class="relative mb-6">
            <IconGlyph name="search" tint="current" glyph :size="16" :stroke-width="2.2" class="absolute left-3 top-1/2 -translate-y-1/2 z-[1] text-text-secondary pointer-events-none" />
            <input
              ref="inputEl"
              v-model="keyword"
              type="text"
              placeholder="搜索页面或设置…"
              autocomplete="off"
              spellcheck="false"
              class="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-surface-hover border border-border text-text focus:outline-none focus:border-primary"
              @keydown.down.prevent="moveActive(1)"
              @keydown.up.prevent="moveActive(-1)"
              @keydown.enter.prevent="confirmActive"
              @keydown.esc="$emit('close')"
            />
          </div>

          <!-- 固定高度的结果区：「最近搜索」与「分组 chips」都放在这个容器里，出现与否都只是
               让下面的列表变矮（flex-1），弹窗总高度始终不变 —— 否则勾选/筛选时窗口会跳一下。 -->
          <div class="h-[360px] max-h-[60vh] flex flex-col">
            <!-- 最近搜索：只在没输入时出现，点一下回填关键字。
                 出现/消失走 sd-tags 过渡（高度 + 淡入 + 轻微下移），让下面的列表平滑让位，
                 而不是瞬间跳一格 —— 外层高度固定，所以弹窗本身不动。 -->
            <Transition name="sd-tags">
              <div v-if="!keyword.trim() && history.length" class="sd-history">
                <span class="sd-history-label">最近搜索</span>
                <button
                  v-for="h in history"
                  :key="h"
                  type="button"
                  class="sd-history-item"
                  @click="useHistory(h)"
                >{{ h }}</button>
              </div>
            </Transition>

            <!-- 分组筛选：结果跨多个分组时给一排 chips，点一下只看该类。
                 「全部」常驻在第一位并高亮当前状态（未筛选时就是它），避免「没选中任何一项」
                 看起来像筛选失效。放在滚动容器外面，滚动列表不会把它带走。 -->
            <Transition name="sd-tags">
              <div v-if="chips.length > 1" class="sd-chips">
                <button
                  type="button"
                  class="sd-chip"
                  :class="{ 'sd-chip-on': !effectiveGroup }"
                  @click="clearGroup"
                >全部<span class="sd-chip-num">{{ results.length }}</span></button>
                <button
                  v-for="c in chips"
                  :key="c.name"
                  type="button"
                  class="sd-chip"
                  :class="{ 'sd-chip-on': effectiveGroup === c.name }"
                  @click="toggleGroup(c.name)"
                >{{ c.name }}<span class="sd-chip-num">{{ c.count }}</span></button>
              </div>
            </Transition>

            <!-- p-1：聚焦/高亮项有外发光时，滚动容器 overflow 会裁掉四边 -->
            <!-- 空态时关掉纵向滚动：空态块是 height:100%，加上容器的 p-1 内边距会高出几像素，
                 overflow-y-auto 就会冒出一条多余的滚动条。空态本来也不需要滚动。 -->
            <div
              ref="listEl"
              class="flex-1 min-h-0 p-1 space-y-1 app-custom-scroll"
              :class="visibleResults.length || remoteSearching ? 'overflow-y-auto' : 'overflow-y-hidden'"
            >
              <!-- 搜索无结果：与列表型表格的空态同款版式（图标 + 文案 + 按钮）。
                   给出「清除搜索」而不是只留一句提示：搜不到时最该做的是换个词或清掉重来，
                   给个一键清除的入口，比让用户自己退格更快。 -->
              <div v-if="!visibleResults.length && !remoteSearching" class="sd-empty">
                <svg class="sd-empty-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                  <circle cx="21" cy="21" r="12" opacity="0.75" />
                  <path d="M30 30l10 10" stroke-linecap="round" opacity="0.85" />
                </svg>
                <p class="sd-empty-text">暂无搜索结果</p>
                <!-- 搜不到时最该告诉用户「还能怎么写」：字段限定是最容易被忽略的用法 -->
                <p class="sd-empty-hint">可用 姓名:张三 限定搜索字段</p>
                <button type="button" class="sd-empty-btn" @click="clearKeyword">清除搜索</button>
              </div>
              <template v-else>
                <button
                  v-for="(r, idx) in visibleResults"
                  :key="keyword + '#' + r.id"
                  class="tb-search-row w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm text-text transition-theme"
                  :class="{ 'bg-surface-hover': idx === activeIndex }"
                  :style="{ animationDelay: Math.min(idx, 10) * 30 + 'ms' }"
                  @mousedown.prevent="goToResult(r)"
                  @mouseenter="activeIndex = idx"
                >
                  <span class="w-5 flex items-center justify-center shrink-0 text-base">
                    <IconGlyph v-if="iconStyle === 'color' && r.icon" :name="r.icon" :size="16" :stroke-width="2" />
                    <template v-else>{{ r.emoji }}</template>
                  </span>
                  <span class="flex-1 min-w-0 truncate">{{ r.label }}</span>
                  <span v-if="r.sub" class="shrink-0 max-w-[40%] truncate text-xs text-text-muted">{{ r.sub }}</span>
                  <span class="shrink-0 text-xs text-text-muted">{{ r.group }}</span>
                </button>
              </template>
            </div>
          </div>
          <CustomScrollbar :target="listEl" />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup vapor>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import axios from 'axios'
import {
  PAGES, SETTINGS_SECTIONS, SETTINGS_ITEMS, matchKeywords, REMOTE_SOURCE, buildRemoteResults,
} from '../../config/searchData.js'
import { useSeq } from '../../composables/useSeq.js'
import { useThemeStore } from '../../stores/theme'
import IconGlyph from '../../components/base/IconGlyph.vue'
import CustomScrollbar from './CustomScrollbar.vue'

const props = defineProps({ visible: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const router = useRouter()
const route = useRoute()

// 图标样式：color 档搜索结果用语义图标（与侧栏一致），emoji 档保留原有表情
const { iconStyle } = storeToRefs(useThemeStore())

const inputEl = ref(null)
const listEl = ref(null)
// 关键字 / 高亮项
const keyword = ref('')
const activeIndex = ref(0)
// 分组筛选：点中某个分组后只看这一类（空串 = 不筛选）
const activeGroup = ref('')
// 最近搜索：只存用户真的点进去过的关键字，最多 6 条
const HISTORY_KEY = 'classnest.search.history'
const HISTORY_MAX = 6
const history = ref(readHistory())
// 远程数据搜索结果（后端 /api/search 回填），与本地页面/设置结果合并展示
const remoteResults = ref([])
// 远程搜索进行中：用于避免本地无结果时过早闪现「无匹配结果」
const remoteSearching = ref(false)
// pinyin-match 的 match 函数（懒加载，首次打开搜索时动态 import，加载完成后本地结果自动重算）
const pinyinMatch = ref(null)

let pinyinPromise = null
let remoteTimer = null
// 在途远程请求的取消器：用户继续输入时上一次的结果已经没用了，让后端别白算完
let remoteAbort = null

// 本地可搜项（页面 + 设置）：静态数据，构建一次即可
const items = (() => {
  const out = []
  PAGES.forEach((p) => out.push({
    id: 'page:' + p.to, kind: 'page', group: '页面', label: p.label, emoji: p.emoji, icon: p.icon,
    route: p.to, keywords: [p.py], sub: p.group,
  }))
  SETTINGS_SECTIONS.forEach((s) => out.push({
    id: 'sec:' + s.key, kind: 'setting-section', group: '设置', label: s.label, emoji: '⚙️', icon: 'settings',
    route: '/settings', query: { focus: s.key }, keywords: [s.py], sub: '',
  }))
  SETTINGS_ITEMS.forEach((it) => out.push({
    id: 'item:' + it.section + ':' + it.label, kind: 'setting-item', group: '设置', label: it.label, emoji: '🔧', icon: 'wrench',
    route: '/settings', query: { focus: it.section + '|' + it.label }, keywords: [it.py], sub: '',
  }))
  return out
})()

const results = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return items
  const local = items.filter(r => matchKeywords(r.label + ' ' + (r.sub || ''), r.keywords, q, pinyinMatch.value))
  // 本地（页面/设置）结果在前，远程（业务数据）结果在后
  return local.concat(remoteResults.value)
})

// 没输入时不筛选：此时列表是全部页面/设置项，按「页面/设置」切分没有意义
const chips = computed(() => {
  if (!keyword.value.trim()) return []
  const order = []
  const count = new Map()
  for (const r of results.value) {
    if (!count.has(r.group)) { count.set(r.group, 0); order.push(r.group) }
    count.set(r.group, count.get(r.group) + 1)
  }
  // 按首次出现顺序展示，与结果列表的排列一致，不按数量重排（位置会跳）
  return order.map(name => ({ name, count: count.get(name) }))
})

// 选中的分组在新一轮结果里已经不存在时自动失效（否则会一直筛出空列表）
const effectiveGroup = computed(() => (
  chips.value.some(c => c.name === activeGroup.value) ? activeGroup.value : ''
))
const visibleResults = computed(() => (
  effectiveGroup.value ? results.value.filter(r => r.group === effectiveGroup.value) : results.value
))

function toggleGroup(name) {
  activeGroup.value = effectiveGroup.value === name ? '' : name
  activeIndex.value = 0
}

// 「全部」= 取消筛选，回到不分类的完整列表
function clearGroup() {
  activeGroup.value = ''
  activeIndex.value = 0
}

// 最近搜索：读写 localStorage，坏数据/不可用时静默退化为空列表
function readHistory() {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).slice(0, HISTORY_MAX) : []
  } catch (_) {
    return []
  }
}
function rememberKeyword(text) {
  const v = String(text || '').trim()
  if (!v) return
  const next = [v, ...history.value.filter(x => x !== v)].slice(0, HISTORY_MAX)
  history.value = next
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)) } catch (_) {}
}
function useHistory(text) {
  keyword.value = text
  nextTick(() => inputEl.value?.focus())
}

watch(keyword, () => {
  activeIndex.value = 0
  activeGroup.value = ''
  scheduleRemoteSearch()
})

// 打开弹窗（visible 由 false 变为 true）：清空关键字重新开始，列全部可搜项并聚焦输入框
// （内置远程搜索 + 拼音库在首次打开时懒加载，行为与抽出前一致）
watch(() => props.visible, (v) => { if (v) onOpened() })
// 兜住「点击时 chunk 还没加载完」：组件挂载时若已是打开态，同样走一次打开初始化
onMounted(() => { if (props.visible) onOpened() })

function onOpened() {
  keyword.value = ''
  activeIndex.value = 0
  ensurePinyin()
  nextTick(() => inputEl.value?.focus())
}

// 懒加载拼音库：仅在首次打开搜索时动态 import（独立 chunk，不进初始包），
// 加载完成后把 match 函数写回响应式字段，本地搜索结果随之重算。
function ensurePinyin() {
  if (pinyinPromise) return
  pinyinPromise = import('pinyin-match')
    .then((m) => { const PM = m.default || m; pinyinMatch.value = PM.match })
    .catch(() => { pinyinPromise = null })
}

// 远程数据搜索：输入 debounce（约 250ms）后拉取 /api/search，回填 remoteResults。
// 关键字为空立即清空，不留上一轮结果。
//
// 竞态守卫用请求序号而不是「比较关键字」：后者在「输入 a → 删空 → 再输 a」时会失效
// —— 两次 q 相同，旧响应照样能通过检查，把过期的结果盖上来。
const remoteSeq = useSeq()

function scheduleRemoteSearch() {
  clearTimeout(remoteTimer)
  const q = keyword.value.trim()
  if (!q) {
    remoteResults.value = []
    remoteSearching.value = false
    // 清空时作废在途请求，否则它回来后会把结果又填回空列表
    remoteSeq.invalidate()
    abortRemote()
    return
  }
  remoteSearching.value = true
  remoteTimer = setTimeout(() => fetchRemoteSearch(q), 250)
}

// 取消在途请求。axios 的取消会在 catch 里抛 ERR_CANCELED，那里要放行（不是失败）。
function abortRemote() {
  if (!remoteAbort) return
  remoteAbort.abort()
  remoteAbort = null
}

async function fetchRemoteSearch(q) {
  const my = remoteSeq.take()
  // 先取消上一次：后端在做的是同步查询，越早掐掉越省 CPU
  abortRemote()
  remoteAbort = new AbortController()
  try {
    const { data } = await axios.get(REMOTE_SOURCE.endpoint, { params: { q }, signal: remoteAbort.signal })
    // 响应回来时已不是最新一次检索：丢弃（快速输入时后发的请求可能先到）
    if (!remoteSeq.isLatest(my)) return
    remoteResults.value = buildRemoteResults(data && data.groups)
  } catch (e) {
    // 主动取消：不是错误，保持现有结果不动
    if (e && (e.code === 'ERR_CANCELED' || e.name === 'CanceledError')) return
    // 后端未就绪/未登录：静默，仅清空远程结果，不影响本地搜索
    if (!remoteSeq.isLatest(my)) return
    remoteResults.value = []
  } finally {
    if (remoteSeq.isLatest(my)) remoteSearching.value = false
  }
}

function moveActive(dir) {
  // 键盘导航走「筛选后」的列表，否则上下键会跳到被筛掉的项上
  const n = visibleResults.value.length
  if (!n) return
  let i = activeIndex.value + dir
  if (i < 0) i = n - 1
  if (i >= n) i = 0
  activeIndex.value = i
  nextTick(() => {
    listEl.value?.querySelectorAll('.tb-search-row')?.[activeIndex.value]
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function confirmActive() {
  const r = visibleResults.value[activeIndex.value]
  if (r) goToResult(r)
}

// 清除搜索：清空关键字并把焦点留在输入框，方便直接换个词再搜。
// 远程结果也要一并清掉 —— keyword 变化会触发 watch → scheduleRemoteSearch，
// 关键字为空时它会自行清空 remoteResults，这里只需管本地文本与焦点。
function clearKeyword() {
  keyword.value = ''
  nextTick(() => inputEl.value?.focus())
}

function goToResult(r) {
  if (!r) return
  // 记一次「最近搜索」：只记真的点进去过的词，比一直记输入过程更接近用户的意图
  rememberKeyword(keyword.value)
  emit('close')
  const target = r.query ? { path: r.route, query: r.query } : r.route
  // 已在目标页且 query 未变时不重复导航（设置页应用后会自动清空 query，故再选同项仍能重新定位）
  if (route.fullPath === router.resolve(target).fullPath) return
  router.push(target)
}
</script>

<style scoped>
/* 搜索无结果：版式对齐列表型表格的 .dt-empty（图标 + 文案 + 按钮）。
   列表型表格在毛玻璃页面上，所以那边用透明底 + backdrop-filter；
   这里在弹窗的白底卡片里，改为浅灰底块，避免看起来像块补丁。 */
.sd-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  text-align: center;
  /* 抵消父容器 space-y-1 给首元素加的 margin-top，否则整块被顶下去、底部溢出 */
  margin-top: -4px;
  animation: sd-empty-in 0.3s ease both;
}
@keyframes sd-empty-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.sd-empty-icon {
  width: 44px;
  height: 44px;
  color: var(--color-text-muted, #94a3b8);
  opacity: 0.9;
}
.sd-empty-text {
  margin: 0;
  font-size: 15px;
  letter-spacing: 0.5px;
  color: var(--color-text-muted, #94a3b8);
}
/* 空态里的用法提示：比正文小一号、更淡，只在搜不到时出现 */
.sd-empty-hint {
  margin: -6px 0 0;
  font-size: 12px;
  color: var(--color-text-muted, #94a3b8);
  opacity: 0.85;
}
/* 按钮配色与 DynamicTable 的 .dt-empty-btn 保持一致（#d9e5f8 底 + #1e3a6b 字） */
.sd-empty-btn {
  min-width: 100px;
  padding: 7px 18px;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.4;
  color: #1e3a6b;
  background: #d9e5f8;
  border: 1px solid #c3d6f2;
  border-radius: var(--radius-control);
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(30, 58, 107, 0.10);
  transition: transform 0.15s ease, background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}
.sd-empty-btn:hover {
  background: #c9d9f2;
  border-color: #a9c3ea;
}
.sd-empty-btn:active { transform: scale(0.98); }
.sd-empty-btn:focus-visible {
  outline: 2px solid rgba(30, 58, 107, 0.55);
  outline-offset: 2px;
}

/* ===== 分组筛选 chips ===== */
/* 左边距 18px = 列表容器 p-1(4) + 结果行 px-3(12) + 图标在 w-5(20px) 框内居中的 2px，
   这样 chips 的左边缘与下方结果行里的图标对齐，不再吊在弹窗内边距上。 */
.sd-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
  padding-left: 18px;
}
.sd-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-secondary, #64748b);
  background: var(--color-surface-hover, #f1f5f9);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 9999px;
  cursor: pointer;
  transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}
.sd-chip:hover {
  background: #d9e5f8;
  border-color: #c3d6f2;
  color: #1e3a6b;
}
/* 选中态沿用空态按钮的配色（#d9e5f8 / #1e3a6b），全弹窗只有一套强调色 */
.sd-chip-on {
  color: #1e3a6b;
  background: #d9e5f8;
  border-color: #a9c3ea;
  font-weight: 600;
}
.sd-chip-num {
  font-size: 11px;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

/* ===== 最近搜索 ===== */
.sd-history {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  /* 同上：与结果行的图标列对齐 */
  padding-left: 18px;
}
.sd-history-label {
  font-size: 12px;
  color: var(--color-text-muted, #94a3b8);
}
.sd-history-item {
  padding: 2px 8px;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text, #334155);
  background: var(--color-surface-hover, #f1f5f9);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-control, 6px);
  cursor: pointer;
  transition: background-color 0.2s ease, border-color 0.2s ease;
}
.sd-history-item:hover {
  background: #d9e5f8;
  border-color: #c3d6f2;
}

/* ===== 标签行（最近搜索 / 分组 chips）的出现与消失 =====
   外层结果区高度固定，所以「展开」的观感是下面的列表平滑收缩，弹窗本身不动。
   max-height 只需过渡到一个大于实际高度的上限：行数变化时不会卡在中间值。 */
.sd-tags-enter-active,
.sd-tags-leave-active {
  overflow: hidden;
  transition: max-height 0.22s cubic-bezier(0.32, 0.72, 0.24, 1),
              opacity 0.16s ease,
              transform 0.22s ease,
              margin-bottom 0.22s ease;
}
.sd-tags-enter-from,
.sd-tags-leave-to {
  max-height: 0;
  margin-bottom: 0;
  opacity: 0;
  transform: translateY(-4px);
}
.sd-tags-enter-to,
.sd-tags-leave-from {
  max-height: 120px;
  opacity: 1;
  transform: none;
}

/* 单个标签的出现：v-for 按 key 复用已有节点，所以连续输入时只有「新冒出来的那个」
   播一次，已经存在的标签不会反复闪。 */
.sd-chip,
.sd-history-item {
  animation: sd-tag-in 0.18s ease both;
}
@keyframes sd-tag-in {
  from { opacity: 0; transform: scale(0.92); }
  to { opacity: 1; transform: none; }
}
</style>
