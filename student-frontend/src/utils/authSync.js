// =========================================================================
// authSync.js —— 跨窗口登录态同步的唯一实现
//
// 同一 profile 下所有窗口共享一份 localStorage，但各窗口是独立 JS 上下文：
// 主窗口登出/换号时，**其它窗口**只会收到一条 storage 事件（只带 key 与新旧值）。
//
// 过去这段逻辑被抄在两个子窗口入口里，而且口径不一致：
//   · 桌面组件按 userId|dbSlug|sid 判断身份（续期不清缓存，审查 v5 · V5-044）；
//   · 工具箱只看 key 就 reset —— 滑动续期也会把它的用户级缓存清一遍；
//   · 主窗口干脆没有监听 —— 其它窗口换号时主窗口的登录代次不 +1（v6 · 2-3b 缺口）。
//
// 现在收成一份：所有窗口入口都调 installAuthSync()，判定与副作用只在这里。
// 判身份的键是「账号 + 库 + 会话」三项：滑动续期只换 token 字符串，这三项不变，
// 因此不会把同一次登录的在途请求/缓存误判成换人（那把 30 天续期变成一次登出）。
//
// 副作用顺序与登出入口一致（见 authStorage.clearAuth）：先 resetUserScopedCaches()
// 递增登录代次，再广播 AUTH_CHANGED_EVENT 通知业务组件清数据 —— 顺序反了的话，
// 组件在代次还没变时重拉，结果仍会被判成「旧代次响应」而丢弃。
// =========================================================================
import { getToken, TOKEN_KEY, AUTH_CHANGED_EVENT } from './authStorage.js'
import { decodeJwtPayload } from './jwt.js'
import { resetUserScopedCaches } from './userScopedCache.js'

// 登录主体身份：解析失败（空 token / 损坏 JWT）返回 ''，视为未登录。
export function authIdentity(token) {
  const p = decodeJwtPayload(token)
  return p ? `${p.userId || ''}|${p.dbSlug || ''}|${p.sid || ''}` : ''
}

/**
 * 安装跨窗口登录态监听。
 *
 * @param {object} [opts]
 * @param {EventTarget} [opts.target] 监听对象，默认 window（测试可传假对象）
 * @param {Function} [opts.readToken] 读当前 token，默认 authStorage.getToken
 * @param {Function} [opts.identity] 身份计算，默认 authIdentity
 * @param {Function} [opts.resetCaches] 用户级缓存清理，默认 resetUserScopedCaches
 * @param {Function} [opts.onTokenChanged] 任何 TOKEN_KEY 变化（含滑动续期）都会调用
 * @param {Function} [opts.onIdentityChanged] 仅在身份真的变了时调用（登出/换号）
 * @param {Function} [opts.notify] 广播 AUTH_CHANGED_EVENT，默认在 target 上派发
 * @returns {Function} 卸载函数（重复安装时先调它，避免同窗口叠加多份监听）
 */
export function createAuthSync({
  target = window,
  readToken = getToken,
  identity = authIdentity,
  resetCaches = resetUserScopedCaches,
  onTokenChanged = () => {},
  onIdentityChanged = () => {},
  notify = () => target.dispatchEvent(new CustomEvent(AUTH_CHANGED_EVENT)),
} = {}) {
  let snapshot = identity(readToken())

  const handler = (e) => {
    // 只关心登录 token：主题等 app-* 键由各窗口自己的监听处理
    if (!e || e.key !== TOKEN_KEY) return
    onTokenChanged(e.newValue)
    const next = identity(e.newValue)
    // 同一会话只换了 token 字符串（滑动续期）：让下次请求重读即可，不是换人
    if (next === snapshot) return
    const previous = snapshot
    snapshot = next
    resetCaches()
    notify()
    onIdentityChanged({ previous, next })
  }

  target.addEventListener('storage', handler)
  return () => target.removeEventListener('storage', handler)
}

export function installAuthSync(opts) {
  return createAuthSync(opts)
}
