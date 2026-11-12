// =========================================================================
// main.api-proxy.js —— B1：app://local/api/* → 127.0.0.1:3000 的同源代理
//
// 为什么需要：页面保持 app://local（origin 隔离不变、登录态不迁移），但 API 走
// app://local/api/* 后浏览器视为同源，不再发 CORS 预检，省掉实测 100ms+ 的
// 「OPTIONS 完成 → 真实 GET」空档。
//
// 只代理 /api（含 /api/secure/handshake、SSE、multipart）；/uploads 等媒体仍走
// 后端绝对地址，保持 Cookie/媒体凭据语义，也避免代理 Range 大文件。
// 纯逻辑与 fetch 注入分离，便于单测。
// =========================================================================

const http = require('node:http')
const { Readable } = require('node:stream')

const BACKEND_ORIGIN = 'http://127.0.0.1:3000'
// 连接复用：启动首批请求仍要建连，但后续请求可复用；对照实验也用它排除「每请求重连」。
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 })

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/')
}

function targetUrlFor(reqUrl) {
  const u = new URL(reqUrl)
  return BACKEND_ORIGIN + u.pathname + u.search
}

// Node 原生 http 版 fetch：绕过 Chromium 网络服务/系统代理解析，用于 2-16 对照。
// 返回标准 Response，body 用 Node → Web ReadableStream 桥接（SSE 也能流式透传）。
function nodeFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (err) { reject(err); return }
    const headers = {}
    if (init.headers) {
      const h = new Headers(init.headers)
      for (const [k, v] of h.entries()) headers[k] = v
    }
    // 2-17 归因：分段「建连请求发出 → socket connect → 后端首字节」。
    // 目的：区分 132ms 空档到底在①主进程事件循环（调用前后相隔久）、
    // ②OS/本地回环建连（connect 晚）、还是③后端 accept/处理（connect 早、首字节晚）。
    const tag = u.pathname;
    perfLog(`[perf] 代理建连 ${tag} ${Date.now()}`);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: init.method || 'GET',
      headers,
      agent,
    }, (res) => {
      perfLog(`[perf] 代理首字节 ${tag} ${Date.now()}`);
      const status = res.statusCode || 502
      // 204/304/HEAD 不能带 body，否则 Response 构造会抛错
      const noBody = status === 204 || status === 304 || (init.method || 'GET') === 'HEAD'
      const body = noBody ? null : Readable.toWeb(res)
      try {
        resolve(new Response(body, { status, headers: res.headers }))
      } catch (err) {
        reject(err)
      }
    })
    // socket 复用（keepAlive 命中）与新建连接分开记：复用时 connect 不会触发，
    // 若日志从「建连」直接跳到「首字节」，说明这段耗时在请求写出/后端处理上。
    req.on('socket', (s) => {
      if (!s.connecting) {
        perfLog(`[perf] 代理 socket 复用 ${tag} ${Date.now()}`);
        return;
      }
      s.once('connect', () => perfLog(`[perf] 代理 socket connect ${tag} ${Date.now()}`));
    })
    req.on('error', reject)
    req.setTimeout(120000, () => req.destroy(new Error('proxy timeout')))
    if (init.body) {
      // 协议层的 Request.body 是 Web ReadableStream，转回 Node 流后直接 pipe（不整份缓冲）；
      // 字符串 / Buffer（如握手报文这类小 JSON）直接 end。
      if (typeof init.body === 'string' || Buffer.isBuffer(init.body)) {
        req.end(init.body)
      } else {
        try {
          Readable.fromWeb(init.body).pipe(req)
        } catch (err) {
          reject(err)
        }
      }
    } else {
      req.end()
    }
  })
}

function perfOn() {
  return process.env.PERF_STARTUP === '1'
}
function perfLog(line) {
  if (!perfOn()) return
  try { console.log(line) } catch (_) { /* 打点失败静默 */ }
}

// 代理请求；非 /api 返回 null，交给静态文件处理。
// fetchImpl 由调用方注入（生产传 Electron net.fetch），单测可替换。
function createApiProxy({ fetchImpl, backendOrigin = BACKEND_ORIGIN } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createApiProxy 需要 fetchImpl')
  return async function proxy(req) {
    let url
    try { url = new URL(req.url) } catch (_) { return null }
    if (!isApiPath(url.pathname)) return null

    const t0 = Date.now()
    perfLog(`[perf] proxy 进入 ${url.pathname} ${t0}`)

    const headers = new Headers(req.headers)
    // Host / 帧级头由 net.fetch 重新生成；带 body 流时 Content-Length 也必须去掉。
    for (const h of ['host', 'connection', 'content-length', 'transfer-encoding']) headers.delete(h)

    const init = { method: req.method, headers, redirect: 'manual' }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      init.body = req.body
      // Node/Electron fetch 对流式请求体要求 half duplex
      init.duplex = 'half'
    }

    try {
      const res = await fetchImpl(backendOrigin + url.pathname + url.search, init)
      perfLog(`[perf] proxy 返回 ${url.pathname} ${Date.now()}（${Date.now() - t0}ms）`)
      return res
    } catch (err) {
      perfLog(`[perf] proxy 失败 ${url.pathname} ${Date.now()}（${Date.now() - t0}ms）`)
      // 后端未就绪：回 503，前端既有「不可达 → 等 backend-ready → 重试」链路会接管
      return new Response(JSON.stringify({ error: `后端暂不可用：${err && err.message || 'fetch failed'}` }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
  }
}

module.exports = { BACKEND_ORIGIN, isApiPath, targetUrlFor, createApiProxy, nodeFetch }
