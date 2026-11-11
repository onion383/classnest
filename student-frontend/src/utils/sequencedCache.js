// =========================================================================
// sequencedCache.js —— 「带账号代次的进程内缓存」
//
// 解决的一类问题：模块级缓存 + 异步加载 + 换号/切作用域，三者凑在一起时，
// 仅仅「在登出时清缓存」是不够的 —— 清缓存和请求返回是两个时刻：
//   ① 发请求（此时还是 A 账号）
//   ② 用户登出登录成 B（清理表跑过，缓存已空）
//   ③ A 的响应回来 → 旧代码直接写缓存 → B 看到 A 的数据（跨账号泄漏）
// 所以写入前必须核对「这份响应还属于当前这一代吗」，代次由 createLatest 统一提供。
//
// 与 createLatest 的分工：createLatest 是序号原语（唯一实现），本文件是
// 「把它用在缓存上」的那一种固定写法（TTL + 代次 + 不缓存失败结果）。
//
// load 的约定：
//   · 返回缓存值；返回 null/undefined 表示「本次没拿到」（例如接口失败），**不写缓存**，
//     调用方拿到 null 自行兜底 —— 失败结果绝不能缓存，否则之后永远显示空白。
//   · load 抛错等同于没拿到：同样不写缓存，错误继续抛给调用方（由它决定怎么提示）。
// =========================================================================
import { createLatest } from './latestOnly.js'

export function createSequencedCache({ load, ttl = 60 * 1000, now = () => Date.now() } = {}) {
  if (typeof load !== 'function') throw new TypeError('createSequencedCache 需要 load 函数')
  let value = null
  let at = 0
  const guard = createLatest()

  return {
    /** 取缓存；过期或没有则加载一次。返回 null 表示「本次没拿到」（代次已过期 / load 失败） */
    async get() {
      if (value !== null && now() - at < ttl) return value
      const token = guard.begin()
      const fresh = await load()
      // 代次已变（登出/换号/手动 invalidate）：不写缓存，也不把它交给调用方
      if (!guard.isCurrent(token)) return null
      if (fresh == null) return null
      value = fresh
      at = now()
      return value
    },
    /** 只清值，不动代次：改名/增删后下次重新拉（在途请求仍然有效） */
    clear() {
      value = null
      at = 0
    },
    /** 换号/登出：清值 **并** 让所有在途请求作废（少任一件都还会泄漏） */
    invalidate() {
      guard.invalidate()
      value = null
      at = 0
    },
    /** 仅供断言/调试：当前是否已有缓存值 */
    has() {
      return value !== null
    },
  }
}
