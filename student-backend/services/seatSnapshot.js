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

module.exports = { seatSnapshotPayload };
