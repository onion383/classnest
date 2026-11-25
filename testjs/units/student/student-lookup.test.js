// =========================================================================
// student-lookup.test.js —— 学生「认人」的单源实现（services/studentLookup.js）
//
// 背景：加减分与请假各抄过一份 students 查询，列清单还不一样
// （加减分要学号，请假要双方联系电话）。收敛到一份语句之后，最容易出的事故是
// 「调用方点错列集合」：请假点了 'score' 就会静默丢两列联系方式，
// 页面表现是「电话那一列突然全空」，不报任何错。所以这里锁的是
// 「每套列集合包含什么、不含什么」，而不是「函数能返回一行」。
//
// 另锁三条历史口径：
//   ① 同名最多取 2 条 —— 调用方只靠「1 条 / 2 条」区分唯一命中与重名歧义；
//   ② 查不到统一返回 null（原实现一处 undefined、一处 null，会漏掉 `=== null` 判断）；
//   ③ 未知列集合立刻抛错，不拼出 `SELECT undefined FROM students`。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'student-lookup' })
const conn = fx.conn
// 夹具装好 db.js 的 Proxy 之后再 require，服务里的 `require('../db')` 才会落到内存库
const lookup = require('../../../student-backend/services/studentLookup')

test.after(() => fx.close())

function addStudent(row) {
  const cols = Object.keys(row)
  const info = conn.prepare(
    `INSERT INTO students (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...cols.map((c) => row[c]))
  return Number(info.lastInsertRowid)
}

test('score 列集合：带学号，不带联系电话', () => {
  const id = addStudent({ 姓名: '张小分', 学号: '20260101', 家长联系电话: '13800000001' })
  const row = lookup.findById(id, 'score')
  assert.deepEqual(Object.keys(row).sort(), ['id', '学号', '姓名'].sort())
  assert.equal(row.学号, '20260101')
  assert.ok(!('家长联系电话' in row), '加减分记录行不存联系方式，多带一列就是多余的数据搬运')
})

test('leave 列集合：带双方联系电话，不带学号', () => {
  const id = addStudent({
    姓名: '张小假', 学号: '20260102',
    家长联系电话: '13800000002', 学生联系电话: '13900000002',
  })
  const row = lookup.findById(id, 'leave')
  assert.deepEqual(
    Object.keys(row).sort(),
    ['id', '姓名', '家长联系电话', '学生联系电话'].sort()
  )
  assert.equal(row.家长联系电话, '13800000002')
  assert.equal(row.学生联系电话, '13900000002')
})

test('未知列集合直接抛错（防止静默拼出 undefined 列）', () => {
  const id = addStudent({ 姓名: '张三误' })
  assert.throws(() => lookup.findById(id, 'typo'), /未知的学生列集合/)
  assert.throws(() => lookup.findStudentsByXuehao('20260101', 'typo'), /未知的学生列集合/)
  assert.throws(() => lookup.findByName('张三误', 'typo'), /未知的学生列集合/)
})

test('findByName 最多取两条：三人同名也只回 2 条', () => {
  for (let i = 0; i < 3; i += 1) addStudent({ 姓名: '李同名', 学号: `2026020${i}` })
  const rows = lookup.findByName('李同名', 'score')
  assert.equal(rows.length, 2, '调用方只需要判「不止一个」，第 3 条起没有用处')
  assert.deepEqual(rows.map((r) => r.学号), ['20260200', '20260201'], '必须按 id 升序，结果才稳定')
})

test('查不到统一返回 null（不是 undefined）', () => {
  assert.equal(lookup.findById(999999, 'score'), null)
  assert.deepEqual(lookup.findStudentsByXuehao('不存在的学号', 'score'), [])
  assert.deepEqual(lookup.findByName('名册里没有的人', 'score'), [])
})

test('学号重复时返回 2 条：不静默取第一条', () => {
  addStudent({ 姓名: '重复学号甲', 学号: '20260999' })
  addStudent({ 姓名: '重复学号乙', 学号: '20260999' })
  const rows = lookup.findStudentsByXuehao('20260999', 'score')
  assert.equal(rows.length, 2, '.get() 会把歧义蒙住，导入时整张表就记到同一个人头上')
  assert.deepEqual(rows.map((r) => r.姓名), ['重复学号甲', '重复学号乙'], '按 id 升序，结果才稳定')
})
