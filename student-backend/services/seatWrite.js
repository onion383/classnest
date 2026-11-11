// ==================== 座位单格写入的唯一入口 ====================
// 背景：座位有两条写路径 —— 整表 PUT（走 validateRow + normalizeSeats，校验齐）与
// 单格 PATCH（为撤销/增量拖拽加的旁路，只校了坐标与值的形状）。后者能绕过
// 「洞里/走廊里不能有人」「学生 id 必须存在」「一人一座」三类不变量，
// 而且绕过时**不报错**：界面按 types 渲染，那个人在空位分支里根本不显示，
// 座位指数按可用格跳过他，智能排表把他当未入座重排 —— 三处静默错误。
//
// 修法不是给两个 PATCH 路由各补一行 if（那是打补丁，下一个写入口还会漏），
// 而是把「写一格座位」收敛成这一个函数：坐标、值形状、可写性、引用关系全在这里，
// 路由只负责 HTTP 形状。新增任何单格写需求都必须经过它。
//
// 与读路径的分工（刻意不对称）：
//   · seats 解析失败 → 抛 500，**不降级**。写路径若把畸形数据降级成空数组，
//     会把整张座位表覆盖成只剩这一格 —— 数据直接丢。
//   · types 解析失败 → 按「全座位」处理并记日志，与 GET 的 readTypes 同口径。
//     types 是后加的列，老库/老客户端留下的畸形值不该让用户连拖动都做不了；
//     洞的守卫在数据正常时生效，数据损坏时由读路径的降级暴露给用户。
const store = require('./slotStore');
const { normalizeCellTypes, assertSeatCell, SEAT_MAX_ROWS, SEAT_MAX_GRID_COLS } = require('./sanitize');
const { assertSeatCellWritable } = require('./businessRules');
const { SEAT_CURRENT_SLOTS } = require('../schema/tableRegistry');

// 只有这两张表有「当前座位」语义。做成白名单而不是直接拼表名：
// 调用方传错表名时必须当场失败，不能写进 seat_draft / seat_weight。
// 名单在 schema/tableRegistry.js 统一维护，这里不再手抄一份。
const SEAT_TABLES = new Set(SEAT_CURRENT_SLOTS);

class SeatWriteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SeatWriteError';
    this.status = status;
  }
}

function parseSeatsForWrite(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SeatWriteError(`座位数据损坏，拒绝写入（避免把整表覆盖成单格）：${err.message}`, 500);
  }
  if (!Array.isArray(parsed)) {
    throw new SeatWriteError('座位数据不是二维数组，拒绝写入（避免把整表覆盖成单格）', 500);
  }
  return parsed;
}

function parseTypesForWrite(raw, rows, cols) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.length) return [];
  try {
    return normalizeCellTypes(parsed, rows, cols);
  } catch (err) {
    console.error('[seatWrite] 格子类型矩阵畸形，本次按全座位处理:', err.message);
    return [];
  }
}

// 当前布局（严格读：写路径不降级）
function readSeatDoc(table) {
  const rec = store.getDoc(table);
  if (!rec) {
    // schema 里两种 kind 都是 INSERT OR IGNORE 种好的，正常不会走到这里。
    // 走到这里说明库结构与代码不匹配，setDoc 会静默 UPDATE 0 行 —— 必须显式失败。
    throw new SeatWriteError(`座位表 ${table} 尚未初始化，无法写入`, 500);
  }
  const rows = Number(rec.rows);
  const cols = Number(rec.cols);
  return {
    rows: Number.isInteger(rows) && rows > 0 ? rows : null,
    cols: Number.isInteger(cols) && cols > 0 ? cols : null,
    seats: parseSeatsForWrite(rec.seats),
    types: parseTypesForWrite(rec.types, rows, cols),
  };
}

// 坐标：必须落在**当前布局**内，布局字段缺失时退回全局上限。
// 为什么按当前 rows/cols 而不只按全局 50×60：单格写是唯一不经过 normalizeSeats 的
// 座位写入口（它按坐标就地改一格）。不卡当前布局的话，row=10 的提交能把 seats 撑到 11 行、
// 而 rows/cols 仍写着旧值 —— 前端按 rows/cols 渲染，多出来的行永远看不见却一直占着库；
// 更糟的是下一次整块 PUT 按 rows 裁剪（slice(0, rows)）会把它静默丢掉，用户丢了数据都不知道。
function assertCellInLayout(doc, row, col) {
  if (doc.rows != null && row >= doc.rows) {
    throw new SeatWriteError(`行坐标超出当前座位表范围（当前 ${doc.rows} 行）`);
  }
  if (doc.cols != null && col >= doc.cols) {
    throw new SeatWriteError(`列坐标超出当前座位表范围（当前 ${doc.cols} 列）`);
  }
  if (row >= SEAT_MAX_ROWS) throw new SeatWriteError(`行坐标需在 0 ~ ${SEAT_MAX_ROWS - 1} 之间`);
  if (col >= SEAT_MAX_GRID_COLS) throw new SeatWriteError(`列坐标需在 0 ~ ${SEAT_MAX_GRID_COLS - 1} 之间`);
}

/**
 * 写一个座位格（唯一入口）。
 * 成功返回写入后的格子值；失败抛 SeatWriteError（400 = 参数/业务不允许，500 = 库内数据损坏）。
 */
function writeSeatCell(table, row, col, value) {
  if (!SEAT_TABLES.has(table)) throw new SeatWriteError(`不支持的座位表：${table}`, 500);
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) {
    throw new SeatWriteError('参数格式错误');
  }

  const doc = readSeatDoc(table);
  assertCellInLayout(doc, row, col);

  // 值形状：空值 / 数字 / ≤20 字文本。与 PUT 走 normalizeSeats 时的元素级校验同一强度
  try {
    assertSeatCell(value, 'seats', row, col);
  } catch (err) {
    throw new SeatWriteError(err.message);
  }

  // 业务不变量：这一格能不能坐人（洞里/走廊里不行，id 得存在，不能一人两座）
  try {
    assertSeatCellWritable(doc.seats, doc.types, row, col, value);
  } catch (err) {
    throw new SeatWriteError(err.message);
  }

  const seats = doc.seats;
  if (!Array.isArray(seats[row])) seats[row] = [];
  seats[row][col] = value == null ? null : value;
  store.setDoc(table, { seats: JSON.stringify(seats) });
  return seats[row][col];
}

// 只导出对外真正需要的两个：写入入口与错误类型（路由靠 instanceof 分流 400/500）。
// readSeatDoc 等内部函数不导出 —— 让「读布局」只有一个消费点，避免又长出第二套读口径。
module.exports = { writeSeatCell, SeatWriteError };
