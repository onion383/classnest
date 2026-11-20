// =========================================================================
// backendOrigin.js —— 后端地址的唯一口径（B1：页面 app:// + /api 协议代理）
//
// B1 方案：页面保持 app://local，`/api/*` 由主进程自定义协议代理到后端回环地址。
// 因此：
//   · API 请求始终用相对路径（dev 走 Vite 代理，打包走 app:// 协议代理）；
//   · 图片/视频等媒体仍用后端绝对地址（Cookie/媒体凭据、Range 都保持原有语义）；
//   · 不再有「页面 origin = 后端 http origin」的分支，origin 隔离不变。
//
// 端口默认值来自仓库根 config/ports.json（Vite 与 Node 都能读）；运行期主进程经
// preload 注入 __BACKEND_ORIGIN__，优先级更高，所以改端口无需重建前端也能对上 CSP。
// 纯函数 resolveMediaBase 便于单测；mediaBaseUrl 才依赖 import.meta.env。
// =========================================================================

import ports from '../../../config/ports.json' with { type: 'json' }

function runtimeOrigin() {
  try {
    const value = globalThis.__BACKEND_ORIGIN__
    // 只接受主进程注入的回环 http 地址，避免页面脚本改全局值把媒体请求导向别处
    return typeof value === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value) ? value : ''
  } catch (_) {
    return ''
  }
}

// 端口在运行期可能被顺延（首选端口被占用），主进程会把真实 origin 广播下来。
// 所以这里每次读全局值，不把结果固化到模块作用域 —— 否则顺延后整批媒体 404。
const FALLBACK_ORIGIN = `http://127.0.0.1:${ports.backendPort}`

export function backendOrigin() {
  return runtimeOrigin() || FALLBACK_ORIGIN
}

// 兼容老引用：这是**页面加载时**的值。运行期请调 backendOrigin()。
export const BACKEND_ORIGIN = backendOrigin()

// 主进程广播 backend-origin 时由后端就绪监听调用；返回值便于调用方判断是否真的换了。
export function setRuntimeBackendOrigin(origin) {
  if (typeof origin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)) return false
  if (origin === runtimeOrigin()) return false
  globalThis.__BACKEND_ORIGIN__ = origin
  return true
}

export function resolveMediaBase({ isDev = false } = {}) {
  return isDev ? '' : backendOrigin()
}

// API 永远走相对路径：/api/* 在两种模式下都会到后端（Vite 代理 / app:// 代理）
export function apiBaseUrl() {
  return ''
}

export function mediaBaseUrl() {
  try {
    return resolveMediaBase({ isDev: !!import.meta.env.DEV })
  } catch (_) {
    return backendOrigin()
  }
}
