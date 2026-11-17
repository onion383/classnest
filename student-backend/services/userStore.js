// ==================== users 表的 SQL 出口 ====================
// 档 C · M12-B7：账号路由只做鉴权/加密与 HTTP，users 的读写语句收在这里。
const { db } = require('../db')

function findById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id)
}

// 登录态变更时要拿旧哈希比对，只取最小列。
function findCredentials(id) {
  return db.prepare('SELECT id, password FROM users WHERE id = ?').get(id)
}

function findIdByUsername(username) {
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username)
}

function updateRecoveryHash(id, hash) {
  db.prepare('UPDATE users SET recovery_hash = ? WHERE id = ?').run(hash, id)
}

function updateUsername(id, username) {
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id)
}

function updatePassword(id, hash) {
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, id)
}

// ==================== 登录前路径（显式传 conn） ====================
// 与上面 6 个函数的分工是**刻意**的，别「统一」：
//   · 上面的函数只在已登录请求里用，那时 middleware/auth 已经 withDb 绑好库，走 db 代理即可；
//   · 下面这组跑在 /login、/db-recover、/recover-password 里 —— 那时还没有登录态，
//     ALS 里没有 slug，db.prepare 会直接抛「未绑定数据库连接」。库是调用方用
//     dbManager.resolveByUsername() 按用户名解析出来的（connCache 里的同一个实例），
//     所以连接只能由调用方显式传进来。
//
// 刻意取全列：10 个调用点各挑各的字段（登录要 password、恢复要 recovery_hash、
// 确认注册只要 id/username/role），这样 4 个函数就够了，不必为每处再开一个窄函数。
// 注意：返回值含 password / recovery_hash —— 路由必须挑字段回前端，禁止整个对象 res.json。
const LOGIN_USER_COLS = 'id, username, role, db_slug, password, recovery_hash'

function findByUsername(conn, username) {
  return conn.prepare(`SELECT ${LOGIN_USER_COLS} FROM users WHERE username = ?`).get(username)
}

// 多班级改名后各库内 users.username 可能还是旧名（改名只同步 registry / accounts），
// 按新名查不到时退回「库里第一条」—— 能打开这个库本身就说明密钥正确。
function findFirstUser(conn) {
  return conn.prepare(`SELECT ${LOGIN_USER_COLS} FROM users ORDER BY id LIMIT 1`).get()
}

function setPasswordByName(conn, username, hash) {
  return conn.prepare('UPDATE users SET password = ? WHERE username = ?').run(hash, username)
}

function setRecoveryHashByName(conn, username, hash) {
  return conn.prepare('UPDATE users SET recovery_hash = ? WHERE username = ?').run(hash, username)
}

module.exports = {
  findById,
  findCredentials,
  findIdByUsername,
  updateRecoveryHash,
  updateUsername,
  updatePassword,
  // 登录前路径（第一个参数是 conn，不走 db 代理）
  findByUsername,
  findFirstUser,
  setPasswordByName,
  setRecoveryHashByName,
}
