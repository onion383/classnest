// =========================================================================
// seat-cell-undo-same-tx.test.js —— 座位单格 PATCH 写与撤销同事务（V9-I-13）
// 判据：①真跑：带 _undoSpec 的 PATCH 回 undoId，undo_history 落一条 grid_cell，
//         且 payload 原样保留前端写前给的 oldValue/newValue；
//       ②不变量仍在：洞里/走廊里塞人被拒时不登记（写失败不写撤销栈）；
//       ③变异反证：不带 spec 的 PATCH 无 undoId、撤销栈不增长；
//       ④几何不动：单格写入后 types/rows/cols 未被改动。
// 手法与 seat-cell-write.test.js 一致：真内存库 + 真 schema + 真 Express + 真 HTTP。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')

const { createBackendDb } = require(abs('testjs/units/_db-express-fixture.cjs'))
const fx = createBackendDb({ label: 'seat-cell-undo' })

test.before(() => fx.mount('/api/seats', 'student-backend/routes/seats.js'))
test.after(() => fx.close())

const ROWS = 2, COLS = 3
const TYPES = [[2, 1, 0], [0, 1, 0]] // (0,0) 空位洞、(0,1)/(1,1) 走廊；只有 col 2 可坐
const SEATS = [[null, null, null], [null, null, null]]

async function bootstrap() {
  fx.reset()
  const s = fx.conn.prepare('INSERT INTO students (position, 学号, 姓名) VALUES (1, ?, ?)')
  s.run('001', '学生1'); s.run('002', '学生2')
  const put = await fx.call('PUT', '/api/seats', { mode: 'single', rows: ROWS, cols: COLS, seats: SEATS, types: TYPES })
  assert.equal(put.status, 200, put.text.slice(0, 200))
}
function count() { return fx.conn.prepare('SELECT COUNT(*) n FROM undo_history').get().n }
function last() { return fx.conn.prepare('SELECT type, payload FROM undo_history ORDER BY id DESC LIMIT 1').get() }

test('带 spec 的单格 PATCH：同事务登记 grid_cell，payload 原样保留', async () => {
  await bootstrap()
  const before = count()
  const res = await fx.call('PATCH', '/api/seats/cell', {
    row: 0, col: 2, value: 1,
    _undoSpec: { key: '座位表', type: 'grid_cell', label: '格子(1,3)',
      payload: { table: 'seat_layout', row: 0, col: 2, oldValue: null, newValue: 1 } },
  })
  assert.equal(res.status, 200, res.text.slice(0, 200))
  assert.ok(res.json.undoId, '回 undoId')
  assert.equal(count(), before + 1, '同事务登记一条')
  const row = last()
  assert.equal(row.type, 'grid_cell')
  const p = JSON.parse(row.payload)
  assert.equal(p.oldValue, null)
  assert.equal(p.newValue, 1)
  assert.equal(p.row, 0); assert.equal(p.col, 2)
})

test('不变量被拒：洞里塞人不登记，撤销栈不增长', async () => {
  await bootstrap()
  const before = count()
  const res = await fx.call('PATCH', '/api/seats/cell', {
    row: 0, col: 0, value: 1, // (0,0) 是洞，assertSeatCellWritable 必拒
    _undoSpec: { key: '座位表', type: 'grid_cell', label: '洞里塞人',
      payload: { table: 'seat_layout', row: 0, col: 0, oldValue: null, newValue: 1 } },
  })
  assert.notEqual(res.status, 200, '洞里塞人必须被拒')
  assert.equal(count(), before, '写失败不写撤销栈')
})

test('变异反证：不带 spec 的 PATCH 无 undoId、撤销栈不增长', async () => {
  await bootstrap()
  const before = count()
  const res = await fx.call('PATCH', '/api/seats/cell', { row: 0, col: 2, value: 2 })
  assert.equal(res.status, 200, res.text.slice(0, 200))
  assert.equal(res.json.undoId, undefined, '没 spec 就没有 undoId')
  assert.equal(count(), before, '没 spec 不自动登记')
})

test('几何不动：单格写入只改一格，types/rows/cols 不被改动', async () => {
  await bootstrap()
  await fx.call('PATCH', '/api/seats/cell', { row: 0, col: 2, value: 1 })
  const doc = fx.conn.prepare("SELECT rows, cols, types FROM seat_slots WHERE kind = 'current'").get()
  assert.equal(doc.rows, ROWS)
  assert.equal(doc.cols, COLS)
  assert.deepEqual(JSON.parse(doc.types), TYPES, 'types 矩阵不能被单格写入改动')
})
