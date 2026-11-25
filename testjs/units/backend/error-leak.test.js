// =========================================================================
// error-leak.test.js —— 5xx 不回传内部细节（v8 审查 N3-09 · RC-ERROR-LEAK）
//
// 判据：全局 errorHandler 必须分层——4xx 保留业务文案，5xx 只回通用文案，
// 原始 message（SQL / 路径 / 模块名）只进本地日志；需要例外时显式 err.expose。
// N1-31：从读 app.js 内联源码正则改为真跑 services/errorResponse.js 的函数，
//   并断言 app.js 确实装的是这个函数（避免测试过了但生产没接）。
// 变异反证：把函数改回 `error: err.message` 一行直出 → 行为用例必须红。
// =========================================================================
const test = require('node:test')
const { abs, read } = require('#testjs/paths')
const assert = require('node:assert/strict')

const { errorResponse } = require(abs('student-backend/services/errorResponse.js'))

function run(err, opts = {}) {
  const calls = []
  const res = {
    headersSent: !!opts.headersSent,
    status(code) { calls.push(['status', code]); return this },
    json(body) { calls.push(['json', body]); return this },
  }
  let nextErr
  const orig = console.error
  const logs = []
  console.error = (...args) => logs.push(args)
  try { errorResponse(err, { method: 'GET', originalUrl: '/api/x' }, res, (e) => { nextErr = e }) }
  finally { console.error = orig }
  return { calls, logs, nextErr }
}

test('行为：4xx 保留业务 message，5xx 只回通用文案，err.expose 显式例外', () => {
  const badRequest = run(Object.assign(new Error('班级库不存在'), { status: 404 }))
  assert.deepEqual(badRequest.calls, [['status', 404], ['json', { error: '班级库不存在' }]],
    '4xx 必须原样返回业务可读文案')

  // 原始 SQL / 路径细节不能出现在 5xx 响应体里
  const internal = run(new Error('SELECT * FROM users WHERE pwd = "secret"'))
  assert.deepEqual(internal.calls,
    [['status', 500], ['json', { error: '服务器内部错误，请查看日志后重试' }]],
    '5xx 不能把原始 message 回给客户端')
  assert.ok(internal.logs.some(args => args[0] === '[express-error]' && String(args[args.length - 1]).includes('secret')),
    '原始现场必须留在服务端日志')

  const exposed = run(Object.assign(new Error('可读原因'), { expose: true }))
  assert.deepEqual(exposed.calls, [['status', 500], ['json', { error: '可读原因' }]],
    '显式 expose 的 5xx 才回原始原因')
})

test('行为：响应头已发出时交回 Express，不再硬写状态码', () => {
  const r = run(new Error('boom'), { headersSent: true })
  assert.deepEqual(r.calls, [], 'headersSent 后不能改状态码')
  assert.equal(r.nextErr.message, 'boom', '原始错误交回 next')
})

test('接线：app.js 装的是 errorResponse，不是内联副本', () => {
  const src = read('student-backend/app.js')
  assert.match(src, /require\(['"]\.\/services\/errorResponse['"]\)/, // @pin student-backend/services/errorResponse.js#errorResponse
    'app.js 必须 require errorResponse 服务')
  assert.match(src, /app\.use\(errorResponse\)/, // @pin student-backend/services/errorResponse.js#errorResponse
    '全局错误处理必须挂抽出的函数')
})
