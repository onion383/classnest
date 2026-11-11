// ===== 值日智能排表：一级条件的拖拽添加/删除 + 语义句 + 草稿 =====
// 移除了「方式 → 子约束」的二级结构：条件一行一条、可重复添加，按顺序执行。
// ctx 契约：{ conditions, nextUid, arranged, rejectText, previewCells, _rejectTimer, emit, sortCond ... }

import { nextTick } from 'vue'

export function useDutyArrangementOptions(ctx, REGISTRY) {
  return {
    // ==================== 拖拽交互 ====================
    onOptionDragStart(e, key) {
      e.dataTransfer.setData('text/plain', key)
      e.dataTransfer.setData('text/drag-kind', 'option')
      e.dataTransfer.effectAllowed = 'copy'
    },
    onDropZone(e) {
      ctx.handleDrop(e, ctx.conditions.value.length)
    },
    onDropOnRow(e, index) {
      ctx.handleDrop(e, index)
    },
    handleDrop(e, index) {
      const key = e.dataTransfer.getData('text/plain')
      if (key && REGISTRY[key]) ctx.addCondition(key, index)
    },
    // 添加条件：同类型可重复，不限数量
    addCondition(key, index) {
      const reg = REGISTRY[key]
      if (!reg) return
      const node = { uid: ctx.nextUid.value++, key, label: reg.label, ...(reg.defaults ? reg.defaults() : {}) }
      const at = Math.max(0, Math.min(index, ctx.conditions.value.length))
      ctx.conditions.value.splice(at, 0, node)
      ctx.resetArranged()
      // 高度从 0 展开 + 滚进视野（列表限高时新行可能落在可视区外）：
      // 必须等这一行渲染出来才量得到高度
      nextTick(() => { if (ctx.sortCond) ctx.sortCond.enterAt(at) })
    },
    // 删除条件：先把高度收到 0 再真正移除（否则行「啪」地消失，上下的行也是瞬间补位）
    removeCondition(index) {
      const node = ctx.conditions.value[index]
      if (!node) return
      const doRemove = () => {
        // 用对象身份重新定位：收起动画这 200ms 里列表可能已被再次修改
        const i = ctx.conditions.value.indexOf(node)
        if (i < 0) return
        ctx.conditions.value.splice(i, 1)
        ctx.resetArranged()
      }
      if (ctx.sortCond) ctx.sortCond.leaveAt(index, doRemove)
      else doRemove()
    },
    // 取某条件的语义句段（纯文案 + 下拉位），供通用渲染器产出 UI
    segmentsOf(node) {
      const reg = REGISTRY[node.key]
      if (!reg || !reg.segments) return []
      const big = ctx.bigCleanup.value
      // when: 日常只显示「在同一天值日」，大扫除才显示三档装箱轴（避免单选项下拉）
      // inner: 「同区域且同项目」时整组在同一格，格内只有 count 个位置，
      //        内部排布只换姓名先后、不改变任何安排，故隐藏这一段
      const segs = reg.segments.filter(s => {
        if (s.when === 'big' && !big) return false
        if (s.when === 'daily' && big) return false
        if (s.inner && node.axis === 'cell') return false
        return true
      })
      return segs.map((s, idx) => s.t === 'text'
        ? { ...s, idx }
        : { ...s, idx, options: ctx.resolveOptions(s.options) })
    },
    resolveOptions(kind) {
      switch (kind) {
        case 'scopes': return ctx.scopeOptions()
        case 'units': return ctx.unitOptions()
        case 'groups': return ctx.groupOptions()
        case 'axes': return ctx.axisOptions()
        case 'directions': return ctx.directionOptions()
        case 'innerArranges': return ctx.innerArrangeOptions()
        case 'relationTypes': return ctx.relationOptions()
        case 'laborActions': return ctx.laborActionOptions()
        case 'innerOrder': return ctx.innerOrderOptions()
        case 'students': return ctx.studentOptions.value
        case 'items': return ctx.itemOptions.value
        default: return []
      }
    },
    getField(node, path) {
      return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), node)
    },
    setField(node, path, value) {
      const ks = path.split('.')
      let o = node
      for (let i = 0; i < ks.length - 1; i++) {
        if (o[ks[i]] == null) o[ks[i]] = {}
        o = o[ks[i]]
      }
      o[ks[ks.length - 1]] = value
    },

    // ==================== 选项列表 ====================
    // 作用域：全部日期 / 每一天 / 座位表抽取的学生分组
    scopeOptions() {
      return [
        { value: 'all', label: '全部' },
        { value: 'day', label: '一天' },
        { value: 'student', label: '同学' },
        { value: 'deskmate', label: '同桌' },
        { value: 'four', label: '相邻四位' },
        { value: 'six', label: '相邻六位' },
        { value: 'column', label: '一列' },
        { value: 'bigroup', label: '一大组' },
        { value: 'dorm', label: '宿舍组' },
      ]
    },
    // 操作单元：座位表分组 + 一天（整天名单作为一块）
    unitOptions() {
      return [
        { value: 'student', label: '同学' },
        { value: 'deskmate', label: '同桌' },
        { value: 'four', label: '相邻四位' },
        { value: 'six', label: '相邻六位' },
        { value: 'column', label: '一列' },
        { value: 'bigroup', label: '一大组' },
        { value: 'dorm', label: '宿舍组' },
        { value: 'day', label: '一天' },
      ]
    },
    // 「随机分组」专用：不含「一天」——装箱目标就是「同一天」，再以一天为单元没有语义
    groupOptions() {
      return [
        { value: 'student', label: '同学' },
        { value: 'deskmate', label: '同桌' },
        { value: 'four', label: '相邻四位' },
        { value: 'six', label: '相邻六位' },
        { value: 'column', label: '一列' },
        { value: 'bigroup', label: '一大组' },
        { value: 'dorm', label: '宿舍组' },
      ]
    },
    // 顺序选项的铺设方向：lr/rl 行优先，tb/bt 列优先；反向只反转行内 / 列内
    directionOptions() {
      return [
        { value: 'lr', label: '从左往右' },
        { value: 'rl', label: '从右往左' },
        { value: 'tb', label: '从上往下' },
        { value: 'bt', label: '从下往上' },
      ]
    },
    // 装箱轴：日常值日按「天」；大扫除按工作区域（列）/ 劳动项目（行）/ 具体格子
    axisOptions() {
      if (!ctx.bigCleanup.value) return []
      return [
        { value: 'column', label: '同一个工作区域' },
        { value: 'row', label: '同一个劳动项目' },
        { value: 'cell', label: '同区域且同项目' },
      ]
    },
    relationOptions() {
      return [
        { value: 'same', label: '在同一天值日' },
        { value: 'different', label: '不在同一天值日' },
      ]
    },
    laborActionOptions() {
      return [
        { value: 'do', label: '一定做' },
        { value: 'not', label: '不做' },
      ]
    },
    innerOrderOptions() {
      return [
        { value: 'no', label: '不可以' },
        { value: 'yes', label: '可以' },
      ]
    },
    // 同一天内人名落到具体值日槽位的方式。与 fair 的 innerOrder（可否调整组内顺序）不是一回事，
    // 故另起字段；只改天内顺序，不改变装箱结果（谁在哪一天）。
    innerArrangeOptions() {
      return [
        { value: 'default', label: '默认排布' },
        { value: 'random', label: '随机排布' },
      ]
    },

    // ==================== 开始排表 / 确认 / 草稿 ====================
    // 总槽位 = 值日天数 × Σ 每个项目人数
    totalSlots() {
      const perDay = ctx.itemsArr.value.reduce((t, it) => t + Math.max(1, Number(it.count) || 1), 0)
      return ctx.daysArr.value.length * perDay
    },
    // 参与人数与总槽位的差额（> 0 表示有人排不进表）。
    // 确认框文案与 needsSlotWarning 都读它，别再各写一遍筛选条件。
    shortageCount() {
      return Math.max(0, ctx.poolNames.value.length - ctx.totalSlots())
    },
    needsSlotWarning() {
      const total = ctx.totalSlots()
      if (total <= 0) return false
      // 人数 > 槽位：有人排不进表，X 由 shortageCount 单源给出
      if (ctx.shortageCount() > 0) return true
      if (ctx.dataSource.value === 'all') return false
      // 「现有排表表格」：槽位 > 表里已排的人次 → 有人要重复值日（方向与上面相反）
      return total > ctx.tableFilled.value
    },
    startArrange() {
      // 人数不够时先确认一次，避免用户以为算法漏人
      if (ctx.needsSlotWarning()) {
        ctx.slotWarningVisible.value = true
        return
      }
      ctx.doStart()
    },
    doStart() {
      // 「现有排表表格」但表里没人 → 没有可排的人：直接说明原因，不弹人数确认框
      if (ctx.dataSource.value === 'table' && !ctx.poolNames.value.length) {
        ctx.rejectText.value = '当前值日表里没有学生，无法排表；请改选「全部同学」'
        ctx.showReject()
        return
      }
      // 座位分组条件依赖当前座位表；没有座位表时提示会跳过
      const usesSeat = ctx.conditions.value.some(c =>
        ['deskmate', 'four', 'six', 'column', 'bigroup'].includes(c.scope) ||
        ['deskmate', 'four', 'six', 'column', 'bigroup'].includes(c.unit))
      if (usesSeat && !((ctx.seat.value?.seats) || []).length) {
        ctx.rejectText.value = '未读取到座位表，座位分组条件会被跳过；可改用「同学 / 一天」'
        ctx.showReject()
      }
      ctx.generatePreview()
      const cells = ctx.previewCells.value
      const hasAny = !!cells && Object.values(cells).some(days => (
        days && Object.values(days).some(names => Array.isArray(names) && names.length)
      ))
      ctx.arranged.value = hasAny
      if (!hasAny) {
        ctx.rejectText.value = '当前条件下没有可安排的值日，请检查人数与项目设置'
        ctx.showReject()
      }
    },
    proceedStart() {
      ctx.slotWarningVisible.value = false
      ctx.doStart()
    },
    openSettingsFromWarning() {
      ctx.slotWarningVisible.value = false
      ctx.emit('open-settings')
    },
    resetArranged() {
      ctx.arranged.value = false
      ctx.resetPreview()
    },
    confirm() {
      ctx.emit('confirm', { cells: ctx.previewCells.value })
    },
    onSaveDraft() {
      ctx.emit('save-draft', {
        cells: ctx.previewCells.value,
        conditions: ctx.conditions.value.map(c => {
          const copy = { ...c }
          delete copy.uid
          delete copy.label
          return copy
        }),
      })
    },
    onClearDraft() {
      ctx.emit('clear-draft')
    },
    showReject() {
      clearTimeout(ctx._rejectTimer)
      ctx._rejectTimer = setTimeout(() => { ctx.rejectText.value = '' }, 2500)
    },
    rejectOnce() {
      ctx.rejectText.value = ''
    },
  }
}
