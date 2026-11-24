// =========================================================================
// loginThrottle.js —— 登录失败节流 + 登录页账号列表的极简频控
//
// 为什么放在服务端内存：登录接口在鉴权之前，任何 DB 记录都还没建立；
// 本地单进程后端（Electron fork 一个）用进程内固定窗口足够，且不引入额外存储。
//
// 规则（A-2 · F06-01 / N3-02）：
//   · 同一「账号名 + 来源 IP」15 分钟内失败 5 次 → 锁 30 秒；
//   · 失败 10 次 → 锁 15 分钟；
//   · 成功登录清零。
//   · 被锁时返回 429 + retry_after，前端据此提示等待；错误文案不区分「账号不存在」。
//   · /api/accounts 无需登录即可调用（登录页要列出已保存账号），按 IP 限 60 次/分钟，
//     把「批量枚举本机账号名」的成本抬高，同时不影响正常打开登录页。
// =========================================================================

const WINDOW_MS = 15 * 60 * 1000;
const SOFT_LIMIT = 5;
const SOFT_LOCK_MS = 30 * 1000;
const HARD_LIMIT = 10;
const HARD_LOCK_MS = 15 * 60 * 1000;

const ACCOUNTS_WINDOW_MS = 60 * 1000;
const ACCOUNTS_PER_MIN = 60;

const attempts = new Map(); // key → { count, windowStart, lockedUntil }
const accountsBuckets = new Map(); // ip → { count, start }

function loginKey(username, ip) {
  return `${String(username == null ? '' : username).toLowerCase()}\u0001${ip || ''}`;
}

function prune(now) {
  if (attempts.size < 500 && accountsBuckets.size < 500) return;
  for (const [k, v] of attempts) {
    if ((v.lockedUntil || 0) <= now && now - v.windowStart > WINDOW_MS) attempts.delete(k);
  }
  for (const [k, v] of accountsBuckets) {
    if (now - v.start > ACCOUNTS_WINDOW_MS) accountsBuckets.delete(k);
  }
}

// 登录前检查：返回 { ok:true } 或 { ok:false, retryAfter, error }。
function checkLogin(username, ip, now = Date.now()) {
  prune(now);
  const key = loginKey(username, ip);
  const rec = attempts.get(key);
  if (!rec) return { ok: true };
  if (rec.lockedUntil && rec.lockedUntil > now) {
    const retryAfter = Math.max(1, Math.ceil((rec.lockedUntil - now) / 1000));
    return {
      ok: false,
      retryAfter,
      error: `登录尝试过于频繁，请 ${retryAfter} 秒后再试`,
    };
  }
  return { ok: true };
}

// 记一次失败：达到阈值时设置锁定窗口。
function failLogin(username, ip, now = Date.now()) {
  const key = loginKey(username, ip);
  let rec = attempts.get(key);
  if (!rec || now - rec.windowStart > WINDOW_MS) {
    rec = { count: 0, windowStart: now, lockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= HARD_LIMIT) rec.lockedUntil = now + HARD_LOCK_MS;
  else if (rec.count >= SOFT_LIMIT) rec.lockedUntil = now + SOFT_LOCK_MS;
  attempts.set(key, rec);
  return { count: rec.count, lockedUntil: rec.lockedUntil };
}

// 登录成功：清零该账号 + IP 的失败记录。
function resetLogin(username, ip) {
  attempts.delete(loginKey(username, ip));
}

// /api/accounts 的按 IP 固定窗口（只读接口，超限回 429）。
function checkAccounts(ip, now = Date.now()) {
  prune(now);
  const key = String(ip || '');
  let b = accountsBuckets.get(key);
  if (!b || now - b.start >= ACCOUNTS_WINDOW_MS) {
    b = { count: 0, start: now };
    accountsBuckets.set(key, b);
  }
  if (b.count >= ACCOUNTS_PER_MIN) {
    const retryAfter = Math.max(1, Math.ceil((b.start + ACCOUNTS_WINDOW_MS - now) / 1000));
    return { ok: false, retryAfter };
  }
  b.count += 1;
  return { ok: true };
}

function _resetForTest() {
  attempts.clear();
  accountsBuckets.clear();
}

module.exports = {
  checkLogin,
  failLogin,
  resetLogin,
  checkAccounts,
  _resetForTest,
  WINDOW_MS,
  SOFT_LIMIT,
  HARD_LIMIT,
  ACCOUNTS_PER_MIN,
};
