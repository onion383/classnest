// =========================================================================
// mcpForwarderDiscovery.cjs —— MCP 转发器的后端地址发现
//
// 为什么需要：后端首选端口被占用时会向后顺延（见 app.js 的 MAX_PORT_TRIES），
// 而客户端配置里的 CLASSNEST_MCP_URL 是「复制配置那一刻」的快照。
// 转发器由 Claude Desktop / Cursor 拉起，是独立进程，读不到班集主进程的内存，
// 所以按下面的顺序找地址，逐个试连，第一个连上的就是当前活着的那个后端：
//
//   1. env CLASSNEST_MCP_URL          —— 用户显式指定，永远最高优先
//   2. runtime-port.json              —— 主进程每次后端就绪时写入的真实端口
//                                       （路径由配置里的 CLASSNEST_RUNTIME_FILE 给出；
//                                        老配置没有这个 env 时按常见 userData 目录猜）
//   3. config/ports.json 的默认端口    —— 都没配时的最后兜底
//
// 纯函数与文件读取分开，便于单测（转发器本身顶层就会起 stdio，不能直接 require）。
// =========================================================================

const fs = require('node:fs')
const path = require('node:path')

// 主进程可能还没写完就被读到：半截 JSON、空文件、权限错误一律当「没有」，
// 让调用方继续用下一个候选，不要让转发器在这里崩掉。
function readRuntimePort(file) {
  if (!file) return null
  try {
    const raw = fs.readFileSync(file, 'utf8')
    if (!raw || !raw.trim()) return null
    const json = JSON.parse(raw)
    return json && typeof json === 'object' ? json : null
  } catch (_) {
    return null
  }
}

// runtime-port.json 的三种形态都接受：新版写 mcpUrl，过渡期可能只有 origin 或 port。
function originOf(entry) {
  if (!entry || typeof entry !== 'object') return ''
  if (typeof entry.mcpUrl === 'string' && entry.mcpUrl) return entry.mcpUrl
  if (typeof entry.origin === 'string' && entry.origin) {
    return `${entry.origin.replace(/\/+$/, '')}/mcp`
  }
  if (Number.isInteger(entry.port) && entry.port > 0) return `http://127.0.0.1:${entry.port}/mcp`
  return ''
}

function buildCandidates({ envUrl, runtimeEntries, defaultPort } = {}) {
  const out = []
  const push = (url) => {
    if (typeof url !== 'string') return
    const trimmed = url.trim()
    if (!trimmed || out.includes(trimmed)) return
    out.push(trimmed)
  }
  push(envUrl)
  for (const entry of Array.isArray(runtimeEntries) ? runtimeEntries : [runtimeEntries]) {
    push(originOf(entry))
  }
  if (Number.isInteger(defaultPort) && defaultPort > 0) {
    push(`http://127.0.0.1:${defaultPort}/mcp`)
  }
  return out
}

// 老配置没有 CLASSNEST_RUNTIME_FILE 时的兜底猜测。
// Electron 的 userData 默认取 package.json 的 name（当前是 classnest），
// 但打包版若改用 productName（班集）就会落到另一个目录 —— 两个都试，成本是两个 readFileSync。
function guessRuntimeFiles(env = process.env, platform = process.platform) {
  const names = ['classnest', '班集', 'ClassNest']
  const bases = []
  if (platform === 'win32') {
    if (env.APPDATA) bases.push(env.APPDATA)
  } else if (platform === 'darwin') {
    if (env.HOME) bases.push(path.join(env.HOME, 'Library', 'Application Support'))
  } else {
    bases.push(env.XDG_CONFIG_HOME || (env.HOME ? path.join(env.HOME, '.config') : ''))
  }
  return bases
    .filter(Boolean)
    .flatMap((base) => names.map((name) => path.join(base, name, 'runtime-port.json')))
}

module.exports = { readRuntimePort, originOf, buildCandidates, guessRuntimeFiles }
