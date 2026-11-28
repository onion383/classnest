// =========================================================================
// scan-worker-lock-ack.test.js —— 锁库回执的真 IPC 往返（V9 · 2-3）
//
// 为什么需要真起子进程：restore-stops-scanner.test.js 用 stub 验「恢复方等回执」，
// worker.scan 的纯函数验「收到 lock 会取消在飞任务并关连接」，但两者拼起来
// 「主进程发的 lock 消息真能收到 locked 回执」没人验 —— 这正是 #12 的事故面
// （消息发了但子进程没处理）。这里真 fork worker.scan.js，发 lock，等回执。
//
// 判据：
//   ① ready → lock → locked 往返成功，ok:true；
//   ② 非法 slug 回 ok:false（子进程独立信任边界）；
//   ③ 变异反证：把 worker 的 locked 回执改成不发，判据必须超时失败。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fork } = require('node:child_process')
// 子进程整树清理走项目统一工具（裸 child.kill() 会留孙进程，pattern-sweep 会拦）
const { killTree } = require('../../../testjs/tools/killTree.cjs')

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-ack-'))
process.on('exit', () => { try { fs.rmSync(WORK, { recursive: true, force: true }) } catch (_) {} })
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'classnest-unit-test-master-key-0001'
process.env.DATA_DIR = WORK

const WORKER = abs('student-backend/worker.scan.js')

// 真执行产品模块里的纯函数（不是只读源码）：确认 worker 侧导出的取消/等待逻辑就是 IPC
// 处理器调用的那一份，避免「fork 的文件」和「测试里断言的函数」各写一份分叉。
const { cancelRunningForSlug, waitRunningIdle, applyLock } = require(abs('student-backend/worker.scan.js'))

// 真起一个 worker，等 ready 后发一条消息，收集消息直到匹配到 type 或超时。
function withWorker(sendMsg, wantType, timeoutMs = 4000, workerPath = WORKER) {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], { env: { ...process.env }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const got = []
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      killTree(child)
      reject(new Error(`超时未收到 ${wantType}；收到：${JSON.stringify(got)}`))
    }, timeoutMs)
    child.on('message', (msg) => {
      got.push(msg)
      if (msg && msg.type === 'ready') {
        try { child.send(sendMsg) } catch (e) { cleanup(); reject(e) }
        return
      }
      if (msg && msg.type === wantType) {
        cleanup()
        resolve({ msg, got })
      }
    })
    child.on('error', (e) => { cleanup(); reject(e) })
    function cleanup() {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.send({ cmd: 'shutdown' }) } catch (_) {}
      // 给 shutdown 一点时间退出；兜底整树清理（裸 kill 会留孙进程）
      setTimeout(() => killTree(child), 100).unref()
    }
  })
}

test('产品函数：worker 导出的取消/等待/清理确实可执行（非纯读源码）', async () => {
  const running = new Map([['@aaaaaaaaaaaa|1', { cancelled: false, paused: true }]])
  assert.equal(cancelRunningForSlug('@aaaaaaaaaaaa', { running, pendingStops: new Set() }), 1)
  assert.equal(running.get('@aaaaaaaaaaaa|1').cancelled, true)
  assert.equal(running.get('@aaaaaaaaaaaa|1').paused, false)
  assert.equal(await waitRunningIdle('@aaaaaaaaaaaa', { running }, 50, 5), false, '任务未退出 → 超时 false')
  running.clear()
  assert.equal(await waitRunningIdle('@aaaaaaaaaaaa', { running }, 50, 5), true)
  // applyLock 真跑：关连接 + 丢钥匙，坏句柄不中断
  const openConns = new Map([['@aaaaaaaaaaaa', { close: () => {} }]])
  const keyCache = new Map([['@aaaaaaaaaaaa', 'k']])
  applyLock('@aaaaaaaaaaaa', { openConns, keyCache, thumbReport: { flushAll() {} }, slugScopes: { clearAllForSlug() {} } })
  assert.equal(openConns.size, 0)
  assert.equal(keyCache.size, 0)
})

test('V10-K05-02：锁库等待把补图需求算进去（排队 + 在途都不能提前回 idle）', async () => {
  const running = new Map()
  const queue = [{ slug: '@bbbbbbbbbbbb', id: 1 }]
  assert.equal(
    await waitRunningIdle('@bbbbbbbbbbbb', { running, demandQueue: queue, isDemandBusy: () => false }, 40, 5),
    false, '排队补图未清，锁库不能提前回执'
  )
  assert.equal(
    await waitRunningIdle('@bbbbbbbbbbbb', { running, demandQueue: [], isDemandBusy: () => true }, 40, 5),
    false, '在途补图未收工，锁库不能提前回执'
  )
  assert.equal(
    await waitRunningIdle('@bbbbbbbbbbbb', { running, demandQueue: [], isDemandBusy: () => false }, 40, 5),
    true, '都清空后应真回 idle'
  )
  assert.equal(
    await waitRunningIdle('@bbbbbbbbbbbb', { running, demandQueue: [{ slug: '@cccccccccccc', id: 2 }], isDemandBusy: () => false }, 40, 5),
    true, '跨库补图与本库锁无关'
  )
})

test('真 IPC：lock → locked 回执 ok:true（子进程确实处理了消息）', async () => {
  const { msg } = await withWorker({ cmd: 'lock', slug: '@aaaaaaaaaaaa' }, 'locked')
  assert.equal(msg.type, 'locked')
  assert.equal(msg.slug, '@aaaaaaaaaaaa')
  assert.equal(msg.ok, true, '没有在飞任务时锁库必须成功')
})

test('真 IPC：非法 slug 回 ok:false（子进程不信任入参）', async () => {
  const { msg } = await withWorker({ cmd: 'lock', slug: '../escape' }, 'locked')
  assert.equal(msg.ok, false)
  assert.match(msg.reason, /非法/)
})

test('变异反证：worker 不发 locked 回执时，等待方必须超时失败', async () => {
  const src = fs.readFileSync(WORKER, 'utf8')
  const anchor = "send({ type: 'locked', slug, ok: idle });"
  // @pin student-backend/worker.scan.js#waitRunningIdle
  assert.ok(src.includes(anchor), '找不到 locked 回执锚点')
  const broken = src.replace(anchor, '/* MUTATED: 不发回执 */')
  assert.notEqual(broken, src)

  // 写到 services/ 旁，相对 require 才解析得到；跑完删掉。
  const tmp = abs(`student-backend/_worker-lock-mutant-${process.pid}.js`)
  fs.writeFileSync(tmp, broken)
  try {
    await assert.rejects(
      () => withWorker({ cmd: 'lock', slug: '@aaaaaaaaaaaa' }, 'locked', 1500, tmp),
      /超时未收到 locked/
    )
  } finally {
    fs.rmSync(tmp, { force: true })
  }
})

test('变异反证：抹掉 locked 回执处理后，主进程锁等待必须走超时 ok:false', () => {
  const src = fs.readFileSync(abs('student-backend/scanWorker.js'), 'utf8')
  const broken = src.replace("case 'locked':", "case 'locked-mutated':")
  assert.notEqual(broken, src, '变异没生效')
  assert.throws(() => assert.match(broken, /case 'locked':/))
  // 真实现里超时分支必须回 ok:false
  // @pin student-backend/scanWorker.js#lockDb
  assert.match(src, /resolve\(\{ ok: false, reason: 'lock-ack-timeout' \}\)/)
})
