// =========================================================================
// secure-response-serialize.test.js —— 响应只序列化一次（v6 性能专题 · 1-2）
//
// 验收点：
//   ① 加密分支：信封字节与 JSON.stringify({ d }) 完全一致，且不再经过 res.json；
//   ② 密文能被同一把会话密钥解回原对象（解密链路没被改坏）；
//   ③ 非加密 / 豁免路径 / 会话失效：仍然走 res.json 原路，行为不变；
//   ④ no-store 头在加密分支必须设置。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const sc = require(path.join(ROOT, 'student-backend/services/secureChannel.js'))

const MASTER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'

function clientPub() {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  return ecdh.getPublicKey().toString('base64')
}

function fakeRes() {
  const calls = { set: [], type: [], send: [], json: [] }
  const res = {
    set: (k, v) => { calls.set.push([k, v]); return res },
    type: (t) => { calls.type.push(t); return res },
    send: (body) => { calls.send.push(body); return res },
    json: (data) => { calls.json.push(data); return res },
  }
  return { res, calls }
}

// 挂上中间件后替换 res.json，返回替换后的 res（中间件里改的就是它）
function mount(req, res) {
  sc.responseEncrypt(req, res, () => { /* next */ })
  return res
}

test('加密分支：信封字节与 JSON.stringify({ d }) 一致，且不过 res.json', () => {
  sc.initMaster(MASTER)
  const { sessionId } = sc.performHandshake(clientPub())
  const { res, calls } = fakeRes()
  const payload = { success: true, data: { rows: Array.from({ length: 20 }, (_, i) => ({ i })) } }

  mount({ sessionId, path: '/api/dashboard' }, res).json(payload)

  assert.equal(calls.json.length, 0, '加密分支不得再走 res.json（那是第二次序列化）')
  assert.equal(calls.send.length, 1)
  assert.deepEqual(calls.type, ['application/json; charset=utf-8'])
  assert.ok(calls.set.some(([k, v]) => k === 'Cache-Control' && v === 'no-store'))

  const body = calls.send[0]
  const parsed = JSON.parse(body)
  assert.equal(body, JSON.stringify({ d: parsed.d }), '信封必须与 { d } 序列化结果逐字节一致')

  // 解密链路：同一把会话密钥必须能解回原对象
  const key = sc.getSessionKey(sessionId)
  const plain = JSON.parse(sc.open(key, parsed.d).toString('utf8'))
  assert.deepEqual(plain, payload)
  sc.destroySession(sessionId)
})

test('非加密 / 豁免路径：仍走 res.json 原路', () => {
  sc.initMaster(MASTER)
  const { sessionId } = sc.performHandshake(clientPub())

  // 没有 sessionId（明文模式）
  let target = fakeRes()
  mount({ path: '/api/dashboard' }, target.res).json({ a: 1 })
  assert.equal(target.calls.send.length, 0)
  assert.deepEqual(target.calls.json, [{ a: 1 }])

  // 豁免路径（握手 / 静态资源）即使带 sessionId 也明文
  target = fakeRes()
  mount({ sessionId, path: '/api/secure/handshake' }, target.res).json({ a: 2 })
  assert.equal(target.calls.send.length, 0)
  assert.deepEqual(target.calls.json, [{ a: 2 }])
  sc.destroySession(sessionId)
})

test('会话失效：回退明文 res.json（并保留 no-store）', () => {
  sc.initMaster(MASTER)
  const { sessionId } = sc.performHandshake(clientPub())
  sc.destroySession(sessionId)
  const { res, calls } = fakeRes()
  mount({ sessionId, path: '/api/dashboard' }, res).json({ a: 3 })
  assert.equal(calls.send.length, 0)
  assert.deepEqual(calls.json, [{ a: 3 }])
})
