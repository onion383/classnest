// =========================================================================
// startup-timer.js —— 启动事件计时器
//
// 在 Electron 主进程中记录关键启动事件的时间戳，输出到控制台和日志文件。
// 用于量化启动优化效果，定位瓶颈。
//
// 用法：
//   const timer = require('./main.startup-timer')
//   timer.mark('事件名称')
//   timer.report()  // 打印完整时间线
// =========================================================================

const path = require('path')
const fs = require('fs')

const marks = []
const startTime = Date.now()

// 起点校正：上面的零点只是「本计时器被 require」的时刻，而主进程 JS 此前已经跑了一段——
// 更早还隔着「Electron 进程创建 → Chromium/Node 引导 → main.js 顶层 require」。
// process.getCreationTime() 给出进程创建时刻，把这段量出来并计入总耗时；
// 取不到时保持 null，总耗时就退回旧口径（计时器加载 → 可见）。
let preStartMs = null
try {
  const createdAt = typeof process.getCreationTime === 'function' ? process.getCreationTime() : null
  if (typeof createdAt === 'number' && createdAt > 0 && createdAt <= startTime) {
    // 刻意保留原样小数：getCreationTime() 给的是微秒级精度的毫秒值（如 126.85693359375），
    // 这份精度会顺着 totalMs() 一路带到控制台与设置页性能面板（面板按秒呈现），不作截断。
    preStartMs = startTime - createdAt
  }
} catch (_) { /* 信息不可用则跳过校正 */ }

// 「启动完成」锚点。口径（2026-10-31 统一，日志与性能面板同一口径）：
//   进程创建 → **占位页移除**（界面真正可见）
// 不用「窗口首次显示」——窗口出来了但还盖着占位页，用户盯着的是占位页，两者实证相差
// 369~461ms（后端快时），后端冷启动时可达 2~4.5 秒。
//
// 三级语义：
//   - 候选（provisional）：主窗口显示时登记「窗口首次显示」时刻，不定稿；
//   - 定稿（final）：渲染层报来「占位页移除」时用它自报的 epoch 时刻定稿，覆盖候选；
//   - 兜底：占位页永不移除的异常路径（后端失败时占位页保留作为失败提示载体）由
//     settleProvisional() 用候选时刻收尾，避免锚点永远空缺。
// 引导窗口等没有占位页的路径仍直接 end() 定稿，保持「引导页停留不计入启动耗时」的既有语义。
let endElapsed = null
let endFinal = false
let endName = ''
const finalListeners = []

function mark(name) {
  const now = Date.now()
  const elapsed = now - startTime
  marks.push({ name, time: now, elapsed })
  // 同时输出到控制台，方便实时观察
  console.log(`[startup] +${elapsed}ms  ${name}`)
}

// 用「事件真实发生时刻」打点：epochMs 为毫秒级 epoch（渲染层传 performance.timeOrigin + performance.now()）。
// 渲染层日志经 console-message 送到主进程存在几十毫秒投递延迟，按送达时刻打点会把这段延迟算进耗时；
// 由渲染层自报时刻、主进程只做搬运，即可去掉它。
// 数值越界（落在零点之前或远超本次启动）时退回送达时刻，避免脏值污染时间线。
function markAt(name, epochMs) {
  const at = Number(epochMs)
  if (!Number.isFinite(at) || at < startTime || at > startTime + 600000) return mark(name)
  const elapsed = Math.round(at - startTime)
  marks.push({ name, time: at, elapsed })
  console.log(`[startup] +${elapsed}ms  ${name}`)
}

function msFromStart() {
  return Date.now() - startTime
}

// 锚点落定的统一入口。elapsed 为「相对计时零点的毫秒数」。
//   final=false：候选锚点，仅在没有锚点时生效（多个窗口依次显示时只认第一个）；
//   final=true ：定稿，可覆盖候选（这正是「占位页移除」覆盖「窗口首次显示」的路径），
//                定稿之后不再接受任何修改（幂等）。
function settle(elapsed, name, final) {
  if (endFinal) return
  if (endElapsed !== null && !final) return
  endElapsed = elapsed
  endName = name
  console.log(`[startup] +${elapsed}ms  ${final ? '启动完成' : '候选锚点（等占位页移除定稿）'}${name ? '：' + name : ''}`)
  if (!final) return
  endFinal = true
  for (const fn of finalListeners) {
    try { fn() } catch (_) { /* 监听器异常不影响锚点 */ }
  }
}

// 直接定稿：引导窗口 / 低版本提示等「没有占位页」的路径使用（取当前时刻）。
function end(name = '') {
  settle(msFromStart(), name, true)
}

// 按事件真实发生时刻定稿：渲染层自报的 epoch 毫秒（performance.timeOrigin + performance.now()）。
// 数值越界（落在零点之前或远超本次启动）时退回当前时刻，避免脏值污染总耗时。
function endAt(epochMs, name = '') {
  const at = Number(epochMs)
  if (!Number.isFinite(at) || at < startTime || at > startTime + 600000) return settle(msFromStart(), name, true)
  settle(Math.round(at - startTime), name, true)
}

// 登记候选锚点：主窗口首次显示时调用。不定稿——真正的终点是稍后的「占位页移除」。
function endProvisional(name = '') {
  settle(msFromStart(), name, false)
}

// 兜底定稿：用已登记的候选时刻收尾（占位页始终未移除时），避免总耗时空缺。
function settleProvisional(name = '') {
  if (endFinal) return
  settle(endElapsed !== null ? endElapsed : msFromStart(), name, true)
}

function isFinal() {
  return endFinal
}

// 锚点定稿后的回调：日志落盘必须等它，否则 total 还停在候选值上。
function onFinal(fn) {
  if (typeof fn !== 'function') return
  if (endFinal) { try { fn() } catch (_) {} ; return }
  finalListeners.push(fn)
}

// 总耗时 = 「计时起点 → 事件」的耗时 + 「进程创建 → 计时起点」的前段（取不到前段时即为旧口径）
function totalMs() {
  const tail = endElapsed !== null
    ? endElapsed
    : (marks.length > 0 ? marks[marks.length - 1].elapsed : 0)
  return tail + (preStartMs || 0)
}

// 总耗时后缀：标出锚点名称与是否已定稿，便于区分「窗口显示（候选）」与「占位页移除（定稿）」。
function anchorNote() {
  if (endElapsed === null) return ''
  return `（锚点：${endName || '未命名'}${endFinal ? '' : '，未定稿'}）`
}

// 结构化时间线：供性能面板读取（不改动原有 report/saveLog 的日志输出格式）。
// 返回 { total, preStartMs, marks: [{ label, at, delta }] }，at/delta 单位均为毫秒。
// total 优先取「启动完成」锚点；未设定锚点（如异常路径）时回退到最后一条 mark。
// 两者都额外并入 preStartMs（进程创建 → 计时起点），与 report/saveLog 的总耗时口径一致。
function getTimeline() {
  const list = marks.map((m, i) => ({
    label: m.name,
    at: m.elapsed,
    delta: i === 0 ? 0 : m.elapsed - marks[i - 1].elapsed,
  }))
  return { total: totalMs(), preStartMs, marks: list }
}

function report() {
  console.log('\n========== 启动时间线 ==========')
  if (marks.length === 0) {
    console.log('  （无事件记录）')
    console.log('=================================\n')
    return
  }
  if (preStartMs !== null) {
    console.log(`  （零点为主进程计时器加载；Electron 进程创建更早 ${preStartMs}ms，已并入总耗时）`)
  }
  const first = marks[0]
  for (const m of marks) {
    const gap = m === first ? 0 : m.elapsed - (marks[marks.indexOf(m) - 1]?.elapsed || 0)
    console.log(`  +${String(m.elapsed).padStart(5)}ms  ${m.name}  (间隔 ${gap}ms)`)
  }
  // 总耗时口径与性能面板一致：优先取「启动完成」锚点，未设锚点时回退到最后一条 mark
  console.log(`  总耗时: ${totalMs()}ms${anchorNote()}`)
  console.log('=================================\n')
}

// 写入日志文件（可选）
function saveLog(filePath) {
  if (!filePath) {
    try {
      // v2 布局：启动时间线进 <数据根>/logs/，与其它日志同层
      const { resolveLogsDir } = require('./main.config')
      filePath = path.join(resolveLogsDir(), 'startup.log')
    } catch (_) {
      return
    }
  }
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    // 体积兜底：这份日志每次启动都追加，正式版里也没有门控，长期用下去会无限增长。
    // 它只用于排查启动耗时，超过 512KB 就只保留最近一半（保留末尾，最新一次启动总在）。
    try {
      const st = fs.statSync(filePath)
      if (st.size > 512 * 1024) {
        const tail = fs.readFileSync(filePath, 'utf8').slice(-256 * 1024)
        fs.writeFileSync(filePath, '（历史日志已截断，仅保留最近部分）\n' + tail)
      }
    } catch (_) { /* 首次启动文件不存在，忽略 */ }
    const lines = marks.map((m, i) => {
      const gap = i === 0 ? 0 : m.elapsed - marks[i - 1].elapsed
      return `+${String(m.elapsed).padStart(5)}ms  ${m.name}  (间隔 ${gap}ms)`
    })
    const content = [
      `===== 启动时间线 @ ${new Date().toISOString()} =====`,
      preStartMs !== null ? `（进程创建 → 计时起点: ${preStartMs}ms，已并入总耗时）` : null,
      ...lines,
      `总耗时: ${totalMs()}ms${anchorNote()}`,
      '',
    ].filter((l) => l !== null).join('\n')
    fs.appendFileSync(filePath, content)
  } catch (_) { /* 忽略写入失败 */ }
}

module.exports = { mark, markAt, end, endAt, endProvisional, settleProvisional, isFinal, onFinal, msFromStart, report, saveLog, getTimeline }