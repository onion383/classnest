// =========================================================================
// schedule-cells-validation.test.js —— 课表接口拒绝畸形 cells（4-1 / #60）
//
// 原缺陷：PUT /api/schedule 与 PUT /api/schedule/master 只做 `Array.isArray(cells)`。
// 校验规则（schedule / master_schedule 的 cells：json+array+each:'slot'）早在
// services/sanitize.js:277 声明了，但两个写入口从不调用 → [1,2,3] 这种
// 「是数组、元素是数字」的载荷照单全收，前端按 .course 取值渲染出错，还会被
// 历史快照与 AI 读接口一路带下去。
//
// 判据：
//   ① 行为：两个写入口收到 [1,2,3] 都返 400，且库内旧值不被覆盖；
//   ② 回归：合法课表（空值/文本/对象混排）照常 200 且落库，非数组仍 400；
//   ③ 接线：两个 PUT 都经过 cleanScheduleCells 并把异常转 400，不漏任何一个；
//   ④ 变异反证：把 cleanScheduleCells 调用抹掉后，接线判据必须失败。
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')

const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const SRC = 'student-backend/routes/schedule.js'

// 一个夹具挂两条读写路径：实行课表 / 与一般课表 /master
const fx = createBackendDb({ label: 'schedule-cells' })
let conn

test.before(async () => {
  await fx.mount('/api/schedule', SRC)
})
test.after(() => fx.close())
test.beforeEach(() => { conn = fx.reset() })

const slotCells = (kind) => {
  const row = conn.prepare("SELECT cells FROM schedule_slots WHERE kind = ?").get(kind)
  return row ? JSON.parse(row.cells) : null
}

// 合法课表：行 → 日；元素可以是对象、文本、空值（存量数据三种都有）
const LEGAL = [
  [{ course: '语文', teacher: '张' }, '', null],
  ['数学', { course: '英语' }, null],
]

// ————————————————————————— ① 行为：畸形载荷被拒 —————————————————————————

test('实行课表：cells 元素是数字 → 400，且库内旧值不被覆盖', async () => {
  const ok = await fx.call('PUT', '/api/schedule', { cells: LEGAL })
  assert.equal(ok.status, 200, ok.text)
  assert.deepEqual(slotCells('current'), LEGAL, '合法写入必须先真落库，否则后面的「未被覆盖」是假通过')

  const r = await fx.call('PUT', '/api/schedule', { cells: [1, 2, 3] })
  assert.equal(r.status, 400, `[1,2,3] 必须被拒（收到 ${r.status}）：${r.text}`)
  assert.deepEqual(slotCells('current'), LEGAL, '被拒的载荷不能覆盖已保存的课表')
})

test('一般课表：cells 元素是布尔 → 400，且库内旧值不被覆盖', async () => {
  const ok = await fx.call('PUT', '/api/schedule/master', { cells: LEGAL })
  assert.equal(ok.status, 200, ok.text)
  assert.deepEqual(slotCells('master'), LEGAL, '合法写入必须先真落库')

  const r = await fx.call('PUT', '/api/schedule/master', { cells: [[true, false]] })
  assert.equal(r.status, 400, `布尔元素必须被拒（收到 ${r.status}）：${r.text}`)
  assert.deepEqual(slotCells('master'), LEGAL, '被拒的载荷不能覆盖一般课表')
})

// ————————————————————————— ② 回归：合法与非法边界 —————————————————————————

test('合法课表原样落库（校验不能顺手改写单元格内容）', async () => {
  const r = await fx.call('PUT', '/api/schedule', { cells: LEGAL })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(slotCells('current'), LEGAL, '对象/文本/空值混排必须原样保存')
})

test('cells 不是数组：既有的 400 不能因为换校验而丢失', async () => {
  const r = await fx.call('PUT', '/api/schedule', { cells: '不是数组' })
  assert.equal(r.status, 400, r.text)
  const r2 = await fx.call('PUT', '/api/schedule', { cells: { 0: { course: '语文' } } })
  assert.equal(r2.status, 400, r2.text)
})

test('不传 cells：仍按空课表保存（原 cells || [] 的语义）', async () => {
  const r = await fx.call('PUT', '/api/schedule', { settings: { a: 1 } })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(slotCells('current'), [], '不传 cells 时落空数组，不能变成 null/对象')
})

// ————————————————————————— ③ 接线 —————————————————————————

function putHandler(routePath) {
  const src = read(SRC)
  const parts = src.split(/(?=router\.(?:get|post|put|patch|delete)\s*\()/)
  const h = parts.find((p) => p.startsWith(`router.put('${routePath}'`))
  assert.ok(h, `未找到 PUT ${routePath} handler`)
  return h
}

test('两个课表写入口都直接调 sanitizeField 校验 cells 并把异常转 400', () => {
  for (const [routePath, table] of [['/', 'schedule'], ['/master', 'master_schedule']]) {
    const h = putHandler(routePath)
    // 必须直接调用（覆盖矩阵 write.sanitize_gate 按 handler 体内的 sanitizeField(...'cells') 判定）
    assert.match(h, new RegExp(`sanitizeField\\(rawCells \\|\\| \\[\\], '${table}', 'cells'\\)`),
      `PUT ${routePath} 必须用 ${table} 的列规则直接校验 cells`)
    assert.match(h, /catch\s*\(err\)\s*\{[\s\S]*res\.status\(400\)/, `PUT ${routePath} 必须把校验异常转 400`)
    assert.doesNotMatch(h, /!Array\.isArray\(cells\)/, `PUT ${routePath} 的旧「只判数组」分支应已被替换`)
  }
})

// ————————————————————————— ④ 变异反证 —————————————————————————

test('变异反证：抹掉 sanitizeField 调用后，接线判据必须失败', () => {
  const src = read(SRC)
  const mutated = src.replace(/sanitizeField\(rawCells \|\| \[\], '(?:schedule|master_schedule)', 'cells'\)/g, 'rawCells')
  assert.ok(mutated !== src, '变异没匹配到校验调用，判据已失效')
  assert.equal((mutated.match(/sanitizeField\(rawCells/g) || []).length, 0,
    '变异后应无校验调用，接线判据须判失败（同时 [1,2,3] 会重新变成 200）')
})
