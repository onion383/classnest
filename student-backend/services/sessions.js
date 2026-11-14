const crypto = require('crypto');
const fs = require('fs');
const dbManager = require('../dbManager/dbManager');

// 有效登录会话名单（sid）：JWT 里只带一个随机 sid，服务端按这份名单校验。
// 「不主动退出就一直有效」+「退出后原 token 立即失效」都由此实现——
// 退出时把 sid 从名单里删掉，那个 token 下一次请求就验不过了。
// 名单持久化到 core/.sessions.json（随数据根目录保留），重启后端不会把所有人登出。
const FILE = () => dbManager.sessionsPath;

// 会话名单的保留期与容量上限。
//
// 名单里的 sid 对应的 JWT 最长活 30 天（JWT exp + 滑动续期）。但**名单本身**没人清：
// revoke 只在「主动登出」时删一个 sid，其余 sid 会永久留在 .sessions.json 里 ——
// 每登录一次涨一条，文件单调增长。
//
// TTL 取 35 天（比 JWT 的 30 天略宽）。**前提是 at 必须是「最后一次活动时间」**：
// 每次校验会话时刷新（见 has 里的 touch），否则它只是登录时间，一个持续使用 35 天的
// 会话会在下一次 prune 时被当成弃用会话清掉（审查 v5 · V5-009）。
const SESSION_TTL_MS = 35 * 24 * 60 * 60 * 1000;

// 活动时间落盘节流：每个请求都写 .sessions.json 太贵，只在超过 1 小时没刷新时写一次。
// 对 35 天 TTL 来说，1 小时的精度完全够用（最多多留 1 小时误杀窗口）。
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

// 名单容量上限：正常用户同时只有 1~2 个会话（多窗口/多设备）。
// 给到 200 是极宽松的余量；超出后按「最久没见到」淘汰最老的那些。
// 没有上限时，脚本反复登录能把名单撑到任意大。
const MAX_SESSIONS = 200;

let cache = null; // { [sid]: { userId, at } }

function load() {
  if (cache) return cache;
  try {
    const obj = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    cache = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (_) {
    cache = {};
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(FILE(), JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 });
  } catch (_) { /* 写入失败则退化为进程内名单，重启后需重新登录 */ }
}

// 清理名单：删掉超过 TTL 的会话；再按「最久没见到」淘汰超出容量上限的。
// 只在名单变长时才有意义，所以调用方（create）不必每次都调。
function prune() {
  const list = load();
  const now = Date.now();
  let changed = false;

  for (const [sid, rec] of Object.entries(list)) {
    const at = rec && typeof rec.at === 'number' ? rec.at : 0;
    if (now - at > SESSION_TTL_MS) {
      delete list[sid];
      changed = true;
    }
  }

  const sids = Object.keys(list);
  if (sids.length > MAX_SESSIONS) {
    // 按 at 升序淘汰最老的（at 相同则按 sid 排序，保证结果稳定）
    sids.sort((a, b) => {
      const ta = (list[a] && list[a].at) || 0;
      const tb = (list[b] && list[b].at) || 0;
      return ta === tb ? (a < b ? -1 : 1) : ta - tb;
    });
    const excess = sids.slice(0, sids.length - MAX_SESSIONS);
    excess.forEach((sid) => { delete list[sid]; });
    changed = true;
  }

  if (changed) save();
  return changed;
}

// 登录时登记一个新会话，返回 sid（写进 JWT 的 sid 声明）。
// dbSlug 是账号维度：.sessions.json 是全局一份，各账号库里 users.id 都可能是 1，
// 只记 userId 无法区分账号（改 A 账号密码会把 B 账号一起踢下线）。
function create(userId, dbSlug = null) {
  const list = load();
  const sid = crypto.randomBytes(24).toString('hex');
  list[sid] = {
    userId: userId == null ? null : userId,
    dbSlug: dbSlug == null ? null : String(dbSlug),
    at: Date.now(),
  };
  prune();
  save();
  return sid;
}

// 校验会话是否仍在名单里（每次请求走内存缓存，无文件 IO）
// 命中即表示「这个会话刚刚还在用」→ 刷新 at（节流落盘）。
// at 不刷新的话 prune 会把持续活跃的会话当成弃用会话清掉，与 JWT 滑动续期直接矛盾。
function has(sid) {
  if (!sid) return false;
  const list = load();
  if (!Object.prototype.hasOwnProperty.call(list, sid)) return false;

  const rec = list[sid];
  const prevAt = rec && typeof rec.at === 'number' ? rec.at : 0;
  const now = Date.now();
  if (now - prevAt > TOUCH_INTERVAL_MS) {
    // 兼容旧的/损坏的 rec：保留 userId 与账号维度，at 统一写成数字。
    // dbSlug 丢了会让改密吊销退回到「只按 userId」→ 误踢其它账号，必须原样带过去。
    list[sid] = {
      userId: rec && rec.userId != null ? rec.userId : null,
      dbSlug: rec && rec.dbSlug != null ? rec.dbSlug : null,
      at: now,
    };
    save();
  }
  return true;
}

// 切班：把某个会话的当前班级换掉（sid 不变，由调用方用新 dbSlug 重签 token）。
// 不能「吊销 + 新建」：切班不是凭证变更，没有安全理由把同窗口踢下线，
// 吊销还会连带作废媒体凭据（<img> 的 token 绑同一个 sid），表现为切完班图片全裂。
// 返回 false 表示该 sid 已不在名单里（会话过期/已登出），调用方应让用户重新登录。
function setSlug(sid, dbSlug) {
  const list = load();
  if (!sid || !Object.prototype.hasOwnProperty.call(list, sid)) return false;
  const rec = list[sid];
  if (!rec) return false;
  rec.dbSlug = dbSlug == null ? null : String(dbSlug);
  save();
  return true;
}

// 主动退出：吊销该会话，原 token 立即失效
function revoke(sid) {
  const list = load();
  if (!sid || !Object.prototype.hasOwnProperty.call(list, sid)) return false;
  delete list[sid];
  save();
  return true;
}

// 按账号维度吊销全部会话：改密 / 恢复词重置 / 删账号后，该账号在其它窗口签发的
// 旧 token 必须立即失效，不能留到 JWT 到期（30 天）或 TTL（35 天）。
//
// 双键 (userId, dbSlug)：名单是全局一份，各账号库里 users.id 都可能为 1。
// 记录带 dbSlug 时精确匹配；升级前签发的旧记录没有 dbSlug，按 userId 保守纳入
// （宁可多退一次登录，也不留一个改密后仍可读写数据的旧 token）。
// 两个维度任一为空都直接返回 0 —— 否则「undefined === undefined」会把整张名单清空。
function revokeAllByUser(userId, dbSlug) {
  if (userId == null || dbSlug == null) return 0;
  const slug = String(dbSlug);
  const list = load();
  let revoked = 0;
  for (const [sid, rec] of Object.entries(list)) {
    if (!rec || rec.userId !== userId) continue;
    if (rec.dbSlug != null && rec.dbSlug !== slug) continue;
    delete list[sid];
    revoked += 1;
  }
  if (revoked) save();
  return revoked;
}

module.exports = {
  create, has, revoke, prune, revokeAllByUser, setSlug,
  SESSION_TTL_MS, MAX_SESSIONS,
  // —— 以下仅供单元测试构造场景，生产代码不要用 ——
  __test_insert: (sid, userId, at, dbSlug) => {
    const list = load();
    list[sid] = {
      userId: userId == null ? null : userId,
      dbSlug: dbSlug == null ? null : String(dbSlug),
      at,
    };
    save();
    return true;
  },
  __test_size: () => Object.keys(load()).length,
  __test_get: (sid) => {
    const list = load();
    const rec = list[sid];
    return rec ? { ...rec } : null;
  },
};
