// =========================================================================
// api-proxy.test.js —— B1 的 /api 同源代理（纯逻辑）
//
// 验收点：
//   ① 只代 /api 与 /api/*，静态路径返回 null；
//   ② 目标 URL 保留 path + query，Host/Content-Length 等帧级头被去掉；
//   ③ 方法、请求体、响应体（含流）原样透传；
//   ④ 后端不可达回 503，交给前端既有重试链路。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { isApiPath, targetUrlFor, createApiProxy, nodeFetch, BACKEND_ORIGIN } = require('../../electron/main/main.api-proxy.js')

test('只代 /api 与 /api/*，静态资源不代理', () => {
  assert.equal(isApiPath('/api'), true)
  assert.equal(isApiPath('/api/dashboard'), true)
  assert.equal(isApiPath('/api/secure/handshake'), true)
  assert.equal(isApiPath('/apix'), false)
  assert.equal(isApiPath('/assets/main.js'), false)
  assert.equal(isApiPath('/uploads/a.jpg'), false)
})

test('目标 URL 保留 path 与 query，并指向回环后端', () => {
  assert.equal(targetUrlFor('app://local/api/dashboard'), BACKEND_ORIGIN + '/api/dashboard')
  assert.equal(targetUrlFor('app://local/api/students?x=1&y=2'), BACKEND_ORIGIN + '/api/students?x=1&y=2')
})

test('静态路径返回 null，不触碰 fetch', async () => {
  let called = 0
  const proxy = createApiProxy({ fetchImpl: async () => { called++; return new Response('x') } })
  const res = await proxy(new Request('app://local/assets/main.js'))
  assert.equal(res, null)
  assert.equal(called, 0)
})

test('API：方法/请求体/响应原样透传，帧级头被清理', async () => {
  let seen = null
  const proxy = createApiProxy({
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return new Response(new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode('{"ok":true}')); c.close() },
      }), { status: 200, headers: { 'content-type': 'application/json', 'x-renewed-token': 't2' } })
    },
  })
  const req = new Request('app://local/api/students/3?x=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'app://local', 'content-length': '99', 'x-auth-proof': 'proof' },
    body: '{"a":1}',
  })
  const res = await proxy(req)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-renewed-token'), 't2')
  assert.equal(await res.text(), '{"ok":true}')

  assert.equal(seen.url, BACKEND_ORIGIN + '/api/students/3?x=1')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.headers.get('x-auth-proof'), 'proof')
  assert.equal(seen.init.headers.get('host'), null)
  assert.equal(seen.init.headers.get('content-length'), null)
  assert.ok(seen.init.body, 'body 必须原样交给后端')
  assert.equal(seen.init.duplex, 'half')
})

test('后端不可达：回 503 JSON，前端可走既有重试链路', async () => {
  const proxy = createApiProxy({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  const res = await proxy(new Request('app://local/api/dashboard'))
  assert.equal(res.status, 503)
  assert.match(await res.text(), /后端暂不可用/)
})

test('2-16 归因打点：代理入口/返回必须带 epoch（仅 PERF_STARTUP=1）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../electron/main/main.api-proxy.js'), 'utf8')
  assert.match(src, /PERF_STARTUP === '1'/)
  assert.match(src, /proxy 进入/)
  assert.match(src, /proxy 返回/)
})

test('nodeFetch 对照实现：方法/query/请求体/响应头与流式 body 都能透传', async () => {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-echo', req.headers['x-echo'] || '')
      res.end(JSON.stringify({ method: req.method, url: req.url, body, proof: req.headers['x-auth-proof'] || '' }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('hello-body')); c.close() },
    })
    const res = await nodeFetch(`http://127.0.0.1:${port}/api/echo?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-auth-proof': 'p1', 'x-echo': 'e1' },
      body: stream,
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-echo'), 'e1')
    const data = JSON.parse(await res.text())
    assert.equal(data.method, 'POST')
    assert.equal(data.url, '/api/echo?x=1')
    assert.equal(data.body, 'hello-body')
    assert.equal(data.proof, 'p1')
  } finally {
    await new Promise((r) => server.close(r))
  }
})
