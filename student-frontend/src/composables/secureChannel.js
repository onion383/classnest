// 安全通道前端模块（方案 A）：与后端 services/secureChannel.js 配对的加密层。
//
// 启用方式：前置端到后端都开开关才会真正加密。
//   后端：启动时设置环境变量 SECURE_REQUIRE=1（同时主进程必会注入 SECURE_MASTER）。
//   前端：构建时 VITE_SECURE=1（或运行时 window.__SECURE_CHANNEL__=true）。
// 两者都关闭/缺一时，本模块 safe() 返回 false，axios 拦截器保持「直通」，不影响现有功能。
//
// 协议（与后端一致）：
//   - 认证锚点 K_master：经 electron IPC get-master-key 获取（主密钥只参与 HKDF，不上线）。
//   - 前向保密：每次建立会话前端生成 ephemeral P-256，与后端 ECDH 派生共享密，再 HKDF 出会话密钥。
//   - 数据面：AES-256-GCM；请求体加密为 JSON { session, d: b64(iv).b64(tag).b64(ct) }；
//     响应体为 { d: 同格式加密串 }，由后端中间件包装。

import { INVOKE } from '../electronChannels.js'
import { registerUserScopedReset } from '../utils/userScopedCache.js'
import { waitForBackendReady } from '../utils/backendReady.js'
import { startCryptoStat } from '../utils/cryptoStat.js'
import { apiBaseUrl } from '../utils/backendOrigin.js'

const subtle = crypto.subtle
// 回环地址用 IPv4 字面量，别写 localhost：
// Windows 上 localhost 优先解析成 ::1（实测 dns.lookup 顺序 [::1, 127.0.0.1]），
// 而后端 app.listen(port, '127.0.0.1') 只绑 IPv4 —— 浏览器先连 ::1 被拒、再回退 IPv4，
// 首条请求凭空多出几百毫秒（实测直连 127.0.0.1 5ms / localhost 50ms，浏览器侧更慢）。
// 握手是启动期第一条网络请求，这笔代价全落在它头上（实测握手 353~535ms → 改后 59~72ms）。
// ⚠️ 回环地址散在 6 处，必须同改（同一语义只改一处会让 Cookie 域分裂）：
//   本文件 BASE / httpClient.backendBaseUrl / apiUrl.apiUrl / main.dialogs 背景图 URL /
//   main.js waitBackendReady / vite.config 的两处 proxy target。
//   CORS_ORIGIN_RE 与 Host 校验本来都允许 127.0.0.1，无需改后端。
// 握手地址与业务 API 共用同一口径：B1 下页面是 app://local，/api 由主进程协议代理，
// 始终使用相对路径，不再跨源。
function BASE() { return apiBaseUrl() }

let kMaster = null
let sessionKey = null
let sessionId = null
// 主密钥由 preload 在 document-start 就发起预取（见 electron/preload.js 的 __MASTER_KEY__），
// 握手时只是取回那个已完成的 promise：原本那次跨进程 IPC 往返（18~30ms）不再落在
// ensureSession 的「IPC」分段上。老版 preload / 预取失败时回退到 invoke，保证信道仍建得起来。
// master key 是应用级（非用户级）状态，登出不清，见文件末尾 registerUserScopedReset 的说明。
async function getMasterKey() {
  if (kMaster) return kMaster
  let raw = window.__MASTER_KEY__ ? await window.__MASTER_KEY__.get() : null
  if (!raw) raw = await window.electron.invoke(INVOKE.GET_MASTER_KEY)
  kMaster = raw && /^[0-9a-f]{64}$/.test(String(raw)) ? raw : null
  return kMaster
}

// 会话代次：登出/换号会 +1。在途的握手回来时若代次已变，说明这次握手属于旧用户，
// 不能再把会话写回（否则登出后又被“复活”）。
let sessionGen = 0
// 本会话是否已把登录身份绑定到后端：绑定后凭据里不再携带 token，
// 被动抓包只能拿到「不可复用」的一次性密文。
let authBound = false

export function safe() {
  if (window.__SECURE_CHANNEL__ === true) return true
  return import.meta.env && import.meta.env.VITE_SECURE === '1'
}

// --- 信道凭据（X-Auth-Proof）---
// 把 { token?, ts, n } 用会话密钥加密后放进请求头：被动抓包只看到密文，
// 且 ts+nonce 让密文无法重放。会话已绑定身份后不再携带 token（只发 ts/n）。
function randomNonce() {
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  return b64(b)
}

async function encryptAuthProof(token, perf) {
  const endProof = startCryptoStat(perf, '凭据加密')
  const { sessionId: sid, sessionKey: key } = await ensureSession()
  const payload = { ts: Date.now(), n: randomNonce() }
  if (token) payload.token = token
  const plain = utf8(JSON.stringify(payload))
  const iv = new Uint8Array(12); crypto.getRandomValues(iv)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
  endProof(plain.length)
  const tag = ct.subarray(ct.length - 16)
  const body = ct.subarray(0, ct.length - 16)
  return [sid, b64(iv), b64(tag), b64(body)].join('.')
}

// 会话身份绑定状态：首次带 token 的请求成功后置位；后端回 auth-required 时清除。
// （原先还导出了 isAuthBound()，全项目无人调用，已移除；状态本身仍由下面两个函数维护）
export function markAuthBound() { authBound = true }
export function resetAuthBinding() { authBound = false }

// 把登录凭据写进请求头，返回「本次是否携带了登录 token」：
//   安全模式 → X-Auth-Proof 密文凭据（已绑定且未强制时凭据内不含 token）
//   明文模式 → Authorization: Bearer（兼容未启用安全通道的环境）
// forceToken：绑定失效后重试时必须带 token 重新建立绑定。
export async function applyAuthHeader(headers, token, { forceToken = false, perf = null } = {}) {
  const h = headers || {}
  delete h.Authorization
  delete h['X-Auth-Proof']
  if (!token) return false
  if (safe()) {
    try {
      const withToken = forceToken || !authBound
      h['X-Auth-Proof'] = await encryptAuthProof(withToken ? token : '', perf)
      return withToken
    } catch (e) {
      // 握手异常时退化为明文头：后端会以 auth-required 拒绝并触发一次重建会话的重试。
      // 注意：安全模式下后端不收明文 Bearer（resolveAuth 只认信道凭据），这条降级路径
      // 必然 401——开发模式下在 console 里留痕，否则「拿不到 master key / 握手失败」
      // 在桌面组件窗口里完全静默（console 由 main.widget.js 收进 desktop-layer.log）。
      // 正式打包版不输出（import.meta.env.DEV 在构建期摇掉，不留运行时代码）。
      if (import.meta.env.DEV) {
        console.warn('[secure-channel] 信道凭据生成失败，降级明文 Bearer：', e?.message || e)
      }
      h.Authorization = `Bearer ${token}`
      return true
    }
  }
  h.Authorization = `Bearer ${token}`
  return true
}


function b64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}
function unb64(str) {
  const s = atob(str)
  const u = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
  return u
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
const utf8 = (s) => new TextEncoder().encode(s)

// 协商会话：若已有会话密钥则直接返回。
// 并发请求共用同一个握手 promise：否则首屏并发请求各自握手会互相覆盖会话，
// 导致「请求体用一个会话、凭据用另一个会话」的不一致。
let pendingSession = null
// 启动归因：首次握手耗时。
// 握手走的是一条**裸 fetch**（不经 axios、也不等后端就绪），而首屏第一个请求往往在后端
// listen 之前就发出 —— 于是它会撞「连接被拒」、降级成明文凭据、被后端以 401 拒掉，再走一轮
// 重建会话。这条打点用来确认「首屏那几百毫秒」是否花在这里。只记录首次。
let hsStartMarked = false
let hsEndMarked = false
// 握手 fetch 的「发出 / 到达」两戳只记首次（见 ensureSession 内的 2-18 归因说明）。
let hsFetchMarked = false
function hsMark(name) {
  try {
    console.log(`[startup] ${name} @${Math.round(performance.timeOrigin + performance.now())}`)
  } catch (_) { /* 打点失败绝不能影响握手 */ }
}

// --- 临时密钥对的预生成 ---
// 打包版实测：P-256 generateKey 要 22~37ms，原先它与 waitForBackendReady 一起排在
// 首屏请求发出之后才 Promise.all —— 但它和 token、网络、后端全都无关，没有理由压在
// 关键路径上。这里在页面加载的空窗（挂载前后）先备一把，握手时直接取；用掉后立刻
// 在后台补下一把，保证「每次握手各用一把独立的 ephemeral 密钥」这条前向保密语义不变。
// 任何失败都静默：槽位空着时 ensureSession 会自己现生成，行为与改前完全一致。
let keyPairSlot = null
let keyPairMarked = false

function startKeyPair() {
  const p = subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  // 失败时清空槽位，别让下一次复用一个已 reject 的 promise
  p.catch(() => { if (keyPairSlot === p) keyPairSlot = null })
  return p
}

// 取一把（可能已备好的）密钥对，并立即在后台补下一把给下次握手用
function takeKeyPair() {
  const p = keyPairSlot || startKeyPair()
  // 补的这把必须写回槽位：只发起不赋值的话，第二次握手（换号 / 重连）又会退回
  // 现生成 22~37ms，还白算一把没人用的密钥。startKeyPair 的失败清理也按槽位比对。
  keyPairSlot = startKeyPair()
  return p
}

// 入口在挂载前后调用一次即可；重复调用是幂等的（已有槽位就直接返回）。
export function prewarmKeyPair() {
  if (!safe() || !subtle) return null
  if (keyPairSlot) return keyPairSlot
  const t0 = performance.now()
  const p = startKeyPair()
  keyPairSlot = p
  if (!keyPairMarked) {
    keyPairMarked = true
    p.then(
      () => { try { console.log(`[startup] 密钥对预生成 ${Math.round(performance.now() - t0)}ms @${Math.round(performance.timeOrigin + performance.now())}`) } catch (_) { /* 打点失败忽略 */ } },
      () => { /* 生成失败：ensureSession 现生成兜底，这里不该有任何用户可见输出 */ },
    )
  }
  return p
}

async function ensureSession() {
  if (sessionKey) return { sessionId, sessionKey }
  if (pendingSession) return pendingSession
  const gen = sessionGen
  const _hsT0 = Date.now()
  // 握手分段：「353ms」这类总数只说明握手慢，不说明慢在哪一环。拆成 IPC / 密钥生成 /
  // fetch 往返 / 密钥派生四段，一次启动就能判定是 WebCrypto 慢还是 TCP 连接慢。
  let _segT = _hsT0
  const _seg = []
  const seg = (name) => {
    const now = Date.now()
    _seg.push(`${name} ${now - _segT}ms`)
    _segT = now
  }
  if (!hsStartMarked) { hsStartMarked = true; hsMark('握手开始') }
  pendingSession = (async () => {
    const master = await getMasterKey()
    seg('IPC')
    if (!master) throw new Error('secure channel: no master key')

    // 裸 fetch 绕开了 axios，也绕开了 axios 拦截器里的「等后端就绪」重试。启动期它常在
    // 后端 app.listen 之前发出 → 连接被拒 → Chromium 网络栈退避约 210ms（实测打包版
    // 275~299ms 慢簇，5/5 批）。这里补上对齐：已就绪时 Promise.resolve 零成本，未就绪
    // 则等 backend-ready 广播，BACKEND_STATUS 主动查询兜住「广播早于监听注册」的竞态；
    // 该查询返回的是主进程收到后端 listen 上报后才置位的标志，不会提前放行。
    // 超时只 resolve(false)、不抛错，这里刻意不判返回值：裸 fetch 照常发出，由既有
    // axios「不可达 → 等 backend-ready → 重试」链接管。多抛一种错只会让后端真挂时
    // 每轮重试都白等一遍超时（最多 6 轮）。1500ms 已覆盖实测后端就绪 341~595ms。
    //
    // 2-18：前端的 ephemeral 密钥生成与就绪等待**并行**。两者无数据依赖（generateKey
    // 跑在浏览器密码学线程，等待是纯等网络）。
    // 2026-11-14 再进一步：密钥对通常已由 prewarmKeyPair() 在挂载前后备好，这里只是取用，
    // 该段退化为 max(等待, ~0) —— 打包版实测 keygen 段由 22~37ms 降到 0~3ms。
    // 分段名仍叫 keygen，口径是「就绪 + 取/生成密钥」的合并段。
    // 2-18 归因修正：这一段历史名字叫 keygen（22~37ms），很容易被读成「密钥算力」。
    // 实际上是「等后端就绪信号 + 取预生成密钥」的合并段 —— 密钥是 ECDH P-256，
    // prewarm 已备好时接近 0；真正耗时的通常是 waitForBackendReady 那个信号。
    // 拆成 (ready / key) 两个子值，一次启动就能判断该改哪一头。
    let _readyMs = -1
    let _keyMs = -1
    const _pigT0 = Date.now()
    const [, kp] = await Promise.all([
      waitForBackendReady(1500).then((v) => { _readyMs = Date.now() - _pigT0; return v }),
      takeKeyPair().then((k) => { _keyMs = Date.now() - _pigT0; return k }),
    ])
    const pub = b64(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)))
    seg(`keygen(ready ${_readyMs} / key ${_keyMs})`)

    // 裸握手（握手不能加密，不触发 axios 拦截器）
    // 2-18 归因：握手是本应用第一条网络请求，往返里一直有 ~50ms 找不到归属。
    // 发出/到达各打一戳，与主进程 [perf] proxy 进入 的 epoch 对齐，即可判定花费落在哪一段。
    // 只记首次，避免换号重握手时污染时间线。
    const firstFetch = !hsFetchMarked
    if (firstFetch) { hsFetchMarked = true; hsMark('握手请求发出') }
    const peer = await requestHandshake(pub)
    if (firstFetch) hsMark('握手响应到达')
    seg('fetch')

    const peerPub = await subtle.importKey('raw', unb64(peer.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    const shared = await subtle.deriveBits({ name: 'ECDH', public: peerPub }, kp.privateKey, 256)
    const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits'])
    const ke = await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: hexToBytes(master), info: utf8('campus-secure-v1') },
      ikm, 256,
    )
    const key = await subtle.importKey('raw', ke, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    seg('derive')
    // 握手期间发生了登出/换号：这次会话属于旧用户，不能写回。
    // 抛错让调用方重试（重试会走一次新的握手），而不是拿旧会话继续发请求。
    if (gen !== sessionGen) throw new Error('secure channel: session invalidated')
    sessionKey = key
    sessionId = peer.sessionId
    if (!hsEndMarked) { hsEndMarked = true; hsMark(`握手完成 ${Date.now() - _hsT0}ms 分段(${_seg.join(' / ')})`) }
    return { sessionId, sessionKey }
  })().catch((e) => {
    // 失败也记一条：否则「握手没打完成」既可能是失败、也可能是还没走到。
    if (!hsEndMarked) { hsEndMarked = true; hsMark(`握手失败 ${Date.now() - _hsT0}ms 分段(${_seg.join(' / ')})`) }
    throw e
  }).finally(() => { pendingSession = null })
  return pendingSession
}

// 发握手报文（2-19）：两种传输，返回形状一致。
//   · 有 Electron 外壳：走 IPC，主进程用 Node http 直连后端。省掉 app:// 的一次派发
//     与回程（实测 ~19ms）；过 IPC 的只有公钥与 sessionId，私钥与会话密钥不出渲染层。
//   · 纯浏览器（没有 window.electron）：退回 app:// 相对路径的裸 fetch，行为同旧版。
async function requestHandshake(pub) {
  const api = typeof window !== 'undefined' ? window.electron : null
  if (api && typeof api.invoke === 'function') {
    const res = await api.invoke(INVOKE.SECURE_HANDSHAKE, pub)
    if (res && res.outcome === 'ok' && typeof res.pub === 'string' && res.sessionId) {
      return { pub: res.pub, sessionId: res.sessionId }
    }
    // 失败原因由主进程给（main.ipc-contract 的 fail()），透出来便于定位
    throw new Error('secure channel: ' + ((res && res.error) || 'handshake failed'))
  }
  const resp = await fetch(BASE() + '/api/secure/handshake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pub }),
  })
  if (!resp.ok) throw new Error('secure channel: handshake failed ' + resp.status)
  return resp.json()
}

export async function encryptBody(obj, perf) {
  const { sessionId: sid, sessionKey: key } = await ensureSession()
  const endEncrypt = startCryptoStat(perf, '请求加密')
  const plain = utf8(JSON.stringify(obj))
  const iv = new Uint8Array(12); crypto.getRandomValues(iv)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
  endEncrypt(plain.length)
  const tag = ct.subarray(ct.length - 16)
  const body = ct.subarray(0, ct.length - 16)
  return { session: sid, d: b64(iv) + '.' + b64(tag) + '.' + b64(body) }
}

export async function decryptBody(d, perf) {
  const { sessionKey: key } = await ensureSession()
  const parts = String(d).split('.')
  if (parts.length !== 3) throw new Error('bad secure packet')
  const iv = unb64(parts[0]); const tag = unb64(parts[1]); const body = unb64(parts[2])
  const full = new Uint8Array(body.length + tag.length)
  full.set(body); full.set(tag, body.length)
  const endDecrypt = startCryptoStat(perf, '响应解密')
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, key, full)
  endDecrypt(full.length)
  return JSON.parse(new TextDecoder().decode(pt))
}

// --- 流式（SSE）专用封装 ---
// 请求体：安全通道开启时加密整个 body（与其它 JSON API 一致）；否则原样返回。
// 降级：握手失败时退回明文，保证「开关不一致」也能各自正常工作。
export async function encodeStreamRequest(obj) {
  if (!safe()) return obj
  try {
    return await encryptBody(obj)
  } catch (_) {
    clearSession()
    return obj
  }
}

// 响应帧：SSE 每帧先按 JSON 解析；命中 { d } 密文信封（后端 encodeStreamEvent/responseEncrypt 同形）
// 则解密还原为事件对象，明文帧直接返回。解析/解密失败返回 null，由调用方丢弃该帧。
// 注意：这里不清会话——流是用「发送该请求时的会话」加密的，清掉只会让后续帧继续解不开、
// 并把其它正常请求也在用的会话一起作废；真正过期的情况由请求层的 401 重握手兜底。
export async function decodeStreamEvent(raw) {
  let obj
  try { obj = JSON.parse(raw) } catch (_) { return null }
  if (obj && typeof obj === 'object' && typeof obj.d === 'string') {
    try {
      return await decryptBody(obj.d)
    } catch (_) { return null }
  }
  return obj
}

// 会话失效（15 分钟超时等）后强制清空，下次请求重新握手
export function clearSession() {
  // 代次 +1：让在途的握手回来时发现「会话已作废」而不再写回
  sessionGen++
  sessionKey = null
  sessionId = null
  // 新会话在后端没有任何绑定，下一次请求必须重新携带 token 建立身份
  authBound = false
}

// 登出/换号必须清掉信道会话：会话密钥与「已绑定身份」标记都是**跟着用户走**的状态。
// 不清的话：换号后前端仍认为「本会话已绑定身份」，于是新用户的请求不携带 token，
// 而后端那条会话上还挂着上一个用户的绑定 → 前端与后端对「当前是谁」认知不一致。
// 登记到用户级清理表（见 utils/userScopedCache.js），登出统一调。
// 注：master key 不是用户级（整个应用共用一把），不清。
registerUserScopedReset(clearSession)