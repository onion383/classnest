// =========================================================================
// secure-bridge.test.js —— 安全通道握手报文桥（v6 性能专题 · 2-19）
//
// 验收点：
//   ① 只转发：请求体只有 { pub }，URL 固定指向后端的 /api/secure/handshake；
//   ② 公钥形状非法时直接拒绝，不发出任何请求；
//   ③ 后端非 2xx / 响应缺字段都必须报错，不能带着半个会话往下走；
//   ④ 接线：通道已登记并授权给「装了 apiClient 的 5 个窗口」，
//      渲染层走 IPC、且保留纯浏览器下的 fetch 兜底。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const { createHandshakeBridge } = require(path.join(ROOT, 'electron/main/main.secure-bridge.js'))

// 65 字节原始公钥的 base64（形状与实际一致，内容不重要）
const PUB = Buffer.alloc(65, 7).toString('base64')
const PEER = { pub: Buffer.alloc(65, 9).toString('base64'), sessionId: 'sid-1' }

test('只转发公钥：请求体只有 pub，URL 指向后端握手端点', async () => {
  let seen = null
  const bridge = createHandshakeBridge({
    backendOrigin: 'http://127.0.0.1:3000',
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return new Response(JSON.stringify(PEER), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const out = await bridge(PUB)
  assert.deepEqual(out, PEER, '返回形状必须只有 pub / sessionId')
  assert.equal(seen.url, 'http://127.0.0.1:3000/api/secure/handshake')
  assert.equal(seen.init.method, 'POST')
  assert.deepEqual(JSON.parse(seen.init.body), { pub: PUB }, '请求体不得夹带私钥或其它字段')
  assert.equal(seen.init.headers['content-type'], 'application/json')
  assert.equal(seen.init.headers['content-length'], String(Buffer.byteLength(seen.init.body)))
})

test('公钥形状非法：不发出任何请求', async () => {
  let called = 0
  const bridge = createHandshakeBridge({
    fetchImpl: async () => { called++; return new Response('{}') },
  })
  for (const bad of [null, undefined, '', 'short', 123, 'not base64!!!']) {
    await assert.rejects(() => bridge(bad), /invalid public key/, `应拒绝 ${JSON.stringify(bad)}`)
  }
  assert.equal(called, 0)
})

test('后端异常：非 2xx 与响应缺字段都要报错', async () => {
  const badStatus = createHandshakeBridge({
    fetchImpl: async () => new Response('{"error":"x"}', { status: 503 }),
  })
  await assert.rejects(() => badStatus(PUB), /handshake failed 503/)

  const missing = createHandshakeBridge({
    fetchImpl: async () => new Response(JSON.stringify({ pub: PEER.pub }), { status: 200 }),
  })
  await assert.rejects(() => missing(PUB), /bad handshake response/, '缺 sessionId 不能当成功')

  const notJson = createHandshakeBridge({
    fetchImpl: async () => new Response('oops', { status: 200 }),
  })
  await assert.rejects(() => notJson(PUB), /bad handshake response/)
})

test('接线：通道已登记、授权与 get-master-key 一致、渲染层走 IPC 且保留 fetch 兜底', () => {
  const channels = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron/ipc-channels.json'), 'utf8'))
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron/ipc-policy.json'), 'utf8'))
  assert.ok(channels.invoke.includes('secure-handshake'), 'ipc-channels.json 必须登记该通道')

  const sorted = (a) => [...(a || [])].sort().join(',')
  assert.equal(sorted(policy['secure-handshake']), sorted(policy['get-master-key']),
    '凡是装了 apiClient 的窗口都要能握手，授权范围必须与 get-master-key 一致')
  for (const role of ['main', 'widget', 'desktop-widget', 'setup', 'migration']) {
    assert.ok(policy['secure-handshake'].includes(role), `${role} 缺授权会导致该窗口首屏 401`)
  }

  const renderer = fs.readFileSync(path.join(ROOT, 'student-frontend/src/composables/secureChannel.js'), 'utf8')
  assert.match(renderer, /INVOKE\.SECURE_HANDSHAKE/, '渲染层必须走 IPC 桥')
  assert.match(renderer, /await fetch\(BASE\(\) \+ '\/api\/secure\/handshake'/, '纯浏览器下要保留 fetch 兜底')
  assert.doesNotMatch(renderer, /subtle\.exportKey\('raw', kp\.privateKey\)/, '私钥绝不能被导出')

  const main = fs.readFileSync(path.join(ROOT, 'electron/main/main.js'), 'utf8')
  assert.match(main, /registerSecureBridgeIpc\(\)/, '主进程必须注册该通道')
})
