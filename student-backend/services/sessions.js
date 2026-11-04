const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dbManager = require('../dbManager/dbManager');

// 有效登录会话名单（sid）：JWT 里只带一个随机 sid，服务端按这份名单校验。
// 「不主动退出就一直有效」+「退出后原 token 立即失效」都由此实现——
// 退出时把 sid 从名单里删掉，那个 token 下一次请求就验不过了。
// 名单持久化到 dataDir（随 userData 保留），重启后端不会把所有人登出。
const FILE = () => path.join(dbManager.dataDir, '.sessions.json');

// 会话名单的保留期与容量上限。
//
// 名单里的 sid 对应的 JWT 最长活 30 天（JWT exp + 滑动续期）。但**名单本身**没人清：
// revoke 只在「主动登出」时删一个 sid，其余 sid 会永久留在 .sessions.json 里 ——
// 每登录一次涨一条，文件单调增长。
//
// TTL 取 35 天（比 JWT 的 30 天略宽）：滑动续期的活跃会话每次请求都会把 JWT 续到
// 新的 30 天，但**名单里那条记录的 at 不会跟着更新**（名单不是 token 续期机制的一部分）。
// 所以 TTL 必须大于 30 天，否则一个持续活跃的会话会被误清 —— 用户正在用却被登出。
// 35 天意味着「最后一次见到这个 sid 超过 35 天」才清理，实际上只有真正弃用的会话会走这条路。
const SESSION_TTL_MS = 35 * 24 * 60 * 60 * 1000;

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

// 登录时登记一个新会话，返回 sid（写进 JWT 的 sid 声明）
function create(userId) {
  const list = load();
  const sid = crypto.randomBytes(24).toString('hex');
  list[sid] = { userId: userId == null ? null : userId, at: Date.now() };
  prune();
  save();
  return sid;
}

// 校验会话是否仍在名单里（每次请求走内存缓存，无文件 IO）
function has(sid) {
  if (!sid) return false;
  return Object.prototype.hasOwnProperty.call(load(), sid);
}

// 主动退出：吊销该会话，原 token 立即失效
function revoke(sid) {
  const list = load();
  if (!sid || !Object.prototype.hasOwnProperty.call(list, sid)) return false;
  delete list[sid];
  save();
  return true;
}

module.exports = {
  create, has, revoke, prune,
  SESSION_TTL_MS, MAX_SESSIONS,
  // —— 以下仅供单元测试构造场景，生产代码不要用 ——
  __test_insert: (sid, userId, at) => {
    const list = load();
    list[sid] = { userId: userId == null ? null : userId, at };
    save();
    return true;
  },
  __test_size: () => Object.keys(load()).length,
};
