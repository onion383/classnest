// =========================================================================
// e2e-seat-score-undo.test.js —— 端到端流水线：学生 → 排座 → 加分 → 改座位 → 撤销
//
// 与单点测试的区别：这里走真 HTTP（fx.mount + fetch），按**用户实际操作顺序**
// 串起座位 / 加分 / 撤销三个模块。守的是单文件测不到的跨模块边界：
//   ① 加分要认座位里的学生（student_id 引用，不是姓名快照）
//   ② 撤销一次座位格子编辑，只回滚那一格 —— 不能误伤分数与学生
//   ③ 撤销后再重做，座位回到编辑后的值，分数依旧不动
//
// 手法：真内存库 + 真路由 + 真 fetch + 前端同款 grid_cell 撤销登记。
// 步骤之间共享同一份数据（同一个 fx），这正是「流水线」与「孤立单点」的差别。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'e2e-seat-score-undo' })

const SEATS = [[1, null], [null, null]]
const TYPES = [[0, 0], [0, 0]]

// 读当前座位网格（不是本地副本，是真库）
function seatAt(conn, row, col) {
  const raw = conn.prepare("SELECT seats FROM seat_slots WHERE kind = 'current'").get().seats
  return JSON.parse(raw)[row][col]
}
function scoreCount(conn) {
  return conn.prepare('SELECT COUNT(*) AS n FROM score_records').get().n
}

test.before(async () => {
  await fx.mount('/api/seats', 'student-backend/routes/seats.js')
  await fx.mount('/api/scores', 'student-backend/routes/scores.js')
  await fx.mount('/api/undo', 'student-backend/routes/undo/undo.js')
})
test.after(() => fx.close())

test('端到端：排座 → 加分 → 改格 → 撤销 → 重做，跨模块状态一致', async () => {
  const conn = fx.reset()

  // ① 种学生（起点：名册里有两个真实学生）
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (1, 1, ?)').run('张三')
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (2, 2, ?)').run('李四')
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM students').get().n, 2)

  // ② 排座：把学生放到 (0,0)
  const put = await fx.call('PUT', '/api/seats', {
    mode: 'single', rows: 2, cols: 2, seats: [[1, null], [null, null]], types: TYPES,
  })
  assert.equal(put.status, 200, JSON.stringify(put.json))
  assert.deepEqual(seatAt(conn, 0, 0), 1, '排座后 (0,0) 应是学生 id')

  // ③ 加分：传 studentId，验的是学生引用而非姓名快照
  const add = await fx.call('POST', '/api/scores', {
    studentId: 1, 姓名: '张三', 分值: 5, 原因: '端到端流水',
  })
  assert.equal(add.status, 200, JSON.stringify(add.json))
  assert.equal(scoreCount(conn), 1, '加分后应有一条成绩')
  const scoreRef = conn.prepare('SELECT student_id, 姓名 FROM score_records').get()
  assert.equal(scoreRef.student_id, 1, '成绩必须认 student_id 引用')

  // ④ 改座位格子 (0,1)：放第二个学生（一个学生只能占一座，不能复用 id=1），
  //    同时按前端 recordGridCellUndo 的形状登记撤销
  const before = seatAt(conn, 0, 1) // null
  const edit = await fx.call('PATCH', '/api/seats/cell', { row: 0, col: 1, value: 2 })
  assert.equal(edit.status, 200, JSON.stringify(edit.json))
  assert.deepEqual(seatAt(conn, 0, 1), 2, '编辑后 (0,1) 应是学生 id=2')

  const rec = await fx.call('POST', '/api/undo', {
    key: 'seat_layout',
    type: 'grid_cell',
    label: '格子(1,2)：「(空)」→「李四」',
    payload: { table: 'seat_layout', row: 0, col: 1, oldValue: before, newValue: 2 },
  })
  assert.equal(rec.status, 200, JSON.stringify(rec.json))
  const undoId = rec.json.id

  // ⑤ 撤销：只回滚座位那一格，分数与学生不能被动到
  const un = await fx.call('POST', `/api/undo/${undoId}/undo`)
  assert.equal(un.status, 200, JSON.stringify(un.json))
  assert.deepEqual(seatAt(conn, 0, 1), before, '撤销后 (0,1) 应回到编辑前')
  assert.deepEqual(seatAt(conn, 0, 0), 1, '撤销不能误伤另一格的学生')
  assert.equal(scoreCount(conn), 1, '撤销座位不能误伤成绩')
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM students').get().n, 2, '撤销不能删学生')

  // ⑥ 重做：座位回到编辑后，分数依旧不动
  const re = await fx.call('POST', `/api/undo/${undoId}/redo`)
  assert.equal(re.status, 200, JSON.stringify(re.json))
  assert.deepEqual(seatAt(conn, 0, 1), 2, '重做后 (0,1) 应回到编辑后')
  assert.equal(scoreCount(conn), 1, '重做座位同样不能动成绩')
})
