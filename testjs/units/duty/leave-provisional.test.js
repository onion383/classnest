// =========================================================================
// leave-provisional.test.js —— 请假里的名册外姓名（P0-2 / P0-3 口径对齐）
//
// 背景：加减分会给名册外的姓名建临时学生（is_provisional=1）并回填 student_id，
// 请假原先直接落 null。同一个人从两条路进来身份不一样，改名/统计就对不上。
// 现在请假的两条入口（单条新增、Excel 导入）都走同一套 provisionalStudents 解析。
//
// 本用例锁六条：
//   ① 单条新增名册外姓名 → 建临时学生 + 回填 student_id；
//   ② 再传同名 → 复用同一条，不重复建；
//   ③ 名册里唯一同名正式学生 → 用正式学生，不建临时；
//   ④ 名册里多个同名 → 仍 200 但 student_id 留空（这条路没有候选选择 UI，
//      回 409 会把原本能落的记录直接丢掉），不猜也不建；
//   ⑤ 空姓名 → 仍 200 且 student_id 留空（历史允许的写法）；
//   ⑥ 导入名册外姓名 → 建临时学生；导入重名 → 该行留空但整批照常成功
//      （导入是整批一个事务，不能为了补 id 把能导的行一起废掉）。
// =========================================================================
const test = require('node:test')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'leave-provisional' })
// 连接随 reset 变化：每个用例独立库，写路径互不累积（T06-04）
let conn = fx.conn

let base
test.before(async () => {
  base = await fx.mount('/api/leaves', 'student-backend/routes/leaves.js')
})
test.beforeEach(() => { conn = fx.reset() })
test.after(() => fx.close())

const postTo = async (path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}
const post = (body) => postTo('', body)
const postImport = (body) => postTo('/import', body)

const leaveOf = (id) => conn.prepare('SELECT * FROM leave_records WHERE id = ?').get(id)
const studentsNamed = (name) => conn.prepare('SELECT * FROM students WHERE 姓名 = ?').all(name)
const addStudent = (name, xuehao, provisional = 0) =>
  conn.prepare('INSERT INTO students (姓名, 学号, is_provisional) VALUES (?,?,?)').run(name, xuehao, provisional)

// 请假窗口：结束必须晚于开始（assertLeaveWindow），否则 400 盖住真正要测的分支
const leaveBody = (extra) => ({ 开始时间: '2026-11-10', 结束时间: '2026-11-12', 类型: '病假', ...extra })

test('单条新增：名册外姓名建临时学生并回填 student_id', async () => {
  const r = await post(leaveBody({ 姓名: '请假临时甲' }))
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const row = leaveOf(r.json.id)
  assert.ok(row.student_id, '必须回填 student_id，否则这条记录只剩一个字符串')
  const stu = studentsNamed('请假临时甲')
  assert.equal(stu.length, 1)
  assert.equal(stu[0].is_provisional, 1, '新建的必须是临时学生')
  assert.equal(row.student_id, stu[0].id)
})

test('单条新增：再传同名复用同一条临时学生', async () => {
  await post(leaveBody({ 姓名: '请假临时乙' }))
  const r = await post(leaveBody({ 姓名: '请假临时乙' }))
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const stu = studentsNamed('请假临时乙')
  assert.equal(stu.length, 1, '同名只能有一条临时学生')
  assert.equal(leaveOf(r.json.id).student_id, stu[0].id)
})

test('单条新增：名册唯一同名正式学生时用正式学生，不建临时', async () => {
  addStudent('请假正式丙', '2026101')
  const formal = conn.prepare("SELECT id FROM students WHERE 姓名 = '请假正式丙'").get()
  const r = await post(leaveBody({ 姓名: '请假正式丙' }))
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(leaveOf(r.json.id).student_id, formal.id)
  assert.equal(studentsNamed('请假正式丙').length, 1)
})

test('单条新增：名册多个同名 → 200 但 student_id 留空，不猜也不建临时', async () => {
  addStudent('请假重名丁', '2026102')
  addStudent('请假重名丁', '2026103')
  const r = await post(leaveBody({ 姓名: '请假重名丁' }))
  // 刻意不是 409：请假可以从「表格内直接新增一行」进来，那条路没有候选选择 UI，
  // 回 409 会把原本能落的记录直接丢掉。所以歧义时退回老行为（只存姓名）。
  assert.equal(r.status, 200, '没有选择 UI 的入口不能因为歧义而拒绝落库')
  assert.equal(leaveOf(r.json.id).student_id, null, '歧义时不替用户挑人')
  assert.equal(studentsNamed('请假重名丁').length, 2, '不得额外建临时学生')
})

test('单条新增：空姓名仍是 200 且 student_id 留空', async () => {
  const r = await post(leaveBody({ 姓名: '' }))
  assert.equal(r.status, 200, '空姓名是历史允许的写法，不能被解析器拦成 400')
  assert.equal(leaveOf(r.json.id).student_id, null)
})

test('导入：名册外姓名建临时学生并回填 id', async () => {
  const r = await postImport({
    fields: ['姓名', '开始时间', '结束时间'],
    rows: [['请假导入戊', '2026-11-10', '2026-11-12']],
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const created = r.json.created[0]
  assert.ok(created.student_id, '导入也要回填 student_id')
  const stu = studentsNamed('请假导入戊')
  assert.equal(stu.length, 1)
  assert.equal(stu[0].is_provisional, 1)
  assert.equal(created.student_id, stu[0].id)
})

test('导入：重名行留空但整批不失败（不把能导的行一起废掉）', async () => {
  addStudent('请假导入重名己', '2026104')
  addStudent('请假导入重名己', '2026105')
  const r = await postImport({
    fields: ['姓名', '开始时间', '结束时间'],
    rows: [
      ['请假导入重名己', '2026-11-10', '2026-11-12'],
      ['请假导入正常庚', '2026-11-10', '2026-11-12'],
    ],
  })
  assert.equal(r.status, 200, '重名只是这一行无法定人，不该让整批 400')
  assert.equal(r.json.created.length, 2, '两行都要导入成功')
  assert.equal(r.json.created[0].student_id, null, '歧义行留空，不猜是哪一位')
  assert.ok(r.json.created[1].student_id, '另一行仍然正常回填')
  assert.equal(studentsNamed('请假导入重名己').length, 2, '歧义时不能多建临时学生')
})

test('导入：学号命中时优先按学号认人，同名歧义不介入', async () => {
  addStudent('请假导入学号辛', '2026106')
  addStudent('请假导入学号辛', '2026107')
  const r = await postImport({
    fields: ['姓名', '学号', '开始时间', '结束时间'],
    rows: [['请假导入学号辛', '2026107', '2026-11-10', '2026-11-12']],
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const target = conn.prepare("SELECT id FROM students WHERE 学号 = '2026107'").get()
  assert.equal(r.json.created[0].student_id, target.id, '学号能唯一定人时不需要走姓名歧义判定')
})
