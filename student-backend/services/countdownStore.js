// ==================== countdowns 的 SQL 出口 ====================
// 档 C · M12-B5：路由只做 HTTP 与导入解析，裸 SQL 收在这里。
const { db } = require('../db')

function readAll() {
  return db.prepare('SELECT * FROM countdowns ORDER BY position, id').all()
}

function removeById(id) {
  db.prepare('DELETE FROM countdowns WHERE id = ?').run(id)
}

// 批量导入：整批一个事务，返回新建 id（供路由回传 created 完整行）。
function insertMany(items) {
  const insert = db.prepare(
    'INSERT INTO countdowns (名称, 截止日, 包含这一天, created_at, position) VALUES (?, ?, ?, ?, ?)'
  )
  const tx = db.transaction((list) => {
    const ids = []
    for (const item of list) {
      ids.push(Number(insert.run(item.名称, item.截止日, item.包含这一天, item.created_at, item.position).lastInsertRowid))
    }
    return ids
  })
  return tx(items)
}

module.exports = { readAll, removeById, insertMany }
