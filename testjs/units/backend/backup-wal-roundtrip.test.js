// =========================================================================
// backup-wal-roundtrip.test.js —— 备份一致性真库往返（V8 · 5-1 / N2-01）
//
// N2-01（P0，实测复现）：备份走裸文件拷贝、导出前未 checkpoint。常驻连接在用户
// 编辑后仍持有句柄，最近提交可能只在 -wal 里；旧恢复侧只拷 .db 再删 -wal/-shm，
// 尾页丢失 → 恢复「报成功」但数据少了。
//
// 生产修复（fc41e39）：①导出前 checkpointForBackup 合并尾页、包内只带主库；
// ②checkpoint 失败退回三件套时，恢复侧按同 basename 落位 srcWal 并重放。
//
// 本测试是这两条修复的行为守卫：用真库 + 常驻连接 + WAL 尾页复现生产常态路径，
// 断言「最近提交不丢」。变异去掉任一修复即红。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BACKEND = abs('student-backend')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-backup-wal-'))
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'backup-wal-test-key'
process.env.DATA_DIR = DATA_DIR

const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const Database = require(path.join(BACKEND, 'node_modules', 'better-sqlite3-multiple-ciphers'))

// 独立 slug，避免与其它测试的库互相覆盖
const { slug } = dbManager.createTeacher('backup-wal', 'hash', 'teacher', false /* 明文库，便于直接读主库文件 */)
dbManager.withDb(slug, () => { dbManager.current().prepare('SELECT 1').get() })
const dbFile = () => dbManager.dbFilePath(slug)
const walFile = () => dbFile() + '-wal'

test.after(() => {
  try { dbManager.evictConn(slug, { force: true }) } catch (_) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) {}
})

// 通过常驻连接写一行带唯一标记的数据，不 evict / 不手工 checkpoint。
// 这是生产里「用户刚编辑完就点备份」的常态：尾页还留在 -wal 中。
function writeTailRow(id, mark) {
  dbManager.withDb(slug, () => {
    dbManager.current().prepare('INSERT INTO students (id, 姓名) VALUES (?, ?)').run(id, mark)
  })
  assert.ok(fs.existsSync(walFile()) && fs.statSync(walFile()).size > 0,
    '前置：写入应让 WAL 出现尾页（否则本测试测不到 checkpoint 行为）')
}

test('① 导出前 checkpoint 把 WAL 尾页并回主库，只拷主库不丢最近提交', () => {
  const mark = 'N2-WAL-TAIL-' + Date.now()
  writeTailRow(9101, mark)

  // 生产导出路径：account.js 导出路由先 checkpointForBackup，成功则包内只带主库
  assert.strictEqual(dbManager.checkpointForBackup(slug, null, false), true,
    '明文库的 checkpointForBackup 应成功')
  assert.strictEqual(fs.existsSync(walFile()) ? fs.statSync(walFile()).size : 0, 0,
    'checkpoint(TRUNCATE) 后 WAL 应清空，尾页已并入主库')

  // 模拟「包内只包含主库」：把主库单独拷到新位置、不带任何 -wal/-shm
  const snapshot = path.join(DATA_DIR, 'snapshot-only-db.db')
  fs.copyFileSync(dbFile(), snapshot)
  assert.ok(!fs.existsSync(snapshot + '-wal'), '快照不应带 WAL 侧车')

  const reader = new Database(snapshot)
  try {
    const row = reader.prepare('SELECT 姓名 AS name FROM students WHERE id = 9101').get()
    assert.ok(row, '只拷主库也必须读到刚写入的那行——否则恢复后会静默丢数据（N2-01）')
    assert.strictEqual(row.name, mark)
  } finally {
    reader.close()
  }
})

test('② checkpoint 失败退回三件套时，恢复侧落位并回放 WAL，最近提交不丢', () => {
  // 造一个「主库 + 带尾页的 -wal」源包。源库必须是完整 schema 的真库
  // （恢复后 initSchema 要在其上做迁移，空壳库会因缺列失败），所以另建一个
  // 完整账号库，常开写入尾页后不 checkpoint，拿它的 .db + -wal 当源包。
  const srcSlug = dbManager.createTeacher('backup-wal-src', 'hash', 'teacher', false).slug
  dbManager.withDb(srcSlug, () => { dbManager.current().prepare('SELECT 1').get() })
  const backupDb = dbManager.dbFilePath(srcSlug)

  const mark = 'N2-RESTORE-WAL-' + Date.now()
  dbManager.withDb(srcSlug, () => {
    dbManager.current().prepare('INSERT INTO students (id, 姓名) VALUES (?, ?)').run(9201, mark)
  })
  // 保持连接常开、不 checkpoint：行此刻落在 -wal 中
  assert.ok(fs.existsSync(backupDb + '-wal') && fs.statSync(backupDb + '-wal').size > 0,
    '前置：源包的 -wal 应含尾页')

  // 恢复：恢复侧落位 srcWal 并 checkpoint 回放（backup.js:101/114）
  // 注意不能在别处先打开 backupDb 去「偷看」——额外连接退出时会触发 WAL checkpoint，
  // 反而把尾页并回主库，让本测试退化成「只拷主库也能过」。直接把主库+WAL 交给恢复侧。
  dbManager.restoreBundle({
    slug, username: 'backup-wal',
    srcPath: backupDb, srcWal: backupDb + '-wal',
    dbKey: null, encrypted: false,
  })
  dbManager.evictConn(srcSlug, { force: true })

  // 恢复后从现役库读到那行：证明 WAL 尾页被回放而不是被丢弃
  const n = dbManager.withDb(slug, () =>
    dbManager.current().prepare('SELECT 姓名 AS name FROM students WHERE id = 9201').get())
  assert.ok(n, '带 -wal 的包恢复后必须读到 WAL 里的那行——否则最近提交静默丢失（N2-01）')
  assert.strictEqual(n.name, mark)
})
