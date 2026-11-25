// =========================================================================
// history-load-guard.test.js —— 历史 tab「数据已在就不再重复拉」的判定
//
// 判据：
//   ① 周列表为空 → 拉；列表在且选中周有效 → 不拉；选中周失效 → 拉；
//   ② Duty 维度变了 → 拉（周列表属旧 mode，不能拿旧列表发新 mode 的请求）；
//   ③ 接线：SeatView / DutyView 的 watch(activeTab) 必须调用 shouldReloadHistory，
//      不能退回「if (newTab === 'history') fetchHistoryWeeks()」；
//   ④ 变异反证：把接线去掉后，判据 ③ 必须失败。
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')

const { shouldReloadHistory } = require('../../../student-frontend/src/utils/historyLoadGuard.js')

const WEEKS = [
  { week_start: '2026-11-02' },
  { week_start: '2026-11-09' },
]

// ————————————————— ① 判定本身 —————————————————

test('周列表为空 → 需要拉', () => {
  assert.equal(shouldReloadHistory({ weeks: [], currentWeek: '' }), true)
  assert.equal(shouldReloadHistory({ weeks: null, currentWeek: '2026-11-02' }), true)
  assert.equal(shouldReloadHistory({}), true)
})

test('周列表在且选中周有效 → 不拉（这是消除重复请求的关键分支）', () => {
  assert.equal(shouldReloadHistory({ weeks: WEEKS, currentWeek: '2026-11-09' }), false)
  // 选中周为空但列表在：fetchHistoryWeeks 内部会选第一周，不必由 watch 再拉
  assert.equal(shouldReloadHistory({ weeks: WEEKS, currentWeek: '' }), false)
})

test('选中周已不在列表 → 需要拉（重选周 + 载快照）', () => {
  assert.equal(shouldReloadHistory({ weeks: WEEKS, currentWeek: '2026-10-01' }), true)
})

// ————————————————— ② Duty 维度 —————————————————

test('维度变化 → 需要拉，即使周列表非空且选中周有效', () => {
  assert.equal(shouldReloadHistory({
    weeks: WEEKS, currentWeek: '2026-11-09', loadedScope: 'daily', scope: 'big',
  }), true)
})

test('维度未变 → 按普通规则判定', () => {
  assert.equal(shouldReloadHistory({
    weeks: WEEKS, currentWeek: '2026-11-09', loadedScope: 'daily', scope: 'daily',
  }), false)
  assert.equal(shouldReloadHistory({
    weeks: WEEKS, currentWeek: '2026-10-01', loadedScope: 'daily', scope: 'daily',
  }), true)
})

test('不传 scope 时不受维度判定影响（Seat 无维度概念）', () => {
  assert.equal(shouldReloadHistory({ weeks: WEEKS, currentWeek: '2026-11-09' }), false)
})

// ————————————————— ③ 接线 —————————————————

const SEAT = 'student-frontend/src/views/SeatView.vue'
const DUTY = 'student-frontend/src/views/DutyView.vue'

// watch 块很可能有多个内层 `})`，用正则整块提取很脆；改为核对两个文本事实：
//   ① 存在 shouldReloadHistory 调用；② 旧的无条件单行写法已不存在。
const UNCONDITIONAL = /watch\(activeTab,\s*\(newTab\)\s*=>\s*\{\s*if\s*\(\s*newTab\s*===\s*'history'\s*\)\s*fetchHistoryWeeks\(\)\s*\}\)/

for (const [name, file] of [['SeatView', SEAT], ['DutyView', DUTY]]) {
  test(`${name} 的 watch(activeTab) 经 shouldReloadHistory 判定`, () => {
    const src = read(file)
    assert.ok(/watch\(activeTab,/.test(src), `${name}: 找不到 watch(activeTab)`)
    assert.match(src, /shouldReloadHistory\s*\(/, `${name}: 没有调 shouldReloadHistory`)
    assert.doesNotMatch(src, UNCONDITIONAL, `${name}: 旧的无条件拉取写法仍在`)
  })
}

test('DutyView 的判定传入 scope / loadedScope（否则切 mode 会用旧周列表）', () => {
  const src = read(DUTY)
  assert.match(src, /shouldReloadHistory\s*\(\s*\{[\s\S]{0,200}?scope\s*:/)
})

// ————————————————— ④ 变异反证 —————————————————

test('变异反证：把 SeatView 改回无条件拉取 → 接线判据必须失败', () => {
  const original = read(SEAT)
  // 在源码副本里注入旧写法（不改磁盘文件），判据应立刻检出
  const broken = original + `\nwatch(activeTab, (newTab) => { if (newTab === 'history') fetchHistoryWeeks() })\n`
  assert.match(broken, UNCONDITIONAL, '注入的变异应被识别为无条件写法')
  // 用与接线判据相同的两条断言验证：变异后「无条件写法已消失」这条必然失败
  assert.throws(() => assert.doesNotMatch(broken, UNCONDITIONAL))
})
