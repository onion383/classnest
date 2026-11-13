// =========================================================================
// main.secure-bridge.js —— 安全通道握手报文桥（v6 性能专题 · 2-19）
//
// 只搬「握手报文」，不搬密钥：
//   渲染层生成 ephemeral P-256、**自留私钥**，把 public key（base64）经 IPC 交给本模块；
//   本模块用 Node http 直连 127.0.0.1:3000，换回后端的 public key + sessionId；
//   ECDH / HKDF / AES-256-GCM 仍然全部在渲染层的 WebCrypto 里完成。
//
// 为什么值得做：握手是应用启动后的第一条网络请求。走 app:// 时要经过
//   「协议派发 → 主进程代理 → 后端 → 原路返回渲染层」两次跨进程，
//   PERF_STARTUP 实测回程占 ~19ms、派发 ~3ms；改走 IPC 后这段直接消失。
//
// 为什么安全：过 IPC 的只有**公钥**与 sessionId —— 都是公开值。
//   临时私钥、ECDH 共享密、会话密钥一个都不离开渲染层，
//   所以这个改动不触碰「密钥归属」，比「把握手挪到主进程建会话」小一个数量级。
//
// 授权范围与 get-master-key 完全一致：凡是装了 apiClient、会建安全通道的窗口
// （main / widget / desktop-widget / setup / migration）都要用。
// =========================================================================

const { BACKEND_ORIGIN, nodeFetch } = require('./main.api-proxy')
const { CH, IPC } = require('./channels')

// P-256 未压缩公钥 raw 为 65 字节 → base64 88 字符。这里只校验形状，
// 不解析密钥：解析与派生是渲染层的事，主进程只负责转发。
const PUB_MIN_LEN = 40
const PUB_RE = /^[A-Za-z0-9+/]+={0,2}$/

// 纯逻辑：渲染层公钥 → 后端公钥 + sessionId。
// fetchImpl 注入（与 api-proxy 同款），让本模块在普通 node 下可直接单测。
function createHandshakeBridge({ fetchImpl = nodeFetch, backendOrigin = BACKEND_ORIGIN } = {}) {
  return async function handshake(pub) {
    if (typeof pub !== 'string' || pub.length < PUB_MIN_LEN || !PUB_RE.test(pub)) {
      throw new Error('invalid public key')
    }
    const body = JSON.stringify({ pub })
    const res = await fetchImpl(backendOrigin + '/api/secure/handshake', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    })
    if (!res || !res.ok) throw new Error('handshake failed ' + (res ? res.status : 'no response'))
    const peer = await res.json().catch(() => null)
    // 只认这两个字段：多传的东西一律丢弃，避免把后端内部结构透给渲染层
    if (!peer || typeof peer.pub !== 'string' || typeof peer.sessionId !== 'string') {
      throw new Error('bad handshake response')
    }
    return { pub: peer.pub, sessionId: peer.sessionId }
  }
}

// 注册 IPC。失败走 main.ipc-contract 的 fail()（不 reject）：
// 渲染层读 outcome 决定重试，与其它通道同一套判据。
function registerSecureBridgeIpc() {
  const { ok, fail } = require('./main.ipc-contract')
  const handshake = createHandshakeBridge()
  IPC.handle(CH.SECURE_HANDSHAKE, async (_event, pub) => {
    try {
      return ok(await handshake(pub))
    } catch (err) {
      return fail(err)
    }
  })
}

module.exports = { createHandshakeBridge, registerSecureBridgeIpc }
