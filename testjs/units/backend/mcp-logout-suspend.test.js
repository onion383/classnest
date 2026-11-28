// =========================================================================
// mcp-logout-suspend.test.js —— V9-I-22：登出后 MCP 令牌暂时失效、登录自动恢复
//
// 根因：MCP token 是独立长效凭据，verify 只看 revoked_at/expired，不跟 Web 会话走。
// 用户从网页登出后，外部客户端（Claude Desktop / Cursor）仍能用旧 token 读数据。
// 修法：不改 revoke（永久），加 suspended_at 时间戳——登出挂起、登录清除。
//
// 判据：真库跑 create → suspend → verify 拒绝 → resume → verify 通过；
// 变异反证：去掉 verify 里的 suspended 判断，判据必须红。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createBackendDb, backendRequire } = require('#testjs/units/_db-express-fixture.cjs')

const BACKEND = abs('student-backend')

test.after(() => { if (setup.ctx) setup.ctx.close() })

function setup(label) {
  // 单例：多个用例共享同一 fixture（fixture 是进程级 stub，重复建会互相踩 conn）
  if (setup.ctx) return setup.ctx
  const fx = createBackendDb({ label })
  const dbManager = backendRequire(path.join(BACKEND, 'dbManager/dbManager.js'))
  const origWithDb = dbManager.withDb
  const origFindBySlug = dbManager.registryFindBySlug
  const origFindAll = dbManager.registryFindAllByUsername
  dbManager.withDb = (_slug, fn) => fn()
  dbManager.registryFindBySlug = (slug) => (slug === 'class-a' || slug === 'class-b' ? { slug } : null)
  dbManager.registryFindAllByUsername = (u) => (u === 'alice'
    ? [{ slug: 'class-a' }, { slug: 'class-b' }]
    : [])
  const tokenStore = backendRequire(path.join(BACKEND, 'services/mcpTokenStore.js'))
  try { fs.rmSync(tokenStore.FILE, { force: true }) } catch (_) {}
  setup.ctx = {
    fx, tokenStore, dbManager, origs: { origWithDb, origFindBySlug, origFindAll },
    reset() { try { fs.rmSync(tokenStore.FILE, { force: true }) } catch (_) {} },
    close() {
      dbManager.withDb = origWithDb
      dbManager.registryFindBySlug = origFindBySlug
      dbManager.registryFindAllByUsername = origFindAll
      try { fs.rmSync(tokenStore.FILE, { force: true }) } catch (_) {}
      fx.close()
    },
  }
  return setup.ctx
}

test('登出挂起 → verify 拒绝 → 登录恢复 → verify 通过（真跑）', (t) => {
  const ctx = setup('mcp-suspend')
  ctx.reset()
  const { tokenStore } = ctx
  const created = tokenStore.create({ slug: 'class-a', label: 'claude' })
  assert.equal(tokenStore.verify(created.token).ok, true, '创建后应可用')

  const suspended = tokenStore.setSuspendedByAccount('alice', true)
  assert.equal(suspended, 1, 'alice 在 class-a 有一枚令牌')
  const denied = tokenStore.verify(created.token)
  assert.equal(denied.ok, false, '登出后必须拒绝')
  assert.equal(denied.suspended, true, '要能区分「挂起」与「撤销/过期」')
  assert.equal(tokenStore.list()[0].suspended, true, '列表要显示挂起态')

  const resumed = tokenStore.setSuspendedByAccount('alice', false)
  assert.equal(resumed, 1)
  assert.equal(tokenStore.verify(created.token).ok, true, '重新登录必须自动恢复')
  assert.equal(tokenStore.list()[0].suspended, false)
})

test('挂起只作用本人班级；不标 revoked（不是永久删除）', (t) => {
  const ctx = setup('mcp-suspend')
  ctx.reset()
  const { tokenStore } = ctx
  tokenStore.create({ slug: 'class-a', label: 'a' })
  tokenStore.setSuspendedByAccount('nobody', true)
  assert.equal(tokenStore.list()[0].suspended, false, '别的账号不能挂起我的令牌')

  tokenStore.setSuspendedByAccount('alice', true)
  const item = JSON.parse(fs.readFileSync(tokenStore.FILE, 'utf8'))[0]
  assert.ok(item.suspended_at, '要写挂起时间戳')
  assert.equal(item.revoked_at, null, '绝不能标成永久撤销')
})

test('变异反证：verify 不检查 suspended_at 时判据必须红', (t) => {
  const ctx = setup('mcp-suspend')
  ctx.reset()
  const { tokenStore } = ctx
  const created = tokenStore.create({ slug: 'class-a', label: 'm' })
  tokenStore.setSuspendedByAccount('alice', true)

  // 真编译去掉挂起判断的模块
  const { loadMutated } = require('#testjs/units/_mechanism.cjs')
  const REL = 'student-backend/services/mcpTokenStore.js'
  const mutated = loadMutated(REL, (s) => s.replace(
    '  if (item.suspended_at) return { ok: false, suspended: true };',
    '  /* mutated: 不检查挂起 */'
  ))
  assert.equal(mutated.verify(created.token).ok, true,
    '变异后挂起令牌仍可用 → 原判据确实在防这件事')
})
