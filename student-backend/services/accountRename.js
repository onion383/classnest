// =========================================================================
// accountRename.js —— 改用户名的跨库两写（带补偿）
//
// 背景：用户名存在**两处** —— index.db 的 registry 登记表（跨库的账号真源，
// 登录时靠它定位到哪个班主任库）与业务库（<班主任>.db）的 users 表。
// 两者是**两个 SQLite 文件**，事务无法跨库（除非 ATTACH），所以不能靠
// 「包一层事务」解决 —— 只能显式补偿。
//
// 为什么先改 registry：registry 决定「能不能用这个名字登录」，是权威侧。
// 若反过来先改 users，users 是新名而 registry 还是旧名 → 新名永远登不进去，
// 且此时连旧名也登不进去（registry 里的旧名已对不上 users）—— 用户被彻底锁在门外。
//
// 补偿逻辑：业务库写失败时把 registry 改回改之前的用户名，让「旧名仍可登录」
// 这个状态重新成立（而不是留下一个两边对不上的半改状态）。
//
// ⚠️ 回滚前必须确认 registry 当前**仍是**我们刚写进去的新名：否则会覆盖掉
//    期间发生的另一次改名（并发的改名请求或用户在另一窗口改的名）。
// =========================================================================

/**
 * 改用户名的跨库两写。
 *
 * @param {object}   opts
 * @param {object}   opts.registry  registry 接口：{ findBySlug(slug), rename(slug, name) }
 * @param {string}   opts.slug      当前账号所在库的 slug
 * @param {string}   opts.newName   新用户名（调用方已规范过：trim + 规则校验）
 * @param {string}   opts.fallbackOldName  registry 查不到时的兜底旧名（一般是业务库里的 username）
 * @param {function} opts.applyUsersUpdate  写业务库 users 表的函数；返回值应含 changes
 * @returns {{ ok: boolean, reason?: string, compensated?: boolean, oldName?: string, error?: Error }}
 */
function renameUsernameWithCompensation({ registry, slug, newName, fallbackOldName, applyUsersUpdate }) {
  if (!registry || typeof registry.findBySlug !== 'function' || typeof registry.rename !== 'function') {
    throw new Error('registry 接口不可用');
  }
  if (typeof applyUsersUpdate !== 'function') {
    throw new Error('缺少业务库更新函数');
  }

  // 改之前先把 registry 的**真实**旧值取出来：补偿要恢复的是它，
  // 而不是业务库里的 username（两者本来就可能已经不同步）。
  const before = registry.findBySlug(slug);
  const oldName = (before && before.username) || fallbackOldName || '';

  const changed = registry.rename(slug, newName);
  if (!changed) {
    return { ok: false, reason: 'registry-update-failed', oldName };
  }

  try {
    const result = applyUsersUpdate();
    // 「UPDATE 没命中任何行」也是一种失败：users 里那一行可能已被并发删掉。
    // 不当作成功 —— 否则 registry 已改而 users 没改，用户名就此对不上。
    if (result && result.changes === 0) {
      throw new Error('用户记录不存在或已被删除');
    }
  } catch (err) {
    let compensated = false;
    try {
      const current = registry.findBySlug(slug);
      // 只有当 registry 现在仍是**我们刚写的**新名时才回滚：
      // 若期间已被别人改成别的名字，说明有并发改名，此时回滚会覆盖掉它。
      if (current && current.username === newName) {
        // 必须看返回值：registry.rename 返回受影响行数（0 = 没改到），
        // 失败时不能报「已补偿」，否则调用方以为两边已恢复一致（审查 v5 · V5-024）。
        compensated = Number(registry.rename(slug, oldName)) > 0;
      }
    } catch (_) {
      // 回滚本身也失败：registry 与 users 已经对不上，只能靠人工/下次改名修正。
      // 不掩盖原始错误 —— 它才是用户真正要看到的。
    }
    return { ok: false, reason: 'users-update-failed', compensated, oldName, error: err };
  }

  return { ok: true, oldName };
}

module.exports = { renameUsernameWithCompensation };
