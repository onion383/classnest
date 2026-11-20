// =========================================================================
// usePrivacyConfig.js —— 「AI 数据保护」这份配置的唯一前端实现
//
// 为什么抽出来：这份配置（总开关 / 三个混淆项 / 每张表的权限档）有两个编辑
// 入口——AI 助手页的「数据保护」和设置页的「MCP 数据权限」。两处各写一份
// 乐观更新 + 回滚 + 序号守卫，迟早出现「一边滚回去了另一边没滚」的分歧。
//
// 两个入口改的是两份独立配置（scope 参数）：
//   'ai'  → ai_settings.privacy_json      本地助手（老师自己用）
//   'mcp' → ai_settings.mcp_privacy_json  外部客户端（给别人的 AI 用）
// 逻辑同一套，存哪儿不同——所以这里只多一个 scope，不复制第二份实现。
//
// 归口：
//   - 读写与回滚：本文件（update / setLevel）
//   - 档位判定：本文件的 levelOf / writableOf（纯函数，面板只负责渲染）
//   - 文案与排版：各自的面板组件
// =========================================================================
import { ref } from 'vue'
import axios from 'axios'
import { useNotification } from './useNotification.js'

const LEVELS = ['none', 'read', 'write']

// 这张表能不能被 AI 写：由后端 writable 决定。
// 拿不到该字段（后端进程还是旧的，接口没带 level/writable）时按「可写」算 ——
// 那时默认档就是改造前的行为，比让整列停在「请选择」这种空态强。
export function writableOf(t) {
  return t.writable !== false
}

// 每张表必然有一档，「未选择」不是合法状态。
// 所以 level 缺失时按能力退回默认档：能写=读写、不能写=只读，下拉不会出现占位文案。
export function levelOf(t) {
  const lv = t.level
  if (LEVELS.includes(lv)) return lv
  return writableOf(t) ? 'write' : 'read'
}

export function usePrivacyConfig(scope = 'ai') {
  const notify = useNotification()
  // 两种 scope 各一个端点：写错端点等于在别人的配置上动手，所以只在这里拼死
  const url = scope === 'mcp' ? '/api/mcp/privacy' : '/api/ai/privacy'
  const error = ref('')
  const cfg = ref({
    enabled: false,
    hide_phone: true,
    hide_path: true,
    hide_album: true,
    closed_tables: [],
    readonly_tables: [],
    tables: [],
  })

  // 同一个字段的请求排队序号：回包只认「最后一次」的，避免快速连点时旧响应把新值盖回去
  const seqByKey = new Map()
  function nextSeq(key) {
    const n = (seqByKey.get(key) || 0) + 1
    seqByKey.set(key, n)
    return n
  }

  function patchTable(key, patch) {
    cfg.value = {
      ...cfg.value,
      tables: (cfg.value.tables || []).map((t) => (t.key === key ? { ...t, ...patch } : t)),
    }
  }

  async function load() {
    try {
      const r = await axios.get(url)
      if (r.data && r.data.success) cfg.value = { ...cfg.value, ...(r.data.data || {}) }
    } catch (e) {
      error.value = '读取设置失败：' + (e.response?.data?.error || e.message)
    }
  }

  // 开关类字段（总开关 + 三个混淆项）：先改本地再发请求。
  // 不这么做的话，「等接口回包才更新状态」的写法会在等待期间被重渲染按回旧值，勾选框会闪一下再跳回来。
  async function update(key, value) {
    const seq = nextSeq(key)
    const prev = cfg.value[key]
    error.value = ''
    cfg.value = { ...cfg.value, [key]: value }
    try {
      const r = await axios.put(url, { [key]: value })
      if (seqByKey.get(key) !== seq) return // 已有更新的一次请求在飞，丢弃这次回包
      if (r.data && r.data.success) cfg.value = { ...cfg.value, ...(r.data.data || {}) }
    } catch (e) {
      if (seqByKey.get(key) !== seq) return
      cfg.value = { ...cfg.value, [key]: prev }
      error.value = '保存失败：' + (e.response?.data?.error || e.message)
      notify.error(error.value)
    }
  }

  // 单表权限档：同样先改本地（下拉立刻显示新档位），失败再退回并提示
  async function setLevel(t, level) {
    const cur = levelOf(t)
    if (!level || level === cur) return
    const key = 'table:' + t.key
    const seq = nextSeq(key)
    const prev = cur
    error.value = ''
    patchTable(t.key, { level })
    try {
      const r = await axios.put(url, { table: t.key, level })
      if (seqByKey.get(key) !== seq) return
      if (r.data && r.data.success) cfg.value = { ...cfg.value, ...(r.data.data || {}) }
    } catch (e) {
      if (seqByKey.get(key) !== seq) return
      patchTable(t.key, { level: prev })
      error.value = '保存失败：' + (e.response?.data?.error || e.message)
      notify.error(error.value)
    }
  }

  return { cfg, error, load, update, setLevel }
}
