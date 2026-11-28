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

test('V10-SE-03/05：AI 连接测试与批量撤销的工具返回值也走脱敏', () => {
  const cfg = read('student-backend/routes/ai/ai.config.js')
  const undo = read('student-backend/routes/undo/undo.records.js')
  assert.match(cfg, /require\(['"]\.\.\/\.\.\/utils\/publicToolError['"]\)/, 'ai.config 未引入脱敏工具')
  assert.ok((cfg.match(/publicToolError\(/g) || []).length >= 3, '连接失败/上游报文/接口报错三处都要脱敏')
  assert.match(undo, /error: publicToolError\(err\.message\)/, '批量撤销失败返回值必须脱敏')
})

test('V10-K02-01~05：SSE / MCP tokens / AI 写入 / 快照的错误链都脱敏', () => {
  for (const [rel, need] of [
    ['student-backend/routes/ai/ai.conversations.js', /publicToolError\(raw\)/],
    ['student-backend/routes/ai/mcp/mcp.routes.js', /publicToolError\(e && e\.message\)/],
    ['student-backend/routes/ai/ai.dataRoutes.js', /publicToolError\(e && e\.message\)/],
    ['student-backend/routes/ai/ai.tools/tools.executors/executors.snapshot.js', /publicToolError\(`创建快照失败/],
  ]) {
    const src = read(rel)
    // @pin student-backend/utils/publicToolError.js#publicToolError
    assert.match(src, need, `${rel} 未接脱敏`)
  }
  // SSE 必须按业务/原生分流：业务错误（expose）保留，其余脱敏
  const conv = read('student-backend/routes/ai/ai.conversations.js')
  // @pin student-backend/routes/ai/ai.conversations.js#publicToolError
  assert.match(conv, /err && err\.expose \? raw : publicToolError\(raw\)/, 'SSE 分流缺失')
  // @pin student-backend/routes/ai/ai.conversations.js#publicToolError
  assert.doesNotMatch(conv, /type: 'err', message: err\.message/, 'SSE 不能再直出原生异常')

  // 删照片两处 500 走 sendError 固定文案
  const album = read('student-backend/routes/album.js')
  assert.equal((album.match(/sendError\(res, Object\.assign\(err, \{ expose: true/g) || []).length, 2,
    '删照片两处 500 必须固定文案')
  assert.doesNotMatch(album, /移入回收站失败：' \+ err\.message|删除照片失败（已回退文件）：' \+ err\.message/)
})
