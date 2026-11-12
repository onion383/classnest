// =========================================================================
// get-share.test.js —— 通用 GET 在途共享 + 短 TTL（v6 性能专题 · 1-7）
//
// 验收点：
//   ① 同 key 并发只调用一次底层请求，两个调用方拿到同一份响应；
//   ② 成功后 TTL 内复用，过期后重新请求；
//   ③ 换号：旧响应不写缓存、也不交给调用方（reject 成取消错误），且已缓存的值被清掉；
//   ④ 写操作（markDirty）只清缓存、不取消在途；写之后新到的调用方会重新发请求；
//   ⑤ key 判定：只共享普通 GET（写请求 / 二进制 / 取消信号 / __noShare 都不进）；
//   ⑥ 接线：httpClient 装了适配器、登记了换号清理、写成功会 markDirty。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const MODULE = pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/getShare.js')).href
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function makeShare(overrides = {}) {
  const { createGetShare } = await import(MODULE)
  const clock = { t: 1000 }
  let gen = 1
  const share = createGetShare({
    ttl: 500,
    now: () => clock.t,
    generation: () => gen,
    ...overrides,
  })
  return { share, clock, setGen: (g) => { gen = g } }
}

test('同 key 并发只发一次，两个调用方拿到同一份响应', async () => {
  const { share } = await makeShare()
  let calls = 0
  const d = deferred()
  const factory = () => { calls += 1; return d.promise }
  const key = share.keyOf({ method: 'get', url: '/api/students', params: { a: 1 } })
  const p1 = share.run(key, factory)
  const p2 = share.run(key, factory)
  d.resolve({ data: { rows: [1, 2] } })
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(calls, 1, '并发同 key 必须只打一次网络')
  assert.equal(r1, r2, '两个调用方共享同一份响应')
  assert.equal(share.stats().cached, 1)
})

test('TTL 内复用，过期后重新请求', async () => {
  const { share, clock } = await makeShare()
  let calls = 0
  const factory = () => { calls += 1; return Promise.resolve({ data: { n: calls } }) }
  const key = share.keyOf({ method: 'get', url: '/api/ai/config' })
  await share.run(key, factory)
  clock.t += 499
  const again = await share.run(key, factory)
  assert.equal(calls, 1, 'TTL 内应复用')
  assert.deepEqual(again.data, { n: 1 })
  clock.t += 2
  const fresh = await share.run(key, factory)
  assert.equal(calls, 2, 'TTL 过期应重新请求')
  assert.deepEqual(fresh.data, { n: 2 })
})

test('换号：旧响应 reject 成取消错误，不写缓存也不交给调用方', async () => {
  const { share, setGen } = await makeShare()
  const d = deferred()
  const key = share.keyOf({ method: 'get', url: '/api/students' })
  const p = share.run(key, () => d.promise)
  // 换号 = userScopedCache 代次 +1 + 本层 reset
  setGen(2)
  share.reset()
  d.resolve({ data: { secret: '旧账号' } })
  await assert.rejects(p, (e) => e.code === 'ERR_CANCELED' && e.__CANCEL__ === true)
  assert.equal(share.stats().cached, 0, '旧响应不得写缓存')
  assert.equal(share.stats().inflight, 0, '在途表必须一并清掉')
})

test('写操作只清缓存、不取消在途；写之后的新调用重新发请求', async () => {
  const { share, clock } = await makeShare()
  const key = share.keyOf({ method: 'get', url: '/api/students' })
  // 先放一条缓存
  await share.run(key, () => Promise.resolve({ data: 'v1' }))
  assert.equal(share.stats().cached, 1)

  clock.t += 1000 // 让缓存过期，下一次 run 才会真的发请求
  const d = deferred()
  const pOld = share.run(key, () => d.promise)
  share.markDirty() // 模拟写成功
  assert.equal(share.stats().cached, 0, '写成功必须清掉已缓存的值')

  let calls = 0
  const pNew = share.run(key, () => { calls += 1; return Promise.resolve({ data: 'v2' }) })
  assert.equal(calls, 1, '写之后到达的调用方不能复用写之前的在途请求')

  d.resolve({ data: 'v1-late' })
  assert.deepEqual((await pOld).data, 'v1-late', '在途请求本身不能被取消')
  assert.deepEqual((await pNew).data, 'v2')
  assert.equal(share.stats().cached, 1, '迟到的旧响应不得写缓存')
})

test('key 判定：只共享普通 GET', async () => {
  const { share } = await makeShare()
  assert.ok(share.keyOf({ method: 'get', url: '/a' }))
  assert.ok(share.keyOf({ url: '/a' }), '未写 method 时按 GET 处理')
  assert.equal(share.keyOf({ method: 'post', url: '/a' }), null)
  assert.equal(share.keyOf({ method: 'put', url: '/a' }), null)
  assert.equal(share.keyOf({ method: 'get', url: '/a', responseType: 'blob' }), null)
  assert.ok(share.keyOf({ method: 'get', url: '/a', responseType: 'json' }))
  assert.equal(share.keyOf({ method: 'get', url: '/a', __noShare: true }), null)
  assert.equal(share.keyOf({ method: 'get', url: '/a', signal: {} }), null)
  assert.equal(share.keyOf(null), null)

  // 参数顺序不影响 key；参数或 URL 变了就是另一个 key
  const k1 = share.keyOf({ method: 'get', url: '/a', params: { x: 1, y: 2 } })
  const k2 = share.keyOf({ method: 'get', url: '/a', params: { y: 2, x: 1 } })
  assert.equal(k1, k2)
  assert.notEqual(k1, share.keyOf({ method: 'get', url: '/a', params: { x: 2, y: 2 } }))
  assert.notEqual(k1, share.keyOf({ method: 'get', url: '/b', params: { x: 1, y: 2 } }))
  // 不同 baseURL 也不能撞
  assert.notEqual(k1, share.keyOf({ method: 'get', baseURL: 'http://x', url: '/a', params: { x: 1, y: 2 } }))
})

test('缓存条目有上限，超限淘汰最旧', async () => {
  const { share } = await makeShare({ maxEntries: 2 })
  const run = (url) => share.run(share.keyOf({ method: 'get', url }), () => Promise.resolve({ data: url }))
  await run('/a'); await run('/b')
  assert.equal(share.stats().cached, 2)
  await run('/c')
  assert.equal(share.stats().cached, 2, '始终不超过上限')
})

test('接线：httpClient 安装适配器、登记换号清理、写成功 markDirty', () => {
  const src = read('student-frontend/src/utils/httpClient.js')
  assert.match(src, /from '\.\/getShare\.js'/)
  assert.match(src, /registerUserScopedReset\(\(\) => getShare\.reset\(\)\)/)
  assert.match(src, /installSharedGetAdapter\(axios\)/)
  assert.match(src, /getShare\.run\(key, \(\) => native\(config\)\)/)
  assert.match(src, /getShare\.markDirty\(\)/)
  assert.match(src, /__sharedGet/, '重复 setupApiClient 不能重复包裹适配器')
})
