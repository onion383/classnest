// =========================================================================
// studentRename.js —— 学生改名时的关联姓名同步
//
// 本项目的人际关联是「id 优先 / 姓名兜底」的松耦合结构，其中**只存姓名**的几处
// 不会随 students 表改名自动更新：
//   · duty_layout.cells        值日表（只存姓名）
//   · seat_layout.seats        座位（可能是字符串，也可能是 {student_id,name} 对象）
//   · score_records.姓名       加减分（老数据 student_id 为 null，靠姓名认人）
//   · leave_records.姓名       请假（同上）
//   · group_members.member_name 小组成员
//   · cadre_members.student_name 班干部担任学生
//
// 后果最重的是值日指数：账本按姓名归集（DutyView 的 acc[name]），
// 改名后历史值日全挂在旧名下、新名字从 0 开始算，而界面不会报任何错。
//
// **歧义保护**：姓名在这些表里不是唯一键。如果旧名还有另一个学生（同名），
// 逐处改名会连那个人的数据一起改掉。所以只在「旧名已不再被其他学生使用」时才级联，
// 否则跳过并把原因回给调用方 —— 宁可不同步，也不能改错人。
// =========================================================================
const { db } = require('../db');
const store = require('./slotStore');
const { safeJson } = require('../utils/json');
const { renameDutyName } = require('./dutyCells');

function nameStillUsedByOthers(oldName) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM students WHERE 姓名 = ?').get(oldName);
  return (row ? row.c : 0) > 0;
}

// 座位里可能是 "姓名"、"123"（id）、{student_id,name}、{姓名}：四种都认
//
// 匹配口径与值日表一致：**trim 后比较**，写回一律写规范名（newName）。
// 座位是手工录入的网格，历史数据可能带首尾空格（' 张三 '）—— 各分支口径不一致时
// （字符串用 trim、对象用严格 ===），改名后同一学生在座位表里一半新名一半旧名。
// 写回不保留原空格：下游 SeatView 的 acc[name] 是精确键聚合，留空格会让统计键分裂。
function renameSeatCells(seats, oldName, newName) {
  let changed = 0;
  if (!Array.isArray(seats)) return changed;
  for (const row of seats) {
    if (!Array.isArray(row)) continue;
    for (let i = 0; i < row.length; i++) {
      const cell = row[i];
      if (typeof cell === 'string' && cell.trim() === oldName) {
        row[i] = newName; changed++; continue;
      }
      if (cell && typeof cell === 'object') {
        if (typeof cell.name === 'string' && cell.name.trim() === oldName) { cell.name = newName; changed++; }
        if (typeof cell['姓名'] === 'string' && cell['姓名'].trim() === oldName) { cell['姓名'] = newName; changed++; }
      }
    }
  }
  return changed;
}

// 返回 { changed, skipped, counts }；skipped 为 'duplicate-name' 时调用方应提示用户
function renameStudentRefs(oldName, newName) {
  const from = String(oldName || '').trim();
  const to = String(newName || '').trim();
  if (!from || !to || from === to) return { changed: false, counts: {} };
  // 调用点约定：students 行**已经**改成新名字后再调用，所以这里查到的就是「其余同名者」
  if (nameStillUsedByOthers(from)) return { changed: false, skipped: 'duplicate-name', counts: {} };

  const counts = { duty: 0, seat: 0, score: 0, leave: 0, group: 0, cadre: 0 };

  // 六处联写必须原子：分成六次提交时，中途任一步抛错（库忙、磁盘满、SQL 约束）
  // 都会留下「前面表改了、后面表没改」的状态 —— 同一学生在值日表叫新名、
  // 在加减分表叫旧名，界面不报任何错，历史值日指数也再也归不到他名下。
  // better-sqlite3 的事务是同步的，被外层事务调用时自动降级为 SAVEPOINT。
  db.transaction(() => {
    const duty = store.getDoc('duty_layout');
    if (duty) {
      const cells = safeJson(duty.cells, {});
      counts.duty = renameDutyName(cells, from, to);
      if (counts.duty) store.setDoc('duty_layout', { cells: JSON.stringify(cells) });
    }

    const seat = store.getDoc('seat_layout');
    if (seat) {
      const seats = safeJson(seat.seats, []);
      counts.seat = renameSeatCells(seats, from, to);
      if (counts.seat) store.setDoc('seat_layout', { seats: JSON.stringify(seats) });
    }

    // 四张「只存姓名」的表：SQL 侧用 TRIM(列) 匹配，与上面两处 JSON 表的
    // trim 比较保持同一口径。
    //
    // 为什么不直接 `WHERE 姓名 = ?`：值日表/座位表的值日名单与座位格是手工录入的
    // JSON，**写入路径只查类型、不 trim**（assertDutyCellShape / assertSeatCell），
    // 库里确实可能存在 ' 张三 ' 这种带空格的旧名。而这四张表虽然常规写入都过
    // sanitizeField（会 trim），历史数据与直接改库仍可能带空格 —— 一旦某张表漏改，
    // 同一学生就在不同表里叫不同名字，界面不报任何错。
    //
    // 这四张表的姓名列本来就没有索引（只有 students.姓名 有），TRIM 匹配不影响性能。
    counts.score = db.prepare('UPDATE score_records SET 姓名 = ? WHERE TRIM(姓名) = ?').run(to, from).changes;
    counts.leave = db.prepare('UPDATE leave_records SET 姓名 = ? WHERE TRIM(姓名) = ?').run(to, from).changes;
    counts.group = db.prepare('UPDATE group_members SET member_name = ? WHERE TRIM(member_name) = ?').run(to, from).changes;
    counts.cadre = db.prepare('UPDATE cadre_members SET student_name = ? WHERE TRIM(student_name) = ?').run(to, from).changes;
  })();

  const changed = Object.values(counts).some((n) => n > 0);
  return { changed, counts };
}

module.exports = { renameStudentRefs };
