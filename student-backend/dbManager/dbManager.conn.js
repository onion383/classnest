// =========================================================================
// dbManager.conn.js —— 多库加密核心·连接管理
// （原 dbManager.js 按职责拆分而来，纯代码搬运，行为不变）
//   打开/缓存/驱逐单个班主任库连接、请求上下文取库、后台暖机
// =========================================================================

const fs = require('fs');
const { initSchema } = require('../schema/schema');
const { probeForeignKeys, describeForeignKeys } = require('../schema/foreignKeyProbe');
const {
  dbFilePath, lastDbPath, als, connCache, touchConn, setCachedConn, ensureIndex,
  openFile, registryFindBySlug, unwrapKey, getUnlockedKey, clearUnlockedKey,
  beginConnUse, endConnUse, isConnInUse, getDatabase, sqlKey,
} = require('./dbManager.base');

// 打开（或打开后初始化）某个 slug 对应的库并缓存
function getConn(slug, passphrase, encrypted = true) {
  if (connCache.has(slug)) {
    touchConn(slug);
    return connCache.get(slug);
  }
  const _t0 = Date.now();
  const conn = openFile(dbFilePath(slug), passphrase, encrypted);
  const _t1 = Date.now();
  try {
    initSchema(conn);
    // 首屏请求的第一笔同步开销就在这里（KDF + 全量 DDL 检查），而它发生在
    // 「连接已 accept、路由还没进去」的窗口里 —— 表现是首屏请求凭空多等 100ms+。
    if (process.env.PERF_STARTUP === '1') {
      try { console.log(`[boot] 首次打开账号库 ${_t1 - _t0}ms（openFile）+ ${Date.now() - _t1}ms（initSchema）`); } catch (_) { /* best-effort: 启动打点日志失败不影响打开账号库 */ }
    }
    reportForeignKeyStatus(slug, conn);
    setCachedConn(slug, conn);
  } catch (err) {
    // 硬顶拒绝或 initSchema 失败：新建的连接不能留在内存里
    try { conn.close(); } catch (_) { /* best-effort: 关闭失败不再掩盖原始错误 */ }
    throw err;
  }
  return conn;
}

// 开库后探一次外键，把「这个库受不受外键保护」写进日志。
//
// 为什么值得专门打一行：外键声明只对**新建的表**生效（`CREATE TABLE IF NOT EXISTS`
// 不会给已存在的表补约束），所以同一版本的程序在老库上「删学生不级联」、
// 在新库上「级联」。这个差异完全隐形 —— 用户只会觉得「有时候删完学生加分记录还在」。
// 打出来以后，排查任何「删了学生数据还残留」的问题，第一眼就有结论。
//
// 探测本身只读 PRAGMA，开销 <1ms，且每个连接只算一次（缓存见 foreignKeyProbe）；
// 失败不抛出：探测是诊断，不是开库的前置条件。
function reportForeignKeyStatus(slug, conn) {
  try {
    const r = probeForeignKeys(conn);
    const brief = describeForeignKeys(r);
    if (r.complete) {
      console.log(`[db] 外键约束 ${slug}: ${brief} 完整`);
    } else {
      const missing = r.missing.map((m) => `${m.table}.${m.column}`).join(', ');
      console.warn(
        `[db] 外键约束 ${slug}: ${brief} —— 该库的表现在建于外键声明之前，`
        + `删学生不会自动级联，依赖应用层清理（缺: ${missing}）`
      );
    }
  } catch (_) { /* best-effort: 诊断失败不影响开库 */ }
}

// 关闭并移出某库的缓存连接。
// force=false（默认）：仍有请求在用这个连接时**不关** —— 强 close 会让在途查询直接抛
//   "database is closed"，表现为偶发的保存失败/白屏，而调用点根本不知道发生了这件事
//   （审查 v4 · B05-04）。这类调用交给 LRU，在计数归零后自然回收。
// force=true：调用方确实需要独占文件句柄（恢复备份、加密转换、删账号、登出锁库），
//   这些是维护窗口内的操作，调用方已保证没有并发写。
function evictConn(slug, opts = {}) {
  const force = !!(opts && opts.force);
  if (!connCache.has(slug)) return false;
  if (!force && isConnInUse(slug)) {
    console.warn(`[db] 跳过关闭 ${slug}：仍有请求在使用该连接`);
    return false;
  }
  const conn = connCache.get(slug);
  try { conn.close(); } catch (_) { /* best-effort: 关闭失败可忽略 */ }
  connCache.delete(slug);
  return true;
}

// 备份前的快照一致性收口：把 WAL 里的尾页合并回主库，让「直接拷 .db」成为一致快照。
//
// 为什么必须在这一层做：导出路由拿到的是文件路径，它无法判断哪些页还只在 -wal 里。
// 常驻连接（connCache）优先复用 —— 另开句柄做 checkpoint 会与它在 WAL 锁上互斥；
// 没有缓存连接时（刚重启 / 已被驱逐）才临时打开一次，用完即关。
// 返回 true 表示主库已自包含；false 表示 checkpoint 没做成，调用方必须连同
// -wal/-shm 一起打包，由恢复侧按同一 basename 落位后重放（见 dbManager.backup.js）。
function checkpointForBackup(slug, key, encrypted) {
  try {
    const cached = connCache.get(slug);
    if (cached && cached.open !== false) {
      const mode = String(cached.pragma('journal_mode', { simple: true }) || '').toLowerCase();
      if (mode === 'wal') cached.pragma('wal_checkpoint(TRUNCATE)');
      return true;
    }
    const file = dbFilePath(slug);
    if (!fs.existsSync(file)) return false;
    const Database = getDatabase();
    const conn = new Database(file);
    try {
      if (encrypted && key) conn.pragma(`key = '${sqlKey(key)}'`);
      const mode = String(conn.pragma('journal_mode', { simple: true }) || '').toLowerCase();
      if (mode === 'wal') conn.pragma('wal_checkpoint(TRUNCATE)');
      return true;
    } finally {
      try { conn.close(); } catch (_) { /* best-effort: 连接已关闭时重复关闭可忽略 */ }
    }
  } catch (_) {
    return false;
  }
}

// ---------- 请求内取当前库 ----------
function current() {
  const ctx = als.getStore();
  if (ctx && ctx.slug && connCache.has(ctx.slug)) return connCache.get(ctx.slug);
  // 未通过 auth 中间件绑定库（如未登录直接访问业务接口）即拒绝访问
  throw new Error('未绑定数据库连接');
}

// 当前请求绑定的库标识（slug）。
// 用途：相册缩略图按库隔离目录 —— 各库的 album_photos.id 都从 1 开始自增，
// 若缩略图文件只按 {photoId}.jpg 命名并共用一个目录，不同库会互相覆盖（串图）。
// slug 在 withDb 里写入 ALS 上下文，故请求内随时可取。
function currentSlug() {
  const ctx = als.getStore();
  return (ctx && ctx.slug) || '';
}

// 绑定：在请求上下文内设置当前班主任库 slug，并解析出连接放入上下文缓存
function withDb(slug, fn) {
  const rec = registryFindBySlug(slug);
  if (!rec) throw new Error('库不存在');
  const encrypted = rec.encrypted !== 0;
  let passphrase = null;
  if (encrypted) {
    if (rec.protect === 1) {
      // 超级隐私模式：库钥匙只能来自本次登录解锁的内存表，主密钥拿不到
      passphrase = getUnlockedKey(slug);
      if (!passphrase) {
        const err = new Error('数据库已锁定，请重新登录');
        err.code = 'DB_LOCKED';
        throw err;
      }
    } else {
      passphrase = unwrapKey(rec.wrapped_key);
    }
  }
  const conn = getConn(slug, passphrase, encrypted);
  // 记下「这次真的用了哪个库」——下次启动的 warmup 靠它预热（见 warmupMostRecent）。
  // 放在 getConn 之后：只有真打开成功才算数。
  rememberDb(slug);
  return als.run({ slug, conn }, () => {
    // 标记「本请求正在使用该连接」：连接缓存的 LRU 驱逐会跳过在用连接，
    // 避免并发切换库时把仍在执行查询的连接 close() 掉（B04-01）。
    beginConnUse(slug);
    const done = () => endConnUse(slug);
    let out;
    try {
      out = fn({ slug, conn });
    } catch (err) {
      done();
      throw err;
    }
    // 路由处理函数可能是 async：等它真正结束（含异常）后再减少计数
    if (out && typeof out.then === 'function') return Promise.resolve(out).finally(done);
    done();
    return out;
  });
}

// 把「本次请求正在用这个库」的标记延长到响应真正结束。
//
// withDb 只能看它包住的函数的返回值：在 auth 中间件里那是 `next()`，而 Express 的
// next() 同步返回 undefined —— 于是计数在**路由处理函数还在 await 的时候**就归零了，
// setCachedConn 的 LRU 驱逐也就可能把正在用的连接 close 掉（查询报 database is closed）。
// 这里额外持有一份计数，响应 finish/close 时释放；两个事件都会触发，用 once 释放一次。
function holdConnUntilResponse(slug, res) {
  if (!slug || !res || typeof res.once !== 'function') return;
  beginConnUse(slug);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    endConnUse(slug);
  };
  res.once('finish', release);
  res.once('close', release);
}

// 锁定某库：关闭连接缓存并丢弃内存里的库钥匙（登出时调用）
function lockDb(slug) {
  if (!slug) return;
  evictConn(slug, { force: true });
  clearUnlockedKey(slug);
}

// 后端就绪后的后台暖机：把一次性冷启动成本（require 原生 sqlite 模块、打开 index.db）
// 放到 listen 就绪信号之后、用户首个请求到达之前悄悄完成，消除登录/首屏的等待。
// 暖机失败不抛出，正常走懒加载兜底（与原先行为一致）。
function warmup() {
  try {
    ensureIndex();
  } catch (_) { /* best-effort: 暖机失败不影响正常懒加载路径 */ }
}

// ---------- 「上次真正用的是哪个库」----------
// 启动预热要先知道该打开哪个库，但那一刻还没有任何请求。
//
// 为什么不用会话名单里的 dbSlug：那个字段是后来才加进 sessions.create 的，
// 老会话里根本没有 —— 实测本机 21 条会话里 16 条 dbSlug 为 null，于是只能退回
// 「别的有 dbSlug 的会话」，必然猜错。猜错的代价不是零：白花 40~60ms 预热，
// 首屏请求还要再付一次冷开，等于比不预热更慢。
//
// 所以这里记**事实**而不是猜：withDb 真正打开某个库后，把 slug 写进 data/.last-db；
// 下次启动 warmup 读它来预热。首次安装/首次启动没有这个文件 → 不预热，零损失。
//
// 只在 slug 变化时写盘（进程内比对），不是每个请求都写；换账号也会立即更新。
// 多环境（dev + 打包）共用一个数据目录时会互相覆盖，真实用户只有一个环境，不受影响。
const LAST_DB_FILE = () => lastDbPath;
let lastDbWritten = '';   // 进程内「已经写进去的值」

// slug 白名单与 snapshotsDir 同一条规则：别把文件里的脏内容当路径用
const SLUG_RE = /^[A-Za-z0-9_@-]+$/;

function rememberDb(slug) {
  const s = slug == null ? '' : String(slug);
  if (!s || s === lastDbWritten) return;
  try {
    fs.writeFileSync(LAST_DB_FILE(), s, { encoding: 'utf8', mode: 0o600 });
    lastDbWritten = s;
  } catch (_) { /* best-effort: 写不进去就算了：下次启动不预热，不影响任何功能 */ }
}

function rememberedDb() {
  try {
    const s = fs.readFileSync(LAST_DB_FILE(), 'utf8').trim();
    return SLUG_RE.test(s) ? s : '';
  } catch (_) {
    return '';   // 没这个文件是常态（首次启动），不是错误
  }
}

// 首屏第一笔同步开销的提前量（2026-11-14 打包版精确归因）：
// 第一个请求进 auth 的 withDb 时才**第一次**开账号库，「KDF + openFile」实测 41~58ms；
// better-sqlite3 是同步的，这一笔会把同时到达的另外 4 个首屏请求
// （dashboard / seats-draft / ai-config / widget-settings）全挡在「连接到达」之后 ——
// 表现是 dashboard 白白多等约 50ms，而它自己的聚合只要 2~3ms。
//
// 让路链的 warmup 里先把 `.last-db` 记的那个库打开：
//   命中 → 首屏 withDb 直接走 connCache，省 40~60ms；
//   没有文件 / 记录失效 / 猜错 → 白花一次开库（此时还没有用户请求），不比现在差。
//
// 超级隐私库（protect=1）的钥匙只在登录解锁后的内存表里，这里拿不到，直接跳过。
// 全程静默失败：预热不成功时一切照旧走懒加载。
function warmupMostRecent() {
  try {
    const slug = rememberedDb();
    if (!slug || connCache.has(slug)) return;   // 没记录 / 已经开着：幂等返回
    const rec = registryFindBySlug(slug);
    if (!rec) return;
    if (rec.protect === 1) return;              // 隐私库：钥匙只在本次登录的内存里
    const encrypted = rec.encrypted !== 0;
    const passphrase = encrypted ? unwrapKey(rec.wrapped_key) : null;
    const t0 = Date.now();
    getConn(slug, passphrase, encrypted);
    if (process.env.PERF_STARTUP === '1') {
      try { console.log(`[boot] 预热账号库 ${slug} ${Date.now() - t0}ms`); } catch (_) { /* best-effort: 预热账号库失败时首屏请求会自己冷开 */ }
    }
  } catch (_) { /* best-effort: 预热失败：首屏请求照旧在自己那次 withDb 里冷开 */ }
}

module.exports = { getConn, evictConn, checkpointForBackup, current, currentSlug, withDb, holdConnUntilResponse, lockDb, warmup, warmupMostRecent, rememberedDb };
