// =========================================================================
// mcp-cross-class-scope.test.js —— MCP 令牌跨班越权 + 限流原子性（2-10 / #8）
//
// 原缺陷①：revoke/remove 只按短 id 在全局令牌表查找，不限制当前 slug，
// A 班持有者看到/猜到 B 班令牌 id 就能撤销或删除它（getPlain 早已带 slug 限定）。
// 修法：revoke(id, slug) / remove(id, slug) 匹配时限定 slug；路由传 slug(req)。
// 原缺陷②：rateLimit check 与 consume 之间隔着 await，并发请求都通过 check 再各自
// consume，突破 perMin。修法：read/search 用同步 checkAndConsume 原子预占。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createBackendDb, ROOT, backendRequire } = require('#testjs/units/_db-express-fixture.cjs')

const BACKEND = abs('student-backend')

test('令牌跨班：revoke/remove 带 slug 时只影响本班令牌', (t) => {
  const fx = createBackendDb({ label: 'mcp-cross-class' })
  const dbManager = backendRequire(path.join(BACKEND, 'dbManager/dbManager.js'))
  const origWithDb = dbManager.withDb
  const origFind = dbManager.registryFindBySlug
  dbManager.withDb = (_slug, fn) => fn()
  dbManager.registryFindBySlug = (slug) => (slug === 'class-a' || slug === 'class-b' ? { slug } : null)
  const tokenStore = backendRequire(path.join(BACKEND, 'services/mcpTokenStore.js'))
  const FILE = tokenStore.FILE
  t.after(() => {
    dbManager.registryFindBySlug = origFind
    dbManager.withDb = origWithDb
    try { fs.rmSync(FILE, { force: true }) } catch (_) {}
    fx.close()
  })
  try { fs.rmSync(FILE, { force: true }) } catch (_) {}

  const a = tokenStore.create({ slug: 'class-a', label: 'A的令牌' })
  const b = tokenStore.create({ slug: 'class-b', label: 'B的令牌' })

  // 带 B 的 slug 去撤销 A 的 id → 应失败（返回 false），A 仍有效
  assert.equal(tokenStore.revoke(a.id, 'class-b'), false, 'B 班不能撤销 A 班令牌')
  assert.equal(tokenStore.getPlain(a.id, 'class-a'), a.token, 'A 令牌仍有效、明文还在')
  // 带正确 slug 才能撤销
  assert.equal(tokenStore.revoke(a.id, 'class-a'), true)
  assert.equal(tokenStore.getPlain(a.id, 'class-a'), null, 'A 令牌已撤销')
  assert.equal(tokenStore.getPlain(b.id, 'class-b'), b.token, 'B 令牌不受影响')

  // remove 同样带 slug：撤销 B 后用 A 的 slug 去删 B 应失败
  tokenStore.revoke(b.id, 'class-b')
  assert.equal(tokenStore.remove(b.id, 'class-a'), false, 'A 班不能删 B 班令牌')
  assert.equal(tokenStore.list().some((x) => x.id === b.id), true, 'B 令牌记录还在')
  assert.equal(tokenStore.remove(b.id, 'class-b'), true)
  assert.equal(tokenStore.list().some((x) => x.id === b.id), false, 'B 班自己的才能删')
})

test('限流原子：checkAndConsume 同步预占，并发都过 check 也不会超额', () => {
  const rate = backendRequire(path.join(BACKEND, 'services/mcpRateLimit.js'))
  rate._resetForTest()
  rate._setLimitsForTest({ read: { perMin: 1, label: '读取' } })

  // 模拟原来的「分离」写法：两次 check 都在 consume 之前 → 都看到 count=0 → 都放行
  const now = Date.now()
  const c1 = rate.check('class-a', 'read', now)
  const c2 = rate.check('class-a', 'read', now)
  rate.consume('class-a', 'read', now)
  rate.consume('class-a', 'read', now)
  assert.equal(c1.ok, true); assert.equal(c2.ok, true, '分离写法两发都通过 —— 这正是原 bug')

  // 原子写法：第二次应被拒
  rate._resetForTest()
  rate._setLimitsForTest({ read: { perMin: 1, label: '读取' } })
  const a1 = rate.checkAndConsume('class-a', 'read', now)
  const a2 = rate.checkAndConsume('class-a', 'read', now)
  assert.equal(a1.ok, true)
  assert.equal(a2.ok, false, '原子预占后第二个被拒，perMin 不超')
  // 不同班互不影响
  const b1 = rate.checkAndConsume('class-b', 'read', now)
  assert.equal(b1.ok, true, '分桶按 slug，B 班独立额度')
  rate._resetForTest()
})

test('接线：路由 revoke/remove 传 slug，mcp.server read/search 用原子闸门', () => {
  const routes = fs.readFileSync(path.join(BACKEND, 'routes/ai/mcp/mcp.routes.js'), 'utf8')
  assert.match(routes, /tokenStore\.revoke\(req\.params\.id, slug\(req\)\)/, 'revoke 必须传 slug')
  assert.match(routes, /tokenStore\.remove\(req\.params\.id, slug\(req\)\)/, 'remove 必须传 slug')

  const server = fs.readFileSync(path.join(BACKEND, 'routes/ai/mcp/mcp.server.js'), 'utf8')
  assert.match(server, /meta\.rate !== 'write'[\s\S]{0,120}checkAndConsume/, 'read/search 走原子闸门')
  assert.doesNotMatch(server, /mcpRateLimit\.consume\(slug, meta\.rate\)/, '不能再按 meta.rate 泛化 consume')
})
