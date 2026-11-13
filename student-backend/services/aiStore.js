// ==================== AI 域（routes/ai/**）的 SQL 出口 ====================
// 档 C · M12-B7：AI 路由与工具执行器只保留业务判断，语句收在这里。
// 这里不承载业务规则，只做「同一张表的同一件事只有一份查询」。
const { db } = require('../db')
const dbManager = require('../dbManager/dbManager')

// ---------- 表结构（PRAGMA 一次后复用，键带数据库 slug，不能跨库复用） ----------
const colCache = {}
function tableColumns(table) {
  let slug = 'default'
  try { slug = dbManager.currentSlug() || 'default' } catch (_) { /* 非请求上下文时退回 default */ }
  const key = `${slug}:${table}`
  if (colCache[key]) return colCache[key]
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)
  colCache[key] = cols
  return cols
}

// 表结构变更（加/删/改名列）后必须主动失效，否则 PRAGMA 结果会一直停留在旧结构。
function clearTableColumnsCache(table) {
  Object.keys(colCache).forEach((key) => {
    if (!table || key.endsWith(`:${table}`)) delete colCache[key]
  })
}

// ---------- 学生 id → 姓名 ----------
function studentIdNameMap() {
  const map = {}
  for (const s of db.prepare('SELECT id, 姓名 FROM students').all()) map[Number(s.id)] = String(s['姓名'] || '')
  return map
}

// ---------- 教学周：倒计时里名称含「期末 / 考试」的项 ----------
function listCountdowns() {
  return db.prepare('SELECT 名称, 截止日 FROM countdowns').all()
}

// ---------- 整块文档（排布图导出 / 删除影响预估共用） ----------
function readScheduleDoc() {
  return db.prepare('SELECT cells, settings FROM schedule WHERE id = 1').get()
}
function readSeatDoc() {
  return db.prepare('SELECT seats, cols, types FROM seat_layout WHERE id = 1').get()
}
function readDutyDoc() {
  return db.prepare('SELECT cells, settings FROM duty_layout WHERE id = 1').get()
}

// ---------- delete_impact：删除前的引用预估 ----------
function findRow(table, id) {
  return db.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id)
}

// ---------- 行式表读写（/doc 与 /apply-batch 共用） ----------
// 值的语义仍留在路由：调用方先经 serializeColVal 归一（对象转 JSON 文本、布尔转 1/0），
// 这里只负责拼语句与绑定，避免 service 反向依赖 routes/ai/ai.helpers。
function rowsByIds(table, ids) {
  return db.prepare(`SELECT * FROM "${table}" WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
}
function maxPosition(table) {
  const row = db.prepare(`SELECT MAX(position) AS m FROM "${table}"`).get()
  return Number(row && row.m) || 0
}
function insertRow(table, keys, values) {
  const sql = `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  return db.prepare(sql).run(...values)
}
function updateColumns(table, id, keys, values) {
  const setSql = keys.map((k) => `"${k}" = ?`).join(', ')
  return db.prepare(`UPDATE "${table}" SET ${setSql} WHERE id = ?`).run(...values, id)
}
function deleteRow(table, id) {
  return db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id)
}
function countReferences(table, field, value) {
  return db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${field}" = ?`).get(value).n
}
function sampleReferences(table, field, value, limit = 3) {
  return db.prepare(`SELECT * FROM "${table}" WHERE "${field}" = ? LIMIT ${Number(limit) || 3}`).all(value)
}

// ---------- 固定读取（AI 数据体检 / 跨表检索） ----------
function listStudentsForChecks() {
  return db.prepare('SELECT id, 学号, 姓名 FROM students').all()
}
function listStudentCandidates() {
  return db.prepare('SELECT id, 学号, 姓名, 年级, 班级 FROM students').all()
}
function listCadreMembers() {
  return db.prepare('SELECT id, cadre_id, student_id, student_name FROM cadre_members').all()
}
function listGroupMembers() {
  return db.prepare('SELECT id, group_id, member_name FROM group_members').all()
}
function listLeaveRecordsForChecks() {
  return db.prepare('SELECT id, 姓名, 开始时间, 结束时间 FROM leave_records').all()
}
function listFeeRecords() {
  return db.prepare('SELECT id, 收支类型, 收支金额, 收支时间, 备注 FROM fee_records').all()
}
function listCountdownsForChecks() {
  return db.prepare('SELECT id, 名称, 截止日 FROM countdowns').all()
}

// ---------- 跨表检索（search_all） ----------
function listScoresForSearch() {
  return db.prepare('SELECT id, 姓名, 学号, 类型, 项目, 分值, 原因, 加分时间 FROM score_records').all()
}
function listLeaveRecordsForSearch() {
  return db.prepare('SELECT id, 姓名, 类型, 开始时间, 结束时间, 状态 FROM leave_records').all()
}
function listCadreMembersForSearch() {
  return db.prepare('SELECT id, student_id, student_name FROM cadre_members').all()
}
function listGroupMembersForSearch() {
  return db.prepare('SELECT id, group_id, member_name, remark FROM group_members').all()
}

// ---------- 权重评分（座位/值日指数） ----------
function readSeatWeight() {
  return db.prepare('SELECT weights FROM seat_weight WHERE id = 1').get()
}
function readSeatHistory(fromD, toD) {
  return fromD
    ? db.prepare('SELECT seats FROM seat_history WHERE snap_date >= ? AND snap_date <= ? ORDER BY snap_date').all(fromD, toD)
    : db.prepare('SELECT seats FROM seat_history WHERE snap_date <= ? ORDER BY snap_date').all(toD)
}
function readDutyWeight() {
  return db.prepare('SELECT weights FROM duty_weight WHERE id = 1').get()
}
function readDutyHistory(fromD, toD, mode) {
  const params = [mode]
  let sql = 'SELECT cells FROM duty_history WHERE mode = ?'
  if (fromD) { sql += ' AND snap_date >= ?'; params.push(fromD) }
  sql += ' AND snap_date <= ?'; params.push(toD)
  sql += ' ORDER BY snap_date'
  return db.prepare(sql).all(...params)
}

// ---------- 动态查询执行口 ----------
// 查询/聚合工具的 SQL 由执行器按入参拼装（列名与表名已按白名单校验），
// 这里只统一执行入口，避免执行器各自持有 db。
function queryAll(sql, params = []) {
  return db.prepare(sql).all(...params)
}
function queryGet(sql, params = []) {
  return db.prepare(sql).get(...params)
}

// ---------- 提案校验用 ----------
function existingIds(table, ids) {
  return db.prepare(`SELECT id FROM "${table}" WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.id)
}
function listIds(table, limit = 2) {
  return db.prepare(`SELECT id FROM "${table}" ORDER BY id LIMIT ${Number(limit) || 2}`).all()
}

// ---------- AI 长对话压缩 / 上下文重建 ----------
// 这几项已按「会话域」归到 services/aiConversationStore.js（M12-B7），
// 本文件只保留与表结构 / 文档 / 引用预估相关的查询。

module.exports = {
  tableColumns,
  clearTableColumnsCache,
  studentIdNameMap,
  listCountdowns,
  readScheduleDoc,
  readSeatDoc,
  readDutyDoc,
  findRow,
  rowsByIds,
  maxPosition,
  insertRow,
  updateColumns,
  deleteRow,
  countReferences,
  sampleReferences,
  listStudentsForChecks,
  listStudentCandidates,
  listCadreMembers,
  listGroupMembers,
  listLeaveRecordsForChecks,
  listFeeRecords,
  listCountdownsForChecks,
  listScoresForSearch,
  listLeaveRecordsForSearch,
  listCadreMembersForSearch,
  listGroupMembersForSearch,
  readSeatWeight,
  readSeatHistory,
  readDutyWeight,
  readDutyHistory,
  queryAll,
  queryGet,
  existingIds,
  listIds,
}
