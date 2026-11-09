import axios from 'axios'
import { setupSecureAxios } from '../composables/secureAxios'
import { applyAuthHeader, safe } from '../composables/secureChannel'
import { waitForBackendReady, isBackendUnreachable, resetBackendReady } from './backendReady'
import { absorbRenewal } from './apiUrl'
import { getToken as loadStoredToken } from './authStorage'

// 安全通道「会话过期」不是登录态失效：加密会话 15 分钟被动过期时，后端在请求解密阶段
// 直接回 401 且 body 为 { d:'session-expired' }（不是密文，也非登录 token 问题）。
// 这种 401 由 secureAxios 清会话、重新握手后重试，绝不能当成登录过期把用户踢回登录页。
function isSecureSessionExpired(error) {
  const d = error.response && error.response.data
  return !!d && typeof d === 'object' && d.d === 'session-expired'
}

// 信道凭据缺失/绑定失效：后端置 X-Auth-Required，由 secureAxios 带 token 重试一次，
// 这里同样不能按「登录过期」处理，否则重试还没发生用户就先被踢回登录页。
function isAuthRequired(error) {
  const r = error.response
  return !!r && r.status === 401 && String(r.headers?.['x-auth-required'] || '') === '1'
}

// 各窗口入口（主窗口 / 引导窗口 / 悬浮组件 / 桌面组件）共用同一套 axios 装配：
// baseURL、登录态注入、401 登录失效处理、后端未就绪时的探针与退避重试、安全通道加密。
// 各窗口差异只用可选项表达，不传即保持「token 注入 + 未就绪重试 + 加密」的最小行为：
//   - baseURL：是否需要指定后端地址（主窗口生产态 / 桌面组件指定，其余走 Vite 代理）
//   - getToken：token 获取方式（桌面组件经 IPC 异步取）
//   - onTokenRenewed：滑动续期拿到新 token 时的回调（缓存了 token 的窗口需同步更新）
//   - onAuthExpired：收到「登录态失效」401 时如何处理（清 token / 提示 / 跳登录）
//   - onUnreachable：请求判定为「后端不可达」时的探测回调（每次失败触发一次）
//   - writeRetryGuard：重连期间是否允许自动重发该请求（写请求禁重发，避免重复落库）

/**
 * 默认的写请求重发守卫：**只放行读请求**（GET / HEAD）。
 *
 * 读请求幂等 → 重试没有副作用；写请求（POST / PUT / DELETE）重试可能重复落库。
 *
 * 注意：这个守卫**只在「后端不可达 → 等待重连」那个分支里被调用**
 * （见下面响应拦截器的 `isBackendUnreachable(error)` 分支）——
 * 也就是说「调用它」本身就等价于「现在处于重连期间」，不需要再判断状态位。
 * 主窗口自己传了带 `backendReconnecting` 判断的版本，是更严格的额外约束。
 *
 * 为什么要有默认值：见下面 setupApiClient 的参数注释 —— 默认放行会让
 * **没传守卫的窗口**（子窗口）把写请求重发 6 次。
 */
function defaultWriteRetryGuard(config) {
  const m = (config?.method || 'get').toLowerCase()
  return m === 'get' || m === 'head'
}
export function setupApiClient({
  baseURL,
  getToken = loadStoredToken,
  onTokenRenewed,
  onAuthExpired,
  onUnreachable,
  // ⚠️ 默认值必须是「**写请求不重发**」，不能是放行。
  //
  // 原默认值是 `() => true`（放行），于是**任何没传守卫的窗口**（子窗口 setup /
  // widget / desktop-widget 都只传了 baseURL）在后端重连期间，写请求会被自动
  // 重发最多 6 次 → 重复落库 / 重复提交。
  //
  // 「主窗口传了守卫、子窗口没传」是典型的**默认值不安全**：
  // 以后新增窗口忘了传守卫，又会静默恢复成放行。
  //
  // 所以默认值内置成「按 method 判定」：读请求幂等 → 允许重试；写请求 → 禁重发。
  // 需要覆盖的窗口仍可显式传入自己的守卫。
  writeRetryGuard = defaultWriteRetryGuard,
} = {}) {
  if (baseURL) axios.defaults.baseURL = baseURL

  // 安全通道先装配：请求拦截器按「后注册先执行」的顺序运行，
  // 先注册加密层可保证「凭据注入」在「请求体加密」之前完成（两者共用同一会话）。
  // 响应侧同理，加密层的 401 重试要先于下面的登录失效判定执行。
  setupSecureAxios(axios)

  // 请求拦截器：登录凭据统一走信道（X-Auth-Proof 密文凭据；未启用安全通道时才用明文头）
  axios.interceptors.request.use(async (config) => {
    const token = await getToken()
    config.headers = config.headers || {}
    if (!token) return config
    const carriedToken = await applyAuthHeader(config.headers, token, {
      forceToken: config.__forceAuthToken === true,
    })
    // 记录了「本次确实携带 token」，响应成功后据此把会话标记为已绑定身份
    if (carriedToken) config.__authProofToken = true
    // 凭据降级：安全模式下 applyAuthHeader 握手失败会退回明文 Bearer，而后端在安全模式下
    // 不收明文凭据 → 这次请求必然 401。标记出来，响应拦截器遇到这种 401 时**不**按「登录过期」
    // 处理（否则一次握手抖动就把用户的 token 清掉、直接踢回登录页），而是让 secureAxios
    // 重建会话后重试。
    if (safe() && !config.headers['X-Auth-Proof']) config.__credentialDegraded = true
    return config
  })

  // 响应拦截器：
  //  1) 登录态失效：401（非安全通道会话过期）交 onAuthExpired 处理（清 token / 提示 / 跳登录）；
  //  2) 后端稍慢于窗口（或引导页「改储存目录」重启后端）时，首屏请求可能遇到「连接被拒」
  //     网络错误（此时 error.response 为 undefined）。这类错误不立即失败，而是先触发一次探测，
  //     再等后端就绪信号（backend-ready）后重试，后端一就绪立即重试、不盲等固定退避；
  //     有 HTTP 响应（4xx/5xx）的错误不重试，避免重复提交等副作用——但 502/503/504 网关错误
  //     例外（dev 下 Vite 代理对「上游未就绪」的包装，与「连接被拒」同义），见 isBackendUnreachable。
  axios.interceptors.response.use(
    res => {
      // 滑动续期：后端在 token 快到期时随响应下发新的 30 天 token / 媒体凭据，落盘后生效
      absorbRenewal(res.headers, { onTokenRenewed })
      return res
    },
    async (error) => {
      const config = error.config

      // 登录态失效（401，且非安全通道会话过期 / 信道凭据待重试）：交调用方决定是否清 token 并跳登录
      if (error.response && error.response.status === 401
        && !isSecureSessionExpired(error) && !isAuthRequired(error)) {
        // 凭据降级造成的 401（同上）：握手失败退回明文，而后端不收明文 → 不是登录过期，
        // 不能清 token 把用户踢回登录页。secureAxios 会重建会话后重试一次。
        if (!config?.__credentialDegraded) onAuthExpired?.(error, config)
      }

      // 主动取消的请求不是故障，既不探测也不重试
      if (error.code === 'ERR_CANCELED') return Promise.reject(error)

      if (isBackendUnreachable(error) && config) {
        // 没拿到任何响应 = 后端可能已不可达。触发一次探测，把用户的每一次失败操作变成探针
        if (!config.__probed) {
          config.__probed = true
          onUnreachable?.(error, config)
        }

        // 已经不可达说明「就绪」标记过期，复位后重试才会真正等新的 backend-ready
        resetBackendReady()

        // 重连期间：写请求不自动重发，把失败直接交给调用方提示用户手动重试
        if (!writeRetryGuard(config)) return Promise.reject(error)

        const retryCount = config.__retryCount || 0
        if (retryCount < 6) {
          config.__retryCount = retryCount + 1
          // 启动窗口内的等待保持静默：主窗口此时仍被首屏占位页盖着，弹提示条毫无意义。
          await waitForBackendReady(200 * config.__retryCount)
          return axios(config)
        }
      }
      return Promise.reject(error)
    }
  )
  return axios
}

// 生产模式（app:// 协议）下无 Vite 代理，需指定完整后端地址；开发模式走 Vite 代理，保持相对路径。
// 与 secureChannel.js 的 BASE 保持一致：回环地址统一用 127.0.0.1，避开 localhost → ::1 回退。
// ⚠️ 必须与 apiUrl.js 的 base 同步：后端 set-cookie 是 host-only，两者不同域会让媒体请求丢 Cookie。
export function backendBaseUrl() {
  return import.meta.env.PROD ? 'http://127.0.0.1:3000' : ''
}