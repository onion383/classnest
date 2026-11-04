// =========================================================================
// disposables.js —— 「需要在某个时刻被释放的东西」统一登记表
//
// 为什么要有它：
//   审查 v4 挖出一串同根因的泄漏：定时器没人 clear、事件监听器注册成匿名
//   函数所以根本移不掉、AbortController 没人 abort、异步链卸载后还在写 ref。
//   逐条补清理是典型的打补丁——下一个人加一个 setTimeout 照样漏。
//
//   病根不在某一行，而在于「资源创建处」与「资源销毁处」在代码上是两个
//   不相邻的地方，必须靠人脑记住配对。而且本项目里 onScopeDispose 全库
//   零使用、onBeforeUnmount 与 onUnmounted 两种钩子混用，没有统一表达。
//
//   这里反过来：**资源就地登记，作用域结束时统一释放**。
//   创建资源的那一行顺手登记自己，销毁就变成作用域的事，不用记。
//
// 用法：
//   // 组件里：
//   const d = useDisposables()          // 随组件卸载自动 dispose
//   d.timeout(() => doSomething(), 700)  // 定时器
//   d.listen(window, 'resize', onResize)// 监听器
//   d.abort(ctrl)                       // AbortController
//
//   // 普通函数里（没有 Vue 作用域）：自己 createDisposables()，由调用方 dispose
//   const d = createDisposables()
//
// 与 utils/userScopedCache.js 的分工：
//   · disposables 管「组件/作用域」维度 —— 组件卸载就该释放的东西。
//   · userScopedCache 管「用户」维度 —— 换号/登出就该失效的进程内缓存。
//   两者同源理念：状态自己登记清理函数，清理方不点名。
// =========================================================================
import { getCurrentScope, onScopeDispose } from 'vue'

// 清理函数抛错不能影响其它资源的释放，也不能让调用方崩掉。
function safeCall(fn) {
  try { fn() } catch (e) { console.warn('[disposables] 释放资源失败：', e) }
}

/**
 * 创建一个资源登记表。
 * @returns {{
 *   add: (fn: Function) => Function,
 *   timeout: (fn: Function, ms: number) => Function,
 *   defer: () => (fn: Function, ms: number) => void,
 *   interval: (fn: Function, ms: number) => Function,
 *   listen: (target: any, type: string, handler: Function, options?: any) => Function,
 *   abort: (controller: { abort: Function }) => Function,
 *   dispose: () => void,
 *   disposed: boolean,
 *   size: number
 * }}
 */
export function createDisposables() {
  const items = []
  let disposed = false

  /**
   * 登记一个清理函数。返回「提前撤销登记」的函数。
   * 已经 dispose 过再登记：立刻执行清理函数（资源不该留在已死的作用域里）。
   */
  function add(fn) {
    if (typeof fn !== 'function') return () => {}
    if (disposed) { safeCall(fn); return () => {} }
    items.push(fn)
    return () => {
      const i = items.indexOf(fn)
      if (i >= 0) items.splice(i, 1)
    }
  }

  /** 一次性定时器。返回取消函数。 */
  function timeout(fn, ms) {
    let timer = null
    const cancel = add(() => { if (timer) { clearTimeout(timer); timer = null } })
    timer = setTimeout(() => { timer = null; cancel(); fn() }, ms)
    return cancel
  }

  /**
   * 「可替换」的一次性定时器调度器：每次调用自动取消上一次未触发的定时器。
   * 典型用途是防抖——输入框每敲一下都要重新排期。
   * 返回的调度器带 .cancel()：手动撤掉仍在排期的那次（如弹窗关闭）。
   * 不需要调用方保存：作用域释放时仍在排期的那个会被清掉。
   */
  function defer() {
    let timer = null
    const cancelTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
    add(cancelTimer)
    const schedule = (fn, ms) => {
      cancelTimer()
      timer = setTimeout(() => { timer = null; fn() }, ms)
    }
    schedule.cancel = cancelTimer
    // 是否还有一个没触发的定时器在排期（调用方常拿它当「已排期」的标志位）
    Object.defineProperty(schedule, 'pending', { get: () => timer !== null })
    return schedule
  }

  /** 周期定时器。返回取消函数。 */
  function interval(fn, ms) {
    const id = setInterval(fn, ms)
    return add(() => clearInterval(id))
  }

  /** 事件监听器：登记时自动配对 removeEventListener（opts 原样传回，capture 必须一致）。 */
  function listen(target, type, handler, options) {
    if (!target || typeof target.addEventListener !== 'function') return () => {}
    target.addEventListener(type, handler, options)
    return add(() => {
      try { target.removeEventListener(type, handler, options) } catch (e) { console.warn('[disposables] 移除监听器失败：', e) }
    })
  }

  /** AbortController：登记后随作用域一起 abort。 */
  function abort(controller) {
    if (!controller || typeof controller.abort !== 'function') return () => {}
    return add(() => { try { controller.abort() } catch (e) { /* 已结束 */ } })
  }

  /** 释放全部已登记资源。可重复调用（第二次是空操作）。 */
  function dispose() {
    if (disposed) return
    disposed = true
    const list = items.splice(0, items.length)
    for (const fn of list) safeCall(fn)
  }

  return {
    add,
    timeout,
    defer,
    interval,
    listen,
    abort,
    dispose,
    get disposed() { return disposed },
    get size() { return items.length },
  }
}

/**
 * 在组件 setup 里创建一个资源登记表，组件卸载时自动释放。
 * 不在 Vue 作用域内调用时退化成普通登记表（由调用方自己 dispose）——
 * 用 getCurrentScope 判定，而不是 getCurrentInstance：前者管的是副作用作用域，
 * 与组件实例代理无关（实例代理在本项目已全库清零）。
 */
export function useDisposables() {
  const d = createDisposables()
  if (getCurrentScope()) onScopeDispose(() => d.dispose())
  return d
}
