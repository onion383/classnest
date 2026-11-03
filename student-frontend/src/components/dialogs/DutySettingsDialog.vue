<template>
  <DialogShell :visible="visible" :z-index="50" overlay-class="bg-black/30">
      <div class="bg-surface rounded-xl p-6 w-[680px] max-w-[94vw] shadow-card border border-border dialog-card">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold">值日设置</h3>
          <button
            @click="importVisible = true"
            class="bg-warning text-text-inverse px-3 py-1.5 rounded text-sm flex items-center gap-1.5"
            title="从 Excel 批量导入劳动项目"
          >
            <IconGlyph name="download" :size="14" tint="current" /> 从 Excel 表格批量导入
          </button>
        </div>

        <!-- 时间（星期几） -->
        <div class="mb-5">
          <p class="font-semibold mb-2 text-text">时间</p>
          <div class="flex flex-wrap gap-2">
            <label
              v-for="d in weekDays"
              :key="d"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border cursor-pointer select-none text-sm transition-theme"
              :class="isDayOn(d) ? 'bg-info/15 border-info text-info' : 'bg-surface-hover border-border text-text-secondary'"
            >
              <input type="checkbox" class="accent-info" :value="d" v-model="localDays" />
              {{ d }}
            </label>
          </div>
        </div>

        <!-- 劳动项目 -->
        <div class="mb-4">
          <p class="font-semibold mb-2 text-text">劳动项目</p>
          <div
            class="min-h-[120px] rounded-lg border-2 border-dashed border-border p-2 space-y-2"
            :class="dragSource ? 'border-primary/60' : ''"
            @dragover.prevent="onBoxOver"
            @drop.prevent="onBoxDrop"
          >
            <div
              v-for="(it, i) in localItems"
              :key="it.name"
              class="flex items-center gap-2 bg-surface-hover rounded-lg px-2 py-1.5 border border-border"
              :class="dragSource && dragSource.type === 'box' && overIndex === i ? 'ring-2 ring-primary/50' : ''"
              @dragover.prevent.stop="onRowOver(i)"
              @drop.prevent.stop="onRowDrop(i)"
            >
              <span
                class="grip cursor-grab text-text-muted select-none px-1"
                title="拖动排序"
                draggable="true"
                @dragstart="onGripDrag(i)"
              >⋮⋮</span>

              <span class="flex-1 min-w-0 font-medium text-text truncate">{{ it.name }}</span>

              <div class="flex items-center gap-1 text-xs whitespace-nowrap">
                <span class="text-text-muted">辛苦度</span>
                <input v-model.number="it.difficulty" type="number" step="0.1" min="0" class="w-14 border rounded px-1 py-0.5 text-sm" />
              </div>

              <div class="flex items-center gap-1 text-xs whitespace-nowrap">
                <span class="text-text-muted">人数</span>
                <input v-model.number="it.count" type="number" min="1" class="w-14 border rounded px-1 py-0.5 text-sm" />
              </div>

              <button class="text-danger hover:bg-danger/10 rounded px-1.5 py-0.5 text-sm transition-theme" title="删除" @click="removeItem(i)">删除</button>
            </div>

            <div v-if="!localItems.length" class="text-center py-6 text-text-muted/60 text-sm">
              从下方拖动劳动项目到此处
            </div>
          </div>
          <p class="text-xs text-text-muted mt-1">提示：可拖动下方项目放入上面，或拖动项目左侧 ⋮⋮ 调整顺序</p>
        </div>

        <!-- 可拖入的项目池 -->
        <div class="mb-5">
          <p class="font-semibold mb-2 text-text">可选项目</p>
          <div class="flex flex-wrap gap-2">
            <span
              v-for="name in poolChips"
              :key="name"
              class="px-3 py-1.5 rounded-lg border text-sm cursor-move select-none transition-theme"
              :class="isInList(name)
                ? 'opacity-40 border-border bg-surface-hover text-text-muted'
                : 'border-info/40 bg-info/10 text-info hover:bg-info/20'"
              :draggable="!isInList(name)"
              @dragstart="onPoolDrag(name)"
              :title="isInList(name) ? '已在列表' : '拖入上方方框'"
            >{{ name }}</span>

            <!-- 添加项目 -->
            <div class="flex items-center gap-1.5">
              <template v-if="adding">
                <input
                  v-model="newPoolName"
                  ref="newInput"
                  class="w-28 border px-2 py-1 rounded text-sm"
                  placeholder="项目名"
                  @keyup.enter="confirmAdd"
                  @blur="confirmAdd"
                />
                <button class="text-info hover:bg-info/10 rounded px-1.5 py-0.5 text-sm transition-theme" @click="confirmAdd">✓</button>
                <button class="text-text-muted hover:bg-surface-hover rounded px-1.5 py-0.5 text-sm transition-theme" @click="cancelAdd">✕</button>
              </template>
              <button
                v-else
                class="px-3 py-1.5 rounded-lg border border-dashed border-text-muted text-text-secondary text-sm hover:bg-surface-hover transition-theme"
                @click="startAdd"
              >+ 添加项目</button>
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-2 border-t border-border">
          <button class="bg-surface-hover px-4 py-2 rounded text-text" @click="cancel">取消</button>
          <button class="bg-info text-text-inverse px-4 py-2 rounded" @click="save">保存设置</button>
        </div>

        <!-- 从 Excel 导入：只填充当前弹窗的劳动项目列表，仍需点「保存设置」才落库 -->
        <ImportExcel
          v-if="importMounted"
          :visible="importVisible"
          :existingFields="importFields"
          :requiredFields="[['劳动项目', '项目', '劳动项目名称', '项目名称', '值日项目']]"
          :templateName="'值日设置标准导入表'"
          @import-data="onImportData"
          @cancel="importVisible = false"
        />
      </div>
  </DialogShell>
</template>

<script setup vapor>
import { ref, computed, watch, nextTick, defineAsyncComponent } from 'vue'
import '../../styles/dialog-transition.css'
import DialogShell from '../base/DialogShell.vue'
import IconGlyph from '../base/IconGlyph.vue'
import { useNotification } from '../../composables/useNotification.js'
import { resolveHeader, normalizeLoose } from '../../utils/importSheet.js'

const loadImportExcel = () => import('../import-export/ImportExcel.vue')
const ImportExcel = defineAsyncComponent(loadImportExcel)

const WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const DEFAULT_POOL = ['擦黑板', '倒垃圾', '拖地', '扫地', '摆桌子']

defineOptions({ name: 'DutySettingsDialog' })

const props = defineProps({
  visible: Boolean,
  days: { type: Array, default: () => ['周一', '周二', '周三', '周四', '周五'] },
  items: { type: Array, default: () => [] }
})
const emit = defineEmits(['save', 'cancel'])

// 组件内部使用本地副本，避免直接修改父传入的 props/响应式数据
const localDays = ref([])
const localItems = ref([])
const customPool = ref([])
const weekDays = ref(WEEK)
const dragSource = ref(null) // { type: 'pool', name } 或 { type: 'box', index }
const overIndex = ref(-1)
const adding = ref(false)
const newPoolName = ref('')
const newInput = ref(null)

const poolChips = computed(() => [...DEFAULT_POOL, ...customPool.value])
const isInList = computed(() => (name) => localItems.value.some(it => it.name === name))

watch(() => props.visible, (val) => {
  if (val) {
    localDays.value = [...props.days]
    localItems.value = props.items.map(it => ({ name: it.name, difficulty: it.difficulty == null ? 0.6 : it.difficulty, count: it.count || 1 }))
    customPool.value = []
    adding.value = false
    newPoolName.value = ''
    dragSource.value = null
    overIndex.value = -1
  }
})

function isDayOn(d) { return localDays.value.includes(d) }
function removeItem(i) { localItems.value.splice(i, 1) }
// 项目池拖入
function onPoolDrag(name) { dragSource.value = { type: 'pool', name } }
// 列表内拖动排序
function onGripDrag(i) {
  if (i >= localItems.value.length) return
  dragSource.value = { type: 'box', index: i }
}
// 悬停在空区域（末尾追加）
function onBoxOver() {
  if (dragSource.value) overIndex.value = localItems.value.length
}
// 悬停在某一行
function onRowOver(i) {
  if (dragSource.value) overIndex.value = i
}
function onRowDrop(i) {
  if (!dragSource.value) return
  placeAt(i)
}
function onBoxDrop() {
  if (!dragSource.value) return
  placeAt(overIndex.value >= 0 ? overIndex.value : localItems.value.length)
}
function placeAt(targetIdx) {
  const idx = Math.max(0, Math.min(targetIdx, localItems.value.length))
  const source = dragSource.value
  if (source.type === 'pool') {
    if (!localItems.value.some(it => it.name === source.name)) {
      localItems.value.splice(idx, 0, { name: source.name, difficulty: 0.6, count: 1 })
    }
  } else if (source.type === 'box' && source.index !== idx) {
    const moved = localItems.value.splice(source.index, 1)[0]
    localItems.value.splice(idx, 0, moved)
  }
  dragSource.value = null
  overIndex.value = -1
}
function startAdd() {
  adding.value = true
  newPoolName.value = ''
  nextTick(() => { if (newInput.value) newInput.value.focus() })
}
function cancelAdd() {
  adding.value = false
  newPoolName.value = ''
}
function confirmAdd() {
  const name = (newPoolName.value || '').trim()
  if (name) {
    if (defaultPoolHas(name) || customPool.value.includes(name)) {
      adding.value = false
      newPoolName.value = ''
      return
    }
    customPool.value.push(name)
  }
  adding.value = false
  newPoolName.value = ''
}
function defaultPoolHas(name) { return DEFAULT_POOL.includes(name) }

// ==================== 从 Excel 导入劳动项目 ====================
const importVisible = ref(false)
const importMounted = ref(false)
watch(importVisible, (v) => { if (v) importMounted.value = true })
const importFields = [
  { name: '劳动项目' },
  { name: '人数' },
  { name: '辛苦度' }
]
// 文本里取数字：先取阿拉伯数字（全角先归一），没有再认「两 / 六 / 十」等中文数字
const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
function pickNumber(raw) {
  const s = String(raw == null ? '' : raw).normalize('NFKC').trim()
  const m = s.replace(/[，,]/g, '').match(/\d+(\.\d+)?/)
  if (m) return Number(m[0])
  const cn = s.match(/[一二两三四五六七八九十]/)
  return cn ? CN_DIGITS[cn[0]] : null
}
// 人数：接受「2」「2人」「两 名」「２人」等写法；提取不到数字时回退默认 1
function parseCount(raw) {
  if (raw == null || raw === '') return 1
  const n = pickNumber(raw)
  return n == null ? 1 : Math.max(1, Math.round(n) || 1)
}
// 辛苦度：接受「0.6」「60%」「6 成」「六成」等写法；0.6 为默认
function parseDifficulty(raw) {
  if (raw == null || raw === '') return 0.6
  const s = String(raw).normalize('NFKC')
  const n = pickNumber(s)
  if (n == null) return 0.6
  const value = s.includes('%') ? n / 100 : (/成/.test(s) ? n / 10 : n)
  return Number.isFinite(value) ? Math.max(0, value) : 0.6
}
function onImportData({ fields, rows }) {
  importVisible.value = false
  // 表头宽松匹配：劳动项目 / 项目 / 项目名称、人数 / 需要人数、辛苦度 / 难度 等
  const nameHeader = resolveHeader(fields, ['劳动项目', '项目', '劳动项目名称', '项目名称', '值日项目'])
  const countHeader = resolveHeader(fields, ['人数', '需要人数', '人数需求', '每班人数'])
  const diffHeader = resolveHeader(fields, ['辛苦度', '辛苦程度', '难度', '劳动强度'])
  if (!nameHeader) {
    useNotification().error('未识别到「劳动项目」列，请检查表头')
    return
  }
  const objects = rows.map(row => {
    const obj = {}
    fields.forEach((name, i) => { obj[name] = String(row[i] ?? '').trim() })
    return obj
  })
  const errors = []
  const next = []
  const seen = new Set()
  objects.forEach((obj, idx) => {
    const rowNo = idx + 1
    const name = obj[nameHeader]
    if (!name) { errors.push(`第 ${rowNo} 行缺少「劳动项目」`); return }
    const key = normalizeLoose(name)
    if (seen.has(key)) return // 同名项目（含多空格/全角写法）只取第一行，避免重复项
    seen.add(key)
    const count = parseCount(countHeader ? obj[countHeader] : '')
    const difficulty = parseDifficulty(diffHeader ? obj[diffHeader] : '')
    next.push({ name, difficulty, count })
  })
  if (errors.length) {
    useNotification().error(errors[0] + (errors.length > 1 ? `（共 ${errors.length} 处问题）` : ''))
    return
  }
  if (!next.length) return useNotification().info('没有可导入的劳动项目')
  localItems.value = next
  useNotification().success(`已导入 ${next.length} 个劳动项目，请确认后点「保存设置」`)
}
function save() {
  // 过滤空姓名
  const items = localItems.value
    .filter(it => (it.name || '').trim())
    .map(it => ({ name: it.name.trim(), difficulty: Number(it.difficulty) || 0, count: Math.max(1, Math.round(Number(it.count)) || 1) }))
  // 天数按 周一到周日 固定顺序输出，避免因勾选顺序导致列乱序
  const days = WEEK.filter(d => localDays.value.includes(d))
  emit('save', { days, items })
}
function cancel() { emit('cancel') }
</script>

<style scoped>
.grip { cursor: grab; }
.grip:active { cursor: grabbing; }
</style>