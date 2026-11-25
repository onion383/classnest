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
const { abs, read } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadMutated } = require('#testjs/units/_mechanism.cjs')

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-lock-'))
process.on('exit', () => { try { fs.rmSync(WORK, { recursive: true, force: true }) } catch (_) {} })

// 行为用例要 require worker.scan.js，它顶层依赖 dbManager；dbManager 在构造期要求主密钥。
// 这里只 require 不打开任何库，给一个测试值即可（真实密钥语义不在本文件范围）。
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'classnest-unit-test-master-key-0001'
process.env.DATA_DIR = process.env.DATA_DIR || WORK

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

test('变异反证：真模块去掉 lockDb 后，恢复流程不再通知子进程', () => {
  const workerPath = require.resolve(abs('student-backend/scanWorker.js'))
  const saved = require.cache[workerPath]
  const locked = []
  require.cache[workerPath] = {
    id: workerPath, filename: workerPath, loaded: true,
    exports: { lockDb: (slug) => locked.push(slug) },
  }
  const args = { slug: '@aaaaaaaaaaaa', username: 'u', data: 'not-a-db', encrypted: false }
  try {
    const real = require(abs(RESTORE))
    try { real.restoreBundle(args) } catch (_) { /* 无效包会在后面被拒，不影响 lock 调用 */ }
    assert.deepEqual(locked, [args.slug], '基线必须先通知子进程')

    locked.length = 0
    // N1-28：变异真实模块后调它的真函数，不再只改本地源码串再跑正则。
    const mutated = loadMutated(RESTORE, (s) => {
      const out = s.replace("try { require('../scanWorker').lockDb(slug); } catch (_) { /* best-effort: 子进程未启动 */ }", '/* MUTATED */')
      if (out === s) throw new Error('变异没匹配到 lockDb 调用')
      return out
    })
    try { mutated.restoreBundle(args) } catch (_) { /* 同上 */ }
    assert.deepEqual(locked, [], '守卫失效：覆盖库文件前不再通知扫描子进程')
  } finally {
    if (saved) require.cache[workerPath] = saved
    else delete require.cache[workerPath]
  }
})

// 行为层（T07-05）：上面三条只能证明「主进程发了 lock 消息」，
// 证明不了「子进程收到后真的关连接、丢钥匙」。这里直接执行 worker 的真实清理函数。
test('行为：子进程收到 lock 后关闭该库连接、丢钥匙、发干净批次、清作用域', () => {
  const { applyLock } = require(abs('student-backend/worker.scan.js'))
  let closed = 0
  const connA = { close: () => { closed++ } }
  const connBroken = { close: () => { throw new Error('bad handle') } }
  const openConns = new Map([['slug-a', connA], ['slug-b', connBroken]])
  const keyCache = new Map([['slug-a', 'key-a'], ['slug-b', 'key-b']])
  const flushed = []
  const thumbReport = { flushAll: () => flushed.push('flush') }
  const scoped = []
  const slugScopes = { clearAllForSlug: (s) => scoped.push(s) }

  applyLock('slug-a', { openConns, keyCache, thumbReport, slugScopes })

  assert.equal(closed, 1, '必须关闭该库连接')
  assert.ok(!openConns.has('slug-a'), '连接表要删掉该 slug')
  assert.ok(openConns.has('slug-b'), '不得影响其它库的连接')
  assert.ok(!keyCache.has('slug-a'), '隐私钥匙必须丢弃')
  assert.ok(keyCache.has('slug-b'), '其它库的钥匙不受影响')
  assert.deepEqual(flushed, ['flush'], '必须把残留缩略图索引发干净（按各自 slug）')
  assert.deepEqual(scoped, ['slug-a'], '必须清该库的扫描作用域')

  // 连接 close 抛错时仍要继续丢钥匙（不能让坏句柄把锁死流程卡住）
  assert.doesNotThrow(() => applyLock('slug-b', { openConns, keyCache, thumbReport, slugScopes }), 'close 抛错不应中断清理')
  assert.ok(!keyCache.has('slug-b'), 'close 抛错后钥匙仍必须丢弃')
  assert.ok(!openConns.has('slug-b'), 'close 抛错后连接表仍必须删掉该 slug')
})
