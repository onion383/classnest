const express = require('express');
const router = express.Router();
const { db } = require('../db');
const store = require('../services/slotStore');
const { validateRow } = require('../services/businessRules');
const { normalizeSeats, normalizeCellTypes, SEAT_MAX_ROWS, SEAT_MAX_GRID_COLS } = require('../services/sanitize');
// 单格写入的唯一入口（坐标 / 值形状 / 可坐性 / 引用关系都在它里面）
const { writeSeatCell, SeatWriteError } = require('../services/seatWrite');
const { readDocJson } = require('../utils/json');
// 历史快照 payload 的唯一构造点（补存 / 补录 / AI 写入前快照共用一套字段表）
const { seatSnapshotPayload } = require('../services/seatSnapshot');
const { isDateStr } = require('../utils/sql');
// 日期口径统一走 utils/date（本地时区）。此前本文件自己复制了一份
// localDateStr/parseDateStr/shiftDateStr/mondayOf，与 duty.js 逐字重复。
const { localDateStr, localDateTimeStr, shiftDateStr, mondayOf } = require('../utils/date');

// 这里的 cols 是**网格列数**（含走廊列）：走廊变成真实列之后，前端 PUT 上来的
// rows/cols 描述的是整个矩阵，不是「座位列数」。座位列数上限（SEAT_MAX_COLS=30）
// 是设置界面上的另一件事，不能用同一个常量卡这里。
function validateSeatSize(rows, cols) {
  if (rows < 1 || rows > SEAT_MAX_ROWS) return `行数需在 1 ~ ${SEAT_MAX_ROWS} 之间`;
  if (cols < 1 || cols > SEAT_MAX_GRID_COLS) return `列数需在 1 ~ ${SEAT_MAX_GRID_COLS} 之间`;
  return null;
}

// 读取座位：库中若被历史/AI 写成了「扁平对象数组」，这里规范化为二维数组返回，
// 保证前端（按 seats[行][列] 渲染）拿到的一直是可用形态；畸形数据不原样回传，按空座位处理。
function readSeats(raw) {
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : []; } catch (_) { return []; }
  if (!Array.isArray(parsed)) {
    console.error('[seats] 座位数据不是数组，按空座位处理');
    return [];
  }
  try {
    return normalizeSeats(parsed, 'seats');
  } catch (err) {
    // 不能把未通过 normalizeSeats 的原始数据回给前端：那样会绕过 50×30 上限，
    // 前端还按二维数组渲染，等于把畸形数据伪装成正常座位表。
    console.error('[seats] 座位数据畸形，按空座位处理:', err.message);
    return [];
  }
}

// 读取格子类型矩阵（types）：与 seats 同尺寸，0 座位 / 1 走廊 / 2 空位。
// 读路径与 readSeats 同策略：畸形数据降级成空数组（等价于「全部是座位」），
// 不把未通过校验的数据回给前端 —— 否则前端会拿一个长度不对的矩阵去渲染。
// 空数组**不**在这里补成全 0 矩阵：库里没存就是没存，补出来会让人误以为数据已落库。
function readTypes(raw, rows, cols) {
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : []; } catch (_) { return []; }
  if (!Array.isArray(parsed) || !parsed.length) return [];
  try {
    return normalizeCellTypes(parsed, rows, cols);
  } catch (err) {
    console.error('[seats] 格子类型矩阵畸形，按全座位处理:', err.message);
    return [];
  }
}

// 写入前规范化 types：裁剪到 rows×cols、不足补 0、值域校验。
// 返回 { skip } 表示调用方没传这个字段 —— 此时**不写库**，保留已有矩阵。
// 这一点和 seats/aisleCols 的「全量覆盖」不同：types 是后加的列，老客户端不认识它，
// 若把未传当空值写回，一次老版本保存就会把已经画好的走廊矩阵冲掉。
function parseTypesForWrite(raw, rows, cols) {
  if (raw === undefined) return { skip: true };
  try {
    return { value: normalizeCellTypes(raw, rows, cols) };
  } catch (e) {
    return { error: e.message };
  }
}

// 桌型序列：每张桌坐几人（1 或 2），对应**座位列**而不是网格列。
// 只做元素级校验，不校验长度：长度由前端按座位列数派生（deskPatternOf 会兜底），
// 后端再算一遍座位列数就等于维护第二份几何口径 —— 改一处忘另一处就开始拒合法数据。
function parseDeskPattern(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const raw of v) {
    const n = Number(raw);
    if (n !== 1 && n !== 2) return null;
    out.push(n);
  }
  return out;
}

// 形状一致性守卫：库里已经有 types（满矩阵）时，**rows/cols 不能单独改**。
// types 的形状（行数 × 宽度）就是这份布局的真实几何；两者一旦写脱节，
// 下次读取 normalizeCellTypes 会按新的 rows×cols 去裁它（多了截掉、行数对不上直接降级成 []），
// 走廊信息连同它代表的几何一起消失 —— 而且不报错。更糟的是降级成 [] 之后，
// 下次启动的一次性迁移会把「已经是网格」的矩阵再展开一遍（走廊翻倍）。
// 要改尺寸必须同时提交新 types（PUT 带上 types 即可，会走严格尺寸校验）。
function gridShapeMismatch(view, rows, cols, typesSupplied) {
  if (typesSupplied) return null;
  const rec = db.prepare(`SELECT rows AS r, cols AS c, types FROM ${view} WHERE id = 1`).get();
  if (!rec || !rec.types) return null;
  let stored;
  try { stored = JSON.parse(rec.types); } catch (_) { return null; }
  if (!Array.isArray(stored) || !stored.length) return null;
  const width = Array.isArray(stored[0]) ? stored[0].length : 0;
  if (!width) return null;
  if (stored.length !== rows || width !== cols) {
    return `尺寸与已保存的格子类型矩阵不一致（现有 ${stored.length} 行 × ${width} 列，提交 ${rows} 行 × ${cols} 列）：改尺寸时必须同时提交 types`;
  }
  return null;
}

// ======================== 当前座位 ========================
router.get('/', (req, res) => {
    const row = db.prepare('SELECT mode, rows, cols, seats, types, desk_pattern, aisle_cols, groups_config, settings FROM seat_layout WHERE id = 1').get();
  if (!row) return res.json({ mode: 'single', rows: 6, cols: 7, seats: [], types: [], aisleCols: [], groupsConfig: [], settings: {} });
  // seats 单独走 readSeats（还要规范化结构），其余三列统一走 readDocJson：
  // 四条 JSON 列只要有一条畸形，裸解析就会让整个响应 500、页面白板。
  const extra = readDocJson(row, {
    aisleCols: ['aisle_cols', []],
    deskPattern: ['desk_pattern', []],
    groupsConfig: ['groups_config', []],
    settings: ['settings', {}],
  });
  res.json({
    mode: row.mode,
    rows: row.rows,
    cols: row.cols,
    seats: readSeats(row.seats),
    types: readTypes(row.types, Number(row.rows), Number(row.cols)),
    ...extra,
  });
});

router.put('/', (req, res) => {
  try {
    const { mode, rows, cols, seats, types, deskPattern, aisleCols, groupsConfig, settings } = req.body;
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || !Array.isArray(seats)) {
      return res.status(400).json({ error: '参数格式错误' });
    }
    const sizeError = validateSeatSize(rows, cols);
    if (sizeError) {
      return res.status(400).json({ error: sizeError });
    }
    // 规范化座位结构（兼容「二维数组」与「扁平对象数组」），并做元素级校验
    let normSeats;
    try { normSeats = normalizeSeats(seats, 'seats'); } catch (e) { return res.status(400).json({ error: e.message }); }
    // 确保 seats 尺寸与 rows/cols 匹配
    const trimmed = normSeats.slice(0, rows).map(r => {
      const row = Array.isArray(r) ? r.slice(0, cols) : [];
      while (row.length < cols) row.push(null);
      return row;
    });
    while (trimmed.length < rows) trimmed.push(Array(cols).fill(null));

    const parsedTypes = parseTypesForWrite(types, rows, cols);
    if (parsedTypes.error) return res.status(400).json({ error: parsedTypes.error });
    const shapeError = gridShapeMismatch('seat_layout', rows, cols, !parsedTypes.skip);
    if (shapeError) return res.status(400).json({ error: shapeError });

    // 依赖既有数据的一致性校验：座位里的学生 id 必须真实存在（尺寸越界也在此拦下）
    validateRow('seat_layout', { seats: trimmed, rows, cols, types: parsedTypes.value });

    const patch = {
      mode: mode || 'single',
      rows,
      cols,
      seats: JSON.stringify(trimmed),
      aisle_cols: JSON.stringify(aisleCols || []),
      // 桌型序列（每张桌 1/2 人，对应座位列）：元素非法就落空数组 = 按 mode 推。
      // 不因此拒绝整次保存 —— 座位数据比桌型重要，不该被一个附属字段拖垮。
      desk_pattern: JSON.stringify(parseDeskPattern(deskPattern) || []),
      groups_config: JSON.stringify(groupsConfig || []),
      settings: JSON.stringify(settings || {}),
    };
    if (!parsedTypes.skip) patch.types = JSON.stringify(parsedTypes.value);
    store.setDoc('seat_layout', patch);
    res.json({ message: '保存成功' });
  } catch (err) {
    // 业务校验失败带 status=400（businessRules 的 ValidationError），只有真异常才是 500。
    // 以前这里一律 500，与单格 PATCH 的 400 不一致 —— 「学生 id 不存在 / 空位里还有人」
    // 是用户填错了，报「服务器错误」会让老师和排查都以为后端崩了。
    const status = Number(err && err.status) || 500;
    if (status >= 500) console.error('[seats] 座位表保存失败:', err);
    res.status(status).json({ error: err.message });
  }
});

// ======================== 单格更新（供撤销/重做前的单格提交） ========================
// 全部校验与写库都收敛到 services/seatWrite.js 的 writeSeatCell —— 这里只做 HTTP 形状。
// 曾经的 updateSingleCell + validateCellValue 是本文件的旁路：只校坐标与值形状，
// 洞里/走廊里能塞人、id 不存在的也能写、一人两座不拦（见该模块头部说明）。
function cellPatchHandler(table) {
  return (req, res) => {
    const { row, col, value } = req.body || {};
    try {
      writeSeatCell(table, row, col, value);
      res.json({ message: '已更新' });
    } catch (err) {
      if (err instanceof SeatWriteError) return res.status(err.status).json({ error: err.message });
      // 解析/数据库异常：带上原始信息，别把它伪装成「参数错误」
      console.error(`[seats] 单格写入失败（${table} ${row},${col}）:`, err);
      res.status(500).json({ error: err.message });
    }
  };
}

router.patch('/cell', cellPatchHandler('seat_layout'));
router.patch('/master/cell', cellPatchHandler('seat_template'));

// ======================== 座位模板 ========================
router.get('/master', (req, res) => {
    const row = db.prepare('SELECT mode, rows, cols, seats, types, desk_pattern, aisle_cols, groups_config, settings FROM seat_template WHERE id = 1').get();
  if (!row) return res.json({ mode: 'single', rows: 6, cols: 7, seats: [], types: [], aisleCols: [], groupsConfig: [], settings: {} });
  const extra = readDocJson(row, {
    aisleCols: ['aisle_cols', []],
    deskPattern: ['desk_pattern', []],
    groupsConfig: ['groups_config', []],
    settings: ['settings', {}],
  });
  res.json({
    mode: row.mode,
    rows: row.rows,
    cols: row.cols,
    seats: readSeats(row.seats),
    types: readTypes(row.types, Number(row.rows), Number(row.cols)),
    ...extra,
  });
});

router.put('/master', (req, res) => {
  try {
    const { mode, rows, cols, seats, types, deskPattern, aisleCols, groupsConfig, settings } = req.body;
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || !Array.isArray(seats)) {
      return res.status(400).json({ error: '参数格式错误' });
    }
    const sizeError = validateSeatSize(rows, cols);
    if (sizeError) {
      return res.status(400).json({ error: sizeError });
    }
    // 规范化座位结构（兼容「二维数组」与「扁平对象数组」），并做元素级校验
    let normSeats;
    try { normSeats = normalizeSeats(seats, 'seats'); } catch (e) { return res.status(400).json({ error: e.message }); }
    const trimmed = normSeats.slice(0, rows).map(r => {
      const row = Array.isArray(r) ? r.slice(0, cols) : [];
      while (row.length < cols) row.push(null);
      return row;
    });
    while (trimmed.length < rows) trimmed.push(Array(cols).fill(null));

    const parsedTypes = parseTypesForWrite(types, rows, cols);
    if (parsedTypes.error) return res.status(400).json({ error: parsedTypes.error });
    const shapeError = gridShapeMismatch('seat_template', rows, cols, !parsedTypes.skip);
    if (shapeError) return res.status(400).json({ error: shapeError });

    // 依赖既有数据的一致性校验：座位里的学生 id 必须真实存在
    validateRow('seat_template', { seats: trimmed, rows, cols, types: parsedTypes.value });

    const patch = {
      mode: mode || 'single',
      rows,
      cols,
      seats: JSON.stringify(trimmed),
      aisle_cols: JSON.stringify(aisleCols || []),
      // 桌型序列（每张桌 1/2 人，对应座位列）：元素非法就落空数组 = 按 mode 推。
      // 不因此拒绝整次保存 —— 座位数据比桌型重要，不该被一个附属字段拖垮。
      desk_pattern: JSON.stringify(parseDeskPattern(deskPattern) || []),
      groups_config: JSON.stringify(groupsConfig || []),
      settings: JSON.stringify(settings || {}),
    };
    if (!parsedTypes.skip) patch.types = JSON.stringify(parsedTypes.value);
    store.setDoc('seat_template', patch);
    res.json({ message: '模板保存成功' });
  } catch (err) {
    // 业务校验失败带 status=400（businessRules 的 ValidationError），只有真异常才是 500。
    // 以前这里一律 500，与单格 PATCH 的 400 不一致 —— 「学生 id 不存在 / 空位里还有人」
    // 是用户填错了，报「服务器错误」会让老师和排查都以为后端崩了。
    const status = Number(err && err.status) || 500;
    if (status >= 500) console.error('[seats] 座位表保存失败:', err);
    res.status(status).json({ error: err.message });
  }
});

// ======================== 从模板应用到当前座位 ========================
router.post('/apply-master', (req, res) => {
    const template = db.prepare('SELECT mode, rows, cols, seats, types, desk_pattern, aisle_cols, groups_config, settings FROM seat_template WHERE id=1').get();
  if (!template) return res.status(400).json({ error: '模板为空' });
  store.setDoc('seat_layout', {
    mode: template.mode,
    rows: template.rows,
    cols: template.cols,
    seats: template.seats,
    // 格子类型必须跟着一起搬：只抄 seats 不抄 types，抄过来的走廊会变成座位格
    types: template.types,
    aisle_cols: template.aisle_cols,
    groups_config: template.groups_config,
    settings: template.settings,
  });
  res.json({ message: '已应用模板' });
});

// ======================== 座位位置权重表 ========================
// 与座位布局共用同一套几何：weights 与 seats 同形（同一次迁移展开、同一次尺寸调整），
// 走廊格的权重恒为 null。types 也一并存取 —— 它是这份权重矩阵的几何依据，
// 权重写入一旦与它脱节，座位指数就会按错的列取权重（界面上看不出来，只觉得排得不公平）。
router.get('/weight', (req, res) => {
    const row = db.prepare('SELECT mode, rows, cols, weights, types, settings FROM seat_weight WHERE id = 1').get();
  if (!row) return res.json({ mode: 'single', rows: 6, cols: 13, weights: [], types: [], settings: {} });
  const extra = readDocJson(row, { weights: [], settings: {} });
  res.json({
    mode: row.mode,
    rows: row.rows,
    cols: row.cols,
    ...extra,
    types: readTypes(row.types, Number(row.rows), Number(row.cols)),
  });
});

router.put('/weight', (req, res) => {
    const { mode, rows, cols, weights, types, settings } = req.body;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || !Array.isArray(weights)) {
    return res.status(400).json({ error: '参数格式错误' });
  }
  const sizeError = validateSeatSize(rows, cols);
  if (sizeError) return res.status(400).json({ error: sizeError });
  const parsedTypes = parseTypesForWrite(types, rows, cols);
  if (parsedTypes.error) return res.status(400).json({ error: parsedTypes.error });
  const shapeError = gridShapeMismatch('seat_weight', rows, cols, !parsedTypes.skip);
  if (shapeError) return res.status(400).json({ error: shapeError });
  // 权重尺寸与 rows/cols 对齐：超出截断、不足补 null
  const trimmed = weights.slice(0, rows).map(r => {
    const row = Array.isArray(r) ? r.slice(0, cols) : [];
    while (row.length < cols) row.push(null);
    return row;
  });
  while (trimmed.length < rows) trimmed.push(Array(cols).fill(null));

  const patch = {
    mode: mode || 'single',
    rows,
    cols,
    weights: JSON.stringify(trimmed),
    settings: JSON.stringify(settings || {}),
  };
  if (!parsedTypes.skip) patch.types = JSON.stringify(parsedTypes.value);
  store.setDoc('seat_weight', patch);
  res.json({ message: '权重保存成功' });
});

// ======================== 草稿表（智能排表的临时草稿） ========================
// 草稿只在「智能排表」弹窗里恢复：保存本次排表的预览结果与条件。
// saved_at 为空串即视为没有草稿（不额外存标记位，避免多一个状态字段）。
router.get('/draft', (req, res) => {
    const row = db.prepare('SELECT mode, rows, cols, seats, types, desk_pattern, aisle_cols, settings, conditions, saved_at FROM seat_draft WHERE id = 1').get();
  if (!row || !row.saved_at) return res.json({ exists: false });
  // 草稿的 seats 同样要按矩阵规范化：AI / 历史写入的草稿可能是扁平对象数组，
  // 原样回传会让前端按 seats[行][列] 读到 undefined。
  const extra = readDocJson(row, {
    aisleCols: ['aisle_cols', []],
    deskPattern: ['desk_pattern', []],
    settings: {},
    conditions: [],
  });
  res.json({
    exists: true,
    mode: row.mode,
    rows: row.rows,
    cols: row.cols,
    seats: readSeats(row.seats),
    types: readTypes(row.types, Number(row.rows), Number(row.cols)),
    ...extra,
    savedAt: row.saved_at
  });
});

router.put('/draft', (req, res) => {
    const { mode, rows, cols, seats, types, aisleCols, settings, conditions } = req.body;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || !Array.isArray(seats)) {
    return res.status(400).json({ error: '参数格式错误' });
  }
  const sizeError = validateSeatSize(rows, cols);
  if (sizeError) {
    return res.status(400).json({ error: sizeError });
  }
  // 尺寸对齐（超出截断、不足补齐），与正式座位表同一套规则
  const trimmed = seats.slice(0, rows).map(r => {
    const row = Array.isArray(r) ? r.slice(0, cols) : [];
    while (row.length < cols) row.push(null);
    return row;
  });
  while (trimmed.length < rows) trimmed.push(Array(cols).fill(null));
  // 全空的草稿视为没有内容，直接拒绝，避免启动时弹一个空草稿提示
  if (!trimmed.some(r => r.some(v => v !== null && v !== ''))) {
    return res.status(400).json({ error: '草稿内容为空' });
  }

  // 草稿的格子类型同样保留：恢复草稿后走廊/空位要和排表时看到的一致
  const parsedTypes = parseTypesForWrite(types, rows, cols);
  if (parsedTypes.error) return res.status(400).json({ error: parsedTypes.error });
  const shapeError = gridShapeMismatch('seat_draft', rows, cols, !parsedTypes.skip);
  if (shapeError) return res.status(400).json({ error: shapeError });

  // 本地时间口径（与全库一致）。原来用 toISOString() 是 UTC，
  // 东八区 00:00–08:00 之间存进去的时间戳「日期部分」是昨天。
  const savedAt = localDateTimeStr();
  const patch = {
    mode: mode || 'single',
    rows,
    cols,
    seats: JSON.stringify(trimmed),
    aisle_cols: JSON.stringify(aisleCols || []),
    groups_config: JSON.stringify([]),
    settings: JSON.stringify(settings || {}),
    conditions: JSON.stringify(conditions || []),
    saved_at: savedAt,
  };
  if (!parsedTypes.skip) patch.types = JSON.stringify(parsedTypes.value);
  store.setDoc('seat_draft', patch);
  res.json({ message: '草稿已保存', savedAt });
});

// 清除草稿：清空内容与 saved_at，下次启动不再提示
router.delete('/draft', (req, res) => {
    store.setDoc('seat_draft', { seats: '[]', conditions: '[]', saved_at: '' });
  res.json({ message: '草稿已清除' });
});

// ======================== 全局设置（预留） ========================
router.get('/settings', (req, res) => {
  res.json({});
});

router.put('/settings', (req, res) => {
  res.json({ message: 'ok' });
});

// ======================== 历史快照（按天） ========================
// 快照按天保存：每行代表某一天（snap_date）的座位；week_start 为由该天推导的周一，
// 历史下拉按 week_start 聚合，回看时取该周最后一天的快照。
// localDateStr / shiftDateStr / mondayOf 见 utils/date.js（全库唯一实现）。

// 历史列表：按周聚合（代表日期 = 该周最后一天），供下拉框使用
router.get('/history', (req, res) => {
    res.json(store.histWeeks('seat'));
});

// 单周快照：返回该周最后一天（最新一天）的座位
router.get('/history/:weekStart', (req, res) => {
    const rec = store.histLatest('seat', req.params.weekStart, null);
  if (!rec) return res.json(null);
  const p = rec.payload || {};
  res.json({
    week_start: rec.week_start,
    snap_date: rec.snap_date,
    mode: rec.mode,
    rows: p.rows,
    cols: p.cols,
    seats: p.seats || [],
    // 格子类型矩阵：cols 已是网格列数，没有它前端就不知道哪几列是走廊，
    // 只能把走廊列当空座位显示（老快照没有这个字段 → 空数组，前端降级成全座位）
    types: p.types || [],
    aisleCols: p.aisleCols || [],
    groupsConfig: p.groupsConfig || [],
    settings: p.settings || {},
    created_at: rec.created_at,
  });
});

// 按天取快照区间（座位指数结算用）：返回区间内每日快照，按天升序；from/to 可只给其一
router.get('/daily', (req, res) => {
    const { from, to } = req.query;
  res.json(store.histDaily('seat', { from, to }).map((rec) => {
    const p = rec.payload || {};
    return {
      snap_date: rec.snap_date,
      week_start: rec.week_start,
      mode: rec.mode,
      rows: p.rows,
      cols: p.cols,
      seats: p.seats || [],
      types: p.types || [],
      settings: p.settings || {},
    };
  }));
});

// 保存某一天的快照（手动保存 / 补存都会走到这里）：按 snap_date 幂等 upsert
router.post('/snapshot', (req, res) => {
    const { snap_date, mode, rows, cols, seats, types, settings } = req.body;
  if (!snap_date) return res.status(400).json({ error: '缺少快照日期' });
  // 快照日期直接落库并据此推导周一：非法串会生成 NaN 周键，历史列表出现幽灵周
  if (!isDateStr(snap_date)) return res.status(400).json({ error: '快照日期格式不正确（应为 YYYY-MM-DD）' });

  store.histUpsert('seat', {
    weekStart: mondayOf(snap_date),
    snapDate: snap_date,
    mode: mode || 'single',
    payload: {
      mode: mode || 'single',
      rows,
      cols,
      seats,
      // 走廊已是 seats 里的真实列，几何必须随 payload 一起存 ——
      // 只存 seats 的话回看历史时走廊列会被当成空座位，座位指数也会跟着错位。
      types: Array.isArray(types) ? types : [],
      aisleCols: [],
      groupsConfig: [],
      settings,
    },
  });
  res.json({ message: '快照已保存' });
});

// 补存历史快照：仅学期范围内。过去日期缺失才补（沿用最近一天座位），
// includeToday=true 时今天总是用当前临时表覆盖（启动时静默补全用）。
router.post('/snapshot/backfill', (req, res) => {
  try {
    const includeToday = !!(req.body && req.body.includeToday);
    const today = localDateStr(new Date());
    const { start, end } = store.semesterRange();
    // 未设置学期开始日期时无法界定结算范围，直接跳过
    if (!start) return res.json({ message: '未设置学期开始日期', inserted: 0 });

    let upper = includeToday ? today : shiftDateStr(today, -1);
    if (end && upper > end) upper = end;
    if (upper < start) return res.json({ message: '学期范围外', inserted: 0 });

    const layout = store.getDoc('seat_layout');
    // 快照 payload 的字段表只有一份（services/seatSnapshot.js）：语义是「从布局复制一份」，
    // 读路径降级成空座位/空设置 —— 补录的是「快照」，不影响源数据，一条脏记录不会让整批 500。
    // types 必须带：补存/补录出的快照要参与座位指数累加，
    // 少了它走廊列会在回看时显示成空座位、结算时权重也会挪位。
    const layoutPayload = layout ? seatSnapshotPayload(layout) : null;

    // 写循环整体放进一个事务（与 routes/duty.js 的同名接口同款改法）：
    // 逐日 INSERT 各自提交时，中途失败会留下半截快照（前几天已落库、后几天没有），
    // 用户看到的是「补了 37 天」这种半吊子结果。整批要么全成、要么全不成。
    // 循环体全是同步调用（没有 await），可以安全地放进 better-sqlite3 的同步事务。
    let inserted = 0;
    const tx = db.transaction(() => {
      let cur = start;
      while (cur <= upper) {
        const isToday = cur === today;
        const exists = store.histFind('seat', cur, null);
        if (isToday && includeToday && layoutPayload) {
          // 今天：总是覆盖为当前临时表
          if (exists) store.histUpdateByDate('seat', cur, null, layoutPayload);
          else store.histInsert('seat', {
            weekStart: mondayOf(cur), snapDate: cur, mode: layoutPayload.mode,
            payload: { ...layoutPayload, aisleCols: [], groupsConfig: [] },
          });
          inserted++;
        } else if (!exists) {
          // 过去日期：缺失才补，沿用最近一天座位；没有更早快照则用当前座位
          const prev = store.histPrev('seat', cur, null);
          const payload = prev ? prev.payload : layoutPayload;
          if (payload) {
            store.histInsert('seat', {
              weekStart: mondayOf(cur), snapDate: cur, mode: payload.mode || 'single',
              payload: { ...payload, aisleCols: [], groupsConfig: [] },
            });
            inserted++;
          }
        }
        cur = shiftDateStr(cur, 1);
      }
    });
    tx();
    res.json({ message: `已补存 ${inserted} 天`, inserted });
  } catch (err) {
    // 业务校验失败带 status=400（businessRules 的 ValidationError），只有真异常才是 500。
    // 以前这里一律 500，与单格 PATCH 的 400 不一致 —— 「学生 id 不存在 / 空位里还有人」
    // 是用户填错了，报「服务器错误」会让老师和排查都以为后端崩了。
    const status = Number(err && err.status) || 500;
    if (status >= 500) console.error('[seats] 座位表保存失败:', err);
    res.status(status).json({ error: err.message });
  }
});

// 删除某一周的历史快照（该周下的全部天）
router.delete('/history/:weekStart', (req, res) => {
    const changes = store.histDeleteWeek('seat', req.params.weekStart, null);
  if (!changes) return res.status(404).json({ error: '该周快照不存在' });
  res.json({ message: '快照已删除' });
});

// 补录/生成一整周记录（周一起 7 天）：已存在的日期跳过，缺失的日期沿用最近一天的座位
// （没有更早快照时用当前座位表）。week_start 传任意日期都会先归一到该周周一。
router.post('/history/week', (req, res) => {
  try {
    const raw = (req.body && req.body.week_start) || '';
    // 用 isDateStr 而不是只看格式：'2026-02-30' 格式对但日期不存在，
    // mondayOf 会把它解析成 NaN，补录出一批 NaN-NaN-NaN 的幽灵记录。
    if (!isDateStr(raw)) return res.status(400).json({ error: '周起始日期格式不正确' });
    const weekStart = mondayOf(raw);
    const layout = store.getDoc('seat_layout');
    // 快照 payload 的字段表只有一份（services/seatSnapshot.js）：语义是「从布局复制一份」，
    // 读路径降级成空座位/空设置 —— 补录的是「快照」，不影响源数据，一条脏记录不会让整批 500。
    // types 必须带：补存/补录出的快照要参与座位指数累加，
    // 少了它走廊列会在回看时显示成空座位、结算时权重也会挪位。
    const layoutPayload = layout ? seatSnapshotPayload(layout) : null;

    let inserted = 0;
    for (let i = 0; i < 7; i++) {
      const date = shiftDateStr(weekStart, i);
      if (store.histFind('seat', date, null)) continue;
      const prev = store.histPrev('seat', date, null);
      const payload = prev ? prev.payload : layoutPayload;
      if (!payload) continue;
      store.histInsert('seat', {
        weekStart, snapDate: date, mode: payload.mode || 'single',
        payload: { ...payload, aisleCols: [], groupsConfig: [] },
      });
      inserted++;
    }
    res.json({ message: inserted ? `已生成 ${inserted} 天记录` : '该周记录已完整，无需补录', inserted });
  } catch (err) {
    // 业务校验失败带 status=400（businessRules 的 ValidationError），只有真异常才是 500。
    // 以前这里一律 500，与单格 PATCH 的 400 不一致 —— 「学生 id 不存在 / 空位里还有人」
    // 是用户填错了，报「服务器错误」会让老师和排查都以为后端崩了。
    const status = Number(err && err.status) || 500;
    if (status >= 500) console.error('[seats] 座位表保存失败:', err);
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;