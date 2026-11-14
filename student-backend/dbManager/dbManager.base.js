// =========================================================================
// dbManager.base.js —— 多库加密核心·基础层
// （原 dbManager.js 按职责拆分而来，纯代码搬运，行为不变）
//   主密钥 / 数据目录与资源目录 / 密钥包裹与解包 / 请求上下文与连接缓存
//   连接基础原语（性能 pragma、打开文件）/ index.db 登记表
// =========================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { normalizePhrase } = require('../services/recoveryKey');
const { BACKEND_ROOT } = require('../utils/backendRoot');

// 原生模块懒加载：后端子进程启动时不加载 .node 二进制，首次真正需要打开
// 数据库时才 require，缩短 app.listen 就绪信号的时间，让主窗口更早出现。
let Database = null;
function getDatabase() {
  if (!Database) Database = require('better-sqlite3-multiple-ciphers');
  return Database;
}

// 加载 .env（若存在），使密钥可从配置文件读取而不硬编码
// 注意：.env 与数据目录都在 student-backend/ 层，bundle 后 __dirname 语义会变，故走 BACKEND_ROOT。
(function loadEnvFile() {
  const envFile = path.join(BACKEND_ROOT, '.env');
  try {
    const content = fs.readFileSync(envFile, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch (_) { /* .env 不存在则忽略 */ }
})();

// ---------- 主密钥 ----------
const MASTER_KEY = process.env.DB_MASTER_KEY;
if (!MASTER_KEY) {
  throw new Error('未配置主密钥 DB_MASTER_KEY（请设置环境变量或 student-backend/.env）');
}
// 主密钥派生为 AES-256 包裹密钥
const WRAP_KEY = crypto.createHash('sha256').update(MASTER_KEY).digest();

// 数据目录分层布局（v2）的唯一定义处是 dbManager.paths.js。这里只做转发并重新导出，
// 让既有 require('./dbManager.base') 的调用点保持不变；**不要再 path.join(dataDir, ...)**，
// 所有具体路径请从 paths / dbManager 门面取常量。
const paths = require('./dbManager.paths');
const {
  dataDir, coreDir, contentDir, cacheDir, logsDir, ensureDir,
  indexPath, dbMasterKeyPath, jwtSecretPath, sessionsPath, lastDbPath, dbFilePath,
  uploadsDir, backgroundDir, thumbsDir, trashDir, receiptTrashDir,
  snapshotsDirRoot, snapshotsDir, memoryDir, skillsDirRoot, skillsDir,
  ffmpegCacheDir, backendLogPath, startupLogPath, inpLogPath,
} = paths;

// ---------- 库密钥 包裹/解包 ----------
// wrapped = base64(iv).base64(tag).base64(ciphertext)
function wrapWithKey(wKey, plainKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wKey, iv);
  const enc = Buffer.concat([cipher.update(plainKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map(b => b.toString('base64')).join('.');
}

function unwrapWithKey(wKey, wrapped) {
  const [ivB, tagB, encB] = String(wrapped || '').split('.');
  if (!ivB || !tagB || !encB) throw new Error('invalid wrapped key');
  const decipher = crypto.createDecipheriv('aes-256-gcm', wKey, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
}

function wrapKey(plainKey) {
  return wrapWithKey(WRAP_KEY, plainKey);
}

function unwrapKey(wrapped) {
  return unwrapWithKey(WRAP_KEY, wrapped);
}

// ---------- 超级隐私模式：库钥匙改由「登录密码 / 恢复词」包裹 ----------
// 开启后 registry.wrapped_key 置空，主密钥再也解不出库钥匙：拷走 db-master.key + 库文件，
// 没有登录密码或恢复词就打不开。口令不落盘，解锁结果只存内存 unlockedKeys，登出即丢。
// 派生用 scrypt 而非单次 SHA256：离线拿到 wrapped 密文时爆破成本足够高。
// 密码与恢复词各用独立 salt，改密码不会让已抄写的恢复词失效。
// 成本参数：N=2^17（约 128MB 内存、本机实测 ~0.2s）。默认 maxmem 只有 32MB，
// 必须按 N/r 显式放宽，否则 scryptSync 会直接抛错。
// 每个账号把实际使用的参数记在 registry 里（密码/恢复词各一列），解锁按登记行的参数派生。
const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1 };
const SCRYPT_LEN = 32;

function newPrivacySalt() {
  return crypto.randomBytes(16).toString('base64');
}

// 把登记行里的参数（JSON 字符串 / 对象 / 空值）还原成 scrypt 选项。
// 空值或损坏一律回退当前默认参数；maxmem 不信任存下来的值，按 N/r 现算。
function normalizeScryptParams(raw) {
  const fallback = () => ({ ...SCRYPT_PARAMS, maxmem: 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2 });
  let parsed = raw;
  if (typeof raw === 'string') {
    if (!raw) return fallback();
    try { parsed = JSON.parse(raw); } catch (_) { return fallback(); }
  }
  if (!parsed || typeof parsed !== 'object') return fallback();
  const N = Number(parsed.N);
  const r = Number(parsed.r);
  const p = Number(parsed.p);
  // 上限防止被改坏的登记行把内存拉爆（宁可解锁失败，也不要 OOM）
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)
    || N < 1024 || N > (1 << 19) || r < 1 || r > 32 || p < 1 || p > 16) {
    return fallback();
  }
  return { N, r, p, maxmem: Math.max(32 * 1024 * 1024, 128 * N * r * 2) };
}

function serializeScryptParams(params) {
  const { N, r, p } = normalizeScryptParams(params || SCRYPT_PARAMS);
  return JSON.stringify({ N, r, p });
}

function derivePrivacyKey(secret, saltB64, params) {
  return crypto.scryptSync(
    String(secret),
    Buffer.from(String(saltB64), 'base64'),
    SCRYPT_LEN,
    normalizeScryptParams(params)
  );
}

function wrapKeyByPrivacySecret(plainKey, secret, saltB64, params) {
  return wrapWithKey(derivePrivacyKey(secret, saltB64, params || SCRYPT_PARAMS), plainKey);
}

function unwrapKeyByPrivacySecret(wrapped, secret, saltB64, params) {
  return unwrapWithKey(derivePrivacyKey(secret, saltB64, params), wrapped);
}

// 内存解锁表：slug -> 库钥匙明文。只在进程内存在，不写盘；登出/退出应用即释放。
const unlockedKeys = new Map();
// 解锁来源（password / mnemonic）：用于「恢复词登录后重设密码」时免输已忘记的旧密码
const unlockSources = new Map();
function setUnlockedKey(slug, key, source) {
  if (!slug || !key) return;
  unlockedKeys.set(slug, key);
  if (source) unlockSources.set(slug, source);
}
function getUnlockedKey(slug) { return unlockedKeys.get(slug) || null; }
function getUnlockSource(slug) { return unlockSources.get(slug) || null; }
function clearUnlockedKey(slug) { unlockedKeys.delete(slug); unlockSources.delete(slug); }
function clearAllUnlockedKeys() { unlockedKeys.clear(); unlockSources.clear(); }

// ---------- 用户绑定钥匙（v2 便携备份） ----------
// 以「用户的密码/助记词」派生一把 AES 包裹钥匙，把库钥匙加密成密文装进备份包。
// 这样备份包不再依赖服务端主密钥：换台电脑、.env 完全不一样，只要本人知道密码/助记词即可解包。
// 规则：密码原样参与派生；助记词先归一化(只留汉字,兼容序号/空格)再派生，保证两边一致。
function deriveBundleWrapKey(secret) {
  return crypto.createHash('sha256').update('bundle:' + secret).digest();
}

// wrapPlainKeyBySecret(plainKey, secret) -> base64(iv).base64(tag).base64(密文)
function wrapKeyBySecret(plainKey, secret) {
  const wKey = deriveBundleWrapKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wKey, iv);
  const enc = Buffer.concat([cipher.update(plainKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map(b => b.toString('base64')).join('.');
}

function unwrapKeyBySecret(wrapped, secret) {
  const [ivB, tagB, encB] = wrapped.split('.');
  const wKey = deriveBundleWrapKey(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', wKey, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
}

// 从 v2 备份包里解出库钥匙：明文 key（无密码账号）优先级最高，否则用密码或助记词任一对上即可（AES-GCM 校验失败的密文在 try 里直接跳过）。
function decryptBundleKey({ key, wrappedByPassword, wrappedByMnemonic, password, mnemonic }) {
  if (key) return key;
  if (wrappedByPassword && password) {
    try { return unwrapKeyBySecret(wrappedByPassword, password); } catch (_) { /* 密码不对，尝试助记词 */ }
  }
  if (wrappedByMnemonic && mnemonic) {
    try { return unwrapKeyBySecret(wrappedByMnemonic, normalizePhrase(mnemonic)); } catch (_) { /* 助记词不对 */ }
  }
  throw new Error('无法解锁备份：密码或助记词不正确');
}

function sqlKey(passphrase) {
  return passphrase.replace(/'/g, "''");
}

// ---------- 请求上下文绑定 ----------
const als = new AsyncLocalStorage();
// 缓存已打开的库连接：slug -> { db, key }
const connCache = new Map();
// 缓存连接数量上限（LRU 驱逐策略：超过上限时关闭并移出最久未使用的连接）
const CONN_CACHE_MAX = 10;
// 硬顶：全部连接都在用时允许临时超限，但不能无限增长（N 个账号并发会把 RSS 按连接数放大）。
// 达到硬顶且没有可驱逐的空闲连接时，拒绝新库连接，由调用方提示「稍后重试」。
const CONN_CACHE_HARD_MAX = CONN_CACHE_MAX * 3;
// 每个库当前「正在被请求使用」的计数（见 withDb）：
// 驱逐时跳过计数 > 0 的连接，否则会把仍在执行查询的连接 close() 掉（B04-01）。
const connUseCount = new Map();

// 记录对某连接的访问（命中时刷新 LRU 顺序）
function touchConn(slug) {
  if (connCache.has(slug)) {
    const conn = connCache.get(slug);
    connCache.delete(slug);
    connCache.set(slug, conn);
  }
}

// 请求开始/结束使用某库连接（成对调用；withDb 已包好，业务侧不用管）
// 是否仍有请求持有该库连接。evictConn 用它决定能不能关（见 dbManager.conn.js）
function isConnInUse(slug) {
  return (connUseCount.get(slug) || 0) > 0;
}

function beginConnUse(slug) {
  connUseCount.set(slug, (connUseCount.get(slug) || 0) + 1);
}
function endConnUse(slug) {
  const n = (connUseCount.get(slug) || 0) - 1;
  if (n > 0) connUseCount.set(slug, n);
  else connUseCount.delete(slug);
}

// 写入缓存，超限时按 LRU 驱逐最久未使用的连接。
// 正在被请求使用的连接不驱逐：直接 close() 会让在途查询抛「database is closed」。
// 若候选全都在用，允许在上限与硬顶之间暂时超出，超过硬顶则拒绝新连接。
function setCachedConn(slug, conn) {
  connCache.set(slug, conn);
  let guard = 0;
  while (connCache.size > CONN_CACHE_MAX && guard++ < CONN_CACHE_MAX * 2) {
    const oldestKey = connCache.keys().next().value;
    if (oldestKey == null) break;
    // 刚插入的这条也不能驱逐：getConn 是先 setCachedConn 再交给 withDb 的，
    // 此刻它的使用计数还是 0，按「空闲最旧」淘汰会把调用方马上要用的连接直接 close。
    if (oldestKey === slug || (connUseCount.get(oldestKey) || 0) > 0) {
      // 只把顺序挪到末尾（下一次优先淘汰别的），不关闭连接
      const keep = connCache.get(oldestKey);
      connCache.delete(oldestKey);
      connCache.set(oldestKey, keep);
      continue;
    }
    const evicted = connCache.get(oldestKey);
    connCache.delete(oldestKey);
    try { evicted.close(); } catch (_) { /* 关闭失败可忽略 */ }
  }
  // 全部在用、没有空闲可驱逐时，硬顶兜底：拒绝本次新连接，避免连接数无限增长。
  if (connCache.size > CONN_CACHE_HARD_MAX) {
    if (connCache.get(slug) === conn) connCache.delete(slug);
    throw new Error('同时打开的数据库连接过多，请稍后重试');
  }
}

// 仅测试使用：连接缓存是进程级单例，用例之间必须显式归零，避免互相污染。
function _resetConnCacheForTest() {
  for (const conn of connCache.values()) {
    try { conn.close(); } catch (_) { /* best-effort: 测试清理 */ }
  }
  connCache.clear();
  connUseCount.clear();
}

// ---------- 打开/创建 单个班主任库 ----------
// （基础原语层：完整的打开/创建流程见 dbManager.conn.js）
function applyPerfPragmas(conn) {
  // WAL：读写不互斥、大幅减少 fsync；synchronous=NORMAL 兼顾安全与性能；
  // cache_size=-20000（约20MB页缓存）；busy_timeout 避免并发写互相报锁；temp_store 放内存。
  // 先设 busy_timeout 再开 WAL，避免切换日志模式期间的锁等待。
  conn.pragma('busy_timeout = 5000');
  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('cache_size = -20000');
  conn.pragma('temp_store = MEMORY');
}

function openFile(dbPath, passphrase, encrypted = true) {
  const Database = getDatabase();
  const conn = new Database(dbPath);
  // 明文库（宽松模式）没有库钥匙，不能下发 pragma key，否则会被当作加密库而打不开
  if (encrypted) conn.pragma(`key = '${sqlKey(passphrase)}'`);
  applyPerfPragmas(conn);
  return conn;
}

// ---------- index.db（主密钥加密的登记表） ----------
let indexDb = null;

function ensureIndex() {
  if (indexDb) return indexDb;
  const Database = getDatabase();
  indexDb = new Database(indexPath);
  indexDb.pragma(`key = '${sqlKey(MASTER_KEY)}'`);
  applyPerfPragmas(indexDb);
  indexDb.exec(`
    CREATE TABLE IF NOT EXISTS registry (
      slug TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      wrapped_key TEXT NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 1,
      protect INTEGER NOT NULL DEFAULT 0,
      wrapped_by_password TEXT NOT NULL DEFAULT '',
      wrapped_by_mnemonic TEXT NOT NULL DEFAULT '',
      kdf_salt TEXT NOT NULL DEFAULT '',
      mnemonic_salt TEXT NOT NULL DEFAULT '',
      kdf_params_password TEXT NOT NULL DEFAULT '',
      kdf_params_mnemonic TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  ensureAccountsSchema(indexDb);
  return indexDb;
}

// ---------- 多班级：账号表 ----------
// 原设计是「一个账号 = 一个库 = 一个班级」，账号凭证存在各库自己的 users 表里。
// 支持「一个账号多个班级」后，同一个用户名会对应多个 slug（registry 里多行），于是需要
// 一个库外的稳定账号标识和统一的密码校验位置：
//   accounts.id            —— 稳定主键，改用户名不影响班级归属
//   accounts.password_hash —— 登录校验的唯一依据（各库 users 表降级为「该库属于谁」的标记）
// registry.account_id 指向它；registry.class_name 供登录时列班级（那时还没开库）。
//
// 幂等：表用 IF NOT EXISTS，列用 PRAGMA 探测后补（SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS）。
// 全内存操作，实测亚毫秒，放在启动关键路径上无影响。
function ensureAccountsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'teacher',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const cols = new Set(db.prepare('PRAGMA table_info(registry)').all().map((r) => r.name));
  if (!cols.has('account_id')) {
    db.exec('ALTER TABLE registry ADD COLUMN account_id INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.has('class_name')) {
    db.exec("ALTER TABLE registry ADD COLUMN class_name TEXT NOT NULL DEFAULT ''");
  }
}

// ---------- index.db 操作 ----------
function registryFindByUsername(username) {
  ensureIndex();
  // 多班级：同一用户名会有多行（一库一行）。加 ORDER BY 让「取第一条」确定下来 ——
  // 否则 SQLite 返回顺序未定义，登录时默认进哪个班可能每次都不一样。
  // 排序取「最早创建的那个班」作为默认班（用户在设置弹窗里切换后由 token 里的 dbSlug 接管）。
  return indexDb
    .prepare('SELECT * FROM registry WHERE username = ? ORDER BY created_at, slug LIMIT 1')
    .get(username);
}

function registryFindBySlug(slug) {
  ensureIndex();
  return indexDb.prepare('SELECT * FROM registry WHERE slug = ?').get(slug);
}

function registryUpsert(slug, username, wrappedKey, encrypted = 1) {
  ensureIndex();
  indexDb.prepare(`
    INSERT INTO registry(slug, username, wrapped_key, encrypted) VALUES (?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET username = excluded.username, wrapped_key = excluded.wrapped_key, encrypted = excluded.encrypted
  `).run(slug, username, wrappedKey, encrypted ? 1 : 0);
}

// 仅切换某库的加密标记（明文化时保留原 wrapped_key 作占位，NOT NULL 约束不允许置空）
function registrySetEncrypted(slug, encrypted) {
  ensureIndex();
  indexDb.prepare('UPDATE registry SET encrypted = ? WHERE slug = ?').run(encrypted ? 1 : 0, slug);
}

// 改账号名：只更新 registry.username 一列。
//
// 为什么不能复用 registryUpsert：它的 ON CONFLICT 子句会连带覆盖
// wrapped_key / encrypted —— 而 wrapped_key 是**库钥匙的主密钥包裹**，
// 一旦被写坏，该库将永远解不开（等于数据报废）。改用户名与钥匙无关，
// 因此这里单独提供一个「只动 username」的窄接口。
//
// 定位用 slug（主键，不随用户名变），返回受影响行数供调用方判断是否真的改到。
function registryRename(slug, newUsername) {
  ensureIndex();
  const info = indexDb.prepare('UPDATE registry SET username = ? WHERE slug = ?').run(newUsername, slug);
  return info.changes;
}

// 从 index 登记表移除账号（删除账号用）
function registryDelete(slug) {
  ensureIndex();
  indexDb.prepare('DELETE FROM registry WHERE slug = ?').run(slug);
}

// 列出所有已登记的班主任账号（供登录页「从数据库注册」加载账号）
function registryList() {
  ensureIndex();
  return indexDb.prepare('SELECT slug, username, protect FROM registry ORDER BY created_at').all();
}

// ---------- 多班级：registry 侧查询与归属 ----------
// 某个用户名名下的全部班级（registry 一库一行）。用 username 兜底是为了迁移前后都能列全：
// 迁移只回填 account_id，不改 username，所以哪怕还没回填也能靠它找齐。
function registryFindAllByUsername(username) {
  ensureIndex();
  return indexDb.prepare('SELECT * FROM registry WHERE username = ? ORDER BY created_at, slug').all(username);
}

// 某个账号名下的全部班级（登录后列班级列表用）
function registryFindByAccount(accountId) {
  ensureIndex();
  return indexDb.prepare(
    'SELECT slug, username, class_name, account_id, protect, encrypted FROM registry WHERE account_id = ? ORDER BY created_at, slug'
  ).all(accountId);
}

// 把库归属到账号。className 传 undefined 表示只改归属不动班名。
// 迁移与「新建班级」共用这一个入口，避免两处写不一样的 SQL。
function registrySetAccount(slug, accountId, className) {
  ensureIndex();
  if (className === undefined) {
    indexDb.prepare('UPDATE registry SET account_id = ? WHERE slug = ?').run(accountId, slug);
  } else {
    indexDb.prepare('UPDATE registry SET account_id = ?, class_name = ? WHERE slug = ?').run(accountId, className, slug);
  }
}

// 改班级名（用户在设置弹窗里改班名时调用；只动 class_name 这一列）
function registrySetClassName(slug, className) {
  ensureIndex();
  indexDb.prepare('UPDATE registry SET class_name = ? WHERE slug = ?').run(className, slug);
}

// ---------- 多班级：accounts 侧 ----------
function accountFindByUsername(username) {
  ensureIndex();
  return indexDb.prepare('SELECT * FROM accounts WHERE username = ?').get(username);
}

function accountFindById(id) {
  ensureIndex();
  return indexDb.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

function accountCreate(username, passwordHash, role = 'teacher') {
  ensureIndex();
  const info = indexDb
    .prepare('INSERT INTO accounts(username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, passwordHash, role);
  return Number(info.lastInsertRowid);
}

function accountSetPassword(accountId, passwordHash) {
  ensureIndex();
  indexDb.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(passwordHash, accountId);
}

function accountRename(accountId, newUsername) {
  ensureIndex();
  indexDb.prepare('UPDATE accounts SET username = ? WHERE id = ?').run(newUsername, accountId);
}

function accountDelete(accountId) {
  ensureIndex();
  indexDb.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
}

// 开启超级隐私模式：写入两份口令包裹的库钥匙，并抹掉主密钥包裹的 wrapped_key。
// 此后没有登录密码/恢复词，任何路径（包括持有 db-master.key）都解不出库钥匙。
// kdfParamsPassword / kdfParamsMnemonic 分别记录两份包裹实际使用的 scrypt 参数。
function registrySetPrivacy(slug, {
  passwordSalt, mnemonicSalt, wrappedByPassword, wrappedByMnemonic,
  kdfParamsPassword = '', kdfParamsMnemonic = '',
}) {
  ensureIndex();
  indexDb.prepare(`
    UPDATE registry SET protect = 1, kdf_salt = ?, mnemonic_salt = ?,
      kdf_params_password = ?, kdf_params_mnemonic = ?,
      wrapped_by_password = ?, wrapped_by_mnemonic = ?, wrapped_key = ''
    WHERE slug = ?
  `).run(
    passwordSalt, mnemonicSalt, kdfParamsPassword, kdfParamsMnemonic,
    wrappedByPassword, wrappedByMnemonic, slug
  );
}

// 关闭超级隐私模式：用主密钥重新包裹库钥匙，清空口令相关字段
function registryClearPrivacy(slug, wrappedKey) {
  ensureIndex();
  indexDb.prepare(`
    UPDATE registry SET protect = 0, kdf_salt = '', mnemonic_salt = '',
      kdf_params_password = '', kdf_params_mnemonic = '',
      wrapped_by_password = '', wrapped_by_mnemonic = '', wrapped_key = ?
    WHERE slug = ?
  `).run(wrappedKey, slug);
}

// 改登录密码：只换密码这一份包裹（新 salt + 新密文 + 新 KDF 参数），恢复词包裹保持原样
function registrySetPasswordWrap(slug, passwordSalt, wrappedByPassword, kdfParamsPassword = '') {
  ensureIndex();
  indexDb.prepare(`
    UPDATE registry SET kdf_salt = ?, kdf_params_password = ?, wrapped_by_password = ?
    WHERE slug = ?
  `).run(passwordSalt, kdfParamsPassword, wrappedByPassword, slug);
}

module.exports = {
  getDatabase,
  MASTER_KEY,
  WRAP_KEY,
  dataDir,
  ensureDir,
  // v2 分层布局：core / content / cache / logs 与所有具体路径常量
  coreDir, contentDir, cacheDir, logsDir,
  indexPath, dbMasterKeyPath, jwtSecretPath, sessionsPath, lastDbPath, dbFilePath,
  uploadsDir, backgroundDir, thumbsDir, trashDir, receiptTrashDir,
  snapshotsDirRoot, snapshotsDir, memoryDir, skillsDirRoot, skillsDir,
  ffmpegCacheDir, backendLogPath, startupLogPath, inpLogPath,
  wrapKey,
  unwrapKey,
  wrapWithKey,
  unwrapWithKey,
  wrapKeyBySecret,
  decryptBundleKey,
  // 超级隐私模式
  newPrivacySalt,
  normalizeScryptParams,
  serializeScryptParams,
  SCRYPT_PARAMS,
  wrapKeyByPrivacySecret,
  unwrapKeyByPrivacySecret,
  setUnlockedKey,
  getUnlockedKey,
  getUnlockSource,
  clearUnlockedKey,
  clearAllUnlockedKeys,
  sqlKey,
  als,
  connCache,
  CONN_CACHE_MAX,
  CONN_CACHE_HARD_MAX,
  beginConnUse,
  isConnInUse,
  endConnUse,
  touchConn,
  setCachedConn,
  _resetConnCacheForTest,
  applyPerfPragmas,
  openFile,
  ensureIndex,
  registryFindByUsername,
  registryFindBySlug,
  registryUpsert,
  registrySetEncrypted,
  registryRename,
  registryDelete,
  registryList,
  // 多班级：账号与班级归属
  ensureAccountsSchema,
  registryFindAllByUsername,
  registryFindByAccount,
  registrySetAccount,
  registrySetClassName,
  accountFindByUsername,
  accountFindById,
  accountCreate,
  accountSetPassword,
  accountRename,
  accountDelete,
  registrySetPrivacy,
  registryClearPrivacy,
  registrySetPasswordWrap,
};
