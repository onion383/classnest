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
import { createLatest } from '../utils/latestOnly.js'

const EMPTY_SUMMARY = { days: 7, total: 0, denied: 0, failed: 0, writes: 0, pending: 0 }
const DEFAULT_CONFIG = { keep: 500, granularity: 'per_call' }

export function useAccessLog(source) {
  const logs = ref([])
  // total：当前来源视图的条数（「已记 N 条」）。retentionTotal：全表原始条数 ——
  // 保留条数是全局设置（AI 与 MCP 共用一张表），改小 keep 会不会丢历史要按它判断。
  const total = ref(0)
  const retentionTotal = ref(0)
  const summary = ref({ ...EMPTY_SUMMARY })
  const config = ref({ ...DEFAULT_CONFIG })
  const loading = ref(false)
  const error = ref('')
  const loaded = ref(false)
  // load / loadSummary / clear 共用一个代次：面板先拉摘要、弹窗再拉全量，
  // 旧回包不能覆盖新结果，清空后也不允许在途 load 把已清记录写回（F04-06）。
  const seq = createLatest()

  async function load(opts = {}) {
    const my = seq.begin()
    loading.value = true
    error.value = ''
    try {
      const r = await axios.get('/api/access-log', { params: { source, ...opts } })
      if (!seq.isCurrent(my)) return
      logs.value = Array.isArray(r.data.logs) ? r.data.logs : []
      total.value = r.data.total || 0
      retentionTotal.value = r.data.retentionTotal ?? total.value
      summary.value = r.data.summary || { ...EMPTY_SUMMARY }
      if (r.data.config) config.value = { ...DEFAULT_CONFIG, ...r.data.config }
      loaded.value = true
    } catch (e) {
      if (!seq.isCurrent(my)) return
      error.value = e.response?.data?.error || e.message
    } finally {
      if (seq.isCurrent(my)) loading.value = false
    }
  }

  // 只取摘要与配置：面板刚渲染时用，不必把 100 条记录拖回来
  async function loadSummary() {
    const my = seq.begin()
    try {
      const r = await axios.get('/api/access-log', { params: { source, limit: 1 } })
      if (!seq.isCurrent(my)) return
      summary.value = r.data.summary || { ...EMPTY_SUMMARY }
      if (r.data.config) config.value = { ...DEFAULT_CONFIG, ...r.data.config }
    } catch (_) { // best-effort: 摘要读不到保持暂无记录，点开弹窗会重拉

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
    // 先作废在途 load：清空后旧响应不能再把已清记录写回
    seq.invalidate()
    try {
      const r = await axios.delete('/api/access-log', { params: { source } })
      logs.value = []
      total.value = 0
      retentionTotal.value = 0
      summary.value = { ...EMPTY_SUMMARY, days: summary.value.days }
      return r.data.removed || 0
    } catch (e) {
      error.value = e.response?.data?.error || e.message
      return 0
    }
  }

  return {
    logs, total, retentionTotal, summary, config, loading, error, loaded,
    load, loadSummary, saveConfig, clear,
  }
}
