// =========================================================================
// secureRetry.js —— 安全信道 401 重试的分支判定（纯函数、零依赖）
//
// 为什么单独抽出来：原来三个 401 分支（凭据降级 / auth-required / session-expired）
// 的条件散在 axios 拦截器里，唯一覆盖它们的是需要 Vite + Electron 的冒烟脚本，
// CI 里直接跳过（N1-02）——安全信道重试回归等于零覆盖。
//
// 这里只回答「这次 401 该走哪个重试分支」，副作用仍留在 secureAxios：
// 清会话、重新握手、重新加密、重发原请求。
//
// 分支顺序与拦截器一致，优先级：降级 > auth-required > session-expired。
// 顺序不能改：凭据降级时后端也会回 401，若先判 auth-required 会误清 token。
// =========================================================================

/**
 * @param {object} p
 * @param {number} [p.status] HTTP 状态码
 * @param {object} [p.headers] 响应头
 * @param {any} [p.data] 响应体（session-expired 是 { d: 'session-expired' } 裸 JSON）
 * @param {object} [p.config] axios 请求配置（重试标志挂在上面）
 * @returns {'degraded'|'auth'|'session'|null} 该走哪个重试分支；null = 不重试
 */
export function decideSecureRetry({ status, headers, data, config } = {}) {
  const cfg = config || {}

  // 凭据降级：安全模式下握手失败 → applyAuthHeader 退回明文 Bearer，后端不收 → 必然 401。
  // 用独立标志 __retryDegraded，避免与 auth-required 共用标记而互相跳过。
  if (status === 401 && cfg.__credentialDegraded && cfg.__retryDegraded !== true) return 'degraded'

  // 信道身份未绑定/绑定失效：后端置 X-Auth-Required，要求带 token 重新认证。
  if (status === 401
    && String((headers && headers['x-auth-required']) || '') === '1'
    && cfg.__retryAuth !== true) return 'auth'

  // 会话过期：后端 15 分钟 TTL 清掉了信道会话、或后端重启。任何方法都要重试。
  if (status === 401
    && data && typeof data === 'object' && data.d === 'session-expired'
    && cfg.__retrySession !== true) return 'session'

  return null
}
