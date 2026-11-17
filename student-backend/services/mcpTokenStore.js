// =========================================================================
// mcpTokenStore.js —— MCP 服务端访问令牌（方向 B）
//
// 令牌是「应用级」配置，不是某个班级库里的数据，所以存在 core/.mcp-tokens.json，
// 与 .jwt-secret / .sessions.json 同级：打包后随 userData 持久化、不进 asar。
//
// 设计要点：
//   1. 只存 token 的 sha256，不存明文。明文只在「创建时返回一次」+ 转发器配置里出现。
//   2. 每个 token 绑定一个 dbSlug——MCP 工具执行时用 withDb(slug) 打开对应加密库，
//      这样外部 MCP 客户端拿不到主密钥，也碰不到别的班级。
//   3. 与 JWT 体系完全隔离：MCP token 不走 secureChannel，也不签 JWT。
//      它是「本地进程拿 URL+token 直连」的独立入口，权限由工具白名单 + 绑定 slug 约束。
//   4. 文件名带随机后缀无意义（路径固定），靠 mode 0o600 + core 目录权限保护。
// =========================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbManager = require('../dbManager/dbManager');

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

// 生成新 token：返回明文（仅此一次）与元信息。
// slug 必须存在——令牌绑定的班级库必须真实存在，否则工具执行时会开库失败。
function create({ slug, label = '' } = {}) {
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
    revoked_at: null,
  };
  const list = readAll().filter((x) => x.hash !== item.hash);
  list.push(item);
  writeAll(list);
  return { token, id: item.hash.slice(0, 12), slug, label: item.label, created_at: item.created_at };
}

// 验证 token → { ok, slug, id }。撤销的 / 不存在的都返回 ok:false。
function verify(token) {
  if (!token || typeof token !== 'string' || token.length < 16) return { ok: false };
  const hash = hashToken(token);
  const item = readAll().find((x) => x.hash === hash && !x.revoked_at);
  if (!item) return { ok: false };
  return { ok: true, slug: item.slug, id: item.hash.slice(0, 12), label: item.label };
}

function list() {
  return readAll().map((x) => ({
    id: x.hash.slice(0, 12),
    slug: x.slug,
    label: x.label,
    created_at: x.created_at,
    revoked: !!x.revoked_at,
  }));
}

// 撤销：按短 id 或完整 hash 前缀匹配，避免明文出现在调用侧。
function revoke(id) {
  if (!id || typeof id !== 'string') return false;
  const list = readAll();
  let changed = false;
  for (const x of list) {
    if ((x.hash.slice(0, 12) === id || x.hash === id) && !x.revoked_at) {
      x.revoked_at = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) writeAll(list);
  return changed;
}

module.exports = { create, verify, list, revoke, hashToken, FILE };
