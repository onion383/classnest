// =========================================================================
// error-leak.test.js —— 5xx 不回传内部细节（v8 审查 N3-09 · RC-ERROR-LEAK）
//
// 判据：全局 errorHandler 必须分层——4xx 保留业务文案，5xx 只回通用文案，
// 原始 message（SQL / 路径 / 模块名）只进本地日志；需要例外时显式 err.expose。
// 变异反证：改回 `error: err.message` 一行直出 → 本文件必须红。
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')


test('全局 errorHandler：5xx 脱敏，4xx 保留业务文案，支持 err.expose 例外', () => {
  const src = read('student-backend/app.js')
  const fn = src.slice(src.indexOf('app.use((err, req, res, next) =>'), src.indexOf('// 队列完成打点'))
  assert.match(fn, /const isClientError = status >= 400 && status < 500/)
  assert.match(fn, /isClientError \|\| \(err && err\.expose === true\)/)
  assert.match(fn, /'服务器内部错误，请查看日志后重试'/)
  assert.doesNotMatch(fn, /json\(\{ error: \(err && err\.message\) \|\| '服务器内部错误' \}\)/,
    '不能把原始 message 直接回给客户端')
  assert.match(fn, /console\.error\('\[express-error\]'/, '原始现场必须留在服务端日志')
})
