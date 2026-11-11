// =========================================================================
// leave-undo-wiring.test.js —— 请假记录全链路撤销（Q2-05 / §4-6）
//
// 事故面：请假页的写路径里只有「单元格编辑」登记了撤销；
// 新增（弹窗 / 行内）/ 编辑 / 删除 / 销假 / 撤销销假 全都没有 —— 填错或点错只能手工恢复。
//
// 本文件覆盖两部分：
//   ① 行为：通用行命令（row_insert / row_update / row_delete）能在 leave_records 上真正回滚
//   ② 接线：每条写路径都调用了对应的登记函数（防止以后新增路径又漏掉）
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
}

const { executors } = require('../../student-backend/routes/undo/undo.executors')

const LEAVE = {
  id: 1, student_id: 1, 姓名: '张三', 状态: '请假中',
  开始时间: '2026-03-02 08:00', 结束时间: '2026-03-03 18:00', 返校时间: null,
}

function freshDb() {
  const conn = new Database(':memory:')
  initSchema(conn)
  active.conn = conn
  conn.prepare('INSERT INTO students (id, position, 姓名) VALUES (1, 1, ?)').run('张三')
  conn.prepare('INSERT INTO leave_records (id, student_id, 姓名, 状态, 开始时间, 结束时间) VALUES (1, 1, ?, ?, ?, ?)')
    .run(LEAVE.姓名, LEAVE.状态, LEAVE.开始时间, LEAVE.结束时间)
  return conn
}

const row = (conn, id = 1) => conn.prepare('SELECT * FROM leave_records WHERE id = ?').get(id)

// ---------------------------------------------------------------------------
// ① 行为：通用命令真能回滚 leave_records
// ---------------------------------------------------------------------------
test('新增可撤销：row_insert 撤销后记录消失，重做后原样回来', () => {
  const conn = freshDb()
  const added = { ...LEAVE, id: 2, 姓名: '李四' }
  // 模拟后端已插入
  conn.prepare('INSERT INTO leave_records (id, student_id, 姓名, 状态) VALUES (2, 1, ?, ?)').run(added.姓名, added.状态)
  // 前端登记的是「添加后的完整行」（这里按 minSchema 允许的列传）
  const payload = { table: 'leave_records', row: { id: 2, student_id: 1, 姓名: '李四', 状态: '请假中' } }

  executors.row_insert.undo(payload)
  assert.equal(row(conn, 2), undefined)

  executors.row_insert.redo(payload)
  assert.equal(row(conn, 2).姓名, '李四')
})

test('编辑可撤销：row_update 撤销回旧值，重做回新值（含销假字段）', () => {
  const conn = freshDb()
  const payload = {
    table: 'leave_records',
    rowId: 1,
    oldRow: { ...LEAVE },
    newRow: { ...LEAVE, 状态: '已销假', 返校时间: '2026-03-03 17:30' },
  }
  executors.row_update.redo(payload)
  assert.equal(row(conn).状态, '已销假')
  assert.equal(row(conn).返校时间, '2026-03-03 17:30')

  executors.row_update.undo(payload)
  assert.equal(row(conn).状态, '请假中')
  assert.equal(row(conn).返校时间, null, '撤销销假必须把返校时间一起清掉')
})

test('删除可撤销：row_delete 撤销后整行回到库里', () => {
  const conn = freshDb()
  const snapshot = { ...row(conn) }
  conn.prepare('DELETE FROM leave_records WHERE id = 1').run()

  executors.row_delete.undo({ table: 'leave_records', row: snapshot })
  assert.equal(row(conn).姓名, '张三')
  assert.equal(row(conn).状态, '请假中')

  executors.row_delete.redo({ table: 'leave_records', row: snapshot })
  assert.equal(row(conn), undefined)
})

test('validate：leave_records 在命令白名单内（否则前端登记了也执行不了）', () => {
  assert.equal(executors.row_insert.validate({ table: 'leave_records', row: LEAVE }), null)
  assert.equal(executors.row_update.validate({ table: 'leave_records', rowId: 1 }), null)
  assert.equal(executors.row_delete.validate({ table: 'leave_records', row: LEAVE }), null)
})

// ---------------------------------------------------------------------------
// ② 接线：每条写路径都必须登记（漏一条 = 那条路径仍然不可撤销）
// ---------------------------------------------------------------------------
const view = fs.readFileSync(path.join(ROOT, 'student-frontend/src/views/LeaveManagement.vue'), 'utf8')

function bodyOf(name) {
  const start = view.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `找不到 ${name}`)
  // 截到同缩进的下一个顶层 function（够用即可）
  const rest = view.slice(start + 1)
  const next = rest.search(/\n(?:async )?function [a-zA-Z]/)
  return next >= 0 ? view.slice(start, start + 1 + next) : view.slice(start)
}

test('接线：新增（弹窗 + 行内）登记 row_insert', () => {
  assert.match(bodyOf('submitAdd'), /recordLeaveInsert\(/)
  assert.match(bodyOf('saveNewRow'), /recordLeaveInsert\(/)
})

test('接线：编辑与三种销假流转登记 row_update（先取 before、再取 after）', () => {
  assert.match(bodyOf('updateLeave'), /snapshotLeaveRow\(id\)[\s\S]*recordLeaveUpdate\(/)
  for (const fn of ['handleOverdueReturn', 'returnLeave', 'unreturnLeave']) {
    assert.match(bodyOf(fn), /recordLeaveUpdate\(/, `${fn} 必须登记撤销`)
  }
})

test('接线：删除登记 row_delete，单元格编辑仍保留 recordCellUndo', () => {
  assert.match(bodyOf('deleteLeave'), /recordRowDelete\('leave_records'/)
  assert.match(bodyOf('saveCell'), /recordCellUndo\('leave_records'/)
})
