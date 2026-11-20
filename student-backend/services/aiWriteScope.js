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

function makeWriteScope({ readReadonly, supportsWrite, msg = READONLY_MSG } = {}) {
  const canWrite = typeof supportsWrite === 'function'
    ? supportsWrite
    : (t) => !!(WRITE_TABLES[t] || JSON_WRITE_TABLES[t])

  function readonlyTables() {
    try {
      const v = typeof readReadonly === 'function' ? readReadonly() : []
      return Array.isArray(v) ? v.map(String) : []
    } catch (_) { return [] }
  }

  function isTableWritable(table) {
    const t = String(table)
    if (!canWrite(t)) return false
    return !readonlyTables().includes(t)
  }

  function readonlyError(table) {
    return { error: `${msg}（${String(table)}）` }
  }

  return { isTableWritable, readonlyError, readonlyTables }
}

// 运行期单例：读当前账号库的 ai_settings.privacy_json.readonly_tables。
const writeScope = makeWriteScope({ readReadonly: () => aiConfigStore.readPrivacy().readonly_tables })
// MCP 侧独立的一份（ai_settings.mcp_privacy_json），与 mcpReadScope 同源。
// 执行确认时也要用它：老师在「MCP 数据权限」里设的只读，不能靠执行路径绕过去。
const mcpWriteScope = makeWriteScope({
  readReadonly: () => aiConfigStore.readMcpPrivacy().readonly_tables,
  msg: MCP_READONLY_MSG,
})

module.exports = { makeWriteScope, writeScope, mcpWriteScope, READONLY_MSG, MCP_READONLY_MSG }
