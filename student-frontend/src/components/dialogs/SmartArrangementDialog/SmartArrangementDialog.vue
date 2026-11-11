<template>
  <DialogShell :visible="visible" :z-index="50" overlay-class="bg-black/30">
    <div class="bg-surface rounded-lg p-5 shadow-card dialog-card flex flex-col overflow-hidden" style="width: 960px; height: 800px; max-width: 90vw; max-height: 90vh;">
      <h3 class="text-lg font-bold mb-4 flex items-center gap-2"><IconGlyph name="brain" :size="18" /> 智能排表</h3>

      <!-- 新同学确认：座位表里有班级学生信息表不存在的名字时提示 -->
      <NewComerConfirm :visible="showNewPrompt" :names="strangers" action="排表" @participate="onParticipate" @not="onNot" />

      <!-- 草稿确认：本次结果来自草稿（恢复或刚保存）时，应用前确认一次，正式应用会清空草稿 -->
      <ConfirmDialog
        :visible="draftConfirmVisible"
        title="确认应用草稿"
        :message="'检测到你使用了草稿，是否确认应用？\n点击「确认」正式应用到座位表后，草稿将会被清空。'"
        confirm-text="确认"
        cancel-text="取消"
        :show-cancel="true"
        @confirm="applyConfirm"
        @cancel="draftConfirmVisible = false"
      />

      <!-- 数据源：本次排表用哪些学生。默认「现有排表表格」= 只重排当前座位表里的人；
           选「全部同学」= 按学生表里的全班同学排（没入座的补进空位） -->
      <div class="mb-3 flex items-center gap-3">
        <label class="text-sm font-medium shrink-0">选择数据源</label>
        <AppSelect v-model="dataSource" :options="dataSourceOptions" class="w-44" @change="onDataSourceChange" />
        <span class="text-xs text-text-muted">{{ dataSourceHint }}</span>
      </div>

      <!-- 排表条件：标题与「开始排表」按钮独立在毛玻璃外；条件行 + 底部拖放位同处一块毛玻璃 -->
      <div class="mb-3">
        <div class="flex items-center justify-between mb-2">
          <label class="text-sm font-medium block">排表条件</label>
          <button @click="startArrange" :disabled="poolEmpty" class="bg-primary text-text-inverse px-3 py-1.5 rounded border-none cursor-pointer text-sm disabled:opacity-40 disabled:cursor-not-allowed">{{ arranged ? '换一换' : '开始排表' }}</button>
        </div>
        <div
          class="border border-dashed border-border rounded-lg p-2 bg-surface/55 backdrop-blur-md"
          @dragover.prevent
          @drop="onDropZone"
        >
          <!-- 条件多时限高滚动（约三行：每行 py-1.5 + 行高 ≈ 34px，加上行距 4px）；拖动到上下边缘会自动滚动 -->
          <div class="max-h-[112px] overflow-auto" @scroll="sortCond.onScroll">
            <div v-if="conditions.length === 0" class="text-sm text-text-muted py-1">把下方的条件选项拖到这里添加</div>
            <div
              v-for="(node, ni) in conditions"
              :key="node.uid"
              :data-cond-idx="conditions.indexOf(node)"
              class="mb-1 last:mb-0"
              :class="{ 'cond-row-dragging': dragIdx === conditions.indexOf(node) }"
              @dragover.prevent
              @drop.stop="onDropOnRow($event, conditions.indexOf(node))"
            >
              <div class="flex flex-wrap items-center gap-2 px-3 py-1.5 rounded bg-primary text-text-inverse text-sm">
                <!-- 序号 + 拖拽手柄：序号跟着数组顺序走，拖动松手后自动重排 -->
                <span class="flex items-center gap-2 shrink-0">
                  <span class="text-xs tabular-nums text-text-inverse/60 select-none">{{ conditions.indexOf(node) + 1 }}</span>
                  <span class="cursor-grab select-none text-text-inverse/70" @mousedown="sortCond.handleDown($event, conditions.indexOf(node))">⠿</span>
                </span>
                <!-- 条件名字：语义句前先亮明是哪个条件 -->
                <span class="font-semibold whitespace-nowrap">{{ node.label }}</span>
                <!-- 语义句：文案段 + 下拉位，由条件注册表驱动 -->
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
                <!-- 满足率与关闭按钮靠右成组：关闭键永远贴行尾，不随满足率有无而漂移 -->
                <span class="ml-auto flex items-center gap-2 shrink-0">
                  <span v-if="satisfactionOf(node) !== null" class="text-xs px-1.5 py-0.5 rounded bg-white/20 text-text-inverse border border-white/30">满足 {{ satisfactionOf(node) }}%</span>
                  <button @click="removeCondition(conditions.indexOf(node))" class="dlg-close cond-close" title="删除该条件">✕</button>
                </span>
              </div>
            </div>
          </div>
          <!-- 新增条件行：常驻在条件列表下方（条件多时列表内部滚动，此行不随之滚走），
               把上方条件选项拖到这里即追加到末尾。样式对齐值日表智能排表的投放虚线框 -->
          <div
            class="mt-1 text-xs text-text-muted px-2 py-1 rounded border border-dashed border-info/40 flex items-center select-none"
            @dragover.prevent
            @drop.stop="onDropZone"
          >拖动到这里新增条件</div>
        </div>
      </div>

      <!-- 优先级提示（满足率已内联显示在每行条件右侧） -->
      <div class="mb-3 text-xs text-text-muted">条件按顺序依次生效，越靠后的条件越重要，可部分覆盖前面的结果。</div>

      <!-- 条件选项：6 个按钮，拖到上方即可添加（可重复添加，不限数量） -->
      <div class="mb-4">
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

      <!-- 表格预览 -->
      <!-- min-h-0：flex 子项默认可拒绝收缩，总高超出时会把底部按钮顶出去；这里自己滚动 -->
      <div class="flex-1 min-h-0 overflow-auto border border-border rounded mb-4">
        <!-- maxHeight=0：预览区外层已是 flex-1 overflow-auto（弹窗自身滚动），
             这里再限高会形成嵌套滚动条 -->
        <GridView
          :key="previewKey"
          :colHeaders="previewColHeaders"
          :rows="previewRows"
          :hideMetaColumns="true"
          :showRowNumber="true"
          :minTableHeight="200"
          :enableCandidate="false"
          :maxHeight="0"
        />
      </div>

      <div class="flex items-center justify-end gap-2">
        <!-- 保存草稿：把当前预览结果 + 条件存到后端，下次启动据此提示「已恢复上一次的草稿表」 -->
        <button
          @click="saveDraft"
          :disabled="!arranged || savingDraft"
          class="bg-surface-hover px-4 py-2 rounded text-text border border-border mr-auto disabled:opacity-40 disabled:cursor-not-allowed"
        >{{ savingDraft ? '保存中…' : '保存草稿' }}</button>
        <span v-if="seatShortage > 0" class="text-sm text-danger">座位不够：还差 {{ seatShortage }} 个（可用 {{ usableCount }} / 待排 {{ poolSize }}），请先在座位表里减少空位或多加行列</span>
        <button @click="cancel" class="bg-surface-hover px-4 py-2 rounded text-text border border-border">取消</button>
        <button @click="confirm" :disabled="seatShortage > 0" class="bg-info text-text-inverse px-4 py-2 rounded border-none disabled:opacity-40 disabled:cursor-not-allowed">确定</button>
      </div>
    </div>
  </DialogShell>
</template>

<script setup vapor>
import { ref, computed, watch, nextTick, toRef } from 'vue';
import GridView from '../../tables/GridView/GridView.vue';
import NewComerConfirm from '../NewComerConfirm.vue';
import ConfirmDialog from '../../base/ConfirmDialog.vue';
import AppSelect from '../../base/AppSelect.vue';
import IconGlyph from '../../base/IconGlyph.vue';
import { useSeatDraft } from '../../../composables/useSeatDraft.js'
import { useSmartArrangementPipeline } from './SmartArrangementDialog.pipeline.js'
import { useSmartArrangementBlocks } from './SmartArrangementDialog.blocks.js'
import { useSmartArrangementOptions } from './SmartArrangementDialog.options.js'
import { seatColumnIndices, gridToDenseCols, normalizeTypes, generateColHeaders, toDenseSeats, alignDraftSeats, deskIndexOfDense, deriveDeskPattern, CELL } from '../../../composables/useSeatGrid.geometry.js'
import { useRowSortDrag } from '../../../composables/useRowSortDrag.js'
import '../../../styles/dialog-transition.css'
import DialogShell from '../../base/DialogShell.vue'

defineOptions({ name: 'SmartArrangementDialog' })
const props = defineProps({
  visible: Boolean,
  rows: { type: Number, default: 6 },
  // 网格总列数（含走廊列）；「座位列数」由 types 反推，不再单独传
  cols: { type: Number, default: 7 },
  mode: { type: String, default: 'single' },
  // 格子类型矩阵（rows×cols，0=座位 1=走廊 2=空位），与 seats 同下标
  types: { type: Array, default: () => [] },
  students: { type: Array, default: () => [] },
  // 当前未改动的座位表（二维网格，元素为学生 id 或 null；走廊/空位格为 null）
  initialSeats: { type: Array, default: () => [] },
  // 位置权重矩阵（rows×cols，网格口径）与「座位指数账本」（学生 id → 截至今日之前累计的座位权重），供「位置公平」使用
  weights: { type: Array, default: () => [] },
  ledger: { type: Object, default: () => ({}) }
})
const emit = defineEmits(['cancel', 'confirm'])

// 条件注册表：每类条件在此登记 —— 执行函数名(apply) + 语义句段(segments) + 初始参数(defaults)。
// 模板里的条件行 UI 与流水线的条件分发都由本表驱动：
//   新增一类条件，只需在此加一条 + 一个 apply 方法，无需再改动模板或 if/else。
// segments 每段：{ t:'text', v } 为纯文案段；{ t:'select', path, options, width, placeholder } 为下拉位。
// options 取值：groups(分组单位) | students(可选学生) | relation(关系类型) | swapTypes(分组方式)
//              | lockModes(同桌内部) | genders(性别) | innerOrder(组内排序)
// 六句语义文案逐字保留（位置公平用「中」，其余用「内」）：
//   特殊选项：在[范围]内 尽量满足[学生A]和[学生B]同学 [作为同桌/不作为同桌/坐在附近/不坐在附近]
//   分组选项：在[范围]内 按照[单位]为一组 [Z字形/上下交换形/随机性分组]
//   随机选项：在[范围]内 按照[单位]为操作单元 随机排布
//   同桌关系：在[范围]内 同桌不变为一组 随机排布 并且 内部 同桌 [交换位置/不交换位置/不变]
//   性别选项：在[范围]内 按照同桌为一组 [相同性别/不同性别] 坐在一起
//   位置公平选项：在[范围]中 按照[单位]为一组 整体调整使得位置更加公平 并且 [可以/不可以] 调整组内排序 使得位置更加公平
const CONDITION_REGISTRY = {
  relation: {
    label: '特殊选项',
    apply: 'applyRelation',
    defaults: () => ({ scope: 'whole', pair: { a: '', b: '' }, relationType: 'deskmate' }),
    segments: [
      { t: 'text', v: '在' }, { t: 'select', path: 'scope', options: 'groups', width: 'w-24' },
      { t: 'text', v: '内 尽量满足' }, { t: 'select', path: 'pair.a', options: 'students', width: 'w-24', placeholder: '选择学生' },
      { t: 'text', v: '和' }, { t: 'select', path: 'pair.b', options: 'students', width: 'w-24', placeholder: '选择学生' },
      { t: 'text', v: '同学' }, { t: 'select', path: 'relationType', options: 'relation', width: 'w-28' }
    ]
  },
  group: {
    label: '分组选项',
    apply: 'applyGroupAction',
    defaults: () => ({ scope: 'whole', unit: 'six', swapType: 'random' }),
    segments: [
      { t: 'text', v: '在' }, { t: 'select', path: 'scope', options: 'groups', width: 'w-24' },
      { t: 'text', v: '内 按照' }, { t: 'select', path: 'unit', options: 'groups', width: 'w-24' },
      { t: 'text', v: '为一组' }, { t: 'select', path: 'swapType', options: 'swapTypes', width: 'w-32' }
    ]
  },
  random: {
    label: '随机选项',
    apply: 'applyRandom',
    defaults: () => ({ scope: 'whole', unit: 'six' }),
    segments: [
      { t: 'text', v: '在' }, { t: 'select', path: 'scope', options: 'groups', width: 'w-24' },
      { t: 'text', v: '内 按照' }, { t: 'select', path: 'unit', options: 'groups', width: 'w-24' },
      { t: 'text', v: '为操作单元 随机排布' }
    ]
  },
  'lock-deskmate': {
    label: '同桌关系',
    apply: 'applyLockDeskmate',
    defaults: () => ({ scope: 'whole', lockMode: 'no-swap' }),
    segments: [
      { t: 'text', v: '在' }, { t: 'select', path: 'scope', options: 'groups', width: 'w-24' },
      { t: 'text', v: '内 同桌不变为一组 随机排布 并且 内部 同桌' },
      { t: 'select', path: 'lockMode', options: 'lockModes', width: 'w-32' }
    ]
  },
  gender: {
    label: '性别选项',
    apply: 'applyGender',
    defaults: () => ({ scope: 'whole', genderMode: 'same' }),
    segments: [
      { t: 'text', v: '在' }, { t: 'select', path: 'scope', options: 'groups', width: 'w-24' },
      { t: 'text', v: '内 按照同桌为一组' },
      { t: 'select', path: 'genderMode', options: 'genders', width: 'w-28' },
      { t: 'text', v: '坐在一起' }
    ]
  },
  fair: {
    label: '位置公平选项',
    apply: 'applyFair',
    defaults: () => ({ scope: 'whole', unit: 'six', innerOrder: 'no' }),
    segments: [
      { t: 'text', v: '在' }, { t: 'select', path: 'scope', options: 'groups', width: 'w-24' },
      { t: 'text', v: '中 按照' }, { t: 'select', path: 'unit', options: 'groups', width: 'w-24' },
      { t: 'text', v: '为一组 整体调整使得位置更加公平 并且' },
      { t: 'select', path: 'innerOrder', options: 'innerOrder', width: 'w-32' },
      { t: 'text', v: '调整组内排序 使得位置更加公平' }
    ]
  }
}

// 底部按钮顺序（与六句语义条件一一对应）
const CONDITION_ORDER = ['relation', 'group', 'random', 'lock-deskmate', 'gender', 'fair']

// 排表条件：一层平铺，一行一条件（可拖拽排序、可重复添加、不限数量）
const conditions = ref([{ uid: 0, key: 'random', label: '随机选项', scope: 'whole', unit: 'six' }])
const nextUid = ref(1)
// 条件行拖拽：拖动中/落点行索引（用于让位动画与「原位空槽」淡出）
const dragIdx = ref(null)
const dragOverIdx = ref(null)
const previewSeats = ref([])
const previewVersion = ref(0)
// 是否已排表：false 显示"开始排表"，true 显示"换一换"
const arranged = ref(false)
// 每个条件的满足率统计：uid -> { done, total }
const satisfaction = ref({})
// 新同学校验：座位表里有名字不在班级学生信息表中，参与排表前弹窗确认
const showNewPrompt = ref(false)
const excludeNew = ref(false)
// 恢复的草稿座位（二维数组，学生 id / 新同学名字 / null）；为空表示没有草稿，
// 预览与后续排表都以它优先于 props.initialSeats 作为基准
const draftSeats = ref(null)
// 保存草稿中：按钮置灰防重复点击
const savingDraft = ref(false)
// 本次结果是否来自草稿（打开时恢复了草稿，或刚点过保存草稿）：为真时「确定」前先弹确认框
const draftInUse = ref(false)
// 草稿确认弹窗：标题「确认应用草稿」，取消则留在弹窗内继续调整
const draftConfirmVisible = ref(false)
// 恢复草稿的过程中暂缓条件变更监听，避免恢复动作本身把 arranged 重置掉
const restoring = ref(false)
// 数据源：table = 只用现有排表（座位表）里的人；all = 学生表里的全班同学
const dataSource = ref('table')
const dataSourceOptions = [
  { value: 'table', label: '现有排表表格' },
  { value: 'all', label: '全部同学' },
]

// ==================== 几何：网格 ↔ 算法（dense）坐标 ====================
// 座位表在库里是**网格**（走廊是真实列），排表算法按 dense 坐标工作（只保留座位列、
// 连续下标）—— 算法里 `%2 == 0 为同桌` 这类判据在任意走廊布局下才能继续成立。
// 转换只发生在本弹窗的进出口：这里压，buildSeatsOut 展开。算法侧零改动。
const gridTypes = computed(() => normalizeTypes(props.types, props.rows, props.cols))
// dense 列 → 网格列
const seatIdx = computed(() => seatColumnIndices(props.cols, gridTypes.value))
// 网格列 → dense 列（走廊列 -1），预览时按网格列取 dense 数据用
const gridToDense = computed(() => gridToDenseCols(props.cols, gridTypes.value))
// dense 版 types：把「行走廊 / 空位」从算法的可选格集合里排除
const denseTypes = computed(() => {
  const idx = seatIdx.value
  const out = []
  for (let r = 0; r < props.rows; r++) out.push(idx.map(c => gridTypes.value[r]?.[c] ?? CELL.SEAT))
  return out
})
function isUsable(r, c) {
  return denseTypes.value[r]?.[c] === CELL.SEAT
}
// 9.1：可用座位数 < 待排人数时禁止确认。
// 放行的后果不是「排得难看」——pipeline 的 rest 放不下的人会被**静默丢掉**，
// 点一次确定就把座位表写残了，而且界面看着是排好的。
const usableCount = computed(() => {
  let n = 0
  for (let r = 0; r < props.rows; r++) {
    for (let c = 0; c < seatIdx.value.length; c++) if (isUsable(r, c)) n++
  }
  return n
})
const poolSize = computed(() => (dataSource.value === 'all' ? props.students.length : tableStudents.value.length))
const seatShortage = computed(() => Math.max(0, poolSize.value - usableCount.value))

// 排表基准座位（网格口径）：有草稿用草稿，否则用父组件传入的当前座位表
const baseGridSeats = computed(() => draftSeats.value || props.initialSeats)
// 算法坐标空间：压掉走廊列
const baseSeats = computed(() => toDenseSeats(baseGridSeats.value, props.cols, gridTypes.value))
// 座位表里有名字但班级学生信息表里不存在的名字集合
// 座位表数据：班级学生存 id(数字)，未被识别的自由文本名字(新同学)以字符串形式存储
const strangerNames = computed(() => {
  const known = new Set(props.students.map(s => String(s.姓名 || '').trim()).filter(Boolean))
  const out = new Set()
  for (const row of baseSeats.value || [])
    for (const val of row || []) {
      let n = ''
      if (typeof val === 'string') n = val.trim()
      else if (val && typeof val === 'object') n = String(val.姓名 || '').trim()
      if (n && !known.has(n)) out.add(n)
    }
  return out
})
const strangers = computed(() => [...strangerNames.value])
// 现有座位表里的人（去重）：数据源选「现有排表表格」时的参与者（含不在名册里的新同学）
const tableStudents = computed(() => {
  const out = []
  const seen = new Set()
  for (const row of baseSeats.value || []) {
    for (const val of row || []) {
      let n = ''
      if (typeof val === 'number') {
        const s = props.students.find(x => x.id === val)
        n = s ? String(s.姓名 || '').trim() : ''
      } else if (typeof val === 'string') n = val.trim()
      else if (val && typeof val === 'object') n = String(val.姓名 || '').trim()
      if (n && !seen.has(n)) { seen.add(n); out.push(n) }
    }
  }
  return out
})
const dataSourceHint = computed(() => {
  if (dataSource.value === 'all') return '按学生表里的全班同学排，没入座的补进空位'
  if (!tableStudents.value.length) return '当前座位表里没有人，改选「全部同学」才能排表'
  return `只排现有座位表里已有的 ${tableStudents.value.length} 人，空位保持空着`
})
// 「现有排表表格」但表里没人 → 没有可排的人，「开始排表」置灰
const poolEmpty = computed(() => dataSource.value === 'table' && !tableStudents.value.length)
// 数据源能力位：只有「全部同学」才允许名册外的新同学参与排表。
// 新人提示、excludeNew 过滤、切源复位全部读这一位 —— 不逐个调用点再判一次 dataSource，
// 否则 table 模式仍会弹新人确认、并把表内已有成员按 excludeNew 排除掉（A5-01）。
const allowNew = computed(() => dataSource.value !== 'table')
const previewKey = computed(() => {
  const sig = conditions.value.map(c => c.key + ':' + c.uid).join('-') || 'empty'
  return props.visible ? `arrange-${props.rows}-${props.cols}-${sig}-${previewVersion.value}` : 'closed'
})
// 混排桌型：把网格桌号投影到算法（dense）坐标。走廊列被压掉后，
// 「隔着一条走廊的两列」在 dense 里看起来就是相邻下标，必须靠桌号才能区分它们不是同桌。
const denseDeskIndex = computed(() => deskIndexOfDense(props.cols, gridTypes.value, props.mode))
const deskPattern = computed(() => deriveDeskPattern(props.cols, gridTypes.value, props.mode))
// 只有「1 人桌与 2 人桌同时存在」才是真混排：混合桌初始全双桌、纯 single/double
// 都不置灰四/六位（方案 11.4 要求纯模式行为完全不变）。
const nonUniformDesk = computed(() =>
  props.mode === 'mixed' && deskPattern.value.includes(1) && deskPattern.value.includes(2))
const previewColHeaders = computed(() => generateColHeaders(props.cols, gridTypes.value))
const previewRows = computed(() => ctx.buildPreviewRows(previewSeats.value))
// 底部条件按钮（六类条件，拖到上方即添加，可重复添加）
const conditionButtons = computed(() =>
  CONDITION_ORDER.map(k => ({ key: k, label: CONDITION_REGISTRY[k].label })))

// 跨模块共享的上下文：状态为 ref（模块内 .value 访问），临时字段与方法直接挂上；
// 三个 useXxx 的返回方法在下方 Object.assign 回填，模块间经 ctx 互相调用（运行时解析）
// 坐标口径：ctx.rows / ctx.cols / ctx.baseSeats / ctx.weights 一律是**算法侧 dense**；
// 网格口径另给 ctx.gridCols / ctx.gridTypes / ctx.gridToDense（预览与落库用）。
const ctx = {
  conditions, nextUid, previewSeats, previewVersion, arranged, satisfaction,
  dragIdx, dragOverIdx,
  showNewPrompt, excludeNew, draftSeats, savingDraft, draftInUse, draftConfirmVisible, restoring,
  dataSource, allowNew,
  baseSeats, strangerNames, strangers, tableStudents,
  rows: toRef(props, 'rows'),
  cols: computed(() => seatIdx.value.length),
  mode: toRef(props, 'mode'),
  students: toRef(props, 'students'),
  weights: computed(() => toDenseSeats(props.weights, props.cols, gridTypes.value)),
  ledger: toRef(props, 'ledger'),
  gridCols: toRef(props, 'cols'),
  gridTypes,
  gridToDense,
  denseTypes,
  deskIndex: denseDeskIndex,
  nonUniformDesk,
  isUsable,
  usableCount,
  seatShortage,
  emit,
}
const pipeline = useSmartArrangementPipeline(ctx, CONDITION_REGISTRY)
const blocks = useSmartArrangementBlocks(ctx)
const options = useSmartArrangementOptions(ctx, CONDITION_REGISTRY)
Object.assign(ctx, pipeline, blocks, options)

// 数据源切换：回到「开始排表」，按新数据源重排一次（预览回到未改动的座位表）。
// 同时清掉上一轮的新同学选择：table 模式下这个选择本来就不该生效，
// 留到切回 all 时会让用户莫名其妙地「上次选过不参与」还继续生效。
function onDataSourceChange() {
  ctx.excludeNew.value = false
  ctx.showNewPrompt.value = false
  ctx.resetArranged()
}

// 条件行拖拽排序：指针拖拽 + 相邻行让位 + 松手滑入（与表格行/列移动同一套，见 composables/useRowSortDrag.js）
const sortCond = useRowSortDrag({
  items: conditions,
  dragIdx,
  overIdx: dragOverIdx,
  attr: 'data-cond-idx',
  rowClass: 'cond-row-dragging',
  // 条件顺序变了就要重置为「开始排表」（等价于原先 moveCondition 里的 resetArranged）
  onMoved: () => ctx.resetArranged(),
})
// 挂到 ctx，供 options.js 里的新增/删除调用进出动画
ctx.sortCond = sortCond

// 供模板调用的顶层绑定
const {
  segmentsOf, getField, setField, satisfactionOf, removeCondition,
  onDropOnRow, onDropZone, onOptionDragStart,
  startArrange, onParticipate, onNot, saveDraft, cancel, confirm, applyConfirm,
} = { ...pipeline, ...blocks, ...options }

// immediate：父组件（SeatView）是先置 visible=true、再在 watch 里置 mounted=true，
// 组件挂载时 visible 已经是 true，没有 immediate 的话首次打开不会初始化预览（表格一片空）。
watch(() => props.visible, async (v) => {
  if (!v) return
  showNewPrompt.value = false
  excludeNew.value = false
  arranged.value = false
  draftConfirmVisible.value = false
  // 每次打开都回到默认数据源（现有排表表格）；草稿里不存这一项
  dataSource.value = 'table'
  // 有草稿则恢复上次草稿（座位结果 + 排表条件）；没有则显示未改动的当前座位表，不自动排表
  const { draft, fetchDraft } = useSeatDraft()
  if (!draft.loaded) await fetchDraft()
  if (draft.exists) {
    // restoring 期间暂缓 conditions 监听，避免恢复条件本身把 arranged 重置为未排表
    restoring.value = true
    // 草稿的几何可能与当前座位表设置已经不同（排完草稿后又改过行列/桌子模式）：
    // 必须先按座位列序号搬过来，否则走廊与座位会整体错位
    draftSeats.value = alignDraftSeats(draft, props.rows, props.cols, gridTypes.value)
    draftInUse.value = true
    ctx.restoreConditions(draft.conditions)
    await nextTick()
    restoring.value = false
    arranged.value = true
  } else {
    draftSeats.value = null
    draftInUse.value = false
  }
  previewSeats.value = ctx.buildInitialSeats()
  previewVersion.value++
}, { immediate: true })
// 任一条件（含下拉选项、顺序）变更：重置为"开始排表"
watch(conditions, () => {
  if (restoring.value) return
  arranged.value = false
}, { deep: true })
</script>

<style scoped>
/* 智能排表条件行内的下拉框：压低触发框高度，让条件行更紧凑 */
:deep(.av-select__trigger) {
  padding: 4px 8px;
}

/* 条件行的基础过渡：让位靠相邻行的 translate 位移，过渡必须在样式层先声明好。
   只在 markShift 里临时写 inline transition 时，「同一帧内既设 transition 又设 transform」
   的首次让位可能被浏览器直接拍到终点，看起来就是没有动画。 */
[data-cond-idx] {
  transition: transform 180ms cubic-bezier(0.22, 0.61, 0.36, 1);
}

/* 条件行里的关闭键：沿用全局 .dlg-close 的形制（圆角方块 + 可读对比度），
   但行是实心蓝底，默认的「浅灰底 + 深色字」压上去会发闷，这里换成半透明白。
   尺寸压到 22px：行本身只有 py-1.5 + 20px 内容，28px 会把行撑高一圈。 */
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

/* 拖动中的条件行：原位变淡，留出「待填补的空槽」。
   与表格拖行/拖列一致——真正让开位置的是相邻行的 translate 位移（见 tableDragFx），
   这里只负责让源行看起来被「拿起来了」，两者叠加才是表格那套观感。
   注意：拖拽走的是 mousedown 指针拖拽（不是原生 HTML5 拖拽）——原生 drag 会话期间
   Chromium 不推进 CSS transition，让位只能瞬间跳过去，这点已实测。 */
.cond-row-dragging {
  opacity: 0.35;
}
</style>
