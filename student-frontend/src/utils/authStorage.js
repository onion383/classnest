// 登录凭据与当前用户的唯一存取点（localStorage）。
//
// 此前 token 有 37 处、currentUser 有 14 处裸 localStorage 读写散在 22 个文件里：
// 键名/序列化/清空口径（登出是否连用户一起清）由各处独立维护，策略一变要全库搜改。
// 收拢到本模块后，存取策略只发生在这里。
//
// 跨窗口共享是有意设计（Electron 主窗口/引导窗口/悬浮组件/桌面组件同 origin 共享
// localStorage），不是泄漏面：本地数据本来就在同一用户目录下。

import { resetUserScopedCaches } from './userScopedCache.js'

const TOKEN_KEY = 'token'
const USER_KEY = 'currentUser'

// 「登录态变了」的窗口内事件名。
// 同一 profile 下别的窗口登出/换号时，本窗口只会收到 storage 事件（只带 key，
// 不知道是登出还是换号）。业务状态怎么作废由各窗口自己决定，这个事件把信号传下去。
const AUTH_CHANGED_EVENT = 'classnest:auth-changed'

// ---- 登录 token ----
// 读：未登录统一返回 ''（历史调用点有 || '' 与 if(判空) 两种口味，'' 兼容两者）
function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch (_) { return '' }
}
function setToken(token) {
  try { if (token) localStorage.setItem(TOKEN_KEY, token) } catch (_) { /* 隐私模式等写失败忽略 */ }
}
function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY) } catch (_) {}
}

// ---- 当前用户（登录返回的 user 对象，JSON 持久化）----
// 读：未登录/损坏返回 null（需要空对象的调用点自己 || {}）
function getCurrentUser() {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch (_) { return null }
}
function setCurrentUser(user) {
  try { if (user) localStorage.setItem(USER_KEY, JSON.stringify(user)) } catch (_) {}
}
function clearCurrentUser() {
  try { localStorage.removeItem(USER_KEY) } catch (_) {}
}

// ---- 组合操作（登录成功写全套 / 登出清全套）----
function setAuth(token, user) {
  setToken(token)
  setCurrentUser(user)
}
function clearAuth() {
  clearToken()
  clearCurrentUser()
  // 登出/换号必须连「跟着用户走」的缓存一起清：开学日、仪表盘快照等都是进程内缓存，
  // 不清的话下一个登录的人会看到上一个人的数据（审查 v4 · B06-02）。
  // 具体清哪些由各缓存模块自己登记（见 utils/userScopedCache.js），这里不点名。
  resetUserScopedCaches()
}

export {
  TOKEN_KEY, USER_KEY, AUTH_CHANGED_EVENT,
  getToken, setToken, clearToken,
  getCurrentUser, setCurrentUser, clearCurrentUser,
  setAuth, clearAuth,
}
