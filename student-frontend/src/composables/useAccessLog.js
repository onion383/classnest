// useAccessLog.js —— 「数据访问记录」的唯一前端实现
//
// 两个入口共用这一个组合式，只传 source（ai / mcp）：
//   AI 数据保护弹窗底部  → useAccessLog('ai')
//   MCP 服务管理第 4 行  → useAccessLog('mcp')
// 面板只要行尾那句摘要（loadSummary，limit=1 不拉列表），弹窗打开时才全量拉（load）。
//
// 设置（保留条数 / 记录方式）两边共用一份 —— 同一张表，规则不该有两套；
// 在哪里改都会立刻影响另一侧，所以弹窗里标了「AI 与 MCP 共用」。
import { ref } from 'vue'
import axios from 'axios'

const EMPTY_SUMMARY = { days: 7, total: 0, denied: 0, failed: 0, writes: 0, pending: 0 }
const DEFAULT_CONFIG = { keep: 500, granularity: 'per_call' }

export function useAccessLog(source) {
  const logs = ref([])
  const total = ref(0)
  const summary = ref({ ...EMPTY_SUMMARY })
  const config = ref({ ...DEFAULT_CONFIG })
  const loading = ref(false)
  const error = ref('')
  const loaded = ref(false)

  async function load(opts = {}) {
    loading.value = true
    error.value = ''
    try {
      const r = await axios.get('/api/access-log', { params: { source, ...opts } })
      logs.value = Array.isArray(r.data.logs) ? r.data.logs : []
      total.value = r.data.total || 0
      summary.value = r.data.summary || { ...EMPTY_SUMMARY }
      if (r.data.config) config.value = { ...DEFAULT_CONFIG, ...r.data.config }
      loaded.value = true
    } catch (e) {
      error.value = e.response?.data?.error || e.message
    } finally {
      loading.value = false
    }
  }

  // 只取摘要与配置：面板刚渲染时用，不必把 100 条记录拖回来
  async function loadSummary() {
    try {
      const r = await axios.get('/api/access-log', { params: { source, limit: 1 } })
      summary.value = r.data.summary || { ...EMPTY_SUMMARY }
      if (r.data.config) config.value = { ...DEFAULT_CONFIG, ...r.data.config }
    } catch (_) {
      // 摘要读不到就保持「暂无记录」，不阻断面板其余部分（点开弹窗会重拉并报错）
    }
  }

  async function saveConfig(patch) {
    const prev = config.value
    config.value = { ...config.value, ...patch } // 乐观：下拉立即停在新值上
    try {
      const r = await axios.put('/api/access-log/config', patch)
      if (r.data.config) config.value = { ...DEFAULT_CONFIG, ...r.data.config }
      return true
    } catch (e) {
      config.value = prev
      error.value = e.response?.data?.error || e.message
      return false
    }
  }

  async function clear() {
    try {
      const r = await axios.delete('/api/access-log', { params: { source } })
      logs.value = []
      total.value = 0
      summary.value = { ...EMPTY_SUMMARY, days: summary.value.days }
      return r.data.removed || 0
    } catch (e) {
      error.value = e.response?.data?.error || e.message
      return 0
    }
  }

  return { logs, total, summary, config, loading, error, loaded, load, loadSummary, saveConfig, clear }
}
