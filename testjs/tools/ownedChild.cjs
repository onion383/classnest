// =========================================================================
// ownedChild.cjs —— 「本脚本自己启动的子进程」的统一登记与幂等清理
//
// 为什么需要：性能探针会启动 Electron（含 renderer/GPU/backend 后代），
// 但清理只写在 one-shot 成功路径；Ctrl+C / SIGTERM / 异常 catch 只停 Vite，
// Electron 残留会占着单实例锁，下次跑直接连上僵尸窗口。
// 另一个坑：探针可能复用**外部已启动**的实例，那种绝不能杀 —— 所以必须区分
// 「owned（本进程 spawn 的）」和「借用的」。
//
// 用法（调用方保留 killTree 的引入方式即可，本工具负责登记/幂等/钩子）：
//   const owned = createOwnedChild({ killTree, label: 'inp' })
//   owned.adopt(child)          // 只在本进程 spawn 新实例后调用；复用的实例不要登记
//   owned.stop()                // 幂等：杀树并清空句柄，重复调用无害
// one-shot / catch / SIGINT / SIGTERM / exit 各路径都调 owned.stop()，共享同一句柄。
// 信号退出码各探针约定不同（0/130/143），由调用方自己接钩子，本工具不替它决定。
// =========================================================================

/**
 * @param {{ killTree: (child: any) => void, label?: string }} opts
 */
function createOwnedChild({ killTree, label = 'probe' } = {}) {
  let child = null

  /** 登记本进程刚 spawn 的子进程；传 null 表示复用外部实例（不登记） */
  function adopt(spawned) {
    if (!spawned || !spawned.pid) return
    child = spawned
  }

  /** 幂等停止：只杀本进程启动的那一个，重复调用/未登记都无害 */
  function stop() {
    if (!child) return
    const target = child
    child = null // 先清句柄：killTree 内部 spawn 是异步的，避免重复触发
    try { killTree(target) } catch (_) { /* 清理路径不抛 */ }
  }

  /** 当前是否持有 owned child（测试/调用方可查） */
  function hasOwned() { return !!child }

  return { adopt, stop, hasOwned }
}

module.exports = { createOwnedChild }
