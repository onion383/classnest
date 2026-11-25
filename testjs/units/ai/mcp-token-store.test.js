// =========================================================================
// mcp-token-store.test.js —— U4：令牌明文可复制（明文存加密班级库，core 只留索引）
//
// 为什么要专门测：mcp-server.test.js 把 tokenStore.verify stub 掉了，测不到真实
// create/getPlain/revoke。这里用真实 tokenStore + 夹具内存库：
//   · create 后 core/.mcp-tokens.json 只有 hash，不含明文（文件落盘检查）
//   · 班级库 mcp_tokens 表有明文副本，getPlain 能读回
//   · 刷新页面后仍可复制（getPlain 是独立入口，不依赖「创建那一次」）
//   · 撤销后 getPlain 返回 null，库里明文也被删
//   · 跨 slug 拿明文被拒（A 班 id 读不到 B 班令牌）
//   · verify 口径不变：仍是 sha256(hash) 比对，明文不进鉴权路径
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createBackendDb, ROOT, backendRequire } = require('#testjs/units/_db-express-fixture.cjs')

const BACKEND = abs('student-backend')

test('方向B U4：令牌明文可复制（core 只留索引 + 班级库存明文）', (t) => {
  // 夹具必须先建：tokenStore 顶层用 dbManager.coreDir（受 DATA_DIR 影响）算 FILE，
  // 且 require('../db') 要拿到夹具替换后的 Proxy。
  const fx = createBackendDb({ label: 'mcp-token-store' })

  // create/getPlain/revoke 里用 dbManager.withDb(slug, ...) 进班级库写明文。
  // 本测试不挂路由，夹具不会自动 stub withDb；手动 stub 成直接执行，让 db Proxy 命中内存库。
  const dbManager = backendRequire(path.join(BACKEND, 'dbManager/dbManager.js'))
  const origWithDb = dbManager.withDb
  dbManager.withDb = (_slug, fn) => fn()
  // create 要查 registryFindBySlug；补一个「slug 存在」的返回。
  const origFind = dbManager.registryFindBySlug
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

  // 造两个班级库里的 mcp_tokens 表结构（夹具 initSchema 已建，这里确认）
  assert.ok(fx.conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_tokens'").get(), 'mcp_tokens 表必须存在')

  const created = tokenStore.create({ slug: 'class-a', label: 'Claude' })
  assert.ok(created.token && created.token.startsWith('mcp_'), 'create 返回明文')
  assert.ok(created.id, 'create 返回短 id')

  // 反证点 1：core 索引文件里绝不能出现明文
  const coreText = fs.readFileSync(FILE, 'utf8')
  assert.ok(!coreText.includes(created.token), 'core 文件不许含明文令牌')
  assert.ok(coreText.includes(tokenStore.hashToken(created.token)), 'core 文件存的是 hash')
  assert.ok(!/token_plain/.test(coreText), 'core 索引不含明文字段名')

  // 反证点 2：明文副本落在班级库，getPlain 能读回（模拟刷新页面后重新复制）
  const row = fx.conn.prepare('SELECT token_plain, slug FROM mcp_tokens WHERE hash = ?').get(tokenStore.hashToken(created.token))
  assert.ok(row, '班级库 mcp_tokens 必须有明文副本')
  assert.equal(row.token_plain, created.token)
  assert.equal(row.slug, 'class-a')
  assert.equal(tokenStore.getPlain(created.id, 'class-a'), created.token, 'getPlain 读回同一明文')

  // 反证点 3：跨 slug 拿不到（A 班 id 不能从 B 班复制出来）
  assert.equal(tokenStore.getPlain(created.id, 'class-b'), null, '跨库复制被拒')

  // 反证点 4：verify 口径不变——明文可验、hash 比对，且不因明文副本改变
  assert.equal(tokenStore.verify(created.token).ok, true, '明文能验过')
  assert.equal(tokenStore.verify(created.token).slug, 'class-a')
  assert.equal(tokenStore.verify('mcp_' + '0'.repeat(32)).ok, false, '错误令牌验不过')

  // 反证点 5：撤销后不能再复制，库里明文也被清掉
  assert.equal(tokenStore.revoke(created.id), true)
  assert.equal(tokenStore.getPlain(created.id, 'class-a'), null, '撤销后不返回明文')
  assert.equal(fx.conn.prepare('SELECT token_plain FROM mcp_tokens WHERE hash = ?').get(tokenStore.hashToken(created.token)), undefined, '撤销后删库明文')
  assert.equal(tokenStore.verify(created.token).ok, false, '撤销后验不过')

  // ---- 有效期：与上面共用夹具/模块（backendRequire 有缓存，换夹具会拿到已关闭的库） ----
  // 1. 带有效期创建：core 索引和班级库明文行都记下 expires_at，list 也对外暴露
  const expCreated = tokenStore.create({ slug: 'class-a', label: '短期', validDays: 1 })
  assert.ok(expCreated.expires_at, 'create 返回过期时间')
  const expCore = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const expItem = expCore.find((x) => x.hash === tokenStore.hashToken(expCreated.token))
  assert.equal(expItem.expires_at, expCreated.expires_at, 'core 索引写入 expires_at')
  const expRow = fx.conn.prepare('SELECT expires_at FROM mcp_tokens WHERE hash = ?').get(expItem.hash)
  assert.equal(expRow.expires_at, expCreated.expires_at, '班级库明文行也写入 expires_at')
  assert.ok(tokenStore.list().some((t) => t.expires_at === expCreated.expires_at), 'list 暴露有效期')
  assert.equal(tokenStore.verify(expCreated.token).ok, true, '未过期能验过')

  // 2. 变异反证：把 core 索引里的过期时间改到过去，verify 和 getPlain 都必须拒绝
  expItem.expires_at = new Date(Date.now() - 1000).toISOString()
  fs.writeFileSync(FILE, JSON.stringify(expCore, null, 2), { encoding: 'utf8', mode: 0o600 })
  assert.equal(tokenStore.verify(expCreated.token).ok, false, '过期令牌验不过')
  assert.equal(tokenStore.getPlain(expCreated.id, 'class-a'), null, '过期令牌不给复制明文')

  // 3. 老令牌没有 expires_at → 永远不过期（向后兼容）
  const legacy = tokenStore.create({ slug: 'class-a', label: '老令牌' })
  assert.equal(legacy.expires_at, null, '不带 validDays 时不过期')
  assert.equal(tokenStore.verify(legacy.token).ok, true, '无有效期字段仍能验过')

  // 4. 白名单外的天数兜底成不过期，别让乱填的值变成「立刻过期」
  const bad = tokenStore.create({ slug: 'class-a', validDays: 999 })
  assert.equal(bad.expires_at, null, '非五档天数按不过期处理')

  // ---- 去除记录 remove：与 revoke 的区别是「整条抹掉，list 不再显示」 ----
  // 反证点 1：仍有效的令牌不能 remove（防误删后失去追溯），必须先 revoke
  assert.equal(tokenStore.remove(bad.id), false, '有效令牌拒绝去除记录')
  assert.ok(tokenStore.list().some((t) => t.id === bad.id), '被拒后记录仍在')

  // 反证点 2：revoke 只标记、留条目（界面据此显示「已失效」）
  const doomed = tokenStore.create({ slug: 'class-a', label: '待去除' })
  assert.equal(tokenStore.revoke(doomed.id), true, '先撤销')
  assert.ok(tokenStore.list().some((t) => t.id === doomed.id && t.revoked), 'revoke 后条目仍在、标记 revoked')

  // 反证点 3：remove 后 core 文件里整条消失、list 查不到、verify 也失败
  assert.equal(tokenStore.remove(doomed.id), true, '失效令牌可去除')
  assert.ok(!tokenStore.list().some((t) => t.id === doomed.id), 'remove 后 list 不再显示')
  const afterRemove = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  assert.ok(!afterRemove.some((x) => x.hash.startsWith(doomed.id)), 'core 文件里整条记录被抹掉')
  assert.equal(tokenStore.verify(doomed.token).ok, false, '去除后验不过')

  // 反证点 4：重复 remove 返回 false（幂等，不误删别人）
  assert.equal(tokenStore.remove(doomed.id), false, '重复去除返回 false')
})

test('方向B U4 源码判据：鉴权只读 core 索引、明文只在 getPlain 经 withDb 读', () => {
  const code = fs.readFileSync(path.join(BACKEND, 'services/mcpTokenStore.js'), 'utf8')
  const verifyBody = code.slice(code.indexOf('function verify('), code.indexOf('function list('))
  // @pin student-backend/services/mcpTokenStore.js#verify
  assert.ok(!/mcp_tokens|token_plain|withDb/.test(verifyBody), 'verify 不碰班级库/明文，保证鉴权路径最快')
  const plainBody = code.slice(code.indexOf('function getPlain('), code.indexOf('function list('))
  // @pin student-backend/services/mcpTokenStore.js#getPlain
  assert.match(plainBody, /withDb/, 'getPlain 经 withDb 进班级库')
  // @pin student-backend/services/mcpTokenStore.js#getPlain
  assert.match(plainBody, /token_plain/, 'getPlain 读明文列')
  // @pin student-backend/services/mcpTokenStore.js#getPlain
  assert.match(plainBody, /item\.slug !== slug/, 'getPlain 校验 slug 一致，防跨库')
})

