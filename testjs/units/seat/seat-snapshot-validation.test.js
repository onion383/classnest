// =========================================================================
// seat-snapshot-validation.test.js —— 座位快照写接口必须与座位写入口同口径（4-10）
//
// 原缺陷：POST /api/seats/snapshot 只校验日期，rows/cols/seats/types 原样进 payload：
//   · rows/cols 不校验范围 → 越界几何写进历史；
//   · seats 不规范化、不裁剪到 rows×cols → 比声明更宽的矩阵原样落库；
//   · types 只要「是数组」就收 → 尺寸不符的格型矩阵也收，座位指数逐日累加时错位。
// 快照与当前布局不同：写进历史后没有「再存一次」的机会，脏数据会一直参与结算。
//
// 判据：
//   ① 行为：越界几何、非数组 seats、尺寸不符的 types、非法单元格都 400，且不落库；
//   ② 归一：合法载荷按 rows×cols 裁剪/补齐后落库（与 PUT / 同一套规范化）；
//   ③ 接线：/snapshot 复用 validateSeatSize / normalizeSeats / parseTypesForWrite；
//   ④ 变异反证：去掉形状校验后，行为判据必须失败。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const { extractFunctionDecl } = require('#testjs/units/_mechanism.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

// X2-02：快照写入下沉到服务层，接线判据跟着改测服务而非路由
const SRC = 'student-backend/services/seatSnapshot.js'

const fx = createBackendDb({ label: 'seat-snapshot' })
const seatSnapshot = require('../../../student-backend/services/seatSnapshot')
let conn

test.after(() => fx.close())
test.beforeEach(() => { conn = fx.reset() })

const payloadOf = (date) => {
  const row = conn.prepare("SELECT payload FROM domain_history WHERE domain = 'seat' AND snap_date = ?").get(date)
  return row ? JSON.parse(row.payload) : null
}
const countOf = (date) => conn.prepare("SELECT COUNT(*) AS n FROM domain_history WHERE domain = 'seat' AND snap_date = ?").get(date).n

const BASE = { rows: 2, cols: 2, seats: [[1, null], [null, 2]], types: [[0, 1], [0, 0]] }

// ————————————————————————— ① 畸形载荷 —————————————————————————

test('行列为越界/非整数 → 400 且不落库', async () => {
  for (const bad of [{ rows: 0 }, { cols: 0 }, { rows: 999 }, { rows: '2' }, { cols: 2.5 }]) {
    const r = seatSnapshot.saveManualSnapshot({ snap_date: '2026-11-10', ...BASE, ...bad })
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应被拒：${r.error}`)
  }
  assert.equal(countOf('2026-11-10'), 0, '被拒的快照不能落库')
})

test('seats 不是数组 → 400', async () => {
  const r = seatSnapshot.saveManualSnapshot({
    snap_date: '2026-11-10', rows: 2, cols: 2, seats: { 0: [1] },
  })
  assert.equal(r.ok, false, r.error)
  assert.equal(countOf('2026-11-10'), 0)
})

test('types 尺寸与 rows/cols 不符 → 400（格型矩阵错位会让指数结算串位）', async () => {
  const r = seatSnapshot.saveManualSnapshot({
    snap_date: '2026-11-10', ...BASE, types: [[0, 1], [0, 0], [0, 0]],
  })
  assert.equal(r.ok, false, r.error)
  assert.equal(countOf('2026-11-10'), 0, '尺寸不符的 types 不能落库')
})

test('types 元素不是 0/1/2 → 400', async () => {
  const r = seatSnapshot.saveManualSnapshot({
    snap_date: '2026-11-10', ...BASE, types: [[0, 9], [0, 0]],
  })
  assert.equal(r.ok, false, r.error)
})

test('seats 单元格是非法值（对象/超长姓名）→ 400', async () => {
  const r = seatSnapshot.saveManualSnapshot({
    snap_date: '2026-11-10', rows: 1, cols: 1, seats: [[{ a: 1 }]], types: [[0]],
  })
  assert.equal(r.ok, false, `非法单元格应被 normalizeSeats 拒：${r.error}`)
})

// ————————————————————————— ② 合法载荷归一 —————————————————————————

test('合法载荷：按 rows×cols 裁剪后落库，types 一并保存', async () => {
  const r = seatSnapshot.saveManualSnapshot({
    snap_date: '2026-11-10',
    rows: 2,
    cols: 2,
    // 故意多传一列/一行：应被裁掉，而不是原样进历史
    seats: [[1, null, 99], [null, 2, 99], [99, 99, 99]],
    types: [[0, 1], [0, 0]],
  })
  assert.equal(r.ok, true, r.error)
  const p = payloadOf('2026-11-10')
  assert.deepEqual(p.seats, [[1, null], [null, 2]], '必须裁到 rows×cols')
  assert.deepEqual(p.types, [[0, 1], [0, 0]], 'types 原样保存')
  assert.equal(p.rows, 2)
})

test('不传 types（老调用方）仍按空数组保存，不因此报错', async () => {
  const r = seatSnapshot.saveManualSnapshot({
    snap_date: '2026-11-11', rows: 1, cols: 1, seats: [[1]],
  })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(payloadOf('2026-11-11').types, [])
})

// ————————————————————————— ③ 接线 —————————————————————————

// 判据抽成函数，正例与变异反证共用（T07-02）：变异源码要回喂同一入口，
// 不能只在本地副本上断言「正则消失」—— 那样判据接错文件也照样绿。
const REQUIRED_CALLS = [/validateSeatSize\(/, /normalizeSeats\(/, /parseTypesForWrite\(/, /fitSeatsToGrid\(/]
function wiringGuard(h) {
  const missing = REQUIRED_CALLS.filter((re) => !re.test(h))
  return { ok: missing.length === 0, missing: missing.map((r) => r.source) }
}

test('接线：saveManualSnapshot 复用座位写入口的三件套校验', () => {
  const src = fs.readFileSync(abs(SRC), 'utf8')
  const h = extractFunctionDecl(src, 'saveManualSnapshot')
  const r = wiringGuard(h)
  assert.ok(r.ok, `saveManualSnapshot 缺少校验调用：${r.missing.join(', ')}`)
})

// ————————————————————————— ④ 变异反证 —————————————————————————

test('变异反证：去掉形状校验后，行为判据必须失败', () => {
  const src = fs.readFileSync(abs(SRC), 'utf8')
  const h = extractFunctionDecl(src, 'saveManualSnapshot')
  assert.equal(wiringGuard(h).ok, true, '基线必须通过，否则反证无意义')
  const mutated = h.replace(/validateSeatSize\(rows, cols\)/, 'null').replace(/parseTypesForWrite\(types, rows, cols\)/, '{ skip: true }')
  assert.ok(mutated !== h, '变异没匹配到校验调用')
  assert.equal(wiringGuard(mutated).ok, false, '判据假绿：去掉尺寸校验后仍判 PASS')
})
