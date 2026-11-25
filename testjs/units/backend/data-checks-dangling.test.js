// =========================================================================
// data-checks-dangling.test.js —— 数据体检的「孤立数据」规则
//
// 背景：项目有三处引用强度（id / 姓名字符串 / JSON 格子里的 id），而老库没有外键
// （P0-1 已把这个分叉显性化）。删学生、导入覆盖、AI 批量写入只要漏一处，
// 就留下「指向不存在的人」的行或格子 —— 界面上通常显示成空白，不报错。
//
// 这一组判据守两件事：
//   ① 五类孤立都能被体检报出来（加减分 / 请假 / 分组 / 座位 / 值日）；
//   ② **不要误报**：`student_id` 为空的「历史姓名行」不是孤儿 —— 它没有断链，
//      把它算成孤立然后让 AI 删掉，等于把用户真实数据当垃圾清掉。
//
// 体检工具本身**只报告、不删除**（schema 描述里写死），清理必须走提案让用户确认。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'data-checks-dangling' })
test.after(() => fx.close())

const { runChecks } = require('../../../student-backend/routes/ai/ai.tools/tools.executors/executors.checks')

const seedStudent = (id, name, sno = '') =>
  fx.conn.prepare('INSERT INTO students (id, 姓名, 学号) VALUES (?, ?, ?)').run(id, name, sno)

// 造孤儿的测试必须显式关外键：新建库有外键约束（P0-1 的收益），断链的数据根本插不进去。
// 体检规则防的是「老库没有外键」留下的孤儿，所以这里关掉约束才能复现那种数据 ——
// 不关的话，测到的是 SQLite 的约束，而不是我们的检测逻辑。
function allowDangling() { fx.conn.pragma('foreign_keys = OFF') }

// 取某条规则的命中明细（没有该规则时返回 []）
function hits(res, type) {
  const issue = (res.issues || []).find((x) => x.type === type)
  return issue ? issue.items : []
}

test('干净库：所有孤立规则都报 0', () => {
  fx.reset()
  seedStudent(1, '张三')
  const res = runChecks({ checks: ['score_dangling', 'leave_dangling', 'group_dangling', 'seat_dangling', 'duty_dangling'] })
  assert.equal(res.total, 0, JSON.stringify(res.issues))
  assert.equal(res.clean, true)
})

test('加减分：id 指向不存在的学生才算孤儿，id 为空的历史行不算', () => {
  fx.reset()
  allowDangling()
  seedStudent(1, '张三')
  const ins = fx.conn.prepare('INSERT INTO score_records (student_id, 姓名, 类型, 项目, 分值) VALUES (?, ?, ?, ?, ?)')
  ins.run(1, '张三', '加分', '作业', 1)
  ins.run(null, '李四', '加分', '作业', 1)
  ins.run(999, '王五', '加分', '作业', 1)

  const res = runChecks({ checks: ['score_dangling'] })
  const rows = hits(res, 'score_dangling')
  assert.equal(rows.length, 1, '只有 id=999 那条是孤儿')
  assert.equal(rows[0].student_id, 999)
  assert.equal(rows[0]['姓名'], '王五')
  assert.ok(rows[0].id > 0, '必须带上行 id —— 清理时才知道要删哪一条')
})

test('请假：同样只报悬空 id', () => {
  fx.reset()
  allowDangling()
  seedStudent(1, '张三')
  const ins = fx.conn.prepare('INSERT INTO leave_records (student_id, 姓名, 类型, 开始时间, 结束时间) VALUES (?, ?, ?, ?, ?)')
  ins.run(1, '张三', '病假', '2026-11-01', '2026-11-02')
  ins.run(null, '李四', '病假', '2026-11-01', '2026-11-02')
  ins.run(888, '赵六', '病假', '2026-11-01', '2026-11-02')

  const rows = hits(runChecks({ checks: ['leave_dangling'] }), 'leave_dangling')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].student_id, 888)
})

test('分组：id 悬空但姓名刚好和另一个人重合，也必须报出来', () => {
  fx.reset()
  allowDangling()
  seedStudent(1, '张子涵', '2026001')
  seedStudent(31, '张子涵', '2026002')
  const dim = fx.conn.prepare('INSERT INTO group_dimensions (name) VALUES (?)').run('学习小组')
  const g = fx.conn.prepare('INSERT INTO groups (dimension_id, name) VALUES (?, ?)').run(Number(dim.lastInsertRowid), '第1组')
  const ins = fx.conn.prepare('INSERT INTO group_members (group_id, student_id, member_name) VALUES (?, ?, ?)')
  ins.run(Number(g.lastInsertRowid), 31, '张子涵')     // 正常
  ins.run(Number(g.lastInsertRowid), 777, '张子涵')    // id 已断，但姓名撞上了 31 号
  ins.run(Number(g.lastInsertRowid), null, '名册外甲')  // 没有 id，按姓名判 —— 名册里没有

  const rows = hits(runChecks({ checks: ['group_dangling'] }), 'group_dangling')
  assert.equal(rows.length, 2, '断链的 id 和名册外的姓名各算一条')
  assert.deepEqual(rows.map((r) => r.student_id).sort(), [777, null].sort())
})

test('座位：格子里的 id 悬空要报，字符串格不参与这类', () => {
  fx.reset()
  seedStudent(1, '张三')
  fx.conn.prepare("UPDATE seat_slots SET seats = ?, cols = 2 WHERE kind = 'current'")
    .run(JSON.stringify([[1, 999], ['李四', null]]))

  const rows = hits(runChecks({ checks: ['seat_dangling'] }), 'seat_dangling')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].student_id, 999)
  assert.equal(rows[0]['排'], 1)
  assert.equal(rows[0]['列'], 2)
})

test('值日：id 悬空要报，且带上「项目 / 星期 / 第几个人」便于定位', () => {
  fx.reset()
  seedStudent(1, '张三')
  fx.conn.prepare("UPDATE duty_slots SET cells = ? WHERE kind = 'current'")
    .run(JSON.stringify({ daily: { 擦黑板: { 周一: [1, 666] } }, big: {} }))

  const rows = hits(runChecks({ checks: ['duty_dangling'] }), 'duty_dangling')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].student_id, 666)
  assert.equal(rows[0]['项目'], '擦黑板')
  assert.equal(rows[0]['星期'], '周一')
  assert.equal(rows[0]['第几个人'], 2)
})

test('体检只读：跑完数据一行没变', () => {
  fx.reset()
  allowDangling()
  seedStudent(1, '张三')
  fx.conn.prepare('INSERT INTO score_records (student_id, 姓名, 类型, 项目, 分值) VALUES (999, ?, ?, ?, 1)').run('王五', '加分', '作业')
  const before = fx.conn.prepare('SELECT COUNT(*) c FROM score_records').get().c
  runChecks({})
  const after = fx.conn.prepare('SELECT COUNT(*) c FROM score_records').get().c
  assert.equal(after, before, '体检不允许偷偷清理')
})
