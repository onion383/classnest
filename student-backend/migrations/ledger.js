// ==================== 迁移账本（schema_migrations） ====================
//
// 一行一个「已应用」的版本。表建在**每个库自己**里（账号索引库、每个班级库各一份），
// 因为它们各自的 user_version 是独立的。
//
// 为什么不只靠 user_version：
//   · user_version 只说「到第几版」，不说「跑过哪些」——跳版升级后无从判断中间补了哪几条；
//   · 也不说「当时那份脚本长什么样」——半年后脚本被改过，账本里的 checksum 是唯一线索。
//
// 约定：
//   · version 是**整数**（1、2、3…），因为 SQLite 的 user_version 只能存 32 位整数，
//     文件名里的 0002 只是给人看的顺序，落库时取数字部分；
//   · 账本表由 ensure() 建，随时可重复调用；
//   · 本模块只碰账本，不认识任何业务表。
const crypto = require('crypto')

const TABLE = 'schema_migrations'

function ensure(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    applied_at TEXT NOT NULL DEFAULT '',
    checksum TEXT NOT NULL DEFAULT ''
  )`)
}

// 库头里的结构版本。没有 user_version 时读到 0（新建库、或从未升级过的老库）。
function readVersion(db) {
  return Number(db.pragma('user_version', { simple: true })) || 0
}

// 写库头版本。必须在事务内调用：user_version 存在第 1 页的头部，
// 事务回滚时一起回滚，不会出现「版本前进了、表没改成」。
function writeVersion(db, version) {
  const n = Number(version)
  if (!Number.isInteger(n) || n < 0) throw new Error(`版本号必须是非负整数：${version}`)
  db.pragma(`user_version = ${n}`)
}

function listApplied(db) {
  ensure(db)
  return db.prepare(`SELECT version, name, applied_at, checksum FROM ${TABLE} ORDER BY version`).all()
}

// 记一条。调用方负责包事务（与写入、user_version 同边界）。
function record(db, step, checksum) {
  ensure(db)
  db.prepare(`INSERT OR REPLACE INTO ${TABLE} (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)`)
    .run(Number(step.version), String(step.name || ''), new Date().toISOString(), String(checksum || ''))
}

// 一步的指纹：**整个模块**一起算，不是只算 data 函数。
// 只算 data 会漏掉「改了 structure 声明但 data 没动」——那正是最容易被顺手改的一处。
function checksumOf(step) {
  const parts = [
    String(step.version),
    String(step.name || ''),
    JSON.stringify(step.structure || null),
    String(step.data || ''),
  ]
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

// 校验「已应用过的版本，代码还和当时一致」。
// 返回问题数组（不抛）：调用方决定是硬失败还是只记日志。
// 三种问题：
//   · checksum 不一致 —— 有人改了已发布的迁移脚本（线上老库和新代码会错位）；
//   · 账本有、代码里没有 —— 脚本被删了，但库已经跑过（无法解释库的现状）；
//   · 代码里有、账本没有，但 user_version 已经越过它 —— 账本与库头不一致（手工改过库）。
function verify(db, steps) {
  const byVersion = new Map((steps || []).map((s) => [Number(s.version), s]))
  const problems = []
  for (const row of listApplied(db)) {
    const step = byVersion.get(Number(row.version))
    if (!step) {
      problems.push({ version: row.version, reason: '账本里有这个版本，代码里已经没有对应脚本' })
      continue
    }
    const want = checksumOf(step)
    if (row.checksum && row.checksum !== want) {
      problems.push({ version: row.version, reason: `脚本被改过（账本 ${row.checksum.slice(0, 8)}…，当前 ${want.slice(0, 8)}…）` })
    }
  }
  return problems
}

module.exports = {
  TABLE,
  ensure,
  readVersion,
  writeVersion,
  listApplied,
  record,
  checksumOf,
  verify,
}
