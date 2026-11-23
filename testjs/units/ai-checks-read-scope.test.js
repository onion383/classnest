// =========================================================================
// ai-checks-read-scope.test.js —— 1-6 遗留：体检 / 冲突 / 指数工具的表级读闸门
//
// 原缺陷：run_checks / run_conflict_checks / score_weights 不传 table（一次遍历
// 多张表），dispatchTool 的统一闸门 `(a) => [a.table]` 挡不住 —— 老师把「学生名单」
// 设成「完全禁止」后，这些工具仍把含姓名的脏数据回给外部模型。
// 修法：执行器内部按「规则 → 依赖表」逐条过滤；点名要跑的规则全被关掉时明确报错，
// 部分被关时跳过并在 note 里说明，绝不返回「体检通过」的假绿。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'ai-checks-scope', currentSlug: '@checks' })

let aiConfigStore
let readScopeMod
let exec

test.before(() => {
  aiConfigStore = require(path.join(ROOT, 'student-backend/services/aiConfigStore'))
  readScopeMod = require(path.join(ROOT, 'student-backend/services/aiReadScope'))
  exec = require(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools.executors/executors.checks.js'))
  aiConfigStore.setPrivacy({ enabled: true, closed_tables: [], readonly_tables: [] })
})

test.after(() => fx.close())

function setClosed(tables) {
  aiConfigStore.setPrivacy({ closed_tables: tables })
}

test.beforeEach(() => setClosed([]))

// ————————————————————————— ① 行为层：关闭依赖表后拒绝执行 —————————————————————————

test('学生名单被关：run_checks 不返回体检结果，明确报「已关闭」', () => {
  setClosed(['students'])
  const r = exec.runChecks({ checks: ['sno_duplicate'] })
  assert.equal(r.ok, false, '关掉学生名单后仍返回结果 = 姓名被读走')
  assert.match(r.error, /设置中关闭/)
})

test('倒计时被关：run_conflict_checks 拒绝已过期的冲突检查', () => {
  setClosed(['countdowns'])
  const r = exec.runConflictChecks({ checks: ['countdown_passed'] })
  assert.equal(r.ok, false)
  assert.match(r.error, /设置中关闭/)
})

test('座位权重被关：score_weights 的座位指数拒绝计算', () => {
  setClosed(['seat_weight'])
  const r = exec.runScoreWeights({ type: 'seat' })
  assert.equal(r.ok, false)
  assert.match(r.error, /设置中关闭/)
})

// ————————————————————————— ② 部分关闭：只跳过对应规则 —————————————————————————

test('只关班费：体检跳过班费规则，其余规则照跑并如实列出 skipped', () => {
  setClosed(['fee_records'])
  const r = exec.runChecks({ checks: ['fee_negative', 'sno_duplicate'] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.checked, ['sno_duplicate'], '可读的规则仍要执行')
  assert.deepEqual(r.skipped.map((s) => s.type), ['fee_negative'])
  assert.match(r.note, /1 项检查因依赖的表已在设置中关闭而未执行/)
})

test('只关座位权重：score_weights 仍算值日指数，并说明座位指数被跳过', () => {
  setClosed(['seat_weight'])
  const r = exec.runScoreWeights({ type: 'both' })
  assert.equal(r.ok, true)
  assert.equal(r.seat, undefined, '座位权重被关后不得再计算座位指数')
  assert.ok(r.duty, '值日指数不依赖座位权重，应照常计算')
  assert.match(r.note, /座位指数/)
})

test('全部关闭：默认体检不假装通过，明确说明未执行', () => {
  const { READ_TABLES } = require(path.join(ROOT, 'student-backend/routes/ai/ai.constants'))
  setClosed(Object.keys(READ_TABLES))
  const r = exec.runChecks()
  assert.equal(r.ok, true)
  assert.deepEqual(r.checked, [])
  assert.equal(r.total, 0)
  assert.match(r.note, /所有检查项依赖的表都已在设置中关闭/)
})

// ————————————————————————— ③ 变异反证 —————————————————————————

test('变异反证：绕过读作用域后，被关的表仍会被读（证明上面的用例确实由闸门拦住）', () => {
  setClosed(['students'])
  const orig = readScopeMod.readScope.isTableReadable
  readScopeMod.readScope.isTableReadable = () => true
  try {
    const r = exec.runChecks({ checks: ['sno_duplicate'] })
    assert.notEqual(r.ok, false, '闸门被绕过时用例必须变红')
  } finally {
    readScopeMod.readScope.isTableReadable = orig
  }
})

// ————————————————————————— ④ 接线钉子 —————————————————————————

test('接线：规则自带依赖表，闸门直接消费声明（未声明即拒绝）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/ai/ai.tools/tools.executors/executors.checks.js'), 'utf8')
  const rules = [
    'cadre_dangling', 'group_dangling', 'score_dangling', 'leave_dangling', 'seat_dangling',
    'duty_dangling', 'leave_reversed', 'fee_negative', 'sno_duplicate',
    'seat_duplicate', 'duty_duplicate', 'countdown_passed', 'schedule_conflict',
  ]
  for (const name of rules) {
    assert.match(src, new RegExp(`${name}: \\{\\s*tables:`), `${name} 未声明依赖表`)
  }
  assert.match(src, /splitReadable\(want, CHECK_RULES\)/)
  assert.match(src, /splitReadable\(want, CONFLICT_RULES\)/)
  assert.match(src, /if \(!Array\.isArray\(tables\)\)/, '未声明依赖表必须 fail-closed')
  assert.match(src, /AI_CHECK_RULE_TABLES/, '规则依赖表必须来自 tableRegistry')
  assert.match(src, /AI_SCORE_TABLES/, 'score_weights 依赖表必须来自 tableRegistry')
  assert.match(src, /const \{ readScope \} = require\('\.\.\/\.\.\/\.\.\/\.\.\/services\/aiReadScope'\)/)
})
