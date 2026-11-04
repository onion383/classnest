// 账号安全等级判定：plain 明文 / nopass 加密免密 / password 普通密码 / privacy 超级隐私。
//
// 口径必须单源：设置页（routes/account.js 的 /security-level 与 /security-level 返回）
// 和「本机信息恢复」（routes/auth.js 的 /db-recover）都走这里。各写一份迟早分叉 ——
// 恢复后后端按 A 处理、设置页显示 B，用户看到的就是一个自相矛盾的账号
// （典型症状：设置页写着「加密免密」，登录却要密码）。
const dbManager = require('../dbManager/dbManager');

// conn：已打开的该账号库连接（db 代理与 better-sqlite3 连接都实现了 prepare）。
// 不要在这里 require('../db') —— 那个代理依赖请求作用域，只有路由 handler 里才绑得上。
function resolveSecurityLevel(conn, { dbSlug, username, userId }) {
  const rec = dbManager.registryFindBySlug(dbSlug);
  // 明文库没有库钥匙，users.password 本来就不该有值（注册与切换等级都禁写）。
  // 这一条必须排在 password 判定之前：否则残留的哈希会把明文库顶成「普通密码」，
  // 而库本身仍是明文，等于给了个假密码。
  if (rec && rec.encrypted === 0) return 'plain';
  if (dbManager.isProtected(username)) return 'privacy';
  const u = conn.prepare('SELECT password FROM users WHERE id = ?').get(userId);
  return u && u.password ? 'password' : 'nopass';
}

module.exports = { resolveSecurityLevel };
