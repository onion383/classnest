<template>
  <!-- 数据访问记录弹窗：读 + 写合成一条时间线，两个入口共用，source 固定各自一侧
       （AI 只看 ai、MCP 只看 mcp）。全部来源的总览在「设置 → 更改审查」。
       这里的「写」不复制数据：已执行的写来自 undo_history，未执行的来自 MCP 提案，
       所以同一件事只会出现一次（确认提案后，pending 行换成已执行行）。 -->
  <DialogShell :visible="visible" :z-index="zIndex" overlay-class="bg-black/50" @overlay="close">
    <div class="dialog-card bg-surface rounded-lg border border-border shadow-lg p-5 flex flex-col access-dialog">
      <div class="flex items-center justify-between gap-3 mb-2 flex-shrink-0">
        <div class="flex items-center gap-1.5 min-w-0">
          <IconGlyph :name="source === 'mcp' ? 'brain' : 'ai'" :size="18" />
          <h3 class="text-lg font-bold text-text truncate">{{ title }}</h3>
          <AppHelp :aria-label="title + '说明'" :z-index="zIndex + 5" :text="helpText" />
        </div>
        <div class="flex items-center gap-3 flex-shrink-0">
          <button type="button" @click="reload" :disabled="loading"
            class="btn-plain px-2.5 py-1 text-sm text-info disabled:opacity-40">刷新</button>
          <button class="dlg-close" title="关闭" @click="close">✕</button>
        </div>
      </div>

      <!-- 摘要 + 筛选：读了多少、写了多少、被拒多少；没有记录时整句不出现 -->
      <div class="flex items-center gap-3 flex-wrap text-xs text-text-muted mb-2 flex-shrink-0">
        <span v-if="summaryText">{{ summaryText }}</span>
        <label class="flex items-center gap-1.5 ml-auto cursor-pointer select-none">
          <input type="checkbox" :checked="onlyAbnormal" @change="toggleAbnormal($event.target.checked)" />
          仅看被拒与失败
        </label>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto app-custom-scroll pr-1">
        <p v-if="error" class="text-sm text-danger py-6 text-center">{{ error }}</p>
        <p v-else-if="loading && !logs.length" class="text-sm text-text-muted py-8 text-center">正在读取记录…</p>
        <p v-else-if="!logs.length" class="text-sm text-text-muted py-8 text-center leading-relaxed">
          {{ onlyAbnormal ? '没有「被拒」或「失败」的记录 —— 说明没有请求被挡下来。' : emptyText }}
        </p>
        <ul v-else class="access-tl">
          <li v-for="row in logs" :key="row.id" class="access-tl-row">
            <span class="access-tl-gutter"><i class="access-tl-dot" :class="dotClass(row)"></i></span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-xs text-text-muted tabular-nums flex-none">{{ fmtTime(row.at) }}</span>
                <span class="access-act" :class="{ 'is-write': row.kind === 'write', 'is-pending': row.kind === 'proposal' }">{{ toolLabel(row.tool) }}</span>
                <span class="text-sm text-text truncate">{{ titleText(row) }}</span>
                <span class="text-xs text-text-muted flex-none">{{ metaText(row) }}</span>
                <span v-if="row.result !== 'ok'" class="access-badge" :class="row.result">{{ resultLabel(row.result) }}</span>
              </div>
              <p v-if="row.actor" class="text-[11px] text-text-muted truncate mt-0.5">{{ actorText(row.actor) }}</p>
              <p v-if="row.reason" class="text-[11px] text-text-muted truncate mt-0.5" :title="row.reason">{{ row.reason }}</p>
            </div>
          </li>
        </ul>
      </div>

      <!-- 记录设置：两个入口共用一份（同一张表，规则不该有两套），所以这里注明 -->
      <div class="border-t border-border mt-3 pt-3 flex items-center gap-2 flex-wrap text-xs text-text-muted flex-shrink-0">
        <span>记录方式</span>
        <AppSelect :model-value="config.granularity" aria-label="记录方式" :options="GRAN_OPTIONS" compact class="w-32"
          @change="onGranularity" />
        <span class="ml-1">保留</span>
        <AppSelect :model-value="config.keep" aria-label="记录保留条数" :options="keepOptions" compact class="w-24"
          @change="onKeep" />
        <span class="ml-auto">已记 {{ total }} 条</span>
        <button type="button" @click="askClear = true" :disabled="!total"
          class="btn-plain px-2.5 py-1 text-xs text-danger disabled:opacity-40">清空记录</button>
      </div>
    </div>

    <ConfirmDialog :visible="askClear" :z-index="zIndex + 10" title="清空访问记录"
      :message="clearMessage" show-cancel confirm-text="清空" @confirm="doClear" @cancel="askClear = false" />
    <!-- 改小保留条数且会丢历史时先确认；取消则下拉留在旧值（config.keep 没动过） -->
    <ConfirmDialog :visible="pendingKeep != null" :z-index="zIndex + 10" title="减少保留条数"
      :message="shrinkMessage" show-cancel confirm-text="仍要设置"
      @confirm="applyPendingKeep" @cancel="pendingKeep = null" />
  </DialogShell>
</template>

<script setup vapor>
import { computed, ref, watch } from 'vue'
import DialogShell from '../base/DialogShell.vue'
import IconGlyph from '../base/IconGlyph.vue'
import AppHelp from '../base/AppHelp.vue'
import AppSelect from '../base/AppSelect.vue'
import ConfirmDialog from '../base/ConfirmDialog.vue'
import { useNotification } from '../../composables/useNotification.js'
import { useAccessLog } from '../../composables/useAccessLog.js'
import { LABELS } from '../../composables/ai/aiConstants.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  // 'ai' | 'mcp'：两端各自只看自己的记录，不提供「全部」——全部来源的写入与回退
  // 在「设置 → 更改审查」里，那是另一件事（写入），不在这里重复。
  source: { type: String, default: 'ai' },
  zIndex: { type: Number, default: 10080 },
})
const emit = defineEmits(['close', 'changed'])

const notify = useNotification()
const {
  logs, total, retentionTotal, summary, config, loading, error, load, saveConfig, clear,
} = useAccessLog(props.source)

const onlyAbnormal = ref(false)
const askClear = ref(false)

const title = computed(() => (props.source === 'mcp' ? 'MCP 访问记录' : 'AI 访问记录'))

const helpText = [
  '读和写都在这里；统计窗口为最近 7 天。',
  '写入不重复存：已执行的写来自「设置 → 更改审查」（同一件事只出现一次），未执行的写是 MCP 待确认提案。',
  '不记数据内容：只有表名、条数和结果，学生信息不会被复制到记录里。',
  '回退某次写入：去「设置 → 更改审查」，那里有前后值和回退按钮。',
].join('\n')

const emptyText = '暂无记录'

const summaryText = computed(() => {
  const s = summary.value
  const parts = []
  if (s.total) parts.push(`${s.total} 次读取`)
  if (s.writes) parts.push(`${s.writes} 次写入`)
  if (s.denied) parts.push(`${s.denied} 次被拒`)
  if (s.failed) parts.push(`${s.failed} 次失败`)
  if (s.pending) parts.push(`${s.pending} 条待确认`)
  return parts.join(' · ')
})

const clearMessage = computed(() => `将清空读取记录 ${summary.value.total} 条，无法恢复。\n写入记录不在此范围内（在「设置 → 更改审查」）。`)

const GRAN_OPTIONS = [
  { value: 'per_call', label: '每次调用一条' },
  { value: 'per_day', label: '按天合并' },
]
const KEEP_BASE = [200, 500, 1000, 2000]
const KEEP_FOREVER = 0
// 后端允许 100~5000 的自定义值：当前值不在预设档里时补一项，别让下拉显示成空。
// 0 是「永久」哨兵（后端放行、不裁剪），单独占一档，别显示成「0 条」。
const keepOptions = computed(() => {
  const cur = config.value.keep
  const nums = KEEP_BASE.includes(cur) || cur === KEEP_FOREVER
    ? KEEP_BASE
    : [...KEEP_BASE, cur].sort((a, b) => a - b)
  return [
    ...nums.map((v) => ({ value: v, label: `${v} 条` })),
    { value: KEEP_FOREVER, label: '永久' },
  ]
})

const TOOL_LABEL = {
  // 读：MCP 侧工具名
  read_table: '读取表', read_doc: '读取文档', search: '搜索', list_tables: '列出表',
  // 读：AI 侧工具名
  query: '查询', aggregate: '统计', search_all: '搜索', describe_table: '查看结构',
  show_record: '展示记录', export_image: '导出图片', export_file: '导出文件', delete_impact: '评估删除影响',
  // 写：已执行的写入 / 未执行的提案
  write: '写入', proposal: '提案',
}
function toolLabel(tool) { return TOOL_LABEL[tool] || String(tool || '') }

// 表名统一翻成中文（LABELS 是 AI 提案卡片同一份映射），搜索词加书名号。
// 写入行的 key 可能本身就是中文（课程表/座位表等整块文档的撤销分组），原样显示即可。
function targetText(row) {
  const t = String(row.target || '')
  if (!t) return ''
  if (LABELS[t]) return LABELS[t]
  if (row.tool === 'search' || row.tool === 'search_all') return `「${t}」`
  return t
}

// 主文案：读是「表名」，写是「那次动作的说明」（修改学生姓名 / 导入 3 名学生）
function titleText(row) {
  if (row.kind === 'read') return targetText(row)
  return row.detail || targetText(row)
}

function metaText(row) {
  if (row.kind === 'write') {
    const table = targetText(row)
    return row.count > 1 ? `${row.count} 条改动${table ? ` · ${table}` : ''}` : table
  }
  if (row.kind === 'proposal') return targetText(row)
  if (row.count > 1) return `${row.count} 次${row.detail ? ` · ${row.detail}` : ''}`
  return row.detail || ''
}

function actorText(actor) {
  return props.source === 'mcp' ? `令牌 · ${actor}` : `对话 · ${actor}`
}

function resultLabel(r) {
  return { denied: '已拒绝', failed: '失败', undone: '已撤销', pending: '待确认' }[r] || ''
}

// 圆点：读=主色实心；写=成功色实心；已撤销/待确认/被拒/失败=空心，颜色只做提示
function dotClass(row) {
  const r = row.result
  if (r === 'ok') return row.kind === 'write' ? 'is-write' : ''
  return { denied: 'is-denied', failed: 'is-failed', undone: 'is-undone', pending: 'is-pending' }[r] || ''
}

function fmtTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  // 精确到秒：AI 一轮对话里会连着读好几张表，只到分钟看不出先后
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function reload() { load({ limit: 200, onlyAbnormal: onlyAbnormal.value ? 1 : undefined }) }

function toggleAbnormal(v) {
  onlyAbnormal.value = !!v
  reload()
}

async function onGranularity(v) {
  if (await saveConfig({ granularity: v })) {
    reload()
    emit('changed')
  }
}

// 改小且当前条数已超过目标值 → 会丢历史，先确认；否则（含改成「永久」）直接设置。
// 下拉是受控的：不调 saveConfig 就不会改 config.keep，取消后自动停回旧值。
// 保留条数是全局的（AI 与 MCP 共用一张表、共用一份 keep），而这个弹窗只看当前来源。
// 所以「会不会丢历史」要按全表原始条数判断：否则只看到 20 条的 AI 面板从 500 改到 100
// 不弹确认，后端却按全表的 800 条裁到 100（审查 v7 · #33）。
const pendingKeep = ref(null)
const shrinkMessage = computed(() =>
  `全部来源共记 ${retentionTotal.value} 条，多于要设置的 ${pendingKeep.value} 条。确认后超出的历史记录会被丢弃，无法恢复。`)

function onKeep(v) {
  const next = Number(v)
  if (next > 0 && retentionTotal.value > next) {
    pendingKeep.value = next
    return
  }
  applyKeep(next)
}

async function applyKeep(v) {
  if (await saveConfig({ keep: v })) {
    reload()
    emit('changed')
  }
}

async function applyPendingKeep() {
  const v = pendingKeep.value
  pendingKeep.value = null
  if (v != null) await applyKeep(v)
}

async function doClear() {
  askClear.value = false
  const n = await clear()
  if (n) notify.success(`已清空 ${n} 条读取记录`)
  // 写入记录不在这次清空的范围内，清完必须重拉，否则列表会把它们一起"清空"掉
  reload()
  emit('changed')
}

// 每次打开都重拉：记录是别人（AI / 外部客户端）随时在写的，缓存的列表很快就过期
watch(() => props.visible, (v) => {
  if (v) {
    onlyAbnormal.value = false
    reload()
  } else {
    askClear.value = false
    pendingKeep.value = null
  }
})

function close() { emit('close') }
</script>

<style scoped>
/* 弹窗宽度：比父级（AI 数据保护 38rem / MCP 弹窗 40rem）宽一档，
   一行里能放下「时间 + 动作 + 表名 + 量 + 结果」不换行。 */
.access-dialog {
  width: 46rem;
  max-width: calc(100vw - 2rem);
  max-height: 86vh;
}

/* ===== 时间轴：与「更改审查」同一种语言（圆点 + 竖线），但这里是只读记录 ===== */
.access-tl {
  --line: var(--color-border, #e5e7eb);
  padding: 2px 0;
}
.access-tl-row {
  display: flex;
  gap: 10px;
  padding: 7px 4px;
  border-radius: var(--radius-control, 6px);
}
.access-tl-row:hover {
  background: color-mix(in srgb, var(--color-text, #111827) 4%, transparent);
}
.access-tl-gutter {
  position: relative;
  width: 12px;
  flex: none;
  display: flex;
  justify-content: center;
}
/* 竖线画在 gutter 上；首行从圆点起、末行到圆点止，两端不悬空 */
.access-tl-gutter::before {
  content: '';
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  width: 1px;
  background: var(--line);
  top: 0;
  bottom: 0;
}
.access-tl-row:first-child .access-tl-gutter::before { top: 50%; }
.access-tl-row:last-child .access-tl-gutter::before { bottom: 50%; }
.access-tl-row:only-child .access-tl-gutter::before { display: none; }
.access-tl-dot {
  position: relative;
  z-index: 1;
  width: 7px;
  height: 7px;
  margin-top: 7px;
  border-radius: 999px;
  background: var(--color-primary, #3b82f6);
  box-shadow: 0 0 0 3px var(--color-surface, #fff);
}
/* 被拒 / 失败用空心点：颜色只做提示，不做第二套配色，保持和时间轴同一套语言 */
.access-tl-dot.is-denied {
  background: var(--color-surface, #fff);
  border: 1.5px solid var(--color-warning, #f59e0b);
}
.access-tl-dot.is-failed {
  background: var(--color-surface, #fff);
  border: 1.5px solid var(--color-danger, #ef4444);
}
/* 写入：成功色实心 —— 与「读」的蓝点区分开，但不做成第二套视觉语言 */
.access-tl-dot.is-write { background: var(--color-success, #22c55e); }
.access-tl-dot.is-undone {
  background: var(--color-surface, #fff);
  border: 1.5px solid var(--color-border-strong, #9ca3af);
}
.access-tl-dot.is-pending {
  background: var(--color-surface, #fff);
  border: 1.5px solid var(--color-warning, #f59e0b);
}

/* 动作：小号同色系标签，不用来源色标（这里来源是固定的，标了也没信息量） */
.access-act {
  flex: none;
  font-size: 11px;
  line-height: 1.5;
  padding: 0 6px;
  border-radius: 999px;
  color: color-mix(in srgb, var(--color-text, #111827) 75%, transparent);
  background: color-mix(in srgb, var(--color-text, #111827) 8%, transparent);
}
/* 写入用成功色淡染、提案用警示色淡染：扫一眼就能分出「这条是改数据」 */
.access-act.is-write {
  color: color-mix(in srgb, var(--color-success, #22c55e) 70%, var(--color-text, #111827));
  background: color-mix(in srgb, var(--color-success, #22c55e) 14%, transparent);
}
.access-act.is-pending {
  color: color-mix(in srgb, var(--color-warning, #f59e0b) 70%, var(--color-text, #111827));
  background: color-mix(in srgb, var(--color-warning, #f59e0b) 14%, transparent);
}
.access-badge {
  flex: none;
  font-size: 10px;
  line-height: 1.5;
  padding: 0 6px;
  border-radius: 999px;
}
.access-badge.denied {
  color: color-mix(in srgb, var(--color-warning, #f59e0b) 70%, var(--color-text, #111827));
  background: color-mix(in srgb, var(--color-warning, #f59e0b) 15%, transparent);
}
.access-badge.failed {
  color: color-mix(in srgb, var(--color-danger, #ef4444) 70%, var(--color-text, #111827));
  background: color-mix(in srgb, var(--color-danger, #ef4444) 14%, transparent);
}
.access-badge.undone {
  color: var(--color-text-muted, #9ca3af);
  background: color-mix(in srgb, var(--color-text, #111827) 7%, transparent);
}
.access-badge.pending {
  color: color-mix(in srgb, var(--color-warning, #f59e0b) 70%, var(--color-text, #111827));
  background: color-mix(in srgb, var(--color-warning, #f59e0b) 15%, transparent);
}
</style>
