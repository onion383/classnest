// =========================================================================
// dbManager.backup.js —— 多库加密核心·备份与迁移
// （原 dbManager.js 按职责拆分而来，纯代码搬运，行为不变）
//   库文件路径 / 导出包组装 / 备份恢复落盘 / 就地切换落盘加密方式
// =========================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  getDatabase, dbFilePath, wrapKey, unwrapKey, sqlKey,
  registryFindBySlug, registryUpsert, registrySetEncrypted,
  getUnlockedKey,
} = require('./dbManager.base');
const { evictConn } = require('./dbManager.conn');

// 库文件路径：v2 布局下位于 core/${slug}.db（slug 形如 @xxxxxxxxxxxx）。
// 由 dbManager.paths.js 统一定义，备份 / 恢复 / 就地加密转换共用同一份。

// 供备份/导出：返回当前 slug 对应库文件路径与密钥
function exportBundle(slug) {
  const rec = registryFindBySlug(slug);
  if (!rec) throw new Error('库不存在');
  const encrypted = rec.encrypted !== 0;
  return {
    slug,
    username: rec.username,
    wrappedKey: rec.wrapped_key,
    filePath: dbFilePath(slug),
    encrypted,
    // 明文库没有库钥匙（数据本身不加密），key 为 null
    // 超级隐私模式：wrapped_key 为空，只能取本次登录解锁后留在内存里的库钥匙
    key: encrypted
      ? (rec.protect === 1 ? (getUnlockedKey(slug) || (() => { throw new Error('数据库已锁定，请重新登录'); })()) : unwrapKey(rec.wrapped_key))
      : null,
  };
}

// 供备份/恢复：写入教师库文件并在 index 登记（幂等）。
// 参数 dbKey 为「已解出的库钥匙」（明文，仅加密库需要）——由调用方用密码/助记词解出的，本处只负责落盘与登记。
// encrypted=false 表示恢复的是一个明文库，不包裹库钥匙、登记为明文。
//
// 库内容有两种给法，二选一：
//   · srcPath：磁盘上的现成库文件（v3 ZIP 解包后的产物）——**优先**，直接内核复制，JS 堆零驻留；
//   · data：base64 字符串（旧 v2 JSON 包与单测用）——要先解码成 Buffer 再写，100MB 库会在
//     堆里同时存在 base64 字符串（约 133MB）+ 解码 Buffer（100MB），这是 2-11 要消掉的峰值。
// 同一库的恢复备份只保留最近一份：`.bak-<stamp>` 是回滚壳，不是版本历史。
function pruneDbBackups(filePath, keepPath) {
  try {
    const dir = path.dirname(filePath);
    const prefix = path.basename(filePath) + '.bak-';
    const olds = fs.readdirSync(dir).filter((n) => n.startsWith(prefix));
    const keep = keepPath ? path.basename(keepPath) : olds.sort().pop();
    for (const n of olds) {
      if (n === keep) continue;
      try { fs.rmSync(path.join(dir, n), { force: true }); } catch (_) { /* best-effort: 过期的旧库副本删不掉就留着，不影响本次恢复 */ }
    }
  } catch (_) { /* best-effort: 清理失败不影响恢复结果 */ }
}

// srcWal：旧备份包可能带着导出时没能 checkpoint 的 -wal（见 checkpointForBackup）。
// 恢复侧必须履约「同一组文件名放回去」的契约 —— 把 WAL 落位后由 SQLite 重放，
// 而不是像以前那样只挑 .db、再把唯一能补回尾页的 WAL 直接删掉（v8 · N2-01）。
function restoreBundle({ slug, username, data, srcPath, srcWal, dbKey, encrypted = true }) {
  if (!slug || !username || (typeof srcPath !== 'string' && typeof data !== 'string')) {
    throw new Error('备份数据不完整');
  }
  if (encrypted && !dbKey) {
    throw new Error('备份数据不完整');
  }
  // 强约束 slug：仅允许 @ 开头 + 十六进制的内部格式，防止路径穿越/覆盖其它库
  if (!/^@[0-9a-f]{12}$/.test(slug)) {
    throw new Error('非法的库标识');
  }
  const filePath = dbFilePath(slug);
  // 顺序很关键：**先断开连接再覆盖文件**。
  // 反过来的话，旧连接还开着时 Windows 上写同名文件会 EBUSY；即便写成功，
  // 旧连接的 -wal 之后仍可能被重放到新库上，两份数据交错（审查 v4 · B05-03）。
  // 恢复属维护窗口操作，强制关（force）——此时不应有人在写。
  // 主进程连接由 evictConn 关；扫描子进程另持一份连接，必须先通知它关闭并丢弃钥匙，
  // 否则它可能在恢复期间继续读旧库/写 -wal，触发 SQLITE_BUSY 或数据交错（#12）。
  // 惰性 require：scanWorker 顶层依赖 dbManager，不能在此模块顶层引入（循环依赖）。
  try { require('../scanWorker').lockDb(slug); } catch (_) { /* best-effort: 子进程未启动 */ }
  evictConn(slug, { force: true });

  // 先写临时文件并校验完整性，**通过后才覆盖现有库**：
  // 备份包可能上传到一半/损坏，直接覆盖会把「能用的旧库」也一起毁掉，
  // 而且损坏的库一旦登记就能通过登录校验，故障延后且更难排查（审查 v4 · B05-13）。
  const tmpPath = filePath + '.restore-tmp';
  const tmpWal = tmpPath + '-wal';
  const cleanTmp = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(tmpPath + suffix, { force: true }); } catch (_) { /* best-effort: 临时库 sidecar 清理失败可忽略 */ }
    }
  };
  cleanTmp();
  if (typeof srcPath === 'string') {
    fs.copyFileSync(srcPath, tmpPath);
    // WAL 必须与主文件同 basename 落位，SQLite 才会认它并重放；
    // -shm 是可重建的临时索引（可能来自另一台机器的热状态），不拷。
    if (typeof srcWal === 'string' && fs.existsSync(srcWal)) fs.copyFileSync(srcWal, tmpWal);
  } else {
    fs.writeFileSync(tmpPath, Buffer.from(data, 'base64'));
  }
  let bakPath = null;
  try {
    const Database = getDatabase();
    let conn = null;
    try {
      conn = new Database(tmpPath);
      if (encrypted && dbKey) conn.pragma(`key = '${sqlKey(dbKey)}'`);
      // 有 WAL 时先合并尾页：完整性校验、后续换文件都以「自包含的 .db」为准。
      // 否则校验只覆盖主文件页，WAL 里的最新提交既没被校验也没被保留。
      try { conn.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* best-effort: 非 WAL 模式无 WAL 可合并 */ }
      let first;
      try {
        const r = conn.pragma('integrity_check');
        first = Array.isArray(r)
          ? (r[0] && (r[0].integrity_check || Object.values(r[0])[0]))
          : r;
      } catch (_) {
        // 非 SQLite 文件/截断包会在 pragma 阶段直接抛 SQLITE_NOTADB，
        // 统一成可读错误，避免把底层错误原样丢给用户
        throw new Error('备份文件完整性校验未通过（不是有效的数据库文件）');
      }
      if (String(first).toLowerCase() !== 'ok') {
        throw new Error('备份文件完整性校验未通过（文件可能损坏或不是有效的数据库）');
      }
    } finally {
      if (conn) { try { conn.close(); } catch (_) { /* best-effort: 连接已关闭时重复关闭可忽略 */ } }
    }
    // 覆盖前留一份旧库：rename 是原子的，但「包能打开、内容却不是想要的」时用户仍需回退；
    // 与目录替换的 .bak-<stamp> 口径一致。
    if (fs.existsSync(filePath)) {
      bakPath = `${filePath}.bak-${Date.now()}`;
      fs.copyFileSync(filePath, bakPath);
    }
    // 同目录 rename 是原子替换；copyFileSync 会先截断目标，中途崩溃会留下半写库。
    fs.renameSync(tmpPath, filePath);
    pruneDbBackups(filePath, bakPath);
  } finally {
    cleanTmp();
  }
  // 覆盖 .db 后必须清掉同名的 -wal/-shm 残留，否则旧库的日志会被新库重放导致损坏
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(filePath + suffix, { force: true }); } catch (_) { /* best-effort: 覆盖后残留的 WAL/SHM 删不掉时下步会再处理 */ }
  }
  // 覆盖前的原登记：恢复后续步骤（目录/记忆）失败时，调用方要能把库文件与登记一起回滚（K04-04）。
  const prevRec = registryFindBySlug(slug);
  // 用本机主密钥重新包裹库钥匙后登记，后续登录走常规主密钥路径即可打开；
  // 明文库无需钥匙，wrapped_key 留空占位（NOT NULL 约束）
  registryUpsert(slug, username, encrypted ? wrapKey(dbKey) : '', encrypted ? 1 : 0);
  // bakPath / prevRec 供「库已换、目录阶段失败」时整体回滚（见 services/bundleRestore.js）
  return { slug, bakPath, prevRec };
}

// ---------- 就地切换单个库的落盘加密方式（加密 <-> 明文） ----------
// 只作用于传入 slug 对应的那一个库，绝不触碰其它账号。
// 严格顺序：关闭连接 → 退出 WAL → 预检完整性 → 备份 → rekey → 转换后校验 → 回写登记 → 删备份；
// 任一步失败即从备份还原原库文件并保持原登记状态，绝不留下半加密/半明文的中间态。
// rekey 是 SQLCipher 的同步阻塞操作，因此本函数由后端执行；进度只到步骤级（无字节级回报）。
// 函数为 async：每上报一步就让出事件循环一次（tick），否则后续同步的 rekey 会把已写入的
// 进度一并阻塞到结束时才送达，进度窗口将看不到中间步骤。
async function convertDbEncryption(slug, encrypt, onProgress) {
  const rec = registryFindBySlug(slug);
  if (!rec) throw new Error('库不存在');
  const dbPath = dbFilePath(slug);
  if (!fs.existsSync(dbPath)) throw new Error('数据库文件不存在');

  const wasEncrypted = rec.encrypted !== 0;
  const targetEncrypted = !!encrypt;
  if (wasEncrypted === targetEncrypted) return { changed: false, encrypted: targetEncrypted };

  const report = (phase, detail, percent) => { if (onProgress) onProgress({ phase, detail, percent }); };
  const tick = () => new Promise((r) => setImmediate(r));
  const Database = getDatabase();
  const oldKey = wasEncrypted ? unwrapKey(rec.wrapped_key) : null;
  const newKey = targetEncrypted ? crypto.randomBytes(32).toString('hex') : null;
  const backupPath = `${dbPath}.rekey-backup`;

  const cleanSidecars = () => {
    for (const suffix of ['-wal', '-shm']) {
      try { fs.rmSync(dbPath + suffix, { force: true }); } catch (_) { /* best-effort: sidecar 清理失败可忽略 */ }
    }
  };
  const integrityOk = (conn) => {
    const r = conn.pragma('integrity_check');
    const first = Array.isArray(r) ? (r[0] && (r[0].integrity_check || Object.values(r[0])[0])) : r;
    return String(first).toLowerCase() === 'ok';
  };
  // 以「无 WAL」方式打开：rekey 必须在非 WAL 模式下进行；key 为 null 表示明文库不开加密。
  const openRaw = (key) => {
    const conn = new Database(dbPath);
    if (key != null) conn.pragma(`key = '${sqlKey(key)}'`);
    try { conn.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* best-effort: 非 WAL 模式无 WAL 可 checkpoint */ }
    conn.pragma('journal_mode = DELETE');
    return conn;
  };

  // 先驱逐缓存连接（含 auth 中间件为本次请求打开的连接），确保转换期间本库无其它句柄。
  // 转换要独占文件，必须强制关（force）——守卫生效时会直接跳过，那就白转了
  evictConn(slug, { force: true });

  let conn = null;
  try {
    // 1) 预检：原库能打开且完整
    report('校验文件', '正在校验当前数据库完整性', 5);
    await tick();
    conn = openRaw(oldKey);
    if (!integrityOk(conn)) throw new Error('当前数据库完整性校验未通过');
    conn.close();
    conn = null;

    // 2) 备份原库主文件（已退出 WAL，无 -wal/-shm 需一并备份）
    report('校验文件', '正在备份原数据库', 30);
    await tick();
    fs.copyFileSync(dbPath, backupPath);

    // 3) rekey：加密→明文用空串；明文→加密用新生成的随机库钥匙
    report('转换数据库', targetEncrypted ? '正在为数据库启用加密' : '正在移除数据库加密', 40);
    await tick();
    conn = openRaw(oldKey);
    conn.pragma(`rekey = '${sqlKey(targetEncrypted ? newKey : '')}'`);
    conn.close();
    conn = null;

    // 4) 转换后校验：用新状态重新打开并做完整性检查
    report('校验文件', '正在校验转换结果', 75);
    await tick();
    conn = openRaw(targetEncrypted ? newKey : null);
    if (!integrityOk(conn)) throw new Error('转换后完整性校验未通过');
    conn.close();
    conn = null;

    // 5) 回写登记表（唯一的状态持久化点）
    report('校验文件', '正在更新账号登记', 90);
    await tick();
    if (targetEncrypted) registryUpsert(slug, rec.username, wrapKey(newKey), 1);
    else registrySetEncrypted(slug, 0); // 明文库保留原 wrapped_key 作占位

    // 6) 清理备份与可能残留的 WAL/SHM
    try { fs.rmSync(backupPath, { force: true }); } catch (_) { /* best-effort: 备份文件删除失败可忽略 */ }
    cleanSidecars();
    report('校验文件', '转换完成', 100);
    await tick();
    return { changed: true, encrypted: targetEncrypted };
  } catch (err) {
    try { if (conn) conn.close(); } catch (_) { /* best-effort: 出错时连接已关闭则重复关闭可忽略 */ }
    // 失败回滚：从备份还原原库文件，登记状态保持原样（备份删除失败则保留供人工处理）
    try {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, dbPath);
        fs.rmSync(backupPath, { force: true });
        cleanSidecars();
      }
    } catch (_) { /* best-effort: 回滚异常时保留备份文件，不掩盖原始错误 */ }
    throw err;
  }
}

module.exports = { dbFilePath, exportBundle, restoreBundle, convertDbEncryption };
