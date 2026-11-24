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

// 登录校验用哪份哈希（唯一口径）：
//   accounts.password_hash 是账号级权威 —— 一个账号在多个班的 users 表里可以各存一份
//   密码，但登录发生在「进哪个班」之前，只能认账号级这一份。
//   账号级哈希还没同步过（历史账号/明文模式）时，退回当前库 users.password。
//
// 抽成导出纯函数（T07-03）：登录路径与单测共用同一行判据。
// 过去单测把这行手抄进 `security-level-hash-sync.test.js` 当 oracle，
// 口径一旦调整（比如改成先看 user.password），测试不会跟着变。
function hashSource(acc, user) {
  return (acc && acc.password_hash) ? acc.password_hash : user.password;
}

// 改密 / 恢复词重置 / 删账号：全部旧 token 作废，要求重新登录。
// 缺任一维度直接抛错，绝不静默返回 0 —— 静默等于「改完密码旧 token 还能用」。
//
// 多班级：dbSlug 可以是字符串，也可以是**数组**（该账号名下所有班级的 slug）。
// 一个账号多个班时，各班的会话是按不同 dbSlug 登记的；只吊销当前班那一个，
// 另一个班窗口里签发的 token 会在改密后继续有效 —— 等于改了密码没改。
// 调用方应传 dbManager.listClasses(username).map(c => c.slug)。
function revokeAccountSessions(userId, dbSlug) {
  if (userId == null || dbSlug == null) {
    throw new TypeError('revokeAccountSessions 需要 userId 与 dbSlug 两个维度');
  }
  const slugs = Array.isArray(dbSlug) ? dbSlug.filter((s) => s != null) : [dbSlug];
  if (!slugs.length) {
    throw new TypeError('revokeAccountSessions 的 dbSlug 列表为空');
  }
  let revoked = 0;
  for (const s of slugs) {
    revoked += sessions.revokeAllByUser(userId, s);
    // 集成凭据（MCP token）与登录会话是两套存储：改密/删号后不能留着旧 token 继续访问 /mcp（N3-04）。
    // 惰性 require：避免启动路径上把 mcpTokenStore → dbManager → db 的初始化链提前拉起来。
    try { require('./mcpTokenStore').revokeBySlug(s); } catch (_) { /* 令牌文件不可写不阻断会话吊销 */ }
  }
  return revoked;
}

// 设置页改密这类「改完仍要继续在线」的路径：全量吊销后换发一个新 sid。
// 不能沿用旧 sid（沿用会把自己也一起吊销）；也不能只吊销兄弟会话而放过当前
// token —— 若当前 token 已泄露，改密码就失去意义。
function rotateAccountSessions(userId, dbSlug) {
  const revoked = revokeAccountSessions(userId, dbSlug);
  // 新会话登记在当前所在的班（数组时取第一个 = 当前班由调用方排首位）
  const current = Array.isArray(dbSlug) ? dbSlug[0] : dbSlug;
  return { revoked, sid: sessions.create(userId, current) };
}

module.exports = { hashSource, revokeAccountSessions, rotateAccountSessions };
