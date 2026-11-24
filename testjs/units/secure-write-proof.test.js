// =========================================================================
// secure-write-proof.test.js —— 安全信道写请求强制一次性凭据（1-10 / #2）
//
// 原缺陷：requestAuthProof 在缺 X-Auth-Proof 时无条件 next()。攻击者抓到一份
// 有效加密写报文后，去掉凭据头原样重放 —— nonce 校验只在有 proof 时跑，
// 缺凭据完全绕过。认证中间件随后接受 req.sessionId → 重复写入。
// 修法：安全信道里的写请求（有 sessionId）缺 proof 一律 401；读请求与明文
// 请求（登录/注册，无 sessionId）维持兼容。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const sc = require(path.join(ROOT, 'student-backend/services/secureChannel.js'))
const MASTER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
sc.initMaster(MASTER)

function fakeRes() {
  const calls = { status: [], json: [], headers: [] }
  const res = {
    status(s) { calls.status.push(s); return res },
    set(k, v) { calls.headers.push([k, v]); return res },
    json(d) { calls.json.push(d); return res },
  }
  return { res, calls }
}
function reqOf(method, sessionId, proof) {
  return { method, sessionId, headers: proof ? { 'x-auth-proof': proof } : {} }
}

// ————————————————————————— ① 行为层 —————————————————————————

test('缺 proof 的安全信道写请求被拒（重放绕过的口子）', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const { res, calls } = fakeRes()
    let nextCalled = false
    sc.requestAuthProof(reqOf(method, 'sid-replay'), res, () => { nextCalled = true })
    assert.equal(nextCalled, false, `${method} 缺 proof 不该放行`)
    assert.equal(calls.status[0], 401)
    assert.ok(calls.headers.some(([k, v]) => k === 'X-Auth-Required' && v === '1'))
  }
})

test('缺 proof 的读请求仍放行（兼容既有行为）', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const { res } = fakeRes()
    let nextCalled = false
    sc.requestAuthProof(reqOf(method, 'sid-read'), res, () => { nextCalled = true })
    assert.equal(nextCalled, true, `${method} 是读请求，不该被挡`)
  }
})

test('缺 proof 的明文写请求（无 sessionId = 登录/注册）仍放行', () => {
  const { res } = fakeRes()
  let nextCalled = false
  sc.requestAuthProof(reqOf('POST', undefined), res, () => { nextCalled = true })
  assert.equal(nextCalled, true, '登录/注册未建立信道会话，没 proof 也不该被挡')
})

test('有 proof 的合法请求仍走 nonce 校验：伪造会话被拒、重放被拒', () => {
  // 用一个不存在的 session → 凭据解密失败，返回 session-expired（证明有 proof 时进入正常校验）
  const { res, calls } = fakeRes()
  let nextCalled = false
  sc.requestAuthProof(reqOf('POST', undefined, 'bogus.session.proof.here'), res, () => { nextCalled = true })
  assert.equal(nextCalled, false)
  assert.equal(calls.status[0], 401)
})

// ————————————————————————— ② 接线 + 变异反证 —————————————————————————

function proofSrc() {
  return fs.readFileSync(path.join(ROOT, 'student-backend/services/secureChannel.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// 判据抽成函数，正例与变异反证共用（T07-02）
function wiringGuard(src) {
  const fn = src.slice(src.indexOf('function requestAuthProof'), src.indexOf('function cleanupSessions'))
  const noProof = fn.slice(fn.indexOf('if (!raw)'), fn.indexOf('const parts'))
  const checks = {
    writeMethod: /POST|PUT|PATCH|DELETE/.test(noProof),
    sessionId: /req\.sessionId/.test(noProof),
    nonceHas: /usedNonces\.has\(n\)/.test(fn),
    nonceSet: /usedNonces\.set\(n/.test(fn),
    hasBranch: noProof.length > 0 && fn.length > 0,
  }
  return { ok: Object.values(checks).every(Boolean), checks }
}

test('接线：缺 proof 分支按写方法 + sessionId 判定，nonce 去重仍在有 proof 路径', () => {
  const r = wiringGuard(proofSrc())
  assert.ok(r.ok, `接线判据未通过：${JSON.stringify(r.checks)}`)
})

test('变异反证：把缺 proof 分支改回无条件放行后，行为判据必须失败', () => {
  const src = proofSrc()
  assert.equal(wiringGuard(src).ok, true, '基线必须通过，否则反证无意义')
  const fn = src.slice(src.indexOf('function requestAuthProof'), src.indexOf('function cleanupSessions'))
  const mutatedFn = fn.replace(/if \(req\.sessionId && writeMethod\) return fail\([^;]*;/, '/*MUTATED*/')
  assert.ok(mutatedFn !== fn, '变异没匹配到强制判定')
  const mutatedSrc = src.replace(fn, mutatedFn)
  assert.equal(wiringGuard(mutatedSrc).ok, false, '判据假绿：缺 proof 无条件放行仍判 PASS')
})
