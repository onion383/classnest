// =========================================================================
// auth-user-store-sink.test.js —— users 表「登录前路径」的 SQL 出口判据
//
// 背景：routes/auth.js 曾有 10 条裸 SQL，全部写成 `resolved.conn.prepare(...)`。
// 既有 9 处守卫写的是 /db\.prepare\(/（带 db 前缀），所以一条都没抓到 ——
// 判据本身漏了「显式连接」这种写法。
//
// 本用例锁三件事：
//   ① 路由层不再有任何 .prepare（含 resolved.conn / dbManager.current()）；
//   ② auth.js 真的走 userStore 那 4 个显式收 conn 的函数，不是把 SQL 换个地方抄；
//   ③ 那 4 个函数的语句按**用户名**定位，不是按 id（登录前拿不到 id）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'auth-user-store-sink', currentSlug: 'class-a' })
const conn = fx.conn

// 同名不同 id 的两行是不可能的（username UNIQUE），所以用「名字与 id 不同序」来区分：
// id=1 叫 zhu，id=2 叫 an。按 id 会命中的那行 ≠ 按名字该命中的那行。
conn.prepare(
  'INSERT INTO users (id, username, password, role, db_slug, recovery_hash) VALUES (?,?,?,?,?,?)'
).run(1, 'zhu', 'hash-zhu', 'teacher', 'class-a', 'rh-zhu')
conn.prepare(
  'INSERT INTO users (id, username, password, role, db_slug, recovery_hash) VALUES (?,?,?,?,?,?)'
).run(2, 'an', 'hash-an', 'teacher', 'class-a', 'rh-an')

// 必须在夹具 stub 装好之后再 require：userStore 顶部捕获了 db 句柄
const userStore = require('../../student-backend/services/userStore')

test.after(() => fx.close())

function routeSrc() {
  return fs.readFileSync(path.join(ROOT, 'student-backend/routes/auth.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

// ---------------------------------------------------------------- 判据

test('SQL 出口：auth 路由不留任何 .prepare（含显式 conn）', () => {
  const src = routeSrc()
  assert.ok(!/\.prepare\(/.test(src), 'auth 路由不许再有裸 SQL（应走 services/userStore）')
  assert.ok(!/dbManager\.current\(\)/.test(src), 'auth 路由不该自己取当前连接（登录前没有当前库）')
})

test('接线：4 个显式收 conn 的函数都真的被调用', () => {
  const src = routeSrc()
  assert.ok((src.match(/userStore\.findByUsername\(/g) || []).length >= 5,
    ':128/:192/:408/:445/:487/:500 六处都应走 findByUsername')
  assert.ok((src.match(/userStore\.findFirstUser\(/g) || []).length >= 1, '登录回退要真的走 findFirstUser')
  assert.ok((src.match(/userStore\.setPasswordByName\(/g) || []).length >= 2, '两处改密都应走 setPasswordByName')
  assert.ok((src.match(/userStore\.setRecoveryHashByName\(/g) || []).length >= 1, '写恢复哈希要走 setRecoveryHashByName')
})

// ---------------------------------------------------------------- 行为

test('findByUsername：按用户名命中，不是按 id（显式传 conn）', () => {
  const u = userStore.findByUsername(conn, 'an')
  assert.equal(u.id, 2)
  assert.equal(u.username, 'an')
  assert.equal(u.password, 'hash-an', '登录要拿 password 比对，这一列必须取到')
  assert.equal(userStore.findByUsername(conn, 'zhu').id, 1)
  assert.equal(userStore.findByUsername(conn, 'nobody'), undefined)
})

test('findFirstUser：id 最小的那条（改名后按新名查不到时的回退）', () => {
  assert.equal(userStore.findFirstUser(conn).username, 'zhu')
})

test('setPasswordByName：只改目标行，另一行原样', () => {
  userStore.setPasswordByName(conn, 'an', 'hash-an-2')
  assert.equal(conn.prepare('SELECT password FROM users WHERE id = 2').get().password, 'hash-an-2')
  assert.equal(conn.prepare('SELECT password FROM users WHERE id = 1').get().password, 'hash-zhu',
    '按 id 写就会改错行')
})

test('setRecoveryHashByName：只改目标行', () => {
  userStore.setRecoveryHashByName(conn, 'zhu', 'rh-zhu-2')
  assert.equal(conn.prepare('SELECT recovery_hash FROM users WHERE id = 1').get().recovery_hash, 'rh-zhu-2')
  assert.equal(conn.prepare('SELECT recovery_hash FROM users WHERE id = 2').get().recovery_hash, 'rh-an')
})
