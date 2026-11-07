<template>
  <DialogShell :visible="visible" :z-index="50" overlay-class="bg-black/30">
    <div class="bg-surface rounded-lg p-5 shadow-card dialog-card flex flex-col overflow-hidden" style="width: 900px; height: 720px; max-width: 92vw;">
      <h3 class="text-lg font-bold mb-1">🧹 值日智能排表</h3>
      <p class="text-xs text-text-muted mb-3">只有一级条件，按顺序从第一条执行到最后一条；越靠后的条件越重要，可部分覆盖前面的结果。结果仅预览，确认后才写回当前值日表。</p>

      <!-- 人数不足：总槽位 < 班级学生数时先确认 -->
      <ConfirmDialog
        :visible="slotWarningVisible"
        title="人数不足提示"
        :message="slotWarningMessage"
        confirm-text="确认继续"
        extra-text="打开值日设置"
        :show-cancel="false"
        @confirm="proceedStart"
        @extra="openSettingsFromWarning"
      />

      <!-- 拒绝提示 -->
      <div v-if="rejectText" class="mb-3 px-3 py-2 rounded bg-warning/15 border border-warning/40 text-warning text-sm">{{ rejectText }}</div>

      <!-- 数据源：本次排表用哪些人。默认「现有排表表格」= 只排当前值日表里已有的人；
           选「全部同学」= 按学生表里的全班同学排 -->
      <div class="mb-3 flex items-center gap-3">
        <label class="text-sm font-medium shrink-0">选择数据源</label>
        <AppSelect v-model="dataSource" :options="dataSourceOptions" class="w-44" @change="onDataSourceChange" />
        <span class="text-xs text-text-muted">{{ dataSourceHint }}</span>
      </div>

      <!-- 排表条件：一层平铺，一行一条件（可拖拽排序、可重复添加、不限数量） -->
      <div class="mb-3">
        <div class="flex items-center justify-between mb-2">
          <label class="text-sm font-medium block">排表条件</label>
          <button @click="startArrange" class="bg-primary text-text-inverse px-3 py-1.5 rounded border-none cursor-pointer text-sm">{{ arranged ? '🔀 换一换' : '▶ 开始排表' }}</button>
        </div>
        <div
          class="border border-dashed border-border rounded-lg p-2 bg-surface/55 backdrop-blur-md"
          @dragover.prevent
          @drop="onDropZone"
        >
          <div class="max-h-[112px] overflow-auto" @scroll="sortCond.onScroll">
            <div v-if="conditions.length === 0" class="text-sm text-text-muted py-1">把下方的条件选项拖到这里添加</div>
            <div
              v-for="(node, ni) in conditions"
              :key="node.uid"
              :data-cond-idx="ni"
              class="mb-1 last:mb-0"
              :class="{ 'cond-row-dragging': dragIdx === ni }"
              @dragover.prevent
              @drop.stop="onDropOnRow($event, ni)"
            >
              <div class="flex flex-wrap items-center gap-2 px-3 py-1.5 rounded bg-primary text-text-inverse text-sm">
                <span class="flex items-center gap-2 shrink-0">
                  <span class="text-xs tabular-nums text-text-inverse/60 select-none">{{ ni + 1 }}</span>
                  <span class="cursor-grab select-none text-text-inverse/70" @mousedown="sortCond.handleDown($event, ni)">⠿</span>
                </span>
                <span class="font-semibold whitespace-nowrap">{{ node.label }}</span>
                <template v-for="s in segmentsOf(node)" :key="s.idx">
                  <span v-if="s.t === 'text'" class="text-text-inverse/90">{{ s.v }}</span>
                  <AppSelect
                    v-else
                    :model-value="getField(node, s.path)"
                    :options="s.options"
                    :placeholder="s.placeholder"
                    :class="s.width"
                    @update:model-value="v => setField(node, s.path, v)"
                  />
                </template>
                <span class="ml-auto flex items-center gap-2 shrink-0">
                  <span v-if="satisfactionOf(node) !== null" class="text-xs px-1.5 py-0.5 rounded bg-white/20 text-text-inverse border border-white/30">{{ satisfactionLabel(node) }} {{ satisfactionOf(node) }}%</span>
                  <button @click="removeCondition(ni)" class="dlg-close cond-close" title="删除该条件">✕</button>
                </span>
              </div>
            </div>
          </div>
          <div
            class="mt-1 text-xs text-text-muted px-2 py-1 rounded border border-dashed border-info/40 flex items-center select-none"
            @dragover.prevent
            @drop.stop="onDropZone"
          >拖动到这里新增条件</div>
        </div>
        <p class="mt-1 text-xs text-text-muted">条件按顺序依次生效；同类型条件可以重复添加。</p>
      </div>

      <!-- 条件选项：拖到上方即可添加 -->
      <div class="mb-3">
        <label class="text-sm font-medium mb-2 block">条件选项（拖到上方添加，可重复添加）</label>
        <div class="flex flex-wrap gap-2">
          <div
            v-for="opt in conditionButtons"
            :key="opt.key"
            draggable="true"
            @dragstart="onOptionDragStart($event, opt.key)"
            class="px-3 py-2 rounded border border-border bg-primary text-text-inverse cursor-grab select-none text-sm shadow-sm hover:border-info"
          >
            {{ opt.label }}
          </div>
        </div>
      </div>

      <!-- 预览 -->
      <div class="flex-1 overflow-auto border border-border rounded mb-4" style="min-height: 200px;">
        <!-- maxHeight=0：预览区外层已是 flex-1 overflow-auto，这里再限高会形成嵌套滚动条 -->
        <GridView
          v-if="previewRows.length"
          :key="previewKey"
          :col-headers="daysArr"
          :rows="previewRows"
          :hide-meta-columns="true"
          :show-row-number="true"
          :disable-row-drag="true"
          row-header-label="劳动项目"
          :enable-candidate="false"
          :min-table-height="200"
          :max-height="0"
        />
        <div v-else class="flex items-center justify-center h-full text-text-muted text-sm py-8">设置劳动项目后开始排表</div>
      </div>

      <div class="flex justify-between gap-2">
        <button v-if="draft && draft.exists" @click="onClearDraft" class="text-text-muted hover:text-text px-4 py-2 rounded text-sm border border-border bg-surface-hover">清除草稿</button>
        <div v-else></div>
        <div class="flex gap-2">
          <button @click="onSaveDraft" :disabled="!arranged" class="bg-surface-hover px-4 py-2 rounded text-text border border-border disabled:opacity-40 disabled:cursor-not-allowed">保存草稿</button>
          <button @click="$emit('cancel')" class="bg-surface-hover px-4 py-2 rounded text-text border border-border">取消</button>
          <button @click="confirm" class="bg-info text-text-inverse px-4 py-2 rounded border-none">确定</button>
        </div>
      </div>
    </div>
  </DialogShell>
</template>

<script setup vapor>
import { ref, computed, watch, nextTick, toRef, onBeforeUnmount } from 'vue'
import GridView from '../../tables/GridView/GridView.vue'
import AppSelect from '../../base/AppSelect.vue'
import DialogShell from '../../base/DialogShell.vue'
import ConfirmDialog from '../../base/ConfirmDialog.vue'
import '../../../styles/dialog-transition.css'
import { useRowSortDrag } from '../../../composables/useRowSortDrag.js'
import { useDutyArrangementPipeline } from './DutyArrangementDialog.pipeline.js'
import { useDutyArrangementOptions } from './DutyArrangementDialog.options.js'
import { useDutyArrangementDimension } from './DutyArrangementDialog.dimension.js'

defineOptions({ name: 'DutyArrangementDialog' })
const props = defineProps({
  visible: Boolean,
  // 值日全局设置：days（星期）、items（[{name, count, ...}]）
  days: { type: Array, default: () => [] },
  items: { type: Array, default: () => [] },
  // 全班学生（含 id / 姓名）
  students: { type: Array, default: () => [] },
  // 值日项目权重表：{ 项目名: { 星期: 权重值 } }
  weights: { type: Object, default: () => ({}) },
  // 公平账本：{ 学生姓名: 累计权重值 }
  ledger: { type: Object, default: () => ({}) },
  // 草稿：{ exists, cells, settings, conditions, savedAt }
  draft: { type: Object, default: () => ({ exists: false }) },
  // 当前值日表：{ 项目: { 星期: [姓名,...] } }
  baseCells: { type: Object, default: () => ({}) },
  // 当前座位表：{ rows, cols, mode, seats }，用于抽取同桌/六位/一列等学生分组
  seat: { type: Object, default: () => ({ rows: 0, cols: 0, mode: 'single', seats: [] }) },
  // 大扫除模式：列是「第X大组 / 第X小组」而不是星期，整张表就是一次活动
  // → 同一个人不能同时出现在两个组（去重范围是整张表而不是单个列）
  bigCleanup: { type: Boolean, default: false },
})
const emit = defineEmits(['cancel', 'confirm', 'save-draft', 'clear-draft', 'open-settings'])

// 条件注册表：每类条件在这里登记语义句、默认参数和执行方法。
const REGISTRY = {
  random: {
    label: '随机选项',
    apply: 'applyPackedRandom',
    defaults: () => ({ unit: 'student', axis: 'column', innerArrange: 'default' }),
    segments: [
      { t: 'text', v: '尽量让' }, { t: 'select', path: 'unit', options: 'groups', width: 'w-28' },
      { t: 'text', v: '在同一天值日', when: 'daily' },
      { t: 'text', v: '在', when: 'big' },
      { t: 'select', path: 'axis', options: 'axes', width: 'w-40', when: 'big' },
      { t: 'text', v: ' 并且 内部', inner: true },
      { t: 'select', path: 'innerArrange', options: 'innerArranges', width: 'w-28', inner: true },
    ],
  },
  group: {
    label: '分组选项',
    apply: 'applyPackedRandom',
    defaults: () => ({ unit: 'student', axis: 'column', innerArrange: 'default' }),
    segments: [
      { t: 'text', v: '尽量让' }, { t: 'select', path: 'unit', options: 'groups', width: 'w-28' },
      { t: 'text', v: '在同一天值日', when: 'daily' },
      { t: 'text', v: '在', when: 'big' },
      { t: 'select', path: 'axis', options: 'axes', width: 'w-40', when: 'big' },
      { t: 'text', v: ' 并且 内部', inner: true },
      { t: 'select', path: 'innerArrange', options: 'innerArranges', width: 'w-28', inner: true },
    ],
  },
  relation: {
    label: '特殊关系',
    apply: 'applyRelation',
    defaults: () => ({ a: '', b: '', relationType: 'same' }),
    segments: [
      { t: 'text', v: '尽量安排' },
      { t: 'select', path: 'a', options: 'students', width: 'w-24', placeholder: '选择学生' },
      { t: 'text', v: '和' },
      { t: 'select', path: 'b', options: 'students', width: 'w-24', placeholder: '选择学生' },
      { t: 'text', v: '同学' },
      { t: 'select', path: 'relationType', options: 'relationTypes', width: 'w-36' },
    ],
  },
  labor: {
    label: '特殊劳动',
    apply: 'applyLabor',
    defaults: () => ({ student: '', action: 'do', item: '' }),
    segments: [
      { t: 'text', v: '尽量满足' },
      { t: 'select', path: 'student', options: 'students', width: 'w-24', placeholder: '选择学生' },
      { t: 'select', path: 'action', options: 'laborActions', width: 'w-24' },
      { t: 'select', path: 'item', options: 'items', width: 'w-32', placeholder: '选择项目' },
    ],
  },
  fair: {
    label: '辛苦度公平选项',
    apply: 'applyFair',
    defaults: () => ({ scope: 'all', unit: 'student', innerOrder: 'no' }),
    segments: [
      { t: 'text', v: '在' }, { t: 'select', path: 'scope', options: 'scopes', width: 'w-24' },
      { t: 'text', v: '中 按照' }, { t: 'select', path: 'unit', options: 'units', width: 'w-24' },
      { t: 'text', v: '为一组 整体调整使得辛苦度更加公平 并且' },
      { t: 'select', path: 'innerOrder', options: 'innerOrder', width: 'w-28' },
      { t: 'text', v: '调整组内顺序 使得辛苦度更加公平' },
    ],
  },
  order: {
    label: '顺序选项',
    apply: 'applyOrdered',
    defaults: () => ({ unit: 'student', direction: 'tb' }),
    segments: [
      { t: 'text', v: '按数据源顺序，以' },
      { t: 'select', path: 'unit', options: 'groups', width: 'w-28' },
      { t: 'text', v: '为一组，' },
      { t: 'select', path: 'direction', options: 'directions', width: 'w-28' },
      { t: 'text', v: '依次排布' },
    ],
  },
}
const CONDITION_ORDER = ['random', 'group', 'relation', 'labor', 'fair', 'order']

// 默认只放一条「同学 / 随机选项」：不依赖座位表，等价于全员整体洗牌
function defaultConditions() {
  return [{ uid: 0, key: 'random', label: '随机选项', unit: 'student', axis: 'column', innerArrange: 'default' }]
}

// 满足率标签跟装箱轴走：整组落在「天 / 区域 / 项目 / 格」，别让用户以为都是同一个指标
function satisfactionLabel(node) {
  if (node.key !== 'random' && node.key !== 'group') return '满足'
  if (node.axis === 'cell') return '整组同格'
  if (node.axis === 'row') return '整组同项'
  return props.bigCleanup ? '整组同区' : '整组同天'
}

const conditions = ref(defaultConditions())
const nextUid = ref(1)
const previewCells = ref({})
const previewVersion = ref(0)
const rejectText = ref('')
const arranged = ref(false)
const satisfaction = ref({})
const dragIdx = ref(null)
const dragOverIdx = ref(null)
const slotWarningVisible = ref(false)
// 人数提示：优先报「有几人排不进表」（数字来自 options.shortageCount 单源）；
// 否则报「槽位比已排人次多 → 部分同学会重复值日」。两种情况方向相反，不能合并成一句。
const slotWarningMessage = computed(() => {
  const n = ctx.shortageCount()
  return n > 0
    ? `值日位置不足，有 ${n} 人排不进值日表，确认继续吗？`
    : '值日槽位比当前值日表里已排的人数多，部分同学会重复值日，确认继续吗？'
})
// 分组维度：用于「宿舍组」这类非座位几何的分组
const dimensions = ref([])
const groups = ref([])
const selectedDimId = ref('')
// 恢复草稿时暂缓条件监听，避免恢复动作把 arranged 重置
const restoring = ref(false)
// 数据源：table = 只用现有排表（值日表）里的人；all = 学生表里的全班同学
const dataSource = ref('table')
const dataSourceOptions = [
  { value: 'table', label: '现有排表表格' },
  { value: 'all', label: '全部同学' },
]
// 有草稿时以草稿为基准继续排；没有则用父组件传入的当前值日表
const draftCells = ref(null)
const baseCells = computed(() => draftCells.value || props.baseCells)

const daysArr = computed(() => (props.days && props.days.length) ? props.days : ['周一', '周二', '周三', '周四', '周五'])
const itemsArr = computed(() => props.items || [])
const studentNames = computed(() => props.students.map(s => String(s.姓名 || '').trim()).filter(Boolean))
// 现有值日表里的人（按出现顺序去重）：数据源选「现有排表表格」时的参与者
const tableNames = computed(() => {
  const out = []
  const seen = new Set()
  const cells = baseCells.value || {}
  for (const item of Object.keys(cells)) {
    const byDay = cells[item] || {}
    for (const day of Object.keys(byDay)) {
      const arr = byDay[day]
      if (!Array.isArray(arr)) continue
      for (const n of arr) {
        const t = String(n || '').trim()
        if (t && !seen.has(t)) { seen.add(t); out.push(t) }
      }
    }
  }
  return out
})
// 参与排表的学生池：随数据源切换（全部同学 = 学生表名册；现有排表表格 = 表里的人）
const poolNames = computed(() => (dataSource.value === 'all' ? studentNames.value : tableNames.value))
// 现有值日表里已排的人次（含重复：同一人排了多天算多次），用于「槽位够不够」的判断
const tableFilled = computed(() => {
  let n = 0
  const cells = baseCells.value || {}
  for (const item of Object.keys(cells)) {
    const byDay = cells[item] || {}
    for (const day of Object.keys(byDay)) {
      const arr = byDay[day]
      if (!Array.isArray(arr)) continue
      for (const x of arr) if (String(x || '').trim()) n++
    }
  }
  return n
})
const dataSourceHint = computed(() => {
  if (dataSource.value === 'all') return '按学生表里的全班同学排'
  if (!tableNames.value.length) return '当前值日表里没有人，改选「全部同学」才能排表'
  return `只排当前值日表里已有的 ${tableNames.value.length} 人`
})
// 条件里的学生下拉：只列当前数据源里能参与排表的人（否则选中的人也调不动）
const studentOptions = computed(() => poolNames.value.map(n => ({ value: n, label: n })))
const itemOptions = computed(() => itemsArr.value.map(it => ({ value: it.name, label: it.name })))
const previewKey = computed(() => {
  const sig = conditions.value.map(c => c.key + ':' + c.uid).join('-') || 'empty'
  return props.visible ? `duty-arrange-${daysArr.value.length}-${itemsArr.value.length}-${sig}-${previewVersion.value}` : 'closed'
})
const previewRows = computed(() => pipeline.buildPreviewRows(previewCells.value))
const conditionButtons = computed(() => CONDITION_ORDER.map(k => ({ key: k, label: REGISTRY[k].label })))

// 跨模块共享上下文：状态为 ref（模块内 .value 访问），方法在下方 Object.assign 回填
const ctx = {
  conditions, nextUid, previewCells, previewVersion, arranged, satisfaction,
  dragIdx, dragOverIdx, rejectText, slotWarningVisible,
  dimensions, groups, selectedDimId,
  daysArr, itemsArr, studentNames, studentOptions, itemOptions,
  dataSource, poolNames, tableNames, tableFilled,
  // 大扫除：整张表是一次活动 → 一个人不能同时出现在两个组
  dedupeWholeTable: computed(() => props.bigCleanup),
  // 大扫除以列/行/格分桶，桶标签不等价，装箱后不做整桶随机映射
  bigCleanup: toRef(props, 'bigCleanup'),
  students: toRef(props, 'students'),
  weights: toRef(props, 'weights'),
  ledger: toRef(props, 'ledger'),
  baseCells,
  seat: toRef(props, 'seat'),
  // 恢复草稿时暂缓 watch
  _restoringDraft: false,
  _rejectTimer: null,
  emit,
}
const pipeline = useDutyArrangementPipeline(ctx, REGISTRY)
const options = useDutyArrangementOptions(ctx, REGISTRY)
const dimension = useDutyArrangementDimension(ctx)
Object.assign(ctx, pipeline, options, dimension)

const sortCond = useRowSortDrag({
  items: conditions,
  dragIdx,
  overIdx: dragOverIdx,
  attr: 'data-cond-idx',
  rowClass: 'cond-row-dragging',
  onMoved: () => ctx.resetArranged(),
})

const {
  segmentsOf, getField, setField, removeCondition,
  onDropOnRow, onDropZone, onOptionDragStart,
  startArrange, proceedStart, openSettingsFromWarning,
  confirm, onSaveDraft, onClearDraft,
} = options
const { satisfactionOf } = pipeline
const { fetchDimensions } = dimension

// 数据源切换：回到「开始排表」，按新数据源重排一次（预览回到当前值日表）
function onDataSourceChange() {
  ctx.resetArranged()
}

// 旧草稿是「方式 → 子约束」的树，这里按文档顺序拍平；无法识别的条件直接忽略
function normalizeDraftConditions(list) {
  const out = []
  for (const n of list || []) {
    if (!n || !REGISTRY[n.key]) continue
    out.push(n)
    for (const c of n.children || []) if (c && REGISTRY[c.key]) out.push(c)
  }
  return out
}
function restoreConditions(list) {
  const flat = normalizeDraftConditions(list)
  if (!flat.length) return defaultConditions()
  return flat.map(c => {
    const reg = REGISTRY[c.key]
    const merged = JSON.parse(JSON.stringify({ ...(reg.defaults ? reg.defaults() : {}), ...c }))
    delete merged.children
    // 旧草稿的「特殊关系」只有「不在同一天值日」，缺字段时按旧语义恢复
    if (c.key === 'relation' && !c.relationType) merged.relationType = 'different'
    merged.uid = nextUid.value++
    merged.label = reg.label
    return merged
  })
}

watch(() => props.visible, async (v) => {
  if (!v) return
  rejectText.value = ''
  satisfaction.value = {}
  arranged.value = false
  // 每次打开都回到默认数据源（现有排表表格）；草稿里不存这一项
  dataSource.value = 'table'
  slotWarningVisible.value = false
  dragIdx.value = null
  dragOverIdx.value = null
  const draft = props.draft || { exists: false }
  if (draft.exists && Array.isArray(draft.conditions) && draft.conditions.length) {
    restoring.value = true
    ctx._restoringDraft = true
    nextUid.value = 1
    conditions.value = restoreConditions(draft.conditions)
    await nextTick()
    restoring.value = false
    ctx._restoringDraft = false
    if (draft.cells && Object.keys(draft.cells).length) {
      draftCells.value = JSON.parse(JSON.stringify(draft.cells))
      previewCells.value = JSON.parse(JSON.stringify(draft.cells))
      arranged.value = true
      previewVersion.value++
    } else {
      draftCells.value = null
      ctx.resetPreview()
    }
  } else {
    draftCells.value = null
    nextUid.value = 1
    conditions.value = defaultConditions()
    ctx.resetPreview()
  }
  fetchDimensions()
}, { immediate: true })

// 任一条件（含下拉选项、顺序）变更：回到「开始排表」
watch(conditions, () => {
  if (restoring.value || ctx._restoringDraft) return
  arranged.value = false
}, { deep: true })

onBeforeUnmount(() => { clearTimeout(ctx._rejectTimer) })
</script>

<style scoped>
/* 智能排表条件行内的下拉框：压低触发框高度，让条件行更紧凑 */
:deep(.av-select__trigger) {
  padding: 4px 8px;
}

/* 条件行的基础过渡：让位靠相邻行的 translate 位移，过渡必须在样式层先声明好 */
[data-cond-idx] {
  transition: transform 180ms cubic-bezier(0.22, 0.61, 0.36, 1);
}

/* 条件行里的关闭键：行是实心蓝底，换成半透明白 */
.cond-close {
  width: 22px;
  height: 22px;
  font-size: 13px;
  background: rgba(255, 255, 255, 0.18);
  color: var(--color-text-inverse);
}
.cond-close:hover {
  background: rgba(255, 255, 255, 0.32);
  color: #fff;
}

/* 拖动中的条件行：原位变淡，留出「待填补的空槽」 */
.cond-row-dragging {
  opacity: 0.35;
}
</style>
