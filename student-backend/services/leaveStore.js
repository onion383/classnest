// ==================== 请假（leave_records）与今日到班列顺序的 SQL 出口 ====================
// 档 C · M12-B6：请假路由只做 HTTP 形状与字段清洗，语句收在这里。
// 分页的 hasMore 用「多取一条」判定、不跑 COUNT（与 services/searchLimits 同一口径）。
const { db } = require('../db')

// 全量列表（GET /api/leaves 不带 limit 时；挂件、导出、AI 工具都依赖这个语义）
function readAll() {
  return db.prepare('SELECT * FROM leave_records ORDER BY position, id').all()
}

// scope=today → 今日到班需要的两类记录：
//   · 状态「请假中」（还没回来的人）
//   · 状态「已返校」且返校时间是今天（今天回来的人）
// 这两类散布在整张表里，不能靠列表第一页顺带，所以单独按范围取。
function scopeClause(scope, date) {
  if (scope !== 'today') return null
  const d = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
  if (!d) return { sql: "状态 = '请假中'", params: [] }
  return { sql: "(状态 = '请假中' OR (状态 = '已返校' AND 返校时间 LIKE ?))", params: [`${d}%`] }
}

// 列表：limit 为 0 时返回全量（hasMore 恒 false），否则分页并多取一条判 hasMore
function readList({ scope, date, limit = 0, offset = 0 } = {}) {
  const sc = scopeClause(scope, date)
  const where = sc ? ` WHERE ${sc.sql}` : ''
  const params = sc ? sc.params : []
  const tail = ' ORDER BY position, id'
  if (!limit) {
    return { rows: db.prepare(`SELECT * FROM leave_records${where}${tail}`).all(...params), hasMore: false }
  }
  const rows = db.prepare(
    `SELECT * FROM leave_records${where}${tail} LIMIT ? OFFSET ?`
  ).all(...params, limit + 1, offset)
  const hasMore = rows.length > limit
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore }
}

// 编辑校验要拿库里的旧行补齐跨字段（只改「结束时间」时看不到「开始时间」）
function findWindow(id) {
  return db.prepare('SELECT 开始时间, 结束时间 FROM leave_records WHERE id = ?').get(id)
}

// ---------- 学生信息带出（新增请假 / 导入按学号、姓名匹配） ----------
// 只取请假表要用的四列：姓名 + 双方联系电话。
function findStudentById(id) {
  return db.prepare('SELECT id, 姓名, 家长联系电话, 学生联系电话 FROM students WHERE id = ?').get(id)
}
function findStudentByXuehao(xuehao) {
  return db.prepare('SELECT id, 姓名, 家长联系电话, 学生联系电话 FROM students WHERE 学号 = ?').get(xuehao)
}
// 重名判断：只看前两条，够判断「唯一匹配」即可
function findStudentsByName(name) {
  return db.prepare('SELECT id, 姓名, 家长联系电话, 学生联系电话 FROM students WHERE 姓名 = ? ORDER BY id LIMIT 2').all(name)
}

// ---------- 单行写入 ----------
function removeById(id) {
  return db.prepare('DELETE FROM leave_records WHERE id = ?').run(id)
}
function markReturned(id, time) {
  return db.prepare("UPDATE leave_records SET 状态='已返校', 返校时间=? WHERE id = ?").run(time, id)
}
function markUnreturned(id) {
  return db.prepare("UPDATE leave_records SET 状态='请假中', 返校时间=NULL WHERE id = ?").run(id)
}
function markCanceled(id) {
  return db.prepare("UPDATE leave_records SET 状态='已取消' WHERE id = ?").run(id)
}

// 批量导入：整批一个事务，返回新建 id（供路由回传 created 完整行）
function insertMany(items) {
  const insert = db.prepare(
    `INSERT INTO leave_records
      (position, student_id, 姓名, 类型, 开始时间, 结束时间, 家长联系电话, 学生联系电话, 状态, 返校时间, 备注, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const tx = db.transaction((list) => {
    const ids = []
    for (const item of list) {
      ids.push(Number(insert.run(
        item.position, item.student_id, item.姓名, item.类型, item.开始时间, item.结束时间,
        item.家长联系电话, item.学生联系电话, item.状态, item.返校时间, item.备注, item.created_at
      ).lastInsertRowid))
    }
    return ids
  })
  return tx(items)
}

// ---------- 今日到班两张只读表的列顺序（复用 table_meta，不改表结构） ----------
function listTodayColumns(names) {
  return db.prepare(
    'SELECT table_name, column_name FROM table_meta WHERE table_name IN (?, ?, ?) ORDER BY sort_order'
  ).all(...names)
}

// 整表替换某张只读表的列顺序：先删后插，同一事务
function replaceTodayColumns(tableName, order) {
  const del = db.prepare('DELETE FROM table_meta WHERE table_name = ?')
  const ins = db.prepare('INSERT INTO table_meta (table_name, column_name, data_type, sort_order) VALUES (?, ?, ?, ?)')
  db.transaction(() => {
    del.run(tableName)
    order.forEach((name, i) => ins.run(tableName, String(name), '文字', i + 1))
  })()
}

module.exports = {
  readAll,
  readList,
  findWindow,
  findStudentById,
  findStudentByXuehao,
  findStudentsByName,
  removeById,
  markReturned,
  markUnreturned,
  markCanceled,
  insertMany,
  listTodayColumns,
  replaceTodayColumns,
}
