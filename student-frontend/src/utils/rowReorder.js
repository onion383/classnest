// ===== 表格行拖拽的落位计算（v7 §5-6 / #37）=====
//
// 病根：DynamicTable 抛给父级的 from/to 是**可见列表**下标（搜索过滤 + 排序后的顺序），
// 父级拿它去 splice 完整数组就是错位。例：完整顺序 [匹配行A, 隐藏行X, 匹配行B]，
// 可见列表只有 [A,B]；把 B 拖到 A 前 → 表格抛 1→0 → 旧实现真把 X 挪到最前，
// 既没重排用户拖的那一行，还改了用户看不见的行。
//
// 这里改成「按行对象定位」：displayRows 复用 rows 里的同一批对象引用，
// 所以 indexOf 能精确找到完整数组中的位置。落位语义保持「被拖行占据落点行的位置，
// 其余顺移」，与改造前一致。
//
// 纯函数、不依赖 Vue：单测直接跑真实源码。

/** 单个行：把 fromIndex 那行挪到 toIndex 那行的位置。返回新数组；无法定位时返回 null。 */
export function moveRowByAnchor(fullRows, displayRows, fromIndex, toIndex) {
  const movedRow = displayRows[fromIndex]
  const anchorRow = displayRows[toIndex]
  if (!movedRow || !anchorRow || movedRow._isNew) return null
  const records = [...fullRows]
  const from = records.indexOf(movedRow)
  if (from < 0) return null
  const [moved] = records.splice(from, 1)
  // 删除被移动行后，落点行可能在原位（向上拖）或前移一位（向下拖）
  const anchorAt = records.indexOf(anchorRow)
  if (anchorAt < 0) return null
  records.splice(from < anchorAt + 1 ? anchorAt + 1 : anchorAt, 0, moved)
  return records
}

/** 多选行：把 selectedKeys 整批挪到 newIndex 那行之前/之后。返回新数组；无法定位时返回 null。 */
export function moveRowsByAnchor(fullRows, displayRows, selectedKeys, newIndex, isDownward) {
  const records = [...fullRows]
  const selectedRows = (selectedKeys || [])
    .map((key) => records.find((r) => r.id === key || r._rowKey === key))
    .filter((r) => r && !r._isNew)
  if (!selectedRows.length) return null
  const selectedIds = selectedRows.map((r) => r.id)
  const otherRows = records.filter((r) => !selectedIds.includes(r.id))
  // 落点行必须在「去掉被移动行之后」的数组里定位：被移动行本身可能就在落点附近
  const anchorRow = displayRows[newIndex]
  const anchor = anchorRow ? otherRows.indexOf(anchorRow) : -1
  const insertIdx = anchor >= 0 ? (isDownward ? anchor + 1 : anchor) : otherRows.length
  otherRows.splice(insertIdx, 0, ...selectedRows)
  return otherRows
}
