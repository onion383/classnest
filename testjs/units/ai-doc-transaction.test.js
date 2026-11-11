// =========================================================================
// ai-doc-transaction.test.js —— AI 单块写入的建档副作用要同事务（v6 · Q4-01）
//
// 事故：`POST /api/ai/doc` 的 applyDocWrite 先 validateRow（校验里会把值日名单中的
// 新姓名建档），再快照、再写库 —— 三步都没有事务。写入失败时值日表没变、名册里
// 却多出一个临时学生。
//
// 判据：① 成功时确实建档（别把功能修死） ② 写入失败 → 建档一起回滚 ③ 接线：校验在事务内
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')
const express = backendRequire('express')

process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = process.env.DATA_DIR || path.join(require('node:os').tmpdir(), 'ai-doc-unit-' + process.pid)

const { initSchema } = require('../../student-backend/schema/schema')

const dbPath = require.resolve(path.join(ROOT, 'student-backend/db.js'))
const realDbModule = require(dbPath)
const active = { conn: null }
require.cache[dbPath].exports = {
  ...realDbModule,
  db: new Proxy({}, {
    get(_t, prop) {
      if (!active.conn) return undefined
      const v = active.conn[prop]
      return typeof v === 'function' ? v.bind(active.conn) : v
    },
  }),
  getFields: (t) => active.conn.prepare(
    'SELECT column_name AS name, data_type AS type FROM table_meta WHERE table_name = ? ORDER BY sort_order'
  ).all(t),
  renumber: () => {},
}

const store = require('../../student-backend/services/slotStore')
const aiDataRoutes = require('../../student-backend/routes/ai/ai.dataRoutes')

async function callApi(body) {
  const app = express()
  app.use(express.json())
  app.use('/api/ai', aiDataRoutes)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = server.address().port
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ai/doc`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch (_) { /* 非 JSON 也留着 */ }
    return { status: res.status, text, json }
  } finally { await new Promise((r) => server.close(r)) }
}

function fresh() {
  const conn = new Database(':memory:')
  initSchema(conn)
  active.conn = conn
  conn.prepare("INSERT INTO students (position, 学号, 年级, 班级, 姓名, 年龄, 家长联系电话, 备注) VALUES (1,'001','初二','3班','张三',14,'1','')").run()
  return conn
}
const hasStudent = (name) => active.conn.prepare('SELECT COUNT(*) c FROM students WHERE 姓名 = ?').get(name).c > 0

const BODY = {
  table: 'duty_layout',
  id: 1,
  // 值日 cells 在库里是「按模式分键」结构（sanitize 会拦）；新名字会在校验阶段被建档（有意副作用）
  values: { cells: { daily: { 扫地: { 周一: ['新同学', '张三'] } }, big: {} } },
}

test('成功写入：新姓名被建档', async () => {
  fresh()
  const r = await callApi(BODY)
  assert.equal(r.status, 200, r.text.slice(0, 300))
  assert.equal(hasStudent('新同学'), true)
})

test('写入失败：已发生的建档必须一起回滚', async () => {
  fresh()
  const orig = store.setDoc
  store.setDoc = function patched(name, patch) {
    if (name === 'duty_layout') throw new Error('模拟写入失败')
    return orig.call(this, name, patch)
  }
  try {
    const r = await callApi(BODY)
    assert.equal(r.status, 400, `应返回 400，实际 ${r.status}：${r.text.slice(0, 200)}`)
    assert.match(r.text, /模拟写入失败/)
  } finally {
    store.setDoc = orig
  }
  assert.equal(hasStudent('新同学'), false, '名册里多出一个没排进值日的人 —— Q4-01 的现象')
})

test('接线：applyDocWrite 的校验在事务内', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/routes/ai/ai.dataRoutes.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const fnAt = src.indexOf('function applyDocWrite')
  const txAt = src.indexOf('db.transaction(', fnAt)
  const vAt = src.indexOf('validateRow(table, cleaned, row)', fnAt)
  assert.ok(txAt > fnAt, 'applyDocWrite 必须开事务')
  assert.ok(vAt > txAt, 'validateRow 必须在事务内（它会建档）')
})
