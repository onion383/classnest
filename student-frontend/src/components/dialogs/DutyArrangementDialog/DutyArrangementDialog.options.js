// ===== 值日智能排表：一级条件的拖拽添加/删除 + 语义句 + 草稿 =====
// 移除了「方式 → 子约束」的二级结构：条件一行一条、可重复添加，按顺序执行。
// ctx 契约：{ conditions, nextUid, arranged, rejectText, previewCells, _rejectTimer, emit ... }

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
    },
    removeCondition(index) {
      const node = ctx.conditions.value[index]
      if (!node) return
      ctx.conditions.value.splice(index, 1)
      ctx.resetArranged()
    },
    // 取某条件的语义句段（纯文案 + 下拉位），供通用渲染器产出 UI
    segmentsOf(node) {
      const reg = REGISTRY[node.key]
      if (!reg || !reg.segments) return []
      return reg.segments.map((s, idx) => s.t === 'text'
        ? { ...s, idx }
        : { ...s, idx, options: ctx.resolveOptions(s.options, node) })
    },
    resolveOptions(kind, node) {
      switch (kind) {
        case 'scopes': return ctx.scopeOptions()
        case 'units': return ctx.unitOptions()
        case 'actions': return ctx.actionOptions(node)
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
    actionOptions(node) {
      if (node.key === 'random') {
        return [
          { value: 'random', label: '随机排布' },
          { value: 'shift', label: '平移排布' },
        ]
      }
      return [
        { value: 'pack', label: '分组填充' },
        { value: 'shift', label: '平移排布' },
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

    // ==================== 开始排表 / 确认 / 草稿 ====================
    // 总槽位 = 值日天数 × Σ 每个项目人数
    totalSlots() {
      const perDay = ctx.itemsArr.value.reduce((t, it) => t + Math.max(1, Number(it.count) || 1), 0)
      return ctx.daysArr.value.length * perDay
    },
    needsSlotWarning() {
      const total = ctx.totalSlots()
      if (total <= 0) return false
      // 「全部同学」：槽位 < 全班人数 → 部分同学排不上值日
      if (ctx.dataSource.value === 'all') return total < ctx.studentNames.value.length
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
