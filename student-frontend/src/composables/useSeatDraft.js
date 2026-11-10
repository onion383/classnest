import { reactive } from 'vue'
import axios from 'axios'

const API_BASE = '/api'

// 全局共享的「智能排表草稿」状态（与 useNotification 同风格：模块级单例，所有调用者共用一份）。
// 启动时 App 拉一次用于弹提示，智能排表弹窗打开时按 exists 决定是否恢复预览。
//
// 口径：与座位表完全一致 —— seats 是**网格矩阵**（含走廊列，走廊/空位格恒 null），
// cols 是网格总列数，types 是 rows×cols 的格子类型矩阵。
// 恢复草稿后走廊位置必须和排表时看到的一样，所以 types 跟 seats 一起存、一起取；
// 早先「draft 对外暴露 dense、存取时转换」的那层换算已随异形网格改造删除。
const draft = reactive({
  loaded: false,
  exists: false,
  rows: 6,
  cols: 7,
  mode: 'single',
  types: [],
  seats: [],
  conditions: [],
  savedAt: ''
})

export function useSeatDraft() {
  // 拉取草稿；未登录或后端未就绪时静默降级为「没有草稿」，不打扰用户
  async function fetchDraft() {
    try {
      const res = await axios.get(`${API_BASE}/seats/draft`)
      draft.exists = !!res.data.exists
      if (draft.exists) {
        draft.rows = res.data.rows
        draft.cols = res.data.cols
        draft.mode = res.data.mode || 'single'
        draft.types = res.data.types || []
        draft.seats = res.data.seats || []
        draft.conditions = res.data.conditions || []
        draft.savedAt = res.data.savedAt || ''
      }
    } catch (_) {
      draft.exists = false
    }
    draft.loaded = true
    return draft
  }

  // 保存草稿：seats 为网格二维数组（学生 id / 新同学名字 / null），cols 为网格总列数，
  // types 为格子类型矩阵。几何由调用方（智能排表弹窗）给出，本函数不做任何换算。
  async function saveDraft({ seats, conditions, rows, cols, mode, types }) {
    const res = await axios.put(`${API_BASE}/seats/draft`, {
      rows,
      cols,
      seats,
      mode,
      types,
      aisleCols: [],
      settings: {},
      conditions: conditions || []
    })
    draft.exists = true
    draft.rows = rows
    draft.cols = cols
    draft.mode = mode || 'single'
    draft.types = types || []
    draft.seats = seats
    draft.conditions = conditions || []
    draft.savedAt = res.data.savedAt || ''
    draft.loaded = true
    return res.data
  }

  // 清除草稿（「确定」应用座位表后调用）；清除失败不影响应用结果
  async function clearDraft() {
    try {
      await axios.delete(`${API_BASE}/seats/draft`)
    } catch (_) {}
    draft.exists = false
    draft.seats = []
    draft.conditions = []
    draft.savedAt = ''
  }

  return { draft, fetchDraft, saveDraft, clearDraft }
}
