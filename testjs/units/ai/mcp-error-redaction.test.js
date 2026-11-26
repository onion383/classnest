// =========================================================================
// mcp-error-redaction.test.js —— MCP 外部错误文案统一脱敏（V9-K02-01 / 4-3）
//
// 以前 publicToolError 只写在 mcp.server.js 里，stdio 转发器各回 e.message，
// 两处正则会漂移。现抽到 utils/publicToolError 单一来源；本文件锁：
//   ① 函数行为：SQL / 路径 / SQLITE_ 都脱敏，业务文案保留；
//   ② 接线：server 与 forwarder 两个调用点都走它，没有裸 e.message 回包。
// =========================================================================
const test = require('node:test')
const { read, abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const { publicToolError } = require(abs('student-backend/utils/publicToolError'))

const GENERIC = '工具执行失败（内部错误，详情见应用日志）'

test('行为：SQL / 路径 / SQLITE_ 都脱敏成通用文案', () => {
  for (const bad of [
    'SELECT * FROM students WHERE id=1',
    'SQLITE_CONSTRAINT: UNIQUE constraint failed',
    'ENOENT: no such file C:\\data\\db.sqlite',
    'Error at Object.<anonymous> (/app/routes/x.js:12:3)',
  ]) {
    assert.equal(publicToolError(bad), GENERIC, `内部细节不该外泄：${bad}`)
  }
})

test('行为：业务文案原样保留，空值兜底', () => {
  assert.equal(publicToolError('班级名不能为空'), '班级名不能为空')
  assert.equal(publicToolError(''), '工具执行失败')
  assert.equal(publicToolError(null), '工具执行失败')
})

test('接线：server 与 forwarder 都走共享脱敏，没有裸 e.message 回包', () => {
  const server = read('student-backend/routes/ai/mcp/mcp.server.js')
  const fwd = read('student-backend/mcp-forwarder.cjs')
  assert.match(server, /publicToolError\(e && e\.message\)/, 'server 回包必须脱敏')
  assert.match(fwd, /publicToolError\(e && e\.message\)/, 'stdio 转发器回包必须脱敏')
  assert.doesNotMatch(fwd, /error:\s*e\.message/, '不许有裸 e.message 回包')
})
