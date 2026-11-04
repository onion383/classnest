<template>
  <!-- 与同族的智能排表一样走 DialogShell：遮罩 / 过渡 / Esc 层次判断统一由外壳管，
       z-index 沿用原来的 z-50，视觉零变化。
       @overlay 走「取消」——点遮罩和按 Esc 与点「取消」按钮同义，不会把预览结果写进小组。 -->
  <DialogShell :visible="visible" :z-index="50" overlay-class="bg-black/30" @overlay="cancel">
    <div class="bg-surface rounded-xl p-5 shadow-card dialog-card flex flex-col overflow-hidden" style="width: 860px; height: 620px; max-width: 90vw;">
      <h3 class="text-lg font-bold mb-4">🧠 智能分组</h3>

      <!-- 新同学确认：小组里有班级学生信息表不存在的名字时提示 -->
      <NewComerConfirm :visible="showNewPrompt" :names="strangers" action="分组" @participate="onParticipate" @not="onNot" />

      <!-- 拒绝/提示 -->
      <Transition name="dialog">
      <div v-if="rejectText" class="mb-3 px-3 py-2 rounded bg-warning/15 border border-warning/40 text-warning text-sm">
        {{ rejectText }}
      </div>
      </Transition>

      <!-- 流水线条件（拖入下方选项添加，拖动手柄调整顺序） -->
      <div class="mb-3">
        <div class="flex items-center justify-between mb-2">
          <label class="text-sm font-medium block">排表条件</label>
          <button @click="startArrange" class="bg-primary text-text-inverse px-3 py-1.5 rounded border-none cursor-pointer text-sm">{{ arranged ? '🔀 换一换' : '▶ 开始排表' }}</button>
        </div>
        <div
          class="border border-dashed border-border rounded-lg p-2 bg-surface-hover min-h-[44px]"
          @dragover.prevent
          @drop="boxDrop"
        >
          <!-- 条件多时限高滚动（约三行：每行 py-1.5 + 行高 ≈ 34px，加上行距 4px）；拖动到上下边缘会自动滚动 -->
          <div class="max-h-[112px] overflow-auto" @scroll="sortStage.onScroll">
          <div v-if="stages.length === 0" class="text-sm text-text-muted py-1">拖入下方选项作为分组条件</div>
          <div v-for="(st, si) in stages" :key="st.key" class="mb-1 last:mb-0" :data-stage-idx="stages.indexOf(st)" :class="{ 'stage-row-dragging': stageDragIdx === stages.indexOf(st) }">
            <div
              class="flex flex-wrap items-center gap-2 px-3 py-1.5 rounded bg-surface border border-border text-text text-sm"
            >
              <!-- 拖动手柄：拖动调整条件顺序（指针拖拽，与表格行/列移动同一套让位动画） -->
              <!-- 序号 + 拖动手柄：序号跟着数组顺序走，拖动松手后自动重排 -->
              <span class="flex items-center gap-2 shrink-0">
                <span class="text-xs tabular-nums text-text-muted select-none opacity-70">{{ stages.indexOf(st) + 1 }}</span>
                <span class="cursor-grab select-none text-text-muted" @mousedown="sortStage.handleDown($event, stages.indexOf(st))" title="拖动调整顺序">⠿</span>
              </span>
              <!-- 特殊关系 -->
              <template v-if="st.type === 'relation'">
                <AppSelect v-model="st.kind" :options="[{ value: 'together', label: '在一组' }, { value: 'apart', label: '不在一组' }]" class="w-28" />
                <AppSelect v-model="st.a" :options="students.map(s => ({ value: s.id, label: s.姓名 }))" placeholder="选择学生" class="w-32" />
                <span class="text-text-muted">和</span>
                <AppSelect v-model="st.b" :options="students.map(s => ({ value: s.id, label: s.姓名 }))" placeholder="选择学生" class="w-32" />
              </template>
              <!-- 指定身份 -->
              <template v-else-if="st.type === 'identity'">
                <AppSelect v-model="st.kind" :options="[{ value: 'leader', label: '担任' + leaderTitle }, { value: 'not-leader', label: '不担任' + leaderTitle }]" class="w-32" />
                <AppSelect v-model="st.studentId" :options="students.map(s => ({ value: s.id, label: s.姓名 }))" placeholder="选择学生" class="w-32" />
              </template>
              <!-- 性别比例 -->
              <template v-else-if="st.type === 'gender'">
                <span class="text-text-secondary">性别比例</span>
                <AppSelect v-model="st.mode" :options="[{ value: 'balanced', label: '男女尽量均匀' }, { value: 'single', label: '全为男生或女生（每组同一性别）' }]" class="w-64" />
              </template>
              <!-- 满足率与关闭按钮靠右成组：关闭键永远贴行尾，不随满足率有无而漂移 -->
              <span class="ml-auto flex items-center gap-2 shrink-0">
                <span v-if="satisfactionOf(st) !== null" class="text-xs px-1.5 py-0.5 rounded bg-info/15 text-info border border-info/30">满足 {{ satisfactionOf(st) }}%</span>
                <button @click="removeStage(stages.indexOf(st))" class="dlg-close close-sm" title="删除该条件">✕</button>
              </span>
            </div>
          </div>
          </div>
          <!-- 新增条件投放框：常驻在列表下方（条件多时列表内部滚动，此行不随之滚走），
               把下方条件选项拖到这里即追加到末尾。样式与智能排表一致 -->
          <div
            class="mt-1 text-xs text-text-muted px-2 py-1 rounded border border-dashed border-info/40 flex items-center select-none"
            @dragover.prevent
            @drop.stop="boxDrop"
          >拖动到这里新增条件</div>
        </div>
      </div>

      <!-- 顺序提示 -->
      <div class="mb-3 text-xs text-text-muted">条件按顺序依次生效，越靠后的条件越重要，可部分覆盖前面的结果。</div>

      <!-- 可选条件（拖入上方作为分组条件，可复用） -->
      <div class="mb-4">
        <label class="text-sm font-medium mb-2 block">分组条件（拖到上方作为条件，拖动手柄调整顺序）</label>
        <div class="flex flex-wrap gap-2">
          <div
            v-for="chip in conditionChips"
            :key="chip.type"
            draggable="true"
            @dragstart="onChipDragStart($event, chip.type)"
            class="px-3 py-1.5 rounded border border-border bg-surface cursor-grab select-none text-sm shadow-sm hover:border-info"
          >＋ {{ chip.label }}</div>
        </div>
      </div>

      <!-- 分组预览 -->
      <!-- min-h-0 是关键：flex 子项默认 min-height:auto，会拒绝收缩，
           总高超出弹窗时就把底部的取消/确定顶出去（弹窗是 overflow-hidden，直接看不见）。
           改成 min-h-0 后这里自己滚动，按钮永远留在原处。 -->
      <div class="flex-1 min-h-0 overflow-auto border border-border rounded mb-4">
        <div class="p-3" v-if="!arranged && previewGroups.length === 0">
          <p class="text-sm text-text-muted">点击上方「开始排表」预览分组结果；确认后写入当前维度的各小组。</p>
        </div>
        <div v-else class="flex flex-wrap gap-3 p-3 content-start" ref="groupGridEl">
          <div
            v-for="(g, gi) in previewGroups"
            :key="gi"
            data-group-card
            class="border border-border rounded bg-surface-hover overflow-hidden flex flex-col"
            style="width: 150px;"
          >
            <div class="px-2 py-1 bg-primary/10 border-b border-border font-semibold text-xs text-text truncate">{{ groupLabel(gi) }}</div>
            <div class="px-2 py-1 text-xs">
              <template v-if="g.length">
                <div class="flex items-center gap-1">
                  <span class="text-info font-medium truncate">{{ g[0].姓名 }}</span>
                  <span class="text-text-muted text-[10px] flex-shrink-0">{{ leaderTitle }}</span>
                </div>
                <div v-for="(s, i) in g.slice(1)" :key="gi + '-' + i" class="text-text truncate">{{ s.姓名 }}</div>
              </template>
              <div v-else class="text-text-muted text-xs">（空组）</div>
            </div>
          </div>
        </div>
      </div>

      <div class="flex justify-end gap-2">
        <button @click="cancel" class="bg-surface-hover px-4 py-2 rounded text-text border border-border">取消</button>
        <button @click="confirm" class="bg-info text-text-inverse px-4 py-2 rounded border-none">确定</button>
      </div>
    </div>
  </DialogShell>
</template>

<script setup vapor>
import { ref, computed, watch, nextTick, onBeforeUnmount, toRef } from 'vue'
import '../../../styles/dialog-transition.css'
import DialogShell from '../../base/DialogShell.vue'
import NewComerConfirm from '../NewComerConfirm.vue'
import AppSelect from '../../base/AppSelect.vue'
import { useSmartGroupPipeline } from './SmartGroupDialog.pipeline.js'
import { useSmartGroupConditions } from './SmartGroupDialog.conditions.js'
import { useSmartGroupPreview } from './SmartGroupDialog.preview.js'
import { useRowSortDrag } from '../../../composables/useRowSortDrag.js'

defineOptions({ name: 'SmartGroupDialog' })
const props = defineProps({
  visible: Boolean,
  students: { type: Array, default: () => [] },
  groups: { type: Array, default: () => [] },
  leaderTitle: { type: String, default: '组长' }
})
const emit = defineEmits(['cancel', 'confirm'])

let keySeq = 0
const nextKey = () => `st-${++keySeq}`

// 流水线：按顺序依次应用，越靠后越重要（可部分覆盖前面）
const stages = ref([{ type: 'gender', mode: 'balanced', key: nextKey() }])
// 条件行拖拽中/落点行下标（用于让位动画与源行淡出）；与 _dragIdx 分开是因为这几个要参与渲染
const stageDragIdx = ref(null)
const stageDragOverIdx = ref(null)
const previewGroups = ref([])
const rejectText = ref('')
const arranged = ref(false)
const satisfaction = ref({})
const lastResult = ref(null)
// 新同学校验：小组中有名字不在班级学生信息表中，参与分组前弹窗确认
const showNewPrompt = ref(false)
const includeNew = ref(false)

// 小组里出现但班级学生信息表里不存在的名字集合
const strangerNames = computed(() => {
  const known = new Set(props.students.map(s => String(s.姓名 || '').trim()).filter(Boolean))
  const out = new Set()
  for (const g of props.groups)
    for (const m of (g.members || [])) {
      const n = String(m.member_name || '').trim()
      if (n && !known.has(n)) out.add(n)
    }
  return out
})
const strangers = computed(() => [...strangerNames.value])
// 参与分组的班级学生（去掉无名）；若用户选择「参与」，附上小组里的新同学一起分组
const roster = computed(() => {
  const base = props.students.filter(s => String(s.姓名 || '').trim())
  if (!includeNew.value) return base
  const named = new Set(base.map(s => String(s.姓名).trim()))
  const extras = [...strangerNames.value].filter(n => !named.has(n)).map(n => ({ 姓名: n }))
  return extras.length ? base.concat(extras) : base
})
// 可选条件（可拖入上方，可复用）
const conditionChips = computed(() => [
  { type: 'relation', label: '特殊关系' },
  { type: 'identity', label: '指定身份' },
  { type: 'gender', label: '性别比例' }
])

// 跨模块共享的上下文：状态为 ref（模块内 .value 访问），临时字段与方法直接挂上；
// 三个 useXxx 的返回方法在下方 Object.assign 回填，模块间经 ctx 互相调用（运行时解析）
const ctx = {
  stages, previewGroups, rejectText, arranged, satisfaction, lastResult,
  stageDragIdx, stageDragOverIdx,
  showNewPrompt, includeNew, strangers, roster,
  students: toRef(props, 'students'),
  groups: toRef(props, 'groups'),
  leaderTitle: toRef(props, 'leaderTitle'),
  // 拖拽交互状态：stage 拖动排序 / chip 拖入添加（非响应式）
  _dragIdx: null,
  _overIdx: null,
  _pendingType: null,
  // 提示条自动消失的定时器
  _rejectTimer: null,
  emit,
}
const { buildAssignment } = useSmartGroupPipeline(ctx)
const conditions = useSmartGroupConditions(ctx, nextKey)
const preview = useSmartGroupPreview(ctx)
Object.assign(ctx, { buildAssignment }, conditions, preview)

// 条件行拖拽排序：指针拖拽 + 相邻行让位 + 松手滑入（与表格行/列移动同一套，见 composables/useRowSortDrag.js）
const sortStage = useRowSortDrag({
  items: stages,
  dragIdx: stageDragIdx,
  overIdx: stageDragOverIdx,
  attr: 'data-stage-idx',
  rowClass: 'stage-row-dragging',
})
// 挂到 ctx，供 conditions.js 里的新增/删除调用进出动画
ctx.sortStage = sortStage

// 供模板调用的顶层绑定
const { satisfactionOf, removeStage, onChipDragStart, boxDrop } = conditions
const { startArrange, onParticipate, onNot, cancel, confirm, buildGroupsPreview } = preview

function groupLabel(gi) {
  const g = props.groups[gi]
  return (g && g.name) || `第${gi + 1}组`
}

// immediate：父组件在同一 tick 里同时把 smartGroupMounted 与 showSmartGroup 置 true，
// 组件挂载时 visible 已经是 true，没有 immediate 的话这里永远不会执行 ——
// 表现就是「没排表时下面一片空白」。
watch(() => props.visible, (v) => {
  if (v) {
    rejectText.value = ''
    // 打开时先显示当前已有的分组结果（尚未排表时作为初始预览）
    previewGroups.value = buildGroupsPreview()
    arranged.value = false
    satisfaction.value = {}
    lastResult.value = null
    showNewPrompt.value = false
    includeNew.value = false
  }
}, { immediate: true })

// 分组数据是异步晚到的：宿组维度的数据先就绪，切到别的维度时 active 还在加载，
// 打开弹窗那一刻 props.groups 是空的 —— 只靠上面的 visible 监听，预览会一直空着。
// 这里补一条：只要分组数据变了、且当前没排过表，就重建预览（已经排过表则保留结果不动）。
watch(() => props.groups, () => {
  if (props.visible && !arranged.value) previewGroups.value = ctx.buildGroupsPreview()
}, { deep: true })
// 分组卡片的动态排布（FLIP）：组内人数不同 → 卡片高度不同，换一次排表后面的卡片就会跳位。
// 亚像素处理（这个坑踩过）：位置差一律 Math.round，写起点后必须 void offsetHeight 强制提交 ——
// 不读一次布局，浏览器会把「设 transform」和「清 transform」合并成一次样式变更，动画根本不播；
// 带小数差还会让起点落在半像素上，动画尾巴有肉眼可见的抖。
const groupGridEl = ref(null)
watch(() => previewGroups.value, async () => {
  const grid = groupGridEl.value
  if (!grid) return
  // pre flush：此刻 DOM 还是旧的，正是要记录的「变化前位置」
  const cards = [...grid.querySelectorAll('[data-group-card]')]
  const prevRects = cards.map((el) => {
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), left: Math.round(r.left) }
  })
  if (!cards.length) return
  await nextTick()
  const nowGrid = groupGridEl.value
  if (!nowGrid) return
  const nowCards = [...nowGrid.querySelectorAll('[data-group-card]')]
  nowCards.forEach((el, i) => {
    const prev = prevRects[i]
    if (!prev) return
    const r = el.getBoundingClientRect()
    const dx = prev.left - Math.round(r.left)
    const dy = prev.top - Math.round(r.top)
    if (!dx && !dy) return
    // 打断上一轮还在跑的过渡，一律从布局位置重新起算，避免两次动画叠加出漂移
    for (const a of el.getAnimations()) {
      if (a.transitionProperty === 'transform') a.cancel()
    }
    el.style.transition = 'none'
    el.style.transform = `translate(${dx}px, ${dy}px)`
    void el.offsetHeight
    el.style.transition = 'transform 220ms cubic-bezier(0.22, 0.6, 0.36, 1)'
    el.style.transform = ''
    el.addEventListener('transitionend', () => {
      el.style.transition = ''
      el.style.transform = ''
    }, { once: true })
  })
})

// 条件变了只把「已排表」状态作废（按钮回到「开始排表」）+ 丢掉可应用的结果缓存，
// 但**不清空预览**：previewGroups 是给人看的，清掉会变成「加一个条件下面的表就没了」。
// 安全性由 lastResult 保证 —— confirm() 里先判 arranged、再判 lastResult，不会误用旧结果。
watch(stages, () => {
  arranged.value = false
  lastResult.value = null
}, { deep: true })

// 提示条自动消失的定时器：弹窗关闭后仍在跑会往已销毁的实例写 rejectText
onBeforeUnmount(() => { clearTimeout(ctx._rejectTimer) })
</script>

<style scoped>
/* 条件行的基础过渡：让位靠相邻行的 translate 位移，过渡必须在样式层先声明好。
   只在 markShift 里临时写 inline transition 时，「同一帧内既设 transition 又设 transform」
   的首次让位可能被浏览器直接拍到终点，看起来就是没有动画。 */
[data-stage-idx] {
  transition: transform 180ms cubic-bezier(0.22, 0.61, 0.36, 1);
}

/* 条件行里的关闭键：沿用全局 .dlg-close（圆角方块 + 浅灰底），只压尺寸——
   行本身只有 py-1.5 + 20px 内容，28px 会把行撑高一圈。 */
.close-sm {
  width: 22px;
  height: 22px;
  font-size: 13px;
}

/* 拖动中的条件行：原位变淡，留出「待填补的空槽」（与表格拖行、智能排表条件行一致） */
.stage-row-dragging {
  opacity: 0.35;
}
</style>
