<template>
  <div class="mcp-panel space-y-5">
    <p class="text-xs text-text-muted leading-relaxed">
      把本班数据暴露给 Claude Desktop / Cursor 等外部 AI 客户端。传输走本机回环地址，
      使用独立访问令牌鉴权；外部 AI 只能读取预设数据，写入必须先生成提案、由你在这里确认后才会执行。
    </p>

    <!-- 令牌管理 -->
    <div>
      <div class="flex items-center justify-between mb-2">
        <h4 class="text-sm font-medium text-text">访问令牌</h4>
        <button type="button" @click="generate" :disabled="busy"
          class="bg-primary hover:bg-primary-hover text-text-inverse px-3 py-1.5 rounded text-sm transition-theme disabled:opacity-50">
          生成令牌
        </button>
      </div>
      <div v-if="tokens.length" class="space-y-2">
        <div v-for="t in tokens" :key="t.id" class="flex items-center justify-between gap-3 bg-bg-secondary rounded px-3 py-2">
          <div class="min-w-0">
            <p class="text-sm text-text truncate">{{ t.label || '未命名令牌' }}
              <span v-if="t.revoked" class="text-danger text-xs ml-1">（已撤销）</span>
            </p>
            <p class="text-xs text-text-muted font-mono">{{ t.id }}</p>
          </div>
          <button v-if="!t.revoked" type="button" @click="revoke(t.id)" :disabled="busy"
            class="text-danger hover:underline text-sm flex-shrink-0">撤销</button>
        </div>
      </div>
      <p v-else class="text-xs text-text-muted">还没有令牌。生成一个后，把下面的一段配置填到 Claude Desktop / Cursor。</p>
    </div>

    <!-- 新生成的令牌，只显示一次 -->
    <div v-if="newToken" class="bg-warning/10 border border-warning rounded p-3">
      <p class="text-sm text-warning font-medium mb-2">请立即复制并保存，此令牌只显示这一次：</p>
      <code class="block text-xs text-text bg-bg-secondary rounded p-2 break-all select-all">{{ newToken }}</code>
      <button type="button" @click="copy(newToken)" class="mt-2 text-sm text-info hover:underline">复制令牌</button>
    </div>

    <!-- 客户端配置片段 -->
    <div>
      <h4 class="text-sm font-medium text-text mb-2">客户端配置（mcpServers）</h4>
      <pre class="text-xs text-text bg-bg-secondary rounded p-3 overflow-auto">{{ configSnippet }}</pre>
      <button type="button" @click="copy(configSnippet)" class="mt-2 text-sm text-info hover:underline">复制配置</button>
      <p class="text-xs text-text-muted mt-2 leading-relaxed">
        <code>命令</code>需指向安装目录下的 <code>mcp-forwarder.cjs</code>（用随应用的 Node 运行时启动）。
        转发器只携带 URL 与令牌，接触不到数据库密钥。
      </p>
    </div>

    <!-- 待确认提案 -->
    <div>
      <div class="flex items-center justify-between mb-2">
        <h4 class="text-sm font-medium text-text">待确认提案
          <span v-if="pending.length" class="text-warning">（{{ pending.length }}）</span>
        </h4>
        <button type="button" @click="loadProposals" :disabled="busy" class="text-sm text-info hover:underline">刷新</button>
      </div>
      <div v-if="pending.length" class="space-y-2">
        <div v-for="p in pending" :key="p.proposal_id" class="bg-bg-secondary rounded p-3">
          <p class="text-sm text-text mb-1">{{ p.label || '数据修改提案' }}</p>
          <p class="text-xs text-text-muted mb-2">{{ p.table }} · {{ p.operation }} · {{ p.created_at }}</p>
          <div class="flex gap-2">
            <button type="button" @click="decide(p.proposal_id, 'confirm')" :disabled="busy"
              class="bg-primary hover:bg-primary-hover text-text-inverse px-3 py-1 rounded text-sm">确认执行</button>
            <button type="button" @click="decide(p.proposal_id, 'reject')" :disabled="busy"
              class="bg-bg-secondary hover:bg-danger/20 text-text px-3 py-1 rounded text-sm">拒绝</button>
          </div>
        </div>
      </div>
      <p v-else class="text-xs text-text-muted">暂无待确认提案。</p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import { useDisposables } from '../../utils/disposables.js'
import { useNotification } from '../../composables/useNotification.js'

// 定时器统一走 disposables：组件卸载自动释放（项目红线：不许裸 setInterval）
const d = useDisposables()
const notify = useNotification()

const tokens = ref([])
const pending = ref([])
const newToken = ref('')
const busy = ref(false)
const endpoint = ref('/mcp')

const configSnippet = computed(() => JSON.stringify({
  mcpServers: {
    classnest: {
      command: '<随应用 Node 运行时>',
      args: ['<安装目录>/student-backend/mcp-forwarder.cjs'],
      env: {
        CLASSNEST_MCP_URL: 'http://127.0.0.1:3000/mcp',
        CLASSNEST_MCP_TOKEN: newToken.value || '<在此填入令牌>',
      },
    },
  },
}, null, 2))

async function loadTokens() {
  const r = await axios.get('/api/mcp/tokens')
  tokens.value = r.data.tokens || []
  endpoint.value = r.data.endpoint || '/mcp'
}
async function loadProposals() {
  const r = await axios.get('/api/mcp/proposals', { params: { status: 'pending' } })
  pending.value = r.data.proposals || []
}
async function generate() {
  busy.value = true
  try {
    const r = await axios.post('/api/mcp/tokens', { label: '外部 AI 客户端' })
    newToken.value = r.data.token
    await loadTokens()
  } catch (e) { notify.error('生成令牌失败：' + (e.response?.data?.error || e.message)) }
  finally { busy.value = false }
}
async function revoke(id) {
  busy.value = true
  try {
    await axios.post(`/api/mcp/tokens/${encodeURIComponent(id)}/revoke`, {})
    await loadTokens()
  } catch (e) { notify.error('撤销失败：' + (e.response?.data?.error || e.message)) }
  finally { busy.value = false }
}
async function decide(id, decision) {
  busy.value = true
  try {
    const r = await axios.post(`/api/mcp/proposals/${encodeURIComponent(id)}/decide`, { decision })
    if (r.data.status === 'failed') notify.error('执行失败：' + (r.data.result?.error || '未知原因'))
    else notify.success(decision === 'confirm' ? '已执行提案' : '已拒绝提案')
    await loadProposals()
  } catch (e) { notify.error('处理提案失败：' + (e.response?.data?.error || e.message)) }
  finally { busy.value = false }
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); } catch (_) { /* 剪贴板不可用时用户可手动选中 */ }
}

onMounted(() => {
  loadTokens().catch(() => {})
  loadProposals().catch(() => {})
  // 每 8 秒拉一次待确认提案，卸载时由 disposables 自动清掉
  d.interval(() => { loadProposals().catch(() => {}) }, 8000)
})
</script>
