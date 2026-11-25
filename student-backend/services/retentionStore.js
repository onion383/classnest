// =========================================================================
// retentionStore.js —— 账号数据「保留策略 + 占用统计 + 清除」的统一出口
//
// 铁律：**默认永久，系统绝不自己删数据**。
//   · 本文件没有任何定时器、启动钩子或写路径回调会调用 clear()；
//   · clear() 只由设置页「账号数据管理」弹窗的「清除」按钮触发（用户显式动作）；
//   · 策略值只是用户的偏好记录与 UI 显示，不驱动自动删除。
// 这样测试版发布后，未点清除前一条数据都不会少。
//
// 两类出口：
//   · SQL 表：ai_messages / domain_history（按 created_at 判超期）；
//   · 文件目录：album-trash / receipt-trash（按 mtime 判超期，见下方 collectFiles）。
// 回收站是撤销删除的还原源，所以**不接写入路径自动清理**——只按用户在弹窗点
// 「确定 / 删除全部」时清。清空后旧撤销会失败（undo.executors 已有兜底）。
// =========================================================================
const fs = require('fs')
const path = require('path')
const { db } = require('../db')
const { safeJson, packJson } = require('../utils/json')
const dbManager = require('../dbManager/dbManager')

const SQL_KINDS = ['messages', 'history']
const FILE_KINDS = ['albumTrash', 'receiptTrash']
const KINDS = [...SQL_KINDS, ...FILE_KINDS]
// 策略只是显示/偏好；'forever' 是唯一默认值。
const POLICIES = ['forever', '7d', '30d', '180d']
const DEFAULTS = { messages: 'forever', history: 'forever', albumTrash: 'forever', receiptTrash: 'forever' }

// 目录只从 dbManager 的受信任常量取，绝不接受前端传来的路径。
function fileDir(kind) {
  if (kind === 'albumTrash') return dbManager.trashDir
  if (kind === 'receiptTrash') return dbManager.receiptTrashDir
  return null
}

// 枚举回收站里的普通文件。cutoffMs 传数字时只保留 mtime 早于它的（= 超期）。
// 子目录递归（相册回收站按 slug 分桶），**符号链接不跟随也不删** —— 回收站里
// 若被放了链接，绝不能顺着它删到 dataDir 外面去。
function collectFiles(dir, cutoffMs = null) {
  const found = []
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
    for (const entry of entries) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) {
        let st
        try { st = fs.lstatSync(p) } catch (_) { continue }
        if (!st.isFile()) continue // 符号链接等不收
        if (cutoffMs != null && st.mtimeMs >= cutoffMs) continue
        // key = 相对回收站根的路径（相册按 slug 分桶，单靠 name 会重名）
        const key = path.relative(d, p).split(path.sep).join('/')
        found.push({ path: p, key, name: entry.name, bytes: st.size, mtime: st.mtimeMs })
      }
    }
  }
  if (dir) walk(dir)
  return found
}

// 按 key 在回收站里安全定位单个文件。key 来自 list() 返回的相对路径。
// 三重防线：只接受相对路径 + 解析后仍在根目录内 + 每段都 lstat 拒绝符号链接。
// 返回 null 表示拒绝（调用方回 400/404，绝不让路径出到 dataDir 之外）。
function findTrashFile(kind, rawKey) {
  const root = fileDir(kind)
  if (!root || typeof rawKey !== 'string' || !rawKey) return null
  if (path.isAbsolute(rawKey) || rawKey.includes('\\')) return null
  const parts = rawKey.split('/').filter(Boolean)
  if (!parts.length || parts.some(p => p === '.' || p === '..' || p !== path.basename(p))) return null
  const abs = path.resolve(root, ...parts)
  const base = path.resolve(root) + path.sep
  if (!abs.startsWith(base)) return null
  // 逐级检查，任一环节是符号链接就拒绝（含最终文件本身）
  let cur = path.resolve(root)
  for (const part of parts) {
    cur = path.join(cur, part)
    let st
    try { st = fs.lstatSync(cur) } catch (_) { return null }
    if (st.isSymbolicLink()) return null
  }
  try {
    const st = fs.lstatSync(abs)
    if (!st.isFile()) return null
    return { path: abs, name: parts[parts.length - 1], bytes: st.size }
  } catch (_) {
    return null
  }
}

// 收据原文件名：移入时命名 `{timestamp}-{random}-{originalName}`。
// 严格按正则拆前两段，拆不出就拒绝恢复（不猜、不猜错覆盖别的文件）。
function receiptOriginalName(archived) {
  const m = /^\d+-\d+-(.+)$/.exec(archived)
  return m ? m[1] : null
}

function daysFromPolicy(p) {
  if (!POLICIES.includes(p) || p === 'forever') return null
  const days = Number(String(p).replace('d', ''))
  return Number.isInteger(days) && days > 0 ? days : null
}

function cutoffFor(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ')
}

function removeFiles(files) {
  let deleted = 0
  for (const f of files) {
    try { fs.unlinkSync(f.path); deleted++ } catch (_) { /* best-effort: 占用等：不影响其它文件 */ }
  }
  return deleted
}

function readPolicy() {
  const row = db.prepare('SELECT retention_json FROM ai_settings WHERE id = 1').get() || {}
  const v = safeJson(row.retention_json, {}, 'ai_settings.retention_json')
  const out = { ...DEFAULTS }
  for (const k of KINDS) {
    if (POLICIES.includes(v && v[k])) out[k] = v[k]
  }
  return out
}

function writePolicy(patch) {
  const next = { ...readPolicy() }
  for (const k of KINDS) {
    if (patch && POLICIES.includes(patch[k])) next[k] = patch[k]
  }
  db.prepare('UPDATE ai_settings SET retention_json = ? WHERE id = 1').run(packJson(next, 'retention_json'))
  return next
}

// 占用统计：条数 + 估算字节。消息按 content + process_json + attachments_json 的实际长度算，
// 历史快照按 payload 长度算；都是 SQLite 里 TEXT 的真实长度，不含索引开销。
function stats() {
  const messages = db.prepare(`
    SELECT COUNT(*) AS n,
           COALESCE(SUM(LENGTH(content) + LENGTH(process_json) + LENGTH(attachments_json)), 0) AS bytes
    FROM ai_messages
  `).get()
  const history = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS bytes
    FROM domain_history
  `).get()
  const out = {
    messages: { count: messages.n, bytes: messages.bytes },
    history: { count: history.n, bytes: history.bytes },
  }
  for (const k of FILE_KINDS) {
    const files = collectFiles(fileDir(k))
    out[k] = { count: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0) }
  }
  return out
}

// 明细：给「查看」按钮用。只回最近 limit 条，避免一次把整张表拉进渲染层。
function list(kind, limit = 50) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50))
  if (kind === 'messages') {
    return db.prepare(`
      SELECT m.id, m.conversation_id AS conversationId, m.role, m.created_at AS createdAt,
             LENGTH(m.content) + LENGTH(m.process_json) + LENGTH(m.attachments_json) AS bytes,
             SUBSTR(m.content, 1, 120) AS preview
      FROM ai_messages m ORDER BY m.id DESC LIMIT ?
    `).all(n)
  }
  if (kind === 'history') {
    return db.prepare(`
      SELECT id, domain, week_start AS weekStart, snap_date AS snapDate, mode,
             LENGTH(payload) AS bytes, created_at AS createdAt
      FROM domain_history ORDER BY id DESC LIMIT ?
    `).all(n)
  }
  if (FILE_KINDS.includes(kind)) {
    return collectFiles(fileDir(kind))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, n)
      .map(f => ({ key: f.key, name: f.name, bytes: f.bytes, deletedAt: new Date(f.mtime).toISOString() }))
  }
  return []
}

// 删除某类全部记录。只由「删除全部」按钮触发，调用方必须二次确认。
function deleteAll(kind) {
  if (kind === 'messages') return { deleted: db.prepare('DELETE FROM ai_messages').run().changes }
  if (kind === 'history') return { deleted: db.prepare('DELETE FROM domain_history').run().changes }
  if (FILE_KINDS.includes(kind)) return { deleted: removeFiles(collectFiles(fileDir(kind))) }
  return { deleted: 0 }
}

// 预览：按给定策略（不一定已保存）算每类会删掉多少行，纯读不写。
// 用于设置页点「确定」前提示"已有数据需要被删除"。
function preview(patch) {
  const out = {}
  for (const k of KINDS) {
    const days = daysFromPolicy(patch && patch[k])
    if (days == null) { out[k] = 0; continue }
    if (FILE_KINDS.includes(k)) {
      out[k] = collectFiles(fileDir(k), Date.now() - days * 86400000).length
      continue
    }
    const table = k === 'messages' ? 'ai_messages' : 'domain_history'
    out[k] = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE created_at < ?`).get(cutoffFor(days)).n
  }
  return out
}

// 按给定策略立即清一次（点「确定」且用户确认删除后调用）。
function applyNow(patch) {
  const out = {}
  for (const k of KINDS) {
    const days = daysFromPolicy(patch && patch[k])
    if (days == null) { out[k] = 0; continue }
    if (FILE_KINDS.includes(k)) {
      out[k] = removeFiles(collectFiles(fileDir(k), Date.now() - days * 86400000))
      continue
    }
    const table = k === 'messages' ? 'ai_messages' : 'domain_history'
    out[k] = db.prepare(`DELETE FROM ${table} WHERE created_at < ?`).run(cutoffFor(days)).changes
  }
  return out
}

// 恢复收据：从 receipt-trash 搬回 uploads 根目录，并去掉归档前缀还原原名。
// 相册不提供恢复——归档名只含 {id}_{原名}，没记原目录，猜回去会放错地方。
function restoreReceipt(key) {
  const found = findTrashFile('receiptTrash', key)
  if (!found) return { ok: false, error: '文件不存在或路径无效' }
  const original = receiptOriginalName(found.name)
  if (!original) return { ok: false, error: '归档文件名无法还原' }
  const uploads = dbManager.uploadsDir
  const target = path.resolve(uploads, path.basename(original))
  if (!target.startsWith(path.resolve(uploads) + path.sep)) return { ok: false, error: '目标路径无效' }
  if (fs.existsSync(target)) return { ok: false, error: '原位置已有同名文件，未覆盖' }
  try {
    fs.mkdirSync(uploads, { recursive: true })
    fs.renameSync(found.path, target)
  } catch (e) {
    // 跨盘不能用 rename：复制后删源文件
    try {
      fs.copyFileSync(found.path, target)
      fs.unlinkSync(found.path)
    } catch (back) {
      try { fs.unlinkSync(target) } catch (_) { /* best-effort: 目标没建成，忽略 */ }
      return { ok: false, error: '恢复失败：' + back.message }
    }
  }
  return { ok: true, name: original }
}

// 自动清理：只供 SQL 写入路径调用（无定时器、无后台任务）。
// 'forever' 直接返回、不删任何东西；文件类没有写入路径钩子（撤销还原源）。
function autoClean(kind) {
  const days = daysFromPolicy(readPolicy()[kind])
  if (days == null || FILE_KINDS.includes(kind)) return { deleted: 0, days: null }
  const table = kind === 'messages' ? 'ai_messages' : kind === 'history' ? 'domain_history' : null
  if (!table) return { deleted: 0, days: null }
  return { deleted: db.prepare(`DELETE FROM ${table} WHERE created_at < ?`).run(cutoffFor(days)).changes, days }
}

module.exports = {
  KINDS, POLICIES, readPolicy, writePolicy, stats, list, deleteAll, preview, applyNow, autoClean,
  findTrashFile, restoreReceipt,
}
