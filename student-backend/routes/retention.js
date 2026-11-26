// =========================================================================
// 账号数据管理路由（设置页「空间管理 → 管理」弹窗）
// 默认永久保留；本路由的 clear 只由用户显式点击触发，无任何自动清理。
// 五类：messages / history / conversations（SQL 表）+ albumTrash / receiptTrash（文件目录）。
// conversations 只清空壳（无消息的会话），避免 CASCADE 删掉用户消息。
// =========================================================================
const express = require('express')
const fs = require('fs')
const path = require('path')
const router = express.Router()
const retention = require('../services/retentionStore')

// 回收站文件预览的 Content-Type：按扩展名推断。未知的按二进制下载处理，
// 绝不按 HTML 之类可被浏览器执行/解析的类型返回（回收站内容不可信）。
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
  // svg 故意不列：回收站内容不可信，内联返回可执行 SVG 会 XSS（V9-K03-02）。
  // 缺项由 mimeOf 回落 application/octet-stream，浏览器当附件下载而非内联执行。
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', json: 'application/json',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
}
function mimeOf(name) {
  return MIME[path.extname(String(name || '')).slice(1).toLowerCase()] || 'application/octet-stream'
}

// 总览：五类占用 + 当前策略
router.get('/', (req, res) => {
  res.json({ ok: true, policy: retention.readPolicy(), stats: retention.stats() })
})

// 预览：按拟选档位算会删多少条/个文件，纯读（点确定前提示用）
router.post('/preview', (req, res) => {
  const patch = req.body || {}
  const picked = {}
  for (const k of retention.KINDS) picked[k] = patch[k]
  res.json({ ok: true, willDelete: retention.preview(picked) })
})

// 改保留策略。applyNow=true 时先按新档位清一次超期数据，再保存策略。
router.put('/', (req, res) => {
  const patch = req.body && typeof req.body === 'object' ? req.body : {}
  const picked = {}
  for (const k of retention.KINDS) picked[k] = patch[k]
  const deleted = patch.applyNow ? retention.applyNow(picked) : null
  const next = retention.writePolicy(picked)
  res.json({ ok: true, policy: next, deleted, stats: retention.stats() })
})

// 查看明细：?kind=messages|history|conversations|albumTrash|receiptTrash&limit=50
router.get('/list', (req, res) => {
  const kind = String(req.query.kind || '')
  if (!retention.KINDS.includes(kind)) return res.status(400).json({ error: '未知的数据类型' })
  res.json({ ok: true, items: retention.list(kind, req.query.limit) })
})

// 预览回收站里的单个文件：?kind=albumTrash|receiptTrash&key=<list 返回的相对路径>
// 路径校验全在 retentionStore.findTrashFile（basename + 范围内 + 拒绝符号链接）。
router.get('/trash-file', (req, res) => {
  const kind = String(req.query.kind || '')
  if (!['albumTrash', 'receiptTrash'].includes(kind)) return res.status(400).json({ error: '未知的数据类型' })
  const found = retention.findTrashFile(kind, req.query.key)
  if (!found) return res.status(404).json({ error: '文件不存在或路径无效' })
  res.setHeader('Content-Type', mimeOf(found.name))
  res.setHeader('Content-Length', found.bytes)
  res.setHeader('Cache-Control', 'no-store')
  const stream = fs.createReadStream(found.path)
  stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: '读取失败' }); else res.destroy() })
  stream.pipe(res)
})

// 恢复收据：{ key: list 返回的相对路径 }，搬回 uploads 并还原原名。
// 相册不提供恢复：归档名没记原目录，猜回去会放错地方。
router.post('/restore-receipt', (req, res) => {
  const r = retention.restoreReceipt((req.body || {}).key)
  if (!r.ok) return res.status(400).json({ error: r.error })
  res.json({ ok: true, name: r.name, stats: retention.stats() })
})

// 删除全部：{ kind: 五类之一 }。前端必须二次确认。
router.post('/clear', (req, res) => {
  const kind = String((req.body || {}).kind || '')
  if (!retention.KINDS.includes(kind)) return res.status(400).json({ error: '未知的数据类型' })
  const r = retention.deleteAll(kind)
  res.json({ ok: true, deleted: r.deleted, stats: retention.stats() })
})

module.exports = router
