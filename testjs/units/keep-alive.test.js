// =========================================================================
// keep-alive.test.js —— 后端 keep-alive 显式配置（v6 性能专题 · 1-6）
//
// 验收点：
//   ① app.js 的 listen 之后显式设置 keepAliveTimeout / headersTimeout；
//   ② headersTimeout 必须**大于** keepAliveTimeout（否则 Node 先按请求头超时掐连接，
//      保活等于没生效）；
//   ③ 两个值都远大于 Node 默认 5s，才谈得上「少一次重连」。
// 这是接线判据：真实复用要靠 socket connect 计数，属于真机探针范畴，本层只锁配置。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const SRC = fs.readFileSync(path.join(ROOT, 'student-backend/app.js'), 'utf8')

test('listen 之后显式设置保活与请求头超时', () => {
  const keep = /server\.keepAliveTimeout = (\d+)_?(\d*)\s*;/.exec(SRC)
  const headers = /server\.headersTimeout = (\d+)_?(\d*)\s*;/.exec(SRC)
  assert.ok(keep, 'app.js 必须显式设置 server.keepAliveTimeout')
  assert.ok(headers, 'app.js 必须显式设置 server.headersTimeout')

  const num = (m) => Number(m[1] + (m[2] || ''))
  const keepMs = num(keep)
  const headersMs = num(headers)

  assert.ok(headersMs > keepMs, `headersTimeout(${headersMs}) 必须大于 keepAliveTimeout(${keepMs})`)
  assert.ok(keepMs > 5000, `keepAliveTimeout(${keepMs}) 应大于 Node 默认 5s，否则等于没改`)
})
