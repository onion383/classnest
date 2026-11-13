// ==================== ai_conversations / ai_messages 的 SQL 出口 ====================
// 档 C · M12-B7：会话路由与上下文压缩共用这一份读写实现。
const { db } = require('../db')

function exists(id) {
  return !!db.prepare('SELECT 1 FROM ai_conversations WHERE id = ?').get(id)
}

function createConversation(title) {
  return db.prepare('INSERT INTO ai_conversations (title) VALUES (?)').run(title)
}

function listConversations() {
  return db.prepare(`
    SELECT c.id, c.title, c.updated_at,
           (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS msg_count
    FROM ai_conversations c
    ORDER BY c.updated_at DESC, c.id DESC
  `).all()
}

// 删会话（含其消息）。两条语句保持原顺序，不额外引入事务（行为与下沉前一致）。
function deleteConversation(id) {
  db.prepare('DELETE FROM ai_messages WHERE conversation_id = ?').run(id)
  db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(id)
}

// 读取消息：上下文重建用（不含 created_at，少取一列）。
function listMessages(conversationId) {
  return db.prepare('SELECT id, role, content, process_json, attachments_json FROM ai_messages WHERE conversation_id = ? ORDER BY id')
    .all(conversationId)
}

// 读取消息：界面列表用（带 created_at）。
function listMessagesForUi(conversationId) {
  return db.prepare('SELECT id, role, content, process_json, attachments_json, created_at FROM ai_messages WHERE conversation_id = ? ORDER BY id')
    .all(conversationId)
}

// 分页读取：倒序取 limit+1 条再升序返回；调用方据多取的一条判断 hasMore。
function listMessagesPage(conversationId, { beforeId, limit }) {
  const hasBefore = Number.isInteger(beforeId) && beforeId > 0
  const where = hasBefore ? 'conversation_id = ? AND id < ?' : 'conversation_id = ?'
  const params = hasBefore ? [conversationId, beforeId, limit + 1] : [conversationId, limit + 1]
  return db.prepare(`
    SELECT id, role, content, process_json, attachments_json, created_at FROM (
      SELECT id, role, content, process_json, attachments_json, created_at FROM ai_messages
      WHERE ${where} ORDER BY id DESC LIMIT ?
    ) ORDER BY id
  `).all(...params)
}

function insertMessage(conversationId, role, content, processJson, attachmentsJson) {
  return db.prepare('INSERT INTO ai_messages (conversation_id, role, content, process_json, attachments_json) VALUES (?,?,?,?,?)')
    .run(conversationId, role, content, processJson, attachmentsJson)
}

function touch(conversationId) {
  db.prepare('UPDATE ai_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId)
}

// 用第一条用户消息作标题（只替换默认标题）。
function autoTitle(conversationId, content) {
  db.prepare("UPDATE ai_conversations SET title = ? WHERE id = ? AND title = '新对话'")
    .run((content || '新对话').slice(0, 30), conversationId)
}

function updateMessage(conversationId, messageId, content, processJson) {
  db.prepare('UPDATE ai_messages SET content = ?, process_json = ? WHERE id = ? AND conversation_id = ?')
    .run(content, processJson, messageId, conversationId)
}

function lastAssistantId(conversationId) {
  return db.prepare("SELECT id FROM ai_messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
    .get(conversationId)
}

function deleteMessage(id) {
  db.prepare('DELETE FROM ai_messages WHERE id = ?').run(id)
}

function deleteMessages(conversationId, ids) {
  return db.prepare(
    `DELETE FROM ai_messages WHERE conversation_id = ? AND id IN (${ids.map(() => '?').join(',')})`
  ).run(conversationId, ...ids)
}

// ---------- 上下文压缩 / 重建（ai.memory.js 使用） ----------
function getSummary(id) {
  return db.prepare('SELECT summary FROM ai_conversations WHERE id = ?').get(id)
}

function getMeta(id) {
  return db.prepare('SELECT summary, summary_upto, last_prompt_tokens FROM ai_conversations WHERE id = ?').get(id)
}

function updateSummary(id, summary, upto) {
  db.prepare('UPDATE ai_conversations SET summary = ?, summary_upto = ? WHERE id = ?').run(summary, upto, id)
}

function setLastPromptTokens(id, tokens) {
  db.prepare('UPDATE ai_conversations SET last_prompt_tokens = ? WHERE id = ?').run(tokens, id)
}

module.exports = {
  exists,
  createConversation,
  listConversations,
  deleteConversation,
  listMessages,
  listMessagesForUi,
  listMessagesPage,
  insertMessage,
  touch,
  autoTitle,
  updateMessage,
  lastAssistantId,
  deleteMessage,
  deleteMessages,
  getSummary,
  getMeta,
  updateSummary,
  setLastPromptTokens,
}
