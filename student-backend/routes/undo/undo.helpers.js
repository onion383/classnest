// =========================================================================
// undo.helpers.js —— 撤销系统·辅助函数
// （原 routes/undo.js 按职责拆分而来，纯代码搬运，行为不变）
//   网格 JSON 读写、动态表行级操作、整块写入、相册排序、分组快照
// =========================================================================

const { db } = require('../../db')
const store = require('../../services/slotStore')
const { SEAT_CURRENT_SLOTS } = require('../../schema/tableRegistry')

// 读取网格某列的完整 JSON（单例文档表经 slotStore 读取，其余仍走物理表）
function readGridArray(table, column) {
  const row = store.isDoc(table)
    ? store.getDoc(table)
    : db.prepare(`SELECT "${column}" FROM "${table}" WHERE id = 1`).get()
  if (!row) return []
  try { return JSON.parse(row[column]) } catch { return [] }
}
// 整体覆盖网格某列：原样 JSON 序列化。
// 座位/课表是二维数组，值日表是 {项目:{星期:[人名]}} 对象，统一原样存储，不做强转。
function writeGridArray(table, column, value) {
  // 座位整块快照可以带几何：{ seats, types }。
  // 只写 seats 的话，撤销「设置空位」只会把人搬回去、洞还留着 —— 人和洞的位置当场错位。
  // 老记录（直接存数组）继续走下面的原样写入，不必迁移历史撤销记录。
  if (column === 'seats' && value && typeof value === 'object' && !Array.isArray(value)) {
    const patch = { seats: JSON.stringify(Array.isArray(value.seats) ? value.seats : []) }
    if (Array.isArray(value.types)) patch.types = JSON.stringify(value.types)
    if (store.isDoc(table)) {
      store.setDoc(table, patch)
      return
    }
    const keys = Object.keys(patch)
    db.prepare(`UPDATE "${table}" SET ${keys.map((k) => `"${k}" = ?`).join(', ')} WHERE id = 1`)
      .run(...keys.map((k) => patch[k]))
    return
  }
  if (store.isDoc(table)) {
    store.setDoc(table, { [column]: JSON.stringify(value) })
    return
  }
  db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE id = 1`).run(JSON.stringify(value))
}
// 座位表的**行数/列数**随整块快照一起回写（插入/删除走廊行、走廊列都会改变 rows/cols）。
// 为什么必须成对写：types 的行数/列数就是几何，读库按 rows/cols 去裁它 ——
// 只回写 types（少一行/一列）而 rows/cols 还是多的，会走到 routes/seats.js 的
// gridShapeMismatch 分支：越界那行被补成「座位」或整块降级成 []，
// 走廊位置对不上，下次启动的一次性迁移还会把矩阵再展开一遍。
// 表名走白名单，不接收调用方的任意字符串；列名是写死的两条语句（不拼 SQL）。
// 名单在 schema/tableRegistry.js（与 seatWrite 的「当前座位」白名单同源）。
const GEOMETRY_COUNT_TABLES = new Set(SEAT_CURRENT_SLOTS)

// 座位表的**当前** rows/cols（非座位表返回 null）。
// 撤销一条单格记录前用它判断「布局是否已经变小」—— 见 undo.executors 的 grid_cell.validate。
function currentSeatGeometry(table) {
  if (!GEOMETRY_COUNT_TABLES.has(table)) return null
  const rec = store.isDoc(table)
    ? store.getDoc(table)
    : db.prepare(`SELECT rows, cols FROM "${table}" WHERE id = 1`).get()
  if (!rec) return null
  const rows = Number(rec.rows)
  const cols = Number(rec.cols)
  return {
    rows: Number.isInteger(rows) && rows > 0 ? rows : null,
    cols: Number.isInteger(cols) && cols > 0 ? cols : null,
  }
}

// 从一个「整块快照」推回它的几何（行数 / 列数）。
//
// 几何在库里只有**一个**真实来源：快照自带的 types 矩阵的形状。
// 为什么不再采信前端传的 oldRows/oldCols：那是把同一事实抄两遍，抄漏一项就分叉
// （历史真实事故：只透传了 rows、漏了 cols → types 宽 8 列而 cols 还写 7，读库按 cols 裁，
// 座位图整体错列且不报错）。矩阵和计数必须同笔写，所以计数只能由矩阵推出来。
//
// 没有 types 的历史记录（换位 / 设置空位那类纯数组快照）返回 null：
// 那时也没有矩阵可写，单独改计数只会**制造**分叉 —— 宁可不动，行为与修复前一致。
function geometryOfSnapshot(snapshot) {
  const types = snapshot && !Array.isArray(snapshot) ? snapshot.types : null
  if (!Array.isArray(types) || !types.length) return null
  const width = Array.isArray(types[0]) ? types[0].length : 0
  if (!width) return null
  return { rows: types.length, cols: width }
}

// 前端仍会把几何四元组一起传（既有契约）。它不再被采信，但**不一致要留痕**：
// 这条日志是「前后端几何口径开始漂移」的早期信号，别删。
function warnGeometryDrift(table, tag, geom, explicitRows, explicitCols) {
  const bad = []
  if (Number.isInteger(explicitRows) && explicitRows !== geom.rows) bad.push(`行 ${explicitRows}≠${geom.rows}`)
  if (Number.isInteger(explicitCols) && explicitCols !== geom.cols) bad.push(`列 ${explicitCols}≠${geom.cols}`)
  if (bad.length) console.warn(`[undo] ${table} ${tag} 的几何字段与 types 快照不一致（以 types 为准）：${bad.join('，')}`)
}

function writeGeometryCounts(table, rows, cols) {
  if (!GEOMETRY_COUNT_TABLES.has(table)) return
  const patch = {}
  if (Number.isInteger(rows)) patch.rows = rows
  if (Number.isInteger(cols)) patch.cols = cols
  if (!Object.keys(patch).length) return
  if (store.isDoc(table)) {
    store.setDoc(table, patch)
    return
  }
  if (Number.isInteger(rows)) db.prepare(`UPDATE "${table}" SET rows = ? WHERE id = 1`).run(rows)
  if (Number.isInteger(cols)) db.prepare(`UPDATE "${table}" SET cols = ? WHERE id = 1`).run(cols)
}
// 单元格展示文案：value 可能是纯值（座位 id/姓名、人名），也可能是课表 {course} 对象，
// 统一取可读文本；null/undefined 视为「空」。
function cellText(v) {
  if (v == null) return '空'
  if (typeof v === 'object') return v.course || '空'
  return String(v)
}
// ===== 动态表行级操作辅助（表名受 ALLOWED_TABLES 白名单约束，杜绝注入）=====
function tableCols(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
}
function rowKeys(table, row) {
  const cols = new Set(tableCols(table))
  return Object.keys(row || {}).filter(k => cols.has(k))
}
// 插入一条完整记录（显式带 id，便于删除后再恢复保留引用关系）
function insertRow(table, row) {
  const keys = rowKeys(table, row)
  if (!keys.length) return
  const cols = keys.map(k => `"${k}"`).join(',')
  const ph = keys.map(() => '?').join(',')
  db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${ph})`).run(...keys.map(k => row[k]))
}
function deleteRowById(table, id) {
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
}
function updateRowById(table, id, row) {
  const keys = rowKeys(table, row).filter(k => k !== 'id')
  if (!keys.length) return
  const set = keys.map(k => `"${k}" = ?`).join(', ')
  db.prepare(`UPDATE ${table} SET ${set} WHERE id = ?`).run(...keys.map(k => row[k]), id)
}
// 整块写入「非行式」表：按给定列整体覆盖某行（对象/数组列按 JSON 文本落库）。
// obj 为「列名 → 列值」，仅写入该表真实列（不含 id）。
function writeDocCols(table, id, obj) {
  // 单例文档表（课表/值日/座位）写入统一走 slotStore
  if (store.isDoc(table)) {
    store.setDoc(table, obj)
    return
  }
  const keys = rowKeys(table, obj).filter(k => k !== 'id')
  if (!keys.length) return
  const set = keys.map(k => `"${k}" = ?`).join(', ')
  const params = keys.map(k => {
    const v = obj[k]
    if (v != null && typeof v === 'object') return JSON.stringify(v)
    // 布尔按 1/0 落库，避免 INTEGER 列（如 toolbox_enabled / auto_apply）被写入文本
    if (typeof v === 'boolean') return v ? 1 : 0
    return v
  })
  db.prepare(`UPDATE ${table} SET ${set} WHERE id = ?`).run(...params, id)
}
// 记录显示名：取姓名/小组名/活动主题/倒计时名称，否则回退 #id
function rowName(row, id) {
  return row ? (row.姓名 || row.group_name || row.主题 || row.名称 || `#${row.id ?? id}`) : `#${id}`
}

// 相册排序：按给定 id 顺序整块重写 sort_order（1 起）。相册删除后 id 可能不再存在，跳过即可。
// 整块重排必须原子：中途失败会留下「一半新序、一半旧序」的错乱排序。
function applyAlbumOrder(ids) {
  const tx = db.transaction(() => {
    const upd = db.prepare('UPDATE albums SET sort_order = ? WHERE id = ?')
    ;(ids || []).forEach((id, i) => upd.run(i + 1, Number(id)))
  })
  tx()
}
// 分组结构：整块重建某维度下的组与成员。
// snapshot = [{ id, name, gender, sort_order, members: [{ id, member_name, remark, sort_order }] }]
// 先按维度清理现有组与成员，再按快照显式 id 重建（保留引用关系与内部排序）。
function applyGroupSnapshot(dimId, groups) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM group_members WHERE group_id IN (SELECT id FROM groups WHERE dimension_id = ?)').run(dimId)
    db.prepare('DELETE FROM groups WHERE dimension_id = ?').run(dimId)
    const insG = db.prepare('INSERT INTO groups (id, dimension_id, name, gender, sort_order) VALUES (?, ?, ?, ?, ?)')
    const insM = db.prepare('INSERT INTO group_members (id, group_id, member_name, remark, sort_order) VALUES (?, ?, ?, ?, ?)')
    for (const g of groups || []) {
      insG.run(g.id, dimId, g.name ?? '', g.gender ?? null, g.sort_order)
      for (const m of g.members || []) {
        insM.run(m.id, g.id, m.member_name ?? '', m.remark ?? '', m.sort_order)
      }
    }
  })
  tx()
}

module.exports = {
  readGridArray,
  writeGridArray,
  writeGeometryCounts,
  currentSeatGeometry,
  geometryOfSnapshot,
  warnGeometryDrift,
  cellText,
  tableCols,
  rowKeys,
  insertRow,
  deleteRowById,
  updateRowById,
  writeDocCols,
  rowName,
  applyAlbumOrder,
  applyGroupSnapshot,
}
