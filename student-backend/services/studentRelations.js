// 学生「关联数据」服务：为「删除学生」提供影响预览与关联清理。
//
// 背景：students 与 请假/加分/座位/值日 之间没有外键，关联是松耦合的——
//   请假/加分：优先用 student_id，老数据可能只有姓名（student_id 为 null）；
//   座位：seats JSON 里可能是纯数字 id、{student_id,name} 对象，或姓名字符串；
//   值日：cells 里只存了姓名。
// 因此删除学生时若不处理，就会留下指向不存在学生的孤儿数据。本模块集中解决两件事：
//   1) studentRelations(student)     统计该生被哪些记录引用（删除前预览）；
//   2) purgeStudentRelations(student) 按勾选清理这些引用（确认「一并删除」时调用）。
//
// db 为多库代理：本模块只读写当前请求绑定的班主任库。
const { db } = require('../db');
const store = require('./slotStore');
const { countDutyRefs, collectDutyRefs, removeDutyName } = require('./dutyCells');

function readSeats() {
  try {
    const rec = store.getDoc('seat_layout');
    return rec ? JSON.parse(rec.seats) : [];
  } catch (_) {
    return [];
  }
}

// ---------- 值日 cells 解析：{项目:{星期:[姓名,...]}} ----------
function readDutyCells() {
  try {
    const rec = store.getDoc('duty_layout');
    return rec ? JSON.parse(rec.cells) : {};
  } catch (_) {
    return {};
  }
}

// 统计某生被引用的位置：请假 / 加分 / 座位 / 值日 / 小组 / 班干部
function studentRelations(student) {
  const id = student.id;
  const name = student['姓名'];
  const leave = db.prepare('SELECT COUNT(*) AS c FROM leave_records WHERE student_id = ? OR (student_id IS NULL AND TRIM(姓名) = TRIM(?))').get(id, name).c;
  const score = db.prepare('SELECT COUNT(*) AS c FROM score_records WHERE student_id = ? OR (student_id IS NULL AND TRIM(姓名) = TRIM(?))').get(id, name).c;
  // 小组只存姓名（没有 student_id），班干部两者都有：
  // 这两处原先既不在统计里、也不在清理里，删完学生后小组和班干部里会留着已删除的人，
  // 而删除确认框也不提 —— 用户没有任何机会知道。
  const group = db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE TRIM(member_name) = TRIM(?)').get(name).c;
  const cadre = db.prepare('SELECT COUNT(*) AS c FROM cadre_members WHERE student_id = ? OR TRIM(student_name) = TRIM(?)').get(id, name).c;

  // 座位预览与清理共用 seatRefCells 的同一份匹配逻辑：
  // 原先这里另写一套「ids 命中数 + names 命中数」，一个 {student_id, name} 对象格
  // 会被同时计入两次（一个座位显示成 2 个），而且与真正清理的口径慢慢就会分叉。
  const seat = seatRefCells(student).hits.length;

  const cells = readDutyCells();
  // cells 是 {daily,big} 打包结构，统计交给 dutyCells 逐模式遍历
  const duty = countDutyRefs(cells, name);
  return { leave, score, seat, duty, group, cadre, total: leave + score + seat + duty + group + cadre };
}

// 收集座位表里指向该生的全部格子（位置 + 原值）。
// 影响预览（studentRelations）与清理（purgeSeatRelation）都调用它 ——
// 「统计到的」必须就是「会被清掉的」，否则预览数字和实际清理结果会分叉。
// 记录**原位**信息不只是为了计数：撤销时要只把被清掉的格子放回去，而不是整块覆盖
// （整块覆盖会把删除之后用户对座位表的其它改动一并抹掉）。
function seatRefCells(student) {
  const seats = readSeats();
  const hits = [];
  if (!Array.isArray(seats)) return { seats: [], hits };
  for (let r = 0; r < seats.length; r++) {
    const row = seats[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      const hit = (typeof cell === 'number' && cell === student.id)
        || (typeof cell === 'string' && cell.trim() === student['姓名'])
        || (cell && typeof cell === 'object' && (
          cell.student_id === student.id
          || (typeof cell.name === 'string' && cell.name.trim() === student['姓名'])
          || (typeof cell['姓名'] === 'string' && cell['姓名'].trim() === student['姓名'])
        ));
      if (hit) hits.push({ row: r, col: c, cell });
    }
  }
  return { seats, hits };
}

// 清空座位里指向该生的格子（命中 id 或姓名），返回 { removed, cells }
// cells 是「被清掉的原位与原值」，供撤销时精确回填。
function purgeSeatRelation(student) {
  const { seats, hits } = seatRefCells(student);
  if (!hits.length) return { removed: 0, cells: [] };
  for (const h of hits) seats[h.row][h.col] = null;
  store.setDoc('seat_layout', { seats: JSON.stringify(seats) });
  return { removed: hits.length, cells: hits };
}

// 移除值日表里该生的姓名，返回 { removed, slots }
// slots 是「被清掉的位置与原值」，供撤销时精确插回。
function purgeDutyRelation(student) {
  const cells = readDutyCells();
  const slots = collectDutyRefs(cells, student['姓名']);
  if (!slots.length) return { removed: 0, slots: [] };
  // daily/big 两个模式都清；只在真的清掉时才回写
  const removed = removeDutyName(cells, student['姓名']);
  if (removed) store.setDoc('duty_layout', { cells: JSON.stringify(cells) });
  return { removed, slots };
}

// ---------- 撤销/重做「删除学生」时的座位与值日回填 ----------
// 只动被清掉的位置，不整块覆盖：用户可能在删除之后又调整过座位/值日，
// 整块回写会把那些改动一起抹掉。
function restoreSeatCells(cells) {
  if (!Array.isArray(cells) || !cells.length) return;
  const seats = readSeats();
  if (!Array.isArray(seats)) return;
  for (const h of cells) {
    const row = seats[h.row];
    // 布局已经删掉这一行：宁可少恢复一个人，也不在已删除的行上造幽灵座位
    if (!Array.isArray(row)) continue;
    while (row.length <= h.col) row.push(null);
    row[h.col] = h.cell;
  }
  store.setDoc('seat_layout', { seats: JSON.stringify(seats) });
}

function clearSeatCells(cells) {
  if (!Array.isArray(cells) || !cells.length) return;
  const seats = readSeats();
  if (!Array.isArray(seats)) return;
  for (const h of cells) {
    const row = seats[h.row];
    if (Array.isArray(row) && h.col < row.length) row[h.col] = null;
  }
  store.setDoc('seat_layout', { seats: JSON.stringify(seats) });
}

function restoreDutySlots(slots) {
  if (!Array.isArray(slots) || !slots.length) return;
  const cells = readDutyCells();
  // 按「同一天」分组、index 升序插回：同一天可能有多个同名项（手工录入的重复），
  // 逐个按原索引 splice 才能把顺序还原。
  const groups = new Map();
  for (const s of slots) {
    const key = `${s.mode}\u0000${s.item}\u0000${s.day}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const [key, list] of groups) {
    const [mode, item, day] = key.split('\u0000');
    const root = cells[mode] || (cells[mode] = {});
    const byDay = root[item] || (root[item] = {});
    if (!Array.isArray(byDay[day])) byDay[day] = [];
    const arr = byDay[day];
    for (const s of list.sort((a, b) => a.index - b.index)) {
      arr.splice(Math.min(s.index, arr.length), 0, s.value);
    }
  }
  store.setDoc('duty_layout', { cells: JSON.stringify(cells) });
}

// 重做「删除学生」时按姓名再清一次值日：
// 不用记下的 index —— 撤销/重做之间用户可能改过值日表，索引会位移，姓名才是稳定锚点。
function clearDutySlots(student) {
  const name = student && student['姓名'];
  if (!name) return;
  const cells = readDutyCells();
  if (removeDutyName(cells, name)) store.setDoc('duty_layout', { cells: JSON.stringify(cells) });
}

// 按勾选清理关联；返回清理计数 + 撤销所需的完整快照：
//   leaveRows / scoreRows / groupRows / cadreRows —— 被删的整行（含 id，可直接重建）
//   seatCells / dutySlots —— 座位与值日「被清掉的原位与原值」
// 「删除学生」现在是一条可撤销命令（student_cascade_delete），七处必须能一起回滚，
// 所以不再只回传计数：只回计数等于撤销时只能恢复半个人。
function purgeStudentRelations(student, opts = {}) {
  const id = student.id;
  const name = student['姓名'];
  const out = {
    leave: 0, score: 0, seat: 0, duty: 0, group: 0, cadre: 0,
    leaveRows: [], scoreRows: [], groupRows: [], cadreRows: [],
    seatCells: [], dutySlots: [],
  };

  if (opts.leave) {
    out.leaveRows = db.prepare('SELECT * FROM leave_records WHERE student_id = ? OR (student_id IS NULL AND TRIM(姓名) = TRIM(?))').all(id, name);
    out.leave = db.prepare('DELETE FROM leave_records WHERE student_id = ? OR (student_id IS NULL AND TRIM(姓名) = TRIM(?))').run(id, name).changes;
  }
  if (opts.score) {
    out.scoreRows = db.prepare('SELECT * FROM score_records WHERE student_id = ? OR (student_id IS NULL AND TRIM(姓名) = TRIM(?))').all(id, name);
    out.score = db.prepare('DELETE FROM score_records WHERE student_id = ? OR (student_id IS NULL AND TRIM(姓名) = TRIM(?))').run(id, name).changes;
  }
  if (opts.seat) {
    const res = purgeSeatRelation(student);
    out.seat = res.removed;
    out.seatCells = res.cells;
  }
  if (opts.duty) {
    const res = purgeDutyRelation(student);
    out.duty = res.removed;
    out.dutySlots = res.slots;
  }
  if (opts.group) {
    out.groupRows = db.prepare('SELECT * FROM group_members WHERE TRIM(member_name) = TRIM(?)').all(name);
    out.group = db.prepare('DELETE FROM group_members WHERE TRIM(member_name) = TRIM(?)').run(name).changes;
  }
  if (opts.cadre) {
    out.cadreRows = db.prepare('SELECT * FROM cadre_members WHERE student_id = ? OR TRIM(student_name) = TRIM(?)').all(id, name);
    out.cadre = db.prepare('DELETE FROM cadre_members WHERE student_id = ? OR TRIM(student_name) = TRIM(?)').run(id, name).changes;
  }

  return out;
}

module.exports = {
  studentRelations,
  purgeStudentRelations,
  restoreSeatCells,
  clearSeatCells,
  restoreDutySlots,
  clearDutySlots,
};
