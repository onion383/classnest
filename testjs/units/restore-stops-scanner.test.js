// =========================================================================
// restore-stops-scanner.test.js —— 整库恢复前停扫描子进程连接（2-6 / #12）
//
// 原缺陷：整库恢复 / 快照还原只 evictConn(slug, force) 关主进程连接，
// 扫描子进程另持一份连接没关 → 覆盖 .db 期间子进程可能读写旧库/写 -wal，
// 造成 SQLITE_BUSY 或新旧数据交错。修法：覆盖前先 scanWorker.lockDb(slug)
// 通知子进程关连接丢钥匙（与登出同口径），再 evictConn。
//
// 判据：
//   ① 接线：restoreBundle 与 snapshot/restore 都在 evictConn 前调 lockDb(slug)；
//   ② 依赖方向：backup.js 用惰性 require（不能顶层引入 scanWorker，循环依赖）；
//   ③ 变异反证：把 lockDb 调用去掉后判据失败。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const RESTORE = 'student-backend/dbManager/dbManager.backup.js'
const SNAPSHOT = 'student-backend/routes/ai/ai.dataRoutes.js'

function lockBeforeEvict(src) {
  const lock = src.indexOf('.lockDb(slug)')
  const evict = src.indexOf('evictConn(slug, { force: true })')
  assert.ok(lock >= 0, '缺少 lockDb(slug) 调用')
  assert.ok(evict >= 0, '缺少 evictConn 强制关连接')
  return lock < evict
}

test('restoreBundle：lockDb 在 evictConn 之前（先停子进程再覆盖文件）', () => {
  const src = read(RESTORE)
  assert.ok(lockBeforeEvict(src), 'lockDb 必须在 evictConn 之前')
  // 惰性 require：不能顶层 require scanWorker（它顶层依赖 dbManager，会循环）
  assert.match(src, /require\('\.\.\/scanWorker'\)\.lockDb\(slug\)/, '应惰性 require scanWorker')
  const top = src.slice(0, src.indexOf('function restoreBundle'))
  assert.doesNotMatch(top, /require\(['"]\.\.\/scanWorker['"]\)/, 'scanWorker 不能在模块顶层引入')
})

test('snapshot/restore：lockDb 在 evictConn 之前', () => {
  const src = read(SNAPSHOT)
  // 只取 snapshot/restore handler 段，避免全文其它 lockDb 干扰
  const parts = src.split(/(?=router\.(?:get|post|put|patch|delete)\s*\()/)
  const h = parts.find((p) => p.startsWith("router.post('/snapshot/restore'"))
  assert.ok(h, '未找到 snapshot/restore handler')
  assert.ok(lockBeforeEvict(h), 'lockDb 必须在 evictConn 之前')
  assert.match(h, /require\('\.\.\/\.\.\/scanWorker'\)\.lockDb\(slug\)/, '应惰性 require scanWorker')
})

test('变异反证：去掉 lockDb 后判据必须失败', () => {
  const src = read(RESTORE)
  const mutated = src.replace(/\s*try \{ require\('\.\.\/scanWorker'\)\.lockDb\(slug\); \} catch \(_\) \{[^\n]*\}/, '')
  assert.ok(mutated !== src, '变异没匹配到 lockDb 调用')
  assert.throws(() => lockBeforeEvict(mutated), /缺少 lockDb/, '变异后判据应判失败')
})
