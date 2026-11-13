// ==================== 导出侧的只读查询出口 ====================
// 档 C · M12-B7：dataExport 路由不再直接持有 db，语句执行与「读失败不拖垮整份导出」
// 的兜底语义都收在这里。
const { db } = require('../db')

// 单表读取失败不应该让整份导出挂掉（旧库缺表 / 列被删过）：返回空结果。
function all(sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch (_) { return [] }
}

function get(sql, params = []) {
  try { return db.prepare(sql).get(...params); } catch (_) { return null }
}

// 只取行数，不物化整表；表不存在时 get 已吞掉异常返回 null。
function countOf(tableName) {
  const row = get(`SELECT COUNT(*) AS n FROM ${tableName}`)
  return Number(row && row.n) || 0
}

module.exports = { all, get, countOf }
