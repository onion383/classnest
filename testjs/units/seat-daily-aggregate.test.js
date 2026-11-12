// =========================================================================
// seat-daily-aggregate.test.js —— 座位账本 / 座位指数单遍结算（v6 性能专题 · 1-9）
//
// 验收点：
//   ① 等价性：同一批快照下，单遍合并结果与改造前两份独立遍历逐学生一致；
//   ② 上限独立：并集多拉的天数不会串口径 —— 账本不含今日，指数不含所选周之后；
//   ③ 并集取值：'' = 不设上限，不能被某一天收窄；
//   ④ 接线：SeatView 只保留一处 `/seats/daily`，两个消费方共用同一次拉取。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const MODULE = pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/seatDailyAggregate.js')).href
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------- 改造前的两份遍历（原样复刻，作为对照基准） ----------
// loadSeatLedger：服务端已按 to=昨日 过滤过区间
function oldLedger(days, weights) {
  const led = {}
  for (const day of days) {
    const seats = day.seats || []
    for (let r = 0; r < seats.length; r++) {
      const wRow = weights[r]
      if (!Array.isArray(wRow)) continue
      const sRow = seats[r] || []
      for (let c = 0; c < sRow.length; c++) {
        const val = sRow[c]
        if (typeof val !== 'number') continue
        const w = wRow[c]
        if (typeof w !== 'number') continue
        led[val] = (led[val] || 0) + w
      }
    }
  }
  return led
}

// seatIndexRows：服务端按 to=所选周代表日 过滤（无 to 时返回全部）
function oldIndex(days, weights, studentName) {
  const acc = {}
  for (const day of days) {
    const seats = day.seats || []
    for (let r = 0; r < seats.length; r++) {
      const wRow = weights[r]
      const sRow = seats[r]
      if (!Array.isArray(wRow) || !Array.isArray(sRow)) continue
      for (let c = 0; c < sRow.length; c++) {
        const val = sRow[c]
        if (val === null || val === undefined || val === '') continue
        const w = wRow[c]
        if (typeof w !== 'number') continue
        const name = typeof val === 'number' ? studentName(val) : val
        if (!name) continue
        acc[name] = (acc[name] || 0) + w
      }
    }
  }
  return acc
}

// 确定性伪随机：保证失败可复现
function lcg(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function makeFixture(seed) {
  const rnd = lcg(seed)
  const ROWS = 4
  const COLS = 5
  const students = { 1: '张三', 2: '李四', 3: '王五', 4: '赵六', 5: '钱七' }
  const weights = []
  for (let r = 0; r < ROWS; r++) {
    const row = []
    for (let c = 0; c < COLS; c++) {
      const x = rnd()
      row.push(x < 0.15 ? null : Math.round(x * 100) / 100)
    }
    weights.push(row)
  }
  const days = []
  for (let d = 1; d <= 12; d++) {
    const seats = []
    for (let r = 0; r < ROWS; r++) {
      const row = []
      for (let c = 0; c < COLS; c++) {
        const x = rnd()
        if (x < 0.1) row.push(null)
        else if (x < 0.85) row.push(1 + Math.floor(rnd() * 5))
        else row.push('临时生')
      }
      // 偶尔缺一行，模拟老快照几何不全
      seats.push(rnd() < 0.1 ? undefined : row)
    }
    days.push({ snap_date: `2026-10-${String(d).padStart(2, '0')}`, seats })
  }
  return { days, weights, students, studentName: (id) => students[id] || '' }
}

const filterTo = (days, to) => (to ? days.filter((d) => d.snap_date <= to) : days)

test('单遍合并与改造前两份遍历逐学生一致（随机 5 组）', async () => {
  const { aggregateSeatDaily } = await import(MODULE)
  for (const seed of [1, 7, 42, 2024, 99991]) {
    const f = makeFixture(seed)
    const indexTo = '2026-10-09'
    const ledgerTo = '2026-10-10'

    const got = aggregateSeatDaily({
      days: f.days, // 并集：服务端一次返回全部（比两个 to 都宽）
      weights: f.weights,
      ledgerTo,
      indexTo,
      studentName: f.studentName,
    })

    assert.deepEqual(got.ledger, oldLedger(filterTo(f.days, ledgerTo), f.weights), `seed ${seed} 账本不一致`)
    assert.deepEqual(got.acc, oldIndex(filterTo(f.days, indexTo), f.weights, f.studentName), `seed ${seed} 指数不一致`)
  }
})

test('上限独立：并集多拉的「今日」与「所选周之后」不会串到对端口径', async () => {
  const { aggregateSeatDaily } = await import(MODULE)
  const weights = [[1, 2]]
  const days = [
    { snap_date: '2026-11-09', seats: [[1, 2]] },
    { snap_date: '2026-11-10', seats: [[2, 1]] },
    { snap_date: '2026-11-11', seats: [[1, 1]] }, // 昨日
    { snap_date: '2026-11-12', seats: [[2, 2]] }, // 今日：账本不能算
  ]
  const got = aggregateSeatDaily({
    days,
    weights,
    ledgerTo: '2026-11-11',
    indexTo: '2026-11-09',
    studentName: (id) => ({ 1: '张三', 2: '李四' }[id] || ''),
  })

  // 账本：截至昨日，不含今日 → 1: 1+2+3=6（11-11 两格都是 1），2: 2+1=3
  assert.deepEqual(got.ledger, { 1: 6, 2: 3 })
  // 指数：只到所选周代表日 → 1: 1，2: 2
  assert.deepEqual(got.acc, { 张三: 1, 李四: 2 })
})

test('indexTo 为空 = 不设上限（该周无快照的旧口径），账本仍截到昨日', async () => {
  const { aggregateSeatDaily } = await import(MODULE)
  const weights = [[1]]
  const days = [
    { snap_date: '2026-11-11', seats: [[1]] },
    { snap_date: '2026-11-12', seats: [[2]] },
  ]
  const got = aggregateSeatDaily({
    days,
    weights,
    ledgerTo: '2026-11-11',
    indexTo: '',
    studentName: (id) => ({ 1: '张三', 2: '李四' }[id] || ''),
  })
  assert.deepEqual(got.ledger, { 1: 1 }, '账本不含今日')
  assert.deepEqual(got.acc, { 张三: 1, 李四: 1 }, '指数包含全部天数')
})

test('unionCutoff：取较大日期，任一为空则不设上限', async () => {
  const { unionCutoff } = await import(MODULE)
  assert.equal(unionCutoff('2026-11-08', '2026-11-11'), '2026-11-11')
  assert.equal(unionCutoff('2026-11-11', '2026-11-08'), '2026-11-11')
  assert.equal(unionCutoff('', '2026-11-11'), '', '指数无上限时不能被昨日收窄')
  assert.equal(unionCutoff('2026-11-11', ''), '', '同理')
})

test('接线：/seats/daily 只保留一处，账本与指数共用', () => {
  const view = read('student-frontend/src/views/SeatView.vue')
  const hits = view.match(/axios\.get\(`\$\{API_BASE\}\/seats\/daily`/g) || []
  assert.equal(hits.length, 1, `SeatView 里 /seats/daily 请求应只有 1 处，实际 ${hits.length}`)
  assert.match(view, /function loadSeatIndex\(\) \{\s*await loadSeatDaily\(\)/)
  assert.match(view, /function loadSeatLedger\(\) \{\s*await loadSeatDaily\(\)/)
  assert.match(view, /seatDailyKey === to/, '命中同一并集区间时不应重复发请求')
  assert.match(view, /seatDailyInflightKey === to/, '同一区间在途时必须复用同一个请求')
  assert.doesNotMatch(view, /seatIndexDaily/, '旧的「再扫一遍」数据源必须移除')
  assert.match(view, /const seatLedger = computed/, '账本改为单遍结果的派生值')
})
