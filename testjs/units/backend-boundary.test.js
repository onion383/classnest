// =========================================================================
// backend-boundary.test.js —— 「写入边界与实际结构脱节」的行为断言
//
// 覆盖 v4 台账 B02-09 / B02-04（批 15）：
//   · B02-09 seats 的 PATCH /cell：只校全局上限 SEAT_MAX(50×30)，不校**当前布局**
//     的 rows/cols。单格写入是唯一不经过 normalizeSeats 的写入口 → 坐标超出当前
//     网格时，seats JSON 会被撑出一大片空行（最多 50 行 × 30 列），而 rows/cols
//     还写着旧值 —— 前端按 rows/cols 渲染，多出来的行永远看不见，但占着库。
//   · B02-04 renameSeatCells：座位格用 trim 后比较（`cell.trim() === oldName`），
//     写回时却直接赋 newName → 原文的首尾空格被丢掉；而值日表 renameDutyName 用
//     严格 `===`。同一批「只存姓名」的表，匹配口径不一致 → 改完名后有些表改了、
//     有些没改，同一个学生在不同表里名字对不上。
//
// 手法：沿用批 14 的脚手架 —— 把 student-backend/db.js 的 db 导出换成「代理到真内存库」，
//      在同进程起 Express 挂真实 router，用 fetch 打真实 HTTP。
//      路由、slotStore、SQLite 全是真的。
//
// 运行：npm run test:units
// =========================================================================
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')
const express = backendRequire('express')

process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'boundary-unit-' + process.pid)

const { initSchema } = require('../../student-backend/schema/schema')

// ---------- 代理到真连接（批 14 的 makeFaultyDb 去掉故障注入部分） ----------
function makeDb(conn) {
  return new Proxy({}, {
    get(_target, prop) {
      const value = conn[prop]
      if (typeof value !== 'function') return value
      return value.bind(conn)
    },
  })
}

const dbPath = require.resolve(path.join(ROOT, 'student-backend/db.js'))
const realDbModule = require(dbPath)
const active = { conn: null }
require.cache[dbPath].exports = {
  ...realDbModule,
  db: new Proxy({}, {
    get(_target, prop) {
      if (!active.conn) return undefined
      return makeDb(active.conn)[prop]
    },
  }),
  // db.js 的 getFields / renumber 不走 db 导出，而是直接调内部 currentDb()，
  // 内部读 dbManager 的 ALS 上下文 —— 单测里没走 auth 中间件，没有绑定库。
  // 这里也一并换成当前内存连接，否则 dynamicTable 的列元数据查询会抛「未绑定数据库连接」。
  getFields: (tableName) => active.conn.prepare(
    `SELECT column_name AS name, data_type AS type FROM table_meta WHERE table_name = ? ORDER BY sort_order`
  ).all(tableName),
  renumber: () => {},
}

const seatsRouter = require('../../student-backend/routes/seats')
const { createDynamicTableRouter } = require('../../student-backend/routes/dynamicTable')
const { renameStudentRefs } = require('../../student-backend/services/studentRename')

// students 的动态表路由是工厂函数（每个逻辑表一个实例），这里建一个专用的
const studentsRouter = createDynamicTableRouter('students')

// ---------- 起一个同进程的 Express，真打 HTTP ----------
async function callApi(routes, method, urlPath, body) {
  const app = express()
  app.use(express.json())
  for (const [prefix, router] of routes) app.use(prefix, router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const port = server.address().port
  try {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch (_) { /* 非 JSON 也是信息 */ }
    return { status: res.status, text, json }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function freshDb() {
  const conn = new Database(':memory:')
  initSchema(conn)
  return conn
}

// seat_slots 的 kind='current' 播种行：mode/rows/cols/seats/...
function setSeatLayout(conn, rows, cols, seats) {
  conn.prepare(
    `UPDATE seat_slots SET rows = ?, cols = ?, seats = ? WHERE kind = 'current'`
  ).run(rows, cols, JSON.stringify(seats))
}

function readSeatLayout(conn) {
  return conn.prepare("SELECT rows, cols, seats FROM seat_slots WHERE kind = 'current'").get()
}

// ---------------------------------------------------------------------------
// B02-09：单格写入不能把座位矩阵撑到当前布局之外
// ---------------------------------------------------------------------------

test('seats 的 PATCH /cell：坐标超出当前布局行列时必须被拒（不能撑出空行）', async () => {
  const conn = freshDb()
  // 当前布局只有 3 行 2 列
  const grid = [['甲', '乙'], ['丙', '丁'], ['戊', '己']]
  setSeatLayout(conn, 3, 2, grid)
  active.conn = conn

  // 写 row=10 —— 远超当前 3 行。全局上限是 50，所以旧实现会放行
  const r = await callApi(
    [['/api/seats', seatsRouter]],
    'PATCH', '/api/seats/cell', { row: 10, col: 0, value: '越界' }
  )
  assert.equal(r.status, 400, '越界坐标应被拒（实际 ' + r.status + '：' + r.text.slice(0, 160) + '）')

  const after = readSeatLayout(conn)
  assert.equal(after.rows, 3, 'rows 不该被单格写入改动')
  assert.equal(after.cols, 2, 'cols 不该被单格写入改动')
  const seats = JSON.parse(after.seats)
  assert.ok(
    seats.length <= 3,
    'seats 行数不能超过当前布局行数 3（实际 ' + seats.length + ' 行：' + after.seats.slice(0, 200) + '）'
  )
  assert.deepEqual(seats[0], ['甲', '乙'], '原有座位内容不能被改动')
})

test('seats 的 PATCH /cell：列坐标超出当前布局列数时同样必须被拒', async () => {
  const conn = freshDb()
  setSeatLayout(conn, 3, 2, [['甲', '乙'], ['丙', '丁'], ['戊', '己']])
  active.conn = conn

  const r = await callApi(
    [['/api/seats', seatsRouter]],
    'PATCH', '/api/seats/cell', { row: 0, col: 9, value: '越界' }
  )
  assert.equal(r.status, 400, '越界列坐标应被拒（实际 ' + r.status + '：' + r.text.slice(0, 160) + '）')

  const after = readSeatLayout(conn)
  const seats = JSON.parse(after.seats)
  assert.ok(
    (seats[0] || []).length <= 2,
    '首行列数不能超过当前布局列数 2（实际 ' + (seats[0] || []).length + '）'
  )
})

test('seats 的 PATCH /master/cell：模板的坐标也必须校当前布局（不能只修当前座位表）', async () => {
  const conn = freshDb()
  // 模板的布局与当前座位表是**两套独立记录**（seat_slots 的 kind='template'）
  conn.prepare("UPDATE seat_slots SET rows = ?, cols = ?, seats = ? WHERE kind = 'template'")
    .run(3, 2, JSON.stringify([['甲', '乙'], ['丙', '丁'], ['戊', '己']]))
  active.conn = conn

  const r = await callApi(
    [['/api/seats', seatsRouter]],
    'PATCH', '/api/seats/master/cell', { row: 10, col: 0, value: '越界' }
  )
  assert.equal(r.status, 400, '模板的越界坐标也应被拒（实际 ' + r.status + '：' + r.text.slice(0, 160) + '）')

  const after = JSON.parse(
    conn.prepare("SELECT seats FROM seat_slots WHERE kind = 'template'").get().seats
  )
  assert.ok(after.length <= 3, '模板 seats 行数不能超过 3（实际 ' + after.length + '）')
})

test('seats 的 PATCH /cell：布局内的合法坐标必须照常写入（不能误伤）', async () => {
  const conn = freshDb()
  setSeatLayout(conn, 3, 2, [['甲', '乙'], ['丙', '丁'], ['戊', '己']])
  active.conn = conn

  const r = await callApi(
    [['/api/seats', seatsRouter]],
    'PATCH', '/api/seats/cell', { row: 2, col: 1, value: '新值' }
  )
  assert.equal(r.status, 200, '布局内的坐标应写入成功（实际 ' + r.status + '：' + r.text.slice(0, 160) + '）')

  const after = readSeatLayout(conn)
  const seats = JSON.parse(after.seats)
  assert.equal(seats[2][1], '新值', '目标格应写入新值（实际 ' + JSON.stringify(seats) + '）')
  assert.equal(seats[0][0], '甲', '其他格不能被改动')
})

// ---------------------------------------------------------------------------
// B02-04：改名级联的匹配口径必须一致
// ---------------------------------------------------------------------------

test('studentRename：改名级联必须六处同一口径 —— 带空格的旧名变体也要一起改', () => {
  const conn = freshDb()
  active.conn = conn
  //
  // 根因不在「座位表丢空格」，而在**匹配口径不一致**：
  //   · 座位表 renameSeatCells 用 `cell.trim() === oldName`（宽松）
  //   · 值日表 renameDutyName 用严格 `list[i] === oldName`（严）
  //   · 四张 SQL 表用 `WHERE 姓名 = ?`（严）
  // 同一个「语义上等于旧名」的格子（' 张三 ' / '张三'），改名时有的被改、有的没被改
  // → 同一学生在值日表叫旧名、在座位表叫新名 → 值日指数再也归不到他名下，且界面不报错。
  //
  // 正确口径：**统一为 trim 匹配 + 写回规范名**（students.姓名 落库时已 cleanText 规范过）。
  // 写回保留空格反而是错的：下游 DutyView/SeatView 的 acc[name] 是**精确键聚合**，
  // 留着 ' 李四 ' 会让统计键分裂成 '李四' 和 ' 李四 ' 两个桶。
  conn.prepare("UPDATE duty_slots SET cells = ? WHERE kind = 'current'")
    .run(JSON.stringify({ daily: { 扫地: { 1: [' 张三 '] } } }))
  conn.prepare("UPDATE seat_slots SET seats = ? WHERE kind = 'current'")
    .run(JSON.stringify([[' 张三 ']]))
  conn.prepare("INSERT INTO score_records (姓名, 分值) VALUES (?, ?)").run(' 张三 ', 5)

  const r = renameStudentRefs('张三', '李四')
  assert.equal(r.counts.duty, 1, '值日表应改名（实际 ' + r.counts.duty + '）')
  assert.equal(r.counts.seat, 1, '座位表应改名（实际 ' + r.counts.seat + '）')
  assert.equal(r.counts.score, 1, '加减分表应改名（实际 ' + r.counts.score + '）')

  const duty = JSON.parse(
    conn.prepare("SELECT cells FROM duty_slots WHERE kind = 'current'").get().cells
  )
  assert.deepEqual(
    duty.daily.扫地['1'], ['李四'],
    '值日表里应写成规范名「李四」（实际 ' + JSON.stringify(duty) + '）'
  )
  const seat = JSON.parse(
    conn.prepare("SELECT seats FROM seat_slots WHERE kind = 'current'").get().seats
  )
  assert.deepEqual(
    seat[0], ['李四'],
    '座位表里应写成规范名「李四」（实际 ' + JSON.stringify(seat) + '）'
  )
  const score = conn.prepare("SELECT 姓名 FROM score_records").all()
  assert.deepEqual(
    score.map((x) => x.姓名), ['李四'],
    '加减分表里应写成规范名「李四」（实际 ' + JSON.stringify(score) + '）'
  )
})

test('studentRename：值日表与座位表的姓名匹配口径必须一致（同一份数据只改一处不行）', () => {
  const conn = freshDb()
  active.conn = conn

  // 值日表 cells：{ daily: { 扫地: { 1: ['张三'] } } }
  conn.prepare("UPDATE duty_slots SET cells = ? WHERE kind = 'current'")
    .run(JSON.stringify({ daily: { 扫地: { 1: ['张三'] } } }))
  conn.prepare("UPDATE seat_slots SET seats = ? WHERE kind = 'current'")
    .run(JSON.stringify([['张三']]))

  const r = renameStudentRefs('张三', '李四')
  assert.equal(r.counts.duty, 1, '值日表应改名（实际 ' + r.counts.duty + '）')
  assert.equal(r.counts.seat, 1, '座位表应改名（实际 ' + r.counts.seat + '）')

  const duty = JSON.parse(
    conn.prepare("SELECT cells FROM duty_slots WHERE kind = 'current'").get().cells
  )
  assert.deepEqual(duty.daily.扫地['1'], ['李四'], '值日表里应是新名（实际 ' + JSON.stringify(duty) + '）')
  const seat = JSON.parse(
    conn.prepare("SELECT seats FROM seat_slots WHERE kind = 'current'").get().seats
  )
  assert.deepEqual(seat[0], ['李四'], '座位表里应是新名（实际 ' + JSON.stringify(seat) + '）')
})

// ---------------------------------------------------------------------------
// B02-04 同族漏网：删除学生路径（studentRelations）的姓名匹配口径
// ---------------------------------------------------------------------------

test('studentRelations：删除学生时，值日表里的带空格旧名也必须被统计与清理', () => {
  const conn = freshDb()
  active.conn = conn
  const { studentRelations, purgeStudentRelations } = require('../../student-backend/services/studentRelations')

  const ins = conn.prepare('INSERT INTO students (姓名, 学号) VALUES (?, ?)')
  ins.run('张三', 'A001')
  const student = conn.prepare('SELECT * FROM students WHERE id = 1').get()

  // 值日表里存的是 ' 张三 '（带空格）；座位格是对象形态 { name: ' 张三 ' }
  conn.prepare("UPDATE duty_slots SET cells = ? WHERE kind = 'current'")
    .run(JSON.stringify({ daily: { 扫地: { 1: [' 张三 '] } } }))
  conn.prepare("UPDATE seat_slots SET seats = ? WHERE kind = 'current'")
    .run(JSON.stringify([[{ name: ' 张三 ' }]]))

  const refs = studentRelations(student)
  assert.equal(
    refs.duty, 1,
    '值日表里的带空格旧名应被统计到（实际 ' + refs.duty + '）—— 否则删除确认框不提示，用户不知道值日表里还挂着这个人'
  )
  assert.equal(refs.seat, 1, '座位表里的带空格旧名应被统计到（实际 ' + refs.seat + '）')

  const purged = purgeStudentRelations(student, { seat: true, duty: true })
  assert.equal(purged.duty, 1, '值日表里的带空格旧名应被清理（实际 ' + purged.duty + '）')
  assert.equal(purged.seat, 1, '座位表里的带空格旧名应被清理（实际 ' + purged.seat + '）')

  const duty = JSON.parse(
    conn.prepare("SELECT cells FROM duty_slots WHERE kind = 'current'").get().cells
  )
  assert.deepEqual(duty.daily.扫地['1'], [], '值日表里不应残留旧名（实际 ' + JSON.stringify(duty) + '）')
  const seat = JSON.parse(
    conn.prepare("SELECT seats FROM seat_slots WHERE kind = 'current'").get().seats
  )
  assert.deepEqual(seat[0], [null], '座位表里不应残留旧名（实际 ' + JSON.stringify(seat) + '）')
})

test('studentRename：座位格的对象形态（{name} / {姓名}）也必须按同一口径改名', () => {
  const conn = freshDb()
  active.conn = conn
  // 座位格里存的是对象形态，且带空格：{ name: ' 张三 ' } / { 姓名: ' 张三 ' }
  conn.prepare("UPDATE seat_slots SET seats = ? WHERE kind = 'current'")
    .run(JSON.stringify([[{ name: ' 张三 ' }, { 姓名: ' 张三 ' }]]))

  const r = renameStudentRefs('张三', '李四')
  assert.equal(r.counts.seat, 2, '对象形态的两个字段都应改名（实际 ' + r.counts.seat + '）')

  const seat = JSON.parse(
    conn.prepare("SELECT seats FROM seat_slots WHERE kind = 'current'").get().seats
  )
  assert.equal(seat[0][0].name, '李四', 'name 字段应写成规范名（实际 ' + JSON.stringify(seat[0][0]) + '）')
  assert.equal(seat[0][1]['姓名'], '李四', '姓名字段应写成规范名（实际 ' + JSON.stringify(seat[0][1]) + '）')
})

// ---------------------------------------------------------------------------
// B02-03：改名时若有同名学生，前端必须能知道「关联表没跟着改」
// ---------------------------------------------------------------------------

test('dynamicTable 的 PUT：同名歧义跳过级联时，响应里必须带得出来的冲突信号', async () => {
  const conn = freshDb()
  active.conn = conn

  // 两个学生同名「张三」：改名其中一个时，级联必须跳过（否则会改到另一个人的数据）
  const ins = conn.prepare('INSERT INTO students (姓名, 学号) VALUES (?, ?)')
  ins.run('张三', 'A001')
  ins.run('张三', 'A002')

  const r = await callApi(
    [['/api/students', studentsRouter]],
    'PUT', '/api/students/1', { 姓名: '李四' }
  )
  assert.equal(r.status, 200, '改名本身应成功（实际 ' + r.status + '：' + r.text.slice(0, 200) + '）')

  // 前端要能据此提示用户「关联记录未同步」—— 后端必须把这个事实说出来
  const payload = r.json || {}
  const renamed = payload.renamed
  assert.ok(renamed, '响应里必须带 renamed 字段（实际 ' + r.text.slice(0, 200) + '）')
  assert.equal(
    renamed.skipped, 'duplicate-name',
    '同名歧义时必须给出 skipped=duplicate-name（实际 ' + JSON.stringify(renamed) + '）'
  )
  assert.equal(
    renamed.changed, false,
    '同名歧义时不得声称「关联记录已同步」（实际 ' + JSON.stringify(renamed) + '）'
  )
})

test('dynamicTable 的 PUT：改名无歧义时不得报 skipped（别误报）', async () => {
  const conn = freshDb()
  active.conn = conn
  const ins = conn.prepare('INSERT INTO students (姓名, 学号) VALUES (?, ?)')
  ins.run('张三', 'A001')
  ins.run('李四', 'A002')
  // 关联表里放一条旧名，让级联真的有东西可改
  conn.prepare("UPDATE seat_slots SET seats = ? WHERE kind = 'current'")
    .run(JSON.stringify([['张三']]))

  const r = await callApi(
    [['/api/students', studentsRouter]],
    'PUT', '/api/students/1', { 姓名: '王五' }
  )
  assert.equal(r.status, 200, '改名应成功（实际 ' + r.status + '：' + r.text.slice(0, 200) + '）')
  const renamed = (r.json || {}).renamed || {}
  assert.equal(
    renamed.skipped, undefined,
    '无歧义时不得报 skipped（实际 ' + JSON.stringify(renamed) + '）'
  )
  assert.equal(renamed.changed, true, '无歧义时应确实改了关联记录（实际 ' + JSON.stringify(renamed) + '）')
  assert.equal(renamed.counts && renamed.counts.seat, 1, '座位表应改了 1 处（实际 ' + JSON.stringify(renamed) + '）')
})
