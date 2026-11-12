import axios from 'axios'
import { setupSecureAxios } from '../composables/secureAxios'
import { applyAuthHeader, safe } from '../composables/secureChannel'
import { waitForBackendReady, isBackendUnreachable, resetBackendReady } from './backendReady'
import { absorbRenewal } from './apiUrl'
import { getToken as loadStoredToken } from './authStorage'
import { userScopedGeneration, registerUserScopedReset } from './userScopedCache.js'
import { installBlobErrorNormalizer } from './blobError.js'
import { createWidgetDataChangedAnnouncer } from './widgetDataChanged.js'
import { markSince, phase } from './perfMark.js'
import { createGetShare } from './getShare.js'
import { SEND } from '../electronChannels.js'

// 主窗口写成功后通知桌面挂件刷新（A5-02）。复用既有 to-widget → from-main 中继，
// 不新增通道名；只有主窗口传 announceDataChanged: true 时才启用，避免挂件自己写
// 自己收、以及子窗口重复广播。
const widgetDataChanged = createWidgetDataChangedAnnouncer(
  (payload) => window.electron.send(SEND.TO_WIDGET, payload),
)

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

// ---------- 通用 GET 在途共享（v6 性能专题 · 1-7） ----------
// 同 `method + url + params` 的并发 GET 只打一次网络请求，成功后短 TTL 内复用响应。
// 判定与清理都在 utils/getShare.js（纯逻辑，可单测）；这里只负责接到 axios 适配器上。
// ⚠️ 必须「清值 + 作废在途」一起做：换号时旧响应既不写缓存也不交给调用方。
const getShare = createGetShare()
registerUserScopedReset(() => getShare.reset())

// 把默认适配器包一层共享逻辑。只包一次（__sharedGet 标记）：
// setupApiClient 在各窗口入口都会调用，重复包裹会让同一个请求被套多层。
function installSharedGetAdapter(target) {
  const current = target.defaults.adapter
  if (typeof current === 'function' && current.__sharedGet) return
  // axios 1.x 的 defaults.adapter 可能是 ['xhr','http','fetch'] 数组，先解析成实际函数
  const native = typeof target.getAdapter === 'function' ? target.getAdapter(current) : current
  if (typeof native !== 'function') return
  const shared = (config) => {
    const key = getShare.keyOf(config)
    if (!key) return native(config)
    // 每个调用方拿到自己的响应副本（config 指向自己）：响应拦截器会改 res.data（解密），
    // 共用同一个对象会让两条拦截器链互相覆盖；副本只共享 data 引用，解密各写各的。
    return getShare.run(key, () => native(config)).then((res) => ({ ...res, config }))
  }
  shared.__sharedGet = true
  target.defaults.adapter = shared
}
export function setupApiClient({
  baseURL,
  getToken = loadStoredToken,
  onTokenRenewed,
  onAuthExpired,
  onUnreachable,
  // 仅主窗口开启：写成功后向桌面挂件广播 data-changed（挂件不再只能等 5 分钟轮询）
  announceDataChanged = false,
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

  // 通用 GET 去重/短缓存：适配器层最靠内，不会与凭据注入 / 加密 / 401 重试打架
  installSharedGetAdapter(axios)

  // 二进制下载（responseType:'blob'）的 4xx 错误体也是 Blob。先把它还原成业务对象，
  // 否则安全通道读不到 err.response.data.d —— 会话过期的 401 会被误判成「登录过期」，
  // 密文错误信封也没法解密，调用方更拿不到后端的 { error }。归一必须排在加密层之前。
  installBlobErrorNormalizer(axios)

  // 安全通道随后装配：请求拦截器按「后注册先执行」的顺序运行，
  // 先注册加密层可保证「凭据注入」在「请求体加密」之前完成（两者共用同一会话）。
  // 响应侧同理，加密层的 401 重试要先于下面的登录失效判定执行。
  setupSecureAxios(axios)

  // 请求拦截器：登录凭据统一走信道（X-Auth-Proof 密文凭据；未启用安全通道时才用明文头）
  //
  // 首屏分段（v6 · P1-01）：本拦截器在注册顺序上最晚、执行顺序上最先，
  // 所以「排队」= 从 axios.get() 创建 config 到这里的调度耗时；「凭据」=
  // getToken + applyAuthHeader（安全模式下含一次握手）。没有 __perf 时两者都空转。
  axios.interceptors.request.use(async (config) => {
    markSince(config, '排队')
    const endCredential = phase(config, '凭据')
    try {
      // 发请求前的登录代次：响应回来时用它判断「这份续期凭据还属于当前这一代吗」。
      // 必须在这里记（而不是响应时现取当前值），否则判据恒为真，等于没判。
      config.__authGeneration = userScopedGeneration()
      const token = await getToken()
      config.headers = config.headers || {}
      if (!token) return config
      const carriedToken = await applyAuthHeader(config.headers, token, {
        forceToken: config.__forceAuthToken === true,
        perf: config.__perf,
      })
      // 记录了「本次确实携带 token」，响应成功后据此把会话标记为已绑定身份
      if (carriedToken) config.__authProofToken = true
      // 凭据降级：安全模式下 applyAuthHeader 握手失败会退回明文 Bearer，而后端在安全模式下
      // 不收明文凭据 → 这次请求必然 401。标记出来，响应拦截器遇到这种 401 时**不**按「登录过期」
      // 处理（否则一次握手抖动就把用户的 token 清掉、直接踢回登录页），而是让 secureAxios
      // 重建会话后重试。
      if (safe() && !config.headers['X-Auth-Proof']) config.__credentialDegraded = true
      return config
    } finally {
      endCredential()
    }
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
      // 写成功 → 作废 GET 共享缓存：紧接着的 fetchRows / 各个面板的刷新不能再拿到写前的旧响应
      const m = String(res.config?.method || 'get').toLowerCase()
      if (m !== 'get' && m !== 'head') getShare.markDirty()
      // 滑动续期：后端在 token 快到期时随响应下发新的 30 天 token / 媒体凭据，落盘后生效。
      // generation 取的是**发请求时**记下的代次（见请求拦截器），中途换号则丢弃这份续期。
      absorbRenewal(res.headers, { onTokenRenewed, generation: res.config?.__authGeneration })
      // 写成功后立刻告诉挂件「数据变了」：只在主窗口发，读请求 / 无关写不发（判定见 widgetDataChanged）
      if (announceDataChanged) widgetDataChanged.announce(res.config)
      return res
    },
    async (error) => {
      const config = error.config

      // blob 错误体已在最前面的归一化拦截器里还原成对象（见 installBlobErrorNormalizer），
      // 所以这里读到的 err.response.data 与 JSON 接口形状一致，无需每个调用点各自解析。

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

// B1：API 走相对路径（dev 由 Vite 代理，打包由 app://local/api 协议代理），
// 页面 origin 保持 app://local，不再跨源。
export { apiBaseUrl as backendBaseUrl } from './backendOrigin.js'