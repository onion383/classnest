// =========================================================================
// undo-cascade-same-tx.test.js —— 级联删除「写与撤销登记同事务」（V8 · 5-2 / Q2-01）
//
// 旧实现：app.js 路由在事务内 purge 七处 + 删学生，但撤销快照只随响应回前端，
// 前端再发第二次 POST /api/undo 登记。两次请求两个事务：中间崩溃/登记失败 →
// 七处已删、撤销栈没有条目，用户只能手工重建。
//
// 修复（studentCascadeDelete.js）：七处清理 + 删学生 + undoStore.push 收进同一
// db.transaction，与 MCP confirm() 同事务登记同构。前端不再发第二次登记请求。
//
// 行为判据（真内存库 + 故障注入，不靠"模拟重启"这种脆弱断言）：
//   ① 一次服务调用后：七处已删 + undo_history 立刻有 student_cascade_delete（无第二请求）
//   ② 让撤销 INSERT 失败：七处和学生一条都没删（事务整体回滚）
//   ③ 静态接线：后端路由消费服务返回的 undoId，前端不再有 recordStudentCascadeDelete
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'undo-cascade-same-tx', faults: true })
const { deleteStudentCascade } = require('../../../student-backend/services/studentCascadeDelete')

// 种「七处都有引用」的场景（与 student-cascade-delete.test.js 同口径）
function freshDb() {
  const conn = fx.reset()
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (1, 1, ?)').run('张三')
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (2, 2, ?)').run('李四')
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

function count(conn, table) {
  return conn.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c
}

test('① 一次级联删除请求内七处已删，撤销栈立刻有一条可撤记录（无需第二次请求）', () => {
  const conn = freshDb()
  const { removed, undoId } = deleteStudentCascade(1)

  assert.ok(undoId, '服务调用必须返回 undoId——登记已随业务写同事务完成')
  assert.ok(removed && removed.student && removed.student.id === 1, '快照含学生整行')

  // 七处都已删
  assert.strictEqual(count(conn, 'students'), 1, '张三已删，只剩李四')
  assert.strictEqual(count(conn, 'leave_records'), 0)
  assert.strictEqual(count(conn, 'score_records'), 0)
  assert.strictEqual(count(conn, 'group_members'), 0)
  assert.strictEqual(count(conn, 'cadre_members'), 0)
  const seats = JSON.parse(conn.prepare("SELECT seats FROM seat_slots WHERE kind='current'").get().seats)
  assert.strictEqual(seats[0][0], null, '座位已清')
  const duty = JSON.parse(conn.prepare("SELECT cells FROM duty_slots WHERE kind='current'").get().cells)
  assert.deepStrictEqual(duty.daily.扫地.周一, ['李四'], '值日里的张三已清')

  // 关键：撤销记录已落库，且是手工来源的一条 student_cascade_delete
  const rec = conn.prepare('SELECT * FROM undo_history WHERE id = ?').get(undoId)
  assert.ok(rec, 'undo_history 必须已有该条——否则就是"数据改了无栈可撤"')
  assert.strictEqual(rec.type, 'student_cascade_delete')
  assert.strictEqual(rec.source, 'manual')
  assert.strictEqual(rec.dir, 1)
  const payload = JSON.parse(rec.payload)
  delete payload.__v // packJson 加的版本标记
  assert.strictEqual(payload.student.id, 1, 'payload 含学生整行供撤销重建')
  assert.ok(Array.isArray(payload.leaveRows) && Array.isArray(payload.seatCells),
    'payload 含六类关联快照')
})

test('①b 传部分勾选也一律全删：不重演 CASCADE 绕过勾选的静默丢失', () => {
  const conn = freshDb()
  // 老调用方可能还传着「只清请假、其余保留」的参数。服务不再读它：
  // 若读回去，新库 CASCADE 会把保留的四类带走却不在快照里 —— 撤销救不回来。
  const partial = { leave: true, score: false, seat: false, duty: false, group: false, cadre: false }
  const { removed } = deleteStudentCascade(1, partial)

  assert.strictEqual(count(conn, 'score_records'), 0, '传 score:false 仍必须删加分')
  assert.strictEqual(count(conn, 'group_members'), 0, '传 group:false 仍必须删小组')
  assert.strictEqual(count(conn, 'cadre_members'), 0, '传 cadre:false 仍必须删班干部')
  const seats = JSON.parse(conn.prepare("SELECT seats FROM seat_slots WHERE kind='current'").get().seats)
  assert.strictEqual(seats[0][0], null, '传 seat:false 仍必须清座位')
  // 快照与 CASCADE 删的是同一批：撤销有完整存档
  assert.ok(Array.isArray(removed.scoreRows) && removed.scoreRows.length === 1, '快照含被 CASCADE 影响的加分行')
})

test('② 撤销登记失败 → 七处清理与学生删除整事务回滚（不留下撤不回来的半截数据）', () => {
  const conn = freshDb()
  // 让 undo_history 的 INSERT 失败：这正是旧实现里「前端第二次登记失败」的场景，
  // 现在它在同一事务内，失败必须把七处删除一起回滚。
  fx.inject({ failMatch: /INSERT INTO undo_history/i, failAtMatch: 1 })
  assert.throws(() => deleteStudentCascade(1), /注入故障/)

  assert.strictEqual(count(conn, 'students'), 2, '撤销登记失败时学生不能真被删')
  assert.strictEqual(count(conn, 'leave_records'), 1, '六类关联也不能被清')
  assert.strictEqual(count(conn, 'score_records'), 1)
  assert.strictEqual(count(conn, 'group_members'), 1)
  assert.strictEqual(count(conn, 'cadre_members'), 1)
  const seats = JSON.parse(conn.prepare("SELECT seats FROM seat_slots WHERE kind='current'").get().seats)
  assert.strictEqual(seats[0][0], 1, '座位保持原样')
  assert.strictEqual(count(conn, 'undo_history'), 0, '失败不留撤销记录')
})

test('③ 接线：后端路由回传 undoId，前端消费它且不再发第二次登记请求', () => {
  const appSrc = read('student-backend/app.js')
  const viewSrc = read('student-frontend/src/views/ClassroomView.vue')
  const undoSrc = read('student-frontend/src/composables/useUndo.js')

  // 后端：路由调同事务服务，并把 undoId 随响应返回
  // @pin student-backend/app.js#deleteStudentCascade
  assert.match(appSrc, /deleteStudentCascade/, '路由必须走同事务服务')
  // @pin student-backend/app.js#deleteStudentCascade
  assert.match(appSrc, /undoId/, '路由响应必须回传 undoId')
  // 前端：消费响应里的 undoId，且不再 import/调用 recordStudentCascadeDelete
  // @pin student-frontend/src/views/ClassroomView.vue#undoById
  assert.match(viewSrc, /res\.data\?\.undoId/, '前端应消费后端返回的 undoId')
  // @pin student-frontend/src/views/ClassroomView.vue#undoById
  assert.doesNotMatch(viewSrc, /recordStudentCascadeDelete/, '前端不得再发第二次登记请求')
  // @pin student-frontend/src/composables/useUndo.js#recordRowInsert
  assert.doesNotMatch(undoSrc, /export function recordStudentCascadeDelete/,
    '统一登记出口里的级联函数应删除，避免留个会造第二次登记的陷阱')
})
