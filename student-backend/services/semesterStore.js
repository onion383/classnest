// ==================== 学期（semesters）的 SQL 出口 ====================
// 档 C · M12-B4：课表路由只做校验与镜像字段的取舍，语句收在这里。
// 「当前学期」的唯一判定也在这里：全库两处曾经各写一份（课表路由 / slotStore.semesterRange），
// 一处按 is_current 取值、另一处回退最新一条 —— 换个写法人就会只有一边跟着变。
const { db } = require('../db')

// 学期列表：按开始日期倒序，未填日期的排最后
function list() {
  return db.prepare(`
      SELECT id, name, start_date, end_date, is_current FROM semesters
      ORDER BY (start_date = '') ASC, start_date DESC, id DESC
    `).all()
}

// 当前学期；没有标记为当前的（老库）时回退最新一条
function findCurrent() {
  return db.prepare('SELECT id, name, start_date, end_date FROM semesters WHERE is_current = 1 ORDER BY id DESC LIMIT 1').get()
    || db.prepare('SELECT id, name, start_date, end_date FROM semesters ORDER BY id DESC LIMIT 1').get()
}

function exists(id) {
  return !!db.prepare('SELECT id FROM semesters WHERE id = ?').get(id)
}

function findById(id) {
  return db.prepare('SELECT id, name, start_date, end_date, is_current FROM semesters WHERE id = ?').get(id)
}

// 只取「是不是当前」这一位（删除时要据此决定是否补选）
function findCurrentFlag(id) {
  return db.prepare('SELECT id, is_current FROM semesters WHERE id = ?').get(id)
}

// 新建学期并置为当前：清旧标记与插入必须同事务，否则中途失败会一个当前学期都没有
function create(name, startDate, endDate) {
  const tx = db.transaction(() => {
    db.prepare('UPDATE semesters SET is_current = 0').run()
    return db.prepare('INSERT INTO semesters (name, start_date, end_date, is_current) VALUES (?,?,?,1)')
      .run(name, startDate, endDate)
  })
  return tx()
}

function setCurrent(id) {
  db.transaction(() => {
    db.prepare('UPDATE semesters SET is_current = 0').run()
    db.prepare('UPDATE semesters SET is_current = 1 WHERE id = ?').run(id)
  })()
}

function update(id, name, startDate, endDate) {
  return db.prepare('UPDATE semesters SET name = ?, start_date = ?, end_date = ? WHERE id = ?')
    .run(name, startDate, endDate, id)
}

// 只改起止日期（设置页「当前学期」镜像写回，不动学期名）
function updateRange(id, startDate, endDate) {
  return db.prepare('UPDATE semesters SET start_date = ?, end_date = ? WHERE id = ?')
    .run(startDate, endDate, id)
}

// 删除学期：删的若是当前学期，自动把剩下的最新一条设为当前。
// 存在性判断与删除放在同一个事务里 —— 分开读再删，中间被别人删掉就会静默 200。
function remove(id) {
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT id, is_current FROM semesters WHERE id = ?').get(id)
    if (!row) return false
    db.prepare('DELETE FROM semesters WHERE id = ?').run(id)
    if (row.is_current) {
      const next = db.prepare('SELECT id FROM semesters ORDER BY start_date DESC, id DESC LIMIT 1').get()
      if (next) db.prepare('UPDATE semesters SET is_current = 1 WHERE id = ?').run(next.id)
    }
    return true
  })
  return tx()
}

module.exports = {
  list,
  findCurrent,
  exists,
  findById,
  findCurrentFlag,
  create,
  setCurrent,
  update,
  updateRange,
  remove,
}
