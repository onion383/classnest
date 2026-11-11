// =========================================================================
// secure-retry.test.js —— N1-02：安全信道 401 重试的分支判定
//
// 背景：原来三个 401 分支（凭据降级 / auth-required / session-expired）的条件
// 散在 secureAxios 拦截器里，唯一覆盖它们的是需要 Vite + Electron 的冒烟脚本，
// CI 直接跳过 → 安全信道重试链路在 CI 中零覆盖。
//
// 修法：判定抽到 composables/secureRetry.js（纯函数），这里直接跑真实源码，
// 覆盖「走哪个分支」与「优先级」；副作用（清会话/重发）仍留在 secureAxios。
// =========================================================================

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..', '..')
const RETRY_SRC = path.join(ROOT, 'student-frontend/src/composables/secureRetry.js')
const AXIOS_SRC = path.join(ROOT, 'student-frontend/src/composables/secureAxios.js')

let seq = 0
function loadRetry() {
  seq += 1
  return import(pathToFileURL(RETRY_SRC).href + '?case=' + seq)
}

test('凭据降级 401：未重试过 → degraded', async () => {
  const { decideSecureRetry } = await loadRetry()
  assert.equal(decideSecureRetry({
    status: 401,
    data: { d: 'session-expired' },
    config: { __credentialDegraded: true },
  }), 'degraded', '降级优先级最高：不能先判 session 或 auth')
})

test('凭据降级已重试过：回落到 session-expired', async () => {
  const { decideSecureRetry } = await loadRetry()
  assert.equal(decideSecureRetry({
    status: 401,
    data: { d: 'session-expired' },
    config: { __credentialDegraded: true, __retryDegraded: true },
  }), 'session', '降级标记用过之后，会话过期分支仍要能接管')
})

test('auth-required 401：未重试过 → auth', async () => {
  const { decideSecureRetry } = await loadRetry()
  assert.equal(decideSecureRetry({
    status: 401,
    headers: { 'x-auth-required': '1' },
    config: {},
  }), 'auth')
})

test('session-expired 401：未重试过 → session', async () => {
  const { decideSecureRetry } = await loadRetry()
  assert.equal(decideSecureRetry({
    status: 401,
    data: { d: 'session-expired' },
    config: {},
  }), 'session', 'GET 也必须重试（旧实现只对带 body 的请求重试）')
})

test('已重试过 / 非 401 / 普通 401 → 不重试', async () => {
  const { decideSecureRetry } = await loadRetry()
  assert.equal(decideSecureRetry({
    status: 401,
    data: { d: 'session-expired' },
    config: { __retrySession: true },
  }), null)
  assert.equal(decideSecureRetry({
    status: 401,
    headers: { 'x-auth-required': '1' },
    config: { __retryAuth: true },
  }), null)
  assert.equal(decideSecureRetry({ status: 200, config: {} }), null)
  assert.equal(decideSecureRetry({ status: 401, data: { error: '普通业务错误' }, config: {} }), null)
})

test('优先级：降级 > auth-required > 会话过期', async () => {
  const { decideSecureRetry } = await loadRetry()
  // 三个条件同时成立：必须先走降级，否则 auth 分支会 resetAuthBinding 误清 token
  assert.equal(decideSecureRetry({
    status: 401,
    headers: { 'x-auth-required': '1' },
    data: { d: 'session-expired' },
    config: { __credentialDegraded: true },
  }), 'degraded')

  // 没有降级时：auth-required 先于 session-expired（与拦截器原顺序一致）
  assert.equal(decideSecureRetry({
    status: 401,
    headers: { 'x-auth-required': '1' },
    data: { d: 'session-expired' },
    config: {},
  }), 'auth')
})

test('[静态] secureAxios 走统一判定，不再内联三个分支条件', () => {
  const src = fs.readFileSync(AXIOS_SRC, 'utf8')
  assert.match(src, /import \{ decideSecureRetry \} from '\.\/secureRetry\.js'/)
  assert.match(src, /if \(retry === 'degraded'\)/)
  assert.match(src, /if \(retry === 'auth'\)/)
  assert.match(src, /if \(retry === 'session'\)/)
  assert.ok(
    !src.includes('if (err.response && err.response.status === 401 && cfg && cfg.__credentialDegraded'),
    '拦截器里不该再保留内联的降级判定',
  )
})
