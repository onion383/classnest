// =========================================================================
// ai-score-seat-layout.test.js —— 4-9 / H4：AI 的 score_weights 座位指数
// 也必须按「当前布局」重映射历史坐标
//
// 界面座位指数（seatDailyAggregate）改成「历史坐标 → 逻辑座位 → 当前布局权重」后，
// AI 工具宣称同口径。若它还按 weights[r][c] 直接套历史坐标，布局插走廊后就会
// 把学生算到走廊格（null）上而丢分，两条路的指数对不上。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'ai-score-seat-layout', currentSlug: '@ssl' })

let runScoreWeights

test.before(() => {
  runScoreWeights = require(path.join(
    ROOT, 'student-backend/routes/ai/ai.tools/tools.executors/executors.checks.js',
  )).runScoreWeights
})

test.after(() => fx.close())

test.beforeEach(() => {
  fx.reset()
  // 当前布局：中间插了一条走廊列，权重只填两侧座位列
  fx.conn.prepare(`INSERT OR REPLACE INTO seat_slots (kind, mode, rows, cols, seats, types, weights)
    VALUES ('current', 'single', 1, 3, ?, ?, '[]')`)
    .run(JSON.stringify([[11, null, 12]]), JSON.stringify([[0, 1, 0]]))
  fx.conn.prepare(`INSERT OR REPLACE INTO seat_slots (kind, mode, rows, cols, types, weights)
    VALUES ('weight', 'single', 1, 3, ?, ?)`)
    .run(JSON.stringify([[0, 1, 0]]), JSON.stringify([[10, null, 20]]))
  // 历史快照：当时只有 2 个座位列（没有走廊），第 1、2 个座位分别是 11、12
  fx.conn.prepare(`INSERT INTO domain_history (domain, week_start, snap_date, mode, payload)
    VALUES ('seat', '2026-11-09', '2026-11-10', 'single', ?)`)
    .run(JSON.stringify({ mode: 'single', rows: 1, cols: 2, seats: [[11, 12]], types: [[0, 0]] }))
})

const scoreOf = (res, name) => {
  const all = [...(res.最差 || []), ...(res.最好 || [])]
  const hit = all.find((x) => x.姓名 === name)
  return hit ? hit.得分 : undefined
}

test('布局插走廊后，AI 座位指数按逻辑座位对位，不把第二个人算丢', () => {
  const r = runScoreWeights({ type: 'seat', from: '2026-11-01', to: '2026-11-30', top: 10 })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.seat.覆盖天数, 1)
  assert.equal(r.seat.人数, 2)
  // 名册为空 → 显示名是 #id；关键看分数：直接套网格下标会让 #12 落到走廊（null）而缺席
  assert.equal(scoreOf(r.seat, '#11'), 10)
  assert.equal(scoreOf(r.seat, '#12'), 20)
})

test('接线：历史查询要带 types/cols，执行器要按当前布局做逻辑座位映射', () => {
  const fs = require('node:fs')
  const storeSrc = fs.readFileSync(path.join(ROOT, 'student-backend/services/aiStore.js'), 'utf8')
  assert.match(storeSrc, /seats, types, cols/, 'readSeatHistory 必须取 types/cols 才能重映射')
  const execSrc = fs.readFileSync(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools.executors/executors.checks.js'), 'utf8')
  assert.match(execSrc, /seatAxisMaps/)
  assert.match(execSrc, /curColGrid\[colOrd\]/)
})
