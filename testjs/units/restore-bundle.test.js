// =========================================================================
// restore-bundle.test.js —— 恢复备份的完整性预检（V4-B05-13）正反用例
//
// 原实现：把上传的 base64 直接 writeFileSync 覆盖现有库。
// 备份包损坏/截断时会连带毁掉「本来能用的旧库」，而且坏库会被登记成有效账号。
// 修复后：先写临时文件 → integrity_check 通过才覆盖。
//
//   反例：非法数据恢复 → 抛错，原库文件字节不变
//   正例：合法库文件恢复 → 成功
// =========================================================================
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BACKEND = path.join(__dirname, '../../student-backend')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-restore-'))
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'restore-bundle-test-key'
process.env.DATA_DIR = DATA_DIR

const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))

const { slug } = dbManager.createTeacher('restore-test', 'not-a-real-hash', 'teacher')
// 触发建库（createTeacher 只登记，首次 withDb 才落文件）
dbManager.withDb(slug, () => { dbManager.current().prepare('SELECT 1').get() })

const dbFile = () => {
  const hit = fs.readdirSync(DATA_DIR).find((f) => f.endsWith('.db') && !f.includes('index'))
  assert.ok(hit, '没找到业务库文件')
  return path.join(DATA_DIR, hit)
}

test.after(() => {
  try { dbManager.evictConn(slug, { force: true }) } catch (_) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) {}
})

test('反例：非法备份数据被拒，且原库数据仍然完好', () => {
  // 先往原库里写一条可核对的数据（evictConn 会做 WAL checkpoint，文件字节本身会变，
  // 所以用「数据是否还在」而不是文件哈希来判断有没有被覆盖）
  dbManager.withDb(slug, () => {
    const c = dbManager.current()
    c.exec('CREATE TABLE IF NOT EXISTS __restore_probe (id INTEGER)')
    c.prepare('INSERT INTO __restore_probe (id) VALUES (1)').run()
  })
  const bad = Buffer.from('this is not a sqlite database').toString('base64')
  assert.throws(
    () => dbManager.restoreBundle({ slug, username: 'restore-test', data: bad, dbKey: null, encrypted: false }),
    /完整性校验未通过/
  )
  const n = dbManager.withDb(slug, () =>
    dbManager.current().prepare('SELECT COUNT(*) AS n FROM __restore_probe').get().n)
  assert.strictEqual(n, 1, '校验失败时绝不能覆盖原库（原数据必须还在）')
})

test('正例：合法明文库可以恢复成功', () => {
  // createTeacher 建的库默认是加密的，测试里拿不到明文钥匙；
  // 这里单独造一个合法的**明文** SQLite 文件作为备份内容，走 encrypted:false 路径。
  const Database = require(path.join(BACKEND, 'node_modules', 'better-sqlite3-multiple-ciphers'))
  const sample = path.join(DATA_DIR, 'sample-plain.db')
  const c = new Database(sample)
  c.exec('CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t (id) VALUES (1);')
  c.close()
  const good = fs.readFileSync(sample).toString('base64')

  const file = dbFile()
  const r = dbManager.restoreBundle({ slug, username: 'restore-test', data: good, dbKey: null, encrypted: false })
  assert.strictEqual(r.slug, slug)
  assert.ok(fs.existsSync(file), '恢复后库文件应存在')
  // 恢复后的内容应真的是那份备份（明文库能被直接打开）
  const check = new Database(file)
  try {
    const row = check.prepare('SELECT COUNT(*) AS n FROM t').get()
    assert.strictEqual(row.n, 1, '恢复出来的库应包含备份里的表与数据')
  } finally {
    check.close()
  }
})
