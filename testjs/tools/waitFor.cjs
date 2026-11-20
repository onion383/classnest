// =========================================================================
// waitFor.cjs —— 轮询等待，替代「死等 N 秒等页面/任务就绪」
//
// 为什么需要：
//   探针和冒烟里的 `await new Promise((r) => setTimeout(r, 3000))` 有两种结局——
//   快机器上白等 3 秒（跑一次几十秒全耗在等上），慢机器上还没就绪就往下走（flaky）。
//   模式扫描把这种写法记为 fixed-wait，本文件是它的替代品。
//
// 两个函数：
//   waitFor(pred)      —— 等到 predicate 返回真，或超时（返回 false，不抛）
//   waitForStable(fn)  —— 等到 fn 的返回值连续 stableTimes 次不变，用于「等动画/等任务收尾」
//                         这类没有结束信号的场景
//
// 用法（.cjs 直接 require；.mjs 用 createRequire）：
//   const { waitFor, waitForStable } = require('../tools/waitFor.cjs')
//   await waitFor(() => countOnDisk(slug) > 0, { label: '第一批开始生成' })
//   await waitForStable(() => countOnDisk(slug), { label: '在跑批次收尾' })
//
// 约定：**不要抛异常**。探测条件本身经常会抛（元素还没挂载、端口还没 listen），
// 那是「还没就绪」而不是失败；拿到 false 之后由调用方决定是报错还是继续。
// =========================================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 轮询直到 predicate 为真。
 * @param {() => unknown | Promise<unknown>} predicate 返回真值即结束
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [opts]
 * @returns {Promise<boolean>} 超时返回 false（不抛）
 */
async function waitFor(predicate, opts = {}) {
  const { timeoutMs = 5000, intervalMs = 100 } = opts
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await predicate()) return true
    } catch (_) { /* 还没就绪：元素未挂载 / 端口未 listen / 页面在导航中 */ }
    if (Date.now() >= deadline) return false
    await sleep(intervalMs)
  }
}

/**
 * 轮询直到取到的值连续 stableTimes 次相同（默认 3 次 ≈ 至少 200ms 不动）。
 * 用于「等动画结束」「等后台任务收尾」这类没有结束信号的场景。
 * @param {() => unknown | Promise<unknown>} getValue
 * @param {{ timeoutMs?: number, intervalMs?: number, stableTimes?: number, label?: string }} [opts]
 * @returns {Promise<boolean>} 超时返回 false（不抛）
 */
async function waitForStable(getValue, opts = {}) {
  const { timeoutMs = 10000, intervalMs = 100, stableTimes = 3 } = opts
  const deadline = Date.now() + timeoutMs
  let prev
  let same = 0
  for (;;) {
    let cur
    let ok = false
    try {
      cur = await getValue()
      ok = true
    } catch (_) { /* 同上：读不到算「还没稳定」 */ }
    if (ok) {
      if (same > 0 && Object.is(cur, prev)) same++
      else same = 1
      prev = cur
      if (same >= stableTimes) return true
    }
    if (Date.now() >= deadline) return false
    await sleep(intervalMs)
  }
}

module.exports = { waitFor, waitForStable, sleep }
