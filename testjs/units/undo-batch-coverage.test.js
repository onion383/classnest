// =========================================================================
// undo-batch-coverage.test.js —— 行顺序 / 批量导入 / 批量删除（Q2-04 / Q2-05 / Q2-06）
//
// 事故面：一次动作改多行（拖拽排序、勾选批量删除、Excel 导入）此前完全不进撤销栈；
// 即使逐行登记，导入几百行也会被「每 key 50 条」上限截断，前面那批根本撤不回来。
//
// 覆盖：
//   ① 行为：row_reorder / rows_batch_insert / rows_batch_delete 真能回滚
//   ② 契约：导入端点回传 created（完整行），tableService.importRows 也一样
//   ③ 接线：共享 CRUD 与四个页面的写路径都调用了对应登记函数
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')

process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'

const { initSchema } = require('../../student-backend/schema/schema')

const dbPath = require.resolve(path.join(ROOT, 'student-backend/db.js'))
const realDbModule = require(dbPath)
const active = { conn: null }
require.cache[dbPath].exports = {
  ...realDbModule,
  db: new Proxy({}, {
    get(_target, prop) {
      if (!active.conn) return undefined
      const v = active.conn[prop]
      return typeof v === 'function' ? v.bind(active.conn) : v
    },
  }),
  getFields: (tableName) => active.conn.prepare(
    'SELECT column_name AS name, data_type AS type FROM table_meta WHERE table_name = ? ORDER BY sort_order'
  ).all(tableName),
  // db.js 的 renumber 走 dbManager.currentDb()（进程级连接），测试里指向内存库
  renumber: (tableName) => {
    const rows = active.conn.prepare(`SELECT id FROM "${tableName}" ORDER BY position, id`).all()
    const upd = active.conn.prepare(`UPDATE "${tableName}" SET position = ? WHERE id = ?`)
    rows.forEach((r, i) => upd.run(i + 1, r.id))
  },
}

const { executors } = require('../../student-backend/routes/undo/undo.executors')
const tableService = require('../../student-backend/services/tableService')

function freshDb() {
  const conn = new Database(':memory:')
  initSchema(conn)
  active.conn = conn
  return conn
}

function seedStudents(conn) {
  const ins = conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (?, ?, ?)')
  ins.run(1, 1, '甲')
  ins.run(2, 2, '乙')
  ins.run(3, 3, '丙')
}

const positions = (conn) => conn.prepare('SELECT id, position FROM students ORDER BY position, id').all()

// ---------------------------------------------------------------------------
// ① 行顺序：撤销回写的是「每行当时的槽位」，不是 ids 重排
// ---------------------------------------------------------------------------
test('row_reorder：撤销恢复动作前槽位，重做恢复动作后槽位', () => {
  const conn = freshDb()
  seedStudents(conn)

  const before = [
    { id: 1, position: 1 }, { id: 2, position: 2 }, { id: 3, position: 3 },
  ]
  // 把「丙」拖到最前：1/2 顺移
  const after = [
    { id: 3, position: 1 }, { id: 1, position: 2 }, { id: 2, position: 3 },
  ]
  conn.transaction(() => {
    for (const r of after) conn.prepare('UPDATE students SET position = ? WHERE id = ?').run(r.position, r.id)
  })()

  executors.row_reorder.undo({ table: 'students', before, after })
  assert.deepEqual(positions(conn).map((r) => r.id), [1, 2, 3], '撤销后顺序回到 甲乙丙')

  executors.row_reorder.redo({ table: 'students', before, after })
  assert.deepEqual(positions(conn).map((r) => r.id), [3, 1, 2], '重做后顺序回到 丙甲乙')
})

test('row_reorder：只动参与排序的行，之后新插入的行保持原位', () => {
  const conn = freshDb()
  seedStudents(conn)
  // 排序之后才新增的第 4 行，没出现在快照里
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (4, 7, ?)').run('丁')

  executors.row_reorder.undo({
    table: 'students',
    before: [{ id: 1, position: 1 }, { id: 2, position: 2 }],
    after: [{ id: 1, position: 2 }, { id: 2, position: 1 }],
  })
  assert.equal(conn.prepare('SELECT position FROM students WHERE id = 4').get().position, 7, '新行槽位不该被撤销改写')
})

// ---------------------------------------------------------------------------
// ② 批量新增 / 批量删除
// ---------------------------------------------------------------------------
test('rows_batch_insert：撤销整批删除，重做按原 id 与 position 重建', () => {
  const conn = freshDb()
  seedStudents(conn)
  const created = [
    { id: 10, position: 4, 姓名: '导入甲' },
    { id: 11, position: 5, 姓名: '导入乙' },
  ]
  const ins = conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (?, ?, ?)')
  for (const r of created) ins.run(r.id, r.position, r.姓名)

  executors.rows_batch_insert.undo({ table: 'students', rows: created })
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM students').get().n, 3, '撤销导入应删掉本次新建的两行')

  executors.rows_batch_insert.redo({ table: 'students', rows: created })
  const back = conn.prepare('SELECT id, position, 姓名 FROM students WHERE id >= 10 ORDER BY id').all()
  assert.deepEqual(back, created, '重做后整行（含 position）应原样回来')
})

test('rows_batch_delete：撤销整批恢复，重做再次删除', () => {
  const conn = freshDb()
  seedStudents(conn)
  const removed = [
    { id: 1, position: 1, 姓名: '甲' },
    { id: 3, position: 3, 姓名: '丙' },
  ]
  conn.prepare('DELETE FROM students WHERE id IN (1, 3)').run()

  executors.rows_batch_delete.undo({ table: 'students', rows: removed })
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM students').get().n, 3, '撤销批量删除应整批恢复')

  executors.rows_batch_delete.redo({ table: 'students', rows: removed })
  assert.deepEqual(conn.prepare('SELECT id FROM students ORDER BY id').all().map((r) => r.id), [2])
})

test('validate：拒绝未知表 / 空行集 / 缺 id 的行（登记了也执行不了）', () => {
  for (const type of ['rows_batch_insert', 'rows_batch_delete']) {
    assert.match(executors[type].validate({ table: 'evil', rows: [{ id: 1 }] }), /表无效/)
    assert.match(executors[type].validate({ table: 'students', rows: [] }), /参数不完整/)
    assert.match(executors[type].validate({ table: 'students', rows: [{ 姓名: '无 id' }] }), /参数不完整/)
    assert.equal(executors[type].validate({ table: 'students', rows: [{ id: 1 }] }), null)
  }
  assert.equal(executors.row_reorder.validate({ table: 'students', before: [], after: [] }), null)
  assert.match(executors.row_reorder.validate({ table: 'evil', before: [], after: [] }), /表无效/)
})

// ---------------------------------------------------------------------------
// ③ 导入契约：回传的是完整行（撤销 redo 要按真实列重建）
// ---------------------------------------------------------------------------
test('importRows 回传 created：完整行 + 最终 position，可直接作为 rows_batch_insert 的 payload', () => {
  const conn = freshDb()
  seedStudents(conn)
  const { count, created } = tableService.importRows('students', ['姓名'], [['新1'], ['新2']])
  assert.equal(count, 2)
  assert.equal(created.length, 2)
  for (const r of created) {
    assert.ok(Number.isInteger(r.id), 'created 必须带 id')
    assert.ok(Number.isInteger(r.position), 'created 必须带最终 position')
    assert.match(r.姓名, /^新[12]$/)
  }

  executors.rows_batch_insert.undo({ table: 'students', rows: created })
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM students').get().n, 3, '导入的两行应被整批撤掉')
})

// ---------------------------------------------------------------------------
// ④ 接线：写路径必须登记（漏一条 = 那条路径仍然不可撤销）
// ---------------------------------------------------------------------------
function bodyOf(text, name) {
  const start = text.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `找不到 ${name}`)
  const rest = text.slice(start + 1)
  const next = rest.search(/\n\s*(?:async )?function [a-zA-Z_]/)
  return next >= 0 ? text.slice(start, start + 1 + next) : text.slice(start)
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const crud = read('student-frontend/src/composables/useTableCRUD.js')
const leaveView = read('student-frontend/src/views/LeaveManagement.vue')
const scoreView = read('student-frontend/src/views/ScoreManagement.vue')
const actView = read('student-frontend/src/views/ActivitiesView.vue')

test('接线（共享 CRUD）：新增 / 单删 / 批量删 / 去重 / 导入 / 排序都登记', () => {
  assert.match(bodyOf(crud, 'saveNewRow'), /recordRowInsert\(undoTableKey/)
  assert.match(bodyOf(crud, 'deleteRows'), /recordRowDelete\(undoTableKey/)
  assert.match(bodyOf(crud, 'deleteRowById'), /recordRowDelete\(undoTableKey/)
  assert.match(bodyOf(crud, 'onBatchDelete'), /recordRowsBatchDelete\(undoTableKey/)
  assert.match(bodyOf(crud, 'onDeleteDuplicates'), /recordRowsBatchDelete\(undoTableKey/)
  assert.match(bodyOf(crud, 'onImportData'), /recordRowsBatchInsert\(undoTableKey/)
  for (const fn of ['moveRow', 'pasteRows', 'onMoveSelectedRows', 'onSwapRows', 'saveCurrentOrder']) {
    const body = bodyOf(crud, fn)
    assert.match(body, /const before = orderSnapshot\(\)/, `${fn} 必须先取动作前顺序`)
    assert.ok(
      /recordOrderChange\(before\)/.test(body) || /recordRowReorder\(undoTableKey, before/.test(body),
      `${fn} 必须登记行顺序撤销`
    )
  }
})

test('接线（共享 CRUD）：列结构不进撤销，但删列确认文案明示不可撤销', () => {
  assert.doesNotMatch(bodyOf(crud, 'deleteColumn'), /recordUndo|recordRows?/)
  assert.match(bodyOf(crud, 'deleteColumn'), /无法撤销/)
})

test('接线（请假页）：排序与导入都登记', () => {
  assert.match(bodyOf(leaveView, 'saveRowOrder'), /recordRowReorder\('leave_records'/)
  assert.match(bodyOf(leaveView, 'onImportData'), /recordRowsBatchInsert\('leave_records'/)
  // 列配置是展示偏好，明确不占撤销栈（代码里有口径注释）
  assert.doesNotMatch(bodyOf(leaveView, 'saveColumnOrder'), /recordUndo|recordRow/)
})

test('接线（加分 / 活动 / 倒计时导入）', () => {
  assert.match(bodyOf(scoreView, 'onImportData'), /recordRowsBatchInsert\('score_records'/)
  assert.match(bodyOf(actView, 'onImportData'), /recordRowsBatchInsert\(resolveKey\(\)/)
})

test('契约（后端）：五个导入端点都回传 created 完整行', () => {
  for (const rel of [
    'student-backend/routes/leaves.js',
    'student-backend/routes/scores.js',
    'student-backend/routes/activities.js',
    'student-backend/routes/countdowns.js',
  ]) {
    assert.match(read(rel), /created: readRowsByIds\(/, `${rel} 必须回传 created`)
  }
  assert.match(read('student-backend/routes/dynamicTable.js'), /const \{ count, created \} = importRows/)
})
