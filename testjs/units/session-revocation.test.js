// =========================================================================
// session-revocation.test.js —— 凭证变更 → 全账号会话失效（A1-16 / N3-04）
//
// 原缺陷：恢复词重置密码后只改 users.password，旧 token 的 sid 仍在全局名单里，
// 其它窗口 30 天内照常读写；sessions 也只有 revoke(sid) 单点出口。
// 更隐蔽的一层：名单是全局 .sessions.json，各账号库 users.id 都可能是 1，
// 只按 userId 吊销会把别的账号一起踢下线 —— 所以账号维度必须是 (userId, dbSlug)。
//
// 行为层用真 sessions + 隔离 dataDir；接线层扫源码，防「只改了底座、路由没接」。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const BACKEND = path.join(ROOT, 'student-backend')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// 隔离 dataDir：必须早于 require dbManager / sessions
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-session-revoke-'))
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'session-revocation-test-key'
process.env.DATA_DIR = DATA_DIR

const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
assert.strictEqual(dbManager.dataDir, DATA_DIR, '隔离目录没生效，测试会写到真实数据目录')

const sessions = require(path.join(BACKEND, 'services', 'sessions'))
const { revokeAccountSessions, rotateAccountSessions } = require(path.join(BACKEND, 'services', 'credentialChange'))

// 按 router.<method>( 切开路由文件，得到一个个 handler 段
function handlersOf(src) {
  const parts = src.split(/(?=router\.(?:get|post|put|patch|delete)\s*\()/)
  return parts.filter((p) => p.startsWith('router.'))
}

// ————————————————————————— 行为层 —————————————————————————

test('create 落 dbSlug：账号维度不能只用 userId', () => {
  const sid = sessions.create(1, '@aaaaaaaaaaaa')
  const rec = sessions.__test_get(sid)
  assert.strictEqual(rec.userId, 1)
  assert.strictEqual(rec.dbSlug, '@aaaaaaaaaaaa', '缺 dbSlug 会让按账号吊销退化成按 userId 误踢')
  assert.strictEqual(sessions.has(sid), true)
})

test('has() 刷新活动时间时不丢 dbSlug', () => {
  const sid = 'touch-keeps-slug'
  sessions.__test_insert(sid, 7, Date.now() - 3 * 60 * 60 * 1000, '@touchslug0001')
  assert.strictEqual(sessions.has(sid), true)
  const rec = sessions.__test_get(sid)
  assert.strictEqual(rec.dbSlug, '@touchslug0001', 'touch 重写记录时把 dbSlug 丢了 = 会话变成无主记录')
  assert.ok(rec.at > Date.now() - 5000)
})

test('核心反证：同 userId=1 的三个账号，只吊销目标 slug 的会话', () => {
  const a1 = 'acct-a-1'; const a2 = 'acct-a-2'
  const b1 = 'acct-b-1'; const c1 = 'acct-c-1'
  sessions.__test_insert(a1, 1, Date.now(), '@acctaaaa0001')
  sessions.__test_insert(a2, 1, Date.now(), '@acctaaaa0001')
  sessions.__test_insert(b1, 1, Date.now(), '@acctbbbb0001')
  sessions.__test_insert(c1, 2, Date.now(), '@acctaaaa0001')

  const n = sessions.revokeAllByUser(1, '@acctaaaa0001')
  assert.strictEqual(n, 2, '只该删 A 账号的两条')
  assert.strictEqual(sessions.has(a1), false)
  assert.strictEqual(sessions.has(a2), false)
  assert.strictEqual(sessions.has(b1), true, 'B 账号也是 userId=1，不能被误踢')
  assert.strictEqual(sessions.has(c1), true, 'userId 不同更不能动')
})

test('升级前的旧记录没有 dbSlug：按 userId 保守纳入，不留旧 token', () => {
  const old = 'legacy-no-slug'
  const other = 'other-account-modern'
  sessions.__test_insert(old, 42, Date.now(), null)
  sessions.__test_insert(other, 42, Date.now(), '@otheracct0001')

  const n = sessions.revokeAllByUser(42, '@legacyacct001')
  assert.strictEqual(n, 1, '旧记录要吊销，但带别的 slug 的新记录不能动')
  assert.strictEqual(sessions.has(old), false)
  assert.strictEqual(sessions.has(other), true)
})

test('空维度绝不误删：userId / dbSlug 任一缺失返回 0', () => {
  const keep = 'guard-keep'
  const keepLegacy = 'guard-legacy-no-slug'
  sessions.__test_insert(keep, 9, Date.now(), '@guardacct0001')
  // 没有挡墙时 revokeAllByUser(9, null) 会把「无 slug 的旧记录」当成目标删掉，
  // 这条让行为判据真能证伪（只放带 slug 的记录会假绿：遍历时自然被 slug 条件跳过）
  sessions.__test_insert(keepLegacy, 9, Date.now(), null)
  assert.strictEqual(sessions.revokeAllByUser(null, '@guardacct0001'), 0)
  assert.strictEqual(sessions.revokeAllByUser(9, null), 0)
  assert.strictEqual(sessions.revokeAllByUser(undefined, undefined), 0)
  assert.strictEqual(sessions.has(keep), true)
  assert.strictEqual(sessions.has(keepLegacy), true, '维度缺失时不能拿「null」当 slug 去匹配旧记录')
})

test('统一动作层缺维度抛错，不静默返回 0（静默 = 改完密码旧 token 还能用）', () => {
  assert.throws(() => revokeAccountSessions(null, '@acctaaaa0001'), TypeError)
  assert.throws(() => revokeAccountSessions(1, null), TypeError)
  assert.throws(() => rotateAccountSessions(1, undefined), TypeError)
})

test('rotateAccountSessions：旧 sid 全失效、新 sid 判活且带账号维度', () => {
  const old1 = 'rotate-old-1'; const old2 = 'rotate-old-2'
  const other = 'rotate-other'
  sessions.__test_insert(old1, 3, Date.now(), '@rotateacct001')
  sessions.__test_insert(old2, 3, Date.now(), '@rotateacct001')
  sessions.__test_insert(other, 3, Date.now(), '@rotateother01')

  const { revoked, sid } = rotateAccountSessions(3, '@rotateacct001')
  assert.strictEqual(revoked, 2)
  assert.strictEqual(sessions.has(old1), false)
  assert.strictEqual(sessions.has(old2), false)
  assert.strictEqual(sessions.has(sid), true, '新 sid 必须可用，否则改一次密码就把自己踢下线')
  assert.strictEqual(sessions.__test_get(sid).dbSlug, '@rotateacct001')
  assert.strictEqual(sessions.has(other), true)
})

test('单点 revoke 仍可用：登出只退当前窗口的既有语义没被破坏', () => {
  const sid = 'single-revoke'
  sessions.__test_insert(sid, 11, Date.now(), '@singleacct001')
  assert.strictEqual(sessions.revoke(sid), true)
  assert.strictEqual(sessions.has(sid), false)
})

// ————————————————————————— 接线层 —————————————————————————

test('接线：所有 sessions.create 都传了 dbSlug（新版记录才有账号维度）', () => {
  const files = [
    'student-backend/routes/auth.js',
    'student-backend/routes/account.js',
    'student-backend/services/credentialChange.js',
  ]
  let calls = 0
  for (const f of files) {
    for (const m of read(f).matchAll(/sessions\.create\(([^)]*)\)/g)) {
      calls += 1
      assert.match(m[1], /,\s*\S+/, `${f} 有一处 create 没带第二参数：${m[1]}`)
    }
  }
  // v2 备份的两个恢复入口（/restore、/restore-offline）下线后，只剩这三处。
  // 用精确数而不是 >=：少一处说明有人删了签发登录态的地方（登录会坏），
  // 多一处说明新增了路径却没被上面那条「必须带 dbSlug」的断言覆盖到清单里。
  assert.equal(calls, 3, `create 调用点数量变了（${calls}）：新增/删除签发路径时请同步本清单与断言`)
})

test('接线：每一处写入登录密码的 handler 都接了统一动作层（防新增路径漏网）', () => {
  let checked = 0
  for (const rel of ['student-backend/routes/auth.js', 'student-backend/routes/account.js']) {
    for (const h of handlersOf(read(rel))) {
      // 密码写入可能在路由里直接写，也可能已下沉到 services/userStore.js（M12）；
      // 两种写法都要被本断言覆盖，否则「新增路径漏网」的守卫就失效了。
      if (!/UPDATE users SET password|userStore\.updatePassword\(/.test(h)) continue
      checked += 1
      assert.match(h, /revokeAccountSessions\(|rotateLoginAfterCredentialChange\(/,
        `${rel} 有一段改密 handler 没接统一动作层：${h.slice(0, 90)}`)
    }
  }
  // 3 段 = auth.js /recover-password（隐私库与普通恢复词两条分支共用同一个 handler）
  //      + account.js /password + account.js /security-level。
  // 两条恢复词分支是否各自接上，由下面「≥2 次且都带 resolved.slug」单独守。
  assert.ok(checked >= 3, `改密 handler 数量异常（${checked}），判据可能失效`)
})

test('接线：删账号走全量吊销，登出仍走单点且注释写明取舍', () => {
  const account = read('student-backend/routes/account.js')
  const del = handlersOf(account).find((h) => h.startsWith("router.delete('/'"))
  assert.ok(del, '没找到 DELETE / handler')
  assert.match(del, /revokeAccountSessions\(req\.user\.userId,\s*req\.user\.dbSlug\)/)

  const auth = read('student-backend/routes/auth.js')
  const logout = handlersOf(auth).find((h) => h.startsWith("router.post('/logout'"))
  assert.ok(logout, '没找到 /logout handler')
  assert.match(logout, /sessions\.revoke\(/)
  assert.match(auth, /刻意保持单点/, '登出保持单点是有意取舍，必须写明，别被后人当漏网补掉')
})

test('接线：全量吊销 + 换发当前窗口登录态只有一份实现，两处凭证变更共用', () => {
  const src = read('student-backend/routes/account.js')
  assert.strictEqual((src.match(/function rotateLoginAfterCredentialChange\(/g) || []).length, 1)
  assert.ok((src.match(/rotateLoginAfterCredentialChange\(req, res\)/g) || []).length >= 2,
    '改密与切换安全等级都要走同一份换发实现')
  // 换发必须真的换 sid：沿用旧 sid 会把自己一起吊销。
  // 多班级后第二个参数可以是「该账号所有班级的 slug 列表」（accountSlugsForRevoke），
  // 但必须仍然来自账号维度 —— 不能写成常量或单个硬编码 slug。
  assert.match(src, /rotateAccountSessions\(u\.userId,\s*(?:u\.dbSlug|accountSlugsForRevoke\(u\))\)/,
    '换发必须按账号维度吊销并换新 sid')
  // 多班级：吊销范围要覆盖该账号名下所有班，否则「切班后改密」会漏掉另一个班的会话
  assert.match(src, /function accountSlugsForRevoke\(user\)[\s\S]{0,600}dbManager\.listClasses\(/,
    'accountSlugsForRevoke 必须用 listClasses 取该账号全部班级，不能只看当前 dbSlug')
})

test('接线：恢复词两条改密路径都传 resolved.slug，不靠 userId 单键', () => {
  const auth = read('student-backend/routes/auth.js')
  const hits = [...auth.matchAll(/revokeAccountSessions\([^)]*\)/g)].map((m) => m[0])
  assert.ok(hits.length >= 2, `恢复词改密有两条路径，实际只接了 ${hits.length} 条`)
  for (const h of hits) assert.match(h, /resolved\.slug/, `${h} 没带账号维度`)
})

test('接线：换发凭据走既有响应头协议（否则改完密码媒体凭据全 401）', () => {
  const account = read('student-backend/routes/account.js')
  const start = account.indexOf('function rotateLoginAfterCredentialChange(')
  const body = account.slice(start, account.indexOf('\n}\n', start))
  assert.match(body, /res\.set\('X-Renewed-Token', token\)/)
  assert.match(body, /res\.set\('X-Renewed-Media', signMediaToken\(payload\)\)/,
    '媒体凭据与登录 token 绑同一个 sid，全量吊销后必须一并换发')

  // 「有人设头」不等于「有人读头」：确认前端成功拦截器真的接了吸收逻辑
  const http = read('student-frontend/src/utils/httpClient.js')
  assert.match(http, /absorbRenewal\(res\.headers,/)
  const renewal = read('student-frontend/src/utils/tokenRenewal.js')
  assert.match(renewal, /get\('x-renewed-token'\)/)
  assert.match(renewal, /get\('x-renewed-media'\)/)
})

test('底座：sessions.has 的 touch 保留 dbSlug，revokeAllByUser 导出可用', () => {
  const src = read('student-backend/services/sessions.js')
  assert.match(src, /dbSlug:\s*rec && rec\.dbSlug != null \? rec\.dbSlug : null/,
    'touch 重写记录必须原样带过账号维度')
  assert.match(src, /create, has, revoke, prune, revokeAllByUser/)
  assert.match(src, /if \(userId == null \|\| dbSlug == null\) return 0/,
    '空维度挡墙丢了会把整张名单清空')
})

test.after(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) {}
})
