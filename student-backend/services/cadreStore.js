// ==================== cadres / cadre_members 的 SQL 出口 ====================
// 档 C · M12-B3：班干部路由只做校验与树形组装，语句收在这里。
const { db } = require('../db')

function allCadres() {
  return db.prepare('SELECT * FROM cadres ORDER BY sort_order, id').all()
}

// sort_order 一并返回：撤销「移除担任学生」要按整行恢复，缺了它恢复后成员会挤到最前面。
function membersOf(cadreId) {
  return db.prepare('SELECT id, cadre_id, student_id, student_name, sort_order FROM cadre_members WHERE cadre_id = ? ORDER BY sort_order, id').all(cadreId)
}

function findCadre(id) {
  return db.prepare('SELECT * FROM cadres WHERE id=?').get(id)
}

function findCadreBasic(id) {
  return db.prepare('SELECT id, name, max_count FROM cadres WHERE id=?').get(id)
}

function findParentId(id) {
  const row = db.prepare('SELECT parent_id FROM cadres WHERE id=?').get(id)
  return row ? row.parent_id : 0
}

// 校验父职务存在（若指定）
function cadreExists(id) {
  return !!db.prepare('SELECT id FROM cadres WHERE id=?').get(id)
}

function maxSort() {
  return db.prepare('SELECT COALESCE(MAX(sort_order),0) AS max FROM cadres').get().max
}

function insertCadre(name, parentId, maxCount, sort) {
  return db.prepare('INSERT INTO cadres (name, parent_id, max_count, sort_order) VALUES (?,?,?,?)')
    .run(name, parentId, maxCount, sort)
}

function updateCadre(id, name, parentId, maxCount) {
  db.prepare('UPDATE cadres SET name=?, parent_id=?, max_count=? WHERE id=?').run(name, parentId, maxCount, id)
}

// 删除职务：级联删除其担任学生，其直接子职务上移挂到被删职务的上级。
function deleteCadreCascade(id, parentId) {
  db.transaction(() => {
    db.prepare('DELETE FROM cadre_members WHERE cadre_id=?').run(id)
    db.prepare('UPDATE cadres SET parent_id=? WHERE parent_id=?').run(parentId, id)
    db.prepare('DELETE FROM cadres WHERE id=?').run(id)
  })()
}

function countMembers(cadreId) {
  return db.prepare('SELECT COUNT(*) AS n FROM cadre_members WHERE cadre_id=?').get(cadreId).n
}

function maxMemberSort(cadreId) {
  return db.prepare('SELECT COALESCE(MAX(sort_order),0) AS max FROM cadre_members WHERE cadre_id=?').get(cadreId).max
}

function insertMember(cadreId, studentId, studentName, sort) {
  return db.prepare('INSERT INTO cadre_members (cadre_id, student_id, student_name, sort_order) VALUES (?,?,?,?)')
    .run(cadreId, studentId, studentName, sort)
}

function deleteMember(id) {
  db.prepare('DELETE FROM cadre_members WHERE id=?').run(id)
}

function findMember(id) {
  return db.prepare('SELECT * FROM cadre_members WHERE id=?').get(id)
}

function listChildIds(parentId) {
  return db.prepare('SELECT id FROM cadres WHERE parent_id=? ORDER BY sort_order, id').all(parentId).map((r) => r.id)
}

// 移动职务：挂到 parentId(0=顶级) 下第 index 位（index 为去掉自身后目标位置，null 表示末尾）。
function moveCadre(id, parentId, index) {
  db.transaction(() => {
    const children = listChildIds(parentId).filter((x) => x !== id)
    if (index == null || index < 0) index = children.length
    if (index > children.length) index = children.length
    children.splice(index, 0, id)
    const stmt = db.prepare('UPDATE cadres SET sort_order=? WHERE id=?')
    children.forEach((cid, i) => stmt.run(i, cid))
    db.prepare('UPDATE cadres SET parent_id=? WHERE id=?').run(parentId, id)
  })()
}

function listMemberIds(cadreId) {
  return db.prepare('SELECT id FROM cadre_members WHERE cadre_id=? ORDER BY sort_order, id').all(cadreId).map((r) => r.id)
}

// 移动担任学生：挂到 cadreId 下第 index 位（index 为去掉自身后目标位置，null 表示末尾）。
function moveMember(id, cadreId, index) {
  db.transaction(() => {
    const list = listMemberIds(cadreId).filter((x) => x !== id)
    if (index == null || index < 0) index = list.length
    if (index > list.length) index = list.length
    list.splice(index, 0, id)
    const stmt = db.prepare('UPDATE cadre_members SET sort_order=? WHERE id=?')
    list.forEach((mid, i) => stmt.run(i, mid))
    db.prepare('UPDATE cadre_members SET cadre_id=? WHERE id=?').run(cadreId, id)
  })()
}

// ---------- 导入（合并追加） ----------
function findCadresByName(name) {
  return db.prepare('SELECT id FROM cadres WHERE name = ? ORDER BY id LIMIT 2').all(name)
}

function findCadreByNameAndParent(name, parentId) {
  return db.prepare('SELECT id, name, max_count FROM cadres WHERE name = ? AND parent_id = ? ORDER BY id LIMIT 1').get(name, parentId)
}

function findMemberByName(cadreId, name) {
  return db.prepare('SELECT id FROM cadre_members WHERE cadre_id = ? AND student_name = ?').get(cadreId, name)
}

function findStudentIdsByName(name) {
  return db.prepare('SELECT id FROM students WHERE 姓名 = ? ORDER BY id LIMIT 2').all(name)
}

module.exports = {
  allCadres,
  membersOf,
  findCadre,
  findCadreBasic,
  findParentId,
  cadreExists,
  maxSort,
  insertCadre,
  updateCadre,
  deleteCadreCascade,
  countMembers,
  maxMemberSort,
  insertMember,
  deleteMember,
  findMember,
  listChildIds,
  moveCadre,
  listMemberIds,
  moveMember,
  findCadresByName,
  findCadreByNameAndParent,
  findMemberByName,
  findStudentIdsByName,
}
