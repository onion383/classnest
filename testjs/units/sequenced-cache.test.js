// =========================================================================
// sequenced-cache.test.js —— 带账号代次的进程内缓存（P0-6 / X2-04）
//
// 事故：AiGridPreview 的 `_studentMap` 是模块级缓存，登出时清掉了，但**在途请求**
// 回来后又把上一个账号的 id→姓名 写回去 → B 账号在预览里看到 A 的学生姓名。
// 「登出时清缓存」和「响应回来」是两个时刻，只清不挡必漏。
//
// 判据：① TTL 语义不变 ② 失败不缓存 ③ 换号时在途响应既不能写缓存、也不能交给调用方
//       ④ 组件真的接上了（否则工具再对也没人用 —— 假绿）
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../..')
const CACHE = pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/sequencedCache.js')).href
const COMPONENT = path.join(ROOT, 'student-frontend/src/components/tables/AiGridPreview.vue')

const load = () => import(CACHE)
const tick = () => new Promise((r) => setImmediate(r))

test('TTL 内复用：load 只调一次', async () => {
  const { createSequencedCache } = await load()
  let calls = 0
  const c = createSequencedCache({ load: async () => ++calls, ttl: 10_000 })
  assert.equal(await c.get(), 1)
  assert.equal(await c.get(), 1, 'TTL 内必须命中缓存')
  assert.equal(calls, 1)
})

test('TTL 过期后重新加载', async () => {
  const { createSequencedCache } = await load()
  let calls = 0
  let now = 0
  const c = createSequencedCache({ load: async () => ++calls, ttl: 1000, now: () => now })
  assert.equal(await c.get(), 1)
  now = 500
  assert.equal(await c.get(), 1)
  now = 1500
  assert.equal(await c.get(), 2, '过期后必须重新拉')
  assert.equal(calls, 2)
})

test('load 返回 null（接口失败）不写缓存，下次仍会重试', async () => {
  const { createSequencedCache } = await load()
  let calls = 0
  const c = createSequencedCache({ load: async () => { calls++; return calls === 1 ? null : 'ok' } })
  assert.equal(await c.get(), null)
  assert.equal(c.has(), false, '失败结果绝不能缓存，否则之后永远空白')
  assert.equal(await c.get(), 'ok')
})

test('load 抛错：错误透传给调用方，且不写缓存', async () => {
  const { createSequencedCache } = await load()
  let calls = 0
  const c = createSequencedCache({
    load: async () => { calls++; if (calls === 1) throw new Error('网络断了'); return 'ok' },
  })
  await assert.rejects(c.get(), /网络断了/)
  assert.equal(await c.get(), 'ok', '抛错后仍能重试成功')
})

// —— 核心：换号时在途响应的归宿 ——
test('换号（invalidate）发生在 await 期间：旧响应不写缓存、也不交给调用方', async () => {
  const { createSequencedCache } = await load()
  let releaseA
  const gateA = new Promise((r) => { releaseA = r })
  const c = createSequencedCache({
    load: async () => { await gateA; return 'A 账号的学生' },
  })

  const pending = c.get()      // ① A 账号发起
  c.invalidate()               // ② 期间登出/换号
  releaseA()                   // ③ A 的响应回来了
  assert.equal(await pending, null, '过期代次的数据不能交给调用方（那就是泄漏）')
  assert.equal(c.has(), false, '更不能写进缓存 —— B 下一次预览会读到 A 的姓名')

  // ④ B 账号重新拉，拿到的是自己的数据
  const c2 = createSequencedCache({ load: async () => 'B 账号的学生' })
  assert.equal(await c2.get(), 'B 账号的学生')
})

test('换号后不能命中上一个账号的缓存值（invalidate 必须连值一起清）', async () => {
  const { createSequencedCache } = await load()
  let payload = 'A 账号的学生'
  const c = createSequencedCache({ load: async () => payload, ttl: 10_000 })
  assert.equal(await c.get(), 'A 账号的学生')
  payload = 'B 账号的学生'
  c.invalidate()
  assert.equal(await c.get(), 'B 账号的学生', 'TTL 还没到也必须重拉 —— 只作废在途、不清值照样泄漏')
})

test('clear 只清值不动代次：在途请求仍然有效（改名/增删场景）', async () => {
  const { createSequencedCache } = await load()
  let release
  const gate = new Promise((r) => { release = r })
  const c = createSequencedCache({ load: async () => { await gate; return 'fresh' } })
  const pending = c.get()
  c.clear()                    // 学生改名后让下次重拉，但这次在途的响应仍是好的
  release()
  assert.equal(await pending, 'fresh', 'clear 不该把同代次的有效响应也作废')
})

test('并发两次 get：只有最后一次的响应被采纳（旧的那次返回 null）', async () => {
  const { createSequencedCache } = await load()
  let n = 0
  const c = createSequencedCache({
    load: async () => { n++; const mine = n; await tick(); return `v${mine}` },
  })
  const [a, b] = await Promise.all([c.get(), c.get()])
  assert.equal(a, null, '第一次已经被第二次顶掉')
  assert.equal(b, 'v2')
  assert.equal(await c.get(), 'v2', '缓存里是最后一次的值')
})

// —— 接线：组件真的用上了 ——
test('接线：AiGridPreview 用 createSequencedCache，且换号走 invalidate', () => {
  const src = fs.readFileSync(COMPONENT, 'utf8')
  const code = src.replace(/<!--[\s\S]*?-->/g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.match(code, /createSequencedCache\(\{\s*load:\s*loadStudentList/, '学生名缓存必须由它托管')
  assert.match(code, /registerUserScopedReset\(\(\)\s*=>\s*studentMapCache\.invalidate\(\)\)/, '换号必须调 invalidate（清值 + 作废在途）')
  assert.ok(!/_studentMap\s*=/.test(code), '不能退回手工赋值模块级缓存 —— 那就是本次泄漏的写法')
})
