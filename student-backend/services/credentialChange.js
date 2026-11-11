// =========================================================================
// credentialChange.js —— 「凭证变更 → 会话失效」的唯一动作层
//
// 根因（A1-16 / N3-04）：过去改密后的会话失效规则散在 auth.js 与 account.js
// 的两条路由里，恢复词重置密码那条甚至完全没吊销 —— 改完密码，其它窗口的旧
// token 在 JWT 有效期内仍可继续读写。而 sessions 只有 revoke(sid) 单点出口，
// 调用方想吊销「这个账号的全部会话」也无从下手。
//
// 这里把规则收成一句话：**凭证一变，该账号所有 sid 立即失效**。
// 调用方只描述「哪个账号变了」，不自己决定吊销范围、也不自己拼 sid。
//
// 账号维度必须是 (userId, dbSlug)：.sessions.json 是全局一份，各账号库里
// users.id 都可能是 1，只按 userId 吊销会误踢其它账号。
// =========================================================================
const sessions = require('./sessions');

// 改密 / 恢复词重置 / 删账号：全部旧 token 作废，要求重新登录。
// 缺任一维度直接抛错，绝不静默返回 0 —— 静默等于「改完密码旧 token 还能用」。
function revokeAccountSessions(userId, dbSlug) {
  if (userId == null || dbSlug == null) {
    throw new TypeError('revokeAccountSessions 需要 userId 与 dbSlug 两个维度');
  }
  return sessions.revokeAllByUser(userId, dbSlug);
}

// 设置页改密这类「改完仍要继续在线」的路径：全量吊销后换发一个新 sid。
// 不能沿用旧 sid（沿用会把自己也一起吊销）；也不能只吊销兄弟会话而放过当前
// token —— 若当前 token 已泄露，改密码就失去意义。
function rotateAccountSessions(userId, dbSlug) {
  const revoked = revokeAccountSessions(userId, dbSlug);
  return { revoked, sid: sessions.create(userId, dbSlug) };
}

module.exports = { revokeAccountSessions, rotateAccountSessions };
