// =========================================================================
// main.eventloop.js —— 主进程事件循环延迟观测（v6 性能专题 · 0-7）
//
// 为什么需要：渲染层有 longtask 观察者（inpProbe），但主进程里的同步 1MB 日志截断、
// 大 Buffer 拼装、导出期间的主线程计算，渲染层完全看不见。心跳只能发现「假死」，
// 发现不了 50~500ms 的阻塞。
//
// 做法：perf_hooks.monitorEventLoopDelay 按固定分辨率采样，读的时候取分位数并重置窗口。
//   · 只在读的时候格式化，不常驻定时器；
//   · start 幂等，重复调用返回同一个 histogram；
//   · stop 用于测试/退出，正常进程退出不需要显式调用。
// =========================================================================

const { monitorEventLoopDelay } = require('perf_hooks')

// 采样分辨率：20ms 足够覆盖 >50ms 的阻塞，又不会自身造成明显开销
const RESOLUTION_MS = 20
// 单次窗口内 max 或 p95 超过该值才打日志，避免每次快照都刷屏
const WARN_MAX_MS = 50
const WARN_P95_MS = 30

let histogram = null

// 纳秒 → 毫秒，保留 1 位小数（50.4ms 比 50ms 更有用于判断量级）
function nsToMs(ns) {
  return Math.round(Number(ns) / 1e5) / 10
}

// 纯格式化：测试可直接注入假 histogram（percentile/max/count 三个字段）
function statsFromHistogram(h) {
  if (!h) return null
  return {
    p50: nsToMs(h.percentile(50)),
    p95: nsToMs(h.percentile(95)),
    p99: nsToMs(h.percentile(99)),
    max: nsToMs(h.max),
    count: Number(h.count) || 0,
  }
}

function startEventLoopSampling({ resolution = RESOLUTION_MS } = {}) {
  if (histogram) return histogram
  try {
    histogram = monitorEventLoopDelay({ resolution })
    histogram.enable()
  } catch (_) {
    // 老版本 Node / 受限环境：不观测，调用方按 null 处理
    histogram = null
  }
  return histogram
}

// 读取当前窗口的分位数；默认读后重置，让下一次读到的仍是「这段时间」而不是累计值
function readEventLoopStats({ reset = true } = {}) {
  const stats = statsFromHistogram(histogram)
  if (reset && histogram) {
    try { histogram.reset() } catch (_) { /* 重置失败不影响本次读数 */ }
  }
  return stats
}

// 在明确的时间边界（启动后、后端重启、大导出结束）读一次并留痕；
// 未超阈值时静默，避免正常路径产生噪音。
function markEventLoopWindow(label) {
  const stats = readEventLoopStats({ reset: true })
  if (!stats) return null
  if (stats.max >= WARN_MAX_MS || stats.p95 >= WARN_P95_MS) {
    try {
      console.log(`[perf] 事件循环 ${label} p50=${stats.p50}ms p95=${stats.p95}ms max=${stats.max}ms 样本=${stats.count}`)
    } catch (_) { /* 日志失败静默 */ }
  }
  return stats
}

function stopEventLoopSampling() {
  try { if (histogram) histogram.disable() } catch (_) { /* 忽略 */ }
  histogram = null
}

module.exports = {
  startEventLoopSampling,
  readEventLoopStats,
  markEventLoopWindow,
  stopEventLoopSampling,
  statsFromHistogram,
}
