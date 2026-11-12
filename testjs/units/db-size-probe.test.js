// =========================================================================
// db-size-probe.test.js —— 库体积探针（v6 性能专题 · 0-4）
//
// 验收点：
//   ① 明文库能读出 page_count / freelist_count / 文件与 WAL 体积；
//   ② 非法/加密库必须标 encrypted=true，而不是静默返回 0；
//   ③ 目录扫描只认 .db；自证脚本必须真的能跑通。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const Database = require(path.join(ROOT, 'student-backend/node_modules/better-sqlite3-multiple-ciphers'))
const { inspectDb, inspectDir, isEncryptedError, runSelftest } = require('../probe/db-size-probe.cjs')

function makePlainDb(dir) {
  const file = path.join(dir, 'a.db')
  const db = new Database(file)
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  const ins = db.prepare('INSERT INTO t (v) VALUES (?)')
  db.transaction(() => { for (let i = 0; i < 500; i++) ins.run('x'.repeat(200)) })()
  db.prepare('DELETE FROM t WHERE id > 50').run()
  db.close()
  return file
}

test('明文库：页数 / 空闲页 / 文件体积 / WAL 体积都能读出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-size-unit-'))
  try {
    const file = makePlainDb(dir)
    fs.writeFileSync(file + '-wal', Buffer.alloc(4096))
    const info = inspectDb(file)
    assert.equal(info.encrypted, false)
    assert.ok(info.pageSize > 0, 'page_size 必须读出')
    assert.ok(info.pages > 0, 'page_count 必须读出')
    assert.ok(info.freelist >= 0, 'freelist_count 必须读出')
    assert.ok(info.dbBytes > 0)
    assert.equal(info.walBytes, 4096)
    assert.ok(info.freelistRatio >= 0 && info.freelistRatio <= 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('非法库：标 encrypted=true，不能静默当 0 页', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-size-unit-'))
  try {
    const bad = path.join(dir, 'bad.db')
    fs.writeFileSync(bad, Buffer.from('definitely not sqlite'))
    const info = inspectDb(bad)
    assert.equal(info.encrypted, true)
    assert.ok(info.dbBytes > 0)
    assert.equal(info.pages, undefined)
    assert.ok(isEncryptedError(new Error('file is not a database')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('目录扫描只认 .db，不把 -wal/-shm 当库', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-size-unit-'))
  try {
    makePlainDb(dir)
    fs.writeFileSync(path.join(dir, 'a.db-wal'), Buffer.alloc(1024))
    fs.writeFileSync(path.join(dir, 'a.db-shm'), Buffer.alloc(1024))
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    const rows = inspectDir(dir)
    assert.equal(rows.length, 1)
    assert.equal(path.basename(rows[0].dbPath), 'a.db')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('自证脚本能跑通（造 freelist + 加密态两类样本）', () => {
  const r = runSelftest()
  assert.equal(r.ok, true)
  assert.ok(r.plain.pages > 0)
  assert.equal(r.encrypted.encrypted, true)
})
