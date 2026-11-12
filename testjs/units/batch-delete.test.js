// =========================================================================
// batch-delete.test.js —— 批量删除端点（v6 性能专题 · 1-8）
//
// 事故面：前端「删除重复数据」逐条 `await axios.delete`（N 条 = N 次往返）；
// 多选删除虽然是 Promise.all，但仍是 N 个请求，且半途失败会留下「部分删掉」的状态。
//
// 覆盖：
//   ① 正常批量：一次 POST 删 N 条，position 重排连续；
//   ② 事务回滚：夹一个不存在的 id → 400，且**合法的那几条也没被删**（无半截状态）；
//   ③ minCount 保护：删完会低于下限 → 400，一行不掉（批量路径绕不过去）；
//   ④ 单条 DELETE 仍保留（行内删除走它）；
//   ⑤ 前端接线：去重删除与多选删除都只发 1 个 batch-delete 请求。
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-delete-'))
process.env.DATA_DIR = tmp

const { initSchema } = require('../../student-backend/schema/schema')
const conn = new Database(':memory:')
initSchema(conn)

// 真实的 renumber（db.js 的实现依赖 currentDb()，这里换成同一语义的内存库版本）
function renumber(tableName) {
  const rows = conn.prepare(`SELECT id FROM ${tableName} ORDER BY position, id`).all()
  const stmt = conn.prepare(`UPDATE ${tableName} SET position = ? WHERE id = ?`)
  conn.transaction(() => rows.forEach((r, i) => stmt.run(i + 1, r.id)))()
}

// 把 db.js 的导出换成内存库（与 data-export-tables.test.js 同一套写法），
// 必须在 require 路由之前完成：路由在模块加载时就拿到了 db 引用。
const dbPath = require.resolve(path.join(ROOT, 'student-backend/db.js'))
const realDb = require(dbPath)
require.cache[dbPath].exports = { ...realDb, db: conn, getFields: () => [], renumber }

const { createDynamicTableRouter } = require('../../student-backend/routes/dynamicTable')

let server
let base
test.before(async () => {
  const names = ['张三', '李四', '王五', '赵六']
  names.forEach((n, i) => {
    conn.prepare('INSERT INTO students (姓名, position) VALUES (?, ?)').run(n, i + 1)
  })
  const app = express()
  app.use(express.json())
  // minCount=1：至少保留一条学生
  app.use('/api/students', createDynamicTableRouter('students', { minCount: 1 }))
  await new Promise((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})

test.after(() => {
  server?.close()
  try { conn.close() } catch (_) { /* 忽略 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) { /* 忽略 */ }
})

const left = () => conn.prepare('SELECT id, position FROM students ORDER BY position').all()
const post = (body) => fetch(`${base}/api/students/batch-delete`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

test('一次 POST 删 N 条，position 连续', async () => {
  const res = await post({ ids: [2, 4, 2] }) // 重复 id 去重
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { message: '删除成功', deleted: 2 })
  assert.deepEqual(left(), [{ id: 1, position: 1 }, { id: 3, position: 2 }])
})

test('任一 id 不存在 → 整批回滚，合法的那条也不删', async () => {
  const res = await post({ ids: [1, 999] })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /记录不存在/)
  assert.deepEqual(left(), [{ id: 1, position: 1 }, { id: 3, position: 2 }], '不能出现半截删除')
})

test('minCount 保护：删完低于下限 → 一行不掉', async () => {
  const res = await post({ ids: [1, 3] })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /至少需要保留一条记录/)
  assert.deepEqual(left(), [{ id: 1, position: 1 }, { id: 3, position: 2 }])
})

test('单条 DELETE 仍保留给行内删除', async () => {
  const res = await fetch(`${base}/api/students/1`, { method: 'DELETE' })
  assert.equal(res.status, 200)
  assert.deepEqual(left(), [{ id: 3, position: 1 }], '剩余行位置要重排为 1')
})

test('缺少 ids 直接拒绝', async () => {
  const res = await post({})
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /缺少要删除的记录/)
  const res2 = await post({ ids: ['abc', 0, -1] })
  assert.equal(res2.status, 400)
})

test('前端接线：两处删除都只发 1 个 batch-delete，不再逐条 DELETE', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-frontend/src/composables/useTableCRUD.js'), 'utf8')
  const batch = src.match(/axios\.post\(`\$\{apiBase\}\/batch-delete`/g) || []
  assert.equal(batch.length, 2, `去重删除与多选删除各一处，实际 ${batch.length}`)
  // 去重删除里不能再有「for 循环逐条 delete」，多选也不能再 Promise.all 一串 DELETE
  assert.doesNotMatch(src, /for \(const id of ids\) \{\s*await axios\.delete/)
  assert.doesNotMatch(src, /Promise\.all\(selectedIds\.map/)
  // 行内单条删除保留
  assert.match(src, /await axios\.delete\(`\$\{apiBase\}\/\$\{row\.id\}`\)/)
})
