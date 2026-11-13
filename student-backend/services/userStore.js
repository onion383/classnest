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

module.exports = {
  findById,
  findCredentials,
  findIdByUsername,
  updateRecoveryHash,
  updateUsername,
  updatePassword,
}
