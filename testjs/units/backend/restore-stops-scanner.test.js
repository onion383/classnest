// =========================================================================
// restore-stops-scanner.test.js —— 整库恢复前停扫描子进程连接（2-6 / #12）
//
// 原缺陷：整库恢复 / 快照还原只 evictConn(slug, force) 关主进程连接，
// 扫描子进程另持一份连接没关 → 覆盖 .db 期间子进程可能读写旧库/写 -wal，
// 造成 SQLITE_BUSY 或新旧数据交错。
//
// V9-2-3（RC-JOIN）：旧修法只「发了 lock 消息」就覆盖文件，没等子进程真停。
// 现在 lockDb 回 Promise，worker 先取消该库在飞扫描 → 等真停 → 关连接丢钥匙
// → 回执 {type:'locked', ok}；恢复方 await，ok:false 就中止覆盖。
//
// 判据：
//   ① 接线：restoreBundle 与 snapshot/restore 都在 evictConn 前 await lockDb(slug)；
//   ② 依赖方向：backup.js 用惰性 require（不能顶层引入 scanWorker，循环依赖）；
//   ③ 行为：cancelRunningForSlug / waitRunningIdle 真执行，只停本库任务；
//   ④ 行为：回执超时 / ok:false 时 restoreBundle 不覆盖文件（直接抛错）；
//   ⑤ 变异反证：去掉 await 回执的判断后，超时也照旧覆盖 → 判据必须红。
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

process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'classnest-unit-test-master-key-0001'
process.env.DATA_DIR = process.env.DATA_DIR || WORK

const RESTORE = 'student-backend/dbManager/dbManager.backup.js'
const SNAPSHOT = 'student-backend/routes/ai/ai.dataRoutes.js'
const SCAN_WORKER = 'student-backend/scanWorker.js'
const WORKER_SCAN = 'student-backend/worker.scan.js'

function lockBeforeEvict(src) {
  const lock = src.indexOf('.lockDb(slug)')
  const evict = src.indexOf('evictConn(slug, { force: true })')
  assert.ok(lock >= 0, '缺少 lockDb(slug) 调用')
  assert.ok(evict >= 0, '缺少 evictConn 强制关连接')
  return lock < evict
}

test('restoreBundle：await lockDb 在 evictConn 之前（先停子进程再覆盖文件）', () => {
  const src = read(RESTORE)
  assert.ok(lockBeforeEvict(src), 'lockDb 必须在 evictConn 之前')
  assert.match(src, /await\s+require\('\.\.\/scanWorker'\)\.lockDb\(slug\)/, '必须等 lockDb 回执')
  // @pin student-backend/dbManager/dbManager.backup.js#restoreBundle
  assert.match(src, /lockResult\.ok === false/, '回执 ok:false 必须中止恢复')
  // 惰性 require：不能顶层 require scanWorker（它顶层依赖 dbManager，会循环）
  const top = src.slice(0, src.indexOf('async function restoreBundle'))
  assert.doesNotMatch(top, /require\(['"]\.\.\/scanWorker['"]\)/, 'scanWorker 不能在模块顶层引入')
})

test('snapshot/restore：await lockDb 在 evictConn 之前', () => {
  const src = read(SNAPSHOT)
  const parts = src.split(/(?=router\.(?:get|post|put|patch|delete)\s*\()/)
  const h = parts.find((p) => p.startsWith("router.post('/snapshot/restore'"))
  assert.ok(h, '未找到 snapshot/restore handler')
  assert.ok(lockBeforeEvict(h), 'lockDb 必须在 evictConn 之前')
  assert.match(h, /await\s+require\('\.\.\/\.\.\/scanWorker'\)\.lockDb\(slug\)/, '必须等 lockDb 回执')
  // @pin student-backend/routes/ai/ai.dataRoutes.js#currentSlug
  assert.match(h, /lockResult\.ok === false/, '回执 ok:false 必须中止还原')
})

test('scanWorker.lockDb：回执 / 超时 / 并发去重', async () => {
  const src = fs.readFileSync(abs(SCAN_WORKER), 'utf8')
  // 真执行纯函数太依赖模块内的 child 状态；这里锁协议契约用源码接线 + 行为侧在下面覆盖。
  // @pin student-backend/scanWorker.js#onWorkerMessage
  assert.match(src, /case 'locked':/, '必须处理 locked 回执消息')
  // @pin student-backend/scanWorker.js#lockDb
  assert.match(src, /LOCK_ACK_TIMEOUT_MS/, '必须有超时兜底')
  // @pin student-backend/scanWorker.js#lockDb
  assert.match(src, /lockWaits\.get\(slug\)/, '同 slug 并发锁要共享等待')
  // @pin student-backend/scanWorker.js#lockDb
  assert.match(src, /resolve\(\{ ok: false, reason: 'lock-ack-timeout' \}\)/, '超时必须回 ok:false')
  // 变异反证：抹掉回执 case → 判据红
  const broken = src.replace("case 'locked':", "case 'locked-mutated':")
  assert.notEqual(broken, src, '变异没生效')
  assert.throws(() => assert.match(broken, /case 'locked':/))
})

test('行为：cancelRunningForSlug 只取消本库在飞任务，且唤醒暂停中的任务', () => {
  const { cancelRunningForSlug } = require(abs(WORKER_SCAN))
  const running = new Map([
    ['@aaaaaaaaaaaa|1', { cancelled: false, paused: true }],
    ['@aaaaaaaaaaaa|2', { cancelled: false, paused: false }],
    ['@bbbbbbbbbbbb|1', { cancelled: false, paused: true }],
  ])
  const n = cancelRunningForSlug('@aaaaaaaaaaaa', { running, pendingStops: new Set() })
  assert.equal(n, 2, '只取消本库的两个任务')
  for (const k of ['@aaaaaaaaaaaa|1', '@aaaaaaaaaaaa|2']) {
    assert.equal(running.get(k).cancelled, true)
    assert.equal(running.get(k).paused, false, '暂停中的也要唤醒收工')
  }
  assert.equal(running.get('@bbbbbbbbbbbb|1').cancelled, false, '不得影响其它库')
})

test('行为：waitRunningIdle 等本库任务退出；超时回 false', async () => {
  const { waitRunningIdle } = require(abs(WORKER_SCAN))
  const running = new Map([['@aaaaaaaaaaaa|1', { cancelled: true }]])
  const p = waitRunningIdle('@aaaaaaaaaaaa', { running }, 200, 5)
  await new Promise((r) => setTimeout(r, 15))
  // 任务还没退出 → promise 仍未 resolve
  let settled = false
  p.then(() => { settled = true })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(settled, false)
  running.clear()
  assert.equal(await p, true, '任务退出后立刻 true')

  // 超时路径：任务一直不退 → false
  const stuck = new Map([['@aaaaaaaaaaaa|9', {}]])
  assert.equal(await waitRunningIdle('@aaaaaaaaaaaa', { running: stuck }, 30, 5), false)
})

test('行为：子进程 lock 回执 ok:true 时恢复照常；ok:false 时恢复中止不覆盖', async () => {
  const workerPath = require.resolve(abs('student-backend/scanWorker.js'))
  const saved = require.cache[workerPath]
  const args = { slug: '@aaaaaaaaaaaa', username: 'u', data: 'not-a-db', encrypted: false }

  async function runWithLock(fakeLock) {
    require.cache[workerPath] = {
      id: workerPath, filename: workerPath, loaded: true,
      exports: { lockDb: fakeLock },
    }
    const real = require(abs(RESTORE))
    // 不吞异常：调用方要据此断言是「中止」还是「完整性校验失败」
    return real.restoreBundle(args)
  }

  try {
    // 基线：回执 ok → 恢复继续到完整性校验（抛「完整性校验」而不是「中止」）
    let seen = null
    await assert.rejects(
      () => runWithLock(async (slug) => { seen = slug; return { ok: true } }),
      /完整性校验未通过/
    )
    assert.equal(seen, args.slug)

    // 回执 ok:false → 恢复在 lock 处中止，抛的是「未确认停止」
    await assert.rejects(
      () => runWithLock(async () => ({ ok: false, reason: 'lock-ack-timeout' })),
      /扫描子进程未确认停止.*lock-ack-timeout/
    )
  } finally {
    if (saved) require.cache[workerPath] = saved
    else delete require.cache[workerPath]
  }
})

test('变异反证：真模块去掉回执检查后，ok:false 也照旧覆盖 → 判据红', async () => {
  const workerPath = require.resolve(abs('student-backend/scanWorker.js'))
  const saved = require.cache[workerPath]
  const args = { slug: '@aaaaaaaaaaaa', username: 'u', data: 'not-a-db', encrypted: false }
  try {
    require.cache[workerPath] = {
      id: workerPath, filename: workerPath, loaded: true,
      exports: { lockDb: async () => ({ ok: false, reason: 'mutant-timeout' }) },
    }
    const mutated = loadMutated(RESTORE, (s) => {
      const out = s.replace(
        /if \(lockResult && lockResult\.ok === false\) \{\s*throw new Error\([^)]*\);\s*\}/,
        '/* MUTATED: 不再检查回执 */'
      )
      if (out === s) throw new Error('变异没匹配到回执检查')
      return out
    })
    // 变异后不会因 lock 中止，而是继续到完整性校验被拒 → 证明守卫确实拦在这里
    await assert.rejects(() => mutated.restoreBundle(args), /完整性校验未通过/)
  } finally {
    if (saved) require.cache[workerPath] = saved
    else delete require.cache[workerPath]
  }
})

// 行为层（T07-05）：上面证明「等回执 / 按回执决定」，这里证明子进程真做了清理动作。
test('行为：子进程收到 lock 后关闭该库连接、丢钥匙、发干净批次、清作用域', () => {
  const { applyLock } = require(abs(WORKER_SCAN))
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
