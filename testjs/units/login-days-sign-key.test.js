// =========================================================================
// login-days-sign-key.test.js —— 登录保持天数签发键（2-3 / 第二轮 N3）
//
// 原缺陷：issueSession 用 authPolicy.signOptsFor(user.dbSlug)，但 authPolicy 的键是
// 账号名 username（一个账号多个班各有 slug，按 slug 存会切班就「重置」）。传 dbSlug
// 查不到键 → daysFor 返回默认 30，用户设的 180 天静默失效。其余 7 处签发点全用 username。
//
// 判据：
//   ① 行为：给账号设 180 天，signOptsFor(username) 出的 expiresIn 是 180d，
//      signOptsFor(dbSlug) 是默认 30d（证明键用错就会失效）；
//   ② 接线：issueSession 里 signOptsFor(user.username)；
//   ③ 变异反证：改回 dbSlug 后接线判据失败。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const BACKEND = path.join(ROOT, 'student-backend')
const AUTH = path.join(BACKEND, 'routes', 'auth.js')

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-login-days-'))
process.on('exit', () => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) {}
})
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'login-days-test-key'
process.env.DATA_DIR = DATA_DIR

const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
assert.strictEqual(dbManager.dataDir, DATA_DIR)
const authPolicy = require(path.join(BACKEND, 'services', 'authPolicy'))

test('行为：按 username 存 180 天，signOptsFor(username)=180d，dbSlug=默认 30d', () => {
  const NAME = 'login-days-user'
  const slug = '@logindays001'
  authPolicy.setDays(NAME, 180)
  assert.deepEqual(authPolicy.signOptsFor(NAME), { expiresIn: '180d' }, '按账号名签发才拿到设置值')
  assert.deepEqual(authPolicy.signOptsFor(slug), { expiresIn: '30d' },
    '按 dbSlug 签发退回默认 30 天 —— 这正是原缺陷的失效机制')
})

function issueSessionBody() {
  const src = fs.readFileSync(AUTH, 'utf8')
  const i = src.indexOf('function issueSession(')
  assert.ok(i >= 0, '未找到 issueSession')
  const rest = src.slice(i)
  const end = rest.indexOf('\nfunction ', 1)
  return end >= 0 ? rest.slice(0, end) : rest
}

test('接线：issueSession 用 signOptsFor(user.username)，不是 dbSlug', () => {
  const h = issueSessionBody()
  assert.match(h, /signOptsFor\(user\.username\)/, '签发键必须是账号名')
  assert.doesNotMatch(h, /signOptsFor\(user\.dbSlug\)/, '不能退回按 dbSlug 签发')
})

test('变异反证：改回 dbSlug 后接线判据必须失败', () => {
  const h = issueSessionBody()
  const mutated = h.replace(/signOptsFor\(user\.username\)/, 'signOptsFor(user.dbSlug)')
  assert.ok(mutated !== h, '变异没匹配到签发键')
  assert.doesNotMatch(mutated, /signOptsFor\(user\.username\)/, '变异后接线判据应判失败')
})
