<template>
  <!-- MCP 服务管理：一个启用开关 + 四行入口（令牌 / 数据权限 / 提案 / 访问记录）。
       原来这里竖排了说明、开关、令牌列表、混淆+权限、提案五段，一屏塞不下，
       下面的权限和提案永远在视野外。现在面板只负责「状态摘要」，
       具体操作各自进弹窗（令牌 / 数据权限 / 提案 / 访问记录），一屏能看完。 -->
  <div class="bg-surface rounded-lg border border-border p-6">
    <div class="flex items-center gap-1.5 mb-2">
      <h3 id="settings-section-mcp" class="text-base font-semibold text-text">MCP 服务管理</h3>
      <AppHelp aria-label="MCP 服务说明" :z-index="10007" :text="introHelp" />
    </div>
    <p class="text-xs text-text-muted leading-relaxed mb-1">
      把本班数据暴露给 Claude Desktop / Cursor 等外部 AI 客户端。传输走本机回环地址，使用独立访问令牌鉴权；
      外部 AI 只能读取预设数据，写入默认要你确认。
    </p>

    <!-- 启用开关：opt-in，默认关闭。安全提示必须留在这一行，不能跟着令牌一起收进弹窗 -->
    <div class="flex items-center justify-between gap-4 py-3">
      <div class="min-w-0">
        <span class="block text-sm font-medium text-text">启用 MCP 服务</span>
        <span class="block text-xs text-text-muted mt-0.5">默认关闭。开启后，任何持有令牌的客户端都能读写本班数据。</span>
      </div>
      <AppSwitch :model-value="mcpEnabled" aria-label="启用 MCP 服务" @update:model-value="setMcpEnabled" />
    </div>

    <!-- 自动执行：默认关闭。开启后外部 AI 的改动不再经人确认（含删除），
         所以用自己的确认弹窗挡一道，且状态行常驻提示——避免开了忘关。 -->
    <div class="flex items-center justify-between gap-4 py-3 border-t border-border">
      <div class="min-w-0">
        <span class="block text-sm font-medium text-text">自动执行提案</span>
        <span class="block text-xs mt-0.5" :class="autoConfirm ? 'text-warning' : 'text-text-muted'">
          {{ autoConfirm ? '已开启：外部 AI 的改动不再等确认，删除也直接执行。' : '关闭时，外部 AI 每次改动都要你点确认。' }}
        </span>
      </div>
      <AppSwitch :model-value="autoConfirm" aria-label="自动执行提案" @update:model-value="onAutoSwitch" />
    </div>

    <!-- 三行管理入口：行尾必须带状态摘要，否则每次都要点进去才知道里面有什么 -->
    <div
      v-for="row in rows"
      :key="row.key"
      class="flex items-center justify-between gap-4 py-3 border-t border-border"
    >
      <div class="min-w-0">
        <span class="block text-sm font-medium text-text">{{ row.title }}</span>
        <span v-if="row.summary" class="block text-xs mt-0.5 truncate" :class="row.warn ? 'text-warning' : 'text-text-muted'">{{ row.summary }}</span>
      </div>
      <button
        type="button"
        class="flex items-center gap-1 flex-shrink-0 bg-bg hover:bg-surface-hover text-text border border-border px-3 py-1.5 rounded text-sm transition-theme whitespace-nowrap"
        @click="openDialog = row.key"
      >{{ row.action || '管理' }}<span class="text-text-muted">›</span></button>
    </div>

    <p v-if="!mcpEnabled" class="text-xs text-text-muted mt-2 leading-relaxed">
      服务当前未启用：令牌与权限可以先配好，但外部客户端连不进来，配置在开启后才生效。
    </p>

    <McpTokensDialog :visible="openDialog === 'tokens'" @close="openDialog = ''" @changed="reloadAll" />
    <McpPermissionsDialog :visible="openDialog === 'perms'" @close="openDialog = ''" @changed="reloadPrivacy" />
    <McpProposalsDialog :visible="openDialog === 'proposals'" @close="openDialog = ''" @changed="loadProposals" />
    <AccessLogDialog :visible="openDialog === 'logs'" source="mcp" @close="openDialog = ''" @changed="loadLogSummary" />

    <ConfirmDialog :visible="askAutoConfirm" :z-index="10010" title="开启自动执行"
      :message="autoConfirmMessage" show-cancel confirm-text="仍然开启"
      @confirm="confirmAuto" @cancel="askAutoConfirm = false" />
  </div>
</template>

<script setup vapor>
import { computed, onMounted, ref } from 'vue'
import axios from 'axios'
import { useDisposables } from '../../utils/disposables.js'
import { useNotification } from '../../composables/useNotification.js'
import { usePrivacyConfig, levelOf } from '../../composables/usePrivacyConfig.js'
import AppSwitch from '../base/AppSwitch.vue'
import AppHelp from '../base/AppHelp.vue'
import ConfirmDialog from '../base/ConfirmDialog.vue'
import McpTokensDialog from './McpTokensDialog.vue'
import McpPermissionsDialog from './McpPermissionsDialog.vue'
import McpProposalsDialog from './McpProposalsDialog.vue'
import AccessLogDialog from './AccessLogDialog.vue'
import { useAccessLog } from '../../composables/useAccessLog.js'
import { createLatest } from '../../utils/latestOnly.js'

// 定时器统一走 disposables：组件卸载自动释放（项目红线：不许裸 setInterval）
const d = useDisposables()
const notify = useNotification()

// 只用来算摘要（混淆 x/3、可写/只读几张）；真正改写在弹窗里，那个实例负责回滚与序号守卫。
// 读的是 MCP 自己那份（mcp_privacy_json），不是 AI 助手的数据保护。
const { cfg, load: loadPrivacy } = usePrivacyConfig('mcp')

// 访问记录摘要：只看 mcp（AI 那一侧在「AI 数据保护」里）。只拉摘要，不拉列表。
const { summary: logSummary, loadSummary: loadLogSummary } = useAccessLog('mcp')

const tokens = ref([])
const pendingCount = ref(0)
const mcpEnabled = ref(false)
const autoConfirm = ref(false)
const askAutoConfirm = ref(false)
const openDialog = ref('') // '' | tokens | perms | proposals

const autoConfirmMessage = '开启后，持有令牌的外部 AI 改动本班数据时不再询问你：新增、修改、删除都会立即执行。'
  + '\n改动仍会登记下来，可以从「更改审查」整批退回；每次自动执行也会记进「MCP 访问记录」。'

const introHelp = [
  '开关只影响外部客户端：本班自己用的 AI 助手不受影响。',
  '关着时，外部客户端即使带着有效令牌也连不进来。',
  '「自动执行提案」默认关：关着时外部 AI 的每次改动都要你确认；打开后（含删除）立即执行。',
  '令牌、按表权限、待确认提案分别点对应行的「管理」查看。',
].join('\n')

const tokenSummary = computed(() => {
  // 没有令牌时不再写一句「还没有令牌，点『管理』新增」——「管理」按钮就在右边，
  // 说明文字留给 ⓘ。（新规矩：界面少说话，重要说明进 ⓘ。）
  if (!tokens.value.length) return ''
  const revoked = tokens.value.filter(t => t.revoked).length
  return `${tokens.value.length} 个${revoked ? ` · ${revoked} 个已失效` : ''}`
})

const permSummary = computed(() => {
  const c = cfg.value
  const tables = Array.isArray(c.tables) ? c.tables : []
  if (!tables.length) return '正在读取…'
  const writable = tables.filter(t => levelOf(t) === 'write').length
  const readonly = tables.filter(t => levelOf(t) === 'read').length
  const masked = ['hide_phone', 'hide_path', 'hide_album'].filter(k => c[k]).length
  return `${c.enabled ? `混淆 ${masked}/3` : '混淆未启用'} · 可写 ${writable} 张 · 只读 ${readonly} 张`
})

const proposalSummary = computed(() => (pendingCount.value ? `${pendingCount.value} 条待确认` : ''))

const logSummaryText = computed(() => {
  const s = logSummary.value
  const parts = []
  if (s.total) parts.push(`${s.total} 次读取`)
  if (s.writes) parts.push(`${s.writes} 次写入`)
  if (s.denied) parts.push(`${s.denied} 次被拒`)
  if (s.failed) parts.push(`${s.failed} 次失败`)
  if (s.pending) parts.push(`${s.pending} 条待确认`)
  return parts.join(' · ')
})

const rows = computed(() => [
  { key: 'tokens', title: 'MCP 令牌', summary: tokenSummary.value, warn: false },
  { key: 'perms', title: 'MCP 数据权限', summary: permSummary.value, warn: false },
  { key: 'proposals', title: 'MCP 提案', summary: proposalSummary.value, warn: pendingCount.value > 0 },
  // 访问记录：只读、只看 mcp（AI 那一侧在「AI 数据保护」弹窗底部）。
  // 按钮文案是「查看」而不是「管理」——这里没有可配置的东西（除了弹窗底部的记录设置）。
  { key: 'logs', title: 'MCP 访问记录', summary: logSummaryText.value, warn: logSummary.value.denied > 0, action: '查看' },
])

// 每个异步字段各自一个「只认最后一次」守卫：
//   · xSeq  —— 同一字段的多次读取，慢响应不能盖掉新响应；
//   · xWrite —— 本地开关的写入代次，读取结果只在「取数后没有发生过写入」时才落回界面，
//     否则会拿旧值把用户刚切换的开关弹回去（这块是乐观更新）。
const enabledSeq = createLatest()
const enabledWrite = createLatest()
const prefsSeq = createLatest()
const prefsWrite = createLatest()
const tokensSeq = createLatest()
const proposalsSeq = createLatest()

async function loadEnabled() {
  const my = enabledSeq.begin()
  const writeAt = enabledWrite.current()
  try {
    const r = await axios.get('/api/mcp/enabled')
    if (!enabledSeq.isCurrent(my) || enabledWrite.current() !== writeAt) return
    mcpEnabled.value = !!r.data.enabled
  } catch (_) { /* best-effort: 读不到按关闭显示，不阻断面板 */ }
}
async function loadPrefs() {
  const my = prefsSeq.begin()
  const writeAt = prefsWrite.current()
  try {
    const r = await axios.get('/api/mcp/prefs')
    if (!prefsSeq.isCurrent(my) || prefsWrite.current() !== writeAt) return
    // 严格等于 true 才算开启：后端也用同一口径，脏值当关闭
    autoConfirm.value = r.data.auto_confirm === true
  } catch (_) { /* best-effort: 读不到按关闭显示 */ }
}

// 开启要过一道确认（含删除）；关闭不要——关掉永远不会造成损失，多问一次只是烦。
function onAutoSwitch(v) {
  if (!v) { setAutoConfirm(false); return }
  askAutoConfirm.value = true
}
function confirmAuto() {
  askAutoConfirm.value = false
  setAutoConfirm(true)
}
async function setAutoConfirm(v) {
  const prev = autoConfirm.value
  const my = prefsWrite.begin()
  autoConfirm.value = v // 乐观更新，避免等回包时开关闪回
  try {
    const r = await axios.put('/api/mcp/prefs', { auto_confirm: v })
    if (!prefsWrite.isCurrent(my)) return // 期间又切过：以最后一次为准
    autoConfirm.value = r.data.auto_confirm === true
    notify.success(v ? '已开启自动执行' : '已关闭自动执行')
  } catch (e) {
    if (!prefsWrite.isCurrent(my)) return
    autoConfirm.value = prev
    notify.error('保存自动执行设置失败：' + (e.response?.data?.error || e.message))
  }
}
async function setMcpEnabled(v) {
  const prev = mcpEnabled.value
  const my = enabledWrite.begin()
  mcpEnabled.value = v // 乐观更新，避免等待回包时开关闪回
  try {
    const r = await axios.put('/api/mcp/enabled', { enabled: v })
    if (!enabledWrite.isCurrent(my)) return
    mcpEnabled.value = !!r.data.enabled
  } catch (e) {
    if (!enabledWrite.isCurrent(my)) return
    mcpEnabled.value = prev
    notify.error('保存启用状态失败：' + (e.response?.data?.error || e.message))
  }
}

async function loadTokens() {
  const my = tokensSeq.begin()
  try {
    const r = await axios.get('/api/mcp/tokens')
    if (!tokensSeq.isCurrent(my)) return
    tokens.value = r.data.tokens || []
  } catch (_) { /* best-effort: 摘要读不到就保持「还没有令牌」，点进去会重拉 */ }
}
async function loadProposals() {
  const my = proposalsSeq.begin()
  try {
    const r = await axios.get('/api/mcp/proposals', { params: { status: 'pending' } })
    if (!proposalsSeq.isCurrent(my)) return
    pendingCount.value = (r.data.proposals || []).length
  } catch (_) { /* best-effort: 保留上次条数，不闪成 0 */ }
}
function reloadPrivacy() { loadPrivacy().catch(() => {}) } // best-effort: 保留上次条数，不闪成 0
function reloadAll() {
  loadTokens()
  reloadPrivacy()
  loadProposals()
  loadLogSummary()
}

onMounted(() => {
  loadEnabled().catch(() => {}) // best-effort: 开关/偏好加载失败时保留默认值
  loadPrefs().catch(() => {}) // best-effort: 开关/偏好加载失败时保留默认值
  reloadAll()
  // 提案条数留在面板上轮询：弹窗按需挂载，关着时没人拉数据。
  // （下一步计划交给标题栏通知中心统一喊，届时这里可以去掉。）
  d.interval(() => { loadProposals().catch(() => {}) }, 8000) // best-effort: 轮询拉取失败不影响面板，下次tick重试
})
</script>
