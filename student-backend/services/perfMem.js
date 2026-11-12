// =========================================================================
// perfMem.js —— 导出内存峰值探针（v6 性能专题 · 0-5）
//
// 只做一件事：PERF_EXPORT=1 时，在导出前后采 process.memoryUsage() 并打一条差值。
// 默认关闭（返回 null / 空操作），普通导出零额外开销。
//
// 为什么用环境变量而不是面板开关：这条通路要在「真机大收据导出」时测，
// 改代码再打包成本高于启动时设一个环境变量；测完关掉即可。
// =========================================================================

const MB = 1048576
const round = (n) => Number.isFinite(n) ? Math.round(n / MB * 10) / 10 : 0

function enabled() {
  return process.env.PERF_EXPORT === '1'
}

// 关闭时返回 null（调用方只负责原样传给 logExportMemory）
function memSnapshot() {
  if (!enabled()) return null
  const m = process.memoryUsage()
  return { rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers || 0 }
}

function logExportMemory(label, before) {
  if (!before || !enabled()) return null
  const after = memSnapshot()
  if (!after) return null
  const delta = {
    rssMB: round(after.rss - before.rss),
    heapMB: round(after.heapUsed - before.heapUsed),
    externalMB: round(after.external - before.external),
  }
  try {
    console.log(`[perf] 导出内存 ${label} rss ${delta.rssMB >= 0 ? '+' : ''}${delta.rssMB}MB / heap ${delta.heapMB >= 0 ? '+' : ''}${delta.heapMB}MB / external ${delta.externalMB >= 0 ? '+' : ''}${delta.externalMB}MB`)
  } catch (_) { /* 日志失败静默 */ }
  return delta
}

module.exports = { memSnapshot, logExportMemory, enabled }
