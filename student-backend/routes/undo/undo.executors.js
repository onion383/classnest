// =========================================================================
// undo.executors.js —— 撤销系统·命令执行器
// （原 routes/undo.js 按职责拆分而来，纯代码搬运，行为不变）
//   指令描述存库，执行逻辑在此注册。重启后读记录仍可执行。
// =========================================================================

const undoStore = require('../../services/undoStore')
const dbManager = require('../../dbManager/dbManager')
const { moveToTrash, restoreToOriginal, deleteThumb } = require('../../albumOps')
const { SEAT_MAX_ROWS, SEAT_MAX_GRID_COLS } = require('../../services/sanitize')
const { renameStudentRefs } = require('../../services/studentRename')
const {
  restoreSeatCells, clearSeatCells, restoreDutySlots, clearDutySlots,
} = require('../../services/studentRelations')
const {
  readGridArray, writeGridArray, currentSeatGeometry, geometryOfSnapshot, warnGeometryDrift, cellText,
  insertRow, deleteRowById, updateRowById, writeDocCols, rowName,
  applyAlbumOrder, applyGroupSnapshot,
} = require('./undo.helpers')
const { UNDO_WRITE_TABLES, UNDO_DOC_TABLES } = require('../../schema/tableRegistry')

// 允许记录的动态表名（防注入）。含 cadre_members：跨表批量写入（propose_batch）可能写入职务成员，需可撤销。
// 名单在 schema/tableRegistry.js —— 白名单散在多处时，新增可撤销表必然漏一处。
const ALLOWED_TABLES = UNDO_WRITE_TABLES

// 学生改名在写入时会把值日/座位/成绩/请假/小组/班干部里的旧姓名一起改掉
// （见 services/studentRename.js）。撤销/重做必须同步反向改名，否则「撤销改名」会让
// students 回到旧名、关联却停在新名上 —— 关联与人对不上，比不同步还乱。
// 参数顺序：fromRow 是「当前关联里的姓名」，toRow 是「要改回/改成」的姓名。
function renameRefsIfStudent(table, fromRow, toRow) {
  if (table !== 'students' || !fromRow || !toRow) return
  const a = fromRow['姓名']
  const b = toRow['姓名']
  if (a == null || b == null || a === b) return
  renameStudentRefs(a, b)
}

// 职务/成员的前后态回写与行槽位回写都在 undoStore：
// 只更新已存在的行，不插入不删除；id 已消失时 UPDATE 影响 0 行直接跳过，
// position 为 null 的异常行也跳过（否则整表排序会漂到表头）。

// 「整块 JSON 列」表：数据以整块 JSON 存于单列（座位 seats / 权重 weights / 课表 cells…），
// 撤销时按「整块列值」整体还原。表名固定，杜绝注入；名单在 registry 统一维护。
const DOC_TABLES = UNDO_DOC_TABLES

// 网格型数据：整块 JSON 存于单列，撤销按单格或整块处理。
// 表名固定，杜绝注入。列名到具体网格列一一对应。
const GRID_SOURCES = {
  seat_layout: 'seats',
  seat_template: 'seats',
  seat_weight: 'weights',
  schedule: 'cells',
  master_schedule: 'cells',
  duty_layout: 'cells',
  duty_template: 'cells'
}

// ===================== 命令执行器 =====================
// 指令描述存库，执行逻辑在此注册。重启后读记录仍可执行。
// payload 各动作字段在下方 executors 定义。
const executors = {
  // 单元格编辑：payload { table, rowId, field, oldValue, newValue }
  cell_update: {
    validate({ table, rowId, field }) {
      if (!ALLOWED_TABLES.includes(table) || !Number.isInteger(rowId)) return '参数不完整'
      const cols = undoStore.tableCols(table)
      if (!cols.includes(field)) return '字段无效'
      return null
    },
    undo({ table, rowId, field, oldValue }) { undoStore.setCellValue(table, field, oldValue, rowId) },
    redo({ table, rowId, field, newValue }) { undoStore.setCellValue(table, field, newValue, rowId) },
    // 生成展示文案：撤销时反向（new→old），重做时正向（old→new）
    describe({ field, oldValue, newValue }, mode) {
      const old = oldValue == null ? '' : oldValue
      const new_ = newValue == null ? '' : newValue
      return mode === 'undo' ? `${field}：「${new_}」→「${old}」` : `${field}：「${old}」→「${new_}」`
    },
    change(p, mode) {
      return { type: 'cell_update', table: p.table, rowId: p.rowId, field: p.field, value: mode === 'undo' ? p.oldValue : p.newValue }
    }
  },

  // 添加一条动态表记录：payload { table, row }（row 为添加后的完整记录，须含 id）
  row_insert: {
    validate({ table, row }) {
      if (!ALLOWED_TABLES.includes(table)) return '表无效'
      if (!row || !Number.isInteger(row.id)) return '参数不完整'
      return null
    },
    undo({ table, row }) { deleteRowById(table, row.id) },
    redo({ table, row }) { insertRow(table, row) },
    describe(p, mode) {
      const name = rowName(p.row)
      return mode === 'undo' ? `撤销添加：${name}` : `重新添加：${name}`
    },
    change(p, mode) {
      return mode === 'undo'
        ? { type: 'row_remove', table: p.table, rowId: p.row.id }
        : { type: 'row_upsert', table: p.table, row: p.row }
    }
  },

  // 编辑动态表记录：payload { table, rowId, oldRow, newRow }
  row_update: {
    validate({ table, rowId }) {
      if (!ALLOWED_TABLES.includes(table) || !Number.isInteger(rowId)) return '参数不完整'
      return null
    },
    undo({ table, rowId, oldRow, newRow }) {
      updateRowById(table, rowId, oldRow)
      renameRefsIfStudent(table, newRow, oldRow)
    },
    redo({ table, rowId, oldRow, newRow }) {
      updateRowById(table, rowId, newRow)
      renameRefsIfStudent(table, oldRow, newRow)
    },
    describe(p, mode) {
      const name = rowName(p.newRow || p.oldRow, p.rowId)
      return mode === 'undo' ? `撤销编辑：${name}` : `重新编辑：${name}`
    },
    change(p, mode) {
      return { type: 'row_upsert', table: p.table, row: mode === 'undo' ? p.oldRow : p.newRow }
    }
  },

  // 删除动态表记录：payload { table, row }（row 为删除前的完整记录）
  row_delete: {
    validate({ table, row }) {
      if (!ALLOWED_TABLES.includes(table)) return '表无效'
      if (!row || !Number.isInteger(row.id)) return '参数不完整'
      return null
    },
    undo({ table, row }) { insertRow(table, row) },
    redo({ table, row }) { deleteRowById(table, row.id) },
    describe(p, mode) {
      const name = rowName(p.row)
      return mode === 'undo' ? `恢复记录：${name}` : `删除记录：${name}`
    },
    change(p, mode) {
      return mode === 'undo'
        ? { type: 'row_upsert', table: p.table, row: p.row }
        : { type: 'row_remove', table: p.table, rowId: p.row.id }
    }
  },

  // 行顺序调整（拖拽排序 / 上移下移 / 粘贴 / 表头排序落库）：
  // payload { table, before, after }，before/after = [{ id, position }]（参与本次排序的行）。
  // 为什么记「每行 position」而不是「ids 顺序」：撤销要恢复的是**这几行当时的槽位**。
  // 按 ids 重排会连带把之后新插入的行挤到别的槽位；按 position 回写只动参与过的行，
  // 后插入的行原样保留（它们的位置本来就是排在这几行之后算出来的）。
  row_reorder: {
    validate({ table, before, after }) {
      if (!ALLOWED_TABLES.includes(table)) return '表无效'
      if (!Array.isArray(before) || !Array.isArray(after)) return '参数不完整'
      const bad = [...before, ...after].some((r) => !r || !Number.isInteger(r.id))
      if (bad) return '参数不完整'
      return null
    },
    undo({ table, before }) { undoStore.applyRowPositions(table, before) },
    redo({ table, after }) { undoStore.applyRowPositions(table, after) },
    describe(p, mode) {
      return mode === 'undo' ? '恢复行顺序' : '重做行顺序调整'
    },
    change() { return { type: 'full_reload' } }
  },

  // 批量新增行（Excel 导入）：payload { table, rows }，rows 为本次真正新建的完整行。
  // 逐行 row_insert 会被每 key 50 条上限截断（导入几百行时前面几十条根本撤不回来），
  // 也会让一次导入变成几十次 Ctrl+Z；整批记一条，撤销即整批删除。
  rows_batch_insert: {
    validate({ table, rows }) {
      if (!ALLOWED_TABLES.includes(table)) return '表无效'
      if (!Array.isArray(rows) || rows.length === 0) return '参数不完整'
      if (!rows.every((r) => r && Number.isInteger(r.id))) return '参数不完整'
      return null
    },
    // 逆序删：自引用/父先行的情况下也不会在事务中途留下悬空引用
    undo({ table, rows }) { undoStore.batchDelete(table, rows, { reverse: true }) },
    redo({ table, rows }) { undoStore.batchInsert(table, rows) },
    describe(p, mode) {
      return mode === 'undo' ? `撤销导入：${p.rows.length} 条记录` : `重新导入：${p.rows.length} 条记录`
    },
    change() { return { type: 'full_reload' } }
  },

  // 批量删除行（勾选删除 / 重复项清理）：payload { table, rows }，rows 为删除前的完整行。
  // 与 rows_batch_insert 互为反操作，理由同上：一次选择删除是一步操作，就该一步撤销。
  rows_batch_delete: {
    validate({ table, rows }) {
      if (!ALLOWED_TABLES.includes(table)) return '表无效'
      if (!Array.isArray(rows) || rows.length === 0) return '参数不完整'
      if (!rows.every((r) => r && Number.isInteger(r.id))) return '参数不完整'
      return null
    },
    undo({ table, rows }) { undoStore.batchInsert(table, rows) },
    redo({ table, rows }) { undoStore.batchDelete(table, rows, { reverse: true }) },
    describe(p, mode) {
      return mode === 'undo' ? `恢复记录：${p.rows.length} 条` : `删除记录：${p.rows.length} 条`
    },
    change() { return { type: 'full_reload' } }
  },

  // 整块写入「非行式」表（座位/权重/课表/值日/模板等）：
  // payload { table, id, before, after, label }，before/after 为「列名 → 整块列值」。
  // 覆盖一列或多列；对象/数组列按 JSON 文本落库。undo 写回 before，redo 写回 after。
  doc_update: {
    validate({ table, id, before }) {
      if (!DOC_TABLES.includes(table) || !Number.isInteger(id)) return '参数不完整'
      if (!before || typeof before !== 'object') return '参数不完整'
      return null
    },
    undo({ table, id, before }) { writeDocCols(table, id, before) },
    redo({ table, id, after }) { writeDocCols(table, id, after) },
    describe(p, mode) {
      if (p.label) return p.label
      const cols = Object.keys(p.before || {}).join('、')
      return mode === 'undo' ? `整块还原：${cols}` : `整块写入：${cols}`
    },
    change() { return { type: 'full_reload' } }
  },

  // 单格编辑（网格 JSON 列）：payload { table, row, col, oldValue, newValue }
  grid_cell: {
    validate({ table, row, col }) {
      if (!(table in GRID_SOURCES)) return '网格表无效'
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) return '参数不完整'
      // 与 /api/seats 的 50×60 上限保持一致，避免撤销记录把越界坐标写回 JSON 网格。
      // 列上限是**网格列数**（含走廊列），不是设置里的「座位列数」。
      if (row >= SEAT_MAX_ROWS || col >= SEAT_MAX_GRID_COLS) return `坐标超出范围（最多 ${SEAT_MAX_ROWS} 行 × ${SEAT_MAX_GRID_COLS} 列）`
      // 光卡全局上限不够：撤的是**很久以前**记下的一格，那次操作之后布局可能已经变小。
      // 越界行照样能写进 seats（JSON 是自由形状），但下一次整表 PUT 会按 rows 裁剪
      // （slice(0, rows)）把它静默丢掉 —— 用户看到「撤销成功」，数据其实没了。
      // 所以按当前布局卡：宁可拒绝并说清原因，也不写一条注定被裁掉的行。
      const geom = currentSeatGeometry(table)
      if (geom && geom.rows != null && row >= geom.rows) {
        return `该布局已变更，无法撤销：这条记录在第 ${row + 1} 行，当前座位表只有 ${geom.rows} 行`
      }
      if (geom && geom.cols != null && col >= geom.cols) {
        return `该布局已变更，无法撤销：这条记录在第 ${col + 1} 列，当前座位表只有 ${geom.cols} 列`
      }
      return null
    },
    apply({ table, row, col, value }) {
      const arr = readGridArray(table, GRID_SOURCES[table])
      if (!arr[row]) arr[row] = []
      arr[row][col] = value == null ? null : value
      writeGridArray(table, GRID_SOURCES[table], arr)
    },
    undo(p) { this.apply({ ...p, value: p.oldValue }) },
    redo(p) { this.apply({ ...p, value: p.newValue }) },
    describe(p, mode) {
      if (p.label) return p.label
      const old = cellText(p.oldValue)
      const new_ = cellText(p.newValue)
      return mode === 'undo' ? `格子(${p.row + 1},${p.col + 1})：「${new_}」→「${old}」` : `格子(${p.row + 1},${p.col + 1})：「${old}」→「${new_}」`
    },
    change(p, mode) {
      return { type: 'grid_cell', table: p.table, row: p.row, col: p.col, value: mode === 'undo' ? p.oldValue : p.newValue }
    }
  },

  // 整块覆盖（网络 JSON 列，用于整行/列换位等批量操作）：
  // payload { table, oldValue, newValue }（oldValue/newValue 为整个 JSON 数组）
  // 座位表「插入/删除走廊行、走廊列」会改变行数/列数，几何必须与 seats/types 同一笔回写，
  // 否则撤完就是「types 宽 8 列、cols 还写着 7」——读库按 cols 裁，座位图错列且不报错。
  //
  // 几何从哪来：**只看快照自带的 types 形状**（geometryOfSnapshot），前端另传的
  // oldRows/oldCols 不再采信 —— 同一事实抄两遍必然漏一项，历史事故就是只传了 rows、漏了 cols。
  // 传了但和 types 不一致时会打一条 warn（这是前后端口径漂移的早期信号），不影响撤销本身。
  // 没有 types 的老记录（换位 / 设置空位）照旧只回写 JSON 列，行数列数一格不动。
  grid_snapshot: {
    validate({ table }) {
      if (!(table in GRID_SOURCES)) return '网格表无效'
      return null
    },
    undo({ table, oldValue, oldRows, oldCols }) {
      const geom = geometryOfSnapshot(oldValue)
      if (geom) warnGeometryDrift(table, 'undo', geom, oldRows, oldCols)
      // 列与几何同一笔（store 内一个事务）：只写 seats 不写 rows/cols，读库会按旧几何裁矩阵
      undoStore.writeGridSnapshot(table, GRID_SOURCES[table], oldValue, geom)
    },
    redo({ table, newValue, newRows, newCols }) {
      const geom = geometryOfSnapshot(newValue)
      if (geom) warnGeometryDrift(table, 'redo', geom, newRows, newCols)
      undoStore.writeGridSnapshot(table, GRID_SOURCES[table], newValue, geom)
    },
    describe(p, mode) {
      if (p.label) return p.label
      const dim = (b) => Array.isArray(b) ? `${b.length} 行` : (b && typeof b === 'object' ? `${Object.keys(b).length} 项` : '')
      const old = dim(p.oldValue), new_ = dim(p.newValue)
      return mode === 'undo' ? `整块：${new_} → ${old}` : `整块：${old} → ${new_}`
    },
    change(p, mode) {
      return { type: 'grid_snapshot', table: p.table, value: mode === 'undo' ? p.oldValue : p.newValue }
    }
  },

  // 相册排序整块覆盖：payload { oldOrder, newOrder }，均为相册 id 的有序数组。
  album_order: {
    validate({ oldOrder, newOrder }) {
      if (!Array.isArray(oldOrder) || !Array.isArray(newOrder)) return '参数不完整'
      return null
    },
    undo({ oldOrder }) { applyAlbumOrder(oldOrder) },
    redo({ newOrder }) { applyAlbumOrder(newOrder) },
    describe(p, mode) {
      const order = (mode === 'undo' ? p.oldOrder : p.newOrder) || []
      const names = order.map((id) => undoStore.albumName(id))
      return mode === 'undo' ? `相册排序恢复：${names.join('、')}` : `相册排序：${names.join('、')}`
    },
    change(p, mode) {
      return { type: 'album_order', order: mode === 'undo' ? p.oldOrder : p.newOrder }
    }
  },

  // 分组结构整块重建：payload { dimId, oldValue, newValue }，两值均为该维度的组+成员快照数组。
  // 覆盖增删小组、增删成员、成员拖拽排序、智能分组、小组数量增减等结构性操作。
  group_snapshot: {
    validate({ dimId, oldValue }) {
      if (!Number.isInteger(dimId) || !Array.isArray(oldValue)) return '参数不完整'
      return null
    },
    undo({ dimId, oldValue }) { applyGroupSnapshot(dimId, oldValue) },
    redo({ dimId, newValue }) { applyGroupSnapshot(dimId, newValue) },
    describe(p, mode) {
      const count = (s) => (s || []).length + '/' + (s || []).reduce((n, g) => n + ((g.members || []).length), 0)
      const old = count(p.oldValue), new_ = count(p.newValue)
      return mode === 'undo' ? `分组结构：${new_} → ${old}` : `分组结构：${old} → ${new_}`
    },
    change(p, mode) {
      return { type: 'group_snapshot', dimId: p.dimId, snapshot: mode === 'undo' ? p.oldValue : p.newValue }
    }
  },

  // 删除分组维度（级联）：payload { dimension, groups, members, sortOrders }
  //   dimension  = 被删维度整行（group_dimensions）
  //   groups     = 该维度下的小组整行（groups）
  //   members    = 这些小组的成员整行（group_members）
  //   sortOrders = 删除前所有维度的排序 [{ id, sort_order }]
  // 后端删维度是三件事：删成员、删小组、删维度，再把剩余维度重排成 1..n。
  // 撤销必须连**排序**一起回滚，否则维度回来了、顺序却和删除前不一样。
  group_dimension_delete: {
    validate({ dimension }) {
      if (!dimension || !Number.isInteger(dimension.id)) return '参数不完整'
      return null
    },
    // 外键顺序（维度 → 小组 → 成员）与「剩余维度重排 1..n」都在 store 内同一事务
    undo(payload) { undoStore.restoreDimension(payload) },
    redo(payload) { undoStore.removeDimension(payload) },
    describe(p, mode) {
      const name = (p.dimension && p.dimension.name) || `#${p.dimension && p.dimension.id}`
      const g = (p.groups || []).length
      const m = (p.members || []).length
      return mode === 'undo'
        ? `恢复分组维度：${name}（${g} 个小组 / ${m} 名成员）`
        : `删除分组维度：${name}（${g} 个小组 / ${m} 名成员）`
    },
    change() { return { type: 'full_reload' } }
  },

  // 合并相册（虚拟相册）：payload { newAlbum, newPhotos, sources: [{ album, photos }] }
  // 后端合并 = 建新相册 + 复制照片索引 + 删掉源相册及其索引。
  // 撤销要反着来：删新相册 → 把每个源相册（整行 + 照片整行）原样插回。
  // ⚠️ 合并时源相册的缩略图文件已被物理删除，恢复索引时把 thumb_path 清空，
  //    让前端按需重新生成 —— 否则列表会指向一批已经不存在的文件。
  album_merge: {
    validate({ newAlbum }) {
      if (!newAlbum || !Number.isInteger(newAlbum.id)) return '参数不完整'
      return null
    },
    undo(payload) { undoStore.restoreMergedAlbum(payload) },
    redo(payload) { undoStore.reapplyMergedAlbum(payload) },
    describe(p, mode) {
      const name = (p.newAlbum && p.newAlbum.name) || ''
      return mode === 'undo' ? `恢复相册：${name}` : `合并相册：${name}`
    },
    change() { return { type: 'full_reload' } }
  },

  // 删除职务（级联）：payload { node, members, children }
  //   node     = 被删职务的整行（cadres）
  //   members  = 该职务当时的担任学生整行（cadre_members，含 sort_order）
  //   children = 直接下级 [{ id, parent_id }]，parent_id 为删除前的上级
  // 后端删职务是三件事：删成员、下级上移到 node.parent_id、删职务行。
  // 撤销必须三件事一起回滚 —— 分开记会让用户按三次 Ctrl+Z 才回到原状。
  cadre_delete: {
    validate({ node, members }) {
      if (!node || !Number.isInteger(node.id)) return '参数不完整'
      if (!Array.isArray(members)) return '参数不完整'
      return null
    },
    undo(payload) { undoStore.restoreCadreDelete(payload) },
    redo(payload) { undoStore.reapplyCadreDelete(payload) },
    describe(p, mode) {
      const name = (p.node && p.node.name) || `#${p.node && p.node.id}`
      const n = (p.members || []).length
      return mode === 'undo' ? `恢复职务：${name}（含 ${n} 名担任学生）` : `删除职务：${name}（含 ${n} 名担任学生）`
    },
    change() { return { type: 'full_reload' } }
  },

  // 职务 / 担任学生拖拽排序：payload { before, after, label }
  //   before/after = { cadres: [{ id, parent_id, sort_order }], members: [{ id, cadre_id, sort_order }] }
  // 一次拖拽会改动同一父级下多个兄弟的 sort_order（成员还会改 cadre_id），
  // 逐行 row_update 会把一步操作拆成好几条撤销记录，故按「受影响行的前后态」整批记一条。
  cadre_order: {
    validate({ before, after }) {
      if (!before || !after) return '参数不完整'
      if (!Array.isArray(before.cadres) || !Array.isArray(before.members)) return '参数不完整'
      if (!Array.isArray(after.cadres) || !Array.isArray(after.members)) return '参数不完整'
      return null
    },
    undo({ before }) { undoStore.applyCadreState(before) },
    redo({ after }) { undoStore.applyCadreState(after) },
    describe(p, mode) {
      if (p.label) return p.label
      return mode === 'undo' ? '恢复职务排序' : '调整职务排序'
    },
    change() { return { type: 'full_reload' } }
  },

  // Excel 批量导入职务：payload { cadres, members }，均为本次导入真正新建的行
  // （同名职务/已有成员只复用、不修改，因此不需要快照，也不会动到导入前的数据）。
  // undo = 删掉本次新建的行；redo = 按原 id 重建。
  cadre_import: {
    validate({ cadres, members }) {
      if (!Array.isArray(cadres) || !Array.isArray(members)) return '参数不完整'
      return null
    },
    undo(payload) { undoStore.restoreCadreImport(payload) },
    redo(payload) { undoStore.reapplyCadreImport(payload) },
    describe(p, mode) {
      const c = (p.cadres || []).length
      const m = (p.members || []).length
      return mode === 'undo' ? `撤销导入：${c} 个职务、${m} 名担任学生` : `重新导入：${c} 个职务、${m} 名担任学生`
    },
    change() { return { type: 'full_reload' } }
  },

  // 删除学生（级联）：payload = 后端 delete-with-relations 返回的 removed 快照
  //   { student, leaveRows, scoreRows, groupRows, cadreRows, seatCells, dutySlots }
  // 一次删除同时动 students / 请假 / 加减分 / 小组 / 班干部 / 座位 / 值日 七处：
  // 拆成七条 row_delete/grid_cell 会让用户按七次 Ctrl+Z 才回到原状，中途失败还会留下半删状态。
  // 所以撤销 = 一个事务里把七处一起回滚；重做 = 一个事务里再删一遍。
  student_cascade_delete: {
    validate({ student }) {
      if (!student || !Number.isInteger(student.id)) return '参数不完整';
      return null;
    },
    undo(payload) {
      const { seatCells, dutySlots } = payload;
      // 主表与四类关联由 restoreStudentCascade 插（外键顺序在 store 内）；
      // 座位/值日走 studentRelations 的 JSON 网格，必须与行插入同一事务 → 事务留在执行器。
      undoStore.runInTransaction(() => {
        undoStore.restoreStudentCascade(payload);
        restoreSeatCells(seatCells);
        restoreDutySlots(dutySlots);
      });
    },
    redo(payload) {
      const { student, seatCells } = payload;
      // 与 undo 对称：先删四类关联、清座位/值日，最后删主表（顺序与原实现一致）
      undoStore.runInTransaction(() => {
        undoStore.deleteStudentLinks(payload);
        clearSeatCells(seatCells);
        clearDutySlots(student);
        undoStore.deleteStudentRow(student.id);
      });
    },
    describe(p, mode) {
      const name = rowName(p.student);
      const n = ['leaveRows', 'scoreRows', 'groupRows', 'cadreRows']
        .reduce((sum, k) => sum + ((p[k] || []).length), 0)
        + (p.seatCells || []).length + (p.dutySlots || []).length;
      return mode === 'undo'
        ? `恢复学生：${name}（含 ${n} 条关联记录）`
        : `删除学生：${name}（含 ${n} 条关联记录）`;
    },
    change() { return { type: 'full_reload' } }
  },

  // 删除照片（移入应用内回收站）：payload { photo }。undo=从回收站搬回+还原索引；redo=再次移入回收站+删索引。
  photo_trash: {
    validate({ photo }) {
      if (!photo || !Number.isInteger(photo.id) || !photo.file_path) return '参数不完整'
      return null
    },
    async undo({ photo }) {
      // 文件搬移与索引插入必须同生共死：
      //   · 先搬文件、后插索引 → 索引插入失败时文件已归位，但库里没这条记录
      //     → 照片躺在磁盘上，界面里看不到也清不掉（用户以为删了，其实还在）。
      //   · 先插索引、后搬文件 → 搬文件失败时索引已恢复，但文件还在回收站
      //     → 界面里能看到这张照片，点开却是坏的（文件打不开）。
      //
      // 文件操作是 async，进不了 SQLite 事务，所以只能「先做不可逆的那步 + 失败时回退」。
      // 这里选「先搬文件」：搬文件成功后再插索引，插索引失败就把文件搬回收站退回去。
      const restored = await restoreToOriginal(photo);
      // 文件不在回收站（已被手动删掉 / 回收站被清空）→ 恢复不了。
      // 这时插索引等于造一条指向不存在文件的记录（点开会坏），
      // 所以按「恢复失败」处理，抛错让 flip 把 dir 改回去（记录仍可重试）。
      if (!restored) {
        throw new Error('照片文件不在回收站，无法恢复');
      }
      try {
        undoStore.insertPhotoIndex(photo)
      } catch (err) {
        // 索引没插进去 → 把已归位的文件搬回收站，退回「文件在回收站、索引没有」的原状态
        if (restored) {
          try { await moveToTrash(photo); } catch (rollbackErr) {
            console.error('[undo] 照片索引插入失败后回退文件失败:', rollbackErr.message);
          }
        }
        throw err;
      }
    },
    async redo({ photo }) {
      // 同理：先删索引（DB），再搬文件；搬文件失败时把索引插回去。
      // 顺序与 undo 相反但同样要求「要么都做、要么都不做」。
      undoStore.deletePhotoIndex(photo.id);
      try {
        await moveToTrash(photo);
      } catch (err) {
        try {
          undoStore.insertPhotoIndex(photo)
        } catch (rollbackErr) {
          console.error('[undo] 照片移入回收站失败后回退索引失败:', rollbackErr.message);
        }
        throw err;
      }
      await deleteThumb(photo, dbManager.currentSlug()).catch(() => {})
    },
    describe(p, mode) {
      const name = p.photo ? (p.photo.file_name || `#${p.photo.id}`) : ''
      return mode === 'undo' ? `恢复照片：${name}` : `删除照片：${name}`
    },
    change() { return { type: 'full_reload' } }
  },

  // 删除相册（仅删索引+缩略图，源文件留在磁盘）：payload { album, photos }。
  // undo=还原相册+照片索引（缩略图由 /thumb 按需重建）；redo=再次删除缩略图+索引。
  album_delete: {
    validate({ album, photos }) {
      if (!album || !Number.isInteger(album.id) || !Array.isArray(photos)) return '参数不完整'
      return null
    },
    async undo({ album, photos }) {
      // 相册 + 全部照片索引一起恢复（store 内一个事务，不留「相册已回、照片只回一半」）
      undoStore.insertAlbumWithPhotos(album, photos)
    },
    async redo({ album, photos }) {
      const slug = dbManager.currentSlug();
      // 缩略图先删（FS 副作用留在这里）；索引与相册行一起删（store 内一个事务）
      for (const ph of photos || []) await deleteThumb(ph, slug).catch(() => {})
      undoStore.deleteAlbumWithPhotos(album.id)
    },
    describe(p, mode) {
      const name = p.album ? (p.album.name || `#${p.album.id}`) : ''
      const c = (p.photos || []).length
      return mode === 'undo' ? `恢复相册：${name}（${c} 项）` : `删除相册：${name}（${c} 项）`
    },
    change() { return { type: 'full_reload' } }
  },

  // 添加相册（触发后台扫描建索引）：payload { album }。undo=撤销添加（删索引+缩略图+停扫描）；redo=重新添加相册。
  // redo 不自动重扫（照片已被 undo 清掉，缩略图按需重建），用户可点「刷新」重扫。
  album_add: {
    validate({ album }) {
      if (!album || !Number.isInteger(album.id)) return '参数不完整'
      return null
    },
    async undo({ album }) {
      const photos = undoStore.albumPhotosBrief(album.id)
      const slug = dbManager.currentSlug();
      for (const ph of photos) await deleteThumb(ph, slug).catch(() => {})
      // 撤销「添加相册」：照片索引与相册行一起删，避免只删了一半导致孤儿索引。
      undoStore.deleteAlbumWithPhotos(album.id)
      const albumRouter = require('../album')
      if (albumRouter && albumRouter.cancelScan) albumRouter.cancelScan(album.id)
    },
    redo({ album }) {
      // kind 必须一起还原：虚拟相册没有文件夹，重做时不能去扫路径（会白跑一轮扫描）
      const kind = undoStore.insertAlbumRow(album)
      if (kind === 'virtual') return
      // 重做=重新加入文件夹，触发该相册的增量扫描（由前端轮询逐步显示）
      const albumRouter = require('../album')
      if (albumRouter && albumRouter.startScan) albumRouter.startScan(album.id)
    },
    describe(p, mode) {
      const name = p.album ? (p.album.name || `#${p.album.id}`) : ''
      return mode === 'undo' ? `撤销添加相册：${name}` : `重新添加相册：${name}`
    },
    change() { return { type: 'full_reload' } }
  },

  // 移动照片索引到另一个相册：payload { target_album_id, target_album_name, records }。
  // records 每项记录来源行与本次动作（inserted=目标侧新增；source_removed=来源是虚拟相册、索引已被搬走）。
  // undo=删掉目标侧新增的索引 + 还原被搬走的来源索引；redo=再做一遍。全程只动 album_photos，不碰文件。
  album_photo_move: {
    validate({ target_album_id, records }) {
      if (!Number.isInteger(target_album_id) || !Array.isArray(records)) return '参数不完整'
      return null
    },
    // 目标侧删除与来源侧还原同一事务（store 内），半途失败不会出现「两边都没有」。
    // redo 的 thumb_path 恒为空：插回目标侧的是新行，缩略图由 /thumb 按需生成。
    async undo({ target_album_id, records }) { undoStore.restoreAlbumPhotoMove(target_album_id, records) },
    async redo({ target_album_id, records }) { undoStore.reapplyAlbumPhotoMove(target_album_id, records) },
    describe(p, mode) {
      const name = p.target_album_name ? `「${p.target_album_name}」` : ''
      const count = (p.records || []).length
      return mode === 'undo' ? `撤销移动照片索引${name}（${count} 张）` : `移动照片索引${name}（${count} 张）`
    },
    change() { return { type: 'full_reload' } }
  }
}

module.exports = { executors, ALLOWED_TABLES, DOC_TABLES, GRID_SOURCES }
