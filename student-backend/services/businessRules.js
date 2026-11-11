// 依赖既有数据的一致性校验层：入库前检查「引用了不存在的学生 / 项目 / 星期」、
// 座位越界、请假时间段倒置等——这些是单列 schema 校验（services/sanitize.js）覆盖不到的。
//
// 与 sanitize.js 的分工：
//   sanitize.js    管「单列自身的形状 / 类型 / 范围」（如 seats 必须是二维数组、金额范围）；
//   businessRules  管「这一列的内容与库里其他表是否对得上」（如座位里的学生 id 是否真实存在）。
// 所有写库路径（AI 整块写入 / 座位 / 值日 / 请假）共用同一入口 validateRow，避免逐处打补丁。

const { db } = require('../db');
const { resolveNames } = require('./provisionalStudents');
const { SEAT_CELL } = require('./sanitize');
// 报座位位置时按「座位列序号」算列号（走廊不计入），与页面表头/导出/检索同口径
const { gridToDenseCols } = require('./seatGrid');
// 列名的唯一读取入口（日常值日=星期几，大扫除=分组名+全部）
const dutyConfig = require('./dutyConfig');

// 业务校验失败 = 用户数据填错了，不是服务器故障。
// 带 status 让统一错误出口（app.js）回 400：此前这些错误全是裸 Error，一路 500，
// 前端看到的「服务器错误」会把「少写了一个学生 / 时间填反了」误导成后端崩了，
// 而单格 PATCH 又自己回 400 —— 同一类错误两个状态码。判据只在抛出处定义一次。
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

// —— 通用工具 ——
function toObj(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return null;
}
// 日期时间归一为可比较文本：仅日期补 00:00:00，到分钟补 :00（供前后比较）
function normDT(s) {
  const t = String(s);
  return t.length <= 10 ? `${t} 00:00:00` : (t.length === 16 ? `${t}:00` : t);
}

// 学生 id / 姓名集合（每次实时查询，避免缓存与学生增删不同步）
function studentIdSet() {
  return new Set(db.prepare('SELECT id FROM students').all().map((r) => Number(r.id)));
}
function studentNameSet() {
  return new Set(db.prepare('SELECT 姓名 FROM students').all().map((r) => String(r.姓名)));
}

// —— 座位：数字格子（即学生 id）必须真实存在，且「一人一座」不得重复 ——
// types 可选：给了就按「座位列序号」报列（走廊不计入列号），与页面表头/导出/检索口径一致。
function assertSeatRefs(seats, name, types) {
  if (!Array.isArray(seats)) return;
  const ids = studentIdSet();
  const seen = new Map(); // 学生 id -> 已占位置描述
  const width = seats.reduce((mx, row) => (Array.isArray(row) ? Math.max(mx, row.length) : mx), 0);
  const dense = Array.isArray(types) && types.length ? gridToDenseCols(width, types) : null;
  const colNo = (c) => (dense && dense[c] >= 0 ? dense[c] + 1 : c + 1);
  seats.forEach((row, r) => {
    if (!Array.isArray(row)) return;
    row.forEach((cell, c) => {
      if (typeof cell !== 'number') return;
      if (!ids.has(cell)) throw new ValidationError(`字段「${name}」引用了不存在的学生（id=${cell}）`);
      // 一人一座：同一学生 id 不能出现在两个位置，否则必然有学生没座位
      if (seen.has(cell)) {
        throw new ValidationError(`座位表一名学生只能占一个座位：id=${cell} 同时出现在 ${seen.get(cell)} 与 第${r + 1}行第${colNo(c)}列`);
      }
      seen.set(cell, `第${r + 1}行第${colNo(c)}列`);
    });
  });
}

// —— 单格写入的可写性（按「增量」判，不做全表重校）——
// 整表 PUT 走 validateRow（全表重校）；单格 PATCH 只改一格。单格路径若也做全表重校，
// 历史库里任何一处早已存在的不合规（越界行 / 幽灵 id / 洞里的人）都会让**每一次**拖动失败 ——
// 用户反而失去唯一的自愈途径。所以这里只判「这一格」。
// 判据与 assertSeatRefs / assertSeatCellsOccupiable 同源（同一 SEAT_CELL 常量、同一 dense 列号口径），
// 不另写一套规则：新增的写入口只要调这一个函数，就不会再出现「某条路径少校验一项」。
// 清空（null / 空串）永远放行 —— 把错放在空位或走廊里的人移走，是修复数据的前提。
function assertSeatCellWritable(seats, types, row, col, value) {
  const width = Math.max(
    Array.isArray(seats) ? seats.reduce((mx, line) => (Array.isArray(line) ? Math.max(mx, line.length) : mx), 0) : 0,
    col + 1,
  );
  const dense = Array.isArray(types) && types.length ? gridToDenseCols(width, types) : null;
  const colNo = (c) => (dense && dense[c] >= 0 ? dense[c] + 1 : c + 1);

  if (value == null || value === '') return;

  const kind = Array.isArray(types) && Array.isArray(types[row]) ? Number(types[row][col]) : SEAT_CELL.SEAT;
  if (seatKindBlocksStudent(kind)) {
    throw new ValidationError(`第 ${row + 1} 行第 ${colNo(col)} 列${SEAT_KIND_BLOCK[kind].cellHint}`);
  }

  // 名字文本走 normalizeSeats 的形状校验，且不参与「一人一座」（名册外临时学生靠姓名入座）
  if (typeof value !== 'number') return;
  if (!studentIdSet().has(value)) throw new ValidationError(`座位引用了不存在的学生（id=${value}）`);

  // 一人一座：同一 id 不能同时出现在两格（本次要写的那一格不算）
  for (let r = 0; r < seats.length; r++) {
    const line = seats[r];
    if (!Array.isArray(line)) continue;
    for (let c = 0; c < line.length; c++) {
      if (r === row && c === col) continue;
      if (line[c] !== value) continue;
      throw new ValidationError(`座位表一名学生只能占一个座位：id=${value} 已在第 ${r + 1} 行第 ${colNo(c)} 列`);
    }
  }
}

// —— 座位格子类型矩阵（types）：形状 + 值域 + 「走廊只能整行或整列」——
// 形状/值域在 services/sanitize.js 的 normalizeCellTypes 里已经做过一遍，这里再校一次，
// 是因为写库路径不止 routes/seats.js 一条（AI 整块写入直接走 validateRow，不经过裁剪）。
// 「整行/整列」这条只有这里能守：允许「一列里一半是走廊」的话，排表侧把走廊列压掉
// 得到的就不再是矩形，「双人桌从偶数列开始」那一整套判据会当场失效。
function assertSeatTypes(types, rows, cols) {
  if (!Array.isArray(types) || !types.length) return;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) return;
  const name = 'types';
  if (types.length !== rows) {
    throw new ValidationError(`字段「${name}」有 ${types.length} 行，应与座位行数 ${rows} 一致`);
  }
  for (let r = 0; r < rows; r++) {
    const line = types[r];
    if (!Array.isArray(line)) throw new ValidationError(`字段「${name}」第 ${r + 1} 行应为数组`);
    if (line.length !== cols) {
      throw new ValidationError(`字段「${name}」第 ${r + 1} 行有 ${line.length} 格，应与座位列数 ${cols} 一致`);
    }
    for (let c = 0; c < cols; c++) {
      const v = Number(line[c]);
      if (!Number.isInteger(v) || v < SEAT_CELL.SEAT || v > SEAT_CELL.HOLE) {
        throw new ValidationError(`字段「${name}」第 ${r + 1} 行第 ${c + 1} 列应为 0/1/2（座位/走廊/空位），收到：${JSON.stringify(line[c])}`);
      }
    }
  }
  const rowAllAisle = types.map((line) => line.every((v) => Number(v) === SEAT_CELL.AISLE));
  const colAllAisle = Array.from({ length: cols }, (_, c) => types.every((line) => Number(line[c]) === SEAT_CELL.AISLE));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (Number(types[r][c]) !== SEAT_CELL.AISLE) continue;
      if (!rowAllAisle[r] && !colAllAisle[c]) {
        throw new ValidationError(`走廊只能整行或整列设置：第 ${r + 1} 行第 ${c + 1} 列是走廊，但该行与该列都不是整行/整列走廊`);
      }
    }
  }
}

// —— 值日：解析 duty_settings 里的劳动项目（按模式分键 { daily: [...], big: [...] }）——
// 返回 { names:Set<项目名>, maps:{ daily:Map<项目名,人数>, big:Map<项目名,人数> } }
function parseDutyItems(raw) {
  let obj = raw;
  if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch (_) { obj = null; } }
  const names = new Set();
  const maps = { daily: new Map(), big: new Map() };
  const add = (mode, arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((it) => {
      if (!it || typeof it !== 'object') return;
      const nm = it.name != null ? String(it.name) : null;
      if (!nm) return;
      names.add(nm);
      const cnt = Number(it.count);
      if (Number.isFinite(cnt) && cnt > 0) maps[mode].set(nm, cnt);
    });
  };
  if (obj && typeof obj === 'object') { add('daily', obj.daily); add('big', obj.big); }
  return { names, maps };
}

// 值日名单校验：项目名须属于已配置的劳动项目、星期须属于设置的星期，
// 且每个「项目 · 星期」的人数须与设置里的 count 严格相等。
// 名单里的姓名与座位表同一口径：名册外的人名**不拒绝**，直接登记为临时学生（is_provisional=1）。
// 值日表存的是姓名而不是 id，建临时学生后名字才有稳定身份——值日指数、候选框、改名级联都认得到它；
// 也让 AI 整块写入 / 智能排表等「不经前端 /students/resolve」的写路径同样能落库。
// 仅在 settings 里确实配置了项目 / 人数时才校验（避免设置未初始化时误伤）。
// 兼容两种提交形态：PUT /api/duty 传来的「单模式内容」（{项目:{星期:[...]}}）、
// 整块写入（AI propose_json_write 等）传来的 {daily,big} 打包内容。
function assertDutyRefs(cells, name) {
  const obj = toObj(cells);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  const keys = Object.keys(obj);
  const isModeMap = keys.length > 0 && keys.every((k) => k === 'daily' || k === 'big');

  const s = db.prepare('SELECT days, items FROM duty_settings WHERE id = 1').get();
  // 列名按模式分键：daily 是星期几，big 是分组名 + 全部。
  // 打包提交按各模式自己的列名校验；单模式提交（看不出是哪个模式）校验「在任一模式的列名里」。
  const dayLists = {
    daily: dutyConfig.readDays('daily'),
    big: dutyConfig.readDays('big'),
  };
  const unionDays = Array.from(new Set([...dayLists.daily, ...dayLists.big]));
  const { names: itemNames, maps } = parseDutyItems(s ? s.items : null);
  // 单模式提交（看不出是哪个模式）时，人数取 daily 与 big 的并集（同名以 daily 优先）
  const unionMap = new Map([...maps.big, ...maps.daily]);
  const names = studentNameSet();
  // 名单里尚未登记的人名：校验完结构后统一建档（同一批去重，同名只建一条）
  const unknown = new Set();

  const layers = isModeMap
    ? ['daily', 'big'].map((m) => ({ mode: m, layer: obj[m] })).filter((x) => x.layer && typeof x.layer === 'object')
    : [{ mode: null, layer: obj }];

  layers.forEach(({ mode, layer }) => {
    // 打包提交按模式取人数；单模式提交共用并集
    const countMap = mode != null ? maps[mode] : unionMap;
    // 打包提交按该模式的列名校验；单模式提交用两模式并集
    const dayList = mode != null ? dayLists[mode] : unionDays;
    Object.keys(layer).forEach((item) => {
      if (itemNames.size && !itemNames.has(item)) {
        throw new ValidationError(`值日项目「${item}」不在设置的劳动项目里（字段「${name}」）`);
      }
      const daysObj = layer[item];
      if (!daysObj || typeof daysObj !== 'object' || Array.isArray(daysObj)) return;
      Object.keys(daysObj).forEach((day) => {
        if (dayList.length && !dayList.includes(day)) {
          throw new ValidationError(`值日列「${day}」不在设置的列名列表里（字段「${name}」）`);
        }
        const list = daysObj[day];
        if (!Array.isArray(list)) return;
        // 人数严格等于设置的 count（仅在确实配置了该项目人数时校验）
        const cnt = countMap.get(item);
        if (cnt != null && list.length !== cnt) {
          throw new ValidationError(`值日的「${item} · ${day}」应排 ${cnt} 人，实际 ${list.length} 人（字段「${name}」）`);
        }
        list.forEach((n) => {
          if (typeof n !== 'string') return;
          const nm = n.trim();
          if (nm && !names.has(nm)) unknown.add(nm);
        });
      });
    });
  });

  // 名册外的人名登记为临时学生（与座位表直接输入姓名的处理一致）：不阻断保存，
  // 但必须落成真实学生记录，否则值日指数等按身份统计的功能会漏掉这个人。
  if (unknown.size) {
    const results = resolveNames([...unknown], { create: true });
    results.forEach((r) => {
      // 已存在（含正式名册里的同名重名）都无需报错：名字本来就认得到
      if (!r || r.id || r.ambiguous) return;
      throw new ValidationError(`值日名单里的「${r.name}」无法登记为学生${r.error ? `（${r.error}）` : ''}（字段「${name}」）`);
    });
  }
}

// —— 请假：结束时间必须晚于开始时间（两者都提供时才校验）——
function assertLeaveWindow(start, end) {
  if (!start || !end) return;
  if (normDT(end) <= normDT(start)) {
    throw new ValidationError(`请假的「结束时间」必须晚于「开始时间」（开始：${start}，结束：${end}）`);
  }
}

// —— 可用座位数不能少于学生数（9.1）——
// 只在「本次提交比库里更少」时拦：老库里本来就可能坐不下（名册涨了、行被删过），
// 那是历史状态，不该让用户连改一格都存不进去；但把座位**改得更少**到坐不下，
// 一定是这次操作造成的，必须拦 —— 否则排表会静默丢掉排不下的学生。
function countUsableSeats(types) {
  let n = 0;
  for (const line of types) {
    if (!Array.isArray(line)) continue;
    for (const v of line) if (Number(v) === SEAT_CELL.SEAT) n++;
  }
  return n;
}
function assertSeatCapacity(types) {
  if (!Array.isArray(types) || !types.length) return;
  const need = studentIdSet().size;
  if (!need) return;
  const usable = countUsableSeats(types);
  if (usable >= need) return;
  let prevUsable = 0;
  try {
    const rec = db.prepare('SELECT types FROM seat_layout WHERE id = 1').get();
    const prev = toObj(rec && rec.types);
    if (Array.isArray(prev)) prevUsable = countUsableSeats(prev);
  } catch (_) {
    // 读不到旧几何就不拦：宁可不拦，也别让一次读取失败卡住正常保存
    return;
  }
  if (usable >= prevUsable) return;
  throw new ValidationError(`可用座位只有 ${usable} 个，学生有 ${need} 人：还差 ${need - usable} 个座位，请减少空位或多加行列`);
}

// —— 格子类型决定「能不能坐人」：唯一判据表 ——
// 座位(0) 可以坐人；走廊(1) 与空位(2) 都是「这里没有桌子」，写上学生就是脏数据。
// 一旦脱节，三处静默出错：
//   · 界面按 types 渲染 → 走廊/空位分支不显示名字，那个人看起来凭空消失
//   · 座位指数按 types 判可用格 → 他的权重静默少算
//   · 智能排表按 usable 过滤 → 把他当成「未入座」重新塞一个座位
// 全部不报错，所以必须在写库前拦。
//
// 为什么做成一张表而不是两处 if：整表 PUT 与单格 PATCH 是两条写入口，
// 规则写两遍就一定会分叉（历史上就是「单格只认空位、整表又只认空位，两边都漏走廊」）。
// 新增「不可坐人」的格子类型只改这一处，两个入口自动同步。
const SEAT_KIND_BLOCK = {
  [SEAT_CELL.AISLE]: { name: '走廊', cellHint: '是走廊，不能安排学生' },
  [SEAT_CELL.HOLE]: { name: '空位', cellHint: '是空位（这里没有桌子），不能安排学生：请先把该格改回座位' },
};
function seatKindBlocksStudent(kind) {
  return Object.prototype.hasOwnProperty.call(SEAT_KIND_BLOCK, Number(kind));
}

// —— 走廊 / 空位格里不许有人（整表校验：PUT 与 AI 整块写入走这条）——
// 报错文案是「被设为 X，但格子里还有学生」的方向：写明用户刚做的操作与残留数据。
function assertSeatCellsOccupiable(seats, types) {
  if (!Array.isArray(types) || !types.length || !Array.isArray(seats)) return;
  for (let r = 0; r < types.length; r++) {
    const line = types[r];
    if (!Array.isArray(line)) continue;
    for (let c = 0; c < line.length; c++) {
      if (!seatKindBlocksStudent(line[c])) continue;
      const v = Array.isArray(seats[r]) ? seats[r][c] : null;
      if (v === null || v === undefined || v === '') continue;
      const name = SEAT_KIND_BLOCK[Number(line[c])].name;
      throw new ValidationError(`第 ${r + 1} 行第 ${c + 1} 列被设为${name}，但格子里还有学生（${v}）：请先把该学生移走，再设置${name}`);
    }
  }
}

// —— 统一入口 ——
// table：目标表；values：本次要写入的列值（可只含部分列）；
// existing：该行旧值（更新时传入，用于补齐 values 里没出现的列）。
function validateRow(table, values, existing) {
  const pick = (k) => (values && values[k] !== undefined ? values[k] : (existing ? existing[k] : undefined));

  if (table === 'seat_layout' || table === 'seat_template') {
    const seats = toObj(pick('seats'));
    const types = toObj(pick('types'));
    const rows = Number(pick('rows'));
    const cols = Number(pick('cols'));
    // 尺寸越界：座位行数 / 每行格数不得超过设定的行×列
    if (Array.isArray(seats) && Number.isInteger(rows) && Number.isInteger(cols)) {
      if (seats.length > rows) throw new ValidationError(`座位行数（${seats.length}）超出设定的 ${rows} 行`);
      seats.forEach((r, i) => {
        if (Array.isArray(r) && r.length > cols) throw new ValidationError(`座位第 ${i + 1} 行有 ${r.length} 格，超出设定的 ${cols} 列`);
      });
    }
    assertSeatTypes(types, rows, cols);
    assertSeatRefs(seats, 'seats', types);
    assertSeatCellsOccupiable(seats, types);
    // 容量守卫只管当前座位表：模板是布局样板，不绑定本班人数
    if (table === 'seat_layout') assertSeatCapacity(types);
  } else if (table === 'duty_layout' || table === 'duty_template') {
    assertDutyRefs(pick('cells'), 'cells');
  } else if (table === 'leave_records') {
    assertLeaveWindow(pick('开始时间'), pick('结束时间'));
  }
}

module.exports = { ValidationError, validateRow, assertLeaveWindow, assertSeatRefs, assertSeatTypes, assertSeatCellsOccupiable, assertSeatCapacity, assertDutyRefs, assertSeatCellWritable };
