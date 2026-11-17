// =========================================================================
// 标题栏待办的「写成功 → 立即重拉」事件通道
//
// 背景：临时学生 / 销假的胶囊原来只有 10 分钟轮询 + 窗口回焦。用户在 AI 助手里
// 写完座位表、或在请假页销假之后，标题栏最长要等 10 分钟才变，两个提醒不同步。
//
// 做法：复用 httpClient 的响应成功时机（桌面挂件的 data-changed 广播就在那里），
// 写完任何业务写请求就发一个 window 级事件，通知中心收到后重拉两类数据。
// 不新增 IPC 通道，也不用每个页面各自记得刷新 —— 新增写入口默认就能触发。
//
// 判定口径与 widgetDataChanged 一致：保守优先。写请求默认触发，只排掉
// 「高频且确定与这两类待办无关」的基础设施写（相册 / 聊天 / 认证 / 设置等）。
// 排错了最多白拉两个 GET，漏掉了就会退回 10 分钟滞后。
// =========================================================================
import { normalizeApiPath } from './widgetDataChanged.js'

export const TODO_CHANGED_EVENT = 'classnest:todo-changed'

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete'])

// 即使路径被 IGNORED_RE 覆盖也必须触发：AI 整块写座位、批量落表、撤销/重做
// 都会建档或改销假状态，而它们挂在 /api/ai 下。
const ALWAYS_RE = /^\/api\/(?:ai\/(?:doc|apply-batch|snapshot\/restore)|undo|restore)(?:\/|\?|$)/

// 高频且与待办无关。注意 /api/ai 整条排掉，再靠 ALWAYS_RE 把三种写入捞回来。
const IGNORED_RE = /^\/api\/(?:ai|album|account|auth|login|register|recover-password|secure|search|widget-settings|background|perf|data\/zip|data\/sources|feedback)(?:\/|\?|$)/

/** 这次写是否需要让标题栏待办重新取数；纯函数，便于单测真跑 */
export function shouldInvalidateTodo(method, url) {
  if (!WRITE_METHODS.has(String(method || '').toLowerCase())) return false
  const path = normalizeApiPath(url)
  if (ALWAYS_RE.test(path)) return true
  if (!path.startsWith('/api/')) return false
  return !IGNORED_RE.test(path)
}

/**
 * 造一个广播器；emit 由调用方注入，这样判定与去重能在 node 里真跑。
 * 同一个 config 只播一次：安全通道 / 后端未就绪重试会复用 config 再走一次响应拦截器，
 * 不去重会让一次写变成多次刷新。
 */
export function createTodoInvalidator(emit) {
  return {
    announce(config) {
      if (!config || config.__todoChangedSent || config.__skipTodoChanged) return false
      if (!shouldInvalidateTodo(config.method, config.url)) return false
      config.__todoChangedSent = true
      try { emit() } catch (_) { /* 刷新失败不该把一次成功的写变成失败 */ }
      return true
    },
  }
}
