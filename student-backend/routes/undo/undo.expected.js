// =========================================================================
// undo.expected.js —— 撤销前的「期望状态」快照校验
//
// 为什么需要：撤销记录存的是每一步的整行前后快照。若跳过中间记录去撤旧记录
// （例如 A 新增 → B MCP 改名 → 手改 → C 助手再改，却直接撤 B），执行器会
// 盲目把 B 的 oldRow 整行回写，把手改/C 的改动无声吞掉。
// 本模块在 flip 抢占方向之前，先确认「当前数据仍是这条记录写入后留下的样子」，
// 不一致就拒绝，提示用户先撤后面的。
//
// 覆盖面（Q2-02/Q2-04/Q2-05 收敛后）：
//   · 行式 row_insert / row_update / row_delete：整行快照比对；
//   · 格子类 cell_update / grid_cell / duty_cell：执行器自带 currentValue，
//     当前值必须等于这一步写入后的值（undo 比 newValue、redo 比 oldValue）；
//   · 复合回插类：撤销前检查显式 id 是否已被新数据占用（占用则业务化拒绝，
//     而不是让 INSERT 主键冲突抛成通用失败）。
// =========================================================================

const undoStore = require('../../services/undoStore')
const { executors } = require('./undo.executors')

const ROW_TYPES = new Set(['row_insert', 'row_update', 'row_delete'])

// 归一化后比较：规避 number 90 与 string '90'、null 与 undefined 的假差异。
function norm(v) {
  if (v == null) return null
  if (typeof v === 'object') {
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  return String(v)
}

// 格子值比较：空格子可能是 null / undefined / ''，三者都视为「空」。
function normCell(v) {
  if (v == null) return ''
  if (typeof v !== 'object') return String(v)
  try { return JSON.stringify(v) } catch { return String(v) }
}

// 快照字段与当前行逐字段比对。只比「快照里有、当前行也有」的键：
//   · 前端 row 对象会带 _rowKey/_isNew 等内部字段 —— 当前行没有它们，跳过；
//   · 老快照可能缺列 —— 剩下的键仍比，全缺则放行（残缺快照不误杀）。
function matchSnapshot(current, snapshot) {
  if (!current || !snapshot || typeof snapshot !== 'object') return false
  const keys = Object.keys(snapshot).filter((k) => Object.prototype.hasOwnProperty.call(current, k))
  if (!keys.length) return true
  return keys.every((k) => norm(current[k]) === norm(snapshot[k]))
}

// 格子类：当前值必须仍是这条记录写入后留下的值。
// 过去这段只在 undoCellOnly 里做，其余入口（/:id/undo、rewind、origin 批次）直接翻方向，
// 旧值静默覆盖后续手改（Q2-02）；redo 同理（Q2-05）。
function checkCellCurrent(rec, mode) {
  const ex = rec && executors[rec.type]
  if (!ex || typeof ex.currentValue !== 'function') return null
  const p = rec.payload || {}
  // 只处理「单值」载荷；整块快照没有 newValue/oldValue，走各自的校验。
  if (!Object.prototype.hasOwnProperty.call(p, 'newValue') && !Object.prototype.hasOwnProperty.call(p, 'oldValue')) return null
  const expect = mode === 'undo' ? p.newValue : p.oldValue
  let cur
  try { cur = ex.currentValue(p) } catch { return null }
  if (normCell(cur) === normCell(expect)) return null
  return mode === 'undo'
    ? '这一格之后又被改过，请从最新的一条开始退'
    : '这一格之后又被改过，无法重做，请先撤销后面的改动'
}

// 复合回插类：按显式 id 把旧对象写回去。id 已被新数据占用时，
// 要么主键冲突整批失败、要么与后补数据叠加 —— 统一提前拒绝并说清原因（Q2-04）。
// 方向：删除类在 undo 插回时检查（undo）；导入类在 redo 按原 id 重建时检查（redo）。
// group_snapshot / cadre_order 是整块重建、无显式 id 回插冲突，不加预检（加了会误杀）。
function checkCompositeUndo(rec, mode) {
  const p = rec.payload || {}
  const exists = (table, id) => Number.isInteger(id) && !!undoStore.findRowById(table, id)
  const undoing = mode === 'undo'
  if (undoing && rec.type === 'student_cascade_delete') {
    const sid = p.student && p.student.id
    if (exists('students', sid)) return '该学生已被重新创建，无法撤销本次删除'
  } else if (undoing && rec.type === 'rows_batch_delete') {
    const hit = (p.rows || []).find((r) => r && exists(p.table, r.id))
    if (hit) return `记录 id=${hit.id} 已被重新创建，无法撤销本次删除`
  } else if (undoing && rec.type === 'cadre_delete') {
    if (exists('cadres', p.node && p.node.id)) return '该职务已被重新创建，无法撤销本次删除'
  } else if (undoing && rec.type === 'group_dimension_delete') {
    if (exists('group_dimensions', p.dimension && p.dimension.id)) return '该分组维度已被重新创建，无法撤销本次删除'
  } else if (undoing && rec.type === 'album_delete') {
    if (exists('albums', p.album && p.album.id)) return '该相册已被重新创建，无法撤销本次删除'
  } else if (undoing && rec.type === 'album_merge') {
    const hit = (p.sources || []).find((s) => s && s.album && exists('albums', s.album.id))
    if (hit) return `相册「${hit.album.name || hit.album.id}」已被重新创建，无法撤销本次合并`
  } else if (!undoing && rec.type === 'rows_batch_insert') {
    // redo 按原 id 整批插回；id 已被新记录占用时拒绝，避免主键冲突整批失败。
    const hit = (p.rows || []).find((r) => r && exists(p.table, r.id))
    if (hit) return `记录 id=${hit.id} 已被重新创建，无法重做本次导入`
  } else if (!undoing && rec.type === 'cadre_import') {
    const hit = (p.cadres || []).find((c) => c && exists('cadres', c.id))
      || (p.members || []).find((m) => m && exists('cadre_members', m.id))
    if (hit) return `职务/成员 id=${hit.id} 已被重新创建，无法重做本次导入`
  }
  return null
}

// 返回 null 表示通过；返回字符串表示拒绝原因。
function checkExpected(rec, mode) {
  const type = rec && rec.type
  if (!type) return null
  const cellErr = checkCellCurrent(rec, mode)
  if (cellErr) return cellErr
  if (!ROW_TYPES.has(type)) return checkCompositeUndo(rec, mode)

  const p = rec.payload || {}
  const table = p.table
  if (!table) return null // validate 已挡掉缺表参数，这里保守放行
  const rowId = p.rowId != null ? p.rowId : (p.row && p.row.id)
  if (!Number.isInteger(rowId)) return null

  const current = undoStore.findRowById(table, rowId)
  const undoing = mode === 'undo'
  const later = undoing ? '撤销' : '重做'
  const before = undoing ? '重做' : '撤销'

  // 期望「执行时这行是什么状态」：
  //   row_update: undo 写回 oldRow，要求当前仍是 newRow；redo 反之。
  //   row_insert: undo 删行，要求当前仍是新增的那行；redo 插回，要求当前不存在。
  //   row_delete: undo 插回，要求当前不存在；redo 删行，要求当前仍是删除前那行。
  let expectExists, snapshot
  if (type === 'row_update') {
    expectExists = true
    snapshot = undoing ? p.newRow : p.oldRow
  } else if (type === 'row_insert') {
    expectExists = undoing
    snapshot = p.row
  } else {
    expectExists = !undoing
    snapshot = p.row
  }

  if (expectExists) {
    if (!current) {
      return `无法${later}：这条记录对应的行已不存在（可能已被后续操作删除），请先${before}后面的改动`
    }
    if (!matchSnapshot(current, snapshot)) {
      return `无法${later}：这条记录之后又被改过，请先${before}后面的改动`
    }
  } else if (current) {
    return `无法${later}：这条记录对应的行已被后续操作重新写入，请先${before}后面的改动`
  }
  return null
}

module.exports = { checkExpected, matchSnapshot, norm }
