// =========================================================================
// single-flight.test.js —— 启动单飞守卫（P0-5 / X1-01 / N4-01）
//
// 事故：startBackend() 是 fire-and-forget，而 fork 前的 await 主密钥是异步的。
// 两次近似同时的调用各跑一遍 → fork 出两个后端抢 3000 端口 → EADDRINUSE 无限重试 →
// 启动卡死/白屏。修法是把启动收敛成单飞任务。
//
// 判据：
//   ① 并发调用只执行一次，且拿到同一个 Promise
//   ② 任务结束后能重新启动（不能永久锁死 —— 那会把「重试」按钮变成摆设）
//   ③ 任务失败时两个调用都要失败，且失败后仍可重试
//   ④ 任务体里的**同步副作用**在调用当场就发生（不能延后一个微任务）
//   ⑤ 接线：main.backend 真的用上了它，而不是又写回普通函数
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const ROOT = path.resolve(__dirname, '../..')
const { createSingleFlight } = require(path.join(ROOT, 'electron/main/main.single-flight'))

const tick = () => new Promise((r) => setImmediate(r))

test('并发调用只跑一次，返回同一个 Promise', async () => {
  let runs = 0
  let release
  const gate = new Promise((r) => { release = r })
  const run = createSingleFlight(async () => {
    runs++
    await gate
    return 'done'
  })

  const a = run()
  const b = run()
  assert.equal(a, b, '在途期间必须复用同一个 Promise（否则调用方会各等一份、各 fork 一个）')
  release()
  assert.equal(await a, 'done')
  assert.equal(await b, 'done')
  assert.equal(runs, 1, '任务体只能执行一次')
})

test('结束后可以重新启动（重试按钮不能变摆设）', async () => {
  let runs = 0
  const run = createSingleFlight(async () => { runs++; return runs })
  assert.equal(await run(), 1)
  assert.equal(await run(), 2, '第一次结束后必须能再跑')
  assert.equal(await run(), 3)
})

test('任务失败：两个调用都失败；失败后仍可重试成功', async () => {
  let attempt = 0
  const run = createSingleFlight(async () => {
    attempt++
    if (attempt === 1) throw new Error('fork 失败')
    return 'ok'
  })

  const a = run()
  const b = run()
  await assert.rejects(a, /fork 失败/)
  await assert.rejects(b, /fork 失败/)
  // 失败不能把守卫永久锁住
  assert.equal(await run(), 'ok')
})

test('同步副作用在调用当场发生（不能延后一个微任务）', () => {
  const seen = []
  const run = createSingleFlight(async () => { seen.push('task'); await tick() })
  run()
  // 调用返回后、事件循环推进前，任务体的同步部分必须已执行：
  // startBackend 里「置 backendReady=false + 广播 backend-resetting」就是这个位置。
  assert.deepEqual(seen, ['task'], '同步副作用被推迟了 → 渲染层会先看到旧的就绪状态')
})

test('参数原样透传', async () => {
  const seen = []
  const run = createSingleFlight(async (...args) => { seen.push(args); return args.length })
  assert.equal(await run(1, 'x', null), 3)
  assert.deepEqual(seen, [[1, 'x', null]])
})

test('接线：main.backend 的启动入口就是单飞任务', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron/main/main.backend.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.match(src, /createSingleFlight\(async \(\) => \{/, 'startBackend 必须由 createSingleFlight 包裹')
  assert.ok(!/^function startBackend\(/m.test(src), '不能退回普通函数（那就是这次要修的并发双 fork）')
  // 10 处调用点保持 fire-and-forget，签名不必改
  assert.ok((src.match(/\bstartBackend\(\)/g) || []).length >= 2, '既有调用点应保持 startBackend() 形态')
})
