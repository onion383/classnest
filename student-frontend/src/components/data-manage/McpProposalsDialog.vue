<template>
  <!-- MCP 提案弹窗：外部 AI 的写入请求都先落成提案，由人在这里确认或拒绝。
       两个栏目：未处理（要老师决策）/ 已处理（只读历史，按条数保留）。
       自包含：打开时拉一次，可手动刷新；关闭后设置页不再为它维持轮询。 -->
  <DialogShell :visible="visible" :z-index="10070" overlay-class="bg-black/50" @overlay="close">
    <div class="dialog-card bg-surface rounded-lg border border-border shadow-lg p-5 flex flex-col mcp-dialog">
      <div class="flex items-center justify-between gap-3 mb-3 flex-shrink-0">
        <div class="flex items-center gap-1.5">
          <h3 class="text-lg font-bold text-text">MCP 提案</h3>
          <AppHelp aria-label="提案说明" :z-index="10075" :text="proposalHelp" />
        </div>
        <div class="flex items-center gap-3 flex-shrink-0">
          <button type="button" @click="refreshAll()" :disabled="busy || loading"
            class="btn-plain px-2.5 py-1 text-sm text-info disabled:opacity-40">刷新</button>
          <button class="dlg-close" title="关闭" @click="close">✕</button>
        </div>
      </div>

      <!-- 两栏：未处理带条数（有就去点），已处理只读 -->
      <div class="flex items-center gap-1 mb-3 flex-shrink-0">
        <button v-for="t in tabs" :key="t.value" type="button" @click="switchTab(t.value)"
          class="px-2.5 py-1 rounded text-sm transition-theme"
          :class="tab === t.value ? 'bg-bg-secondary text-text font-medium' : 'text-text-muted hover:text-text'">
          {{ t.label }}<span v-if="t.value === 'pending' && pending.length" class="text-warning"> {{ pending.length }}</span>
        </button>
      </div>

      <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto app-custom-scroll pr-1" @scroll="onScroll">
        <!-- 未处理：可确认 / 拒绝 -->
        <div v-if="tab === 'pending'" class="space-y-2">
          <div v-for="p in pending" :key="p.proposal_id" class="bg-bg-secondary border rounded p-3"
            :class="isDanger(p) ? 'border-danger/50' : 'border-transparent'">
            <!-- 标题说「要改什么」，不用 AI 自填的 label：label 是调用方给的，
                 完全可以写「修正错别字」而实际删一行。操作名和表名是后端按数据翻出来的，骗不了人。 -->
            <div class="flex items-center justify-between gap-3">
              <p class="text-sm font-medium text-text min-w-0 truncate">{{ summaryOf(p) }}</p>
              <div class="flex items-center gap-1 flex-none">
                <span v-if="p.op_count > 1 && isDanger(p)"
                  class="text-[11px] px-1.5 py-0.5 rounded bg-danger/10 text-danger">含删除</span>
                <span v-if="hasMissing(p)"
                  class="text-[11px] px-1.5 py-0.5 rounded bg-danger/10 text-danger">行已不存在</span>
              </div>
            </div>

            <!-- 改动本体：要丢掉的值压暗（删除还加删除线），要写进去的值正常色，
                 一眼能看出「从什么变成什么」。英文表名一律不出现：后端已翻成中文。 -->
            <div class="mt-2 mb-2.5 space-y-0.5">
              <div v-for="(op, i) in p.ops" :key="i">
                <p v-if="p.op_count > 1" class="text-xs text-text-muted mb-0.5">{{ op.op_label }} · {{ op.table_label }}</p>
                <p v-for="f in op.fields" :key="f.col" class="text-sm text-text pl-3 leading-relaxed truncate"
                  :title="fieldText(op, f)">
                  <span class="text-text-muted">{{ f.col }}：</span>
                  <template v-if="op.operation === 'add'">
                    <span class="font-medium">{{ disp(f.after) }}</span>
                  </template>
                  <template v-else-if="op.operation === 'delete'">
                    <span class="text-text-muted line-through">{{ disp(f.before) }}</span>
                  </template>
                  <template v-else>
                    <span class="text-text-muted">{{ disp(f.before) }}</span>
                    <span class="text-text-muted"> → </span>
                    <span class="font-medium">{{ disp(f.after) }}</span>
                  </template>
                </p>
                <p v-if="op.fields.length === 0 && !op.missing" class="text-xs text-text-muted pl-3">没有可显示的字段</p>
              </div>
              <p v-if="p.more_ops" class="text-xs text-text-muted">还有 {{ p.more_ops }} 条操作未展开，确认前请先点「刷新」查看完整提案。</p>
            </div>

            <div class="flex gap-2">
              <button type="button" @click="decide(p.proposal_id, 'confirm')" :disabled="busy"
                class="px-3 py-1 rounded text-sm transition-theme disabled:opacity-50"
                :class="isDanger(p)
                  ? 'bg-danger hover:bg-danger-hover text-text-inverse'
                  : 'bg-primary hover:bg-primary-hover text-text-inverse'">{{ isDanger(p) ? '确认删除' : '确认执行' }}</button>
              <button type="button" @click="decide(p.proposal_id, 'reject')" :disabled="busy"
                class="bg-bg-secondary hover:bg-danger/20 text-text px-3 py-1 rounded text-sm transition-theme disabled:opacity-50">拒绝</button>
            </div>
            <!-- 条数/时间/AI 自填的说明放在最后一行小字：它是元信息，不该比改动本身更显眼。 -->
            <p class="text-[11px] text-text-muted mt-2 truncate">
              <span v-if="p.op_count > 1">{{ p.op_count }} 条 · </span>{{ fmtTime(p.created_at) }}<span v-if="p.label"> · {{ p.label }}</span>
            </p>
          </div>
          <p v-if="!pending.length && loading" class="text-sm text-text-muted py-8 text-center">正在读取提案…</p>
          <p v-else-if="!pending.length" class="text-sm text-text-muted py-8 text-center">
            {{ prefs.auto_confirm ? '自动执行已开启，新提案会直接执行，记录见「已处理」。' : '暂无待确认提案。' }}
          </p>
        </div>

        <!-- 已处理：只读。不重算 diff（执行后行已是新值），只说动了哪张表、哪一行、结果如何。
             行虚拟滚动（同 DynamicTable 的垫片结构）：已处理可以堆到几百条，全量挂 DOM 没必要。
             「未处理」不走这套——那种卡片必须完整显示 diff，高度随内容变，正是行高不定的情形。 -->
        <div v-else>
          <div v-if="doneView.padTop" :style="{ height: doneView.padTop + 'px' }"></div>
          <div v-for="p in doneRows" :key="p.proposal_id"
            class="prop-card bg-bg-secondary border border-transparent rounded p-2.5 mb-2 flex flex-col overflow-hidden">
            <div class="flex items-center justify-between gap-3 flex-none h-[18px]">
              <p class="text-sm font-medium text-text min-w-0 truncate leading-[18px]">{{ summaryOf(p) }}</p>
              <span class="text-[11px] px-1.5 py-0.5 rounded flex-none" :class="statusClass(p.status)">{{ statusLabel(p.status) }}</span>
            </div>
            <!-- ops 区定高 3 行：卡片高度固定是行虚拟滚动的先决条件，多出来的由 overflow 裁掉 -->
            <div class="mt-1 h-12 overflow-hidden flex-none">
              <p v-for="(op, i) in p.ops" :key="i" class="text-xs text-text-muted truncate leading-4">
                {{ op.op_label }} · {{ op.table_label }}<span v-if="op.id"> #{{ op.id }}</span>
              </p>
              <p v-if="p.more_ops" class="text-xs text-text-muted truncate leading-4">还有 {{ p.more_ops }} 条操作</p>
            </div>
            <p class="mt-auto text-[11px] truncate leading-4"
              :class="p.status === 'failed' ? 'text-danger' : 'text-text-muted'">
              {{ fmtTime(p.decided_at || p.created_at) }}<span v-if="resultText(p)"> · {{ resultText(p) }}</span><span v-if="p.label"> · {{ p.label }}</span>
            </p>
          </div>
          <div v-if="doneView.padBottom" :style="{ height: doneView.padBottom + 'px' }"></div>
          <p v-if="!done.length && loading" class="text-sm text-text-muted py-8 text-center">正在读取记录…</p>
          <p v-else-if="!done.length" class="text-sm text-text-muted py-8 text-center">暂无已处理记录。</p>
        </div>
      </div>

      <!-- 保留条数只作用于「已处理」：未处理的是确认队列，任何情况下都不会被裁掉 -->
      <div class="border-t border-border mt-3 pt-3 flex items-center gap-2 text-xs text-text-muted flex-shrink-0">
        <span>已处理保留</span>
        <AppSelect :model-value="prefs.proposal_keep" aria-label="已处理提案保留条数" :options="keepOptions" compact class="w-24"
          @change="onKeep" />
        <span class="ml-auto">{{ done.length }} 条</span>
      </div>
    </div>
  </DialogShell>
</template>

<script setup vapor>
import { computed, nextTick, ref, watch } from 'vue'
import axios from 'axios'
import { useNotification } from '../../composables/useNotification.js'
import { formatDateTime } from '../../utils/dateTime.js'
import { useDisposables } from '../../utils/disposables.js'
import { visibleFixedRows } from '../../utils/virtualRows.js'
import DialogShell from '../base/DialogShell.vue'
import AppHelp from '../base/AppHelp.vue'
import AppSelect from '../base/AppSelect.vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'changed'])

const notify = useNotification()
const tabs = [
  { value: 'pending', label: '未处理' },
  { value: 'done', label: '已处理' },
]
const tab = ref('pending')
const pending = ref([])
const done = ref([])
// 后端默认 200；先给同一个值，避免下拉在首帧显示成空白
const prefs = ref({ proposal_keep: 200 })
const busy = ref(false)
const loading = ref(false)

// 已处理列表的行虚拟滚动。行高是常量（卡片 overflow 裁内容），所以不需要测量每一行。
const DONE_ROW_H = 110
const DONE_GAP = 8
const scrollEl = ref(null)
const scrollTop = ref(0)
// 视口高在「可见」之后测一次，之后随窗口缩放更新；默认值只兜首帧
const viewH = ref(420)
const d = useDisposables()

const proposalHelp = [
  '外部 AI 的写入请求不会直接落库，而是先变成一条提案。',
  '默认要点「确认执行」才真正写入；点「拒绝」丢弃。写入结果会按「退回/撤销」那套登记，事后仍可回退。',
  '在设置里开启「自动执行提案」后，新提案不再进这一栏，直接执行并记入「已处理」。',
  '超过 24 小时未处理的会标记为过期，需让 AI 重新提交。',
  '已处理只保留最近若干条（可在下方调整）；未处理的不会因这个数字消失。',
].join('\n')

// 保留档位与后端范围（50~2000）对齐；当前值不在档位里时补一项，别让下拉显示成空
const KEEP_BASE = [50, 100, 200, 500, 1000, 2000]
const keepOptions = computed(() => {
  const cur = prefs.value.proposal_keep
  const nums = KEEP_BASE.includes(cur) ? KEEP_BASE : [...KEEP_BASE, cur].sort((a, b) => a - b)
  return nums.map((v) => ({ value: v, label: `${v} 条` }))
})

// 窗口由步长直接算出（固定行高 → 前缀和退化成 index * step），上下垫片撑住滚动条
const doneView = computed(() => visibleFixedRows({
  scrollTop: scrollTop.value,
  viewH: viewH.value,
  rowH: DONE_ROW_H,
  gap: DONE_GAP,
  count: done.value.length,
}))
const doneRows = computed(() => done.value.slice(doneView.value.start, doneView.value.end))

const STATUS_TEXT = { confirmed: '已执行', rejected: '已拒绝', failed: '失败', expired: '已过期' }
const STATUS_CLASS = {
  confirmed: 'bg-success/10 text-success',
  rejected: 'bg-surface-hover text-text-secondary',
  failed: 'bg-danger/10 text-danger',
  expired: 'bg-warning/10 text-warning',
}

// 每次打开都拉一次全量；关闭期间不再轮询（设置页摘要行负责显示条数）
watch(() => props.visible, (v) => {
  if (!v) return
  // 打开时回到顶部：上次滚到一半再进来，窗口会按旧 scrollTop 算，露一屏空白
  scrollTop.value = 0
  refreshAll({ notifyResult: false })
  nextTick(measureView)
}, { immediate: true })

function measureView() {
  const el = scrollEl.value
  if (el && el.clientHeight) viewH.value = el.clientHeight
}
// 只在一列里滚，不需要按 tab 区分：未处理栏没有垫片，写了也不影响渲染
function onScroll(e) {
  if (!e.target || tab.value !== 'done') return
  scrollTop.value = e.target.scrollTop
}
d.listen(window, 'resize', () => measureView(), { passive: true })

function close() { emit('close') }
function switchTab(v) {
  tab.value = v
  // 两栏共用一个滚动容器：切过去必须先归零，否则已处理按未处理的滚动位置算窗口
  scrollTop.value = 0
  if (scrollEl.value) scrollEl.value.scrollTop = 0
  // 切到已处理时补拉一次：确认动作之后列表已经变了，缓存的不作数
  if (v === 'done') loadDone().catch(() => {})
  nextTick(measureView)
}

// 提案卡片的显示口径：后端已把值归一（空→null、对象→JSON 文本、过长截断），
// 这里只负责「空值怎么说」和「怎么排成一行」，不重复做业务判断。
function disp(v) {
  return v === null || v === undefined || v === '' ? '（空）' : String(v)
}
// 一条字段改动：新增只给新值、删除只给旧值、修改给「改前 → 改后」
function fieldText(op, f) {
  if (op.operation === 'add') return `${f.col}：${disp(f.after)}`
  if (op.operation === 'delete') return `${f.col}：${disp(f.before)}`
  return `${f.col}：${disp(f.before)} → ${disp(f.after)}`
}
// 卡片标题：单条给「操作 · 中文表名」，批量给「批量 · N 处改动」。
// 两个值都是后端按数据翻出来的，不是调用方填的 —— 所以它比 label 可信，该放在最上面。
function summaryOf(p) {
  if (p.op_count > 1) return `批量 · ${p.op_count} 处改动`
  const op = (p.ops || [])[0]
  return op ? `${op.op_label} · ${op.table_label}` : '数据修改提案'
}
// 含删除的整卡标红：这是唯一「点下去就丢数据」的形态（虽然还能撤销回来）
function isDanger(p) {
  return (p.ops || []).some((op) => op.operation === 'delete')
}
// 行已被别处删掉：改动列表是空的，必须说明原因，否则看起来像卡片坏了
function hasMissing(p) {
  return (p.ops || []).some((op) => op.missing)
}
function statusLabel(s) { return STATUS_TEXT[s] || s || '未知' }
function statusClass(s) { return STATUS_CLASS[s] || 'bg-surface-hover text-text-secondary' }
// 只给「需要解释」的状态补一句；已执行/已拒绝的徽标本身已经说明结果
function resultText(p) {
  const r = p.result || {}
  if (p.status === 'failed') return r.error || '执行失败，数据已回滚'
  if (p.status === 'expired') return '超过 24 小时未处理'
  return ''
}
function fmtTime(iso) {
  const dt = new Date(iso)
  return isNaN(dt.getTime()) ? String(iso || '') : formatDateTime(dt)
}

// 三个 load 都不再自己吞错：刷新按钮要把失败原因说出来（以前点刷新失败也毫无反馈，
// 列表保持旧内容，看起来像「刷新了但没变化」）。调用方各自决定是提示还是静默。
async function loadPending() {
  const r = await axios.get('/api/mcp/proposals', { params: { status: 'pending' } })
  pending.value = r.data.proposals || []
}
async function loadDone() {
  const r = await axios.get('/api/mcp/proposals', {
    params: { status: 'done', limit: prefs.value.proposal_keep },
  })
  done.value = r.data.proposals || []
}
async function loadPrefs() {
  const r = await axios.get('/api/mcp/prefs')
  prefs.value = {
    proposal_keep: r.data.proposal_keep,
    auto_confirm: r.data.auto_confirm === true,
  }
}

// notifyResult=false 用于「打开弹窗时自动拉」：那时不该弹「已刷新」，
// 只有用户主动点按钮才给反馈。
async function refreshAll({ notifyResult = true } = {}) {
  loading.value = true
  try {
    const rs = await Promise.allSettled([loadPrefs(), loadPending(), loadDone()])
    if (!notifyResult) return
    const bad = rs.find((x) => x.status === 'rejected')
    if (bad) {
      const e = bad.reason || {}
      notify.error('刷新失败：' + (e.response?.data?.error || e.message || '未知原因'))
    } else {
      notify.success('已刷新')
    }
  } finally { loading.value = false }
}

async function onKeep(v) {
  const prev = prefs.value.proposal_keep
  prefs.value = { ...prefs.value, proposal_keep: Number(v) }
  try {
    const r = await axios.put('/api/mcp/prefs', { proposal_keep: Number(v) })
    prefs.value = { ...prefs.value, proposal_keep: r.data.proposal_keep }
    if (r.data.removed) notify.success(`已清理 ${r.data.removed} 条旧记录`)
    await loadDone()
    emit('changed')
  } catch (e) {
    prefs.value = { ...prefs.value, proposal_keep: prev }
    notify.error('保存保留条数失败：' + (e.response?.data?.error || e.message))
  }
}

async function decide(id, decision) {
  busy.value = true
  try {
    const r = await axios.post(`/api/mcp/proposals/${encodeURIComponent(id)}/decide`, { decision })
    if (r.data.status === 'failed') notify.error('执行失败：' + (r.data.result?.error || '未知原因'))
    else notify.success(decision === 'confirm' ? '已执行提案' : '已拒绝提案')
    // 提案已经处理完了，列表刷新失败不该把这次操作报成「处理失败」
    await Promise.all([loadPending(), loadDone()]).catch(() => {})
    emit('changed')
  } catch (e) { notify.error('处理提案失败：' + (e.response?.data?.error || e.message)) }
  finally { busy.value = false }
}
</script>

<style scoped>
.mcp-dialog { width: min(40rem, 92vw); max-height: min(80vh, 680px); }
/* 已处理卡片定高：行虚拟滚动靠 index * step 算位置，高度浮动就会错行。
   内容超出由 overflow-hidden 裁掉（ops 区本身已是 3 行定高）。
   110 = 上下 padding 20 + 边框 2 + 标题 18 + 间距 4 + ops 48 + 底部 16 + 余量 2 */
.prop-card { height: 110px; }
</style>
