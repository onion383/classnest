// =========================================================================
// startup-io.js —— 启动期同步 IO 打点（v6 性能专题 · 1-10，P1-06）
//
// 【为什么只打点、不异步化】
// 主进程把 existsSync / mkdirSync / readFileSync / readdirSync 散在 main.js、main.config.js、
// main.backend.js、main.tray.js、main.protocol.js 里，其中多数处在「建窗之前」的时序关键路径上
// （首启判定、主密钥读取、后端入口探测）。改成异步要重排建窗时序，盲改的风险远大于收益。
// 本卡只解决「没有口径」：先量出总阻塞，合计 < 10ms 就维持同步（见 main.js 的调用点注释），
// 某段显著再单独排异步化卡。
//
// 【实现方式：在 fs 上装一层计时外壳】
// 逐处埋点要改 5 个模块的业务代码；这里在 main.js 最前面（早于所有 business 模块的 require）
// 替换 fs 的同名方法，只加 process.hrtime.bigint() 前后夹取，返回值、异常、this 一律原样透传。
//
// 【已知抓不到的情况】
// `const { existsSync } = require('fs')` 这种解构调用拿到的是替换前的函数引用，计时会漏。
// 主进程现有代码全部走 `fs.xxx()` 形式（已核对 5 个模块），因此不影响结论；后续新增代码
// 也应保持 `fs.xxx()` 写法，否则会把这段统计打歪。
//
// 【默认零开销】
// 只有 PERF_STARTUP=1（与 1-3 / 0-x 的探针同一开关）才安装；未开启时 install() 直接返回 false，
// fs 上一个属性都不动。
// =========================================================================

// 覆盖启动路径上实际出现的同步 IO：清单点名的四个 + 启动期另会同步用到的几个。
// （statSync 见 main.path-guard / startup-timer 落盘；writeFileSync / rmSync / renameSync /
//   copyFileSync 见 main.js 首启标记、config 密钥轮换、userData 迁移。）
const NAMES = [
  'existsSync',
  'mkdirSync',
  'readFileSync',
  'readdirSync',
  'statSync',
  'writeFileSync',
  'appendFileSync',
  'rmSync',
  'renameSync',
  'copyFileSync',
]

let installed = false
let sumCalls = 0
let sumNs = 0
const stats = new Map()

// 合计耗时（毫秒）。未开启采集时恒为 0。
function totalMs() {
  return sumNs / 1e6
}

// 安装计时外壳。fsImpl 可注入（单测用假对象），enabled 默认取 PERF_STARTUP 开关。
// 返回是否真的安装（重复调用 / 开关未开都返回 false）。
function install(fsImpl = require('fs'), { enabled = process.env.PERF_STARTUP === '1' } = {}) {
  if (installed || !enabled || !fsImpl) return false
  for (const name of NAMES) {
    const orig = fsImpl[name]
    if (typeof orig !== 'function') continue
    fsImpl[name] = function timedSyncIo(...args) {
      const t0 = process.hrtime.bigint()
      try {
        return orig.apply(this, args)
      } finally {
        const ns = Number(process.hrtime.bigint() - t0)
        sumCalls += 1
        sumNs += ns
        const cur = stats.get(name) || { count: 0, ns: 0 }
        cur.count += 1
        cur.ns += ns
        stats.set(name, cur)
      }
    }
  }
  installed = true
  return true
}

// 是否已安装（也用于 main.js 判断要不要在启动完成时汇总）。
function isInstalled() {
  return installed
}

// 汇总：按方法降序返回 [{ name, count, ms }]，并给出合计。
function collect() {
  const rows = [...stats.entries()]
    .map(([name, v]) => ({ name, count: v.count, ms: v.ns / 1e6 }))
    .sort((a, b) => b.ms - a.ms)
  return { calls: sumCalls, ms: totalMs(), rows }
}

// 打印 + 往启动时间线补一条 mark，让日志与性能面板都能看到「同步 IO 合计」。
// 放在 startupTimer.report() 之前调用（main.js 的 onFinal 里），报告就会带上这条。
function summarize({ console: out = console } = {}) {
  if (!installed) return null
  const r = collect()
  const label = `同步IO合计 ${r.ms.toFixed(1)}ms / ${r.calls} 次`
  try { out.log(`[boot] ${label}`) } catch (_) { /* 打点失败静默 */ }
  for (const row of r.rows) {
    if (!row.count) continue
    try { out.log(`[boot] fs.${row.name} ${row.ms.toFixed(2)}ms × ${row.count}`) } catch (_) { /* 忽略 */ }
  }
  try { require('./main.startup-timer').mark(label) } catch (_) { /* 时间线不可用则只打印 */ }
  return r
}

// 单测复位（生产代码不调用）。
function reset() {
  installed = false
  sumCalls = 0
  sumNs = 0
  stats.clear()
}

module.exports = { install, isInstalled, summarize, collect, totalMs, reset, NAMES }
