// =========================================================================
// seat-cell-write.test.js —— 座位单格写入（PATCH /cell、PATCH /master/cell）
//
// 背景：单格 PATCH 曾是唯一「不经过 validateRow」的座位写入口，能绕过三类不变量：
//   洞里/走廊里塞人、写入不存在的学生 id、一人占两座 —— 而且全部静默（界面不显示他）。
// 修法是把单格写入收敛到 services/seatWrite.js 一个入口，判据与整表 PUT 同源。
//
// 三块判据（缺一块就假绿）：
//   ① 真实写入口：三类不变量逐条被拒，且**被拒时库里一格都没动**（不能写一半）
//   ② 自愈路径：清空永远放行（否则用户没法把错放在空位里的人移走）
//   ③ 接线：两个 PATCH 路由都走同一入口、旧旁路已删、可坐性判据不在路由里重复实现
//
// 手法与 seat-hole-paint.test.js 一致：真内存库 + 真 schema + 真 Express router + 真 HTTP。
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'seat-cell' })

test.before(() => fx.mount('/api/seats', 'student-backend/routes/seats.js'))
test.after(() => fx.close())

function freshDb() {
  return fx.reset()
}
function seedStudents(n) {
  const stmt = fx.conn.prepare(
    "INSERT INTO students (position, 学号, 年级, 班级, 姓名, 年龄, 家长联系电话, 备注) VALUES (?,?,?,?,?,?,?,?)"
  )
  for (let i = 1; i <= n; i++) stmt.run(i, String(i).padStart(3, '0'), '初二', '3班', `学生${i}`, 14, '1', '')
}

// 2 行 × 3 列：第 0 行第 0 列是空位(2)，第 1 列整列是走廊(1)，其余是座位(0)
const ROWS = 2
const COLS = 3
const TYPES = [[2, 1, 0], [0, 1, 0]]
const SEATS = [[null, null, null], [null, null, null]]

async function bootstrap(kind = 'current', students = 3) {
  freshDb()
  seedStudents(students)
  const url = kind === 'current' ? '/api/seats' : '/api/seats/master'
  const put = await fx.call('PUT', url, { mode: 'single', rows: ROWS, cols: COLS, seats: SEATS, types: TYPES })
  assert.equal(put.status, 200, put.text.slice(0, 200))
}
function stored(kind = 'current') {
  const row = fx.conn.prepare('SELECT rows, cols, seats, types FROM seat_slots WHERE kind = ?').get(kind)
  return { rows: row.rows, cols: row.cols, seats: JSON.parse(row.seats), types: JSON.parse(row.types) }
}

// ---------------------------------------------------------------------------
// ① 三类不变量：逐条被拒，且被拒后库里一格都没动
// ---------------------------------------------------------------------------
test('往「空位」格塞学生会拒（400），且库里保持 null', async () => {
  await bootstrap()
  const r = await fx.call('PATCH', '/api/seats/cell', { row: 0, col: 0, value: 1 })
  assert.equal(r.status, 400, r.text.slice(0, 200))
  assert.match(r.json.error, /空位/)
  assert.equal(stored().seats[0][0], null, '被拒后不能写进库（写一半比不写更糟）')
})

test('往「走廊」列塞学生会拒（400），且库里保持 null', async () => {
  await bootstrap()
  for (const row of [0, 1]) {
    const r = await fx.call('PATCH', '/api/seats/cell', { row, col: 1, value: 1 })
    assert.equal(r.status, 400, r.text.slice(0, 200))
    assert.match(r.json.error, /走廊/)
  }
  assert.equal(stored().seats[0][1], null)
  assert.equal(stored().seats[1][1], null)
})

test('写入不存在的学生 id 会拒（400）——「幽灵人」不进库', async () => {
  await bootstrap()
  const r = await fx.call('PATCH', '/api/seats/cell', { row: 0, col: 2, value: 999 })
  assert.equal(r.status, 400, r.text.slice(0, 200))
  assert.match(r.json.error, /不存在的学生/)
  assert.equal(stored().seats[0][2], null)
})

test('一人两座会拒（400），且原座位不受影响', async () => {
  await bootstrap()
  const first = await fx.call('PATCH', '/api/seats/cell', { row: 1, col: 2, value: 1 })
  assert.equal(first.status, 200, first.text.slice(0, 200))
  const dup = await fx.call('PATCH', '/api/seats/cell', { row: 0, col: 2, value: 1 })
  assert.equal(dup.status, 400, dup.text.slice(0, 200))
  assert.match(dup.json.error, /只能占一个座位/)
  const s = stored()
  assert.equal(s.seats[1][2], 1, '原座位必须还在')
  assert.equal(s.seats[0][2], null, '新座位不能写进去')
})

test('越界坐标会拒（400）——「看不见的行」不进库', async () => {
  await bootstrap()
  const r = await fx.call('PATCH', '/api/seats/cell', { row: ROWS, col: 0, value: 1 })
  assert.equal(r.status, 400, r.text.slice(0, 200))
  assert.match(r.json.error, /超出当前座位表范围/)
  assert.equal(stored().seats.length, ROWS, 'seats 不能被撑出第 3 行')
})

test('值形状仍按 PUT 的强度校验：对象 / 超长文本都拒', async () => {
  await bootstrap()
  const obj = await fx.call('PATCH', '/api/seats/cell', { row: 0, col: 2, value: { id: 1 } })
  assert.equal(obj.status, 400, obj.text.slice(0, 200))
  const long = await fx.call('PATCH', '/api/seats/cell', { row: 0, col: 2, value: 'x'.repeat(40) })
  assert.equal(long.status, 400, long.text.slice(0, 200))
  assert.equal(stored().seats[0][2], null)
})

// ---------------------------------------------------------------------------
// ② 自愈路径：清空永远放行
// ---------------------------------------------------------------------------
test('清空空格子永远放行（自愈：先把错放的人移走，再改布局）', async () => {
  await bootstrap()
  // 直接往库里塞一个「洞里有人」的历史脏数据（模拟老版本写坏的库）
  fx.conn.prepare("UPDATE seat_slots SET seats = ? WHERE kind = 'current'")
    .run(JSON.stringify([[9, null, null], [null, null, null]]))
  const r = await fx.call('PATCH', '/api/seats/cell', { row: 0, col: 0, value: null })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  assert.equal(stored().seats[0][0], null)
})

test('历史脏数据（洞里有人）不影响写别处的格子 —— 按增量判，不做全表重校', async () => {
  await bootstrap()
  fx.conn.prepare("UPDATE seat_slots SET seats = ? WHERE kind = 'current'")
    .run(JSON.stringify([[9, null, null], [null, null, null]]))
  const r = await fx.call('PATCH', '/api/seats/cell', { row: 1, col: 2, value: 2 })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  assert.equal(stored().seats[1][2], 2)
})

// ---------------------------------------------------------------------------
// ④ 整表 PUT 与单格 PATCH 必须同一条规则（不能「单格严、整表松」）
// ---------------------------------------------------------------------------
test('整表 PUT 也拒「走廊格里有人」（不再只有单格路径拦）', async () => {
  freshDb()
  seedStudents(3)
  const before = fx.conn.prepare("SELECT seats FROM seat_slots WHERE kind = 'current'").get().seats
  const r = await fx.call('PUT', '/api/seats', {
    mode: 'single', rows: ROWS, cols: COLS,
    seats: [[null, 1, null], [null, null, null]],
    types: TYPES,
  })
  // 业务校验失败 = 400（与单格 PATCH 同口径）：校验层抛 ValidationError（带 status），
  // 路由不再把它一律包成 500 —— 「填错了」不该报成「服务器错误」。
  assert.equal(r.status, 400, r.text.slice(0, 160))
  assert.match(r.json.error, /走廊/, '文案要说清是走廊，不是笼统的「参数错误」')
  const after = fx.conn.prepare("SELECT seats FROM seat_slots WHERE kind = 'current'").get().seats
  assert.equal(after, before, '被拒时整表不落库（库里那份原样不动）')
})

test('整表 PUT 拒「空位格里有人」，文案与旧行为一致（被设为空位…还有学生）', async () => {
  freshDb()
  seedStudents(3)
  const r = await fx.call('PUT', '/api/seats', {
    mode: 'single', rows: ROWS, cols: COLS,
    seats: [[2, null, null], [null, null, null]],
    types: TYPES,
  })
  assert.equal(r.status, 400, r.text.slice(0, 160))
  assert.match(r.json.error, /被设为空位，但格子里还有学生/)
})

test('一致性：同一个走廊格，单格与整表两个入口都拒（规则只有一份）', async () => {
  await bootstrap()
  const byCell = await fx.call('PATCH', '/api/seats/cell', { row: 1, col: 1, value: 2 })
  const byTable = await fx.call('PUT', '/api/seats', {
    mode: 'single', rows: ROWS, cols: COLS,
    seats: [[null, null, null], [null, 2, null]],
    types: TYPES,
  })
  for (const [tag, res] of [['单格', byCell], ['整表', byTable]]) {
    assert.equal(res.status, 400, `${tag}应拒绝：${res.text.slice(0, 160)}`)
    assert.match(res.json.error, /走廊/, `${tag}的报错必须指向走廊`)
  }
})

// ---------------------------------------------------------------------------
// ③ 正常写入 + 不影响几何 + 模板表同受管 + 接线判据
// ---------------------------------------------------------------------------
test('正常入座写进库，且只改 seats（rows/cols/types 一格不动）', async () => {
  await bootstrap()
  const r = await fx.call('PATCH', '/api/seats/cell', { row: 0, col: 2, value: 3 })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  const s = stored()
  assert.equal(s.seats[0][2], 3)
  assert.equal(s.rows, ROWS)
  assert.equal(s.cols, COLS)
  assert.deepEqual(s.types, TYPES, '单格写入不该碰 types（否则走廊/空位会和座位错位）')
})

test('座位模板走同一套判据（模板也要守「洞里不坐人」）', async () => {
  await bootstrap('template')
  const hole = await fx.call('PATCH', '/api/seats/master/cell', { row: 0, col: 0, value: 1 })
  assert.equal(hole.status, 400, hole.text.slice(0, 200))
  assert.match(hole.json.error, /空位/)
  const ok = await fx.call('PATCH', '/api/seats/master/cell', { row: 1, col: 2, value: 1 })
  assert.equal(ok.status, 200, ok.text.slice(0, 200))
  assert.equal(stored('template').seats[1][2], 1)
})

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
// 判据只针对**代码**：注释里会解释「旧的 updateSingleCell 是旁路」，直接搜字符串会误红
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

test('接线：两个 PATCH 都走 writeSeatCell 单一入口，旧旁路已删除', () => {
  const src = read('student-backend/routes/seats.js')
  const code = codeOnly(src)
  assert.match(src, /router\.patch\('\/cell', cellPatchHandler\('seat_layout'\)\)/, 'PATCH /cell 必须走统一 handler')
  assert.match(src, /router\.patch\('\/master\/cell', cellPatchHandler\('seat_template'\)\)/, 'PATCH /master/cell 必须走统一 handler')
  assert.ok(!/updateSingleCell/.test(code), '旧的旁路写入函数必须删掉，不能留着等下次被调用')
  assert.ok(!/validateCellValue/.test(code), '值校验已下沉到 seatWrite，路由里不该再有第二份')
  // 可坐性判据只能有一处：路由文件里不该出现空格/走廊的判断常量
  assert.ok(!/SEAT_CELL\.(HOLE|AISLE)/.test(code), '路由里不许再写一遍「洞里不能坐人」')
})

test('接线：seatWrite 真的调用了校验层（不是自己重写一套）', () => {
  const src = read('student-backend/services/seatWrite.js')
  assert.match(src, /assertSeatCellWritable/, '必须复用校验层的可坐性判据')
  assert.match(src, /assertSeatCell\(/, '值形状复用 sanitize 的元素级校验')
  assert.match(src, /store\.setDoc/, '写库仍走 store（不要自己拼 SQL）')
})

// M12-B6：座位路由的语句已收进 slotStore（读）/ seatWrite（写），不留裸 SQL。
test('SQL 出口：seats 路由不留裸 SQL，槽位统一走 slotStore', () => {
  const code = codeOnly(read('student-backend/routes/seats.js'))
  assert.ok(!/db\.prepare\(/.test(code), 'seats 路由不许再有裸 SQL（读走 store.getDoc，写走 seatWrite）')
  assert.match(code, /store\.getDoc\('seat_layout'\)/, '当前座位必须经 store.getDoc 读取')
})
