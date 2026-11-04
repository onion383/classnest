// =========================================================================
// userScopedCache.js —— 「跟着登录用户走」的进程内缓存注册表
//
// 为什么要有它：
//   审查发现两个缓存都不跟登出/换号失效：
//     · utils/semesterStart.js 的 cached（开学日）
//     · composables/useDashboardData.js 的 dataCache（仪表盘数据）
//   结果是 B 登录后看到 A 的开学日和仪表盘 —— 而这两个缓存各自为政，
//   谁也不知道「登出」这件事要通知自己。
//
//   逐个在登出入口（设置页、账号弹窗、登录页三处）手工调 invalidate 是最差解：
//   下次加一个新缓存还会漏，而且三处入口总有一个忘掉。
//
//   这里反过来：**缓存自己登记清理函数**，登出统一调 resetUserScopedCaches()。
//   注册表本身不 import 任何业务模块，所以不存在循环依赖。
//
// 用法（在缓存模块里，模块加载时登记）：
//   import { registerUserScopedReset } from '../utils/userScopedCache.js'
//   registerUserScopedReset(() => { cached = null; inflight = null })
// =========================================================================

const resetters = new Set()

// 登录代次：每次登出/换号 +1。
// 只清缓存不够：已经发出去、还在路上的请求回来时仍会把上一个账号的数据写回缓存
// （审查 v5 · V5-004）。各缓存在发起请求时记下当前代次，响应写回前比对；
// 代次变了就丢弃结果并按新用户重拉。
let generation = 0

// 登记一个「换用户必须清掉」的清理函数。重复登记同一个函数无副作用（Set 去重）。
export function registerUserScopedReset(fn) {
  if (typeof fn === 'function') resetters.add(fn)
}

// 当前登录代次。请求发起时取值，响应回来时再取一次比对。
export function userScopedGeneration() {
  return generation
}

// 登出/换号/切库时调用：任何清理函数抛错都不能影响登出本身
export function resetUserScopedCaches() {
  // 先递增，再清理：这样在途请求的响应无论如何都排在「旧代次」上
  generation += 1
  for (const fn of resetters) {
    try { fn() } catch (e) { console.warn('[cache] 清理用户级缓存失败：', e) }
  }
}

// 仅测试用：当前登记数量（验证「缓存模块确实登记了」）
export function _registeredCount() {
  return resetters.size
}
