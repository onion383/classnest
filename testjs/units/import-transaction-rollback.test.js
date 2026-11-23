// =========================================================================
// import-transaction-rollback.test.js —— 导入失败不留孤儿临时学生（2-1 / #14 / 独立 M3）
//
// 原缺陷：Excel 导入在 rows.map 阶段用 tryResolve(create:true) 即时 INSERT 临时学生，
// 但校验 throw 也在 map 里、insertMany 在 map 之后。若只有后者在事务里，
// 则第 1 行建了临时学生、第 2 行校验失败整批 400 → 临时学生残留、无 created、无法撤销。
// 班干部导入（cadres.js）早已把认人建档纳入事务，这里是「一处修了、兄弟没修」。
//
// 判据：
//   ① 行为：首行建临时学生 + 末行校验失败 → 400 且临时学生回滚（leaves + scores 两条路）；
//   ② 成功路径：整批合法时临时学生正常落库（防「为了回滚把建档也废掉」）；
//   ③ 接线：两条路由的 rows.map 都在 db.transaction 内；
//   ④ 变异反证：把事务去掉后，接线判据必须失败。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const { createBackendDb } = require('./_db-express-fixture.cjs')

// 一个 fixture 挂两条路由（db stub 是进程级，多个 createBackendDb 会互相覆盖）。
// 每个用例 reset() 换干净库，避免用例间数据串。
const fx = createBackendDb({ label: 'import-rollback' })
let conn
let postLeaves
let postScores

test.before(async () => {
  await fx.mount('/api/leaves', 'student-backend/routes/leaves.js')
  await fx.mount('/api/scores', 'student-backend/routes/scores.js')
  postLeaves = (body) => fx.call('POST', '/api/leaves/import', body)
  postScores = (body) => fx.call('POST', '/api/scores/import', body)
})
test.after(() => fx.close())
test.beforeEach(() => { conn = fx.reset() })

const tmpCount = (name) => conn.prepare('SELECT COUNT(*) AS n FROM students WHERE 姓名 = ?').get(name).n
const rowCount = (table) => conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n

// ————————————————————————— 请假导入 —————————————————————————

test('请假导入：首行建临时学生 + 末行缺日期 → 400 且临时学生回滚', async () => {
  const r = await postLeaves({
    fields: ['姓名', '开始时间', '结束时间'],
    // 第一行合法且是名册外姓名 → 会建临时学生；第二行缺结束时间 → throw
    rows: [['导入临时甲', '2026-11-10', '2026-11-12'], ['导入临时乙', '2026-11-10', '']],
  })
  assert.equal(r.status, 400, r.text)
  assert.equal(tmpCount('导入临时甲'), 0, '整批失败后临时学生必须回滚，否则残留孤儿且无法撤销')
  assert.equal(tmpCount('导入临时乙'), 0)
  assert.equal(rowCount('leave_records'), 0, '业务行也不该落')
})

test('请假导入：整批合法时临时学生正常落库（回滚不能误伤建档）', async () => {
  const r = await postLeaves({
    fields: ['姓名', '开始时间', '结束时间'],
    rows: [['导入正常丙', '2026-11-10', '2026-11-12']],
  })
  assert.equal(r.status, 200, r.text)
  assert.equal(tmpCount('导入正常丙'), 1)
  assert.ok(Array.isArray(r.json.created) && r.json.created.length === 1, 'success 仍要回 created 供撤销')
})

// ————————————————————————— 成绩导入 —————————————————————————

test('成绩导入：首行建临时学生 + 末行缺姓名 → 400 且临时学生回滚', async () => {
  const r = await postScores({ fields: ['姓名', '分值'], mode: 'personal', rows: [['成绩临时甲', '5'], ['', '3']] })
  assert.equal(r.status, 400, r.text)
  assert.equal(tmpCount('成绩临时甲'), 0, '整批失败后临时学生必须回滚')
  assert.equal(rowCount('score_records'), 0)
})

test('成绩导入：整批合法时临时学生正常落库', async () => {
  const r = await postScores({ fields: ['姓名', '分值'], mode: 'personal', rows: [['成绩正常乙', '5']] })
  assert.equal(r.status, 200, r.text)
  assert.equal(tmpCount('成绩正常乙'), 1)
  assert.ok(Array.isArray(r.json.created) && r.json.created.length === 1)
})

// ————————————————————————— 接线 + 变异反证 —————————————————————————

function importHandler(rel) {
  const src = read(rel)
  const parts = src.split(/(?=router\.(?:get|post|put|patch|delete)\s*\()/)
  const h = parts.find((p) => p.startsWith("router.post('/import'"))
  assert.ok(h, `未找到 ${rel} 的 import handler`)
  return h
}

test('接线：leaves/scores 的 rows.map 认人建档都在 db.transaction 内', () => {
  for (const rel of ['student-backend/routes/leaves.js', 'student-backend/routes/scores.js']) {
    const h = importHandler(rel)
    const runIdx = h.indexOf('const run = db.transaction')
    const mapIdx = h.indexOf('rows.map(')
    assert.ok(runIdx >= 0, `${rel} 缺少事务包裹`)
    assert.ok(mapIdx > runIdx, `${rel} 的 rows.map 必须在事务内`)
  }
})

test('变异反证：去掉事务包裹后，接线判据必须失败', () => {
  const h = importHandler('student-backend/routes/leaves.js')
  const mutated = h.replace(/const run = db\.transaction\(\(\) => \{/, 'const run = (() => {')
  assert.ok(mutated !== h, '变异没匹配到事务起点')
  assert.equal(mutated.indexOf('const run = db.transaction'), -1, '变异后接线判据应判失败')
})
