// =========================================================================
// student-cascade-delete.test.js —— 删除学生的级联撤销（Q2-03 / §4-6）
//
// 事故面：界面上「一并删除」会把学生同时从**七处**抹掉（students / 请假 / 加减分 /
// 小组 / 班干部 / 座位 / 值日），但一条撤销记录都不登记；用户按 Ctrl+Z 什么都不会发生。
// 更糟的是若按「每处一条」去补，撤销要按七次，中途失败就留下半个人。
//
// 判据分两层：
//   ① 行为（真内存库 + 真执行器）：删除 → 撤销后七处**一起**回到原样；重做再一起删掉
//   ② 精确回填：撤销只放回被清掉的位置，删除之后用户对座位/值日的其它改动必须保留
//   ③ 接线：后端把 student 放进了 removed，前端登记成一条 student_cascade_delete
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')
const { createBackendDb, ROOT } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'student-cascade' })

const {
  studentRelations, purgeStudentRelations,
} = require('../../../student-backend/services/studentRelations')
const { executors } = require('../../../student-backend/routes/undo/undo.executors')
const { collectDutyRefs, removeDutyName } = require('../../../student-backend/services/dutyCells')

const ZHANG = { id: 1, position: 1, 姓名: '张三' }
const LI = { id: 2, position: 2, 姓名: '李四' }

// 种一个「七处都有引用」的场景
function freshDb() {
  const conn = fx.reset()

  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (?, ?, ?)').run(1, 1, '张三')
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (?, ?, ?)').run(2, 2, '李四')
  conn.prepare('INSERT INTO leave_records (id, student_id, 姓名) VALUES (1, 1, ?)').run('张三')
  conn.prepare('INSERT INTO score_records (id, student_id, 姓名) VALUES (1, 1, ?)').run('张三')
  conn.prepare('INSERT INTO group_dimensions (id, name) VALUES (1, ?)').run('宿舍')
  conn.prepare('INSERT INTO groups (id, dimension_id, name) VALUES (1, 1, ?)').run('302')
  conn.prepare('INSERT INTO group_members (id, group_id, member_name) VALUES (1, 1, ?)').run('张三')
  conn.prepare('INSERT INTO cadres (id, name) VALUES (1, ?)').run('班长')
  conn.prepare('INSERT INTO cadre_members (id, cadre_id, student_id, student_name) VALUES (1, 1, 1, ?)').run('张三')

  conn.prepare("UPDATE seat_slots SET rows = 2, cols = 2, seats = ?, types = ? WHERE kind = 'current'")
    .run(JSON.stringify([[1, 2], [null, null]]), JSON.stringify([[0, 0], [0, 0]]))
  conn.prepare("UPDATE duty_slots SET cells = ? WHERE kind = 'current'")
    .run(JSON.stringify({ daily: { 扫地: { 周一: ['张三', '李四'] } }, big: {} }))
  return conn
}

function seatsOf(conn) {
  return JSON.parse(conn.prepare("SELECT seats FROM seat_slots WHERE kind = 'current'").get().seats)
}
function dutyOf(conn) {
  return JSON.parse(conn.prepare("SELECT cells FROM duty_slots WHERE kind = 'current'").get().cells)
}

// 模拟后端路由：同一事务里 purge + 删主表，并产出 removed 快照
function cascadeDelete(conn) {
  let removed = null
  conn.transaction(() => {
    removed = {
      student: ZHANG,
      ...purgeStudentRelations(ZHANG, {
        leave: true, score: true, seat: true, duty: true, group: true, cadre: true,
      }),
    }
    conn.prepare('DELETE FROM students WHERE id = ?').run(ZHANG.id)
  })()
  return removed
}

function count(conn, table) {
  return conn.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c
}

// ---------------------------------------------------------------------------
// ① 行为：删除后，一条命令把七处一起恢复
// ---------------------------------------------------------------------------
test('Q2-03 复现：级联删除会把七处一起抹掉，且快照必须包含重建所需的完整信息', () => {
  const conn = freshDb()
  const removed = cascadeDelete(conn)

  assert.equal(count(conn, 'students'), 1, '学生应已删除')
  assert.equal(count(conn, 'leave_records'), 0)
  assert.equal(count(conn, 'score_records'), 0)
  assert.equal(count(conn, 'group_members'), 0)
  assert.equal(count(conn, 'cadre_members'), 0)
  assert.deepEqual(seatsOf(conn), [[null, 2], [null, null]], '只清张三那格')
  assert.deepEqual(dutyOf(conn).daily.扫地.周一, ['李四'])

  // 快照完整性：少了任何一组，撤销就只能恢复半个人
  assert.equal(removed.student.id, 1, '必须带回学生整行')
  assert.equal(removed.leaveRows.length, 1)
  assert.equal(removed.scoreRows.length, 1)
  assert.equal(removed.groupRows.length, 1)
  assert.equal(removed.cadreRows.length, 1)
  assert.deepEqual(removed.seatCells, [{ row: 0, col: 0, cell: 1, table: 'seat_layout' }])
  // 值日 slot 现在带 table 字段（#9a：模板也要统计/清理/撤销）；当前表场景是 duty_layout。
  assert.deepEqual(removed.dutySlots, [
    { mode: 'daily', item: '扫地', day: '周一', index: 0, value: '张三', table: 'duty_layout' },
  ])
})

test('撤销：一个 student_cascade_delete 命令把七处一起恢复', () => {
  const conn = freshDb()
  const removed = cascadeDelete(conn)

  executors.student_cascade_delete.undo(removed)

  assert.equal(count(conn, 'students'), 2)
  assert.equal(conn.prepare('SELECT 姓名 FROM students WHERE id = 1').get().姓名, '张三')
  assert.equal(count(conn, 'leave_records'), 1)
  assert.equal(count(conn, 'score_records'), 1)
  assert.equal(count(conn, 'group_members'), 1)
  assert.equal(count(conn, 'cadre_members'), 1)
  assert.deepEqual(seatsOf(conn), [[1, 2], [null, null]], '座位要原位放回')
  assert.deepEqual(dutyOf(conn).daily.扫地.周一, ['张三', '李四'], '值日要按原索引插回')
})

test('重做：同一条命令把七处再删一遍（不依赖索引，按姓名清值日）', () => {
  const conn = freshDb()
  const removed = cascadeDelete(conn)
  executors.student_cascade_delete.undo(removed)

  executors.student_cascade_delete.redo(removed)

  assert.equal(count(conn, 'students'), 1)
  assert.equal(count(conn, 'leave_records'), 0)
  assert.equal(count(conn, 'score_records'), 0)
  assert.equal(count(conn, 'group_members'), 0)
  assert.equal(count(conn, 'cadre_members'), 0)
  assert.deepEqual(seatsOf(conn), [[null, 2], [null, null]])
  assert.deepEqual(dutyOf(conn).daily.扫地.周一, ['李四'])
})

// ---------------------------------------------------------------------------
// ② 精确回填：删除之后用户改过座位/值日，撤销不能把那些改动抹掉
// ---------------------------------------------------------------------------
test('撤销只放回被清掉的位置：删除后新坐进来的人（含空位）必须保留', () => {
  const conn = freshDb()
  const removed = cascadeDelete(conn)

  // 删除之后：李四从左同桌挪到张三原来的位置，右下角新坐了一人
  conn.prepare("UPDATE seat_slots SET seats = ? WHERE kind = 'current'")
    .run(JSON.stringify([[2, null], [99, null]]))
  // 删除之后：值日表里新增了一个人
  conn.prepare("UPDATE duty_slots SET cells = ? WHERE kind = 'current'")
    .run(JSON.stringify({ daily: { 扫地: { 周一: ['李四', '王五'] } }, big: {} }))

  executors.student_cascade_delete.undo(removed)

  assert.deepEqual(seatsOf(conn), [[1, null], [99, null]], '只回填 (0,0)，不整块覆盖')
  assert.deepEqual(dutyOf(conn).daily.扫地.周一, ['张三', '李四', '王五'], '原位置插回，别人的改动保留')
})

test('值日快照按 trim 口径定位；同名重复项逐个记位置', () => {
  const cells = { daily: { 扫地: { 周一: [' 张三 ', '李四', '张三'] } }, big: {} }
  const hits = collectDutyRefs(cells, '张三')
  assert.deepEqual(hits.map(h => h.index), [0, 2])
  assert.equal(removeDutyName(cells, '张三'), 2)
  assert.deepEqual(cells.daily.扫地.周一, ['李四'])
})

test('影响预览与清理共用同一份匹配：一个对象格只算 1 个座位（原先会算 2）', () => {
  const conn = freshDb()
  conn.prepare("UPDATE seat_slots SET seats = ? WHERE kind = 'current'")
    .run(JSON.stringify([[{ student_id: 1, name: '张三' }]]))
  assert.equal(studentRelations(ZHANG).seat, 1)
})

test('K05-01：座位模板也统计/清理/撤销，应用模板不会把已删学生带回来', () => {
  const conn = freshDb()
  // 当前表 1 处 + 模板表 1 处；值日同理
  conn.prepare("UPDATE seat_slots SET rows = 1, cols = 2, seats = ?, types = ? WHERE kind = 'template'")
    .run(JSON.stringify([[1, null]]), JSON.stringify([[0, 0]]))
  conn.prepare("UPDATE duty_slots SET cells = ? WHERE kind = 'template'")
    .run(JSON.stringify({ daily: { 扫地: { 周一: ['张三'] } }, big: {} }))

  const rel = studentRelations(ZHANG)
  assert.equal(rel.seat, 2, '当前表 + 模板都要计入影响预览')
  assert.equal(rel.duty, 2, '值日当前表 + 模板同样计入')

  const removed = cascadeDelete(conn)
  const tplSeats = JSON.parse(conn.prepare("SELECT seats FROM seat_slots WHERE kind = 'template'").get().seats)
  const tplDuty = JSON.parse(conn.prepare("SELECT cells FROM duty_slots WHERE kind = 'template'").get().cells)
  assert.deepEqual(tplSeats, [[null, null]], '模板座位里的张三也被清掉')
  assert.deepEqual(tplDuty.daily.扫地.周一, [], '模板值日里的张三也被清掉')
  // 快照带来源表，撤销才能写回模板
  assert.ok(removed.seatCells.some(c => c.table === 'seat_template'), '模板格子的来源表必须记录')
  assert.ok(removed.dutySlots.some(s => s.table === 'duty_template'), '模板值日的来源表必须记录')

  executors.student_cascade_delete.undo(removed)
  assert.deepEqual(
    JSON.parse(conn.prepare("SELECT seats FROM seat_slots WHERE kind = 'template'").get().seats),
    [[1, null]], '撤销把模板座位原位放回')
  assert.deepEqual(
    JSON.parse(conn.prepare("SELECT cells FROM duty_slots WHERE kind = 'template'").get().cells).daily.扫地.周一,
    ['张三'], '撤销把模板值日原位插回')
})

test('validate：缺 student 整行直接拒绝，避免执行时只删一半', () => {
  assert.equal(executors.student_cascade_delete.validate({}), '参数不完整')
  assert.equal(executors.student_cascade_delete.validate({ student: { id: '1' } }), '参数不完整')
  assert.equal(executors.student_cascade_delete.validate({ student: { id: 1 } }), null)
})

// ---------------------------------------------------------------------------
// ③ 接线：后端把 student 放回 removed；前端登记成一条命令并接撤销按钮
// ---------------------------------------------------------------------------

test('接线：后端级联删除服务返回带 student 的快照，执行器已注册', () => {
  // Q2-01 后快照构造从 app.js 路由搬进同事务服务，断言对象跟着移到服务文件。
  const svc = read('student-backend/services/studentCascadeDelete.js')
  assert.match(svc, /removed\s*=\s*\{\s*[\r\n\s]*student,/, 'removed 必须包含 student 整行')
  assert.match(svc, /purgeStudentRelations\(student/)
  // @pin student-backend/app.js#deleteStudentCascade
  assert.match(read('student-backend/app.js'), /deleteStudentCascade/, '路由走同事务服务')

  const ex = read('student-backend/routes/undo/undo.executors.js')
  assert.match(ex, /student_cascade_delete:/)
  assert.match(ex, /restoreSeatCells\(seatCells\)/)
  assert.match(ex, /restoreDutySlots\(dutySlots\)/)
  assert.match(ex, /clearSeatCells\(seatCells\)/)
  assert.match(ex, /clearDutySlots\(student\)/)
})

test('接线：前端消费后端同事务登记的 undoId，删学生只走全删一条路', () => {
  // Q2-01 后级联删除的撤销由后端在业务事务内登记，前端不再发第二次 POST /api/undo。
  // @pin student-frontend/src/views/ClassroomView.vue#undoById
  const view = read('student-frontend/src/views/ClassroomView.vue')
  assert.match(view, /res\.data\?\.undoId/, '级联删除消费后端返回的 undoId')
  assert.doesNotMatch(view, /recordStudentCascadeDelete/, '不得再发第二次登记请求')
  assert.match(view, /notifyUndo\(`已删除学生「\$\{name\}」及关联记录`/)
  // 一律全删：不再提供「仅删学生、保留关联」这条会留孤儿的分支
  assert.doesNotMatch(view, /仅删学生/, '不得保留仅删学生的入口')
  // @pin student-frontend/src/views/ClassroomView.vue#deleteStudent
  assert.doesNotMatch(view, /extraText:/, '删除确认框不得有第三个动作按钮')
  assert.match(view, /relations:\s*\{\s*leave:\s*true,\s*score:\s*true,\s*seat:\s*true,\s*duty:\s*true,\s*group:\s*true,\s*cadre:\s*true\s*\}/, '六类关联全选')
  // @pin student-backend/services/studentCascadeDelete.js#deleteStudentCascade
  const svc = read('student-backend/services/studentCascadeDelete.js')
  assert.match(svc, /type:\s*'student_cascade_delete'/, '后端登记成一条命令')
})
