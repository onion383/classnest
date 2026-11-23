// =========================================================================
// aiWriteScope.js —— 「只读 / 读写」档的唯一判定点
//
// 与 aiReadScope 对称：读闸门管 closed_tables（完全禁止），写闸门管
// readonly_tables（可读但不可写）。判定 = 表本身支持写入（行式 WRITE_TABLES
// 或整块 JSON_WRITE_TABLES）且没被老师设成只读。
//
// 默认不设任何表为只读，即维持改造前的行为：白名单表都能提交写提案
// （仍然要老师在前端确认，本模块只管「能不能提」，不管「要不要确认」）。
// 纯函数 makeWriteScope 供单测注入，运行期单例 writeScope 走 aiConfigStore。
// =========================================================================
const { WRITE_TABLES, JSON_WRITE_TABLES } = require('../routes/ai/ai.constants')
const aiConfigStore = require('./aiConfigStore')

// 措辞要让模型知道「这不是数据不存在，是人设了权限」，否则它会反复重试同一次写入
const READONLY_MSG = '该表已在设置中设为只读（AI 数据保护），AI 不能修改它'
const MCP_READONLY_MSG = '该表已在设置中设为只读（MCP 数据权限），外部客户端不能修改它'
// 「完全禁止」的表既不能读也不能写。读闸门 aiReadScope 拦了 closed_tables，
// 写闸门过去只看 readonly_tables —— 设成「完全禁止」的表仍能提交写提案。
// 文案区分来源，和读闸门一样指向对应设置面板。
const CLOSED_WRITE_MSG = '该表已在设置中设为完全禁止（AI 数据保护），AI 不能读取或修改它'
const MCP_CLOSED_WRITE_MSG = '该表已在设置中设为完全禁止（MCP 数据权限），外部客户端不能读取或修改它'

function makeWriteScope({ readReadonly, readClosed, supportsWrite, msg = READONLY_MSG, closedMsg = CLOSED_WRITE_MSG } = {}) {
  const canWrite = typeof supportsWrite === 'function'
    ? supportsWrite
    : (t) => !!(WRITE_TABLES[t] || JSON_WRITE_TABLES[t])

  function listOf(reader) {
    try {
      const v = typeof reader === 'function' ? reader() : []
      return Array.isArray(v) ? v.map(String) : []
    } catch (_) { return [] }
  }
  function closedTables() { return listOf(readClosed) }
  // 执行端多处用 readonlyTables().includes(table) 做写前检查；把 closed 并进来，
  // 让「完全禁止」在这些调用点同样被拦（无需逐个改执行端）。
  function readonlyTables() {
    return [...new Set([...listOf(readReadonly), ...closedTables()])]
  }

  function isTableWritable(table) {
    const t = String(table)
    if (!canWrite(t)) return false
    return !readonlyTables().includes(t)
  }

  function readonlyError(table) {
    // 命中「完全禁止」表时用专门文案，避免误报成「只是只读」。
    if (closedTables().includes(String(table))) return { error: `${closedMsg}（${String(table)}）` }
    return { error: `${msg}（${String(table)}）` }
  }

  return { isTableWritable, readonlyError, readonlyTables, closedTables }
}

// 运行期单例：读当前账号库的 ai_settings.privacy_json（readonly_tables + closed_tables）。
const writeScope = makeWriteScope({
  readReadonly: () => aiConfigStore.readPrivacy().readonly_tables,
  readClosed: () => aiConfigStore.readPrivacy().closed_tables,
})
// MCP 侧独立的一份（ai_settings.mcp_privacy_json），与 mcpReadScope 同源。
// 执行确认时也要用它：老师在「MCP 数据权限」里设的只读/完全禁止，不能靠执行路径绕过去。
const mcpWriteScope = makeWriteScope({
  readReadonly: () => aiConfigStore.readMcpPrivacy().readonly_tables,
  readClosed: () => aiConfigStore.readMcpPrivacy().closed_tables,
  msg: MCP_READONLY_MSG,
  closedMsg: MCP_CLOSED_WRITE_MSG,
})

module.exports = { makeWriteScope, writeScope, mcpWriteScope, READONLY_MSG, MCP_READONLY_MSG }
