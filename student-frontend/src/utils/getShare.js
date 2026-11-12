// =========================================================================
// getShare.js —— 通用 GET 在途共享 + 短 TTL 缓存（v6 性能专题 · 1-7，P3-12）
//
// 事故面：`/api/students`、`/api/schedule/semesters`、`/api/ai/config` 这类基础数据
// 会被多个组件在同一时刻各拉一次；`httpClient` 没有去重层，只能靠各业务自己缓存
// （结果是有的缓存了、有的没缓存，同屏几个组件各发一遍）。
//
// 这里做成**与业务无关的一层**，按 `method + url + params` 合并：
//   · 在途共享：同一个 key 并发发起时只打一次网络请求，后来者等同一个 Promise；
//   · 短 TTL：成功响应在 ttl 内可被后续调用直接复用（吸收「组件依次挂载」那几十毫秒）；
//   · 代次守卫：key 里不带用户，靠 userScopedGeneration() 区分代次 —— 换号后旧响应
//     既不写缓存、也不交给调用方（reject 成取消错误，调用方的错误处理按「已取消」看待）。
//
// ⚠️ 只共享「读」：写请求、二进制下载（blob/arraybuffer/stream）、带取消信号的请求
// 一律不进共享层 —— 前两者语义上不能复用，后者会让一个调用方的取消连累其他人。
//
// 这个文件只有纯逻辑（不 import axios），适配器接线在 utils/httpClient.js，
// 单测可以直接 import 本模块。
// =========================================================================

// 稳定的参数序列化：对象键排序，保证 {a,b} 与 {b,a} 生成同一个 key
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value)
    return s === undefined ? String(value) : s
  }
  // URLSearchParams 的键不在自有属性上，按字符串处理（否则所有查询串都会撞成 {}）
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) return value.toString()
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

// 取消错误：与 axios 的 CanceledError 同形，httpClient 的响应拦截器
// 对 `code === 'ERR_CANCELED'` 一律按「已取消、不探测不重试」处理。
function canceledError() {
  const err = new Error('GET 共享：登录用户已切换，旧响应作废')
  err.name = 'CanceledError'
  err.code = 'ERR_CANCELED'
  err.__CANCEL__ = true
  return err
}

/**
 * @param {object} opts
 * @param {number} opts.ttl 成功响应可复用时长（毫秒）
 * @param {number} opts.maxEntries 缓存条目上限（超过时淘汰最旧）
 * @param {() => number} opts.now 时钟（单测可注入）
 * @param {() => number} opts.generation 当前登录代次（单测可注入）
 */
export function createGetShare({
  ttl = 500,
  maxEntries = 100,
  now = () => Date.now(),
  generation = () => 0,
} = {}) {
  // key → { gen, at, response }
  const cache = new Map()
  // key → { gen, epoch, promise }
  const inflight = new Map()
  // 代次清理的本地代数：reset() 时 +1，让在途请求彻底作废（结果不写缓存、也不交给调用方）
  let epoch = 0
  // 数据版本：写操作成功时 +1。只影响「能不能复用/写缓存」，不取消任何在途请求
  let dataVersion = 0

  // 只给「可共享的读请求」生成 key，其余返回 null（调用方直接走原生适配器）
  function keyOf(config) {
    if (!config) return null
    if (String(config.method || 'get').toLowerCase() !== 'get') return null
    if (config.__noShare === true) return null
    const rt = config.responseType
    if (rt && rt !== 'json') return null
    // 取消信号/令牌属于单个调用方，共享会让一个人的取消连累其他人
    if (config.signal || config.cancelToken) return null
    return `${config.baseURL || ''}|${config.url || ''}|${stableStringify(config.params)}`
  }

  function prune() {
    while (cache.size > maxEntries) {
      let oldestKey = null
      let oldestAt = Infinity
      for (const [k, v] of cache) {
        if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k }
      }
      if (oldestKey === null) break
      cache.delete(oldestKey)
    }
  }

  // 发起（或复用）一次共享请求。factory 返回 axios 适配器的 Promise。
  function run(key, factory) {
    const gen = generation()

    const hit = cache.get(key)
    if (hit && hit.gen === gen && now() - hit.at < ttl) return Promise.resolve(hit.response)

    const pending = inflight.get(key)
    // 同一代次、且不是「写操作之后」的在途请求才能复用：
    // 写成功会 markDirty 抬高数据版本，此时旧的在途响应可能早于这次写，不能再发给后来者
    if (pending && pending.gen === gen && pending.epoch === epoch && pending.dataVersion === dataVersion) {
      return pending.promise
    }

    const entry = { gen, epoch, dataVersion, promise: null }
    entry.promise = (async () => {
      try {
        const response = await factory()
        // 换号之后返回的响应：直接作废，不写缓存、也不交给调用方
        if (entry.epoch !== epoch || entry.gen !== generation()) throw canceledError()
        // 期间发生过写操作：响应仍交给原来的等待方，但不再进缓存（避免写后的 GET 拿到写前数据）
        if (entry.dataVersion === dataVersion) {
          cache.set(key, { gen, at: now(), response })
          prune()
        }
        return response
      } finally {
        if (inflight.get(key) === entry) inflight.delete(key)
      }
    })()
    inflight.set(key, entry)
    return entry.promise
  }

  // 登出/换号：清掉已缓存的值，并让所有在途请求的结果作废（缺一不可 ——
  // 只清值，旧请求回来仍会写回缓存；只作废在途，已缓存的旧账号数据还在）。
  function reset() {
    epoch += 1
    dataVersion += 1
    cache.clear()
    inflight.clear()
  }

  // 写操作成功：只作废「已缓存的值」与在途条目的可复用性，不取消任何请求 ——
  // 否则同屏的普通 GET 会跟着一起被拒绝。写之后到达的调用方会重新发请求，
  // 不会拿到写之前的旧响应。
  function markDirty() {
    dataVersion += 1
    cache.clear()
  }

  // 单测/诊断用
  function stats() {
    return { cached: cache.size, inflight: inflight.size, epoch, dataVersion }
  }

  return { keyOf, run, reset, markDirty, stats }
}
