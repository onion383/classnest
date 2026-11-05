// ===== 值日智能排表：分组维度（分组管理接口） =====
// 纯代码搬运自 DutyArrangementDialog.vue 的 methods，未改写逻辑；经 ctx 闭包调用（script setup）。
// ctx 契约：{ dimensions, groups, selectedDimId, arranged, rejectText, showReject 等 }。
import axios from 'axios'

const API_BASE = '/api'

export function useDutyArrangementDimension(ctx) {
  return {
    // ==================== 分组维度（分组管理接口） ====================
    async fetchDimensions() {
      try {
        const res = await axios.get(`${API_BASE}/group-manage/bootstrap`)
        ctx.dimensions.value = res.data.dimensions || []
        const active = res.data.active
        ctx.groups.value = (active && active.groups) || []
        ctx.selectedDimId.value = active ? String(active.dimension.id) : ''
      } catch (e) {
        console.error(e);
        ctx.rejectText.value = '加载分组维度失败';
        // 必须调 showReject()：它负责起 2500ms 的清除定时器。
        // 只写 rejectText 不调它 → 提示条永远留着，用户关不掉（其他 reject 分支都成对调用了这两步）。
        ctx.showReject();
      }
    },
    async onDimensionChange(id) {
      ctx.selectedDimId.value = id
      ctx.loadDimensionGroups(id)
    },
    async loadDimensionGroups(dimId) {
      if (!dimId) return
      try {
        const res = await axios.get(`${API_BASE}/group-manage/${dimId}`)
        ctx.groups.value = (res.data && res.data.groups) || []
        ctx.arranged.value = false
      } catch (e) { console.error(e) }
    },
    // 当前选中维度各组成员（姓名数组）
    groupBuckets() {
      return ctx.groups.value.map(g => (g.members || []).map(m => String(m.member_name || '').trim()).filter(Boolean))
    },
  }
}
