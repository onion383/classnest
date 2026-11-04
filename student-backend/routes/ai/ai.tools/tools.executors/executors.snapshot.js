// ===== AI 工具执行逻辑·整库快照（snapshot_create / snapshot_list / snapshot_restore）=====
// 纯代码搬运自 ../executors.js，行为不变。
const fs = require('fs');
const path = require('path');
const { db } = require('../../../../db');
const dbManager = require('../../../../dbManager/dbManager');

// ===== 整库快照：snapshot_create / snapshot_list / snapshot_restore =====
// 快照是当前班主任库整体的一份加密 .db 副本（沿用同一库密钥），用于大批量写入前的「后悔药」。
// 快照目录 dataDir/snapshots/<slug>/<时间戳>.db，只保留最近 MAX_SNAPSHOTS 份。
const MAX_SNAPSHOTS = 20;
// 快照标识格式：<8位日期>-<6位时间>[.<3位毫秒>][-<序号>]
//   日期+时间部分保持原有的秒级形态（列表排序仍按时间先后，旧的快照也认），
//   其后可选的毫秒与序号用来保证「同一次操作内连续创建多份」不会互相覆盖 ——
//   审查 v4 · B03-07：原先只有秒级精度，同秒并发创建会写同一个文件名、互相顶掉。
//   注意：这个正则同时用于「还原提案的入参校验」，所以格式与校验必须同步（单一来源）。
const SNAPSHOT_NAME_RE = /^\d{8}-\d{6}(?:\.\d{3})?(?:-\d+)?$/;
// 由「时间戳 + 已在用的标识」推导一个未被占用的快照标识。
// 同毫秒内多次创建时递增序号，保证每个标识唯一 → 不会覆盖已有快照。
function nextSnapshotName(existing, stamp) {
  const taken = new Set(existing);
  if (!taken.has(stamp)) return stamp;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stamp}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  // 极端情况下（同一毫秒创建 999 份）退化为随机后缀，仍保证唯一
  return `${stamp}-${Date.now().toString(36)}`;
}

function snapshotFiles(slug) {
  const dir = dbManager.snapshotsDir(slug);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => SNAPSHOT_NAME_RE.test(n.replace(/\.db$/, ''))); } catch (_) { names = []; }
  // 排序按「解析出的时间戳」而非原始字符串：标识里带毫秒与序号后，
  // 纯字符串排序会把 '...-2' 排到 '...001' 之前（'-' < '0'），导致清理时删错文件。
  return names.sort((a, b) => {
    const ka = snapshotSortKey(a.replace(/\.db$/, ''));
    const kb = snapshotSortKey(b.replace(/\.db$/, ''));
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a < b ? -1 : (a > b ? 1 : 0);
  }).reverse(); // 时间顺序，倒序=最新在前
}

// 快照标识 → 可比较的排序键：前 14 位是「日期+时间」，毫秒与序号作为次级键
function snapshotSortKey(name) {
  const m = /^(\d{8}-\d{6})(?:\.(\d{3}))?(?:-(\d+))?$/.exec(name);
  if (!m) return name;
  return `${m[1]}.${m[2] || '000'}.${String(m[3] || 1).padStart(4, '0')}`;
}

// 创建快照：把当前库整文件复制一份落盘 → 只保留最近 20 份。执行前无需用户确认（是只读式备份）。
//   注意：不能用 better-sqlite3 的 db.backup()。它打开的目标库不带加密口令，加密源库 → 明文目标库
//   会被 sqlite 判定为「不兼容的源库与目标库」，对加密库（本项目默认）必然失败。
//   这里改为「WAL 全部合并回主库 → 整文件复制」：与还原时的整文件覆盖完全对称，
//   加密库与明文库都适用，且快照沿用同一把库密钥，还原后可直接打开。
async function runSnapshotCreate(ctx) {
  const slug = ctx && ctx.slug;
  if (!slug) return { error: '未绑定数据库连接，无法创建快照' };
  const dir = dbManager.snapshotsDir(slug);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  // 同一毫秒内再次创建时递增序号 → 标识唯一，不会覆盖已有快照（B03-07）
  const existing = snapshotFiles(slug).map((n) => n.replace(/\.db$/, ''));
  const name = nextSnapshotName(existing, stamp);
  const file = path.join(dir, `${name}.db`);
  try {
    // 有 WAL 时，最近提交的数据还在 -wal 里；truncate checkpoint 后主库文件才是完整一致的。
    // 单进程单连接且此处同步执行，checkpoint 与复制之间不会插入其它写入。
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* 非 WAL 模式无需 checkpoint */ }
    fs.copyFileSync(dbManager.dbFilePath(slug), file);
  } catch (err) {
    // 半成品快照必须删掉，否则会被当成可用快照出现在列表里
    try { fs.rmSync(file, { force: true }); } catch (_) { /* 忽略 */ }
    return { error: `创建快照失败：${err.message}` };
  }
  const files = snapshotFiles(slug);
  for (const f of files.slice(MAX_SNAPSHOTS)) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch (_) { /* 清理失败可忽略 */ }
  }
  return {
    ok: true, snapshot: name, created: true, count: Math.min(files.length, MAX_SNAPSHOTS),
    note: '快照已创建（加密整库副本）。正文一句话确认即可；要还原须老师再确认一次。',
  };
}

// 列出快照（只读）
function runSnapshotList(ctx) {
  const slug = ctx && ctx.slug;
  if (!slug) return { error: '未绑定数据库连接' };
  const dir = dbManager.snapshotsDir(slug);
  const items = snapshotFiles(slug).slice(0, MAX_SNAPSHOTS).map((f) => {
    let size = 0;
    try { size = fs.statSync(path.join(dir, f)).size; } catch (_) { /* 忽略 */ }
    return { snapshot: f.replace(/\.db$/, ''), size };
  });
  return { count: items.length, snapshots: items };
}

// 还原提案：只出提案不动数据（还原会覆盖当前全部数据，须老师确认）
function runSnapshotRestoreProposal(slug, { snapshot, label } = {}) {
  if (!slug) return { error: '未绑定数据库连接' };
  const name = String(snapshot || '').trim().replace(/\.db$/, '');
  if (!SNAPSHOT_NAME_RE.test(name)) return { error: '请提供有效的快照标识（如 20261017-183000，可先用 snapshot_list 查看）' };
  const dir = dbManager.snapshotsDir(slug);
  if (!fs.existsSync(path.join(dir, `${name}.db`))) return { error: `快照不存在：${name}，请先用 snapshot_list 查看可用快照` };
  const lbl = String(label || '').trim().slice(0, 60) || `还原到快照 ${name}`;
  return { ok: true, snapshot: name, label: lbl };
}

module.exports = { MAX_SNAPSHOTS, SNAPSHOT_NAME_RE, nextSnapshotName, snapshotSortKey, snapshotFiles, runSnapshotCreate, runSnapshotList, runSnapshotRestoreProposal };
