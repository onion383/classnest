// ==================== 在 students 里「认人」的单源实现 ====================
// 加减分与请假都做过「按 id / 学号 / 姓名把学生带出来」，各自抄了一份 SQL，
// 连列清单都不一致（加减分要学号，请假要双方联系电话），于是同一个问题有两个实现。
// 这里只保留一份语句，列清单由调用方按名字点单 —— 以后再有人需要认人，
// 加法是「加一套列清单」，不是再抄一条 SQL。
//
// 边界：这里只做「查」。名册外的名字要落一条 is_provisional=1 的学生，必须走
// services/provisionalStudents.js 的 resolveOne —— 同名歧义、唯一索引冲突兜底都在那边，
// 在这里 insert 会把那套规则绕过去，造出第二条同名临时学生。
const { db } = require('../db')

// 列清单白名单：不接收任意列名拼串，避免调用方把 students 的任意列（含 is_provisional）
// 漏到接口响应里。要新加一套就在这里加一行，全库只有这一处定义。
const COLUMN_SETS = {
  // 只要「是谁」：班干部成员这类把姓名另存一份快照的表，用 id 定人即可
  base: 'id, 姓名',
  // 加减分：记录行冗余存「学号」用于导出与按学号查重
  score: 'id, 姓名, 学号',
  // 请假：新增请假时把家长/学生联系电话带进记录行
  leave: 'id, 姓名, 家长联系电话, 学生联系电话',
}

function colsOf(set) {
  // 未知列集合直接抛：宁可启动即炸，也不让 `SELECT undefined FROM students` 这种
  // 静默错位把响应里的字段变成 undefined（前端表现是「联系方式一列突然全空」）。
  const cols = COLUMN_SETS[set]
  if (!cols) throw new Error(`未知的学生列集合: ${set}`)
  return cols
}

// 按主键。查不到返回 null（原实现一处返回 undefined、一处返回 null，这里统一成 null）。
function findById(id, set) {
  return db.prepare(`SELECT ${colsOf(set)} FROM students WHERE id = ?`).get(id) || null
}

// 按学号。students.学号 没有 UNIQUE 约束（可空、可重复 —— 转学生、借读生常常没有学号，
// 手工录入也拦不住重复），所以这里**返回数组**，把「学号是否唯一」的判断交给调用方：
//   · 1 条  → 唯一命中，可以定人
//   · ≥2 条 → 学号重复，不能静默取第一条。取第一条等于替用户挑人，
//             而且挑错的记录再也查不出来（导入时尤其明显：整张表 quietly 记到同一个学生头上）
//   · 0 条  → 名册里没有这个学号
// 只取 2 条：知道「不止一个」就够了，重复名单再长也没人要看（与 findByName 同口径）。
function findStudentsByXuehao(xuehao, set) {
  return db.prepare(
    `SELECT ${colsOf(set)} FROM students WHERE 学号 = ? ORDER BY id LIMIT 2`
  ).all(xuehao)
}

// 同名最多取两条：调用方据此区分「唯一命中」与「重名歧义」。
// 取 2 条而不是全部 —— 只知道「不止一个」就够了，重名名单再长也没人要看。
function findByName(name, set) {
  return db.prepare(
    `SELECT ${colsOf(set)} FROM students WHERE 姓名 = ? ORDER BY id LIMIT 2`
  ).all(name)
}

module.exports = { COLUMN_SETS, findById, findStudentsByXuehao, findByName }
