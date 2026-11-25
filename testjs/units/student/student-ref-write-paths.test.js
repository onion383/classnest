// =========================================================================
// student-ref-write-paths.test.js —— 「写入路径有没有认人」的验收判据
//
// 背景：临时学生建档（ensureProvisionalStudent）此前只覆盖了「新增」的一半入口。
// 审计（2026-11-17）实测出 6 个缺口，这个文件逐个盯住：
//   ① 加减分 / 请假「编辑」改姓名 → 必须重新认人（原来 student_id 留在旧学生身上）
//   ② 加减分导入名册外姓名 → 必须建档（原来只存字符串，与请假导入不一致）
//   ③ 学号重复 → 必须返回歧义，不能 .get() 静默取第一条
//   ④ AI 行式写加减分 / 请假 → 也要认人（ROW_STUDENT_REFS 覆盖面）
//   ⑤ AI 整块写座位表 → 也要建档（原来只校验不解析）
//
// 为什么每一条都要有：这些路径的失效都不是报错，而是「界面上看起来正常、
// 数据已经错了」。只有断言到库里的 student_id 才能抓住。
// =========================================================================
const { test } = require('node:test')
const { abs } = require('#testjs/paths')
const { extractFunctionDecl } = require('#testjs/units/_mechanism.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'student-ref-write-paths' })

const all = (sql, ...p) => fx.conn.prepare(sql).all(...p)
const one = (sql, ...p) => fx.conn.prepare(sql).get(...p)

test.before(async () => {
  await fx.mount('/api/scores', 'student-backend/routes/scores.js')
  await fx.mount('/api/leaves', 'student-backend/routes/leaves.js')
  await fx.mount('/api/ai', 'student-backend/routes/ai/ai.dataRoutes.js')
})
test.after(() => fx.close())

// 每个用例都从同一份小名册开始
function seed(extra = []) {
  fx.reset({ seed: (c) => {
    c.prepare('INSERT INTO students (id, 姓名, 学号, position) VALUES (1, ?, ?, 1)').run('张三', 'A001')
    c.prepare('INSERT INTO students (id, 姓名, 学号, position) VALUES (2, ?, ?, 2)').run('李四', 'A002')
    for (const s of extra) {
      c.prepare('INSERT INTO students (id, 姓名, 学号, position) VALUES (?, ?, ?, ?)')
        .run(s.id, s.姓名, s.学号 || null, s.id)
    }
  }})
}

const studentByName = (n) => one('SELECT * FROM students WHERE 姓名 = ?', n)

// ============ ① 编辑改姓名必须重认 ============

test('加减分编辑改成名册外姓名：建档并把 student_id 换过去', async () => {
  seed()
  await fx.call('POST', '/api/scores', { 姓名: '张三', 项目: '值日', 分值: 1 })
  const row = one('SELECT * FROM score_records ORDER BY id DESC LIMIT 1')
  assert.equal(row.student_id, 1, '前置：新增时按姓名认到了张三')

  const r = await fx.call('PUT', `/api/scores/${row.id}`, { 姓名: '转学甲' })
  assert.equal(r.status, 200)

  const after = one('SELECT * FROM score_records WHERE id = ?', row.id)
  const stu = studentByName('转学甲')
  assert.ok(stu, '名册外的姓名必须落一条学生记录')
  assert.equal(after.student_id, stu.id, 'id 必须换成新学生；留在旧 id 上就是把加分算给了别人')
  assert.equal(after.姓名, '转学甲')
})

test('加减分只改分值（姓名原样带回）：不重认，id 不动', async () => {
  seed()
  await fx.call('POST', '/api/scores', { 姓名: '张三', 项目: '值日', 分值: 1 })
  const row = one('SELECT * FROM score_records ORDER BY id DESC LIMIT 1')

  // 前端表格 PUT 会带整行 —— 姓名没变也必须不触发重认
  const r = await fx.call('PUT', `/api/scores/${row.id}`, { 姓名: '张三', 分值: 5 })
  assert.equal(r.status, 200)
  const after = one('SELECT * FROM score_records WHERE id = ?', row.id)
  assert.equal(after.student_id, 1, '姓名没变就不该动 id')
  assert.equal(after.分值, 5)
})

test('加减分改成同名歧义的姓名：id 清空、姓名照存，不替用户猜', async () => {
  seed([{ id: 3, 姓名: '同名' }, { id: 4, 姓名: '同名' }])
  await fx.call('POST', '/api/scores', { 姓名: '张三', 项目: '值日', 分值: 1 })
  const row = one('SELECT * FROM score_records ORDER BY id DESC LIMIT 1')

  const r = await fx.call('PUT', `/api/scores/${row.id}`, { 姓名: '同名' })
  assert.equal(r.status, 200, '表格内改名没有候选选择 UI，歧义不能变成 409')
  const after = one('SELECT * FROM score_records WHERE id = ?', row.id)
  assert.equal(after.student_id, null, '两个同名分不出是谁，宁可留空也不替用户选')
  assert.equal(after.姓名, '同名', '姓名照存 —— 留空 id 不该连姓名一起丢')
})

test('加减分清空姓名：student_id 一并清空', async () => {
  seed()
  await fx.call('POST', '/api/scores', { 姓名: '张三', 项目: '值日', 分值: 1 })
  const row = one('SELECT * FROM score_records ORDER BY id DESC LIMIT 1')

  const r = await fx.call('PUT', `/api/scores/${row.id}`, { 姓名: '' })
  assert.equal(r.status, 200)
  const after = one('SELECT * FROM score_records WHERE id = ?', row.id)
  assert.equal(after.student_id, null, '没有姓名就没有人，留着旧 id 等于把记录挂在一个空白名下')
})

test('请假编辑改成名册外姓名：建档并把 student_id 换过去', async () => {
  seed()
  await fx.call('POST', '/api/leaves', { 姓名: '李四', 开始时间: '2026-11-01', 结束时间: '2026-11-02' })
  const row = one('SELECT * FROM leave_records ORDER BY id DESC LIMIT 1')
  assert.equal(row.student_id, 2)

  const r = await fx.call('PUT', `/api/leaves/${row.id}`, { 姓名: '转学乙' })
  assert.equal(r.status, 200)
  const after = one('SELECT * FROM leave_records WHERE id = ?', row.id)
  const stu = studentByName('转学乙')
  assert.ok(stu, '名册外的姓名必须落一条学生记录')
  assert.equal(after.student_id, stu.id)
})

test('请假只改状态（姓名原样带回）：不重认，id 不动', async () => {
  seed()
  await fx.call('POST', '/api/leaves', { 姓名: '李四', 开始时间: '2026-11-01', 结束时间: '2026-11-02' })
  const row = one('SELECT * FROM leave_records ORDER BY id DESC LIMIT 1')

  const r = await fx.call('PUT', `/api/leaves/${row.id}`, { 姓名: '李四', 状态: '已返校', 返校时间: '2026-11-03' })
  assert.equal(r.status, 200)
  const after = one('SELECT * FROM leave_records WHERE id = ?', row.id)
  assert.equal(after.student_id, 2)
  assert.equal(after.状态, '已返校')
})

// ============ ② 加减分导入必须建档 ============

test('加减分导入名册外姓名：建档并回填 student_id', async () => {
  seed()
  const r = await fx.call('POST', '/api/scores/import', {
    fields: ['姓名', '项目', '分值'],
    rows: [['导入丙', '值日', '3']],
    mode: 'personal',
  })
  assert.equal(r.status, 200)
  const row = one('SELECT * FROM score_records ORDER BY id DESC LIMIT 1')
  const stu = studentByName('导入丙')
  assert.ok(stu, '与请假导入同口径：名册外姓名要建档')
  assert.equal(row.student_id, stu.id, '不建档的话这条记录只剩一个字符串，改名/统计都对不上人')
})

// ============ ③ 学号重复必须返回歧义 ============

test('导入撞上学号重复：不静默取第一条', async () => {
  // 甲乙同学号 A009；导入一行写「丙」+ A009
  seed([{ id: 5, 姓名: '重复甲', 学号: 'A009' }, { id: 6, 姓名: '重复乙', 学号: 'A009' }])
  const r = await fx.call('POST', '/api/scores/import', {
    fields: ['姓名', '学号', '项目', '分值'],
    rows: [['导入丁', 'A009', '值日', '2']],
    mode: 'personal',
  })
  assert.equal(r.status, 200)
  const row = one('SELECT * FROM score_records ORDER BY id DESC LIMIT 1')
  assert.notEqual(row.student_id, 5, '不能静默认成重复学号里的第一个人')
  assert.notEqual(row.student_id, 6, '也不能认成第二个人')
  const stu = studentByName('导入丁')
  assert.ok(stu, '学号歧义时退回按姓名认人，名册外就建档')
  assert.equal(row.student_id, stu.id)
})

// ============ ④ AI 行式写也要认人 ============

test('AI 行式写入的映射覆盖加减分与请假', () => {
  const { ROW_STUDENT_REFS, applyRowStudentRef } = require('../../../student-backend/services/provisionalStudents')
  assert.deepEqual(ROW_STUDENT_REFS.score_records, { name: '姓名', id: 'student_id' })
  assert.deepEqual(ROW_STUDENT_REFS.leave_records, { name: '姓名', id: 'student_id' })

  seed()
  const row = { 姓名: 'AI建档甲', student_id: null }
  applyRowStudentRef('score_records', row)
  const stu = studentByName('AI建档甲')
  assert.ok(stu, 'AI 批量写加减分时名册外姓名也要建档')
  assert.equal(row.student_id, stu.id)
})

test('AI 行式写加减分：给了有效 id 时姓名跟权威走', () => {
  const { applyRowStudentRef } = require('../../../student-backend/services/provisionalStudents')
  seed()
  // 前端/模型填了个错的姓名，但 id 是对的 —— 快照不许覆盖权威
  const row = { 姓名: '写错的名字', student_id: 1 }
  applyRowStudentRef('score_records', row)
  assert.equal(row.student_id, 1)
  assert.equal(row.姓名, '张三', '有 id 时姓名一律以 students.姓名 为准')
})

// ============ ⑤ AI 整块写座位表也要建档 ============

test('AI 整块写座位表：名册外姓名建档并落成 id', async () => {
  seed()
  const docRow = one('SELECT id FROM seat_layout')
  assert.ok(docRow, '前置：seat_layout 视图要有一行')

  const r = await fx.call('POST', '/api/ai/doc', {
    table: 'seat_layout',
    id: docRow.id,
    values: { seats: [['座位外的丙', null], [null, null]] },
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))

  const stu = studentByName('座位外的丙')
  assert.ok(stu, 'AI 写进来的名字也要建档，否则名册里查不到这个人')
  const saved = one('SELECT seats FROM seat_layout')
  const grid = typeof saved.seats === 'string' ? JSON.parse(saved.seats) : saved.seats
  assert.equal(grid[0][0], stu.id, '落库的必须是学生 id，不能是姓名字符串')

  // 静态判据只作双保险：行为测试已经覆盖，但它能挡住「把解析挪走、靠别处兜底」的重构
  const src = fs.readFileSync(
    abs('student-backend/routes/ai/ai.dataRoutes.js'), 'utf8'
  )
  const body = extractFunctionDecl(src, 'applyDocWrite')
  // P6 起改用详细版（还要回传新建了谁），所以两种写法都算数 —— 但「完全不解析」仍然要红
  // @pin student-backend/routes/ai/ai.dataRoutes.js#applyDocWrite
  assert.match(body, /resolveNameCells(?:Detailed)?\(/, 'applyDocWrite 必须自己解析座位表姓名')
})
