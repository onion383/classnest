// =========================================================================
// inpLog.js —— INP 归因落盘（仅开发模式）
//
// 渲染层的 INP 探针（student-frontend/src/utils/inpProbe.js）每次导出汇总时，
// 把数据经 'inp-report' 通道发到这里，本模块追加写入 <数据目录>/inp.log，
// 便于不开 DevTools 也能直接读文件分析。
//
// payload 结构（三段）：
//   { reason, categories: [...], details: [...], longTasks: [...] }
//   categories —— 按交互类别聚合（切换页面 / 打开弹窗 / 确认保存 / 表格输入 …）
//   details    —— 最慢交互明细 Top N
//   两者行格式一致：{ <首列键>, 次数, 最长, 输入延迟, 处理, 呈现, 典型 }
//   longTasks  —— 不挂在交互上的主线程长任务：{ 时长, 名称, 路由, 目标 }
//
// 与启动打点同一套 dev 门控：仅在开发模式注册（统一走 main.env 的 isDev 判定），
// 打包版既不 require 本模块、也不注册该通道，不会产生任何日志文件。
// =========================================================================

const { CH, IPC } = require('./channels')
const path = require('path')
const { isDev } = require('./main.env')
const { resolveLogsDir } = require('./main.config')
const { appendWithRotation } = require('./main.logRotator')

// 把行数组格式化成日志行；keyName 为「类别」或「交互」
function formatRows(rows, keyName) {
  return rows.map((r) => {
    const parts = [
      `${r[keyName]}`,
      `次数=${r.次数}`,
      `最长=${r.最长}ms（输入延迟=${r.输入延迟} / 处理=${r.处理} / 呈现=${r.呈现}）`,
    ]
    // 明细行的首列本身已是「事件 → 元素」，再附「典型」就重复了
    if (keyName === '类别' && r.典型) parts.push(`典型=${r.典型}`)
    return parts.join('  ')
  })
}

function formatLongTasks(rows) {
  return rows.map((r) => {
    const parts = [`${r.时长}ms`, `${r.名称 || 'unknown'}`]
    if (r.路由) parts.push(`路由=${r.路由}`)
    if (r.目标) parts.push(`目标=${r.目标}`)
    return parts.join('  ')
  })
}

function registerInpLogIpc() {
  if (!isDev) return // 打包版：不注册，永不落盘
  IPC.on(CH.INP_REPORT, (_event, payload) => {
    try {
      const p = payload || {}
      const categories = Array.isArray(p.categories) ? p.categories : []
      const details = Array.isArray(p.details) ? p.details : []
      const longTasks = Array.isArray(p.longTasks) ? p.longTasks : []

      const lines = [`===== INP 归因 @ ${new Date().toISOString()}（${p.reason || ''}，单位 ms）=====`]
      if (!categories.length && !details.length && !longTasks.length) {
        lines.push('（本轮无 ≥40ms 的交互样本或 ≥16ms 的长任务）')
      } else {
        if (categories.length) {
          lines.push('-- 按交互类别 --')
          lines.push(...formatRows(categories, '类别'))
        }
        if (details.length) {
          lines.push('-- 最慢交互明细 --')
          lines.push(...formatRows(details, '交互'))
        }
        if (longTasks.length) {
          lines.push('-- 主线程长任务（≥16ms）--')
          lines.push(...formatLongTasks(longTasks))
        }
      }
      lines.push('')

      const file = path.join(resolveLogsDir(), 'inp.log')
      // 1-1：写前按体积轮转（1MB 封顶、保留最近 512KB），异步追加。
      // 旧实现每次 appendFileSync 且无上限，开发期反复导出会一直涨。
      appendWithRotation(file, lines.join('\n'), { maxBytes: 1024 * 1024, keepBytes: 512 * 1024 })
    } catch (_) { /* 忽略写入失败 */ }
  })
}

module.exports = { registerInpLogIpc }
