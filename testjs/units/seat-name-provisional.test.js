// =========================================================================
// seat-name-provisional.test.js —— 座位格里的姓名要变成「一个人」（P1-5）
//
// 背景：`useSeatGrid.resolveCellValue` 只在名册里查得到学生时才存 id，名册外的
// 姓名会一直以**字符串**形式留在 seats 里。后果是静默的：
//   · 名册里永远没有这个人（座位指数、点名器、智能排表的「已入座」都看不见他）；
//   · 每次保存都还是字符串，除非用户手动再选一次候选人。
//
// 现在三条写路径（单格 PATCH / 整表 PUT / 模板 PUT）都在写库前认人：
//   ① 名册外姓名 → 建临时学生，并把格子改写成 id（之后读出来就是标准形态）；
//   ② 名册里唯一同名 → 复用正式学生，不建临时；
//   ③ 重名歧义 / 建档失败 → 保持字符串（宁可认不出，也不能认错人）。
//
// 另锁一条事务性质：认人会写库（建临时学生），所以它必须和校验/写座位同一个事务 ——
// 校验失败时不能留下「人建了、座位没存」（值日那边踩过同样的坑）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'seat-name-provisional' })

test.before(() => fx.mount('/api/seats', 'student-backend/routes/seats.js'))
test.after(() => fx.close())

const all = (sql, ...args) => fx.conn.prepare(sql).all(...args)
const studentsNamed = (name) => all('SELECT id, 姓名, is_provisional FROM students WHERE 姓名 = ? ORDER BY id', name)
const addStudent = (name, xuehao = '') =>
  fx.conn.prepare("INSERT INTO students (position, 学号, 姓名) VALUES ((SELECT COALESCE(MAX(position),0)+1 FROM students), ?, ?)").run(xuehao, name)

const patchCell = (row, col, value) => fx.call('PATCH', '/cell', { row, col, value })
const getSeats = async () => {
  const r = await fx.call('GET', '/')
  assert.equal(r.status, 200, r.text.slice(0, 200))
  return r.json.seats
}
const putSeats = (seats, rows = 2, cols = 3) => fx.call('PUT', '/', {
  rows,
  cols,
  seats,
  // 全座位（0），形状必须与 rows/cols 一致
  types: Array.from({ length: rows }, () => Array(cols).fill(0)),
})

test('单格写名册外姓名：建临时学生，且格子里存的是 id', async () => {
  fx.reset()
  const r = await patchCell(0, 0, '坐外甲')
  assert.equal(r.status, 200, r.text.slice(0, 300))

  const stu = studentsNamed('坐外甲')
  assert.equal(stu.length, 1, '名册外姓名必须建档，否则座位指数/点名器永远看不到这个人')
  assert.equal(stu[0].is_provisional, 1)

  const seats = await getSeats()
  assert.equal(seats[0][0], stu[0].id, '认出来之后就该存 id，不能继续留字符串')
})

test('单格写名册里唯一的同名：复用正式学生，不建临时', async () => {
  fx.reset()
  addStudent('坐正乙', '2026001')
  const formal = fx.conn.prepare("SELECT id FROM students WHERE 姓名 = '坐正乙'").get()

  // 默认布局是 6 行 × 13 列，奇数列是走廊 —— 只能写偶数列
  const r = await patchCell(0, 2, '坐正乙')
  assert.equal(r.status, 200, r.text.slice(0, 300))
  assert.equal((await getSeats())[0][2], formal.id)
  assert.equal(studentsNamed('坐正乙').length, 1, '不该为已有正式学生再建一条临时学生')
})

test('单格写重名姓名：保持字符串，不建档也不替用户挑人', async () => {
  fx.reset()
  addStudent('坐重丙', '2026002')
  addStudent('坐重丙', '2026003')

  const r = await patchCell(0, 4, '坐重丙')
  assert.equal(r.status, 200, r.text.slice(0, 300), '认不出人不该让座位存不进去')
  assert.equal((await getSeats())[0][4], '坐重丙', '歧义时保持原字符串（认错人比认不出更糟）')
  assert.equal(studentsNamed('坐重丙').length, 2, '重名时不得多建临时学生')
})

test('整表 PUT：名册外姓名建档并改写成 id', async () => {
  fx.reset()
  const r = await putSeats([[null, '整表丁', null], [null, null, null]])
  assert.equal(r.status, 200, r.text.slice(0, 300))

  const stu = studentsNamed('整表丁')
  assert.equal(stu.length, 1)
  const seats = await getSeats()
  assert.equal(seats[0][1], stu[0].id)
})

test('整表 PUT 校验失败：建出来的临时学生必须一起回滚', async () => {
  fx.reset()
  // 同一个提交里既有名册外姓名（会建档），又有一个不存在的 id（会让校验失败）
  const r = await putSeats([['回滚戊', 999999, null], [null, null, null]])
  assert.equal(r.status, 400, `应被校验拦下，实际 ${r.status}：${r.text.slice(0, 200)}`)

  assert.equal(studentsNamed('回滚戊').length, 0, '座位没存进去，名册里却多出一个人 —— 值日那条路径踩过同样的坑')
  const seats = await getSeats()
  assert.ok(seats.flat().every((v) => v == null), '失败的保存不能留下半截座位表')
})

test('整表 PUT 里已有数字 id 的格子不受影响', async () => {
  fx.reset()
  addStudent('坐正己', '2026004')
  const formal = fx.conn.prepare("SELECT id FROM students WHERE 姓名 = '坐正己'").get()

  const r = await putSeats([[formal.id, '整表庚', null], [null, null, null]])
  assert.equal(r.status, 200, r.text.slice(0, 300))
  const seats = await getSeats()
  assert.equal(seats[0][0], formal.id, '数字 id 应原样保留')
  assert.equal(typeof seats[0][1], 'number', '同一行的姓名也要被认成 id')
})

test('模板 PUT：同样认人（模板里的姓名不再以字符串遗留下来）', async () => {
  fx.reset()
  const r = await fx.call('PUT', '/master', {
    rows: 2,
    cols: 2,
    seats: [['模板辛', null], [null, null]],
    types: [[0, 0], [0, 0]],
  })
  assert.equal(r.status, 200, r.text.slice(0, 300))

  const stu = studentsNamed('模板辛')
  assert.equal(stu.length, 1)
  const tpl = await fx.call('GET', '/master')
  assert.equal(tpl.json.seats[0][0], stu[0].id)
})
