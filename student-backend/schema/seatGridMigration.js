// 一次性数据迁移：把「dense 座位矩阵 + 渲染期按公式虚拟插入的走廊列」
// 搬成「网格座位矩阵 + types 格子类型矩阵」，并把 cols 从「座位列数」改成「网格总列数」。
//
// ============================ 为什么必须单独跑这一次 ============================
// 座位指数（前端 loadSeatLedger / seatIndexRows）是把 domain_history 里每天的 seats[r][c]
// 与权重矩阵**按同一个下标**逐格累加出来的。seats 一旦变成网格、而历史 payload 还是 dense，
// 累加就会从第一天起整体错位 —— 不报错、不崩溃、界面照常显示，只是每人指数全错，
// 而且越攒越错、事后无法区分哪一天开始错的。
//
// 所以「不迁移数据、重建就行」这条规则对 seat_layout 成立，对**历史快照不成立**：
// 座位指数是跨天累加出来的，重建不了。历史 payload 必须一起迁。
//
// ============================ 幂等判据 ============================
// 迁移完成后：seats 类记录（current/template/draft/history payload）一定带**非空满矩阵 types**；
// weight 记录也写一份 types 作为几何标记（权重矩阵与座位矩阵同形，这个字段本来就该有）。
// 老数据 types 恒为 '[]'。以此为判据，不额外建「迁移已执行」标记表 ——
// 标记表和实际数据可能不一致（中途崩溃、手工改库），按数据本身判断才不会迁一半。

const { SEAT_CELL } = require('../services/sanitize');

// ============================ 旧几何（冻结） ============================
// 这两条公式描述的是「老数据长什么样」，不是运行时几何。
// 切完之后全库不应再有第二处副本，也**不要**与将来「按 types 渲染」的代码合并：
// 一旦共用，迁移逻辑会随渲染改动而漂移，已经迁过的库和没迁过的库就会按不同公式解读。
function legacyDisplayColCount(cols, mode, showAisle) {
  if (!showAisle) return cols;
  return mode === 'single' ? cols + (cols - 1) : cols + Math.floor((cols - 1) / 2);
}

function legacyIsAisleCol(displayIdx, cols, mode, showAisle) {
  if (!showAisle) return false;
  if (mode === 'single') return displayIdx % 2 === 1;
  const total = legacyDisplayColCount(cols, mode, showAisle);
  return displayIdx >= 2 && (displayIdx - 2) % 3 === 0 && displayIdx < total;
}

// 任意形状 → 规整 rows×cols 矩阵（缺的补 null）。
// 老写入路径可能存的是扁平对象数组（{row,col,student_id,name}，1 基），不能直接按下标取。
// 这里刻意不用 services/sanitize 的 normalizeSeats：它遇到超上限/重复坐标会抛，
// 迁移要的是「尽力搬过去」，一条脏记录不该让整次迁移失败（宁可补 null 也不能丢表）。
function toMatrix(value, rows, cols) {
  const arr = Array.isArray(value) ? value : [];
  const flat = arr.length > 0 && arr.every((el) => el && typeof el === 'object' && !Array.isArray(el));
  if (flat) {
    const m = Array.from({ length: rows }, () => Array(cols).fill(null));
    for (const el of arr) {
      const r = Number(el.row) - 1;
      const c = Number(el.col) - 1;
      if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
      if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
      const name = typeof el.name === 'string' ? el.name.trim() : '';
      m[r][c] = el.student_id != null ? el.student_id : (name || null);
    }
    return m;
  }
  const m = [];
  for (let r = 0; r < rows; r++) {
    const src = Array.isArray(arr[r]) ? arr[r] : [];
    const line = [];
    for (let c = 0; c < cols; c++) line.push(src[c] === undefined ? null : src[c]);
    m.push(line);
  }
  return m;
}

// dense（旧）→ 网格（新）：走廊列原样展开成真实列，走廊格里 seats/weights 一律 null。
// 走廊格存 null 而不是空串或 0：所有「逐格读 id / 读权重」的老代码天然跳过 null，
// 不需要额外判断；「这格是走廊」这个信息由 types 单独承担，两件事不混在一个值里。
function expandGrid({ rows, cols, mode, showAisle, seats, weights }) {
  const total = legacyDisplayColCount(cols, mode, showAisle);
  const denseSeats = toMatrix(seats, rows, cols);
  const denseWeights = toMatrix(weights, rows, cols);
  const outSeats = [];
  const outTypes = [];
  const outWeights = [];
  for (let r = 0; r < rows; r++) {
    const s = [];
    const t = [];
    const w = [];
    let real = 0;
    for (let d = 0; d < total; d++) {
      if (legacyIsAisleCol(d, cols, mode, showAisle)) {
        s.push(null);
        t.push(SEAT_CELL.AISLE);
        w.push(null);
      } else {
        s.push(denseSeats[r][real]);
        t.push(SEAT_CELL.SEAT);
        w.push(denseWeights[r][real]);
        real++;
      }
    }
    outSeats.push(s);
    outTypes.push(t);
    outWeights.push(w);
  }
  return { cols: total, seats: outSeats, types: outTypes, weights: outWeights };
}

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

// 已迁：types 是非空二维数组（迁移写的一定是满矩阵，至少 1×1）
function isMigrated(types) {
  return Array.isArray(types) && types.length > 0 && Array.isArray(types[0]) && types[0].length > 0;
}

function tableExists(conn, name) {
  return !!conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function readSize(row) {
  const rows = Number(row.rows);
  const cols = Number(row.cols);
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) return null;
  return { rows, cols };
}

function showAisleOf(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return s.showAisle !== false;
}

// current / template / draft / weight 四行
function migrateSeatSlots(conn) {
  const stat = { migrated: 0, skipped: 0 };
  const recs = conn.prepare('SELECT kind, mode, rows, cols, seats, types, weights, settings FROM seat_slots').all();
  const upd = conn.prepare('UPDATE seat_slots SET mode = ?, rows = ?, cols = ?, seats = ?, types = ?, weights = ? WHERE kind = ?');
  for (const rec of recs) {
    if (isMigrated(parseJson(rec.types, null))) { stat.skipped++; continue; }
    const size = readSize(rec);
    if (!size) { stat.skipped++; continue; }
    const isWeight = rec.kind === 'weight';
    const mode = rec.mode || 'single';
    const g = expandGrid({
      rows: size.rows,
      cols: size.cols,
      mode,
      showAisle: showAisleOf(parseJson(rec.settings, {})),
      seats: isWeight ? [] : parseJson(rec.seats, []),
      weights: isWeight ? parseJson(rec.weights, []) : [],
    });
    // 不动的列原样写回（weight 行不存 seats、其它行不存 weights），避免顺手清掉别的东西
    upd.run(
      mode,
      size.rows,
      g.cols,
      isWeight ? rec.seats : JSON.stringify(g.seats),
      JSON.stringify(g.types),
      isWeight ? JSON.stringify(g.weights) : rec.weights,
      rec.kind,
    );
    stat.migrated++;
  }
  return stat;
}

// domain_history 里 domain='seat' 的全部历史快照 payload
function migrateSeatHistory(conn) {
  const stat = { migrated: 0, skipped: 0 };
  const recs = conn.prepare("SELECT id, mode, payload FROM domain_history WHERE domain = 'seat'").all();
  const upd = conn.prepare('UPDATE domain_history SET mode = ?, payload = ? WHERE id = ?');
  for (const rec of recs) {
    const p = parseJson(rec.payload, null);
    if (!p || typeof p !== 'object') { stat.skipped++; continue; }
    if (isMigrated(p.types)) { stat.skipped++; continue; }
    const size = readSize(p);
    if (!size) { stat.skipped++; continue; }
    const mode = p.mode || rec.mode || 'single';
    const settings = p.settings && typeof p.settings === 'object' ? p.settings : {};
    const g = expandGrid({
      rows: size.rows,
      cols: size.cols,
      mode,
      showAisle: showAisleOf(settings),
      seats: p.seats,
      weights: [],
    });
    // settings 原样保留（showAisle 的语义由渲染层在下一批废弃，历史快照不必改写）
    upd.run(mode, JSON.stringify({
      ...p,
      mode,
      cols: g.cols,
      seats: g.seats,
      types: g.types,
      aisleCols: [],
    }), rec.id);
    stat.migrated++;
  }
  return stat;
}

/**
 * 座位几何矩阵化的一次性迁移。
 * 必须在 migrateSeat（建 seat_slots）与 migrateHistory（建 domain_history）之后调用。
 * 整体一个事务：四行槽位与全部历史快照要么全迁、要么全不迁 ——
 * 只迁了一半的库在界面上看不出任何异常，但座位指数会算错。
 */
function migrateSeatGrid(conn) {
  const run = conn.transaction(() => {
    const slots = tableExists(conn, 'seat_slots') ? migrateSeatSlots(conn) : { migrated: 0, skipped: 0 };
    const history = tableExists(conn, 'domain_history') ? migrateSeatHistory(conn) : { migrated: 0, skipped: 0 };
    return { slots, history };
  });
  return run();
}

module.exports = {
  migrateSeatGrid,
  migrateSeatSlots,
  migrateSeatHistory,
  expandGrid,
  legacyDisplayColCount,
  legacyIsAisleCol,
};
