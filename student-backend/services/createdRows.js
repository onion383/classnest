// =========================================================================
// createdRows.js —— 导入类接口的「本次新建行」回读
//
// 撤销导入需要的是**完整行**：redo 要按真实列重建（position、created_at 这些
// 猜不得），只回 id 或只回条数都做不到。过去各导入端点只回 `message`，
// 前端因此普遍没有可用的 inverse（审查 v6 · Q2-04 / Q2-06）。
//
// 这里把「按 id 回读整行」收成一个契约，所有导入端点共用一个响应形状：
//   { message, created: [完整行…] }
//
// 表名只由各路由以字面量传入（从不接收请求参数），ids 走参数绑定。
// =========================================================================

const { db } = require('../db')

// 按 id 回读整行。ids 会去重、过滤非法值；空数组直接返回 []，不拼 SQL。
function readRowsByIds(tableName, ids) {
  const list = [...new Set((ids || []).map(Number))]
    .filter((id) => Number.isInteger(id) && id > 0)
  if (!list.length) return []
  const placeholders = list.map(() => '?').join(',')
  return db.prepare(`SELECT * FROM "${tableName}" WHERE id IN (${placeholders}) ORDER BY id`).all(...list)
}

module.exports = { readRowsByIds }
