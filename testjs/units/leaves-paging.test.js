// =========================================================================
// leaves-paging.test.js —— 请假列表分页与「今日到班」范围（v6 性能专题 · 2-23）
//
// 背景：GET /api/leaves 原本一次返回整表；记录列表改成滚动加载后每次只要一屏。
// 但「今日到班」要的是另一批：请假中 + 今天已返校，这两类散布在整表里，
// 不能靠列表第一页顺带。本用例锁四件事：
//   ① 不带 limit 时仍是全量（桌面挂件、导出、AI 工具都依赖这个语义）；
//   ② limit+offset 逐页拼接 == 全量顺序（无重复、无遗漏）；
//   ③ scope=today 只返回「请假中」+「今天已返校」，昨天的已返校不能混进来；
//   ④ 不带 date 时退化为「只看请假中」（不猜日期）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { localDateStr } = require('../../student-backend/utils/date')
const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

// 公共夹具：内存库 + db.js Proxy / dbManager.current 的进程级 stub
const fx = createBackendDb({ label: 'leaves-paging' })
const conn = fx.conn

const TODAY = localDateStr()
const YESTERDAY = (() => {
  const d = new Date(`${TODAY}T12:00:00`)
  d.setDate(d.getDate() - 1)
  return localDateStr(d)
})()

// 42 条历史（已返校）+ 3 条请假中 + 2 条今天返校 + 2 条昨天返校（不能算今天）
const ins = conn.prepare(
  'INSERT INTO leave_records (student_id, 姓名, 类型, 开始时间, 结束时间, 状态, 返校时间, 备注, position) VALUES (?,?,?,?,?,?,?,?,?)'
)
conn.transaction(() => {
  for (let i = 0; i < 42; i++) {
    const d = `2026-08-${String((i % 28) + 1).padStart(2, '0')}`
    ins.run(null, `学生${i}`, '事假', `${d} 08:00`, `${d} 17:00`, '已返校', `${d} 16:00`, '', i + 1)
  }
  for (let i = 0; i < 3; i++) ins.run(null, `请假中${i}`, '病假', `${TODAY} 08:00`, `${TODAY} 17:00`, '请假中', '', '', 100 + i)
  for (let i = 0; i < 2; i++) ins.run(null, `今天返校${i}`, '事假', `${TODAY} 08:00`, `${TODAY} 12:00`, '已返校', `${TODAY} 11:30`, '', 200 + i)
  for (let i = 0; i < 2; i++) ins.run(null, `昨天返校${i}`, '事假', `${YESTERDAY} 08:00`, `${YESTERDAY} 12:00`, '已返校', `${YESTERDAY} 11:30`, '', 300 + i)
})()

let base
test.before(async () => {
  base = await fx.mount('/api/leaves', 'student-backend/routes/leaves.js')
})
test.after(() => fx.close())

const get = async (qs = '') => (await fetch(base + qs)).json()

test('不带 limit：仍是全量（挂件/导出/AI 工具依赖这个语义）', async () => {
  const j = await get()
  assert.equal(j.data.length, 49, '42 历史 + 3 请假中 + 2 今天返校 + 2 昨天返校')
  assert.equal(j.hasMore, undefined)
})

test('分页：逐页拼接 == 全量顺序', async () => {
  const all = (await get()).data.map((r) => r.id)
  const paged = []
  let offset = 0
  for (;;) {
    const j = await get(`?limit=10&offset=${offset}`)
    paged.push(...j.data.map((r) => r.id))
    if (!j.hasMore) break
    offset += 10
  }
  assert.deepEqual(paged, all)
})

test('scope=today：请假中 + 今天已返校，昨天的已返校不算', async () => {
  const j = await get(`?scope=today&date=${TODAY}`)
  const names = j.data.map((r) => r.姓名).sort()
  assert.equal(j.data.length, 5, '3 请假中 + 2 今天返校')
  assert.ok(names.includes('请假中0'))
  assert.ok(names.includes('今天返校1'))
  assert.ok(!names.some((n) => String(n).startsWith('昨天返校')), '昨天的已返校不能混进来')
  assert.ok(!names.includes('学生0'), '历史已返校不进来')
})

test('scope=today 不带 date：退化为只看请假中，不猜日期', async () => {
  const j = await get('?scope=today')
  assert.equal(j.data.length, 3)
  assert.ok(j.data.every((r) => r.状态 === '请假中'))
})

test('非法 date 不生效（不抛错、不返回空）', async () => {
  const j = await get('?scope=today&date=not-a-date')
  assert.equal(j.data.length, 3, '与不带 date 一致')
})

// M12-B6：提交的语句已收进 services/leaveStore，SQL 不许再长回路由层。
test('SQL 出口：leaves 路由只经 leaveStore，不留裸 SQL', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/leaves.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.ok(!/db\.prepare\(/.test(src), 'leaves 路由不许再有裸 SQL（应走 services/leaveStore）')
  assert.ok(/leaveStore\.readList\(/.test(src), '列表必须真的走 leaveStore.readList')
})
