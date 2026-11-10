// =========================================================================
// seatGrid.js —— 座位「网格几何」的后端唯一入口
//
// 数据模型（异形网格改造后，与前端 composables/useSeatGrid.geometry.js 同构）：
//   seats  rows×cols 二维数组，走廊格 / 空位格恒为 null
//   types  rows×cols 整数矩阵：0=座位 1=走廊 2=空位（SEAT_CELL，见 services/sanitize.js）
//   cols   网格总列数（含走廊列），不再是「座位列数」
//
// 走廊是**数据里的真实列**，所以任何「第几列」的对外文案都必须走 columnLabels /
// gridToDenseCols 换算，不能直接拿网格下标当列号 —— 否则一张 7 座位列的座位表
// 会告诉用户「第3行第13列」，而页面上那一格写的是「列7」。
//
// 这里只放**纯计算**：不读库、不 parse JSON（调用方自己 safeJson / aiParseJson）。
// 导出型需求（Excel / AI 排布图）与检索型需求（按姓名找座位、查重）都从这里取，
// 不要再在各自文件里复制一份 columnKinds —— 后端此前为此有过三份拷贝。
// =========================================================================
const { SEAT_CELL } = require('./sanitize');

// 每列是「走廊列」（整列都是走廊）还是「座位列」。
// 后端校验保证走廊只能整行或整列，所以合法数据下整列判定是准的；
// 局部走廊（行走廊与列走廊交叉格）归到「座位列」侧，宁可多算一列也不吞数据。
function columnKinds(cols, types) {
  const arr = Array.isArray(types) ? types : [];
  const kinds = [];
  for (let c = 0; c < cols; c++) {
    let allAisle = arr.length > 0;
    for (let r = 0; r < arr.length; r++) {
      if (!Array.isArray(arr[r]) || arr[r][c] !== SEAT_CELL.AISLE) { allAisle = false; break; }
    }
    kinds.push(allAisle ? 'aisle' : 'seat');
  }
  return kinds;
}

// 座位列在网格里的下标（升序），相当于旧模型里的「真实列」
function seatColumnIndices(cols, types) {
  const kinds = columnKinds(cols, types);
  const out = [];
  for (let c = 0; c < cols; c++) if (kinds[c] === 'seat') out.push(c);
  return out;
}

// 网格列下标 → 座位列序号（0 基，dense 序号）；走廊列为 -1。
// 用于「网格里存数据、对外按座位列报位置」的场景。
function gridToDenseCols(cols, types) {
  const idx = seatColumnIndices(cols, types);
  const map = new Array(cols).fill(-1);
  idx.forEach((c, k) => { map[c] = k; });
  return map;
}

// 表头文案：走廊列标「走廊」，其余按座位列序号标「列N」
function columnLabels(cols, types) {
  const kinds = columnKinds(cols, types);
  const labels = [];
  let seatNo = 0;
  for (let c = 0; c < cols; c++) labels.push(kinds[c] === 'aisle' ? '走廊' : `列${++seatNo}`);
  return labels;
}

// 整行都是走廊（行走廊）—— 异形教室里被过道占掉的一整排
function rowIsAisle(types, r) {
  const line = Array.isArray(types) ? types[r] : null;
  if (!Array.isArray(line) || !line.length) return false;
  return line.every((v) => v === SEAT_CELL.AISLE);
}

// 该网格列是不是座位列（走廊列返回 false）
function isSeatColumn(cols, types, c) {
  return columnKinds(cols, types)[c] === 'seat';
}

module.exports = {
  SEAT_CELL,
  columnKinds,
  seatColumnIndices,
  gridToDenseCols,
  columnLabels,
  rowIsAisle,
  isSeatColumn,
};
