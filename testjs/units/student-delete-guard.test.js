// =========================================================================
// student-delete-guard.test.js —— 删学生不许留孤儿（v6 · N2-05）
//
// 事故：`DELETE /api/students/:id` 是通用删除入口，只删主表。学生的请假/加分/座位/值日/
// 小组/班干部全是松耦合（老数据只存姓名），于是直调这个端点就留下六类孤儿，
// 而且不报错 —— 值日指数与名单统计继续把已删除的人算进去。
//
// 修法：在 deleteRow 这个「删一行」的原语里守 —— 默认拒，调用方显式声明已处理才放行。
// 判据：① 有关联 → 400 且数据原样 ② 无关联 → 正常删 ③ 显式放行能删
//       ④ 别的表不受影响 ⑤ 接线：两条删除路径各自传对了参数
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'stu-del' })
const { createDynamicTableRouter } = require('../../student-backend/routes/dynamicTable')
const { deleteRow } = require('../../student-backend/services/tableService')

test.before(() => fx.mount('/api/students', createDynamicTableRouter('students', { protectedColumns: ['学号', '姓名'] })))
test.after(() => fx.close())

function fresh() {
  return fx.reset()
}
function seedStudent(name = '张三') {
  return fx.conn.prepare(
    "INSERT INTO students (position, 学号, 年级, 班级, 姓名, 年龄, 家长联系电话, 备注, is_provisional) VALUES (1,'001','初二','3班',?,14,'1','',0)"
  ).run(name).lastInsertRowid
}
const count = (t, id) => fx.conn.prepare(`SELECT COUNT(*) c FROM ${t} WHERE student_id = ?`).get(id).c

test('有关联记录时，通用 DELETE 拒绝并说清怎么办', async () => {
  fresh()
  const id = seedStudent()
  fx.conn.prepare("INSERT INTO score_records (student_id, 姓名, 类型, 项目, 分值) VALUES (?,'张三','加分','作业',2)").run(id)

  const r = await fx.call('DELETE', `/api/students/${id}`)
  assert.equal(r.status, 400, r.text.slice(0, 200))
  assert.match(r.json.error, /一并删除/, '要告诉用户走哪条路，不能只说「失败」')
  assert.match(r.json.error, /加分 1/, '要说清楚是哪一类、几条')

  assert.equal(fx.conn.prepare('SELECT COUNT(*) c FROM students WHERE id = ?').get(id).c, 1, '学生不能被删')
  assert.equal(count('score_records', id), 1, '关联不能被偷偷清掉（会绕过撤销）')
})

test('没有关联记录时正常删除', async () => {
  fresh()
  const id = seedStudent()
  const r = await fx.call('DELETE', `/api/students/${id}`)
  assert.equal(r.status, 200, r.text.slice(0, 200))
  assert.equal(fx.conn.prepare('SELECT COUNT(*) c FROM students WHERE id = ?').get(id).c, 0)
})

test('「一并删除」路径显式放行：purge 之后能删掉学生', async () => {
  fresh()
  const id = seedStudent()
  fx.conn.prepare("INSERT INTO score_records (student_id, 姓名, 类型, 项目, 分值) VALUES (?,'张三','加分','作业',2)").run(id)
  // 模拟 delete-with-relations：用户勾了「加分」→ 先清关联，再删主表（带放行标记）
  fx.conn.prepare('DELETE FROM score_records WHERE student_id = ?').run(id)
  assert.doesNotThrow(() => deleteRow('students', id, { allowStudentOrphans: true }))
  assert.equal(fx.conn.prepare('SELECT COUNT(*) c FROM students WHERE id = ?').get(id).c, 0)
})

test('放行标记只在明确传入时生效：不传就是拦', () => {
  fresh()
  const id = seedStudent()
  fx.conn.prepare("INSERT INTO score_records (student_id, 姓名, 类型, 项目, 分值) VALUES (?,'张三','加分','作业',2)").run(id)
  assert.throws(() => deleteRow('students', id), /一并删除/)
  assert.throws(() => deleteRow('students', id, {}), /一并删除/, '空对象不能当成放行')
})

test('其他表不受这条守卫影响：请假记录照常删', async () => {
  fresh()
  const id = seedStudent()
  const lid = fx.conn.prepare("INSERT INTO leave_records (student_id, 姓名, 类型, 开始时间, 结束时间, 状态) VALUES (?,'张三','事假','2026-11-01','2026-11-02','已返校')").run(id).lastInsertRowid
  assert.doesNotThrow(() => deleteRow('leave_records', lid))
  assert.equal(fx.conn.prepare('SELECT COUNT(*) c FROM leave_records WHERE id = ?').get(lid).c, 0)
})

test('接线：一并删除的调用点显式放行，通用入口不带', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const app = read('student-backend/app.js')
  assert.match(app, /deleteRow\('students', id, \{ allowStudentOrphans: true \}\)/, 'delete-with-relations 必须显式放行（否则 purge 完也删不掉）')
  const dyn = read('student-backend/routes/dynamicTable.js')
  assert.match(dyn, /deleteRow\(tableName, req\.params\.id, \{ minCount \}\)/, '通用 DELETE 不许传放行标记 —— 那就是留孤儿的入口')
})
