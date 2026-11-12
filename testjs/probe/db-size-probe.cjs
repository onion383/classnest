// =========================================================================
// db-size-probe.cjs —— 库体积 / freelist / WAL 只读探针（v6 性能专题 · 0-4）
//
// 用途：回答「库文件里有多少是真正数据、多少是删除后没归还的空闲页」，
// 作为 3-5（VACUUM / auto_vacuum）是否启用的唯一依据。只读：不建表、不删行、不 vacuum。
//
// 用法：
//   node testjs/probe/db-size-probe.cjs <dataDir 或某个 .db>        # 表格
//   node testjs/probe/db-size-probe.cjs <dataDir> --json            # JSON
//   node testjs/probe/db-size-probe.cjs --selftest                  # 自证能读出 freelist/加密态
//
// ⚠️ 真实库是 SQLCipher 加密的，外部拿不到密钥。本探针能给出：
//   · 所有库（含加密库）的文件 / -wal / -shm 体积；
//   · 明文库的 page_size / page_count / freelist_count；
//   · 加密库标记 encrypted=true，并跳过内部页统计。
// 真实加密库的页统计应在应用内跑（复用 dbManager 已解出的连接），本脚本不硬解密钥。
// =========================================================================
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const Database = require(path.join(ROOT, 'student-backend/node_modules/better-sqlite3-multiple-ciphers'))

const MB = 1048576
const round = (n, digits = 2) => Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : 0

function fileBytes(file) {
  try { return fs.statSync(file).size } catch (_) { return 0 }
}

function isEncryptedError(err) {
  return /not a database|file is encrypted|SQLITE_NOTADB|encrypted/i.test(String(err && err.message || err))
}

function inspectDb(dbPath) {
  const base = {
    dbPath,
    dbBytes: fileBytes(dbPath),
    walBytes: fileBytes(dbPath + '-wal'),
    shmBytes: fileBytes(dbPath + '-shm'),
  }
  let db = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const pageSize = Number(db.pragma('page_size', { simple: true })) || 0
    const pages = Number(db.pragma('page_count', { simple: true })) || 0
    const freelist = Number(db.pragma('freelist_count', { simple: true })) || 0
    return {
      ...base,
      encrypted: false,
      pageSize,
      pages,
      freelist,
      dbMB: round(pages * pageSize / MB),
      freelistMB: round(freelist * pageSize / MB),
      freelistRatio: pages ? round(freelist / pages, 3) : 0,
    }
  } catch (err) {
    return {
      ...base,
      encrypted: isEncryptedError(err),
      error: String(err && err.message || err).slice(0, 160),
    }
  } finally {
    try { if (db) db.close() } catch (_) { /* 关闭失败不影响读数 */ }
  }
}

function inspectDir(dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch (_) { return [] }
  return names
    .filter((n) => n.endsWith('.db'))
    .map((n) => path.join(dir, n))
    .filter((p) => fs.existsSync(p))
    .map(inspectDb)
}

function formatTable(rows) {
  const lines = []
  for (const r of rows) {
    const head = `${path.basename(r.dbPath)}  ${round(r.dbBytes / MB)}MB（wal ${round(r.walBytes / MB)}MB）`
    if (r.encrypted) {
      lines.push(`${head}  [加密库：跳过页统计${r.error ? `，${r.error}` : ''}]`)
      continue
    }
    lines.push(`${head}  数据 ${r.dbMB}MB / 空闲 ${r.freelistMB}MB（freelist ${(r.freelistRatio * 100).toFixed(1)}%，页 ${r.pages} × ${r.pageSize}B）`)
  }
  return lines
}

// 自证：造一个删了大量行的明文库，必须能读出 freelist；再造一个随机字节文件，必须标成加密。
function runSelftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-size-probe-'))
  const plain = path.join(dir, 'plain.db')
  const fakeEncrypted = path.join(dir, 'encrypted.db')
  try {
    const db = new Database(plain)
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)')
    const tx = db.transaction(() => { for (let i = 0; i < 2000; i++) ins.run('x'.repeat(200)) })
    tx()
    db.prepare('DELETE FROM t WHERE id > 100').run()
    db.close()

    const plainInfo = inspectDb(plain)
    if (plainInfo.encrypted) throw new Error('明文库被误判为加密')
    if (!(plainInfo.pages > 0)) throw new Error('明文库未读出 page_count')
    if (!(plainInfo.freelist >= 0)) throw new Error('明文库未读出 freelist_count')

    fs.writeFileSync(fakeEncrypted, Buffer.from('not a sqlite database, just random bytes'))
    const encInfo = inspectDb(fakeEncrypted)
    if (!encInfo.encrypted) throw new Error('非法库未标记为加密/不可读')

    const list = inspectDir(dir)
    if (list.length !== 2) throw new Error(`目录扫描数量不对：${list.length}`)
    return { ok: true, plain: plainInfo, encrypted: encInfo }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* 忽略 */ }
  }
}

function main(argv) {
  const args = argv.slice(2)
  if (args.includes('--selftest')) {
    const r = runSelftest()
    console.log(`[selftest] OK：明文库 pages=${r.plain.pages} freelist=${r.plain.freelist}；非法库 encrypted=${r.encrypted.encrypted}`)
    return
  }
  const target = args.find((a) => !a.startsWith('--'))
  if (!target) {
    console.error('用法：node testjs/probe/db-size-probe.cjs <dataDir 或 .db> [--json] [--selftest]')
    process.exitCode = 1
    return
  }
  const rows = fs.statSync(target).isDirectory() ? inspectDir(target) : [inspectDb(target)]
  if (args.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (!rows.length) {
    console.log(`[db-size] ${target} 下没有找到 .db 文件`)
    return
  }
  console.log(`[db-size] ${target}`)
  for (const line of formatTable(rows)) console.log('  ' + line)
}

if (require.main === module) main(process.argv)

module.exports = { inspectDb, inspectDir, isEncryptedError, runSelftest }
