<template>
  <!-- MCP 令牌弹窗：设置页「MCP 令牌 › 管理」打开。
       自包含——列表、新增、复制、失效、去除记录都在这里，关闭后不占面板高度。
       原来这一整块内联在 McpSettingsPanel 里，一屏塞不下，把下面的权限和提案挤到视野外。 -->
  <DialogShell :visible="visible" :z-index="10070" overlay-class="bg-black/50" @overlay="close">
    <div class="dialog-card bg-surface rounded-lg border border-border shadow-lg p-5 flex flex-col mcp-dialog">
      <div class="flex items-center justify-between gap-3 mb-3 flex-shrink-0">
        <div class="flex items-center gap-1.5">
          <h3 class="text-lg font-bold text-text">MCP 令牌</h3>
          <AppHelp aria-label="令牌管理说明" :z-index="10075" :text="tokenHelp" />
        </div>
        <button class="dlg-close" title="关闭" @click="close">✕</button>
      </div>

      <div class="flex items-center justify-between gap-3 mb-2 flex-shrink-0">
        <p class="text-xs text-text-muted">令牌明文存在本班加密数据库里，随时可复制。</p>
        <button type="button" @click="showCreate = true"
          class="bg-primary hover:bg-primary-hover text-text-inverse px-3 py-1.5 rounded text-sm transition-theme whitespace-nowrap">
          新增令牌
        </button>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto app-custom-scroll pr-1">
        <div v-if="tokens.length" class="space-y-2">
          <div v-for="t in tokens" :key="t.id" class="flex items-center justify-between gap-3 bg-bg-secondary rounded px-3 py-2">
            <div class="min-w-0">
              <p class="text-sm text-text truncate">{{ t.label || '未命名令牌' }}
                <span v-if="t.revoked" class="text-danger text-xs ml-1">（已失效）</span>
                <!-- 有效期就放在原来「已失效」的位置：有到期日显示日期（过期标红），没有则长期有效 -->
                <span v-else class="text-xs ml-1" :class="isExpired(t) ? 'text-danger' : 'text-text-muted'">（{{ expiryText(t) }}）</span>
              </p>
              <p class="text-xs text-text-muted font-mono truncate">{{ t.id }}</p>
            </div>
            <!-- 与账号信息按钮同一套类：各主题会把 bg-* + text-text-inverse 自动转成浅色玻璃块 -->
            <div v-if="!t.revoked" class="flex gap-2 flex-shrink-0">
              <button type="button" @click="copyPlain(t.id)" :disabled="busy"
                class="bg-info hover:bg-info-hover text-text-inverse px-3 py-1 rounded text-xs transition-theme disabled:opacity-50">复制令牌</button>
              <button type="button" @click="copyConfig(t.id)" :disabled="busy"
                class="bg-info hover:bg-info-hover text-text-inverse px-3 py-1 rounded text-xs transition-theme disabled:opacity-50">复制配置</button>
              <button type="button" @click="revoke(t.id)" :disabled="busy"
                class="bg-danger hover:bg-danger-hover text-text-inverse px-3 py-1 rounded text-xs transition-theme disabled:opacity-50">删除配置</button>
            </div>
            <!-- 已失效令牌：右侧原本空白，这里给一个「去除记录」彻底删掉这条行 -->
            <div v-else class="flex-shrink-0">
              <button type="button" @click="removeTarget = t" :disabled="busy"
                class="bg-bg-secondary hover:bg-danger/20 text-text px-3 py-1 rounded text-xs transition-theme disabled:opacity-50">去除记录</button>
            </div>
          </div>
        </div>
        <p v-else-if="loading" class="text-sm text-text-muted py-8 text-center">正在读取令牌…</p>
        <p v-else class="text-sm text-text-muted py-8 text-center">还没有令牌。点「新增令牌」后，把该行的配置填到 Claude Desktop / Cursor。</p>
      </div>

      <p class="text-xs text-text-muted mt-3 leading-relaxed flex-shrink-0">
        「复制配置」生成可直接粘贴的 mcpServers 配置（exe 与转发器路径由软件自动填好）；「删除配置」让令牌立即失效、仍显示在列表；「去除记录」把失效令牌彻底移除。
      </p>
    </div>

    <CreateTokenDialog :show="showCreate" @close="showCreate = false" @created="onCreated" />

    <!-- 去除记录确认：已失效令牌彻底删掉后列表不再显示，先问一句防误点。
         层级必须高于本弹窗（10070），否则确认框会被压在下面看不见。 -->
    <ConfirmDialog :visible="!!removeTarget" :z-index="10080" title="去除记录"
      :message="`确定去除「${removeTarget?.label || removeTarget?.id || '该令牌'}」这条记录吗？\n该令牌已失效，去除后列表中不再显示，无法恢复。`"
      confirm-text="确定去除" cancel-text="取消" :show-cancel="true"
      @confirm="doRemove" @cancel="removeTarget = null" />
  </DialogShell>
</template>

<script setup vapor>
import { ref, watch } from 'vue'
import axios from 'axios'
import { INVOKE } from '../../electronChannels.js'
import { useNotification } from '../../composables/useNotification.js'
import { formatDate } from '../../utils/dateTime.js'
import { backendOrigin } from '../../utils/backendOrigin.js'
import DialogShell from '../base/DialogShell.vue'
import AppHelp from '../base/AppHelp.vue'
import ConfirmDialog from '../base/ConfirmDialog.vue'
import CreateTokenDialog from '../dialogs/CreateTokenDialog.vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'changed'])

const notify = useNotification()

const tokens = ref([])
const loading = ref(false)
const busy = ref(false)
const showCreate = ref(false)
const removeTarget = ref(null) // 待确认「去除记录」的令牌行
// 「复制配置」里的路径由主进程给（软件自己知道装在哪）；拿不到时才退到占位符
const launchInfo = ref(null)

const tokenHelp = [
  '「复制配置」会生成一段 mcpServers 配置，里面的令牌就是这一行自己的；exe 与转发器路径由软件自动填好，直接粘到 Claude Desktop / Cursor 即可。',
  '安装版用自带运行时 ClassNest.exe（env 里带 ELECTRON_RUN_AS_NODE=1），源码调试时自动换成 node + 项目里的转发器，都不用手改。',
  '转发器只携带 URL 与令牌，接触不到数据库密钥。',
].join('\n')

// 每次打开都重拉：令牌可能在另一个窗口或上一次会话里变过，别拿旧列表糊弄。
watch(() => props.visible, (v) => {
  if (!v) return
  loadLaunchInfo()
  loadTokens()
}, { immediate: true })

// 从主进程取真实路径；网页预览等没有桥接的场景留空，配置退回占位符。
async function loadLaunchInfo() {
  try {
    if (window.electron?.invoke) {
      launchInfo.value = await window.electron.invoke(INVOKE.GET_MCP_LAUNCH_INFO) || null
    }
  } catch (_) { /* 取不到不影响弹窗其他功能 */ }
}

// 按令牌明文生成客户端配置（每个令牌行各自调，填的就是该行令牌）。
// 主进程给的 exe/转发器路径是 JSON.stringify 输出的，Windows 反斜杠会自动转义成合法 JSON。
function configFor(token) {
  const info = launchInfo.value
  const env = {
    // 用运行期 origin 而不是模块级常量：端口顺延后，旧配置里的地址会连到空处，
    // 每次打开都按当前实际端口生成，用户重新复制一次即可修复。
    CLASSNEST_MCP_URL: `${backendOrigin()}/mcp`,
    CLASSNEST_MCP_TOKEN: token || '<令牌>',
  }
  // 端口发现文件：有了它，即使以后端口顺延，已配好的客户端也能自己找到新端口，
  // 不用再回来重配。老版本没有这个字段，转发器会退化为猜常见目录。
  if (info && info.runtimeFilePath) env.CLASSNEST_RUNTIME_FILE = info.runtimeFilePath
  const server = info
    ? {
        command: info.command,
        args: [info.forwarderPath],
        env: info.useElectronAsNode ? { ELECTRON_RUN_AS_NODE: '1', ...env } : env,
      }
    : {
        command: '<安装目录>/ClassNest.exe',
        args: ['<安装目录>/resources/app.asar.unpacked/student-backend/mcp-forwarder.cjs'],
        env: { ELECTRON_RUN_AS_NODE: '1', ...env },
      }
  return JSON.stringify({ mcpServers: { classnest: server } }, null, 2)
}

// 到期时间：无 expires_at 的令牌（老令牌 / 选了不过期）不会过期。
function expiryMs(t) {
  const ms = t.expires_at ? Date.parse(t.expires_at) : NaN
  return Number.isNaN(ms) ? null : ms
}
function isExpired(t) {
  const ms = expiryMs(t)
  return ms !== null && ms <= Date.now()
}
// 有效期文案放在原来「已失效」的位置：有到期日显示日期（过期补标注），没有则长期有效。
function expiryText(t) {
  const ms = expiryMs(t)
  if (ms === null) return '长期有效'
  const day = formatDate(new Date(ms))
  return isExpired(t) ? `${day} 已过期` : `有效期至 ${day}`
}

function close() { emit('close') }

async function loadTokens() {
  loading.value = true
  try {
    const r = await axios.get('/api/mcp/tokens')
    tokens.value = r.data.tokens || []
  } catch (_) { /* 读不到就留空列表，不阻断新增 */ }
  finally { loading.value = false }
}

// 增删成功后同步面板摘要
function changed() { emit('changed') }

// 弹窗自己完成创建，这里只负责成功后刷新列表并提示。
async function onCreated() {
  try {
    await loadTokens()
    changed()
    notify.success('令牌已生成，点该行的「复制配置」即可')
  } catch (_) { /* 创建已成功，列表刷新失败交给下次打开时重拉 */ }
}
// 复制某一行的配置：先取该令牌明文，再生成填好令牌的 mcpServers 配置
async function copyConfig(id) {
  try {
    const r = await axios.get(`/api/mcp/tokens/${encodeURIComponent(id)}/plain`)
    await copy(configFor(r.data.token))
    notify.success('配置已复制')
  } catch (e) { notify.error('复制配置失败：' + (e.response?.data?.error || e.message)) }
}
async function copyPlain(id) {
  try {
    const r = await axios.get(`/api/mcp/tokens/${encodeURIComponent(id)}/plain`)
    await copy(r.data.token)
    notify.success('令牌已复制')
  } catch (e) { notify.error('复制失败：' + (e.response?.data?.error || e.message)) }
}
async function revoke(id) {
  busy.value = true
  try {
    await axios.post(`/api/mcp/tokens/${encodeURIComponent(id)}/revoke`, {})
    await loadTokens()
    changed()
    notify.success('配置已删除，该令牌立即失效')
  } catch (e) { notify.error('删除失败：' + (e.response?.data?.error || e.message)) }
  finally { busy.value = false }
}
// 去除记录：先确认再彻底删，后端只接受已失效的令牌。
async function doRemove() {
  const t = removeTarget.value
  if (!t) return
  removeTarget.value = null
  busy.value = true
  try {
    await axios.post(`/api/mcp/tokens/${encodeURIComponent(t.id)}/remove`, {})
    await loadTokens()
    changed()
    notify.success('记录已去除')
  } catch (e) { notify.error('去除记录失败：' + (e.response?.data?.error || e.message)) }
  finally { busy.value = false }
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); } catch (_) { /* 剪贴板不可用时用户可手动选中 */ }
}
</script>

<style scoped>
/* 高度封顶：令牌多了列表内部滚动，弹窗本身不撑破屏幕 */
.mcp-dialog { width: min(34rem, 92vw); max-height: min(78vh, 640px); }
</style>
