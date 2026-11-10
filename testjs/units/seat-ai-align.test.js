// =========================================================================
// seat-ai-align.test.js —— 座位网格与「对外文案/快照/AI 输出」的对齐
//
// 异形网格改造后 corridors（走廊）是 seats 里的**真实列**，于是任何「第几列」
// 都不能再拿网格下标直接用：一张 7 座位列的座位表网格宽 13，直接报下标会得到
// 「第3行第13列」，而页面上那一格写的是「列7」。本文件守三类出口：
//   ① 纯几何换算 services/seatGrid.js（列类型 / 座位列序号 / 表头）
//   ② 历史快照 payload services/seatSnapshot.js（必须带 types，否则走廊被当空座位）
//   ③ AI 出口：export_image 的座位排布图、run_conflict_checks 的查重位置、
//      run_search_all 的座位命中位置（全部按座位列序号报列）
//
// 手法与 seat-types.test.js 一致：把 db.js 的 db 导出换成当前测试用例的内存库，
// 再 require 真正要测的模块 —— 断言跑的是**真实源码**，不是本地复刻的逻辑。
// =========================================================================
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')
const express = backendRequire('express')

process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = process.env.DATA_DIR || path.join(require('node:os').tmpdir(), 'seat-ai-align-unit-' + process.pid)

const { initSchema } = require('../../student-backend/schema/schema')

// ---------- 用内存库替换 db.js 的 db 导出（必须在 require 被测模块之前）----------
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
  // getFields 是 db.js 里唯一绕开 db 代理、自己调 dbManager.current() 的 helper：
  // 不覆盖它，AI 写入链路（colType → getFields）会抛「未绑定数据库连接」。
  getFields: (tableName) => active.conn.prepare(
    'SELECT column_name AS name, data_type AS type FROM table_meta WHERE table_name = ? ORDER BY sort_order'
  ).all(tableName),
}

const {
  SEAT_CELL, columnKinds, seatColumnIndices, gridToDenseCols, columnLabels, rowIsAisle,
} = require('../../student-backend/services/seatGrid')
const { seatSnapshotPayload } = require('../../student-backend/services/seatSnapshot')
const { assertSeatRefs, validateRow } = require('../../student-backend/services/businessRules')
const { buildExportImage } = require('../../student-backend/routes/ai/ai.tools/tools.executors/executors.image')
const { runConflictChecks } = require('../../student-backend/routes/ai/ai.tools/tools.executors/executors.checks')
const { runSearchAll } = require('../../student-backend/routes/ai/ai.tools/tools.executors/executors.query')
const aiRouter = require('../../student-backend/routes/ai/ai.dataRoutes')

function freshDb() {
  const conn = new Database(':memory:')
  initSchema(conn)
  active.conn = conn
  return conn
}

// 7 列：1/3/5 是走廊列 → 座位列 4 个（网格下标 0,2,4,6）
const COLS = 7
const TYPES = [
  [0, 1, 0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0, 1, 0],
]
const ROWS = 3

function seedLayout({ seats, types = TYPES, rows = ROWS, cols = COLS }) {
  // schema 已种好 current/template/draft/weight 四行（kind 是主键），这里只改 current
  active.conn.prepare(
    `UPDATE seat_slots SET mode = 'single', rows = ?, cols = ?, seats = ?, types = ? WHERE kind = 'current'`
  ).run(rows, cols, JSON.stringify(seats), JSON.stringify(types))
}

function seedStudent(id, name) {
  active.conn.prepare('INSERT INTO students (id, 姓名) VALUES (?, ?)').run(id, name)
}

// ---------------------------------------------------------------------------
// ① 纯几何换算

test('columnKinds / columnLabels：走廊列标「走廊」，座位列按序号标「列N」', () => {
  assert.deepEqual(columnKinds(COLS, TYPES), ['seat', 'aisle', 'seat', 'aisle', 'seat', 'aisle', 'seat'])
  assert.deepEqual(columnLabels(COLS, TYPES), ['列1', '走廊', '列2', '走廊', '列3', '走廊', '列4'])
  // types 缺席（老数据）时全部当座位列，不能把整张表标成走廊
  assert.deepEqual(columnLabels(COLS, []), ['列1', '列2', '列3', '列4', '列5', '列6', '列7'])
})

test('gridToDenseCols：网格下标 → 座位列序号，走廊为 -1', () => {
  assert.deepEqual(gridToDenseCols(COLS, TYPES), [0, -1, 1, -1, 2, -1, 3])
  assert.deepEqual(seatColumnIndices(COLS, TYPES), [0, 2, 4, 6])
  // 无 types 时恒等映射（老数据按网格下标即座位列序号）
  assert.deepEqual(gridToDenseCols(3, []), [0, 1, 2])
})

test('rowIsAisle：整行走廊才算，局部走廊格不算', () => {
  assert.equal(rowIsAisle(TYPES, 0), false)
  const withRowAisle = [[0, 1, 0], [1, 1, 1], [0, 1, 0]]
  assert.equal(rowIsAisle(withRowAisle, 1), true)
  assert.equal(rowIsAisle(withRowAisle, 0), false)
  assert.equal(rowIsAisle([], 0), false)
})

// ---------------------------------------------------------------------------
// ② 快照 payload

test('seatSnapshotPayload 必须带 types（缺了走廊就被当成空座位）', () => {
  const payload = seatSnapshotPayload({
    mode: 'single', rows: 2, cols: 3,
    seats: JSON.stringify([[1, null, 2], [3, null, 4]]),
    types: JSON.stringify([[0, 1, 0], [0, 1, 0]]),
    settings: JSON.stringify({ a: 1 }),
  })
  assert.deepEqual(payload.types, [[0, 1, 0], [0, 1, 0]], 'types 必须原样进快照')
  assert.deepEqual(payload.seats, [[1, null, 2], [3, null, 4]])
  assert.equal(payload.mode, 'single')
  assert.deepEqual(payload.settings, { a: 1 })
  // 形状稳定：AI 检索/导出仍按这两个老键读
  assert.deepEqual(payload.aisleCols, [])
  assert.deepEqual(payload.groupsConfig, [])
})

test('seatSnapshotPayload：畸形 JSON 降级为空值而不是抛错（补录整批不能因一条脏记录失败）', () => {
  const payload = seatSnapshotPayload({ mode: 'single', rows: 2, cols: 2, seats: '{oops', types: '[', settings: 'x' })
  assert.deepEqual(payload.seats, [])
  assert.deepEqual(payload.types, [])
  assert.deepEqual(payload.settings, {})
})

// ---------------------------------------------------------------------------
// ③ AI 出口

test('export_image 的座位图：走廊列标「走廊」，座位按列序号，行走廊整排写「走廊」', () => {
  freshDb()
  seedStudent(11, '张三')
  const types = [
    [0, 1, 0, 1, 0, 1, 0],
    [1, 1, 1, 1, 1, 1, 1],
    [0, 1, 0, 1, 0, 1, 0],
  ]
  seedLayout({
    types,
    seats: [
      [null, null, 11, null, null, null, null],
      [null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null],
    ],
  })
  const img = buildExportImage({ targets: 'seat' })
  assert.equal(img.error, undefined, JSON.stringify(img))
  const seat = img.spec.items[0]

  // 表头：不能出现「第3列」这种网格下标口径，也不能把走廊列算成座位列
  assert.deepEqual(seat.columns, ['', '列1', '走廊', '列2', '走廊', '列3', '走廊', '列4'])

  // 行首是「第N排」，所以数据格下标 = 网格列下标 + 1
  // 张三在第 1 排、网格第 3 列（下标 2）→ 座位列序号 2
  assert.equal(seat.rows[0][2], '', '网格第 2 列是走廊')
  assert.equal(seat.rows[0][3], '张三', '网格第 3 列 = 列2')
  // 行走廊整排：每格都写「走廊」，否则这一排在图上只是一条空行
  assert.deepEqual(seat.rows[1].slice(1), Array(7).fill('走廊'))
})

test('run_conflict_checks 查重：位置按座位列序号报，不拿网格下标当列号', () => {
  freshDb()
  seedStudent(11, '张三')
  // 同一人坐在 网格(第1行,第3列) 与 网格(第3行,第7列) → 座位列 列2 / 列4
  seedLayout({
    seats: [
      [null, null, 11, null, null, null, null],
      [null, null, null, null, null, null, null],
      [null, null, null, null, null, null, 11],
    ],
  })
  const res = runConflictChecks({ checks: 'seat_duplicate' })
  const issue = (res.issues || []).find((x) => x.type === 'seat_duplicate')
  assert.ok(issue, '应报出重复座位：' + JSON.stringify(res))
  assert.deepEqual(issue.items[0].位置, [{ 排: 1, 列: 2 }, { 排: 3, 列: 4 }])
})

test('run_search_all 的座位命中：列号是座位列序号（不含走廊）', () => {
  freshDb()
  seedStudent(11, '张三')
  seedLayout({
    seats: [
      [null, null, 11, null, null, null, null],
      [null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null],
    ],
  })
  const res = runSearchAll({ query: '张三', tables: 'seat_layout' })
  const sec = (res.sections || []).find((s) => s.table === 'seat_layout')
  assert.ok(sec, '应命中座位表：' + JSON.stringify(res))
  assert.equal(sec.items[0].列, 2, '网格第 3 列应报成「列2」')
  assert.equal(sec.items[0].排, 1)
  assert.equal(sec.items[0].姓名, '张三')
})

test('一人多座 的报错文案用座位列序号；没有 types 时退回网格下标', () => {
  freshDb()
  seedStudent(11, '张三')
  const dupe = [
    [null, null, 11, null, null, null, null],
    [null, null, null, null, null, null, 11],
  ]
  assert.throws(
    () => assertSeatRefs(dupe, 'seats', [[0, 1, 0, 1, 0, 1, 0], [0, 1, 0, 1, 0, 1, 0]]),
    /第2行第4列/,
    '第二次出现在网格第 7 列 = 座位列 4'
  )
  // 老数据没有 types：按网格下标报，不能因为拿不到几何就吞掉提示
  assert.throws(() => assertSeatRefs(dupe, 'seats', []), /第2行第7列/)

  // 必须从**真实写入口** validateRow 也验一遍：只测纯函数会假绿 ——
  // 调用点忘了把 types 传进去时，纯函数照样是对的，用户看到的仍是网格下标。
  assert.throws(
    () => validateRow('seat_layout', {
      rows: 2, cols: 7, seats: dupe,
      types: [[0, 1, 0, 1, 0, 1, 0], [0, 1, 0, 1, 0, 1, 0]],
    }),
    /第2行第4列/,
    'validateRow 必须把 types 带进 assertSeatRefs'
  )
  assert.equal(SEAT_CELL.AISLE, 1)
})

// AI 整块写入前的自动快照：真实走 POST /doc 这条链路。
// 只测 seatSnapshotPayload 会假绿 —— ai.dataRoutes 完全可以自己拼一份 payload，
// 而那正是本次修的 bug（手抄字段表漏了 types）。
test('AI 整块写座位表前的自动快照必须带 types（POST /doc 真实链路）', async () => {
  freshDb()
  seedStudent(11, '张三')
  const seatsBefore = [
    [null, null, 11, null, null, null, null],
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
  ]
  seedLayout({ seats: seatsBefore })

  const app = express()
  app.use(express.json())
  app.use('/api/ai', aiRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const port = server.address().port
  let res
  try {
    // 只写 seats（AI 的整块写入不会带 types）
    res = await fetch(`http://127.0.0.1:${port}/api/ai/doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        table: 'seat_layout',
        id: 1,
        values: { seats: [[null, null, null, null, null, null, 11], [null, null, null, null, null, null, null], [null, null, null, null, null, null, null]] },
      }),
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  assert.equal(res.status, 200, '写入应成功：' + (await res.text()).slice(0, 200))

  const rec = active.conn.prepare("SELECT payload FROM domain_history WHERE domain = 'seat' ORDER BY id DESC LIMIT 1").get()
  assert.ok(rec, '写入前应落一条座位快照')
  const payload = JSON.parse(rec.payload)
  assert.deepEqual(payload.types, TYPES, '快照缺 types 会让回看历史时走廊列变成空座位')
  assert.deepEqual(payload.seats, seatsBefore, '快照存的应是写入前的旧座位')
})
