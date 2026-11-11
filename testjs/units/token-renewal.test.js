// =========================================================================
// token-renewal.test.js —— 滑动续期的「换代即作废」（X2-08）
//
// 事故：A 账号的续期响应在「已登出并登录成 B」之后才回来，一落盘就把 B 的凭据
// 覆盖成 A 的 —— B 看着登录着，实际每个请求都带 A 的 token。
// 响应本身完全合法，唯一的线索是「发请求时是哪一代」。
//
// 判据：① 同代 → 正常落盘（别把续期修死） ② 换代 → 两个凭据都不落、回调不触发
//       ③ 忘传代次 → 立刻抛错（静默停续期 = 30 天后用户被踢，比崩更难查）
//       ④ 两种 headers 形态都读得到
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../..')
const RENEWAL = pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/tokenRenewal.js')).href
const SCOPED = pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/userScopedCache.js')).href

const loadRenewal = () => import(RENEWAL)
const loadScoped = () => import(SCOPED)

function fakeHeaders(map) {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (n) => lower.get(String(n).toLowerCase()) ?? null }
}

test('同一代：token 与媒体凭据都落盘，回调触发一次', async () => {
  const { absorbRenewalTokens } = await loadRenewal()
  const { userScopedGeneration } = await loadScoped()
  const writes = []
  const res = absorbRenewalTokens(
    fakeHeaders({ 'x-renewed-token': 'tok-2', 'x-renewed-media': 'media-2' }),
    {
      generation: userScopedGeneration(),
      setToken: (t) => writes.push(['token', t]),
      storeMediaToken: (m) => writes.push(['media', m]),
      onTokenRenewed: (t) => writes.push(['cb', t]),
    },
  )
  assert.equal(res.applied, true)
  assert.deepEqual(writes, [['token', 'tok-2'], ['cb', 'tok-2'], ['media', 'media-2']])
})

test('换代（期间登出/换号）：两个凭据都不落盘，回调不触发', async () => {
  const { absorbRenewalTokens } = await loadRenewal()
  const { userScopedGeneration, resetUserScopedCaches } = await loadScoped()
  const genAtSend = userScopedGeneration()   // ① A 发请求
  resetUserScopedCaches()                    // ② 期间换号（代次 +1）
  const writes = []
  const res = absorbRenewalTokens(
    fakeHeaders({ 'x-renewed-token': 'A 的续期', 'x-renewed-media': 'A 的媒体凭据' }),
    {
      generation: genAtSend,                 // ③ A 的响应回来
      setToken: (t) => writes.push(t),
      storeMediaToken: (m) => writes.push(m),
      onTokenRenewed: () => writes.push('cb'),
    },
  )
  assert.equal(res.applied, false)
  assert.equal(res.reason, 'stale-generation')
  assert.deepEqual(writes, [], '任何写入都会把 B 的凭据覆盖成 A 的')
})

test('忘传代次直接抛错（不能静默停掉续期）', async () => {
  const { absorbRenewalTokens } = await loadRenewal()
  const headers = fakeHeaders({ 'x-renewed-token': 'x' })
  assert.throws(() => absorbRenewalTokens(headers, { setToken: () => {} }), /必须带 generation/)
  assert.throws(() => absorbRenewalTokens(headers, { generation: undefined, setToken: () => {} }), /必须带 generation/)
})

test('只有媒体凭据：只落媒体，不动登录 token', async () => {
  const { absorbRenewalTokens } = await loadRenewal()
  const { userScopedGeneration } = await loadScoped()
  const writes = []
  absorbRenewalTokens(fakeHeaders({ 'x-renewed-media': 'm' }), {
    generation: userScopedGeneration(),
    setToken: () => writes.push('token'),
    storeMediaToken: (m) => writes.push(['media', m]),
  })
  assert.deepEqual(writes, [['media', 'm']])
})

test('响应头是裸对象（大小写不保证）也能读到', async () => {
  const { absorbRenewalTokens } = await loadRenewal()
  const { userScopedGeneration } = await loadScoped()
  const got = []
  absorbRenewalTokens({ 'X-Renewed-Token': 'tok' }, {
    generation: userScopedGeneration(),
    setToken: (t) => got.push(t),
  })
  assert.deepEqual(got, ['tok'])
})

test('没有续期头：什么也不做（不报错、不写盘）', async () => {
  const { absorbRenewalTokens } = await loadRenewal()
  const { userScopedGeneration } = await loadScoped()
  const writes = []
  const res = absorbRenewalTokens(fakeHeaders({ 'content-type': 'application/json' }), {
    generation: userScopedGeneration(),
    setToken: (t) => writes.push(t),
  })
  assert.equal(res.applied, false)
  assert.equal(res.reason, 'nothing-renewed')
  assert.deepEqual(writes, [])
})

// —— 接线：两条 HTTP 路径都必须把「发请求时的代次」带进来 ——
test('接线：apiFetch 与 axios 拦截器都传了发请求时的代次', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const api = read('student-frontend/src/utils/apiUrl.js')
  assert.match(api, /const authGeneration = userScopedGeneration\(\)/, 'apiFetch 必须在发请求前取代次')
  assert.match(api, /absorbRenewal\(res\.headers, \{ generation: authGeneration \}\)/, '续期必须带上它')
  assert.ok(!/absorbRenewal\(res\.headers\)\s*$/.test(api), '不能退回无代次调用')

  const client = read('student-frontend/src/utils/httpClient.js')
  assert.match(client, /config\.__authGeneration = userScopedGeneration\(\)/, 'axios 请求侧要记下代次')
  assert.match(client, /generation: res\.config\?\.__authGeneration/, '响应侧要把它传回去')
})
