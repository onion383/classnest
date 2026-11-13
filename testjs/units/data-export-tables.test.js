// =========================================================================
// data-export-tables.test.js —— /api/data/tables 只计数、不物化（v6 性能专题 · 1-3）
//
// 事故面：这个接口以前对 20 张表逐个 `build().rows.length` —— 设置页一进来，
// 只为显示「N 行」就把整表（含长文本、路径、快照 JSON）建成行对象再丢掉。
//
// 覆盖：
//   ① 计数正确：students / activities 插入几行就报几行；
//   ② 不物化：整个 GET 期间没有任何 `SELECT * FROM students|activities`；
//   ③ 派生表兜底：没有物理表的「应用设置」仍走 build，行数不为 0；
//   ④ 每张有物理表的表都配了 count（防止以后新增表漏掉）。
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-export-tables-'))
const fx = createBackendDb({
  label: 'data-export-tables',
  dataDir: tmp,
  currentSlug: '@vacuumprobe',
  extraDbExports: { renumber: () => {} },
})
const conn = fx.conn

// SQL spy：记录路由执行期间真正下发的语句
const seen = []
const origPrepare = conn.prepare.bind(conn)
conn.prepare = (sql) => { seen.push(String(sql)); return origPrepare(sql) }

test.before(async () => {
  for (const n of ['张三', '李四', '王五']) conn.prepare('INSERT INTO students (姓名) VALUES (?)').run(n)
  for (const t of ['春游', '运动会']) conn.prepare('INSERT INTO activities (主题) VALUES (?)').run(t)
  await fx.mount('/api/data', 'student-backend/routes/dataExport.js')
})

test.after(() => {
  fx.close()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) { /* 忽略 */ }
})

async function fetchTables() {
  seen.length = 0
  const res = await fx.call('GET', '/api/data/tables')
  assert.equal(res.status, 200)
  const body = res.json
  return Object.fromEntries(body.tables.map((t) => [t.key, t.count]))
}

test('计数正确且不物化整表', async () => {
  const counts = await fetchTables()
  assert.equal(counts.students, 3)
  assert.equal(counts.activities, 2)
  assert.equal(counts.scores, 0, '空表必须报 0 而不是报错')
  assert.ok(counts.settings > 0, '没有物理表的「应用设置」仍要走 build 兜底')

  const materialized = seen.filter((sql) => /SELECT \* FROM\s+(students|activities)\b/i.test(sql))
  assert.deepEqual(materialized, [], '有 count 的表不得再被 SELECT * 物化')
  assert.ok(seen.some((sql) => /COUNT\(\*\)/i.test(sql)), '必须走 COUNT(*) 出口')
})

test('所有「一行对应物理表一行」的表都配了 count', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/dataExport.js'), 'utf8')
  const entries = [...src.matchAll(/\{ key: '([A-Za-z]+)',[^}]*\}/g)]
  const withCount = new Set()
  for (const m of entries) if (/count: \(\) => countOf\('([a-z_]+)'\)/.exec(m[0])) withCount.add(m[1])
  // 四张派生表（整块 JSON 的单一文档）允许不配 count，其余必须有
  const derived = new Set(['seats', 'duties', 'dutiesBig', 'schedule', 'settings'])
  const missing = entries
    .map((m) => m[1])
    .filter((key) => !derived.has(key) && !withCount.has(key))
  assert.deepEqual(missing, [], `以下表有物理表但没配 count：${missing.join(', ')}`)
})

// 「整理」= VACUUM：删除留下的空闲页必须真的被回收，且数据一条不少。
// 用独立表造空洞，避免影响上面 students/activities 的计数断言。
test('POST /vacuum 回收空闲页且数据不丢', async () => {
  conn.exec('CREATE TABLE vacuum_probe (id INTEGER PRIMARY KEY, v TEXT)')
  const ins = conn.prepare('INSERT INTO vacuum_probe (v) VALUES (?)')
  conn.transaction(() => { for (let i = 0; i < 500; i++) ins.run('x'.repeat(300)) })()
  conn.prepare('DELETE FROM vacuum_probe WHERE id > 10').run()

  const before = Number(conn.pragma('freelist_count', { simple: true }))
  assert.ok(before > 0, '前置条件：删行后应当留下空闲页')

  const res = await fx.call('POST', '/api/data/vacuum')
  assert.equal(res.status, 200)
  const d = res.json.data
  assert.equal(d.freelistBefore, before, '返回值要如实报告整理前的空闲页')
  assert.equal(d.freelistAfter, 0, 'VACUUM 后 freelist 必须清零')
  assert.ok(typeof d.durationMs === 'number' && d.durationMs >= 0)
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM vacuum_probe').get().n, 10, '数据不能丢')
  assert.ok(Array.isArray(conn.pragma('integrity_check')) && conn.pragma('integrity_check')[0].integrity_check === 'ok')

  // 已经没有空闲页时不能再跑一次全库重写（大库会白等几秒）：直接 noop 返回
  const again = await fx.call('POST', '/api/data/vacuum')
  assert.equal(again.status, 200)
  assert.equal(again.json.data.noop, true, '无空闲页应直接返回 noop，不做 VACUUM')
  assert.equal(again.json.data.freedBytes, 0)
  assert.equal(again.json.data.freelistBefore, 0)
})
