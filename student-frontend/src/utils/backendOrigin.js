// =========================================================================
// backendOrigin.js —— 后端地址的唯一口径（B1：页面 app:// + /api 协议代理）
//
// B1 方案：页面保持 app://local，`/api/*` 由主进程自定义协议代理到 127.0.0.1:3000。
// 因此：
//   · API 请求始终用相对路径（dev 走 Vite 代理，打包走 app:// 协议代理）；
//   · 图片/视频等媒体仍用后端绝对地址（Cookie/媒体凭据、Range 都保持原有语义）；
//   · 不再有「页面 origin = 后端 http origin」的分支，origin 隔离不变。
//
// 纯函数 resolveMediaBase 便于单测；mediaBaseUrl 才依赖 import.meta.env。
// =========================================================================

export const BACKEND_ORIGIN = 'http://127.0.0.1:3000'

export function resolveMediaBase({ isDev = false } = {}) {
  return isDev ? '' : BACKEND_ORIGIN
}

// API 永远走相对路径：/api/* 在两种模式下都会到后端（Vite 代理 / app:// 代理）
export function apiBaseUrl() {
  return ''
}

export function mediaBaseUrl() {
  try {
    return resolveMediaBase({ isDev: !!import.meta.env.DEV })
  } catch (_) {
    return BACKEND_ORIGIN
  }
}
