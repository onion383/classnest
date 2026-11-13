// =========================================================================
// semester-crud.test.js —— 学期 CRUD 与「当前学期」镜像（档 C · M12-B4）
//
// 背景：`routes/schedule.js` 里 15 处 semesters 语句下沉到 services/semesterStore，
// 课表 / 模板的 4 处槽位读改走 slotStore.getDoc，slotStore.semesterRange 也改为
// 复用同一个 findCurrent() —— 「当前学期」从两份手抄变成一处判定。
//
// 判据是**行为**而非实现：下沉前后同一串请求必须给出同样的结果，尤其是这几条老坑：
//   ① 新增学期即成为当前，且 is_current 互斥；
//   ② 删掉当前学期要自动补选剩下的最新一条（否则全库「没有当前学期」）；
//   ③ PUT /settings 只带 semester_start 时不能把 end_date 清空（历史 bug，
//      结束日期是值日/座位快照补存的上界）；
//   ④ 结束日期早于开始 → 400（存反了会让补存整段静默跳过）。
// 另加一条源码判据：两个路由不许再有裸 SQL。
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'semester-crud' })
// 注意：不能用模块级 `const conn = fx.conn` —— reset() 会换掉连接，旧引用是已关闭的库

test.before(() => fx.mount('/api/schedule', 'student-backend/routes/schedule.js'))
test.after(() => fx.close())

const post = (p, body) => fx.call('POST', p, body)
const put = (p, body) => fx.call('PUT', p, body)
const del = (p) => fx.call('DELETE', p)
const get = (p) => fx.call('GET', p)

const rows = () => fx.conn.prepare('SELECT id, name, start_date, end_date, is_current FROM semesters ORDER BY id').all()

test('新增学期：成为当前学期，且当前标记唯一', async () => {
  fx.reset()
  const a = await post('/semesters', { name: '上学期', start_date: '2026-02-01', end_date: '2026-07-10' })
  assert.equal(a.status, 200, a.text.slice(0, 200))
  const b = await post('/semesters', { name: '下学期', start_date: '2026-09-01', end_date: '2027-01-20' })
  assert.equal(b.status, 200, b.text.slice(0, 200))

  const all = rows()
  assert.equal(all.length, 2)
  assert.equal(all.filter((r) => r.is_current).length, 1, '当前学期必须唯一')
  assert.equal(all.find((r) => r.is_current).name, '下学期', '后加的成为当前')

  // 设置镜像跟着走（座位补存/值日结算读的是这个）
  const s = await get('/settings')
  assert.equal(s.json.semester_start, '2026-09-01')
  assert.equal(s.json.semester_end, '2027-01-20')
})

test('列表：按开始日期倒序，未填日期的排最后', async () => {
  fx.reset()
  await post('/semesters', { name: 'A', start_date: '2026-02-01', end_date: '2026-07-10' })
  await post('/semesters', { name: 'B', start_date: '2026-09-01', end_date: '2027-01-20' })
  // 空日期只能直接落库（POST 会用 autoSemester 补默认值）
  fx.conn.prepare("INSERT INTO semesters (name, start_date, end_date, is_current) VALUES ('空日期','','',0)").run()
  const r = await get('/semesters')
  assert.equal(r.status, 200, r.text.slice(0, 200))
  assert.deepEqual(r.json.semesters.map((s) => s.name), ['B', 'A', '空日期'])
  // current = 标了 is_current 的那条；没有标记时退回列表第一条
  assert.equal(r.json.current.name, 'B')
})

test('切换当前学期：旧的自动取消', async () => {
  fx.reset()
  const a = await post('/semesters', { name: 'A', start_date: '2026-02-01', end_date: '2026-07-10' })
  await post('/semesters', { name: 'B', start_date: '2026-09-01', end_date: '2027-01-20' })

  const r = await put('/semesters/current', { id: a.json.id })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  const all = rows()
  assert.deepEqual(all.filter((x) => x.is_current).map((x) => x.name), ['A'])

  const missing = await put('/semesters/current', { id: 99999 })
  assert.equal(missing.status, 404)
})

test('修改学期：只传名字时日期原样保留', async () => {
  fx.reset()
  const a = await post('/semesters', { name: '旧名', start_date: '2026-02-01', end_date: '2026-07-10' })
  const r = await put(`/semesters/${a.json.id}`, { name: '新名' })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  const row = rows()[0]
  assert.equal(row.name, '新名')
  assert.equal(row.start_date, '2026-02-01', '未传的日期不能被清空')
  assert.equal(row.end_date, '2026-07-10')

  const bad = await put(`/semesters/${a.json.id}`, { start_date: '2026-09-01', end_date: '2026-02-01' })
  assert.equal(bad.status, 400, '结束早于开始必须拒')
  const missing = await put('/semesters/99999', { name: 'x' })
  assert.equal(missing.status, 404)
})

test('删除当前学期：自动把剩下的最新一条设为当前', async () => {
  fx.reset()
  await post('/semesters', { name: 'A', start_date: '2026-02-01', end_date: '2026-07-10' })
  const b = await post('/semesters', { name: 'B', start_date: '2026-09-01', end_date: '2027-01-20' })

  const r = await del(`/semesters/${b.json.id}`)
  assert.equal(r.status, 200, r.text.slice(0, 200))
  const all = rows()
  assert.equal(all.length, 1)
  assert.equal(all[0].is_current, 1, '删掉当前学期后不能一个当前都没有')

  const missing = await del('/semesters/99999')
  assert.equal(missing.status, 404)
})

test('PUT /settings：只传开始日期时不能清空结束日期', async () => {
  fx.reset()
  await post('/semesters', { name: 'A', start_date: '2026-02-01', end_date: '2026-07-10' })
  const r = await put('/settings', { semester_start: '2026-02-10' })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  const s = await get('/settings')
  assert.equal(s.json.semester_start, '2026-02-10')
  assert.equal(s.json.semester_end, '2026-07-10', '结束日期被悄悄清空 —— 快照补存会整段跳过')

  const bad = await put('/settings', { semester_start: '2026-09-01', semester_end: '2026-02-01' })
  assert.equal(bad.status, 400)
})

test('没有学期时 PUT /settings 建一条当前学期', async () => {
  fx.reset()
  const r = await put('/settings', { semester_start: '2026-03-01', semester_end: '2026-07-01' })
  assert.equal(r.status, 200, r.text.slice(0, 200))
  const all = rows()
  assert.equal(all.length, 1)
  assert.equal(all[0].is_current, 1)
  assert.equal(all[0].start_date, '2026-03-01')
})

test('slotStore.semesterRange 与 /settings 同源（当前学期只有一处判定）', async () => {
  fx.reset()
  await post('/semesters', { name: 'A', start_date: '2026-02-01', end_date: '2026-07-10' })
  await post('/semesters', { name: 'B', start_date: '2026-09-01', end_date: '2027-01-20' })
  const store = require('../../student-backend/services/slotStore')
  const range = store.semesterRange()
  const s = await get('/settings')
  assert.deepEqual(range, { start: s.json.semester_start, end: s.json.semester_end })
})

test('老库没有当前标记时：current 回退最新一条（不是 null）', async () => {
  fx.reset()
  // 直接落库：模拟升级前的老数据，is_current 全是 0
  fx.conn.prepare("INSERT INTO semesters (name, start_date, end_date, is_current) VALUES ('老学期1','2025-02-01','2025-07-01',0)").run()
  fx.conn.prepare("INSERT INTO semesters (name, start_date, end_date, is_current) VALUES ('老学期2','2025-09-01','2026-01-10',0)").run()
  const s = await get('/settings')
  assert.equal(s.json.semester_start, '2025-09-01', '没有 is_current 时取 id 最新的一条')
  assert.equal(s.json.semester_end, '2026-01-10')
})

// ---------------------------------------------------------------------------
// 源码判据：M12-B4 之后这两个路由不该再有裸 SQL
// ---------------------------------------------------------------------------
const codeOnly = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

test('SQL 出口：schedule 路由只经 semesterStore / slotStore', () => {
  const code = codeOnly('student-backend/routes/schedule.js')
  assert.ok(!/db\.prepare\(/.test(code), 'schedule 路由不许再有裸 SQL')
  assert.match(code, /semesterStore\.(list|findCurrent|create|setCurrent|update|updateRange|remove)\(/, '学期读写必须走 semesterStore')
  assert.match(code, /store\.getDoc\('schedule'\)/, '实行课表必须经 slotStore 读取')
})

test('SQL 出口：duty 路由的槽位读统一走 slotStore', () => {
  const code = codeOnly('student-backend/routes/duty.js')
  assert.ok(!/db\.prepare\(/.test(code), 'duty 路由不许再有裸 SQL')
  for (const name of ['duty_settings', 'duty_layout', 'duty_template', 'duty_weight', 'duty_draft']) {
    assert.match(code, new RegExp(`store\\.getDoc\\('${name}'\\)`), `${name} 必须经 store.getDoc 读取`)
  }
})
