// =========================================================================
// closeServer.cjs —— 关闭 HTTP server（保证脚本能退出）
//
// 为什么需要：
//   `server.close()` 只是「不再接受新连接」，**已有的 keep-alive 连接还挂着** →
//   Node 的事件循环仍有活着的 handle → 脚本**永不退出**（挂在那里等）。
//   探针/脚本跑到最后看着「什么都没输出」，其实是被这个 handle 吊住了。
//
// 做法（与 testjs/smoke/api-routes-test.cjs 里已验证的实现一致）：
//   1. closeAllConnections()（Node 18.2+）—— 强制断开存量连接
//   2. close(cb) —— 正常关闭
//   3. 超时兜底 —— 万一还有 handle 挂着，也要 resolve（不让收尾卡死）
//
// 用法：await closeServer(server)
// =========================================================================

/**
 * 关闭 server 并等它真正收尾。
 * @param {import('node:http').Server|null|undefined} s
 * @param {number} [timeoutMs] 兜底超时（默认 2000）
 * @returns {Promise<void>}
 */
function closeServer(s, timeoutMs = 2000) {
  if (!s) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(t)
      resolve()
    }
    const t = setTimeout(done, timeoutMs)
    // 先强制断开存量 keep-alive 连接（否则 close 的回调可能永远不来）
    try { s.closeAllConnections?.() } catch (_) { /* 老版本没有该方法 */ }
    try { s.close(() => done()) } catch (_) { done() }
  })
}

module.exports = { closeServer }
