// =========================================================================
// ports.cjs —— 端口唯一口径
//
// 改默认端口只动 ports.json 一处；环境变量可覆盖（优先级）：
//   后端：BACKEND_PORT > PORT（兼容旧口径） > ports.json
//   前端：FRONTEND_PORT > ports.json
//
// 后端端口在运行期可能被顺延（首选端口被占用时 +1 试探，见 student-backend/app.js），
// 所以这里导出 getter：读到的永远是当前实际值，setBackendPort 由主进程在后端回报
// 实际端口时调用。
//
// 主进程、后端子进程、Vite 构建都从这里取值；渲染层的媒体地址由主进程经
// preload 注入（--backend-origin），所以运行时改端口不需要重新构建前端。
// 本文件会被 esbuild 内联进后端 bundle，也会随应用打包（见 electron-builder.json）。
// =========================================================================

const defaults = require('./ports.json')

const LOOPBACK_HOST = '127.0.0.1'

function readPort(names, fallback) {
  for (const name of names) {
    const raw = process.env[name]
    if (raw === undefined || raw === '') continue
    // 只接受纯十进制数字串（E01-07）：Number() 会把 '0x50' / '0b1010' 也解析成端口，
    // 环境变量写错时反而静默落到一个看不出问题的值上。
    const text = String(raw).trim()
    if (!/^\d+$/.test(text)) continue
    const value = Number(text)
    if (Number.isInteger(value) && value > 0 && value <= 65535) return value
  }
  return fallback
}

const isValidPort = (v) => Number.isInteger(v) && v > 0 && v <= 65535

let backendPort = readPort(['BACKEND_PORT', 'PORT'], defaults.backendPort)
let frontendPort = readPort(['FRONTEND_PORT'], defaults.frontendPort)

const originFor = (port) => `http://${LOOPBACK_HOST}:${port}`

// 后端 EADDRINUSE 时会顺延端口，实际值要等子进程 listen 成功后才知道。
// 所以导出的是 **getter** 而不是快照：任何时刻读 ports.backendOrigin 都是当前真值，
// CSP / app:// 代理 / 安全通道 / 媒体地址各自不需要缓存，也不会各自过期。
// 注意：不要 `const { backendOrigin } = require(...)` 解构 —— 那会把值固定在当时。
function setBackendPort(port) {
  if (!isValidPort(port)) return false
  backendPort = port
  return true
}

function setFrontendPort(port) {
  if (!isValidPort(port)) return false
  frontendPort = port
  return true
}

module.exports = {
  defaults,
  LOOPBACK_HOST,
  originFor,
  get backendPort() { return backendPort },
  get frontendPort() { return frontendPort },
  get backendOrigin() { return originFor(backendPort) },
  get frontendOrigin() { return originFor(frontendPort) },
  setBackendPort,
  setFrontendPort,
}
