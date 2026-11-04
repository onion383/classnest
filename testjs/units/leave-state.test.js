// =========================================================================
// leave-state.test.js —— 「今天在不在校」的请假口径
//
// 回归 B06-05：首页右上角「请假 3」和下面的「今日请假」卡片对不上。
// 因为两处各自写筛选条件：数字数的是「所有状态=请假中」（不看日期），
// 卡片筛的是「状态请假中 且 开始时间=今天」。跨天假（8/31–9/02）只进数字、
// 不进卡片 —— 同一屏两个数字互相矛盾。
//
// 归一后唯一口径：状态=请假中 且 开始时间 <= 今天 <= 结束时间（首尾都算）。
// 运行：npm run test:units
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../..')
const loadLeaveState = () => import(pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/leaveState.js')).href)

const leave = (o) => ({ 状态: '请假中', ...o })

test('跨天假：今天落在开始与结束之间都算在假', async () => {
  const { isOnLeaveOn } = await loadLeaveState()
  const l = leave({ 开始时间: '2026-08-31', 结束时间: '2026-09-02' })
  assert.equal(isOnLeaveOn(l, '2026-08-31'), true, '开始当天算')
  assert.equal(isOnLeaveOn(l, '2026-09-01'), true, '中间那天算')
  assert.equal(isOnLeaveOn(l, '2026-09-02'), true, '结束当天也算（首尾都算）')
  assert.equal(isOnLeaveOn(l, '2026-09-03'), false, '结束次日不算')
  assert.equal(isOnLeaveOn(l, '2026-08-30'), false, '开始前一天不算')
})

test('提前登记的假（还没开始）不算今天不在校', async () => {
  const { isOnLeaveOn } = await loadLeaveState()
  const l = leave({ 开始时间: '2026-12-01', 结束时间: '2026-12-03' })
  assert.equal(isOnLeaveOn(l, '2026-11-04'), false,
    '把未来的假算进「今天请假」，会让在校人数凭空减少')
})

test('结束时间已过但状态还挂着「请假中」→ 不算今天（提醒用户销假，而不是算他不在校）', async () => {
  const { isOnLeaveOn } = await loadLeaveState()
  const l = leave({ 开始时间: '2026-08-01', 结束时间: '2026-08-03' })
  assert.equal(isOnLeaveOn(l, '2026-11-04'), false)
})

test('状态不是「请假中」一律不算（已返校 / 已取消）', async () => {
  const { isOnLeaveOn } = await loadLeaveState()
  assert.equal(isOnLeaveOn(leave({ 状态: '已返校', 开始时间: '2026-11-01', 结束时间: '2026-11-30' }), '2026-11-04'), false)
  assert.equal(isOnLeaveOn(leave({ 状态: '已取消', 开始时间: '2026-11-01', 结束时间: '2026-11-30' }), '2026-11-04'), false)
})

test('结束时间为空按「请到销假为止」处理；开始时间为空不计入', async () => {
  const { isOnLeaveOn } = await loadLeaveState()
  assert.equal(isOnLeaveOn(leave({ 开始时间: '2026-11-01', 结束时间: '' }), '2026-11-04'), true)
  assert.equal(isOnLeaveOn(leave({ 开始时间: '2026-11-01' }), '2026-11-04'), true)
  assert.equal(isOnLeaveOn(leave({ 开始时间: '', 结束时间: '2026-11-30' }), '2026-11-04'), false)
})

test('日期串带时间 / 传 Date 都要按「本地日期」比', async () => {
  const { isOnLeaveOn } = await loadLeaveState()
  // 接口可能回来带时间的串
  assert.equal(isOnLeaveOn(leave({ 开始时间: '2026-11-04 08:30:00', 结束时间: '2026-11-04 17:00:00' }), '2026-11-04'), true)
  // 桌面挂件传的是 Date：本地 00:30 不能被算成 UTC 的「昨天」
  assert.equal(isOnLeaveOn(leave({ 开始时间: '2026-11-04', 结束时间: '2026-11-04' }), new Date(2026, 10, 4, 0, 30)), true)
  // 缺省日期 = 今天（本地口径）：造一条覆盖今天的假
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const todayStr = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
  assert.equal(isOnLeaveOn(leave({ 开始时间: todayStr, 结束时间: todayStr })), true)
})

test('脏数据不炸：null / 非对象 / 缺字段', async () => {
  const { isOnLeaveOn, leavesOn } = await loadLeaveState()
  assert.equal(isOnLeaveOn(null, '2026-11-04'), false)
  assert.equal(isOnLeaveOn(undefined, '2026-11-04'), false)
  assert.equal(isOnLeaveOn({}, '2026-11-04'), false)
  assert.deepEqual(leavesOn(null, '2026-11-04'), [])
  assert.deepEqual(leavesOn(undefined), [])
  assert.deepEqual(leavesOn('not-an-array'), [])
})

test('leavesOn：跨天假只算一次，姓名不重复计入', async () => {
  const { leavesOn } = await loadLeaveState()
  const list = [
    leave({ 姓名: '张三', 开始时间: '2026-08-31', 结束时间: '2026-09-02' }),
    leave({ 姓名: '李四', 开始时间: '2026-09-02', 结束时间: '2026-09-02' }),
    leave({ 姓名: '王五', 开始时间: '2026-09-05', 结束时间: '2026-09-06' }),
    leave({ 姓名: '赵六', 状态: '已返校', 开始时间: '2026-09-01', 结束时间: '2026-09-03' }),
  ]
  const today = leavesOn(list, '2026-09-02')
  assert.deepEqual(today.map((l) => l.姓名), ['张三', '李四'])
})

test('首页与桌面挂件都走 leavesOn，不再各自写「状态===请假中」（静态守卫）', () => {
  const strip = (src) => src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))

  for (const rel of [
    'student-frontend/src/views/DashboardView.vue',
    'student-frontend/src/subwindows/desktop-widget/DesktopWidget.vue',
  ]) {
    const code = strip(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
    assert.ok(!/状态\s*===\s*'请假中'/.test(code),
      `${rel} 又自己筛「请假中」了 —— 改走 utils/leaveState.js 的 leavesOn，否则两个数字迟早又对不上`)
  }
})
