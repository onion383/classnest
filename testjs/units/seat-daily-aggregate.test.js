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

// 指数现在按**身份**归并（id:xx / name:xx），姓名只用于显示（v7 §5-4）。
// 与改造前对照时投影成「显示名 → 数值」：学生名互不相同的夹具下，
// 这等价于旧实现按姓名归并的结果，也正好验证了显示名仍然正确。
const byName = (got) => {
  const out = {}
  for (const [k, v] of Object.entries(got.acc)) out[got.accName[k]] = v
  return out
}

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
    assert.deepEqual(byName(got), oldIndex(filterTo(f.days, indexTo), f.weights, f.studentName), `seed ${seed} 指数不一致`)
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
  assert.deepEqual(byName(got), { 张三: 1, 李四: 2 })
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
  assert.deepEqual(byName(got), { 张三: 1, 李四: 1 }, '指数包含全部天数')
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

// ———————————————— §5-4：指数按身份归并，不按姓名 ————————————————

test('§5-4：同名两个学生在指数里各占一行，显示名补 #id 区分', async () => {
  const { aggregateSeatDaily } = await import(MODULE)
  const got = aggregateSeatDaily({
    days: [{ snap_date: '2026-11-10', seats: [[11, 12]] }],
    weights: [[1, 2]],
    ledgerTo: '', indexTo: '',
    studentName: (id) => ({ 11: '张子涵', 12: '张子涵' }[id] || ''),
  })
  assert.equal(Object.keys(got.acc).length, 2, '同名两人必须各占一条（旧实现会并成 { 张子涵: 3 }）')
  assert.deepEqual(got.acc, { 'id:11': 1, 'id:12': 2 })
  assert.deepEqual(Object.values(got.accName).sort(), ['张子涵（#11）', '张子涵（#12）'],
    '两行同名会让人以为是重复数据，补 #id 才能看出是两个人')
})

test('§5-4：同一个人改过名不会被拆成两条（跨天快照记的是当时的姓名）', async () => {
  const { aggregateSeatDaily } = await import(MODULE)
  const got = aggregateSeatDaily({
    days: [
      { snap_date: '2026-11-09', seats: [[11]] },
      { snap_date: '2026-11-10', seats: [[11]] },
    ],
    weights: [[2]],
    ledgerTo: '', indexTo: '',
    // 第一天快照里叫「张三」，第二天之前改了名 → 名册只给得出新名字；
    // 关键点是键必须是 id，否则会在指数表里出现两行「同一个人的前半段」
    studentName: () => '张三丰',
  })
  assert.deepEqual(got.acc, { 'id:11': 4 }, '按 id 归并：两天累计 4')
  assert.equal(got.accName['id:11'], '张三丰')
})

test('§5-4：没有学号的历史字符串格仍按姓名归并（但不再和 id 行混）', async () => {
  const { aggregateSeatDaily } = await import(MODULE)
  const got = aggregateSeatDaily({
    days: [{ snap_date: '2026-11-10', seats: [['王五', 11]] }],
    weights: [[1, 1]],
    ledgerTo: '', indexTo: '',
    studentName: (id) => ({ 11: '王五' }[id] || ''),
  })
  assert.deepEqual(got.acc, { 'name:王五': 1, 'id:11': 1 },
    '老快照只有姓名，无法与 id 行合并；分开统计比错误合并好')
  assert.deepEqual(Object.values(got.accName).sort(), ['王五', '王五（#11）'].sort())
})

// ———————————————— §4-9 / H4：历史坐标按当前布局重算 ————————————————

test('4-9：当前布局插入走廊列后，历史座位按「第几个座位列」对位，不串位', async () => {
  const { aggregateSeatDaily } = await import(MODULE)
  const got = aggregateSeatDaily({
    // 历史：2 个座位列（无走廊）
    days: [{ snap_date: '2026-11-10', cols: 2, types: [[0, 0]], seats: [[11, 12]] }],
    // 当前：中间插了一条走廊列，权重只填在两侧座位列
    weights: [[10, null, 20]],
    weightsRows: 1, weightsCols: 3,
    weightsTypes: [[0, 1, 0]],
    ledgerTo: '2026-11-10', indexTo: '',
    studentName: (id) => ({ 11: '张三', 12: '李四' }[id] || ''),
  })
  assert.deepEqual(got.acc, { 'id:11': 10, 'id:12': 20 },
    '直接套网格下标会让第二个人落到走廊格（null）上而丢分')
  assert.deepEqual(got.ledger, { 11: 10, 12: 20 }, '账本与指数同一口径')
})

test('4-9：当前布局插入行走廊后，历史行按「第几个座位行」对位', async () => {
  const { aggregateSeatDaily } = await import(MODULE)
  const got = aggregateSeatDaily({
    days: [{ snap_date: '2026-11-10', cols: 1, types: [[0], [0]], seats: [[11], [12]] }],
    weights: [[1], [null], [2]],
    weightsRows: 3, weightsCols: 1,
    weightsTypes: [[0], [1], [0]],
    ledgerTo: '', indexTo: '',
    studentName: (id) => ({ 11: '张三', 12: '李四' }[id] || ''),
  })
  assert.deepEqual(got.acc, { 'id:11': 1, 'id:12': 2 },
    '旧行号 1 在新布局里是走廊行，必须按逻辑行号映射到第 3 行')
})

test('4-9：当前布局缩小时，超出的历史座位不计权重（不借错位的格子）', async () => {
  const { aggregateSeatDaily } = await import(MODULE)
  const got = aggregateSeatDaily({
    days: [{ snap_date: '2026-11-10', cols: 2, types: [[0, 0]], seats: [[11, 12]] }],
    weights: [[7]],
    weightsRows: 1, weightsCols: 1,
    weightsTypes: [[0]],
    ledgerTo: '', indexTo: '',
    studentName: (id) => ({ 11: '张三', 12: '李四' }[id] || ''),
  })
  assert.deepEqual(got.acc, { 'id:11': 7 }, '当前布局没有第 2 个座位列，第二个人不应借位计分')
})

test('4-9：老快照没有 types 时按原网格坐标解释，行为与改造前一致', async () => {
  const { aggregateSeatDaily } = await import(MODULE)
  const got = aggregateSeatDaily({
    days: [{ snap_date: '2026-11-10', seats: [[11, 12]] }],
    weights: [[3, 4]],
    ledgerTo: '', indexTo: '',
    studentName: (id) => ({ 11: '张三', 12: '李四' }[id] || ''),
  })
  assert.deepEqual(got.acc, { 'id:11': 3, 'id:12': 4 })
})
