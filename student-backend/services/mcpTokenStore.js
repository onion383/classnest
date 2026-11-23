// =========================================================================
// mcpTokenStore.js —— MCP 服务端访问令牌（方向 B）
//
// 令牌是「应用级」配置，不是某个班级库里的数据，所以存在 core/.mcp-tokens.json，
// 与 .jwt-secret / .sessions.json 同级：打包后随 userData 持久化、不进 asar。
//
// 设计要点：
//   1. core/.mcp-tokens.json 只存 hash→slug 索引，不存明文。鉴权 verify() 只读这个文件，
//      不需要打开加密班级库——外网请求进来第一时间就能判 token 真假/绑定哪个库。
//   2. 令牌明文存在**它绑定的那个加密班级库**的 mcp_tokens 表（主密钥保护）。core 文件
//      打不开班级库，所以「复制令牌」必须 withDb(slug) 读库。这样刷新页面后仍能复制，
//      而不是像以前那样只在创建瞬间展示一次、丢了只能撤销重建。
//   3. 每个 token 绑定一个 dbSlug——MCP 工具执行时用 withDb(slug) 打开对应加密库，
//      这样外部 MCP 客户端拿不到主密钥，也碰不到别的班级。
//   4. 与 JWT 体系完全隔离：MCP token 不走 secureChannel，也不签 JWT。
//      它是「本地进程拿 URL+token 直连」的独立入口，权限由工具白名单 + 绑定 slug 约束。
//   5. 文件名带随机后缀无意义（路径固定），靠 mode 0o600 + core 目录权限保护。
//   6. 令牌可设有效期：validDays → core 索引里的 expires_at。verify 只读 core 就能判
//      过期，不开库；老令牌没有 expires_at，一律视为不过期（向后兼容）。
//
// 一致性：core 索引与 DB 明文是跨库两写，无单一事务。create 先写 DB 明文再写索引，
// 索引写失败则补偿删 DB；getPlain 只认「core 索引存在且未撤销 + DB 有明文」的交集。
// =========================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbManager = require('../dbManager/dbManager');
const { db } = require('../db');

const FILE = path.join(dbManager.coreDir, '.mcp-tokens.json');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function writeAll(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { encoding: 'utf8', mode: 0o600 });
}

// 有效期只认界面给的五档，别的（缺省/负数/乱填）一律按「不过期」处理。
const VALID_DAYS = [1, 2, 30, 180, 365];
function expiryFromDays(validDays) {
  const days = Number(validDays);
  if (!VALID_DAYS.includes(days)) return null;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

// 过期判定：expires_at 缺失/不可解析都当不过期，避免老令牌或脏数据被误杀。
function expired(item, now = Date.now()) {
  if (!item.expires_at) return false;
  const t = Date.parse(item.expires_at);
  return !Number.isNaN(t) && t <= now;
}

// 生成新 token：core 索引只写 hash→slug；明文写进绑定库的 mcp_tokens。
// 两步跨库无单一事务：先写 DB 明文，索引写失败就补偿删 DB，避免留下「鉴权认、却复制不出」的半吊子令牌。
// slug 必须存在——令牌绑定的班级库必须真实存在，否则工具执行时会开库失败。
function create({ slug, label = '', validDays = 0 } = {}) {
  if (!slug || typeof slug !== 'string') throw new Error('缺少 slug');
  // 校验 slug 对应库确实登记过，避免生成永远用不了的 token
  const rec = dbManager.registryFindBySlug(slug);
  if (!rec) throw new Error('班级库不存在: ' + slug);

  const token = 'mcp_' + crypto.randomBytes(32).toString('hex');
  const item = {
    hash: hashToken(token),
    slug,
    label: String(label).slice(0, 80),
    created_at: new Date().toISOString(),
    expires_at: expiryFromDays(validDays),
    revoked_at: null,
  };
  // 第 1 步：明文副本写进加密班级库（db Proxy 在 withDb 上下文里指向该库）。
  dbManager.withDb(slug, () => {
    db.prepare(`INSERT OR REPLACE INTO mcp_tokens (hash, token_plain, slug, label, created_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(item.hash, token, slug, item.label, item.created_at, item.expires_at);
  });
  // 第 2 步：core 索引。失败则补偿删掉刚写的明文副本。
  try {
    const list = readAll().filter((x) => x.hash !== item.hash);
    list.push(item);
    writeAll(list);
  } catch (e) {
    try { dbManager.withDb(slug, () => db.prepare('DELETE FROM mcp_tokens WHERE hash = ?').run(item.hash)); }
    catch (_) { /* 补偿也失败时留给下次清理，不能吞掉原始错误 */ }
    throw e;
  }
  return { token, id: item.hash.slice(0, 12), slug, label: item.label, created_at: item.created_at, expires_at: item.expires_at };
}

// 取明文供「复制令牌」。必须同时满足：core 索引里该 id 未撤销、且绑定 slug 与调用方一致
// （防止拿 A 班的 id 读 B 班明文），再从班级库读 token_plain。老的、没有明文副本的令牌返回 null。
function getPlain(id, slug) {
  if (!id || typeof id !== 'string') return null;
  const item = readAll().find((x) => (x.hash.slice(0, 12) === id || x.hash === id));
  if (!item || item.revoked_at || expired(item)) return null;
  if (slug && item.slug !== slug) return null;
  try {
    const row = dbManager.withDb(item.slug, () => db.prepare('SELECT token_plain FROM mcp_tokens WHERE hash = ?').get(item.hash));
    return row && row.token_plain ? row.token_plain : null;
  } catch (_) {
    return null; // 库打不开 / 老库没这张表：没有明文可复制
  }
}

// 验证 token → { ok, slug, id }。撤销的 / 不存在的都返回 ok:false。
function verify(token) {
  if (!token || typeof token !== 'string' || token.length < 16) return { ok: false };
  const hash = hashToken(token);
  const item = readAll().find((x) => x.hash === hash && !x.revoked_at);
  if (!item || expired(item)) return { ok: false };
  return { ok: true, slug: item.slug, id: item.hash.slice(0, 12), label: item.label };
}

function list() {
  return readAll().map((x) => ({
    id: x.hash.slice(0, 12),
    slug: x.slug,
    label: x.label,
    created_at: x.created_at,
    expires_at: x.expires_at || null,
    revoked: !!x.revoked_at,
  }));
}

// 撤销：按短 id 或完整 hash 前缀匹配，避免明文出现在调用侧。
// core 索引标 revoked 后 verify 会拒；同时清掉班级库里的明文，撤销了就不该还能复制出来。
// 记录仍留在 core 索引里（revoked 标记），界面据此显示「已失效」。
function revoke(id, slug) {
  if (!id || typeof id !== 'string') return false;
  const list = readAll();
  let changed = false;
  for (const x of list) {
    // 必须限定当前班级：令牌短 id 是 hash 前缀，其它班持有者也能猜到/看到 id，
    // 不限 slug 就能撤销别的班的令牌（跨班越权）。与 getPlain 同口径。
    if (slug && x.slug !== slug) continue;
    if ((x.hash.slice(0, 12) === id || x.hash === id) && !x.revoked_at) {
      x.revoked_at = new Date().toISOString();
      changed = true;
      try { dbManager.withDb(x.slug, () => db.prepare('DELETE FROM mcp_tokens WHERE hash = ?').run(x.hash)); }
      catch (_) { /* 班级库暂时打不开不阻断撤销：core 已 revoked，鉴权层已生效 */ }
    }
  }
  if (changed) writeAll(list);
  return changed;
}

// 彻底删除记录：从 core 索引里整条抹掉，界面列表不再显示。
// 与 revoke 的区别：revoke 只标记失效、留条目供追溯；remove 是「去除记录」。
// 只允许删已经撤销/过期的令牌，活着的有效令牌要先走 revoke，避免误删后失去追溯。
function remove(id, slug) {
  if (!id || typeof id !== 'string') return false;
  const all = readAll();
  const hit = all.find((x) => (x.hash.slice(0, 12) === id || x.hash === id) && (!slug || x.slug === slug));
  if (!hit || (!hit.revoked_at && !expired(hit))) return false;
  writeAll(all.filter((x) => x !== hit));
  // 明文行一般已在 revoke 时清掉；这里再兜一次，幂等无副作用。
  try { dbManager.withDb(hit.slug, () => db.prepare('DELETE FROM mcp_tokens WHERE hash = ?').run(hit.hash)); }
  catch (_) { /* 班级库打不开不阻断：core 条目已删，鉴权层已彻底不认 */ }
  return true;
}

module.exports = { create, verify, list, getPlain, revoke, remove, hashToken, FILE };
