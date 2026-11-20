// =========================================================================
// undo.expected.js —— 撤销前的「期望状态」快照校验
//
// 为什么需要：撤销记录存的是每一步的整行前后快照。若跳过中间记录去撤旧记录
// （例如 A 新增 → B MCP 改名 → 手改 → C 助手再改，却直接撤 B），执行器会
// 盲目把 B 的 oldRow 整行回写，把手改/C 的改动无声吞掉。
// 本模块在 flip 抢占方向之前，先确认「当前行仍是这条记录写入后留下的样子」，
// 不一致就拒绝，提示用户先撤后面的。
//
// 范围：行式三类 row_insert / row_update / row_delete。
// 复合类型（student_cascade_delete / rows_batch_* / doc_update / grid_cell…）
// 的快照形状不同，留给「回退到指定记录之前」的统一入口处理，本模块一律放行。
// =========================================================================

const undoStore = require('../../services/undoStore')

const ROW_TYPES = new Set(['row_insert', 'row_update', 'row_delete'])

// 归一化后比较：规避 number 90 与 string '90'、null 与 undefined 的假差异。
function norm(v) {
  if (v == null) return null
  if (typeof v === 'object') {
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  return String(v)
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

// 返回 null 表示通过；返回字符串表示拒绝原因。
function checkExpected(rec, mode) {
  const type = rec && rec.type
  if (!ROW_TYPES.has(type)) return null
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
