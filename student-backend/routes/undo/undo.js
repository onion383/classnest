// =========================================================================
// undo.js —— 撤销系统·路由入口
// （原 routes/undo.js 拆分后的主文件，纯代码搬运，行为不变）
//   实现按职责搬运到 undo.helpers.js / undo.executors.js / undo.records.js，
//   本文件仅定义路由并挂载 AI 复用接口，导出 router（与原文件一致）。
// =========================================================================

const express = require('express')
const { sendError } = require('../../utils/sendError')
const undoStore = require('../../services/undoStore')
const { executors } = require('./undo.executors')
const { withGridCache } = require('./undo.helpers')
const {
  pushRecord, flip, rewindTo, undoCellOnly, undoOriginBatch, redoOriginBatch, undoAiChange, undoAiChanges, listAiChanges,
  staleReason, getRecord,
} = require('./undo.records')

const router = express.Router()

// 批次撤销的展示文案：逐条 label 拼起来会很长（单格改动每格一句），只给出条数
function batchLabel(b) {
  if (b.count > 1) return `一次改动（${b.count} 项）`
  return b.labels[0] || ''
}

// 按 key 分组返回（含每组计数与记录）
// 这里**不算失效**：列表要快、要能立刻开面板；失效判定要读数据表逐条比对，
// 拆到 GET /stale（面板一次只看一张表，也就只算那一张）。
router.get('/', (req, res) => {
  const rows = undoStore.listAll()
  const groups = []
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.key)) {
      map.set(r.key, { key: r.key, records: [] })
      groups.push(map.get(r.key))
    }
    map.get(r.key).records.push({
      id: r.id,
      type: r.type,
      label: r.label,
      dir: r.dir,
      ts: r.ts,
      // origin 交给前端折叠：同一次动作的多条记录合成一行（一次动作一步）
      origin: r.origin,
      // 来源分类（manual/ai_assistant/mcp）：审查面板按它筛选、给每条打标签。
      // 不能用 origin<>'' 在前端猜——AI 和 MCP 的 origin 都非空。
      source: r.source,
      // 不回 payload：列表只需要 label/时间/来源，而整块快照类记录的 payload
      // 是整张座位表/值日表的前后副本（单条上百 KB）—— 几十条就是几 MB 的无用响应。
      // 需要具体前后值时按 id 取单条（getRecord），不在列表里传。
    })
  }
  res.json({ groups })
})

// 某张表里「现在还撤得动吗」：只返回**失效的那几条**（id → 原因），可撤的不占字节。
// 现算不落库：数据被别的路径改回去之后，同一条记录会重新变可用，存标记立刻过期。
// 只算 dir=1（已撤销的没有失效概念）；不传 key 才算全部（导出/排查用）。
router.get('/stale', (req, res) => {
  try {
    const key = typeof req.query.key === 'string' ? req.query.key : ''
    const rows = key ? undoStore.idsByKey(key, 1, 'DESC') : undoStore.listAll().filter((r) => r.dir === 1)
    const stale = {}
    // 一次请求内复用同一份网格 JSON（helpers.withGridCache）：同表 50 条记录
    // 不必把同一块 seats/duty cells 解析 50 遍。
    withGridCache(() => {
      for (const row of rows) {
        const rec = getRecord(row.id)
        if (!rec || rec.dir !== 1) continue
        const why = staleReason(rec)
        if (why) stale[rec.id] = why
      }
    })
    res.json({ key, stale })
  } catch (e) { sendError(res, e) }
})

// 新增记录
router.post('/', (req, res) => {
  const { key, type, label, payload, origin } = req.body || {}
  if (!key || !type) return res.status(400).json({ error: '缺少参数' })
  if (!(type in executors)) return res.status(400).json({ error: `不支持的记录类型: ${type}` })
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  // 入库前先跑执行器校验（Q2-08）：畸形负载（缺 rowId / 表名非法 / 网格坐标越界）
  // 过去会先落库，直到用户点撤销才暴露，且那条记录永远无法回放。
  const ex = executors[type]
  const bad = ex.validate ? ex.validate(p) : null
  if (bad) return res.status(400).json({ error: bad })
  const id = pushRecord(String(key).slice(0, 200), type, String(label || '').slice(0, 200), p, String(origin || ''))
  res.json({ id })
})

// 查询某 key 的撤销/重做可用态（供标题栏按钮显示禁用态与提示文案）
router.get('/table/:key/status', (req, res) => {
  const key = req.params.key
  const u = undoStore.latestByKey(key, 1)
  const r = undoStore.latestByKey(key, 0)
  res.json({ canUndo: !!u, canRedo: !!r, undoLabel: u?.label || '', redoLabel: r?.label || '' })
})

// 按 key 撤销最近一条（dir 1 -> 0），供 Ctrl+Z 使用
// 最近一条带 origin 时按「批次」整批回退：一次用户动作（拖一次座位、AI 一次提案）可能登记多条记录，
// Ctrl+Z 应该退回一步，而不是让用户按 N 次。无 origin 的普通记录仍是单条行为，与旧版一致。
//
// 失效处理（skipIds / skipOrigins）：记录还生效、但执行条件已不满足（数据被别的路径改过）。
// 第一次撞上**不跳**，回 { stale:true, ... } 让前端说清原因；用户再按一次才把这条加进
// skip 列表重发，逐条往回找下一个还能撤的。失效是现算的：把那次改动撤回去之后，
// 同一条会重新变可用，所以 skip 只存在于前端这一次会话里，不落库。
router.post('/table/:key/undo', async (req, res) => {
  const key = req.params.key
  const skipIds = new Set((Array.isArray(req.body?.skipIds) ? req.body.skipIds : []).map(Number).filter(Number.isInteger))
  const skipOrigins = new Set((Array.isArray(req.body?.skipOrigins) ? req.body.skipOrigins : []).map(String).filter(Boolean))

  for (const row of undoStore.idsByKey(key, 1, 'DESC')) {
    const rec = getRecord(row.id)
    if (!rec) continue
    if (skipIds.has(rec.id)) continue
    if (rec.origin && skipOrigins.has(rec.origin)) continue

    const why = staleReason(rec)
    if (why) {
      return res.json({ ok: false, stale: true, id: rec.id, origin: rec.origin || '', label: rec.label, error: why })
    }

    if (rec.origin) {
      // 批次是原子的：成员里只要有一条被改过，整批都退不了。先逐条验，
      // 才能把「哪一条失效」说清楚（否则只能拿到 batch 里的一句模糊报错）。
      for (const m of undoStore.idsByOrigin(rec.origin, 1, 'DESC')) {
        const member = getRecord(m.id)
        const memberWhy = staleReason(member)
        if (memberWhy) {
          return res.json({ ok: false, stale: true, id: member.id, origin: rec.origin, label: member.label, error: memberWhy })
        }
      }
      const b = await undoOriginBatch(rec.origin)
      if (!b.ok) return res.status(400).json({ error: b.error })
      return res.json({ ok: true, label: batchLabel(b), change: { type: 'full_reload' }, batch: b.count })
    }

    const r = await flip(rec.id, 1, 0, 'undo')
    if (r.error) return res.status(400).json({ error: r.error })
    return res.json({ ok: true, label: r.label, change: r.change })
  }
  return res.json({ ok: false, error: '当前表没有可撤销的记录' })
})

// 按 key 重做最近一条（dir 0 -> 1），供 Ctrl+Shift+Z / Ctrl+Y 使用
// 与撤销对称：最近一条在 redo 侧且带 origin 时，整批重做（正序，与撤销的逆序相反）。
router.post('/table/:key/redo', async (req, res) => {
  const rec = undoStore.latestByKey(req.params.key, 0, true)
  if (!rec) return res.json({ ok: false, error: '当前表没有可重做的记录' })
  if (rec.origin) {
    const b = await redoOriginBatch(rec.origin)
    if (!b.ok) return res.status(400).json({ error: b.error })
    return res.json({ ok: true, label: batchLabel(b), change: { type: 'full_reload' }, batch: b.count })
  }
  const r = await flip(rec.id, 0, 1, 'redo')
  if (r.error) return res.status(400).json({ error: r.error })
  res.json({ ok: true, label: r.label, change: r.change })
})

// 按批次（origin）撤销整批：供设置页对「一次改动」整批操作。
// 与 /table/:key/undo 的区别是**指定批次**，而不是「最近一条」——
// 设置页里用户可以点历史中任意一行的撤销按钮。
router.post('/origin/:origin/undo', async (req, res) => {
  const b = await undoOriginBatch(req.params.origin)
  if (!b.ok) return res.status(400).json({ error: b.error })
  res.json({ ok: true, label: batchLabel(b), batch: b.count })
})

// 按批次（origin）重做整批，顺序与撤销相反（正序）
router.post('/origin/:origin/redo', async (req, res) => {
  const b = await redoOriginBatch(req.params.origin)
  if (!b.ok) return res.status(400).json({ error: b.error })
  res.json({ ok: true, label: batchLabel(b), batch: b.count })
})

// 路径里的 :id 收敛成正整数。
// Number('abc') → NaN、Number('1.5') → 1.5、Number('') → 0：这些值绑进 SQL 不会抛错
// （better-sqlite3 允许 NaN），只是查不到记录 → 表现为「记录不存在」。
// 但「静默查不到」是**误导**：用户点了撤销却看到「记录不存在」，实际是请求本身就不合法。
// 按项目既有口径（ai.dataRoutes / ai.config 都是 Number.isInteger(id) && id > 0）显式拒绝。
function parseUndoId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

// 撤销某条（dir 1 -> 0）
router.post('/:id/undo', async (req, res) => {
  const id = parseUndoId(req.params.id)
  if (id == null) return res.status(400).json({ error: '记录 id 无效' })
  const r = await flip(id, 1, 0, 'undo')
  if (r.error) return res.status(400).json({ error: r.error })
  res.json({ ok: true, label: r.label, change: r.change })
})

// 只撤这一条（跳过它后面的记录）：仅限「格子级」记录，且这一格后来没被再改过。
// 与 /:id/undo 的区别：那条是「翻一条」的底层接口、不做冲突判定；这条是给人点的，
// 带着「后面改过这一格就拒绝」的判据（见 undoCellOnly）。
router.post('/:id/only', async (req, res) => {
  const id = parseUndoId(req.params.id)
  if (id == null) return res.status(400).json({ error: '记录 id 无效' })
  const r = await undoCellOnly(id)
  if (r.error) return res.status(400).json({ error: r.error })
  res.json({ ok: true, label: r.label, change: r.change })
})

// 重做某条（dir 0 -> 1）
router.post('/:id/redo', async (req, res) => {
  const id = parseUndoId(req.params.id)
  if (id == null) return res.status(400).json({ error: '记录 id 无效' })
  const r = await flip(id, 0, 1, 'redo')
  if (r.error) return res.status(400).json({ error: r.error })
  res.json({ ok: true, label: r.label, change: r.change })
})

// 回退到这条记录之前（全局时间线，跨表跨来源整批）：撤销 R 及之后所有可撤销记录。
// 与 /:id/undo 的区别：后者只退单条，前者退「这条 + 它后面的全部」，且整批原子。
router.post('/:id/rewind', async (req, res) => {
  const id = parseUndoId(req.params.id)
  if (id == null) return res.status(400).json({ error: '记录 id 无效' })
  const b = await rewindTo(id, 'undo')
  if (!b.ok) return res.status(400).json({ error: b.error })
  res.json({ ok: true, label: b.count > 1 ? `已回退 ${b.count} 项改动` : (b.labels[0] || ''), batch: b.count, change: { type: 'full_reload' } })
})

// 重做到这条记录（全局时间线对称操作）：重做 R 及之前所有可重做记录
router.post('/:id/replay', async (req, res) => {
  const id = parseUndoId(req.params.id)
  if (id == null) return res.status(400).json({ error: '记录 id 无效' })
  const b = await rewindTo(id, 'redo')
  if (!b.ok) return res.status(400).json({ error: b.error })
  res.json({ ok: true, label: b.count > 1 ? `已重做 ${b.count} 项改动` : (b.labels[0] || ''), batch: b.count, change: { type: 'full_reload' } })
})

// 清空某 key（?key=all 则清空全部）
router.delete('/', (req, res) => {
  const { key } = req.query
  if (key === 'all') undoStore.clear(null)
  else if (key) undoStore.clear(key)
  else return res.status(400).json({ error: '缺少 key' })
  res.json({ ok: true })
})

// 供 AI 工具（undo_change / list_changes）复用：撤销 AI 助手自己此前的更改
router.undoAiChange = undoAiChange
router.undoAiChanges = undoAiChanges
router.listAiChanges = listAiChanges

module.exports = router
