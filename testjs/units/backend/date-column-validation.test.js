// =========================================================================
// date-column-validation.test.js —— 日期列拒绝非法日期（4-2 / #61）
//
// 原缺陷：score_records.加分时间 / activities.时间 / leave_records.返校时间 三个日期列
// 没有在 services/sanitize.js 的 COLUMN_RULES 里声明 {kind:'date'}，于是退化成
// 「按 table_meta 类型宽松归一」（normDate）：解析不出来就原样保留 → '2026-13-45'、
// 'abc' 都能落库，导出/排序/时间轴状态判断时才炸。
//
// 判据：
//   ① 行为：三个列的非法值都返 400，且库内旧值不变；
//   ② 不误伤：默认值 now()（带时分）、'2026年11月5日'/'2026/11/5' 等写法照常接受并归一；
//   ③ 接线：三张表在 COLUMN_RULES 里都声明了 date 规则（防止规则被删掉后只剩行为巧合）；
//   ④ 变异反证：把三条规则去掉后，接线判据必须失败。
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')

const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')
const { COLUMN_RULES } = require('../../../student-backend/services/sanitize')

const fx = createBackendDb({ label: 'date-columns' })
let conn

test.before(async () => {
  await fx.mount('/api/activities', 'student-backend/routes/activities.js')
  await fx.mount('/api/scores', 'student-backend/routes/scores.js')
  await fx.mount('/api/leaves', 'student-backend/routes/leaves.js')
})
test.after(() => fx.close())
test.beforeEach(() => { conn = fx.reset() })

const one = (sql, ...args) => conn.prepare(sql).get(...args)

// ————————————————————————— ① 活动时间 —————————————————————————

test('活动：时间 2026-13-45 → 400，且不落库', async () => {
  const r = await fx.call('POST', '/api/activities', { 时间: '2026-13-45', 主题: '非法日期' })
  assert.equal(r.status, 400, `非法日期必须被拒（收到 ${r.status}）：${r.text}`)
  assert.equal(one('SELECT COUNT(*) AS n FROM activities').n, 0, '被拒的记录不能落库')
})

test('活动：编辑成 abc → 400，旧值不变', async () => {
  const ok = await fx.call('POST', '/api/activities', { 时间: '2026-11-05', 主题: '合法活动' })
  assert.equal(ok.status, 200, ok.text)
  const id = ok.json.id

  const r = await fx.call('PUT', `/api/activities/${id}`, { 时间: 'abc' })
  assert.equal(r.status, 400, `非日期文本必须被拒（收到 ${r.status}）：${r.text}`)
  assert.equal(one('SELECT 时间 FROM activities WHERE id = ?', id).时间, '2026-11-05', '旧值必须保持不变')
})

test('活动：合法写法照常接受并归一（不误伤导入/手输）', async () => {
  const a = await fx.call('POST', '/api/activities', { 时间: '2026年11月5日', 主题: '中文日期' })
  assert.equal(a.status, 200, a.text)
  const b = await fx.call('POST', '/api/activities', { 时间: '2026/11/6', 主题: '斜杠日期' })
  assert.equal(b.status, 200, b.text)
  const times = conn.prepare('SELECT 时间 FROM activities ORDER BY id').all().map((r) => r.时间)
  assert.deepEqual(times, ['2026-11-05', '2026-11-06'], '能解析的写法应归一成 YYYY-MM-DD')
})

test('活动：导入里的中文日期同样被接受（收紧不能把整批导入挡死）', async () => {
  const r = await fx.call('POST', '/api/activities/import', {
    fields: ['时间', '主题'],
    rows: [['2026年11月5日', '导入活动']],
  })
  assert.equal(r.status, 200, r.text)
  assert.equal(one('SELECT 时间 FROM activities').时间, '2026-11-05')
})

// ————————————————————————— ② 加分时间 —————————————————————————

test('加分记录：编辑成 2026-02-30 → 400，旧值不变', async () => {
  const ok = await fx.call('POST', '/api/scores', { 姓名: '日期测试生', 分值: 2, 项目: '纪律', 加分时间: '2026-11-05' })
  assert.equal(ok.status, 200, ok.text)
  const id = ok.json.id
  assert.equal(one('SELECT 加分时间 FROM score_records WHERE id = ?', id).加分时间, '2026-11-05')

  const r = await fx.call('PUT', `/api/scores/${id}`, { 加分时间: '2026-02-30' })
  assert.equal(r.status, 400, `不存在的日期必须被拒（收到 ${r.status}）：${r.text}`)
  assert.equal(one('SELECT 加分时间 FROM score_records WHERE id = ?', id).加分时间, '2026-11-05')
})

test('加分记录：不传时间时用 now()（带时分），严格规则不能把默认值拒掉', async () => {
  const r = await fx.call('POST', '/api/scores', { 姓名: '默认时间生', 分值: 1, 项目: '卫生' })
  assert.equal(r.status, 200, r.text)
  const t = one("SELECT 加分时间 FROM score_records WHERE 姓名 = '默认时间生'").加分时间
  assert.match(t, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, `默认值应保留时分，实际：${t}`)
})

// ————————————————————————— ③ 返校时间 —————————————————————————

test('请假：返校时间 2026-13-45 → 400，且旧值不变', async () => {
  const ok = await fx.call('POST', '/api/leaves', {
    姓名: '请假日期生', 类型: '病假', 开始时间: '2026-11-01', 结束时间: '2026-11-03',
  })
  assert.equal(ok.status, 200, ok.text)
  const id = ok.json.id
  const before = one('SELECT 返校时间 FROM leave_records WHERE id = ?', id).返校时间

  const r = await fx.call('PUT', `/api/leaves/${id}`, { 返校时间: '2026-13-45' })
  assert.equal(r.status, 400, `非法日期必须被拒（收到 ${r.status}）：${r.text}`)
  assert.equal(one('SELECT 返校时间 FROM leave_records WHERE id = ?', id).返校时间, before, '旧值必须保持不变')
})

test('请假：销假写入的 now() 时间能通过严格校验', async () => {
  const ok = await fx.call('POST', '/api/leaves', {
    姓名: '销假生', 类型: '事假', 开始时间: '2026-11-01', 结束时间: '2026-11-03',
  })
  assert.equal(ok.status, 200, ok.text)
  const r = await fx.call('POST', `/api/leaves/${ok.json.id}/return`)
  assert.equal(r.status, 200, r.text)
  assert.match(one('SELECT 返校时间 FROM leave_records WHERE id = ?', ok.json.id).返校时间, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

// ————————————————————————— ④ 接线 + 变异反证 —————————————————————————

test('接线：三张表的日期列在 COLUMN_RULES 里都有 date 规则', () => {
  const expect = [['activities', '时间'], ['score_records', '加分时间'], ['leave_records', '返校时间']]
  for (const [table, col] of expect) {
    assert.equal(COLUMN_RULES[table] && COLUMN_RULES[table][col] && COLUMN_RULES[table][col].kind, 'date',
      `${table}.${col} 必须显式声明 date 规则，否则退化成宽松归一，非法日期原样落库`)
  }
})

test('变异反证：抹掉三条 date 规则后，接线判据必须失败', () => {
  const src = read('student-backend/services/sanitize.js')
  const mutated = src
    .replace(/\n\s*返校时间: \{ kind: 'date' \},/, '')
    .replace(/\n\s*加分时间: \{ kind: 'date' \},/, '')
    .replace(/\n\s*时间: \{ kind: 'date' \},/, '')
  assert.ok(mutated !== src, '变异没匹配到规则声明')
  // 逐条断言（必须锚行首：'时间: { kind:... }' 是「开始时间: ...」的子串，includes 会误判）
  for (const decl of ['返校时间', '加分时间', '时间']) {
    assert.doesNotMatch(mutated, new RegExp(`^\\s*${decl}: \\{ kind: 'date' \\},`, 'm'),
      `变异后仍存在「${decl}」的 date 规则，接线判据须判失败`)
  }
})
