// =========================================================================
// client-cache.test.js —— 「只认最后一次」守卫 与 用户级缓存注册表
//
// 这两个是审查 v4 这批（6 条竞态 + 3 条换号残留）的共用底座，本身没有任何依赖，
// 直接 import 即可。要保证的是它们的语义不被后来人改歪：
//   · latestOnly：后发先至时，旧结果必须被丢弃（只允许最新令牌写状态）
//   · userScopedCache：登出时每个登记者都被调用；某个登记者抛错不能拖垮别人
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const load = (rel) => import(pathToFileURL(path.join(__dirname, '../../student-frontend/src/utils', rel)).href)

test('latestOnly：后发的请求让先发的失效', async () => {
  const { createLatest } = await load('latestOnly.js')
  const g = createLatest()

  const first = g.begin()
  assert.equal(g.isCurrent(first), true, '刚发起的请求应有效')

  const second = g.begin()
  assert.equal(g.isCurrent(first), false, '又发了一次，旧令牌必须失效（否则旧响应会覆盖新数据）')
  assert.equal(g.isCurrent(second), true)
})

test('latestOnly：invalidate 之后所有在途请求都失效', async () => {
  const { createLatest } = await load('latestOnly.js')
  const g = createLatest()
  const t = g.begin()
  g.invalidate()
  assert.equal(g.isCurrent(t), false)
})

test('latestOnly：多个守卫互不干扰', async () => {
  const { createLatest } = await load('latestOnly.js')
  const a = createLatest()
  const b = createLatest()
  const ta = a.begin()
  b.begin()
  assert.equal(a.isCurrent(ta), true, '另一张表的请求不该让这张表的守卫失效')
})

test('userScopedCache：登出时每个登记者都被调用', async () => {
  const mod = await load('userScopedCache.js')
  let a = 0
  let b = 0
  mod.registerUserScopedReset(() => { a++ })
  mod.registerUserScopedReset(() => { b++ })
  mod.resetUserScopedCaches()
  assert.equal(a, 1)
  assert.equal(b, 1)
})

test('userScopedCache：某个清理函数抛错不影响其它清理', async () => {
  const mod = await load('userScopedCache.js')
  let ok = 0
  mod.registerUserScopedReset(() => { throw new Error('boom') })
  mod.registerUserScopedReset(() => { ok++ })
  assert.doesNotThrow(() => mod.resetUserScopedCaches(), '清理失败不能反过来让登出失败')
  assert.equal(ok, 1, '后面的清理仍要执行')
})

test('userScopedCache：重复登记同一个函数只算一次', async () => {
  const mod = await load('userScopedCache.js')
  let n = 0
  const fn = () => { n++ }
  mod.registerUserScopedReset(fn)
  mod.registerUserScopedReset(fn)
  mod.resetUserScopedCaches()
  assert.equal(n, 1, '重复登记（如 HMR 重跑模块）不该让清理执行多次')
})

test('userScopedCache：业务流程上真的挂上了登出链', async () => {
  // 这条是行为级兜底：authStorage.clearAuth() 必须调到注册表，
  // 否则 semesterStart / dashboard 那几处登记形同虚设。
  const fs = require('node:fs')
  const code = fs.readFileSync(path.join(__dirname, '../../student-frontend/src/utils/authStorage.js'), 'utf8')
  assert.ok(/clearAuth[\s\S]*?resetUserScopedCaches\(\)/.test(code), 'clearAuth 里没有 resetUserScopedCaches()')
  // 两个已知缓存模块必须登记，漏一个就等于换号仍看到上一个人的数据
  for (const f of ['semesterStart.js', '../composables/useDashboardData.js']) {
    const p = path.join(__dirname, '../../student-frontend/src/utils', f)
    const src = fs.readFileSync(p, 'utf8')
    assert.ok(/registerUserScopedReset\(/.test(src), `${f} 没有登记用户级缓存清理`)
  }
})

test('V5-004：换号代次守卫接在两个缓存模块上', async () => {
  const fs = require('node:fs')
  const read = (f) => fs.readFileSync(path.join(__dirname, '../../student-frontend/src', f), 'utf8')

  const cache = read('utils/userScopedCache.js')
  assert.ok(/generation \+= 1/.test(cache), 'reset 必须先递增代次')
  assert.ok(/export function userScopedGeneration/.test(cache), '必须对外暴露当前代次')

  // dashboard：发起时取代次、响应后比对、旧响应丢弃并重拉；pending 只在仍是自己时清理
  const dash = read('composables/useDashboardData.js')
  assert.ok(/const gen = userScopedGeneration\(\)/.test(dash), '发请求前必须取代次')
  assert.ok(/if \(gen !== userScopedGeneration\(\)\)/.test(dash), '响应写缓存前必须比对代次')
  assert.ok(/if \(pending === req\) pending = null/.test(dash), '旧请求收尾不能把新请求的 pending 抹掉')

  // semesterStart：同理
  const sem = read('utils/semesterStart.js')
  assert.ok(/const gen = userScopedGeneration\(\)/.test(sem))
  assert.ok(/if \(gen !== userScopedGeneration\(\)\)/.test(sem))
  assert.ok(/if \(inflight === req\) inflight = null/.test(sem))
})

test('V5-007：桌面挂件两类加载都挂上「只认最后一次」守卫', async () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(__dirname, '../../student-frontend/src/subwindows/desktop-widget/DesktopWidget.vue'), 'utf8')
  assert.ok(/import \{ createLatest \}/.test(src), '必须复用 latestOnly 守卫')
  // 两类请求各自一个实例：共用一个会让负载较轻的那类把另一类作废
  assert.ok(/loadAllGuard = createLatest\(\)/.test(src))
  assert.ok(/loadAppsGuard = createLatest\(\)/.test(src))
  // loadAll：await 后、写 ref 前判断；finally 只让最新一轮收尾
  assert.ok(/if \(!loadAllGuard\.isCurrent\(token\)\) return/.test(src))
  // A5-02 之后 finally 里除了收尾还要处理「在途期间来过变更通知」的补拉，
  // 展开成块了；守卫本身（只让最新一轮收尾）必须还在。
  assert.ok(/if \(loadAllGuard\.isCurrent\(token\)\) \{\s*loadingAll = false/.test(src))
  // loadApps：成功与失败两条路径都要判断（旧请求的 401 不能写「未登录」）
  assert.ok(/if \(!loadAppsGuard\.isCurrent\(token\)\) return false/.test(src))
  // 换号时必须作废在途请求，并放开 loadingAll 让新请求立刻发出
  assert.ok(/loadAllGuard\.invalidate\(\)[\s\S]{0,200}loadingAll = false/.test(src))
  assert.ok(/loadAppsGuard\.invalidate\(\)/.test(src))
})
