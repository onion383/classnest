// ==================== ai_settings / ai_models 的 SQL 出口 ====================
// 档 C · M12-B7：AI 配置路由只做校验、联网测试与 HTTP，语句收在这里。
const { db } = require('../db')

function readFlags() {
  return db.prepare('SELECT enabled, floating_enabled FROM ai_settings WHERE id = 1').get() || {}
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
  readFlags,
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
