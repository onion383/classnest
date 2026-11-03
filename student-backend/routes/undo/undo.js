// =========================================================================
// undo.js —— 撤销系统·路由入口
// （原 routes/undo.js 拆分后的主文件，纯代码搬运，行为不变）
//   实现按职责搬运到 undo.helpers.js / undo.executors.js / undo.records.js，
//   本文件仅定义路由并挂载 AI 复用接口，导出 router（与原文件一致）。
// =========================================================================

const express = require('express')
const { db } = require('../../db')
const { executors } = require('./undo.executors')
const {
  pushRecord, flip, undoOriginBatch, redoOriginBatch, undoAiChange, undoAiChanges, listAiChanges,
} = require('./undo.records')

const router = express.Router()

// 批次撤销的展示文案：逐条 label 拼起来会很长（单格改动每格一句），只给出条数
function batchLabel(b) {
  if (b.count > 1) return `一次改动（${b.count} 项）`
  return b.labels[0] || ''
}

// 按 key 分组返回（含每组计数与记录）
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM undo_history ORDER BY id ASC').all()
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
      payload: JSON.parse(r.payload || '{}')
    })
  }
  res.json({ groups })
})

// 新增记录
router.post('/', (req, res) => {
  const { key, type, label, payload, origin } = req.body || {}
  if (!key || !type) return res.status(400).json({ error: '缺少参数' })
  if (!(type in executors)) return res.status(400).json({ error: `不支持的记录类型: ${type}` })
  const id = pushRecord(key, type, label || '', payload || {}, origin || '')
  res.json({ id })
})

// 查询某 key 的撤销/重做可用态（供标题栏按钮显示禁用态与提示文案）
router.get('/table/:key/status', (req, res) => {
  const key = req.params.key
  const u = db.prepare('SELECT label FROM undo_history WHERE key = ? AND dir = 1 ORDER BY id DESC LIMIT 1').get(key)
  const r = db.prepare('SELECT label FROM undo_history WHERE key = ? AND dir = 0 ORDER BY id DESC LIMIT 1').get(key)
  res.json({ canUndo: !!u, canRedo: !!r, undoLabel: u?.label || '', redoLabel: r?.label || '' })
})

// 按 key 撤销最近一条（dir 1 -> 0），供 Ctrl+Z 使用
// 最近一条带 origin 时按「批次」整批回退：一次用户动作（拖一次座位、AI 一次提案）可能登记多条记录，
// Ctrl+Z 应该退回一步，而不是让用户按 N 次。无 origin 的普通记录仍是单条行为，与旧版一致。
router.post('/table/:key/undo', async (req, res) => {
  const rec = db.prepare('SELECT id, origin FROM undo_history WHERE key = ? AND dir = 1 ORDER BY id DESC LIMIT 1').get(req.params.key)
  if (!rec) return res.json({ ok: false, error: '当前表没有可撤销的记录' })
  if (rec.origin) {
    const b = await undoOriginBatch(rec.origin)
    if (!b.ok) return res.status(400).json({ error: b.error })
    return res.json({ ok: true, label: batchLabel(b), change: { type: 'full_reload' }, batch: b.count })
  }
  const r = await flip(rec.id, 1, 0, 'undo')
  if (r.error) return res.status(400).json({ error: r.error })
  res.json({ ok: true, label: r.label, change: r.change })
})

// 按 key 重做最近一条（dir 0 -> 1），供 Ctrl+Shift+Z / Ctrl+Y 使用
// 与撤销对称：最近一条在 redo 侧且带 origin 时，整批重做（正序，与撤销的逆序相反）。
router.post('/table/:key/redo', async (req, res) => {
  const rec = db.prepare('SELECT id, origin FROM undo_history WHERE key = ? AND dir = 0 ORDER BY id DESC LIMIT 1').get(req.params.key)
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

// 撤销某条（dir 1 -> 0）
router.post('/:id/undo', async (req, res) => {
  const id = Number(req.params.id)
  const r = await flip(id, 1, 0, 'undo')
  if (r.error) return res.status(400).json({ error: r.error })
  res.json({ ok: true, label: r.label, change: r.change })
})

// 重做某条（dir 0 -> 1）
router.post('/:id/redo', async (req, res) => {
  const id = Number(req.params.id)
  const r = await flip(id, 0, 1, 'redo')
  if (r.error) return res.status(400).json({ error: r.error })
  res.json({ ok: true, label: r.label, change: r.change })
})

// 删除单条
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  db.prepare('DELETE FROM undo_history WHERE id = ?').run(id)
  res.json({ ok: true })
})

// 清空某 key（?key=all 则清空全部）
router.delete('/', (req, res) => {
  const { key } = req.query
  if (key === 'all') db.prepare('DELETE FROM undo_history').run()
  else if (key) db.prepare('DELETE FROM undo_history WHERE key = ?').run(key)
  else return res.status(400).json({ error: '缺少 key' })
  res.json({ ok: true })
})

// 供 AI 工具（undo_change / list_changes）复用：撤销 AI 助手自己此前的更改
router.undoAiChange = undoAiChange
router.undoAiChanges = undoAiChanges
router.listAiChanges = listAiChanges

module.exports = router
