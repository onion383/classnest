// =========================================================================
// seat-undo-rows.test.js —— 撤销「插入/删除行走廊」时，行数必须跟 types 一起回写
//
// 为什么单独一个文件：
//   插入行走廊会改变 rows。撤销走的是 grid_snapshot，它原本只回写 JSON 列（seats / types），
//   不认行数。撤掉一次「插入一行」后库里会变成「types 少一行、rows 还是多的」，
//   下次读库按 rows 去裁 types（routes/seats.js 的 gridShapeMismatch 分支）：
//   越界那行被补成座位、或整块降级成 []，走廊位置对不上；更糟的是降级成 [] 之后，
//   下次启动的一次性迁移会把已经展开过的矩阵**再展开一遍**（走廊翻倍）。
//   所以要逐条钉住：undo/redo 必须同时写 rows，且只对座位表生效（白名单）。
//
// 手法与 seat-types.test.js 一致：真内存库 + 真 schema + 真 store.setDoc。
// run-units 每个测试文件独立子进程，替换 db.js 导出不会污染别人。
// =========================================================================
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')

// db.js 会连带 require dbManager（需要主密钥与数据目录）
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = process.env.DATA_DIR || path.join(require('node:os').tmpdir(), 'seat-undo-rows-' + process.pid)

const { initSchema } = require('../../student-backend/schema/schema')

// ---------- 把 db.js 的 db 导出换成「当前用例的内存库」（必须在 require 执行器之前）----------
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
}

const { executors } = require('../../student-backend/routes/undo/undo.executors')
const store = require('../../student-backend/services/slotStore')

function freshDb() {
  const conn = new Database(':memory:')
  initSchema(conn)
  active.conn = conn
  return conn
}

// 座位表现在是「逻辑表 → slotStore」，直接走 store 写入，与路由同一入口
function seed(table, rows, cols, types, seats) {
  store.setDoc(table, {
    rows,
    cols,
    types: JSON.stringify(types),
    seats: JSON.stringify(seats),
    mode: 'single',
  })
}

// 座位表现在是「逻辑表 → slotStore」，读也走同一入口：seat_slots 是按 kind 分行的，
// 直接 SELECT WHERE id=1 只会拿到 current 那行，测模板就会测到另一张表上。
function read(table) {
  return store.getDoc(table)
}

const AISLE = 1
const SEAT = 0
const cols = 5
const TYPES3 = [
  [SEAT, AISLE, SEAT, SEAT, SEAT],
  [SEAT, AISLE, SEAT, SEAT, SEAT],
  [SEAT, AISLE, SEAT, SEAT, SEAT],
]
// 插入后的状态：第 1 行插入一条整行走廊 → 4 行
const TYPES4 = [
  [SEAT, AISLE, SEAT, SEAT, SEAT],
  [AISLE, AISLE, AISLE, AISLE, AISLE],
  [SEAT, AISLE, SEAT, SEAT, SEAT],
  [SEAT, AISLE, SEAT, SEAT, SEAT],
]
const blank = (n) => Array.from({ length: n }, () => Array(cols).fill(null))

// ---------------------------------------------------------------------------

test('undo 插入行走廊：rows 必须跟 types 一起退回（否则读回被裁/降级）', () => {
  freshDb()
  seed('seat_layout', 4, cols, TYPES4, blank(4))
  // 这条记录描述的是「从 3 行变成 4 行的插入」，undo 要写回 3 行
  executors.grid_snapshot.undo({
    table: 'seat_layout',
    oldValue: { seats: blank(3), types: TYPES3 },
    oldRows: 3,
    newValue: { seats: blank(4), types: TYPES4 },
    newRows: 4,
  })
  const rec = read('seat_layout')
  assert.equal(rec.rows, 3, 'rows 没退回去 → 库里变成「types 3 行、rows 4」')
  assert.deepEqual(JSON.parse(rec.types), TYPES3)
  assert.equal(JSON.parse(rec.types).length, rec.rows, 'types 行数与 rows 必须相等')
})

test('redo 插入行走廊：行数同样跟着回去（撤销后能重做回 4 行）', () => {
  freshDb()
  seed('seat_layout', 3, cols, TYPES3, blank(3))
  executors.grid_snapshot.redo({
    table: 'seat_layout',
    oldValue: { seats: blank(3), types: TYPES3 },
    oldRows: 3,
    newValue: { seats: blank(4), types: TYPES4 },
    newRows: 4,
  })
  const rec = read('seat_layout')
  assert.equal(rec.rows, 4)
  assert.equal(JSON.parse(rec.types).length, 4)
})

test('删除行走廊的撤销（rows +1）同样成对回写', () => {
  freshDb()
  seed('seat_layout', 3, cols, TYPES3, blank(3))
  // 记录描述「从 4 行删成 3 行」，undo 要补回 4 行
  executors.grid_snapshot.undo({
    table: 'seat_layout',
    oldValue: { seats: blank(4), types: TYPES4 },
    oldRows: 4,
    newValue: { seats: blank(3), types: TYPES3 },
    newRows: 3,
  })
  const rec = read('seat_layout')
  assert.equal(rec.rows, 4)
  assert.equal(JSON.parse(rec.types).length, 4)
})

test('座位模板同样支持；老记录（不带 oldRows）行为不变，不会把 rows 改成 undefined', () => {
  for (const table of ['seat_template', 'seat_layout']) {
    freshDb()
    seed(table, 4, cols, TYPES4, blank(4))
    // 不带 oldRows：老的换位/空位记录都是这种，必须保持「只回写 JSON 列」
    executors.grid_snapshot.undo({ table, oldValue: { seats: blank(4), types: TYPES4 }, oldRows: undefined })
    assert.equal(Number(read(table).rows), 4, `${table}：老记录不该动行数`)
  }
})

test('非座位表不收 oldRows：权重表也有 rows 列，但不能被行数回写动到', () => {
  freshDb()
  // seat_weight 是唯一「不是座位表却有 rows 列」的网格表 —— 白名单真正的守点在这里。
  // 只判断 Number.isInteger(rows) 是不够的：去掉白名单后这里会被改成 3。
  store.setDoc('seat_weight', {
    rows: 4, cols, weights: JSON.stringify(blank(4)), types: JSON.stringify(TYPES4),
  })
  executors.grid_snapshot.undo({ table: 'seat_weight', oldValue: blank(4), oldRows: 3 })
  assert.equal(Number(read('seat_weight').rows), 4, '权重表的 rows 不该被撤销记录的行数字段改掉')
})

test('types 写不进去时，行数不能被单独改掉（顺序 + 事务双保险）', () => {
  freshDb()
  seed('seat_layout', 4, cols, TYPES4, blank(4))
  const cyclicSeats = []
  cyclicSeats.push(cyclicSeats) // 序列化时抛 TypeError
  assert.throws(() => {
    executors.grid_snapshot.undo({
      table: 'seat_layout',
      oldValue: { seats: cyclicSeats, types: TYPES3 },
      oldRows: 3,
    })
  })
  assert.equal(Number(read('seat_layout').rows), 4,
    'types 没写成功、行数却改了，就是「types 少一行、rows 还是多的」那个坏状态')
})

// ---------------------------------------------------------------------------
// 列走廊：与行完全同源的第二个字段。列数不回写时读库按 cols 裁 types，
// 右端那条刚撤掉的走廊会被截掉 —— 和「rows 少一行」是同一类损坏，
// 只是方向不同，所以必须单独钉一遍（只测 rows 的判据抓不到它）。
// ---------------------------------------------------------------------------
const cols6 = 6
// 3 行 5 列 → 在第 2 列插一条走廊列 → 3 行 6 列
const TYPES_C5 = [
  [SEAT, SEAT, AISLE, SEAT, SEAT],
  [SEAT, SEAT, AISLE, SEAT, SEAT],
  [SEAT, SEAT, AISLE, SEAT, SEAT],
]
const TYPES_C6 = [
  [SEAT, SEAT, AISLE, AISLE, SEAT, SEAT],
  [SEAT, SEAT, AISLE, AISLE, SEAT, SEAT],
  [SEAT, SEAT, AISLE, AISLE, SEAT, SEAT],
]
const blankC = (n, w) => Array.from({ length: n }, () => Array(w).fill(null))

test('undo 插入走廊列：cols 必须跟 types 一起退回', () => {
  freshDb()
  seed('seat_layout', 3, cols6, TYPES_C6, blankC(3, cols6))
  executors.grid_snapshot.undo({
    table: 'seat_layout',
    oldValue: { seats: blankC(3, cols), types: TYPES_C5 },
    oldRows: 3,
    oldCols: cols,
    newValue: { seats: blankC(3, cols6), types: TYPES_C6 },
    newRows: 3,
    newCols: cols6,
  })
  const rec = read('seat_layout')
  assert.equal(Number(rec.cols), cols, 'cols 没退回去 → 库里「types 5 列、cols 6」，右端被裁')
  assert.deepEqual(JSON.parse(rec.types), TYPES_C5)
  assert.equal(JSON.parse(rec.types)[0].length, Number(rec.cols), 'types 列数与 cols 必须相等')
})

test('redo 插入走廊列：列数同样跟着回去', () => {
  freshDb()
  seed('seat_layout', 3, cols, TYPES_C5, blankC(3, cols))
  executors.grid_snapshot.redo({
    table: 'seat_layout',
    oldValue: { seats: blankC(3, cols), types: TYPES_C5 },
    oldRows: 3,
    oldCols: cols,
    newValue: { seats: blankC(3, cols6), types: TYPES_C6 },
    newRows: 3,
    newCols: cols6,
  })
  const rec = read('seat_layout')
  assert.equal(Number(rec.cols), cols6)
  assert.equal(JSON.parse(rec.types)[0].length, cols6)
})

test('老记录（不带 oldCols）不动列数；权重表不在白名单里，cols 也不许被改', () => {
  freshDb()
  seed('seat_layout', 3, cols6, TYPES_C6, blankC(3, cols6))
  executors.grid_snapshot.undo({ table: 'seat_layout', oldValue: { seats: blankC(3, cols6), types: TYPES_C6 } })
  assert.equal(Number(read('seat_layout').cols), cols6, '老记录不该动列数')

  freshDb()
  store.setDoc('seat_weight', {
    rows: 3, cols: cols6, weights: JSON.stringify(blankC(3, cols6)), types: JSON.stringify(TYPES_C6),
  })
  executors.grid_snapshot.undo({ table: 'seat_weight', oldValue: blankC(3, cols6), oldCols: cols })
  assert.equal(Number(read('seat_weight').cols), cols6, '权重表的 cols 不该被撤销记录的列数字段改掉')
})

test('types 写不进去时，列数也不能被单独改掉', () => {
  freshDb()
  seed('seat_layout', 3, cols6, TYPES_C6, blankC(3, cols6))
  const cyclicSeats = []
  cyclicSeats.push(cyclicSeats)
  assert.throws(() => {
    executors.grid_snapshot.undo({
      table: 'seat_layout',
      oldValue: { seats: cyclicSeats, types: TYPES_C5 },
      oldCols: cols,
    })
  })
  assert.equal(Number(read('seat_layout').cols), cols6, 'types 没写成功、列数却改了，右端会被截掉')
})
