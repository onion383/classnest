// ==================== 撤销系统（undo_history）与执行器的 SQL 出口 ====================
// 档 C · M12-B8：undo.* 只保留撤销语义（validate / describe / change / 顺序编排），
// 语句收在这里。
//
// 两条边界，与 B1/B2 同一判据：
//   · 「必须在一个事务里才一致」的复合动作用一个方法包住（删维度、合并相册、删职务、
//     删学生等），事务边界跟着数据操作走。
//   · **带文件系统副作用的顺序仍留在执行器**（照片搬回收站、删缩略图、派发扫描）——
//     先搬文件再插索引这类顺序就是业务本身，搬进 service 会让它看不见。
//     这里只提供纯 DB 段（insertPhotoIndex / deletePhotoIndex / insertAlbumRows）。
//
// 表名安全：动态表名的白名单校验在调用方（executors 的 ALLOWED_TABLES /
// DOC_TABLES / GRID_SOURCES），本文件只拼语句与绑定，不再重复校验。
const { db } = require('../db')
const store = require('./slotStore')
const { packJson, safeJson } = require('../utils/json')
const { COLUMN_RULES, sanitizeField } = require('./sanitize')
const { SEAT_CURRENT_SLOTS, MATRIX_GEOMETRY_TABLES: MATRIX_GEOMETRY_TABLE_LIST } = require('../schema/tableRegistry')

// X3-06：回放快照写回前按当前列级规则清洗脏值（数字/日期/枚举/布尔/电话）。
// 三条约束保证「撤销 = 精确还原」不被破坏：
//   1. 只对声明了列级规则的标量列清洗——无规则的列原样写回，避免 cleanByType('文字')
//      把合法数字/日期 String() 成字符串；
//   2. JSON / 结构化列（json / seatgrid / dutycells / dutymap / apps / classinfo）跳过——
//      sanitizeField 返回对象，直接绑值会被 better-sqlite3 存成 "[object Object]"，
//      而快照里的 JSON 值本来就是合法字符串；
//   3. 清洗抛错（快照带脏值）时保留原值——恢复语义优先，宁可放过脏值也不能让撤销失败，
//      让用户的「撤销」按钮永远可用。
const STRUCTURED_RULES = new Set(['json', 'seatgrid', 'dutycells', 'dutymap', 'apps', 'classinfo'])
function sanitizeReplayValue(table, column, value) {
  const rule = COLUMN_RULES[table] && COLUMN_RULES[table][column]
  if (!rule || STRUCTURED_RULES.has(rule.kind)) return value
  try { return sanitizeField(value, table, column) } catch (_) { return value }
}

const GEOMETRY_COUNT_TABLES = new Set(SEAT_CURRENT_SLOTS)
// 非座位网格里几何可由当前 cells 矩阵推出的表（课表）。值日表的 cells 是
// {项目:{星期:[]}} 的对象，没有行列几何，不在此列。清单从注册表引用，禁止手抄。
const MATRIX_GEOMETRY_TABLES = new Set(MATRIX_GEOMETRY_TABLE_LIST)

// 每 key 保留条数：撤销面板不分页，完全建立在这个上限上（见 undo-retention 判据）。
const MAX_KEYS = 50
// 时间保留期：某个 key 之后不再编辑时，它的 50 条快照会永久留存（K05-04）。
// 30 天足够覆盖「放假回来还想撤回」的场景，又不会让 undo_history 无限增长。
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

// 批量回退的 savepoint 序号：名字每次不同，避免重入时撞名（SQLite 同名 savepoint 会嵌套，
// RELEASE 只释放最近一层，撞名会让外层提交落空）。
let rewindSeq = 0

// 统一来源分类：与 origin 正交。origin 保留批次语义（整批回退靠它），source 只做面板筛选。
// 不能只看 origin<>'' 分类——那会把 AI 助手和 MCP 混在一起（两者的 origin 都非空）。
function sourceOfOrigin(origin) {
  if (!origin || typeof origin !== 'string') return 'manual'
  if (/^[0-9a-f]{32}$/.test(origin)) return 'mcp' // MCP 提案 id = randomBytes(16).toString('hex')
  // 助手批次只有两种词形：ai-<ts>-<rand> / 子agent:<备注>-<ts>-<rand>。
  // 其余（op-<ts>-<rand>，老师一次动作的批次）是手改 —— 以前「非 hex 即助手」
  // 会把「一次改三格」这种手改批次整批标成 AI。
  if (/^ai-/.test(origin) || origin.startsWith('子agent')) return 'ai_assistant'
  return 'manual'
}

// ============================ 撤销记录表 ============================

// 全量（面板列表用）；调用方按 key 自行分组
function listAll() {
  return db.prepare('SELECT * FROM undo_history ORDER BY id ASC').all()
}

function findById(id) {
  return db.prepare('SELECT * FROM undo_history WHERE id = ?').get(id)
}

// 访问时间线只需要的列（K04-07）：按来源/时间下推，避免把 undo_history 整表读进内存。
function listForAccess(source, { since = '', limit = 1000 } = {}) {
  const cap = Math.max(1, Math.min(5000, Number(limit) || 1000))
  return db.prepare(
    `SELECT id, key, label, ts, dir, source, origin FROM undo_history
     WHERE source = ? AND (? = '' OR ts >= ?) ORDER BY id DESC LIMIT ${cap}`
  ).all(source, since, since)
}

// 某 key 在某方向的最近一条（'undo' 侧 dir=1 / 'redo' 侧 dir=0）。
// full=true 取整行（撤销要 origin），false 只取 label（按钮态文案）。
function latestByKey(key, dir, full = false) {
  const cols = full ? 'id, origin, source' : 'label'
  return db.prepare(`SELECT ${cols} FROM undo_history WHERE key = ? AND dir = ? ORDER BY id DESC LIMIT 1`).get(key, dir)
}

// 新增记录：**清空全部 redo → 插入 → 每 key 超限淘汰最旧**，三步必须同事务。
// 只清本 key 会在跨 key 批次里留下「另一半还能重做」的残尾；淘汰不是原子则可能多删/漏删。
function push({ key, type, label, payload, origin, source }) {
  const ts = new Date().toISOString()
  const src = source || sourceOfOrigin(origin)
  return db.transaction(() => {
    db.prepare('DELETE FROM undo_history WHERE dir = 0').run()
    // 顺带清超龄记录：只按 key 条数淘汰时，长期不再编辑的 key 会永久保留（K05-04）
    db.prepare('DELETE FROM undo_history WHERE ts < ?').run(new Date(Date.now() - MAX_AGE_MS).toISOString())
    const info = db.prepare(
      'INSERT INTO undo_history (key, type, label, payload, dir, origin, source, ts) VALUES (?, ?, ?, ?, 1, ?, ?, ?)'
    ).run(key, type, label, packJson(payload, 'undo_payload'), origin || '', src, ts)
    const over = db.prepare('SELECT id FROM undo_history WHERE key = ? ORDER BY id DESC LIMIT -1 OFFSET ?').all(key, MAX_KEYS)
    if (over.length) {
      const del = db.prepare('DELETE FROM undo_history WHERE id = ?')
      for (const r of over) del.run(r.id)
    }
    return info.lastInsertRowid
  })()
}

// 抢占方向（CAS）：只有仍处于 fromDir 的才能切到 toDir，避免同向重放。
function claimDir(id, toDir, fromDir) {
  return db.prepare('UPDATE undo_history SET dir = ? WHERE id = ? AND dir = ?').run(toDir, id, fromDir)
}

// 执行失败时把方向改回去（记录仍可重试）
function releaseDir(id, fromDir, toDir) {
  return db.prepare('UPDATE undo_history SET dir = ? WHERE id = ? AND dir = ?').run(fromDir, id, toDir)
}

// ========== 批量回退的原子边界（SAVEPOINT） ==========
// 为什么不用 db.transaction()：它是同步包装器，函数里一旦 await（执行器含异步文件操作）
// 就会在 await 前提交、await 后落库，事务边界被撕开。SAVEPOINT 是连接级状态，可以跨 await
// 保持开启，把所有同步 DB 写（含嵌套执行器自己的 db.transaction）收进同一边界。
function beginRewind() {
  const name = `undo_rewind_${++rewindSeq}`
  db.exec(`SAVEPOINT ${name}`)
  return name
}

function commitRewind(name) {
  db.exec(`RELEASE SAVEPOINT ${name}`)
}

function rollbackRewind(name) {
  db.exec(`ROLLBACK TO SAVEPOINT ${name}`)
  db.exec(`RELEASE SAVEPOINT ${name}`)
}

// 全局时间线里从 targetId 起的记录 id（含边界）。op / order 内部写死，绝不接前端字符串：
// 这两个值会拼进 SQL，放行外部输入等于开注入口。undo 逆序（>= target，后做的先退），
// redo 正序（<= target，先做的先回）。
function idsFromBoundary(targetId, dir, op, order) {
  if (op !== '>=' && op !== '<=') throw new Error('无效的时间线方向')
  if (order !== 'ASC' && order !== 'DESC') throw new Error('无效的执行顺序')
  return db.prepare(`SELECT id FROM undo_history WHERE id ${op} ? AND dir = ? ORDER BY id ${order}`).all(targetId, dir)
}

// 某批次在某方向的记录 id，按撤销/重做的执行顺序取：
//   undo 逆序（后做的先退）、redo 正序（先做的先回）
function idsByOrigin(origin, dir, order) {
  return db.prepare(`SELECT id FROM undo_history WHERE dir = ? AND origin = ? ORDER BY id ${order}`).all(dir, origin)
}

// 某资源在某方向的全部记录 id（Ctrl+Z 找候选时用：要从最新往前逐条试，
// 碰到「已失效」的由调用方决定是提示还是跳过，不能一上来只取一条）。
function idsByKey(key, dir, order = 'DESC') {
  const ord = order === 'ASC' ? 'ASC' : 'DESC'
  return db.prepare(`SELECT id FROM undo_history WHERE key = ? AND dir = ? ORDER BY id ${ord}`).all(key, dir)
}

// 最近一条 AI 助手更改的批次标识；key 可选，限定某个资源。
// 用 source 而不是 origin<>''：MCP 的 origin 也非空，旧口径会把外部工具的改动
// 当成助手自己的更改退掉。分类在 push 时已按 origin 形态算好，这里直接用。
function latestAiOrigin(key) {
  let sql = "SELECT origin FROM undo_history WHERE dir = 1 AND source = 'ai_assistant'"
  const params = []
  if (key) { sql += ' AND key = ?'; params.push(String(key)) }
  sql += ' ORDER BY id DESC LIMIT 1'
  return db.prepare(sql).get(...params)
}

// AI 助手更改的可撤销记录（面板 step 分组用，最新在前）
function listAiRows() {
  return db.prepare("SELECT id, key, label, origin, source, ts FROM undo_history WHERE dir = 1 AND source = 'ai_assistant' ORDER BY id DESC").all()
}

// 按主键读真实表的当前整行（expected 快照校验用）。
// 表名来自撤销 payload，已在 executor.validate 经 ALLOWED_TABLES 白名单校验，这里不再重复。
function findRowById(table, id) {
  return db.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id)
}

// key 为空表示清空全部（路由层已把 'all' 转成 undefined）
function clear(key) {
  if (key == null) return db.prepare('DELETE FROM undo_history').run()
  return db.prepare('DELETE FROM undo_history WHERE key = ?').run(key)
}

// ============================ 网格 / 文档列 ============================

// 读单例文档表的一列（slotStore 管辖的走 getDoc，其余读物理表 id=1）
function readDocColumn(table, column) {
  return store.isDoc(table) ? store.getDoc(table) : db.prepare(`SELECT "${column}" FROM "${table}" WHERE id = 1`).get()
}

// 网格表的当前几何（行数/列数），撤销单格前用它判「布局是否已经变小」。
// 座位表的几何是独立列；课表这类矩阵的几何就是当前 cells 的形状（Q2-06）。
function readSeatGeometry(table) {
  if (GEOMETRY_COUNT_TABLES.has(table)) {
    return store.isDoc(table) ? store.getDoc(table) : db.prepare(`SELECT rows, cols FROM "${table}" WHERE id = 1`).get()
  }
  if (!MATRIX_GEOMETRY_TABLES.has(table)) return null
  const row = readDocColumn(table, 'cells')
  const cells = safeJson(row && row.cells, [], 'cells')
  if (!Array.isArray(cells) || !cells.length || !Array.isArray(cells[0]) || !cells[0].length) return null
  return { rows: cells.length, cols: cells[0].length }
}

// 整体覆盖网格列。座位整块快照可带几何 { seats, types }，两列同笔写。
function writeDocColumn(table, column, value) {
  if (column === 'seats' && value && typeof value === 'object' && !Array.isArray(value)) {
    const patch = { seats: JSON.stringify(Array.isArray(value.seats) ? value.seats : []) }
    if (Array.isArray(value.types)) patch.types = JSON.stringify(value.types)
    if (store.isDoc(table)) { store.setDoc(table, patch); return }
    const keys = Object.keys(patch)
    db.prepare(`UPDATE "${table}" SET ${keys.map((k) => `"${k}" = ?`).join(', ')} WHERE id = 1`)
      .run(...keys.map((k) => patch[k]))
    return
  }
  if (store.isDoc(table)) { store.setDoc(table, { [column]: JSON.stringify(value) }); return }
  db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE id = 1`).run(JSON.stringify(value))
}

// 座位表的行数/列数回写（必须与 seats/types 同一笔提交，否则读库按旧几何裁矩阵）
function writeGeometryCounts(table, rows, cols) {
  if (!GEOMETRY_COUNT_TABLES.has(table)) return
  const patch = {}
  if (Number.isInteger(rows)) patch.rows = rows
  if (Number.isInteger(cols)) patch.cols = cols
  if (!Object.keys(patch).length) return
  if (store.isDoc(table)) { store.setDoc(table, patch); return }
  if (Number.isInteger(rows)) db.prepare(`UPDATE "${table}" SET rows = ? WHERE id = 1`).run(rows)
  if (Number.isInteger(cols)) db.prepare(`UPDATE "${table}" SET cols = ? WHERE id = 1`).run(cols)
}

// ============================ 动态表行级操作 ============================

function tableCols(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
}

function rowKeys(table, row) {
  const cols = new Set(tableCols(table))
  return Object.keys(row || {}).filter((k) => cols.has(k))
}

// 插入整行（显式带 id：删除后再恢复要保住引用关系）
function insertRow(table, row) {
  const keys = rowKeys(table, row)
  if (!keys.length) return
  const cols = keys.map((k) => `"${k}"`).join(',')
  const ph = keys.map(() => '?').join(',')
  db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${ph})`).run(...keys.map((k) => sanitizeReplayValue(table, k, row[k])))
}

function deleteRowById(table, id) {
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
}

function updateRowById(table, id, row) {
  const keys = rowKeys(table, row).filter((k) => k !== 'id')
  if (!keys.length) return
  const set = keys.map((k) => `"${k}" = ?`).join(', ')
  db.prepare(`UPDATE ${table} SET ${set} WHERE id = ?`).run(...keys.map((k) => sanitizeReplayValue(table, k, row[k])), id)
}

// 单格写回（cell_update）：字段名已在 validate 里按真实列校验
function setCellValue(table, field, value, rowId) {
  db.prepare(`UPDATE "${table}" SET "${field}" = ? WHERE id = ?`).run(sanitizeReplayValue(table, field, value), rowId)
}

// 成员姓名（快照）被单独回写后，把权威引用拉回一致。
//
// 什么时候会分叉：分组页里把成员「张三」改成「李四」，updateMember 会为李四建临时学生
// 并把 student_id 指过去；用户再撤销，撤销记录里只有 member_name 这一列，
// 于是姓名回到「张三」、student_id 还指着「李四」那个人。界面上完全看不出来，
// 但导出、按 id 统计、以及之后每次「只改备注」（会保留原 id）都会沿用这个错的引用。
//
// 认人复用 provisionalStudents 的单源实现（create:false —— 撤销不该凭空造学生）。
// 延迟 require：本文件是很多 store 的底层，避免加载期成环。
function resyncGroupMemberRef(rowId) {
  const { resolveOne } = require('./provisionalStudents')
  const row = db.prepare('SELECT student_id, member_name FROM group_members WHERE id = ?').get(rowId)
  if (!row) return
  const name = String(row.member_name == null ? '' : row.member_name).trim()
  let nextId = null
  if (name) {
    const r = resolveOne(name, { create: false })
    nextId = r && r.id ? Number(r.id) : null
  }
  const cur = row.student_id == null ? null : Number(row.student_id)
  if (nextId === cur) return
  db.prepare('UPDATE group_members SET student_id = ? WHERE id = ?').run(nextId, rowId)
}

// 整块覆盖「非行式」表的若干列（对象/数组按 JSON 文本落库，布尔按 1/0）
function writeDocCols(table, id, obj) {
  if (store.isDoc(table)) { store.setDoc(table, obj); return }
  const keys = rowKeys(table, obj).filter((k) => k !== 'id')
  if (!keys.length) return
  const set = keys.map((k) => `"${k}" = ?`).join(', ')
  const params = keys.map((k) => {
    const v = obj[k]
    if (v != null && typeof v === 'object') return JSON.stringify(v)
    if (typeof v === 'boolean') return v ? 1 : 0
    return v
  })
  db.prepare(`UPDATE ${table} SET ${set} WHERE id = ?`).run(...params, id)
}

// 按 [{id, position}] 回写槽位：只更新已存在的行，position 非法则跳过
function applyRowPositions(table, list) {
  db.transaction(() => {
    const upd = db.prepare(`UPDATE "${table}" SET position = ? WHERE id = ?`)
    for (const r of list || []) {
      if (!r || !Number.isInteger(r.id) || !Number.isInteger(r.position)) continue
      upd.run(r.position, r.id)
    }
  })()
}

// 相册排序（1 起整块重写；已删的 id 影响 0 行，跳过）
function applyAlbumOrder(ids) {
  db.transaction(() => {
    const upd = db.prepare('UPDATE albums SET sort_order = ? WHERE id = ?')
    ;(ids || []).forEach((id, i) => upd.run(i + 1, Number(id)))
  })()
}

// 相册名（album_order 的展示文案用）
function albumName(id) {
  const r = db.prepare('SELECT name FROM albums WHERE id = ?').get(id)
  return r ? r.name : `#${id}`
}

// 分组结构整块重建：先按维度清理，再按快照显式 id 重建
function applyGroupSnapshot(dimId, groups) {
  db.transaction(() => {
    db.prepare('DELETE FROM group_members WHERE group_id IN (SELECT id FROM groups WHERE dimension_id = ?)').run(dimId)
    db.prepare('DELETE FROM groups WHERE dimension_id = ?').run(dimId)
    const insG = db.prepare('INSERT INTO groups (id, dimension_id, name, gender, sort_order) VALUES (?, ?, ?, ?, ?)')
    // student_id 是权威引用（同名两人靠它区分）；快照行带着它，回填时必须一起写回，
    // 否则撤销/重做后成员行只剩姓名，引用退化为姓名匹配（K05-06）。
    const insM = db.prepare('INSERT INTO group_members (id, group_id, student_id, member_name, remark, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
    for (const g of groups || []) {
      insG.run(g.id, dimId, g.name ?? '', g.gender ?? null, g.sort_order)
      for (const m of g.members || []) insM.run(m.id, g.id, m.student_id ?? null, m.member_name ?? '', m.remark ?? '', m.sort_order)
    }
  })()
}

// 职务/成员的前后态回写：只更新已存在的行，不插入不删除
function applyCadreState(state) {
  db.transaction(() => {
    const updCadre = db.prepare('UPDATE cadres SET parent_id = ?, sort_order = ? WHERE id = ?')
    for (const r of (state && state.cadres) || []) {
      updCadre.run(r.parent_id == null ? 0 : r.parent_id, r.sort_order == null ? 0 : r.sort_order, r.id)
    }
    const updMember = db.prepare('UPDATE cadre_members SET cadre_id = ?, sort_order = ? WHERE id = ?')
    for (const r of (state && state.members) || []) {
      updMember.run(r.cadre_id, r.sort_order == null ? 0 : r.sort_order, r.id)
    }
  })()
}

// ============================ 各执行器的复合动作 ============================

// 删分组维度（级联）的 undo：维度 → 小组 → 成员，最后回滚全部维度的排序
function restoreDimension({ dimension, groups, members, sortOrders }) {
  db.transaction(() => {
    insertRow('group_dimensions', dimension)
    for (const g of groups || []) insertRow('groups', g)
    for (const m of members || []) insertRow('group_members', m)
    const upd = db.prepare('UPDATE group_dimensions SET sort_order = ? WHERE id = ?')
    for (const s of sortOrders || []) upd.run(s.sort_order, s.id)
  })()
}

// 删分组维度（级联）的 redo：删成员 → 删小组 → 删维度 → 剩余维度重排 1..n
function removeDimension({ dimension, groups }) {
  db.transaction(() => {
    for (const g of groups || []) {
      db.prepare('DELETE FROM group_members WHERE group_id = ?').run(g.id)
    }
    db.prepare('DELETE FROM groups WHERE dimension_id = ?').run(dimension.id)
    db.prepare('DELETE FROM group_dimensions WHERE id = ?').run(dimension.id)
    const rest = db.prepare('SELECT id FROM group_dimensions ORDER BY sort_order, id').all()
    const upd = db.prepare('UPDATE group_dimensions SET sort_order = ? WHERE id = ?')
    rest.forEach((r, i) => upd.run(i + 1, r.id))
  })()
}

// 合并相册的 undo：删新相册 → 源相册与照片按原 id 插回（缩略图置空，交给 /thumb 重建）
function restoreMergedAlbum({ newAlbum, sources }) {
  db.transaction(() => {
    db.prepare('DELETE FROM album_photos WHERE album_id = ?').run(newAlbum.id)
    db.prepare('DELETE FROM albums WHERE id = ?').run(newAlbum.id)
    for (const s of sources || []) {
      insertRow('albums', s.album)
      for (const p of s.photos || []) insertRow('album_photos', { ...p, thumb_path: '' })
    }
  })()
}

// 合并相册的 redo：删源相册与照片 → 插回新相册与照片
function reapplyMergedAlbum({ newAlbum, newPhotos, sources }) {
  db.transaction(() => {
    for (const s of sources || []) {
      db.prepare('DELETE FROM album_photos WHERE album_id = ?').run(s.album.id)
      db.prepare('DELETE FROM albums WHERE id = ?').run(s.album.id)
    }
    insertRow('albums', newAlbum)
    for (const p of newPhotos || []) insertRow('album_photos', p)
  })()
}

// 删职务（级联）的 undo：插职务 → 插担任学生 → 下级重新挂回它
function restoreCadreDelete({ node, members, children }) {
  db.transaction(() => {
    insertRow('cadres', node)
    for (const m of members || []) insertRow('cadre_members', m)
    const restoreParent = db.prepare('UPDATE cadres SET parent_id = ? WHERE id = ?')
    for (const c of children || []) restoreParent.run(node.id, c.id)
  })()
}

// 删职务（级联）的 redo：删成员 → 下级上移 → 删职务行
function reapplyCadreDelete({ node, children }) {
  db.transaction(() => {
    db.prepare('DELETE FROM cadre_members WHERE cadre_id = ?').run(node.id)
    const moveUp = db.prepare('UPDATE cadres SET parent_id = ? WHERE id = ?')
    for (const c of children || []) moveUp.run(node.parent_id || 0, c.id)
    db.prepare('DELETE FROM cadres WHERE id = ?').run(node.id)
  })()
}

// 职务导入的 undo：先删成员，再反向删职务（避免父行先消失、下级短暂悬空）
function restoreCadreImport({ cadres, members }) {
  db.transaction(() => {
    const delMember = db.prepare('DELETE FROM cadre_members WHERE id = ?')
    for (const m of members || []) delMember.run(m.id)
    const delCadre = db.prepare('DELETE FROM cadres WHERE id = ?')
    for (const c of [...(cadres || [])].reverse()) delCadre.run(c.id)
  })()
}

// 职务导入的 redo：父职务先插、成员后插
function reapplyCadreImport({ cadres, members }) {
  db.transaction(() => {
    for (const c of cadres || []) insertRow('cadres', c)
    for (const m of members || []) insertRow('cadre_members', m)
  })()
}

// 删学生（级联）的 undo：主表先插（外键），再插四类关联行。
// 座位/值日由 studentRelations 的 restore* 处理（跨表 JSON 语义，不在这里）。
function restoreStudentCascade({ student, leaveRows, scoreRows, groupRows, cadreRows }) {
  db.transaction(() => {
    insertRow('students', student)
    for (const r of leaveRows || []) insertRow('leave_records', r)
    for (const r of scoreRows || []) insertRow('score_records', r)
    for (const r of groupRows || []) insertRow('group_members', r)
    for (const r of cadreRows || []) insertRow('cadre_members', r)
  })()
}

// 按方向批量删（导入的逆操作要逆序删，避免父子行中途悬空）
function batchDelete(table, rows, { reverse = false } = {}) {
  db.transaction(() => {
    const list = reverse ? [...(rows || [])].reverse() : (rows || [])
    for (const r of list) deleteRowById(table, r.id)
  })()
}

function batchInsert(table, rows) {
  db.transaction(() => {
    for (const r of rows || []) insertRow(table, r)
  })()
}

// 整块覆盖 + 几何回写的原子组合：座位插/删走廊行列时，seats/types 与 rows/cols 必须同一笔。
// geom 为 null（老记录没有 types）时只写列，不动计数。
function writeGridSnapshot(table, column, value, geom) {
  db.transaction(() => {
    writeDocColumn(table, column, value)
    if (geom) writeGeometryCounts(table, geom.rows, geom.cols)
  })()
}

// 跨 store / 跨 service 的事务：调用方需要把「本文件的写 + studentRelations 的写」放在
// 同一个事务里时用它（better-sqlite3 的嵌套事务退化为 savepoint，可以安全套）。
function runInTransaction(fn) {
  return db.transaction(fn)()
}

// 删学生（级联）的 redo：先删四类关联行，主表由调用方在 clear* 之后删
function deleteStudentLinks({ leaveRows, scoreRows, groupRows, cadreRows }) {
  db.transaction(() => {
    const delById = (table, id) => db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id)
    for (const r of leaveRows || []) delById('leave_records', r.id)
    for (const r of scoreRows || []) delById('score_records', r.id)
    for (const r of groupRows || []) delById('group_members', r.id)
    for (const r of cadreRows || []) delById('cadre_members', r.id)
  })()
}

function deleteStudentRow(id) {
  db.prepare('DELETE FROM students WHERE id = ?').run(id)
}

// 照片索引：删照片的撤销要按原 id 插回（thumb_path 置空，按需重建）
const INSERT_PHOTO_COLS = '(id, album_id, file_path, file_name, file_size, mtime, photo_date, exif_date, date_src, thumb_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
const INSERT_PHOTO_SQL = 'INSERT INTO album_photos ' + INSERT_PHOTO_COLS
const INSERT_OR_IGNORE_PHOTO_SQL = 'INSERT OR IGNORE INTO album_photos ' + INSERT_PHOTO_COLS

function insertPhotoIndex(photo) {
  db.prepare(INSERT_PHOTO_SQL).run(
    photo.id, photo.album_id || 0, photo.file_path, photo.file_name || '', photo.file_size || 0,
    photo.mtime || '', photo.photo_date || '', photo.exif_date || '', photo.date_src || '', ''
  )
}

function deletePhotoIndex(photoId) {
  db.prepare('DELETE FROM album_photos WHERE id = ?').run(photoId)
}

// 相册 + 全部照片索引一起插回（要么都回、要么都不回）
function insertAlbumWithPhotos(album, photos) {
  db.transaction(() => {
    db.prepare('INSERT INTO albums (id, name, folder_path, kind, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(album.id, album.name || '', album.folder_path || '', album.kind === 'virtual' ? 'virtual' : 'folder', album.sort_order || 0, album.created_at || '', album.updated_at || '')
    for (const ph of photos || []) {
      db.prepare(INSERT_PHOTO_SQL).run(
        ph.id, album.id, ph.file_path || '', ph.file_name || '', ph.file_size || 0,
        ph.mtime || '', ph.photo_date || '', ph.exif_date || '', ph.date_src || '', ''
      )
    }
  })()
}

// 相册与其照片索引一起删（不留「相册已删、照片还挂着不存在的 album_id」）
function deleteAlbumWithPhotos(albumId) {
  db.transaction(() => {
    db.prepare('DELETE FROM album_photos WHERE album_id = ?').run(albumId)
    db.prepare('DELETE FROM albums WHERE id = ?').run(albumId)
  })()
}

// 撤销「添加相册」要先取它当天的照片（删缩略图 + 删索引）
function albumPhotosBrief(albumId) {
  return db.prepare('SELECT id, file_name FROM album_photos WHERE album_id = ?').all(albumId)
}

// 重做「添加相册」：按原 id 插回相册行（kind 必须一起还原，虚拟相册没有文件夹）
function insertAlbumRow(album) {
  const kind = album.kind === 'virtual' ? 'virtual' : 'folder'
  db.prepare('INSERT INTO albums (id, name, folder_path, kind, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(album.id, album.name || '', album.folder_path || '', kind, album.sort_order || 0, album.created_at || '', album.updated_at || '')
  return kind
}

// 移动照片索引的 undo：删目标侧本次插入的行 + 按原 id 还原被搬走的来源行（同一事务）
function restoreAlbumPhotoMove(targetId, records) {
  db.transaction(() => {
    const delTarget = db.prepare('DELETE FROM album_photos WHERE album_id = ? AND file_path = ?')
    const ins = db.prepare(INSERT_OR_IGNORE_PHOTO_SQL)
    for (const r of records || []) {
      if (!r || !r.file_path) continue
      if (r.inserted) delTarget.run(targetId, r.file_path)
      if (r.source_removed && Number.isInteger(r.source_photo_id)) {
        ins.run(r.source_photo_id, r.source_album_id, r.file_path, r.file_name || '', r.file_size || 0,
          r.mtime || '', r.photo_date || '', r.exif_date || '', r.date_src || '', '')
      }
    }
  })()
}

// 移动照片索引的 redo：目标侧按 file_path 插回（新行、无 id、无缩略图缓存），来源侧按 id 删
function reapplyAlbumPhotoMove(targetId, records) {
  db.transaction(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO album_photos (album_id, file_path, file_name, file_size, mtime, photo_date, exif_date, date_src, thumb_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const del = db.prepare('DELETE FROM album_photos WHERE id = ?')
    for (const r of records || []) {
      if (!r || !r.file_path) continue
      if (r.inserted) ins.run(targetId, r.file_path, r.file_name || '', r.file_size || 0,
        r.mtime || '', r.photo_date || '', r.exif_date || '', r.date_src || '', '')
      if (r.source_removed && Number.isInteger(r.source_photo_id)) del.run(r.source_photo_id)
    }
  })()
}

module.exports = {
  MAX_AGE_MS,
  // 记录表
  listAll,
  // 访问时间线用：按来源/时间下推，只取折叠所需列
  listForAccess,
  findById,
  latestByKey,
  push,
  MAX_KEYS,
  claimDir,
  releaseDir,
  beginRewind,
  commitRewind,
  rollbackRewind,
  idsFromBoundary,
  idsByOrigin,
  idsByKey,
  latestAiOrigin,
  listAiRows,
  sourceOfOrigin,
  findRowById,
  clear,
  // 网格 / 文档列
  readDocColumn,
  readSeatGeometry,
  writeDocColumn,
  writeGeometryCounts,
  // 动态表
  tableCols,
  rowKeys,
  insertRow,
  deleteRowById,
  updateRowById,
  setCellValue,
  resyncGroupMemberRef,
  writeDocCols,
  batchDelete,
  batchInsert,
  writeGridSnapshot,
  runInTransaction,
  applyRowPositions,
  applyAlbumOrder,
  albumName,
  applyGroupSnapshot,
  applyCadreState,
  // 执行器的复合动作
  restoreDimension,
  removeDimension,
  restoreMergedAlbum,
  reapplyMergedAlbum,
  restoreCadreDelete,
  reapplyCadreDelete,
  restoreCadreImport,
  reapplyCadreImport,
  restoreStudentCascade,
  deleteStudentLinks,
  deleteStudentRow,
  insertPhotoIndex,
  deletePhotoIndex,
  insertAlbumWithPhotos,
  deleteAlbumWithPhotos,
  albumPhotosBrief,
  insertAlbumRow,
  restoreAlbumPhotoMove,
  reapplyAlbumPhotoMove,
}
