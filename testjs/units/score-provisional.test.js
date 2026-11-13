// =========================================================================
// score-provisional.test.js —— 加分记录里的名册外姓名（v6 · 临时学生复用）
//
// 背景：加分弹窗以前只能从名册里选学生，转学生/借读/别班临时参加的人记不了分。
// 现在允许直接写名字，由后端走与值日/座位/分组同一套 provisionalStudents 解析：
// 建 is_provisional=1 的学生并回填 student_id，引用就有稳定身份（转正只改状态位）。
// 本用例锁四条解析路径：
//   ① 名册外姓名 → 建临时学生，记录 student_id 指向它；
//   ② 再写同名 → 复用那条临时学生，绝不重复建；
//   ③ 名册里已有唯一同名正式学生 → 直接用正式学生，不建临时；
//   ④ 正式名册有多个同名 → 409 + 候选，不替用户挑、也不建临时；
//   ⑤ 空姓名保持原行为（student_id 留空），不能被解析器拦成 400。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendDb } = require('./_db-express-fixture.cjs')

// 公共夹具同时把 db.js（Proxy）和 dbManager.current 指到内存库 ——
// tableService 经由 provisionalStudents 建档走的正是 Proxy，少改一处就会打到真实库。
const fx = createBackendDb({ label: 'score-provisional' })
const conn = fx.conn

let base
test.before(async () => {
  base = await fx.mount('/api/scores', 'student-backend/routes/scores.js')
})
test.after(() => fx.close())

const post = async (body) => {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

const scoreOf = (id) => conn.prepare('SELECT * FROM score_records WHERE id = ?').get(id)
const studentsNamed = (name) => conn.prepare('SELECT * FROM students WHERE 姓名 = ?').all(name)

test('名册外姓名：建临时学生并把 student_id 指过去', async () => {
  const r = await post({ 姓名: '转学生甲', 类型: '加分', 项目: '课堂表现', 分值: 3 })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const row = scoreOf(r.json.id)
  assert.ok(row.student_id, '必须回填 student_id')

  const stu = studentsNamed('转学生甲')
  assert.equal(stu.length, 1, '应新建一条学生记录')
  assert.equal(stu[0].is_provisional, 1, '新建的必须是临时学生')
  assert.equal(row.student_id, stu[0].id, '记录要指向这条临时学生')
})

test('再写同名：复用同一条临时学生，不重复建', async () => {
  await post({ 姓名: '转学生乙', 类型: '加分', 项目: '作业', 分值: 2 })
  const r = await post({ 姓名: '转学生乙', 类型: '加分', 项目: '作业', 分值: 1 })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const stu = studentsNamed('转学生乙')
  assert.equal(stu.length, 1, '同名只该有一条临时学生')
  assert.equal(scoreOf(r.json.id).student_id, stu[0].id, '两条成绩都指向同一个人')
})

test('名册里已有唯一同名正式学生：直接用正式学生，不建临时', async () => {
  conn.prepare('INSERT INTO students (姓名, 学号, is_provisional) VALUES (?,?,0)').run('正式生丙', '2026001')
  const formal = conn.prepare("SELECT id FROM students WHERE 姓名 = '正式生丙'").get()

  const r = await post({ 姓名: '正式生丙', 类型: '加分', 项目: '课堂表现', 分值: 5 })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(scoreOf(r.json.id).student_id, formal.id, '应命中正式学生')
  assert.equal(studentsNamed('正式生丙').length, 1, '不能多建一条临时学生')
})

test('名册里有多个同名正式学生：409 + 候选，不替用户挑也不建临时', async () => {
  conn.prepare('INSERT INTO students (姓名, 学号, is_provisional) VALUES (?,?,0)').run('重名丁', '2026002')
  conn.prepare('INSERT INTO students (姓名, 学号, is_provisional) VALUES (?,?,0)').run('重名丁', '2026003')

  const r = await post({ 姓名: '重名丁', 类型: '加分', 项目: '课堂表现', 分值: 5 })
  assert.equal(r.status, 409, '重名必须交回前端，不能猜')
  assert.equal((r.json.candidates || []).length, 2, '要带回候选让学生选')
  assert.equal(studentsNamed('重名丁').length, 2, '不得额外建临时学生')
})

test('空姓名：保持原行为（student_id 留空），不被解析器拦成 400', async () => {
  const r = await post({ 姓名: '', 类型: '加分', 项目: '课堂表现', 分值: 1 })
  assert.equal(r.status, 200, '空姓名是历史允许的写法，不能变成错误')
  assert.equal(scoreOf(r.json.id).student_id, null)
})
