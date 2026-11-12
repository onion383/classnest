// =========================================================================
// main.logRotator.js —— 日志体积收口（v6 性能专题 · 1-1）
//
// 四个日志出口（backend.log / inp.log / desktop-layer.log / startup.log）此前各写各的：
//   - backend.log 在启动关键路径上同步 stat/read(≤1MB)/write/append；
//   - inp.log、desktop-layer.log 每次 appendFileSync，无任何上限；
//   - 只有 startup.log 有写前截断（见 main.startup-timer.js，作为样板保留）。
//
// 本模块只做两件事，且**全异步**：
//   rotateIfNeeded(file, {maxBytes, keepBytes}) —— 超限就把文件改成「提示行 + 最近 keepBytes」
//   appendWithRotation(file, text, opts)        —— 同一文件串行追加，写前按需截断
//
// 为什么要串行：截断是「读尾部 → 整份重写」，若与 append 交错，后来的行可能写进刚被
// 读掉的那一段里而丢失。按文件一条 Promise 链即可，不需要锁。
// 失败一律静默：日志永远不能影响业务。
// =========================================================================

const fsp = require('node:fs/promises')
const path = require('node:path')

const NOTICE = '（历史日志已截断，仅保留最近部分）\n'

// 默认口径：单文件 1MB 封顶、截断后留最近 512KB。
const DEFAULT_MAX = 1024 * 1024
const DEFAULT_KEEP = 512 * 1024

// 只读文件尾部，用句柄定点读 —— 不把整份日志读进内存（旧实现是 readFileSync 全文再 slice）。
async function readTail(filePath, keepBytes, size) {
  let fh = null
  try {
    fh = await fsp.open(filePath, 'r')
    const start = Math.max(0, size - keepBytes)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    if (fh) await fh.close().catch(() => { /* 关不掉也不影响结果 */ })
  }
}

// 超过 maxBytes 就截断为「提示行 + 最近 keepBytes」，返回是否真的截断过。
// 文件不存在、不是普通文件、读失败都按「无需截断」处理。
async function rotateIfNeeded(filePath, { maxBytes = DEFAULT_MAX, keepBytes = DEFAULT_KEEP } = {}) {
  try {
    const st = await fsp.stat(filePath)
    if (!st.isFile() || st.size <= maxBytes) return false
    // keepBytes 必须严格小于 maxBytes，否则截断完仍然超限、下次又截，白做功。
    const keep = Math.max(0, Math.min(keepBytes, maxBytes - 1))
    const tail = await readTail(filePath, keep, st.size)
    await fsp.writeFile(filePath, NOTICE + tail)
    return true
  } catch (_) {
    return false
  }
}

// 同一文件的写入链：读-改-写与追加不会交错，行不会被截半。
const chains = new Map()

// 追加写入，写前按需截断。返回 Promise（失败也 resolve，调用方可直接 fire-and-forget）。
function appendWithRotation(filePath, text, opts = {}) {
  const prev = chains.get(filePath) || Promise.resolve()
  const next = prev.then(async () => {
    try {
      await fsp.mkdir(path.dirname(filePath), { recursive: true })
      await rotateIfNeeded(filePath, opts)
      await fsp.appendFile(filePath, text)
    } catch (_) { /* 日志失败不影响业务 */ }
  })
  chains.set(filePath, next)
  return next
}

module.exports = { rotateIfNeeded, appendWithRotation, DEFAULT_MAX, DEFAULT_KEEP, NOTICE }
