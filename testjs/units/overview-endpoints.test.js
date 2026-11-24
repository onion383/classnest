// =========================================================================
// overview-endpoints.test.js —— 座位 / 值日首屏概览（v8 · P3-15）
//
// 事故面：座位页 mount 并发拉 /seats + /seats/master + /seats/weight + /students，
//         值日页再拉 settings/template/现行表/权重 + 名册 —— 单页 4~5 个请求，且名册整表搬运。
// 判据：
//   ① /seats/overview 的 active/master/weight 与三个单端点逐字段一致；
//   ② /duty/overview 的 settings/active/template/weight 与四个单端点逐字段一致；
//   ③ 概览名册只含 id/姓名/学号（不多搬电话/备注）；
//   ④ 两个前端首屏只发 1 个概览请求，且概览失败时回退到单端点（不白板）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')
const { analyze, findFunction, scriptBlocks, walk } = require('../_source-scan.cjs')

const fx = createBackendDb({ label: 'overview-endpoints' })

fx.conn.prepare('INSERT INTO students (学号, 年级, 班级, 姓名, 家长联系电话, 学生联系电话, 备注) VALUES (?,?,?,?,?,?,?)')
  .run('2026001', '八年级', '3 班', '张三', '13800138000', '13900139000', '仅内部可见')

test.before(async () => {
  await fx.mount('/api/seats', 'student-backend/routes/seats.js')
  await fx.mount('/api/duty', 'student-backend/routes/duty.js')
})
test.after(() => fx.close())

async function get(p) {
  const r = await fx.call('GET', p)
  assert.equal(r.status, 200, `${p} → ${r.text.slice(0, 300)}`)
  return r.json
}

test('座位概览：三项与单端点逐字段一致', async () => {
  const ov = await get('/api/seats/overview')
  assert.deepEqual(ov.active, await get('/api/seats'))
  assert.deepEqual(ov.master, await get('/api/seats/master'))
  assert.deepEqual(ov.weight, await get('/api/seats/weight'))
})

test('值日概览：四项与单端点逐字段一致（同一模式）', async () => {
  const ov = await get('/api/duty/overview?mode=daily')
  assert.deepEqual(ov.settings, await get('/api/duty/settings?mode=daily'))
  assert.deepEqual(ov.active, await get('/api/duty?mode=daily'))
  assert.deepEqual(ov.template, await get('/api/duty/template?mode=daily'))
  assert.deepEqual(ov.weight, await get('/api/duty/weight?mode=daily'))
  assert.equal(ov.mode, 'daily')
})

test('概览名册只含 id/姓名/学号', async () => {
  const seats = await get('/api/seats/overview')
  assert.equal(seats.students.length, 1)
  assert.equal(seats.students[0].姓名, '张三')
  assert.equal(seats.students[0].学号, '2026001')
  assert.deepEqual(Object.keys(seats.students[0]).sort(), ['id', '姓名', '学号'])
  const duty = await get('/api/duty/overview?mode=daily')
  assert.deepEqual(duty.students, seats.students)
})

/** onMounted(cb) 不是具名函数，直接按 CallExpression 取第一个实参（回调）范围。 */
function callArgRange(ast, calleeName) {
  let found = null
  walk(ast, (node) => {
    if (found) return
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
      && node.callee.name === calleeName && node.arguments[0]) {
      found = { start: node.arguments[0].start, end: node.arguments[0].end }
    }
  })
  return found
}

test('前端接线：首屏 1 个概览请求 + 失败回退单端点', () => {
  const seat = scriptBlocks(fs.readFileSync(
    path.join(ROOT, 'student-frontend/src/views/SeatView.vue'), 'utf8'))
  const seatOv = findFunction(analyze(seat).ast, 'loadSeatOverview')
  assert.ok(seatOv, '找不到 loadSeatOverview')
  const seatBody = seat.slice(seatOv.start, seatOv.end)
  assert.equal((seatBody.match(/axios\.get\(/g) || []).length, 1, '概览只允许 1 个请求')
  assert.match(seatBody, /\/seats\/overview/, '必须走 /seats/overview')
  const seatMount = callArgRange(analyze(seat).ast, 'onMounted')
  assert.ok(seatMount, '找不到 onMounted')
  const seatMountBody = seat.slice(seatMount.start, seatMount.end)
  assert.match(seatMountBody, /loadSeatOverview\(/, '首屏必须先走概览')
  assert.match(seatMountBody, /if \(!fromOverview\)/, '概览失败必须回退')

  const duty = scriptBlocks(fs.readFileSync(
    path.join(ROOT, 'student-frontend/src/views/DutyView.vue'), 'utf8'))
  const dutyOv = findFunction(analyze(duty).ast, 'loadDutyOverview')
  assert.ok(dutyOv, '找不到 loadDutyOverview')
  const dutyBody = duty.slice(dutyOv.start, dutyOv.end)
  assert.equal((dutyBody.match(/axios\.get\(/g) || []).length, 1, '概览只允许 1 个请求')
  assert.match(dutyBody, /\/duty\/overview/, '必须走 /duty/overview')
  const dutyMount = callArgRange(analyze(duty).ast, 'onMounted')
  assert.ok(dutyMount, '找不到 duty onMounted')
  const dutyMountBody = duty.slice(dutyMount.start, dutyMount.end)
  assert.match(dutyMountBody, /loadDutyOverview\(/, '首屏必须先走概览')
  assert.match(dutyMountBody, /if \(!fromOverview\)/, '概览失败必须回退')
})
