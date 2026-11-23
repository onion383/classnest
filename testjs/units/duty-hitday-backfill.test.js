// =========================================================================
// duty-hitday-backfill.test.js —— 大扫除补存只写命中日（审查 v7 · #79）
//
// 两条补存路径各自漏了「命中日」判断：
//   ① POST /api/duty/history/week（手动补录整周）—— 完全不看周期/星期几，固定插 7 天；
//   ② POST /api/duty/snapshot/backfill（挂载时静默补存）—— 服务层虽有 isHitDate 过滤，
//      但写成 `!(isToday && includeToday) && !isHit(cur)`，includeToday 把今天的命中判断整个绕过了。
// 结果：历史列表里出现非大扫除日的空快照，按快照计数的值日指数偏高。
//
// 判据：真起后端跑 SQL，按「学期起始 + 周期/星期几」算出的命中日是否与实际落库的
// snap_date 完全一致（不是「看一眼代码里有没有 isHitDate」）。
// =========================================================================
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb } = require('./_db-express-fixture.cjs')
const ROOT = path.resolve(__dirname, '../..')

const fx = createBackendDb({ label: 'duty-hitday', extraDbExports: { renumber: () => {} } })
const dutyConfig = require(path.join(ROOT, 'student-backend/services/dutyConfig'))
const dutyWrite = require(path.join(ROOT, 'student-backend/services/dutyWrite'))
const { localDateStr, shiftDateStr } = require(path.join(ROOT, 'student-backend/utils/date'))

// 2026-03-02 是周一，作为学期起始 → 第 1 周 = 3/2~3/8，第 3 周 = 3/16~3/22
const SEMESTER_START = '2026-03-02'

test.before(() => fx.mount('/api/duty', 'student-backend/routes/duty.js'))
test.after(() => fx.close())

// 隔周大扫除 · 周三：命中第 1、3、5… 周的周三
function seed({ start = SEMESTER_START, cycle = 'biweek', weekday = '周三' } = {}) {
  const conn = fx.reset()
  if (start) {
    conn.prepare('INSERT INTO semesters (name, start_date, end_date, is_current) VALUES (?,?,?,1)')
      .run('学期', start, '2027-01-31')
  }
  dutyConfig.writeConfig('big', { cycle, weekday })
  return conn
}

const snaps = (mode) => fx.conn.prepare('SELECT snap_date FROM duty_history WHERE mode = ? ORDER BY snap_date').all(mode).map((r) => r.snap_date)

test('命中日判定单源：big 返回判定函数，daily 不过滤', () => {
  seed()
  const hit = dutyWrite.hitDayMatcher('big')
  assert.equal(typeof hit, 'function')
  assert.equal(hit('2026-03-04'), true, '第 1 周周三命中')
  assert.equal(hit('2026-03-11'), false, '第 2 周周三不命中（隔周）')
  assert.equal(hit('2026-03-18'), true, '第 3 周周三命中')
  assert.equal(hit('2026-03-05'), false, '周四永远不命中')
  assert.equal(dutyWrite.hitDayMatcher('daily'), null, '日常值日每天都有，不需要过滤')

  seed({ start: '' })
  assert.equal(dutyWrite.hitDayMatcher('big'), null,
    '学期开始日期没设时无法算「第几周」→ 不猜，保持逐日补的原行为')
})

test('手动补录整周（big）：只落命中日那一天', async () => {
  seed()
  const r = await fx.call('POST', '/history/week', { week_start: '2026-03-02', mode: 'big' })
  assert.ok(r.status < 400, r.text.slice(0, 200))
  assert.deepEqual(snaps('big'), ['2026-03-04'], '第 1 周只有周三命中，不能把 7 天全写上')
  assert.equal(r.json.inserted, 1)
})

test('手动补录整周（big）：非命中周一条都不写，且提示说清原因', async () => {
  seed()
  const r = await fx.call('POST', '/history/week', { week_start: '2026-03-09', mode: 'big' })
  assert.ok(r.status < 400, r.text.slice(0, 200))
  assert.deepEqual(snaps('big'), [], '第 2 周是隔周的空档，不该有快照')
  assert.equal(r.json.inserted, 0)
  assert.match(r.json.message, /没有大扫除日/, '别再说「该周记录已完整」—— 用户会以为已经存过')
})

test('手动补录整周（daily）：仍然补满 7 天', async () => {
  seed()
  const r = await fx.call('POST', '/history/week', { week_start: '2026-03-09', mode: 'daily' })
  assert.ok(r.status < 400, r.text.slice(0, 200))
  assert.equal(snaps('daily').length, 7, '日常值日每天都要有')
  assert.equal(r.json.inserted, 7)
})

test('自动补存（big, includeToday）：今天不是命中日就不能写今天的快照', async () => {
  // 今天（测试运行日）是周一，而命中日设成周三 → 今天必然不命中
  seed({ start: shiftDateStr(localDateStr(new Date()), -30), cycle: 'week', weekday: '周三' })
  const today = localDateStr(new Date())
  const r = await fx.call('POST', '/snapshot/backfill', { mode: 'big', includeToday: true })
  assert.ok(r.status < 400, r.text.slice(0, 200))
  assert.equal(snaps('big').includes(today), false,
    'includeToday 只表示「今天用当前值日表覆盖」，不是「今天无条件写」')
})

test('自动补存（big, includeToday）：今天确实是命中日时要覆盖为当前值日表', async () => {
  const today = localDateStr(new Date())
  // 把命中星期设成「今天」所在的那一天，周期一周 → 今天必命中
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const weekday = names[new Date().getDay()]
  seed({ start: shiftDateStr(today, -30), cycle: 'week', weekday })

  const r = await fx.call('POST', '/snapshot/backfill', { mode: 'big', includeToday: true })
  assert.ok(r.status < 400, r.text.slice(0, 200))
  assert.equal(snaps('big').includes(today), true, '命中日的今天必须有快照（别把功能修死）')
})

test('自动补存（daily, includeToday）：照旧每天都补，今天也在内', async () => {
  seed({ start: shiftDateStr(localDateStr(new Date()), -3), cycle: 'week', weekday: '周三' })
  const today = localDateStr(new Date())
  const r = await fx.call('POST', '/snapshot/backfill', { mode: 'daily', includeToday: true })
  assert.ok(r.status < 400, r.text.slice(0, 200))
  const list = snaps('daily')
  assert.equal(list.length, 4, '从三天前到今天共 4 天')
  assert.equal(list.includes(today), true)
})

test('接线：两条路径共用 dutyWrite.hitDayMatcher（不许各写一份命中日判断）', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/duty.js'), 'utf8')
  const start = src.indexOf("router.post('/history/week'")
  assert.ok(start > 0, '找不到 /history/week')
  const seg = src.slice(start, src.indexOf('module.exports', start))
  assert.match(seg, /dutyWrite\.hitDayMatcher\(mode\)/, '手动补录必须用共用的命中日判定')
  assert.match(seg, /if \(isHit && !isHit\(date\)\)/, '命中日不成立要跳过该天')
})
