// ==================== activities 的 SQL 出口 ====================
// 档 C · M12-B7：路由只做清洗/导入解析，读写语句收在这里。
const { db } = require('../db')

function readAll() {
  return db.prepare('SELECT * FROM activities ORDER BY position, id').all()
}

function removeById(id) {
  db.prepare('DELETE FROM activities WHERE id = ?').run(id)
}

// 批量导入：整批一个事务，返回新建 id（供路由回传 created 完整行）。
function insertMany(items) {
  const insert = db.prepare(
    'INSERT INTO activities (时间, 主题, 地点, 参与人员, 简介, created_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const tx = db.transaction((list) => {
    const ids = []
    for (const item of list) {
      ids.push(Number(insert.run(item.时间, item.主题, item.地点, item.参与人员, item.简介, item.created_at, item.position).lastInsertRowid))
    }
    return ids
  })
  return tx(items)
}

module.exports = { readAll, removeById, insertMany }
