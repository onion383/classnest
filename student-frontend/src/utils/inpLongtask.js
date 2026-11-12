// =========================================================================
// inpLongtask.js —— 主线程长任务观察（纯逻辑，便于单测）
//
// 背景：inpProbe 原来只订阅 event-timing，只看「有交互的长任务」。数据到达后
// 批量渲染、markdown 重解析、大表挂载、排表算法同步段这些不挂在交互上的
// 主线程阻塞，在 INP 条目里完全不可见。
//
// 这里把「阈值判定 / 行格式 / 观察器装配」抽成不依赖 import.meta.env 的纯模块：
//   · inpProbe 负责 DEV 门控与 dump 汇总；
//   · 本模块只做「哪些条目要记、记成什么形状、观察器怎么装」。
// 阈值取 16ms（一帧），上报时不再二次过滤 —— 过滤留在观察器入口，避免
// 先收后丢造成无谓的对象分配。
// =========================================================================

// 一帧的预算；<16ms 的长任务没有优化价值，也不该刷满日志
export const LONG_TASK_MIN = 16

// 单次 dump 最多带多少条长任务（防止长时间 dev 会话把 payload 撑大）
export const LONG_TASK_KEEP = 50

export function isLongTask(entry) {
  return !!entry && Number(entry.duration) >= LONG_TASK_MIN
}

// 一条长任务的可读行；route / target 由调用方注入，纯函数不读全局
export function longTaskRow(entry, extra = {}) {
  return {
    时长: Math.round(Number(entry.duration) || 0),
    名称: String(entry.name || 'unknown'),
    路由: String(extra.route || ''),
    目标: String(extra.target || ''),
  }
}

// 装配 longtask 观察器：
//   Observer  —— PerformanceObserver 构造器（测试可注入假实现）
//   supported —— PerformanceObserver.supportedEntryTypes 是否含 longtask
//   onRecord  —— 每条达标条目的回调（抛错不影响后续条目）
//   warn      —— 装配失败时的告警出口（缺省静默）
// 返回观察器实例；不支持或 observe 抛错时返回 null，调用方据此跳过。
export function createLongtaskObserver({ Observer, supported, onRecord, warn }) {
  if (!Observer || !supported) return null
  const handler = (list) => {
    for (const entry of list.getEntries()) {
      if (!isLongTask(entry)) continue
      try { onRecord && onRecord(entry) } catch (_) { /* 单条失败不影响后续 */ }
    }
  }
  let observer = null
  try {
    observer = new Observer(handler)
    observer.observe({ type: 'longtask', buffered: true })
    return observer
  } catch (err) {
    try { warn && warn(err) } catch (_) { /* 告警失败静默 */ }
    return null
  }
}

// 打包版按需采样（PERF_LONG_TASK=1 → preload 注入 --perf-long-task）：
// 只记录 ≥min 的长任务，最多 max 条；用 [startup] 标记带 epoch，主进程会写进 startup.log。
// 默认不安装，正常启动零日志、零观察器。
export function installLongTaskMarks({ min = 50, max = 20, Observer, supported, now } = {}) {
  const Ctor = Observer || (typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null)
  const ok = supported != null
    ? supported
    : !!(Ctor && Ctor.supportedEntryTypes && Ctor.supportedEntryTypes.includes('longtask'))
  let count = 0
  return createLongtaskObserver({
    Observer: Ctor,
    supported: ok,
    onRecord: (entry) => {
      if (entry.duration < min || count >= max) return
      count++
      try {
        const epoch = typeof now === 'function'
          ? now(entry)
          : Math.round((performance.timeOrigin || Date.now()) + entry.startTime)
        const route = typeof location !== 'undefined' ? (location.hash || location.pathname || '/') : ''
        console.log(`[startup] 长任务 ${Math.round(entry.duration)}ms ${route} @${epoch}`)
      } catch (_) { /* 打点失败静默 */ }
    },
  })
}
