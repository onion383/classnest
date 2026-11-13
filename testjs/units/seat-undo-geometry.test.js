// =========================================================================
// seat-undo-geometry.test.js —— 撤销的「几何四元组」契约（P0-3 / P0-2）
//
// 两个真实事故，一个文件覆盖：
//   P0-3 撤销「插入/删除走廊列」后 types 宽 8、cols 还写着 7 —— 前端只透传了 rows、
//        漏了 cols，后端见 undefined 就跳过回写。读库按 cols 裁 → 座位图整体错列，
//        导出与打印跟着错，而且不报错。
//   P0-2 撤销很久以前记下的一格，布局那时已经变小 —— 越界行照样写进 JSON，
//        下一次整表 PUT 按 rows 裁剪（slice(0, rows)）把它静默丢掉：撤销显示成功，数据没了。
//
// 判据分三层（只测一层会假绿）：
//   ① 几何来源：**types 的形状**是唯一真相，显式四元组只在没有 types 的老记录里兜底
//   ② 越界拒绝：按当前布局卡，且非座位表不被误伤
//   ③ 接线：撤销路由确实先 validate 再执行；前端四个字段成对透传
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'seat-undo-geometry' })

const { executors } = require('../../student-backend/routes/undo/undo.executors')

function freshDb({ rows = 2, cols = 2, seats, types } = {}) {
  const conn = fx.reset()
  const zeros = Array.from({ length: rows }, () => Array(cols).fill(null))
  conn.prepare("UPDATE seat_slots SET rows = ?, cols = ?, seats = ?, types = ? WHERE kind = 'current'")
    .run(rows, cols, JSON.stringify(seats ?? zeros), JSON.stringify(types ?? Array.from({ length: rows }, () => Array(cols).fill(0))))
  return conn
}
function current() {
  const row = fx.conn.prepare("SELECT rows, cols, seats, types FROM seat_slots WHERE kind = 'current'").get()
  return { rows: row.rows, cols: row.cols, seats: JSON.parse(row.seats), types: JSON.parse(row.types) }
}
// 核心不变量：矩阵形状必须与几何计数一致（三者对齐才算撤对了）
function assertGeometryAligned(conn) {
  const c = current()
  assert.equal(c.types.length, c.rows, `types 行数 ${c.types.length} 与 rows ${c.rows} 不一致`)
  assert.equal(c.types[0].length, c.cols, `types 列数 ${c.types[0].length} 与 cols ${c.cols} 不一致`)
  assert.equal(c.seats.length, c.rows, `seats 行数 ${c.seats.length} 与 rows ${c.rows} 不一致`)
  return c
}

// ---------------------------------------------------------------------------
// ① 几何来源：types 是唯一真相
// ---------------------------------------------------------------------------
test('P0-3 复现：只带 rows、漏了 cols 时，几何仍按 types 推回（不再分叉）', () => {
  // 现状：库里是「插入一列走廊」之后的 2 行 × 3 列
  freshDb({ rows: 2, cols: 3, seats: [[null, null, null], [null, null, null]], types: [[0, 1, 0], [0, 1, 0]] })
  // 撤销回插入前的 2 行 × 2 列快照：老前端只透传了 oldRows，**没有 oldCols**
  executors.grid_snapshot.undo({
    table: 'seat_layout',
    oldValue: { seats: [[null, null], [null, null]], types: [[0, 0], [0, 0]] },
    oldRows: 2,
  })
  const c = assertGeometryAligned(fx.conn)
  assert.equal(c.rows, 2)
  assert.equal(c.cols, 2, 'cols 必须跟着 types 回到 2；跟着 undefined 跳过就是这个 P0')
})

test('显式四元组与 types 冲突时，以 types 为准', () => {
  freshDb({ rows: 2, cols: 4, seats: [[null, null, null, null], [null, null, null, null]] })
  executors.grid_snapshot.undo({
    table: 'seat_layout',
    oldValue: { seats: [[null, null], [null, null]], types: [[0, 0], [0, 0]] },
    oldRows: 2,
    oldCols: 9, // 前端抄错的旧值，不该被采信
  })
  assert.equal(assertGeometryAligned(fx.conn).cols, 2)
})

test('重做同样按 types 推回几何（redo 走的是 newValue/newCols）', () => {
  freshDb({ rows: 2, cols: 2, seats: [[null, null], [null, null]] })
  executors.grid_snapshot.redo({
    table: 'seat_layout',
    newValue: { seats: [[null, null, null], [null, null, null]], types: [[0, 1, 0], [0, 1, 0]] },
    newRows: 2,
    // 同样漏 newCols
  })
  const c = assertGeometryAligned(fx.conn)
  assert.equal(c.cols, 3)
})

test('没有 types 的纯数组快照：即使带了行数列数也不动几何（没有矩阵就没有几何真相）', () => {
  freshDb({ rows: 3, cols: 3 })
  executors.grid_snapshot.undo({
    table: 'seat_layout',
    oldValue: [[null, null], [null, null]],
    oldRows: 2,
    oldCols: 2,
  })
  const c = current()
  // 只改计数不改矩阵 = 亲手造出「types 3 行、rows 2」——正是本次要消灭的分叉
  assert.equal(c.rows, 3, '快照没有 types 就不能单独改行数')
  assert.equal(c.cols, 3, '快照没有 types 就不能单独改列数')
  assert.equal(c.types.length, 3)
  assert.equal(c.types[0].length, 3)
})

test('老记录完全不带几何时，rows/cols 一格不动（与既有行为一致）', () => {
  freshDb({ rows: 2, cols: 2 })
  executors.grid_snapshot.undo({ table: 'seat_layout', oldValue: [[null, null], [null, null]] })
  const c = current()
  assert.equal(c.rows, 2)
  assert.equal(c.cols, 2)
})

// ---------------------------------------------------------------------------
// ② 单格撤销：按当前布局卡（P0-2）
// ---------------------------------------------------------------------------
test('P0-2 撤销越界单格会被拒，且说清「布局已变更」', () => {
  freshDb({ rows: 2, cols: 2 }) // 布局已缩小到 2 行
  const err = executors.grid_cell.validate({ table: 'seat_layout', row: 4, col: 0 })
  assert.ok(err, '越界必须拒绝')
  assert.match(err, /布局已变更/)
  assert.match(err, /只有 2 行/)
})

test('布局内的单格撤销照常放行', () => {
  freshDb({ rows: 2, cols: 2 })
  assert.equal(executors.grid_cell.validate({ table: 'seat_layout', row: 1, col: 1 }), null)
})

test('列越界同样拒绝（走廊列也算网格列）', () => {
  freshDb({ rows: 2, cols: 2 })
  const err = executors.grid_cell.validate({ table: 'seat_layout', row: 0, col: 3 })
  assert.match(err, /只有 2 列/)
})

test('非座位表（课程表/值日表）不做布局卡控 —— 不误伤', () => {
  freshDb({ rows: 2, cols: 2 })
  assert.equal(executors.grid_cell.validate({ table: 'schedule', row: 40, col: 9 }), null)
  assert.equal(executors.grid_cell.validate({ table: 'duty_layout', row: 40, col: 9 }), null)
})

test('座位模板也按自己的布局卡（不共用当前表的 rows/cols）', () => {
  freshDb({ rows: 2, cols: 2 })
  fx.conn.prepare("UPDATE seat_slots SET rows = 5, cols = 5, types = ? WHERE kind = 'template'")
    .run(JSON.stringify(Array.from({ length: 5 }, () => Array(5).fill(0))))
  assert.equal(executors.grid_cell.validate({ table: 'seat_template', row: 4, col: 4 }), null, '模板 5×5 里第 5 行第 5 列是合法坐标')
  assert.match(executors.grid_cell.validate({ table: 'seat_layout', row: 4, col: 0 }), /布局已变更/, '当前表还是 2 行，不能跟着模板放宽')
})

// ---------------------------------------------------------------------------
// ③ 接线判据
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

test('接线：撤销路由先 validate 再执行（顺序颠倒 = 校验白写）', () => {
  const src = codeOnly(read('student-backend/routes/undo/undo.records.js'))
  const at = src.indexOf('ex.validate')
  const run = src.indexOf('await ex[mode]')
  assert.ok(at > -1, '必须调用 ex.validate')
  assert.ok(run > -1, '必须执行 ex[mode]')
  assert.ok(at < run, 'validate 必须在执行之前')
})

test('接线：前端四个几何字段成对透传（历史就是漏了列）', () => {
  const src = codeOnly(read('student-frontend/src/composables/useUndo.js'))
  for (const k of ['oldRows', 'newRows', 'oldCols', 'newCols']) {
    assert.match(src, new RegExp(`payload\\.${k}\\s*=`), `${k} 必须透传（漏一个就分叉）`)
  }
})

test('接线：执行器用 geometryOfSnapshot，不再直接采信前端字段', () => {
  const src = codeOnly(read('student-backend/routes/undo/undo.executors.js'))
  assert.match(src, /geometryOfSnapshot\(oldValue/, 'undo 必须经 geometryOfSnapshot 推导')
  assert.match(src, /geometryOfSnapshot\(newValue/, 'redo 必须经 geometryOfSnapshot 推导')
  assert.ok(
    !/writeGeometryCounts\(table, oldRows, oldCols\)/.test(src),
    '不能退回「直接拿前端字段回写」——那就是本次要修的分叉',
  )
})
