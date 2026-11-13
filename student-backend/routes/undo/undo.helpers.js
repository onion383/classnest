// =========================================================================
// undo.helpers.js —— 撤销系统·辅助函数
// （原 routes/undo.js 按职责拆分而来，行为不变）
//   网格 JSON 读写、动态表行级操作、整块写入、相册排序、分组快照
//   档 C · M12-B8：语句收进 services/undoStore，本文件只留语义层
//   （几何从快照推导、座位整块写、展示文案），不再持有 db。
// =========================================================================

const undoStore = require('../../services/undoStore')

// 读取网格某列的完整 JSON（单例文档表经 slotStore 读取，其余读物理表，分支在 store 内）
function readGridArray(table, column) {
  const row = undoStore.readDocColumn(table, column)
  if (!row) return []
  try { return JSON.parse(row[column]) } catch { return [] }
}
// 整体覆盖网格某列：原样 JSON 序列化。
// 座位/课表是二维数组，值日表是 {项目:{星期:[人名]}} 对象，统一原样存储，不做强转。
function writeGridArray(table, column, value) {
  // 座位整块快照可以带几何：{ seats, types }。
  // 只写 seats 的话，撤销「设置空位」只会把人搬回去、洞还留着 —— 人和洞的位置当场错位。
  // 老记录（直接存数组）继续走下面的原样写入，不必迁移历史撤销记录。
  // 两列同笔写的实现在 undoStore.writeDocColumn（`seats` 分支）。
  undoStore.writeDocColumn(table, column, value)
}
// 座位表的**行数/列数**随整块快照一起回写（插入/删除走廊行、走廊列都会改变 rows/cols）。
// 为什么必须成对写：types 的行数/列数就是几何，读库按 rows/cols 去裁它 ——
// 只回写 types（少一行/一列）而 rows/cols 还是多的，会走到 routes/seats.js 的
// gridShapeMismatch 分支：越界那行被补成「座位」或整块降级成 []，
// 走廊位置对不上，下次启动的一次性迁移还会把矩阵再展开一遍。
// 表名走白名单，不接收调用方的任意字符串；名单在 schema/tableRegistry.js
// （与 seatWrite 的「当前座位」白名单同源），读取在 undoStore.readSeatGeometry。

// 座位表的**当前** rows/cols（非座位表返回 null）。
// 撤销一条单格记录前用它判断「布局是否已经变小」—— 见 undo.executors 的 grid_cell.validate。
function currentSeatGeometry(table) {
  const rec = undoStore.readSeatGeometry(table)
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
  undoStore.writeGeometryCounts(table, rows, cols)
}
// 单元格展示文案：value 可能是纯值（座位 id/姓名、人名），也可能是课表 {course} 对象，
// 统一取可读文本；null/undefined 视为「空」。
function cellText(v) {
  if (v == null) return '空'
  if (typeof v === 'object') return v.course || '空'
  return String(v)
}
// ===== 动态表行级操作辅助（表名受 ALLOWED_TABLES 白名单约束，杜绝注入）=====
// 语句与列筛选都在 undoStore；这里保留同名导出，执行器与外部调用方不必改 import。
const { tableCols, rowKeys, insertRow, deleteRowById, updateRowById, writeDocCols } = undoStore

// 记录显示名：取姓名/小组名/活动主题/倒计时名称，否则回退 #id
function rowName(row, id) {
  return row ? (row.姓名 || row.group_name || row.主题 || row.名称 || `#${row.id ?? id}`) : `#${id}`
}

// 相册排序：整块重排必须原子（store 内一个事务），已删的 id 影响 0 行直接跳过。
function applyAlbumOrder(ids) {
  undoStore.applyAlbumOrder(ids)
}
// 分组结构：整块重建某维度下的组与成员（先清理后按快照显式 id 重建，store 内一个事务）。
function applyGroupSnapshot(dimId, groups) {
  undoStore.applyGroupSnapshot(dimId, groups)
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
