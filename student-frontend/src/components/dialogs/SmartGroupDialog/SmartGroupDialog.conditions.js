// ===== 智能分组：流水线条件操作 + 拖拽交互 =====
// 纯代码搬运自 SmartGroupDialog.vue 的 methods，未改写逻辑；经 ctx 闭包调用（script setup）。
// ctx 契约：{ stages, satisfaction, rejectText, _dragIdx, _overIdx, _pendingType, _rejectTimer, addStage }
// （状态为 ref，模块内用 .value；临时字段与跨模块方法直接挂在 ctx 上）。
// nextKey 由主组件以参数传入，避免循环依赖。
import { nextTick } from 'vue'
import { clearStudentSelections } from './SmartGroupDialog.pipeline.js'

export function useSmartGroupConditions(ctx, nextKey) {
  return {
    // ==================== 流水线条件操作 ====================
    addStage(type) {
      const s = { key: nextKey() }
      if (type === 'relation') Object.assign(s, { type: 'relation', kind: 'together', a: '', b: '' })
      else if (type === 'identity') Object.assign(s, { type: 'identity', kind: 'leader', studentId: '' })
      else Object.assign(s, { type: 'gender', mode: 'balanced' })
      ctx.stages.value.push(s)
      // 高度从 0 展开：要等这一行渲染出来才量得到高度
      const at = ctx.stages.value.length - 1
      nextTick(() => { if (ctx.sortStage) ctx.sortStage.enterAt(at) })
    },
    // 数据源切换：清空关系条件 a/b 与身份条件 studentId（统一入口）
    resetStudentSelections() {
      clearStudentSelections(ctx.stages.value)
    },
    // 删除条件：先把高度收到 0 再真正移除（否则行「啪」地消失，上下的行也是瞬间补位）
    removeStage(index) {
      const node = ctx.stages.value[index]
      if (!node) return
      const doRemove = () => {
        // 用对象身份重新定位：收起动画这 200ms 里列表可能已被再次修改
        const i = ctx.stages.value.indexOf(node)
        if (i < 0) return
        ctx.stages.value.splice(i, 1)
      }
      if (ctx.sortStage) ctx.sortStage.leaveAt(index, doRemove)
      else doRemove()
    },

    // ==================== 拖拽交互（拖入添加 / 拖动手柄调序） ====================
    // 从下方选项区拖入：记录待添加的条件类型
    onChipDragStart(e, type) {
      ctx._pendingType = type
      ctx._dragIdx = null
      e.dataTransfer.setData('text/plain', 'chip')
      e.dataTransfer.effectAllowed = 'copy'
    },
    // 松开到条件区：处理拖入新条件（行内调序已改指针拖拽，不走这里）
    boxDrop(e) {
      e.preventDefault()
      if (ctx._pendingType) ctx.addStage(ctx._pendingType)
      ctx._pendingType = null
    },
    satisfactionOf(st) {
      const key = st.key
      if (!ctx.satisfaction.value[key]) return null
      const { done, total } = ctx.satisfaction.value[key]
      return total ? Math.round((done / total) * 100) : 0
    },
    trackSatisfaction(key, done, total) {
      if (!ctx.satisfaction.value[key]) ctx.satisfaction.value[key] = { done: 0, total: 0 }
      ctx.satisfaction.value[key].done += done
      ctx.satisfaction.value[key].total += total
    },
    showReject(text) {
      ctx.rejectText.value = text
      clearTimeout(ctx._rejectTimer)
      ctx._rejectTimer = setTimeout(() => { ctx.rejectText.value = '' }, 2500)
    },
  }
}
