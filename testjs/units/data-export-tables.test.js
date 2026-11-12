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
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')
const express = backendRequire('express')

process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-export-tables-'))
process.env.DATA_DIR = tmp

const { initSchema } = require('../../student-backend/schema/schema')
const conn = new Database(':memory:')
initSchema(conn)

// 把 db.js 的 Proxy 换成内存库（与 undo-batch-coverage.test.js 同一套写法），
// 必须在 require 路由之前完成：路由在模块加载时就拿到了 db 引用。
const dbPath = require.resolve(path.join(ROOT, 'student-backend/db.js'))
const realDb = require(dbPath)
require.cache[dbPath].exports = { ...realDb, db: conn, getFields: () => [], renumber: () => {} }

const router = require('../../student-backend/routes/dataExport')

// SQL spy：记录路由执行期间真正下发的语句
const seen = []
const origPrepare = conn.prepare.bind(conn)
conn.prepare = (sql) => { seen.push(String(sql)); return origPrepare(sql) }

let server
let base
test.before(async () => {
  for (const n of ['张三', '李四', '王五']) conn.prepare('INSERT INTO students (姓名) VALUES (?)').run(n)
  for (const t of ['春游', '运动会']) conn.prepare('INSERT INTO activities (主题) VALUES (?)').run(t)
  const app = express()
  app.use(express.json())
  app.use('/api/data', router)
  await new Promise((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})

test.after(() => {
  server?.close()
  try { conn.close() } catch (_) { /* 忽略 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) { /* 忽略 */ }
})

async function fetchTables() {
  seen.length = 0
  const res = await fetch(`${base}/api/data/tables`)
  assert.equal(res.status, 200)
  const body = await res.json()
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
