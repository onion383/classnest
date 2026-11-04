// 后端日期工具的回归测试（student-backend/utils/date.js）
//
// 为什么单独一支：
//   这些函数此前在 routes/duty.js、routes/seats.js 各有一份逐字重复的私有副本，
//   routes/ai/ai.dataRoutes.js 还有第三份 mondayOf —— 三份拷贝、零测试。
//   「同一语义散在多处」的代价是：改一处不改另一处 = 改坏，而且没人能发现自己漏了。
//   收敛到 utils/date 之后，这里锁住三件事：
//     1. 语义（本地时区口径、周一归属、跨月跨年偏移）；
//     2. 入参 Date 不被就地改写（调用方后面还要用同一个 Date）；
//     3. 不许有人再在路由里复制一份（静态扫描，去注释后匹配）。
//
// 时区无关性：所有 Date 都由「本地分量」构造（new Date(y, m, d, h, mi)），
// 断言也用本地分量比，因此在任何 TZ 下都成立，不依赖跑测试的机器在东八区。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const {
  pad2, localDateStr, localDateTimeStr, todayStr, parseDateStr, shiftDateStr, mondayOf,
} = require(path.join(ROOT, 'student-backend/utils/date.js'))

// 去注释，避免「注释里提到旧写法」被当成违规命中（老坑：forbid 匹配到自己的修复注释）
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

test('pad2 补零', () => {
  assert.equal(pad2(0), '00')
  assert.equal(pad2(7), '07')
  assert.equal(pad2(12), '12')
})

test('localDateStr 用本地日期，不是 UTC 日期', () => {
  // 本地 00:30 —— UTC 口径会给出「昨天」，本地口径必须是当天
  assert.equal(localDateStr(new Date(2026, 0, 1, 0, 30)), '2026-01-01')
  // 本地 23:30 —— UTC 可能已经是「明天」，本地口径仍是当天
  assert.equal(localDateStr(new Date(2026, 11, 31, 23, 30)), '2026-12-31')
  // 月末 / 闰日
  assert.equal(localDateStr(new Date(2024, 1, 29, 12, 0)), '2024-02-29')
  assert.equal(localDateStr(new Date(2026, 1, 28, 12, 0)), '2026-02-28')
})

test('localDateStr 非法输入返回空串而不是 NaN 串', () => {
  assert.equal(localDateStr(new Date('not a date')), '')
  assert.equal(localDateStr('not a date'), '')
})

test('localDateTimeStr 是本地时间的 YYYY-MM-DD HH:mm:ss', () => {
  assert.equal(localDateTimeStr(new Date(2026, 0, 5, 0, 0, 3)), '2026-01-05 00:00:03')
  assert.equal(localDateTimeStr(new Date(2026, 0, 5, 7, 8, 9)), '2026-01-05 07:08:09')
  assert.equal(localDateTimeStr(new Date(2026, 0, 5, 23, 59, 59)), '2026-01-05 23:59:59')
  // 与 localDateStr 的日期部分必须一致（同一时刻不能一个说今天一个说昨天）
  const d = new Date(2026, 0, 5, 0, 30, 0)
  assert.equal(localDateTimeStr(d).slice(0, 10), localDateStr(d))
  assert.equal(localDateTimeStr(new Date('x')), '')
})

test('todayStr 等于此刻的本地日期', () => {
  const now = new Date()
  assert.equal(todayStr(), `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`)
})

test('parseDateStr 得到本地零点', () => {
  const d = parseDateStr('2026-03-09')
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 2)
  assert.equal(d.getDate(), 9)
  assert.equal(d.getHours(), 0)
})

test('shiftDateStr 跨月、跨年、负数与闰日', () => {
  assert.equal(shiftDateStr('2026-01-31', 1), '2026-02-01')
  assert.equal(shiftDateStr('2026-12-31', 1), '2027-01-01')
  assert.equal(shiftDateStr('2026-01-01', -1), '2025-12-31')
  assert.equal(shiftDateStr('2024-02-28', 1), '2024-02-29')
  assert.equal(shiftDateStr('2026-02-28', 1), '2026-03-01')
  assert.equal(shiftDateStr('2026-03-09', 0), '2026-03-09')
  assert.equal(shiftDateStr('2026-03-09', 7), '2026-03-16')
})

test('mondayOf 七个星期几都归到同一个周一（周日在同一周的周一，不是下周一）', () => {
  // 2026-03-09 是周一
  const monday = '2026-03-09'
  for (let i = 0; i < 7; i++) {
    assert.equal(mondayOf(shiftDateStr(monday, i)), monday, `周一起第 ${i} 天`)
  }
  // 跨月的周：2026-03-30(一) ~ 2026-04-05(日)
  for (let i = 0; i < 7; i++) {
    assert.equal(mondayOf(shiftDateStr('2026-03-30', i)), '2026-03-30', `跨月第 ${i} 天`)
  }
  // 跨年的周：2025-12-29(一) ~ 2026-01-04(日)
  assert.equal(mondayOf('2026-01-01'), '2025-12-29')
})

test('mondayOf 接受 Date 且不就地改写调用方的 Date', () => {
  // ai.dataRoutes 的 snapshotBeforeWrite 里 today 既用来取周一，也用来取快照日期；
  // 就地 setDate 会把「今天」改成「本周一」，快照日期整体提前。
  const today = new Date(2026, 2, 12, 18, 30) // 周四
  const before = today.getTime()
  assert.equal(mondayOf(today), '2026-03-09')
  assert.equal(today.getTime(), before, 'mondayOf 改掉了调用方的 Date')
  // Date 入参与字符串入参必须同结果
  assert.equal(mondayOf(today), mondayOf('2026-03-12'))
})

test('路由层不再各自复制日期函数（静态守卫）', () => {
  const files = [
    'student-backend/routes/duty.js',
    'student-backend/routes/seats.js',
    'student-backend/routes/ai/ai.dataRoutes.js',
  ]
  const priv = /function\s+(localDateStr|localDateTimeStr|parseDateStr|shiftDateStr|mondayOf)\s*\(/
  for (const rel of files) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
    assert.ok(!priv.test(code), `${rel} 又复制了一份日期函数，应改成 require('../utils/date')`)
  }
})

test('草稿保存时间不再用 UTC 口径的 toISOString', () => {
  for (const rel of ['student-backend/routes/duty.js', 'student-backend/routes/seats.js']) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
    assert.ok(!/savedAt\s*=\s*new Date\(\)\.toISOString\(\)/.test(code),
      `${rel} 的 savedAt 又退回 UTC 口径（东八区 00:00–08:00 会写进昨天）`)
    assert.ok(/savedAt\s*=\s*localDateTimeStr\(\)/.test(code),
      `${rel} 的 savedAt 应走 utils/date 的 localDateTimeStr()`)
  }
})
