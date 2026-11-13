// ==================== score_records 的 SQL 出口 ====================
// 档 C · M12-B5：路由只做 HTTP 与字段清洗，裸 SQL 全部收在这里。
// 这样「成绩表怎么查/怎么写」只有一处实现，新增调用方不会各抄一条 SQL。
const { db } = require('../db')

const ORDER_BY = ' ORDER BY 加分时间 DESC, id DESC'

// 全量列表（统计页签 / 导出 / 首页兼容旧调用）
function readAll() {
  return db.prepare(`SELECT * FROM score_records${ORDER_BY}`).all()
}

// source 过滤：'group' 只看小组加分；'personal' 只看个人（含历史数据里 source 为空的行）。
function sourceClause(source) {
  if (source === 'group') return { sql: "source = 'group'", params: [] }
  if (source === 'personal') return { sql: "(source IS NULL OR source <> 'group')", params: [] }
  return null
}

// 日期过滤：只取某一天（YYYY-MM-DD 前缀）。
function dateClause(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  return { sql: '加分时间 LIKE ?', params: [`${date}%`] }
}

// limit 为 0 表示全量；分页时多取一条判 hasMore，不跑 COUNT。
function list({ source, date, limit, offset } = {}) {
  const parts = [sourceClause(source), dateClause(date)].filter(Boolean)
  const where = parts.length ? ' WHERE ' + parts.map((p) => p.sql).join(' AND ') : ''
  const params = parts.flatMap((p) => p.params)
  if (!limit) {
    return { data: db.prepare(`SELECT * FROM score_records${where}${ORDER_BY}`).all(...params) }
  }
  const rows = db.prepare(
    `SELECT * FROM score_records${where}${ORDER_BY} LIMIT ? OFFSET ?`
  ).all(...params, limit + 1, offset)
  const hasMore = rows.length > limit
  return { data: hasMore ? rows.slice(0, limit) : rows, hasMore }
}

function findStudentById(id) {
  return db.prepare('SELECT id, 姓名, 学号 FROM students WHERE id = ?').get(id)
}

function findStudentByXuehao(xuehao) {
  return db.prepare('SELECT id, 姓名, 学号 FROM students WHERE 学号 = ?').get(xuehao) || null
}

// 同名最多取两条：调用方据此区分「唯一命中」与「重名歧义」。
function findStudentsByName(name) {
  return db.prepare('SELECT id, 姓名, 学号 FROM students WHERE 姓名 = ? ORDER BY id LIMIT 2').all(name)
}

// 批量导入：整批一个事务，返回新建 id（供路由回传 created 完整行）。
function insertMany(items) {
  const insert = db.prepare(
    `INSERT INTO score_records
      (student_id, 姓名, 学号, 类型, 项目, 分值, 原因, 加分时间, created_at, source, group_name, 成员数)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const tx = db.transaction((list) => {
    const ids = []
    for (const item of list) {
      ids.push(Number(insert.run(
        item.student_id, item.姓名, item.学号, item.类型, item.项目,
        item.分值, item.原因, item.加分时间, item.created_at,
        item.source, item.group_name, item.成员数
      ).lastInsertRowid))
    }
    return ids
  })
  return tx(items)
}

// 首页摘要只要「条数 + 今日 Top4」，不必把整表读进内存（v6 · 2-23）。
function dashboardSummary(today) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM score_records').get().n
  // 加分时间是「YYYY-MM-DD…」前缀，用 LIKE 前缀匹配与前端 startsWith(today) 同口径。
  // 分值列在 schema 里声明为 REAL（数值亲和性），ORDER BY 本来就算数值排序；这里保留 CAST
  // 只为兼容早期库里可能出现过的 TEXT 亲和性列 —— 在当前 schema 上是冗余的（已实测：
  // 去掉 CAST 测试仍全绿，所以它没有被任何用例"锁住"，不能当成不可回退的判据）。
  // 同分时按 id DESC：全量路径原本就是「已按 id DESC 排好 + JS 稳定排序」，等价可复现。
  const top = db.prepare(
    `SELECT 姓名, group_name, 分值, 类型 FROM score_records
     WHERE 加分时间 LIKE ? ORDER BY CAST(分值 AS REAL) DESC, id DESC LIMIT 4`
  ).all(`${today}%`)
  return { count, top }
}

module.exports = {
  readAll,
  list,
  findStudentById,
  findStudentByXuehao,
  findStudentsByName,
  insertMany,
  dashboardSummary,
}
