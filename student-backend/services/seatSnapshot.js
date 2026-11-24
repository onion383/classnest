// =========================================================================
// seatSnapshot.js —— 座位「历史快照 payload」的唯一构造点
//
// 快照 payload 由三处写入：/snapshot（前端整块提交，直接用请求体）、
// /snapshot/backfill（从当前布局复制）、AI 整块写入前的自动快照。
// 后两处原本各写一份字段表，结果只加了 seats 忘了 types ——
// 走廊是真实列之后，快照缺 types 会让回看历史时走廊列显示成「空座位」，
// 座位指数也按错误的列位去乘权重（不报错、界面正常、数字永久偏移）。
//
// 所以字段表只留这一份：新增几何字段时改这里，三个写入点自动跟上。
// =========================================================================
const { readDocJson } = require('../utils/json');
const store = require('./slotStore');
const { normalizeSeats, normalizeCellTypes, SEAT_MAX_ROWS, SEAT_MAX_GRID_COLS } = require('./sanitize');
const { isDateStr } = require('../utils/sql');
const { mondayOf } = require('../utils/date');

// rows/cols 描述的是整个矩阵（含走廊列）；上限在 sanitize 里定义，这里不手抄常量。
function validateSeatSize(rows, cols) {
  if (rows < 1 || rows > SEAT_MAX_ROWS) return `行数需在 1 ~ ${SEAT_MAX_ROWS} 之间`;
  if (cols < 1 || cols > SEAT_MAX_GRID_COLS) return `列数需在 1 ~ ${SEAT_MAX_GRID_COLS} 之间`;
  return null;
}

// 把规范化后的 seats 裁剪/补齐到 rows×cols；快照写进历史后会被座位指数与回看消费，
// 尺寸与 rows/cols 脱节会错位且事后没有自动修正机会。
function fitSeatsToGrid(normSeats, rows, cols) {
  const trimmed = normSeats.slice(0, rows).map((r) => {
    const row = Array.isArray(r) ? r.slice(0, cols) : [];
    while (row.length < cols) row.push(null);
    return row;
  });
  while (trimmed.length < rows) trimmed.push(Array(cols).fill(null));
  return trimmed;
}

// 快照专用的格型矩阵校验：入参是数组（不是 JSON 字符串），返回 { skip } / { value } / { error }。
// 与 seatWrite.parseTypesForWrite（单格写入、吃字符串）是两个不同契约，不能合并。
function parseTypesForWrite(raw, rows, cols) {
  if (raw === undefined) return { skip: true };
  try {
    return { value: normalizeCellTypes(raw, rows, cols) };
  } catch (e) {
    return { error: e.message };
  }
}

// 手工快照的校验 + 写入唯一实现。
// 原挂在 POST /api/seats/snapshot（前端零调用），X2-02 删路由后下沉到这里；
// seat-snapshot-validation.test.js 直接调本函数，仍是真写 SQLite 再读回。
// 返回 { ok, error? }；任何校验失败都不碰库。
function saveManualSnapshot({ snap_date, mode, rows, cols, seats, types, settings }) {
  if (!snap_date) return { ok: false, error: '缺少快照日期' };
  if (!isDateStr(snap_date)) return { ok: false, error: '快照日期格式不正确（应为 YYYY-MM-DD）' };
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || !Array.isArray(seats)) {
    return { ok: false, error: '参数格式错误' };
  }
  const sizeError = validateSeatSize(rows, cols);
  if (sizeError) return { ok: false, error: sizeError };
  let normSeats;
  try { normSeats = normalizeSeats(seats, 'seats'); } catch (e) { return { ok: false, error: e.message }; }
  const trimmed = fitSeatsToGrid(normSeats, rows, cols);
  const parsedTypes = parseTypesForWrite(types, rows, cols);
  if (parsedTypes.error) return { ok: false, error: parsedTypes.error };
  store.histUpsert('seat', {
    weekStart: mondayOf(snap_date),
    snapDate: snap_date,
    mode: mode || 'single',
    payload: {
      mode: mode || 'single', rows, cols, seats: trimmed,
      // 走廊是真实列，几何必须随 payload 一起存，否则回看时走廊被当空座位。
      types: parsedTypes.skip ? [] : parsedTypes.value,
      aisleCols: [], groupsConfig: [], settings,
    },
  });
  return { ok: true };
}

// 从一条 seat_slots 记录（seat_layout / seat_template 视图）构造快照 payload。
// 读路径，JSON 列畸形时降级为空值（快照写坏不影响源数据）。
function seatSnapshotPayload(row) {
  const doc = readDocJson(row, { seats: [], types: [], settings: {} });
  return {
    mode: (row && row.mode) || 'single',
    rows: row ? row.rows : 0,
    cols: row ? row.cols : 0,
    seats: Array.isArray(doc.seats) ? doc.seats : [],
    types: Array.isArray(doc.types) ? doc.types : [],
    // 老字段保留空值：历史消费方（AI 检索、导出）仍按这两个键读
    aisleCols: [],
    groupsConfig: [],
    settings: doc.settings && typeof doc.settings === 'object' ? doc.settings : {},
  };
}

module.exports = { seatSnapshotPayload, validateSeatSize, fitSeatsToGrid, parseTypesForWrite, saveManualSnapshot };
