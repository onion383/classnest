// =========================================================================
// security-level-hash-sync.test.js —— 切换安全等级同步权威凭证（1-12 / #5a）
//
// 原缺陷：POST /security-level 切换时写/清当前库 users.password，但登录校验
// 以 accounts.password_hash 为权威（auth.js hashSource）。于是：
//   · 明文/免密 → 密码/隐私：库内写了新哈希，权威还是旧的 → 新密码登录 401；
//   · 密码/隐私 → 明文/免密：库内清空了密码，权威还留旧哈希 → 免密仍被要密码。
// 对照 PUT /password 本就同步（account.js 610-615），这里属「一处修了、兄弟路径没修」。
//
// 判据三层：
//   ① 接线：security-level handler 的两个写密码点后各跟一次 accountSetPassword；
//   ② 口径：新哈希分支写 newHash、清空分支写空串，账户名用 username（账号维度）；
//   ③ 变异反证：把两处同步去掉后，接线判据必须失败。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BACKEND = abs('student-backend')
const SRC = path.join(BACKEND, 'routes', 'account.js')

// 隔离 dataDir：必须早于 require dbManager（行为层要真读写账号索引库）
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-seclevel-hash-'))
process.on('exit', () => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) { /* 占用则留给系统清理 */ }
})
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'seclevel-hash-test-key'
process.env.DATA_DIR = DATA_DIR
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
assert.strictEqual(dbManager.dataDir, DATA_DIR, '隔离目录没生效，测试会写真实数据')

// ————————————————————————— ① 行为层 —————————————————————————

test('accountSetPassword 读写权威哈希：设新哈希→登录权威生效，清空→权威消失', () => {
  const name = 'seclevel-hash-user'
  const { accountId } = dbManager.createTeacher(name, 'old-hash', 'teacher', false, 'A班')
  const acc0 = dbManager.accountFindByUsername(name)
  assert.equal(acc0.password_hash, 'old-hash', '建号后账号表应有初始哈希')

  // 模拟切到 password/privacy：同步新哈希
  dbManager.accountSetPassword(accountId, 'new-hash')
  assert.equal(dbManager.accountFindByUsername(name).password_hash, 'new-hash',
    '权威哈希必须真被改写，否则新密码登录仍被旧哈希判 401')

  // 模拟切到 plain/nopass：同步清空
  dbManager.accountSetPassword(accountId, '')
  const acc2 = dbManager.accountFindByUsername(name)
  assert.equal(acc2.password_hash, '', '权威哈希必须能清空，否则免密登录仍被要旧密码')
  // 登录 hashSource 的口径由 services/credentialChange.js 唯一导出（T07-03），
  // 不在这里再手抄一行当 oracle —— 口径改了（例如改成先看 user.password），本用例会跟着变。
  const { hashSource } = require(path.join(BACKEND, 'services', 'credentialChange'))
  assert.equal(hashSource(acc2, { password: 'lib-password' }), 'lib-password',
    '权威哈希清空后应退回库内口令，不会拿旧哈希校验')
  assert.equal(hashSource({ password_hash: 'account-hash' }, { password: 'lib-password' }), 'account-hash',
    '账号级哈希存在时必须优先，库内口令不得覆盖权威')
})

function securityLevelHandler() {
  const src = fs.readFileSync(SRC, 'utf8')
  const parts = src.split(/(?=router\.(?:get|post|put|patch|delete)\s*\()/)
  const h = parts.find((p) => p.startsWith("router.post('/security-level'"))
  assert.ok(h, '未找到 POST /security-level handler')
  return h
}

// 按分支切：设新密码分支 / 清空密码分支
function branchOf(h, marker) {
  const i = h.indexOf(marker)
  assert.ok(i >= 0, `未找到分支标记：${marker}`)
  const rest = h.slice(i)
  // 分支止于下一个 else if / 函数尾部
  const end = rest.indexOf('} else if (', 1)
  return end >= 0 ? rest.slice(0, end) : rest
}

test('设新密码分支：写库内哈希后同步 accounts.password_hash(newHash)', () => {
  const h = securityLevelHandler()
  const b = branchOf(h, "target === 'password' || target === 'privacy'")
  assert.match(b, /userStore\.updatePassword\(user\.id, newHash\)/, '库内仍要写新哈希')
  assert.match(b, /dbManager\.accountFindByUsername\(username\)/, '按账号维度名定位 accounts')
  assert.match(b, /dbManager\.accountSetPassword\(acc\.id, newHash\)/, '权威哈希必须同步为新哈希，否则新密码登录 401')
})

test('清空密码分支：写空串后同步 accounts.password_hash 为空', () => {
  const h = securityLevelHandler()
  const b = branchOf(h, "target === 'plain' || target === 'nopass'")
  assert.match(b, /userStore\.updatePassword\(user\.id, ''\)/, '库内密码要清空')
  assert.match(b, /dbManager\.accountSetPassword\(acc\.id, ''\)/, '权威哈希也要清空，否则免密/明文仍要旧密码')
})

test('两个写密码分支各同步一次，另有一次失败回滚（不漏不重）', () => {
  const h = securityLevelHandler()
  const updates = (h.match(/userStore\.updatePassword\(/g) || []).length
  const syncs = (h.match(/dbManager\.accountSetPassword\(/g) || []).length
  assert.equal(updates, 3, '两个写密码点 + 一次失败回滚点，数量变了判据需复核')
  assert.equal(syncs, updates, '每个 updatePassword 都要有对应的 accountSetPassword（含回滚）')
})

test('变异反证：去掉全部权威哈希同步后，接线判据必须失败', () => {
  const h = securityLevelHandler()
  const mutated = h
    .replace(/dbManager\.accountSetPassword\([^)]*\)/g, '')
  assert.ok(mutated !== h, '变异没匹配到同步语句')
  assert.equal((mutated.match(/dbManager\.accountSetPassword\(/g) || []).length, 0,
    '变异后应无权威哈希同步，接线判据须判失败')
})
