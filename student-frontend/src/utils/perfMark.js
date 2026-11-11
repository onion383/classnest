// =========================================================================
// perfMark.js —— 启动 / 首屏分段打点（审查 v6 · P1-01）
//
// 背景：首屏聚合请求约 102ms 里后端只占 7ms，剩下约 95ms 没有归属。原有打点只有
// 「发起 / 就绪」两端，中间（事件循环排队、凭据注入、请求体加密、网络、响应解密、
// JSON.parse、首屏 patch）全是黑的 —— 任何优化都无法证明收益，回归变慢也无法归因。
//
// 设计约束：
//   · **epoch 毫秒**：与主进程 / 后端 Date.now() 同一时钟，日志之间能直接相减。
//   · **纯增量**：配置上没有 `__perf` 就完全空转（子窗口、后台刷新零开销、零日志）。
//   · **失败静默**：打点本身绝不能影响请求；performance 不可用时退回 Date.now。
//   · **一条汇总**：主进程日志按标签去重（同一标签只留第一次），分段逐条打会被吃掉，
//     所以各段先累积，由调用方一次性输出。
// =========================================================================
export function perfNow() {
  try {
    if (typeof performance !== 'undefined' && performance.timeOrigin && performance.now) {
      return Math.round(performance.timeOrigin + performance.now())
    }
  } catch (_) { /* 交给 Date.now 兜底 */ }
  return Date.now()
}

export function perfSince(t0) {
  return perfNow() - t0
}

// 一次请求的分段收集器：挂在 axios config 的自定义字段上，会原样带到响应 config
export function createPhaseLog() {
  return { t0: perfNow(), phases: [] }
}

// 从请求创建到某个拦截器开始之间的耗时（事件循环排队、拦截器链调度）
export function markSince(config, name) {
  const log = config && config.__perf
  if (!log) return
  log.phases.push(`${name} ${perfNow() - log.t0}ms`)
}

// 计时一个阶段；没有 __perf 时返回空操作
export function phase(config, name) {
  const log = config && config.__perf
  if (!log) return () => {}
  const t = perfNow()
  return () => { log.phases.push(`${name} ${perfNow() - t}ms`) }
}

// 输出一条汇总。带 @epoch 是为了兼容 testjs/probe/measure-startup.mjs 的解析格式。
export function logSummary(label, log) {
  try {
    const total = log && log.t0 ? perfSince(log.t0) : 0
    const detail = log && Array.isArray(log.phases) && log.phases.length ? `（${log.phases.join(' / ')}）` : ''
    console.log(`[startup] ${label} 共${total}ms${detail}@${perfNow()}`)
  } catch (_) { /* 打点失败绝不能影响请求 */ }
}

// 标记型打点（只有时刻，没有耗时）；同样失败静默
export function mark(text) {
  try {
    console.log(`[startup] ${text} @${perfNow()}`)
  } catch (_) { /* 打点失败绝不能影响请求 */ }
}
