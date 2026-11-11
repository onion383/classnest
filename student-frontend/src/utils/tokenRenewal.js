// ==================== 滑动续期的落盘判定 ====================
// 后端在 token 快到期时随响应下发新凭据（x-renewed-token / x-renewed-media）。
// 落盘前必须回答一个问题：**这份响应还属于当前这一代登录吗**？
//
// 不判的后果（审查 v6 · X2-08）：A 的续期响应在「已登出并登录成 B」之后才回来，
// 一落盘就把 B 的凭据覆盖成 A 的 —— B 看起来登录着，实际所有请求都带着 A 的 token。
// 响应本身完全合法，没有任何字段能看出它来自上一代，只有「发出请求时是哪一代」这一条线索。
//
// 这里只做判定与取值，真正的写入由调用方注入（apiUrl 用 localStorage 的 setToken /
// storeMediaToken）。注入的目的：这段逻辑不 import 任何浏览器 API，可以直接单测。
//
// 代次用的是**用户作用域代次**（utils/userScopedCache.js），不另立一份：
// 那份代次已经在登出/换号时 +1，全库只该有一个「换人」信号。
import { userScopedGeneration } from './userScopedCache.js'

function headerGetter(headers) {
  // fetch 的 Headers 与 axios 的 AxiosHeaders 都支持 .get()（大小写不敏感）；
  // 裸对象的键名大小写不保证，这里按小写比对兜底。
  if (typeof headers.get === 'function') return (n) => headers.get(n)
  return (n) => {
    const k = Object.keys(headers).find((key) => key.toLowerCase() === n)
    return k ? headers[k] : undefined
  }
}

/**
 * 读取并（在代次仍有效时）落盘续期凭据。
 *
 * @param {Headers|object} headers 响应头
 * @param {object} opts
 * @param {number} opts.generation  发请求时取到的**用户作用域代次**（userScopedGeneration()）——
 *   **必传**。忘记传时按「代次未知」处理会静默停掉续期（30 天后用户被踢），所以这里直接抛错。
 * @param {Function} opts.setToken  写入登录 token
 * @param {Function} [opts.storeMediaToken] 写入媒体凭据
 * @param {Function} [opts.onTokenRenewed] token 续期后的副作用（重建会话绑定等）
 * @returns {{applied:boolean, token?:string, media?:string, reason?:string}}
 */
export function absorbRenewalTokens(headers, opts = {}) {
  const { generation, setToken, storeMediaToken, onTokenRenewed } = opts
  if (!Number.isInteger(generation)) {
    throw new TypeError('absorbRenewalTokens 必须带 generation（发请求时取，不能用当前值顶替）')
  }
  if (!headers) return { applied: false, reason: 'no-headers' }
  // 代次已经变了：这份续期属于上一代登录，两个凭据都不能落盘（连回调也不触发）
  if (generation !== userScopedGeneration()) return { applied: false, reason: 'stale-generation' }

  const get = headerGetter(headers)
  const token = get('x-renewed-token') || ''
  const media = get('x-renewed-media') || ''
  if (!token && !media) return { applied: false, reason: 'nothing-renewed' }

  if (token && typeof setToken === 'function') {
    try { setToken(token) } catch (_) { /* 隐私模式写失败：不影响本次请求 */ }
    onTokenRenewed?.(token)
  }
  if (media && typeof storeMediaToken === 'function') {
    try { storeMediaToken(media) } catch (_) { /* 同上 */ }
  }
  return { applied: true, token, media }
}
