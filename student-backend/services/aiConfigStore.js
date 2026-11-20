// ==================== ai_settings / ai_models 的 SQL 出口 ====================
// 档 C · M12-B7：AI 配置路由只做校验、联网测试与 HTTP，语句收在这里。
const { db } = require('../db')
const crypto = require('node:crypto')
const { safeJson, packJson } = require('../utils/json')

// AI 数据保护默认全关：开启会改变发给模型的内容，必须由用户显式选择。
// closed_tables：完全禁止 AI 读取；readonly_tables：可读但禁止 AI 写入（「只读」档）。
// 两张清单互斥（写接口按 level 单值改写），默认都不含任何表 —— 也就是维持改造前的行为：
// 可读表都能读，白名单里的行式/整块表都能提交写提案（仍需老师确认）。
const PRIVACY_DEFAULTS = { enabled: false, hide_phone: true, hide_path: true, hide_album: true, closed_tables: [], readonly_tables: [] }

// AI 与 MCP 各一份，结构相同、默认值相同，只是存在不同的列里。
// 共用读取逻辑，避免两边对「坏 JSON 怎么退」「缺字段怎么补」出两种口径。
// col 只取下面两个常量，不接受外部输入，所以是安全的标识符拼接。
function readPrivacyCol(col) {
  const row = db.prepare(`SELECT ${col} FROM ai_settings WHERE id = 1`).get() || {};
  const v = safeJson(row[col], {}, `ai_settings.${col}`);
  return { ...PRIVACY_DEFAULTS, ...(v && typeof v === 'object' && !Array.isArray(v) ? v : {}) }
}

function writePrivacyCol(col, patch) {
  const next = { ...readPrivacyCol(col), ...(patch && typeof patch === 'object' ? patch : {}) }
  db.prepare(`UPDATE ai_settings SET ${col} = ? WHERE id = 1`).run(packJson(next, col))
  return next
}

// AI 助手侧（本地对话、工具调用）
function readPrivacy() { return readPrivacyCol('privacy_json') }
function setPrivacy(patch) { return writePrivacyCol('privacy_json', patch) }

// MCP 侧（外部 AI 客户端读表 / 提写提案）。分开的理由见 schema.ai.js 那段注释：
// 面向外部客户端的收紧不该连带锁住老师自己的助手。
function readMcpPrivacy() { return readPrivacyCol('mcp_privacy_json') }
function setMcpPrivacy(patch) { return writePrivacyCol('mcp_privacy_json', patch) }

function readSeed() {
  const row = db.prepare("SELECT privacy_seed FROM ai_settings WHERE id = 1").get() || {}
  return String(row.privacy_seed || '')
}

// 懒生成且条件写回：并发的两个请求各自算出一个随机串时，只有第一个能落库，
// 第二个重读拿到同一个值，避免同一库里先后两套别名。
function ensureSeed() {
  const existing = readSeed()
  if (existing) return existing
  const generated = crypto.randomBytes(32).toString('hex')
  db.prepare("UPDATE ai_settings SET privacy_seed = ? WHERE id = 1 AND (privacy_seed IS NULL OR privacy_seed = '')").run(generated)
  return readSeed() || generated
}

function writeSeed(seed) {
  db.prepare("UPDATE ai_settings SET privacy_seed = ? WHERE id = 1 AND (privacy_seed IS NULL OR privacy_seed = '')").run(String(seed || ''))
  return readSeed()
}

function readFlags() {
  return db.prepare('SELECT enabled, floating_enabled FROM ai_settings WHERE id = 1').get() || {}
}

function readFloatingEnabled() {
  const row = db.prepare('SELECT floating_enabled FROM ai_settings WHERE id = 1').get() || {}
  return row.floating_enabled == null ? true : !!row.floating_enabled
}

// MCP 服务启用状态：存在 ai_settings（按库走备份/恢复），与 token 本身分开。
// 老库没有 mcp_enabled 列时按「未启用」处理，避免迁移前意外对外开放。
function readMcpEnabled() {
  try {
    const row = db.prepare('SELECT mcp_enabled FROM ai_settings WHERE id = 1').get() || {}
    return !!row.mcp_enabled
  } catch (_) {
    return false
  }
}

function setMcpEnabled(on) {
  db.prepare('UPDATE ai_settings SET mcp_enabled = ? WHERE id = 1').run(on ? 1 : 0)
}

// MCP 提案的保留与执行设置。proposal_keep 只作用于「已处理」那一栏 —— 未处理的是
// 老师还没看的确认队列，任何情况下都不能被裁剪掉（裁掉等于偷偷丢提案）。
// 默认 200：一周通常几十条，200 条够回看；这张表的 payload 存的是真名真号码，不宜无限留。
// 范围 50~2000，且**不提供「永久」**：和访问记录不同，这里每一条都是一份数据副本。
//
// auto_confirm：外部 AI 的提案不再等老师点，建完立刻执行（含删除）。
// 默认关，且必须由用户显式打开——它拆掉的是整条链路上唯一的人工闸门。
const MCP_PREFS_DEFAULTS = { proposal_keep: 200, auto_confirm: false }
const MCP_KEEP_MIN = 50
const MCP_KEEP_MAX = 2000

function clampProposalKeep(v) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return MCP_PREFS_DEFAULTS.proposal_keep
  return Math.max(MCP_KEEP_MIN, Math.min(MCP_KEEP_MAX, n))
}

function readMcpPrefs() {
  let raw = {}
  try {
    const row = db.prepare('SELECT mcp_prefs_json FROM ai_settings WHERE id = 1').get() || {}
    raw = safeJson(row.mcp_prefs_json, {}, 'ai_settings.mcp_prefs_json')
  } catch (_) { raw = {} } // 老库还没补列：按默认走，不阻断提案页
  const v = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  return {
    proposal_keep: clampProposalKeep(v.proposal_keep == null ? MCP_PREFS_DEFAULTS.proposal_keep : v.proposal_keep),
    // 严格等于 true 才算开启：脏值（"1" / 1 / null）一律当关闭，安全开关不能靠 truthy
    auto_confirm: v.auto_confirm === true,
  }
}

function setMcpPrefs(patch) {
  const next = readMcpPrefs()
  if (patch && patch.proposal_keep != null) next.proposal_keep = clampProposalKeep(patch.proposal_keep)
  if (patch && patch.auto_confirm !== undefined) next.auto_confirm = patch.auto_confirm === true
  db.prepare('UPDATE ai_settings SET mcp_prefs_json = ? WHERE id = 1').run(packJson(next, 'mcp_prefs_json'))
  return next
}

// 数据访问记录的设置。两个值都可调（用户要求），默认：
//   keep: 500 —— 只留最近 500 条，够回看几周，体积可控；0 = 永久保留（不裁剪）
//   granularity: 'per_call' —— 每次工具调用一条，能看出读了哪张表、多少行
// 'per_day' 只是**查看方式**（读取时按天合并同一工具/目标的记录），不改已落库的
// 数据——切回 per_call 仍然逐条可见，所以这个选择是可逆的，不用写迁移。
const LOG_DEFAULTS = { keep: 500, granularity: 'per_call' }
const LOG_KEEP_MIN = 100
const LOG_KEEP_MAX = 5000
// 0 是「永久」的哨兵值，必须放行（不能被夹回 100）；其余落在 [100, 5000]。
const LOG_KEEP_FOREVER = 0

function clampKeep(v) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return LOG_DEFAULTS.keep
  if (n === LOG_KEEP_FOREVER) return LOG_KEEP_FOREVER
  return Math.max(LOG_KEEP_MIN, Math.min(LOG_KEEP_MAX, n))
}

function readLogConfig() {
  let raw = {}
  try {
    const row = db.prepare('SELECT log_json FROM ai_settings WHERE id = 1').get() || {}
    raw = safeJson(row.log_json, {}, 'ai_settings.log_json')
  } catch (_) { raw = {} } // 老库还没补列：按默认走，不阻断读表
  const v = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  return {
    keep: clampKeep(v.keep == null ? LOG_DEFAULTS.keep : v.keep),
    granularity: v.granularity === 'per_day' ? 'per_day' : 'per_call',
  }
}

function setLogConfig(patch) {
  const next = readLogConfig()
  if (patch && patch.keep != null) next.keep = clampKeep(patch.keep)
  if (patch && patch.granularity) next.granularity = patch.granularity === 'per_day' ? 'per_day' : 'per_call'
  db.prepare('UPDATE ai_settings SET log_json = ? WHERE id = 1').run(packJson(next, 'log_json'))
  return next
}

function readActiveModel() {
  return db.prepare('SELECT * FROM ai_models WHERE is_active = 1').get() || {}
}

function setEnabled(on) {
  db.prepare('UPDATE ai_settings SET enabled = ? WHERE id = 1').run(on ? 1 : 0)
}

function setFloatingEnabled(on) {
  db.prepare('UPDATE ai_settings SET floating_enabled = ? WHERE id = 1').run(on ? 1 : 0)
}

function listModels() {
  return db.prepare('SELECT id, name, provider, base_url, model, is_active, api_key, reasoning FROM ai_models ORDER BY id').all()
}

// 同一服务商已配置过密钥时可留空自动复用。
function findReusableApiKey(provider) {
  const row = db.prepare("SELECT api_key FROM ai_models WHERE provider = ? AND api_key != '' ORDER BY id LIMIT 1").get(provider)
  return (row && row.api_key) || ''
}

function countModels() {
  return db.prepare('SELECT COUNT(*) AS c FROM ai_models').get().c
}

function insertModel({ name, provider, base_url, model, api_key, is_active }) {
  return db.prepare(
    'INSERT INTO ai_models (name, provider, base_url, model, api_key, is_active) VALUES (?,?,?,?,?,?)'
  ).run(name, provider, base_url, model, api_key, is_active)
}

function findModelId(id) {
  return db.prepare('SELECT id FROM ai_models WHERE id = ?').get(id)
}

// 同一事务内「先清其余、再置目标」：任一语句失败都不会留下「全空」的中间态。
function activateModel(id) {
  db.transaction(() => {
    db.prepare('UPDATE ai_models SET is_active = 0 WHERE id != ?').run(id)
    db.prepare('UPDATE ai_models SET is_active = 1 WHERE id = ?').run(id)
  })()
}

function findModelActive(id) {
  return db.prepare('SELECT is_active FROM ai_models WHERE id = ?').get(id)
}

function deleteModel(id) {
  db.prepare('DELETE FROM ai_models WHERE id = ?').run(id)
}

function findOtherModelId(id) {
  return db.prepare('SELECT id FROM ai_models WHERE id != ? ORDER BY id LIMIT 1').get(id)
}

function setModelActive(id) {
  db.prepare('UPDATE ai_models SET is_active = 1 WHERE id = ?').run(id)
}

function findModelConnection(id) {
  return db.prepare('SELECT provider, base_url, api_key FROM ai_models WHERE id = ?').get(id)
}

function findModel(id) {
  return db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id)
}

function updateModel(id, { name, provider, base_url, model, api_key }) {
  db.prepare('UPDATE ai_models SET name = ?, provider = ?, base_url = ?, model = ?, api_key = ? WHERE id = ?')
    .run(name, provider, base_url, model, api_key, id)
}

function setReasoning(id, on) {
  return db.prepare('UPDATE ai_models SET reasoning = ? WHERE id = ?').run(on, id)
}

module.exports = {
  readPrivacy,
  setPrivacy,
  readMcpPrivacy,
  setMcpPrivacy,
  readSeed,
  ensureSeed,
  writeSeed,
  readFlags,
  readFloatingEnabled,
  readMcpEnabled,
  setMcpEnabled,
  readMcpPrefs,
  setMcpPrefs,
  MCP_PREFS_DEFAULTS,
  MCP_KEEP_MIN,
  MCP_KEEP_MAX,
  readLogConfig,
  setLogConfig,
  LOG_DEFAULTS,
  LOG_KEEP_MIN,
  LOG_KEEP_MAX,
  readActiveModel,
  setEnabled,
  setFloatingEnabled,
  listModels,
  findReusableApiKey,
  countModels,
  insertModel,
  findModelId,
  activateModel,
  findModelActive,
  deleteModel,
  findOtherModelId,
  setModelActive,
  findModelConnection,
  findModel,
  updateModel,
  setReasoning,
}
