// =========================================================================
// score-paging.test.js —— 成绩列表分页与首页聚合（v6 性能专题 · 2-23）
//
// 背景：GET /api/scores 原本一次返回整表；成绩随学期线性增长，列表改成无限滚动后
// 每次只要一屏。统计页签仍走全量（它要汇总，不是逐条），所以两种模式都得测。
// 本文件锁四件事：
//   ① 不带 limit 时行为与旧版一致（全量 { data }），统计页签不被分页破坏；
//   ② limit+offset 分页逐页拼接 == 全量顺序（无重复、无遗漏）；
//   ③ source 过滤与前端旧口径一致：'group' 只看小组，'personal' 含历史 source 为空的行；
//   ④ dashboard 改 SQL 聚合后，Top4 仍与「全量 + filter/sort/slice」旧逻辑逐项一致。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { localDateStr } = require('../../student-backend/utils/date')
const { createBackendDb } = require('./_db-express-fixture.cjs')

// 公共夹具会在 require 任何 student-backend 模块之前设好主密钥与 DATA_DIR
const fx = createBackendDb({ label: 'score-paging' })
const conn = fx.conn

const TODAY = localDateStr()
const ins = conn.prepare(
  'INSERT INTO score_records (student_id, 姓名, 学号, 类型, 项目, 分值, 原因, 加分时间, created_at, source, group_name) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
)

// 30 条个人（时间递减）+ 10 条小组 + 5 条历史记录 source 为空（旧数据，前端算作个人）
const seed = () => {
  conn.transaction(() => {
    for (let i = 0; i < 30; i++) {
      const t = `2026-09-${String(28 - (i % 28)).padStart(2, '0')} 10:00:00`
      ins.run(null, `学生${i + 1}`, `2026${String(i + 1).padStart(3, '0')}`, '加分', '课堂表现', i % 5, '表现好', t, t, 'personal', null)
    }
    for (let i = 0; i < 10; i++) {
      const t = `2026-09-${String(28 - (i % 28)).padStart(2, '0')} 11:00:00`
      ins.run(null, null, null, '加分', '小组竞赛', i, '小组表现好', t, t, 'group', `第${i + 1}小组`)
    }
    for (let i = 0; i < 5; i++) {
      const t = `2026-08-${String(20 - i).padStart(2, '0')} 09:00:00`
      ins.run(null, `老学生${i}`, `2025${i}`, '加分', '旧数据', i, '', t, t, null, null)
    }
  })()
}
seed()

let base
test.before(async () => {
  base = await fx.mount('/api/scores', 'student-backend/routes/scores.js')
})
test.after(() => fx.close())

const get = async (qs = '') => (await fetch(base + qs)).json()

test('不带 limit：与旧版一致返回全量 { data }，统计页签不受影响', async () => {
  const j = await get()
  assert.ok(Array.isArray(j.data), '必须是数组')
  assert.equal(j.data.length, 45, '30 个人 + 10 小组 + 5 历史')
  assert.equal(j.hasMore, undefined, '全量模式不该有 hasMore')
})

test('分页：逐页拼接 == 全量顺序，无重复无遗漏', async () => {
  const all = (await get()).data.map((r) => r.id)
  const paged = []
  let offset = 0
  for (;;) {
    const j = await get(`?limit=10&offset=${offset}`)
    paged.push(...j.data.map((r) => r.id))
    if (!j.hasMore) break
    offset += 10
  }
  assert.deepEqual(paged, all, '分页拼接必须与全量顺序完全一致')
})

test('hasMore 边界：最后一页为 false，取完即止', async () => {
  const j1 = await get('?limit=10&offset=0')
  assert.equal(j1.data.length, 10)
  assert.equal(j1.hasMore, true)

  const last = await get('?limit=10&offset=40')
  assert.equal(last.data.length, 5)
  assert.equal(last.hasMore, false, '取到末尾就不能再报还有更多')

  const empty = await get('?limit=10&offset=45')
  assert.equal(empty.data.length, 0)
  assert.equal(empty.hasMore, false)
})

test('source 过滤：group 只看小组，personal 含历史 source 为空的行', async () => {
  const g = await get('?source=group')
  assert.equal(g.data.length, 10)
  assert.ok(g.data.every((r) => r.source === 'group'))

  const p = await get('?source=personal')
  assert.equal(p.data.length, 35, '30 条 personal + 5 条历史 null')
  assert.ok(p.data.every((r) => r.source !== 'group'), 'personal 视图不能混进小组记录')

  // 分页 + 过滤组合
  const pg = await get('?source=personal&limit=20&offset=0')
  assert.equal(pg.data.length, 20)
  assert.equal(pg.hasMore, true)
  const pg2 = await get('?source=personal&limit=20&offset=20')
  assert.equal(pg2.data.length, 15)
  assert.equal(pg2.hasMore, false)
})

test('limit 越界：超过上限夹到 200，非法值退化为全量', async () => {
  // 数据只有 45 条，上限夹紧后仍返回全部 45 条且 hasMore 为 false
  const big = await get('?limit=99999&offset=0')
  assert.equal(big.data.length, 45)
  assert.equal(big.hasMore, false)

  // limit=abc 不是有效数字 → 按全量处理（与旧行为一致）
  const bad = await get('?limit=abc')
  assert.equal(bad.data.length, 45)
})

test('dashboard 聚合：Top4 与「全量 + filter/sort/slice」旧逻辑逐项一致', async () => {
  // 造 6 条今天的记录：分值 10/9/7/5扣/3小组/1扣，覆盖四个分支
  // 必须有两位数（10）—— 分值列是 TEXT，去掉 CAST 后字符串排序会把 "9" 排到 "10" 前面，
  // 这条就是为了让「不回退到字符串排序」这件事在测试里可被抓住。
  const t = `${TODAY} 08:00:00`
  const rows = [
    [5, '钱七', 10, '加分', 'personal', null],
    [1, '张三', 9, '加分', 'personal', null],
    [2, '李四', 7, '加分', 'personal', null],
    [3, '王五', 5, '扣分', 'personal', null],
    [null, null, 3, '加分', 'group', '第三小组'],
    [4, '赵六', 1, '扣分', 'personal', null],
  ]
  for (const [sid, name, v, type, source, group] of rows) {
    ins.run(null, name, sid ? `2026${String(sid).padStart(3, '0')}` : null, type, '课堂表现', v, '', t, t, source, group)
  }

  // 旧逻辑（全量读 + JS 处理）
  const all = conn.prepare('SELECT * FROM score_records ORDER BY 加分时间 DESC, id DESC').all()
  const legacy = all
    .filter((s) => s && s['加分时间'] && String(s['加分时间']).startsWith(TODAY))
    .sort((a, b) => Number(b['分值'] || 0) - Number(a['分值'] || 0))
    .slice(0, 4)
    .map((s) => ({
      name: s['姓名'] || s.group_name || '未知',
      score: s['类型'] === '扣分' ? -Number(s['分值'] || 0) : Number(s['分值'] || 0),
    }))

  const agg = fx.router.dashboardSummary(TODAY)
  const now = agg.top.map((s) => ({
    name: s['姓名'] || s.group_name || '未知',
    score: s['类型'] === '扣分' ? -Number(s['分值'] || 0) : Number(s['分值'] || 0),
  }))

  assert.equal(agg.count, all.length, '条数口径必须与全量行数一致')
  assert.deepEqual(now, legacy, 'SQL 聚合的 Top4 必须与旧 JS 逻辑逐项一致')
  assert.equal(now.length, 4, '要截断到 4 条')
})

test('date 过滤：某一天的全部记录，供今日时间轴单独拉', async () => {
  // 不写死条数：与「全量里属于今天的那些」对比，避免依赖前面用例插了多少条
  const all = (await get()).data
  const expect = all.filter((r) => String(r.加分时间 || '').startsWith(TODAY))
  const today = await get(`?date=${TODAY}`)
  assert.equal(today.data.length, expect.length, '今日条数必须与全量里今天的一致')
  assert.ok(today.data.length > 0, '用例自身要有今天的数据')
  assert.ok(today.data.every((r) => String(r.加分时间).startsWith(TODAY)))

  // 非法日期不生效（退化为全量），而不是抛错或返回空
  const bad = await get('?date=not-a-date')
  assert.equal(bad.data.length, all.length)

  // date + source 可组合
  const g = await get(`?date=${TODAY}&source=group`)
  assert.ok(g.data.every((r) => r.source === 'group' && String(r.加分时间).startsWith(TODAY)))
})
