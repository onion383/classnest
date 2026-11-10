// =========================================================================
// seat-grid-migration.test.js —— 座位几何「dense → 网格矩阵化」的一次性迁移
//
// 为什么值得单独一个文件：这是**唯一一处不可逆且静默**的改动。
//   · 迁错了，界面上看不出任何异常（列数、座位号都还是那些）；
//   · 但座位指数是拿历史快照的 seats[r][c] 按同一下标逐天累加的，
//     历史 payload 没迁 → 每人指数从第一天起整体错位，越攒越错、事后无法区分。
// 所以这里既断言「新几何算对了」，也断言「历史 payload 一起迁了」和「重复跑不会迁第二次」。
//
// 手法：真内存库 + 真 initSchema，不走 Express —— 迁移是 schema 阶段的事，
// 走 HTTP 反而要先把前端形状摆对，测不到「老库长什么样」这个前提。
// =========================================================================
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')

const { initSchema } = require('../../student-backend/schema/schema')
const { migrateSeatGrid, expandGrid } = require('../../student-backend/schema/seatGridMigration')
const { normalizeSeats, SEAT_MAX_COLS, SEAT_MAX_GRID_COLS } = require('../../student-backend/services/sanitize')

const SEAT = 0
const AISLE = 1

function freshDb() {
  const conn = new Database(':memory:')
  initSchema(conn)
  return conn
}

function putSlot(conn, kind, { mode, rows, cols, seats, types, weights, settings }) {
  conn.prepare('UPDATE seat_slots SET mode = ?, rows = ?, cols = ?, seats = ?, types = ?, weights = ?, settings = ? WHERE kind = ?')
    .run(mode, rows, cols, JSON.stringify(seats || []), JSON.stringify(types || []), JSON.stringify(weights || []), JSON.stringify(settings || {}), kind)
}

function readSlot(conn, kind) {
  const r = conn.prepare('SELECT mode, rows, cols, seats, types, weights, settings FROM seat_slots WHERE kind = ?').get(kind)
  return { ...r, seats: JSON.parse(r.seats), types: JSON.parse(r.types), weights: JSON.parse(r.weights), settings: JSON.parse(r.settings) }
}

// ---------------- 纯几何 ----------------

test('单人桌 + 走廊：走廊插在每两个座位列之间', () => {
  const g = expandGrid({
    rows: 1, cols: 4, mode: 'single', showAisle: true,
    seats: [[11, 12, 13, 14]], weights: [],
  })
  assert.equal(g.cols, 7, '4 个座位列 + 3 条走廊 = 7 列')
  assert.deepEqual(g.seats[0], [11, null, 12, null, 13, null, 14])
  assert.deepEqual(g.types[0], [SEAT, AISLE, SEAT, AISLE, SEAT, AISLE, SEAT])
})

test('双人桌 + 走廊：每两列之后一条，末列不加', () => {
  const g = expandGrid({
    rows: 1, cols: 7, mode: 'double', showAisle: true,
    seats: [[1, 2, 3, 4, 5, 6, 7]], weights: [],
  })
  // 7 + floor((7-1)/2) = 10
  assert.equal(g.cols, 10)
  assert.deepEqual(g.types[0], [SEAT, SEAT, AISLE, SEAT, SEAT, AISLE, SEAT, SEAT, AISLE, SEAT])
  assert.deepEqual(g.seats[0], [1, 2, null, 3, 4, null, 5, 6, null, 7])
})

test('showAisle=false：不插走廊列，cols 不变，types 全为座位', () => {
  const g = expandGrid({
    rows: 2, cols: 3, mode: 'single', showAisle: false,
    seats: [[1, 2, 3], [null, null, 4]], weights: [],
  })
  assert.equal(g.cols, 3)
  assert.deepEqual(g.seats, [[1, 2, 3], [null, null, 4]])
  assert.deepEqual(g.types, [[SEAT, SEAT, SEAT], [SEAT, SEAT, SEAT]])
})

test('权重矩阵与座位矩阵同形：走廊格权重为 null', () => {
  const g = expandGrid({
    rows: 1, cols: 3, mode: 'single', showAisle: true,
    seats: [], weights: [[5, 6, 7]],
  })
  assert.deepEqual(g.weights[0], [5, null, 6, null, 7])
  assert.equal(g.weights[0].length, g.seats[0].length, '权重与座位必须等宽，否则座位指数会下标错位')
})

test('扁平对象数组（{row,col,student_id|name}，1 基）也能迁成矩阵', () => {
  const g = expandGrid({
    rows: 2, cols: 2, mode: 'single', showAisle: false,
    seats: [{ row: 1, col: 2, student_id: 88 }, { row: 2, col: 1, name: '张三' }],
    weights: [],
  })
  assert.deepEqual(g.seats, [[null, 88], ['张三', null]])
})

// ---------------- 库内迁移 ----------------

test('新建库：默认 6×7 单人桌被展开成 6×13，且全为座位格', () => {
  const conn = freshDb()
  const cur = readSlot(conn, 'current')
  assert.equal(cur.rows, 6)
  assert.equal(cur.cols, 13)
  assert.equal(cur.types.length, 6)
  assert.ok(cur.types.every((r) => r.length === 13), 'types 必须与 cols 等宽')
  assert.deepEqual(cur.types[0], [SEAT, AISLE, SEAT, AISLE, SEAT, AISLE, SEAT, AISLE, SEAT, AISLE, SEAT, AISLE, SEAT])
  assert.equal(cur.seats.length, 6)
  assert.ok(cur.seats.every((r) => r.length === 13))
  conn.close()
})

test('老库四行一起迁：current / template / draft / weight', () => {
  const conn = freshDb()
  // 手工摆回「迁移前」的样子：dense seats + types 空
  putSlot(conn, 'current', { mode: 'single', rows: 2, cols: 3, seats: [[1, 2, 3], [4, null, null]], settings: { showAisle: true } })
  putSlot(conn, 'template', { mode: 'double', rows: 1, cols: 4, seats: [[1, 2, 3, 4]], settings: { showAisle: true } })
  putSlot(conn, 'draft', { mode: 'single', rows: 1, cols: 2, seats: [[9, 10]], settings: { showAisle: false } })
  putSlot(conn, 'weight', { mode: 'single', rows: 1, cols: 3, weights: [[1, 2, 3]], settings: { showAisle: true } })

  const stat = migrateSeatGrid(conn)
  assert.equal(stat.slots.migrated, 4)

  const cur = readSlot(conn, 'current')
  assert.equal(cur.cols, 5, '3 座位列 + 2 走廊')
  assert.deepEqual(cur.seats[0], [1, null, 2, null, 3])
  assert.deepEqual(cur.types[1], [SEAT, AISLE, SEAT, AISLE, SEAT])
  assert.equal(cur.mode, 'single')
  assert.equal(cur.settings.showAisle, true, 'settings 原样保留')

  const tpl = readSlot(conn, 'template')
  assert.equal(tpl.cols, 5, '4 座位列双人桌：走廊只插在两列之后 → 5 列')
  assert.deepEqual(tpl.seats[0], [1, 2, null, 3, 4])
  assert.deepEqual(tpl.types[0], [SEAT, SEAT, AISLE, SEAT, SEAT])

  const draft = readSlot(conn, 'draft')
  assert.equal(draft.cols, 2, 'showAisle=false 保持原列数')
  assert.deepEqual(draft.seats, [[9, 10]])
  assert.deepEqual(draft.types, [[SEAT, SEAT]])

  const w = readSlot(conn, 'weight')
  assert.equal(w.cols, 5)
  assert.deepEqual(w.weights, [[1, null, 2, null, 3]])
  assert.equal(w.types.length, 1, 'weight 行也写 types 作为几何标记（幂等判据）')
  conn.close()
})

test('历史快照 payload 一起迁，且不碰其它 domain', () => {
  const conn = freshDb()
  const ins = conn.prepare('INSERT INTO domain_history (domain, week_start, snap_date, mode, payload) VALUES (?,?,?,?,?)')
  ins.run('seat', '2026-11-02', '2026-11-03', 'single', JSON.stringify({
    mode: 'single', rows: 2, cols: 3, seats: [[1, 2, 3], [null, null, 4]], aisleCols: [], groupsConfig: [], settings: { showAisle: true },
  }))
  ins.run('seat', '2026-11-02', '2026-11-04', 'single', JSON.stringify({
    mode: 'single', rows: 1, cols: 2, seats: [[5, 6]], aisleCols: [], groupsConfig: [], settings: { showAisle: false },
  }))
  ins.run('duty', '2026-11-02', '2026-11-03', 'daily', JSON.stringify({ cells: { 项目: { 周一: ['张三'] } }, settings: {} }))

  const stat = migrateSeatGrid(conn)
  assert.equal(stat.history.migrated, 2)

  const rows = conn.prepare("SELECT snap_date, payload FROM domain_history WHERE domain = 'seat' ORDER BY snap_date").all()
  const day1 = JSON.parse(rows[0].payload)
  assert.equal(day1.cols, 5)
  assert.deepEqual(day1.seats, [[1, null, 2, null, 3], [null, null, null, null, 4]])
  assert.deepEqual(day1.types[0], [SEAT, AISLE, SEAT, AISLE, SEAT], '历史快照必须带 types，否则回看与指数都按旧几何解读')

  const day2 = JSON.parse(rows[1].payload)
  assert.equal(day2.cols, 2)
  assert.deepEqual(day2.seats, [[5, 6]])
  assert.deepEqual(day2.types, [[SEAT, SEAT]])

  const duty = JSON.parse(conn.prepare("SELECT payload FROM domain_history WHERE domain = 'duty'").get().payload)
  assert.deepEqual(duty.cells, { 项目: { 周一: ['张三'] } }, '值日快照不该被座位迁移碰到')
  conn.close()
})

test('幂等：第二次跑全部跳过，数据一字不改', () => {
  const conn = freshDb()
  putSlot(conn, 'current', { mode: 'single', rows: 2, cols: 3, seats: [[1, 2, 3], [null, null, 4]], settings: { showAisle: true } })
  const first = migrateSeatGrid(conn)
  assert.equal(first.slots.migrated, 1)

  const before = JSON.stringify(readSlot(conn, 'current'))
  const second = migrateSeatGrid(conn)
  assert.equal(second.slots.migrated, 0, '第二次不应再迁')
  assert.equal(second.slots.skipped, 4, '四行都应有非空 types')
  assert.equal(JSON.stringify(readSlot(conn, 'current')), before)
  conn.close()
})

test('尺寸非法的记录跳过而不是让整个迁移失败（不能因为一条脏记录卡住建库）', () => {
  const conn = freshDb()
  conn.prepare('UPDATE seat_slots SET rows = 0, cols = 0, types = ?, seats = ? WHERE kind = ?')
    .run(JSON.stringify([]), JSON.stringify([]), 'draft')
  const stat = migrateSeatGrid(conn)
  assert.equal(stat.slots.skipped >= 1, true)
  conn.close()
})

// ---------------- 列数上限 ----------------

test('迁移可能产出超过「座位列数」上限的网格，数据侧上限必须是网格列数', () => {
  const conn = freshDb()
  // 20 个座位列（旧上限允许 30 以内）+ 单人桌走廊 → 39 列
  const seats = [Array.from({ length: 20 }, (_, i) => i + 1)]
  putSlot(conn, 'current', { mode: 'single', rows: 1, cols: 20, seats, settings: { showAisle: true } })
  migrateSeatGrid(conn)
  const cur = readSlot(conn, 'current')
  assert.equal(cur.cols, 39)

  // 入库清洗不能再按 30 卡它，否则迁移后的每张表「一保存就报列数越界」
  assert.equal(SEAT_MAX_COLS, 30, '座位列数上限仍是 30（设置界面语义）')
  assert.ok(SEAT_MAX_GRID_COLS >= 39, `网格列数上限（${SEAT_MAX_GRID_COLS}）必须容纳 30 座位列展开`)
  const norm = normalizeSeats(cur.seats, 'seats')
  assert.equal(norm[0].length, 39)
  conn.close()
})
