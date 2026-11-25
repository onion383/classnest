// =========================================================================
// auth-recovery-rename-fallback.test.js —— 改名后本机恢复通道仍可用（2-2 / 第二轮 N4）
//
// 原缺陷：/db-recover 用 resolveByDbFile 返回的 r.username 二次 resolveByUsername，
// 但改名只同步 registry + accounts，各库 users.username 故意留旧名（挨个开库改名要 N 次 KDF）。
// r.username 来自库内 users 表 = 旧名 → 拿它查 registry（已是新名）返回 null → 400，
// 改名班无法用本机 .db 恢复。登录分支早有 findFirstUser 兜底，这里没有。
//
// 判据：
//   ① 行为：模拟改名（registry 新名 / 库内 users 旧名），按文件 slug 能拿到登记新名并打开库、
//      按库内旧名查 user、findFirstUser 兜底；
//   ② 接线：/db-recover 用 registryFindBySlug(r.slug) 取账号名、user 查询带 findFirstUser 兜底；
//   ③ 变异反证：把兜底/按 slug 定位去掉后，接线判据必须失败。
// =========================================================================
const test = require('node:test')
const { extractBlockByAnchor } = require('#testjs/units/_mechanism.cjs')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BACKEND = abs('student-backend')
const AUTH = path.join(BACKEND, 'routes', 'auth.js')

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-recover-rename-'))
process.on('exit', () => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) {}
})
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'recover-rename-test-key'
process.env.DATA_DIR = DATA_DIR

const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const userStore = require(path.join(BACKEND, 'services', 'userStore'))
assert.strictEqual(dbManager.dataDir, DATA_DIR, '隔离目录没生效，测试会写真实数据')

const recoverHandlerBody = (src) => extractBlockByAnchor(src, "router.post('/db-recover'")
const handler = () => recoverHandlerBody(fs.readFileSync(AUTH, 'utf8'))

// ————————————————————————— ① 行为层 —————————————————————————

test('模拟改名：按文件 slug 拿到登记新名，能打开库并兜底取到用户', () => {
  const OLD = 'recover-old-name'
  const NEW = 'recover-new-name'
  const { slug } = dbManager.createTeacher(OLD, 'h', 'teacher', false, 'A班')

  // 模拟改名只改 registry（各库 users.username 留旧名，与真实 account.js 一致）
  dbManager.registryRename(slug, NEW)

  // resolveByDbFile 返回的是库内旧名 + 可靠 slug
  const r = dbManager.resolveByDbFile(slug + '.db')
  assert.equal(r.username, OLD, '库内 users 表仍是旧名 —— 这正是 bug 的输入')
  assert.equal(r.slug, slug)

  // 修复口径：按 slug 取登记行的当前账号名
  const rec = dbManager.registryFindBySlug(r.slug)
  assert.equal(rec.username, NEW, 'registry 已是新名')
  const resolved = dbManager.resolveByUsername(rec.username)
  assert.ok(resolved, '按登记新名能打开库（旧名会返回 null）')

  // 库内按旧名能查到，按新名查不到；findFirstUser 是统一兜底
  assert.ok(userStore.findByUsername(resolved.conn, r.username), '旧名能查到用户')
  assert.equal(userStore.findByUsername(resolved.conn, NEW), undefined, '新名查不到（未同步）')
  assert.ok(userStore.findFirstUser(resolved.conn), 'findFirstUser 兜底能取到唯一账号')
})

// ————————————————————————— ② 接线层 —————————————————————————

test('/db-recover 按 r.slug 取登记账号名定位，不再用库内旧名 resolve', () => {
  const h = handler()
  assert.match(h, /registryFindBySlug\(r\.slug\)/, '必须按文件 slug 取登记行（其 username 是当前名）')
  assert.match(h, /resolveByUsername\(registryName\)/, '解析要用登记新名，不是库内 r.username')
})

test('/db-recover 取用户带 findFirstUser 兜底，与登录同口径', () => {
  const h = handler()
  assert.match(h, /findByUsername\(resolved\.conn, r\.username\)/, '先按库内名查')
  assert.match(h, /findFirstUser\(resolved\.conn\)/, '查不到要退回第一条，与登录 pickUser 一致')
})

test('/db-recover 用账号维度名做 wantedUsername 校验与 token 签发', () => {
  const h = handler()
  // 前端传的 username 来自 /api/accounts（registry 新名），不能用库内旧名 user.username 比对
  assert.match(h, /wantedUsername && registryName !== wantedUsername/, '校验要用账号名，否则改名后误判 400')
  // token 用账号名签发，避免切班归属校验失败
  assert.match(h, /username: registryName, role: user\.role/, 'token 里的 username 必须是账号维度名')
  assert.doesNotMatch(h, /username: user\.username, role: user\.role/, '不能再签发库内旧名')
})

// ————————————————————————— ③ 变异反证 —————————————————————————

test('变异反证：改回用 r.username 解析 + 去掉兜底后，接线判据必须失败', () => {
  const h = handler()
  const mutated = h
    .replace(/registryFindBySlug\(r\.slug\)/, 'registryFindBySlug("wrong")')
    .replace(/findFirstUser\(resolved\.conn\)/, 'findFirstUser(null)')
  assert.ok(mutated !== h, '变异没匹配到定位/兜底语句')
  assert.doesNotMatch(mutated, /registryFindBySlug\(r\.slug\)/, '变异后定位判据应失败')
  assert.doesNotMatch(mutated, /findFirstUser\(resolved\.conn\)/, '变异后兜底判据应失败')
})
