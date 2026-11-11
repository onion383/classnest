import axios from 'axios'
import { registerUserScopedReset, userScopedGeneration } from '../utils/userScopedCache.js'
import { createPhaseLog, logSummary, perfNow } from '../utils/perfMark.js'

// ===========================================================================
// 首屏数据预取：Dashboard 首页所需的 9 份数据，改由后端聚合接口 /api/dashboard
// 一次请求返回（1 次 HTTP + 1 次加解密），请求发起时刻仍在「路由导航进入首页时」
// （见 router 守卫 ensureDashboardData()），与 Dashboard 组件 bundle 并行加载。
//
// 共享设计：模块级缓存 + 进行中 Promise，避免 Dashboard 挂载时重复发同样的请求。
// force=true 强制刷新（供切回首页时用，见 onActivated）。
// ===========================================================================

let dataCache = null // 最近一次成功的数据快照
let pending = null   // 进行中的请求 Promise（共享）

// 启动归因：首屏聚合请求的**真实发起时刻**，只打第一次。
//
// 为什么需要它：以前只知道「首页数据就绪」在哪一刻，于是「请求发得晚」和「后端处理得慢」
// 两种可能无法区分。这条打点用 epoch 毫秒（与主进程 / 后端 Date.now() 同一时钟），
// 和后端 `[boot] dashboard 首屏聚合（进入 <epoch>）` 直接相减，就是「axios 管线 + 网络 + 排队」的耗时。
let bootMarked = false
function bootMark(name) {
  try {
    console.log(`[startup] ${name} @${perfNow()}`)
  } catch (_) { /* 打点失败绝不能影响请求 */ }
}

// 完成时一次性汇总。重试次数来自 axios 拦截器记在 config 上的 __retryCount ——
// 「首屏请求撞了几次『后端未就绪』」只有这条能看出来：每次重试单独打点会被主进程的
// 标签去重规则吃掉（同一标签只认第一次），汇总成一条反而更清楚。
//
// 分段（排队/凭据/加密/发送/解密）由各拦截器累积到 perfLog 里，这里一次性输出：
// 否则同一标签的多条日志会被主进程去重，只留下最早那条，等于白打。
let summaryMarked = false
function bootSummary(tag, config, perfLog) {
  if (summaryMarked) return
  summaryMarked = true
  const retries = (config && config.__retryCount) || 0
  logSummary(`首屏请求汇总 ${tag} 重试${retries}次`, perfLog)
}

// 登出/换号必须丢掉这份快照：它是整个库的数据（成绩/班费/学生名册），
// 留着就等于把上一个账号的班级数据展示给下一个人（审查 v4 · B06-02）。
registerUserScopedReset(() => { dataCache = null; pending = null })

// 兜底归一：聚合接口已按约定返回各键，这里只补缺省值，保证调用方拿到的形状稳定。
function normalize(d) {
  return {
    schedule: (d && d.schedule) || { cells: [], settings: {} },
    duty: (d && d.duty) || { cells: {}, settings: {} },
    countdowns: (d && d.countdowns) || [],
    leaves: (d && d.leaves) || [],
    students: (d && d.students) || [],
    scores: (d && d.scores) || [],
    activities: (d && d.activities) || [],
    fees: (d && d.fees) || [],
    album: (d && d.album) || [],
  }
}

function fetchAll() {
  // 失败**不能**伪装成「空数据」：早先这里写的是 `.catch(() => normalize(null))`，
  // 于是后端一旦不可达，首页就显示「全班 0 人、0 条记录」，老师第一反应是数据丢了。
  // 现在让失败如实冒泡（dataCache 不会被写入，下次进首页会重新拉），由调用方显示错误态。
  //
  // 代次守卫：请求发出时记下登录代次，回来时若已经换号（登出/登录别人），
  // 这份数据属于上一个账号，**不写缓存、不返回给界面**，改为按新用户重拉
  // （审查 v5 · V5-004：原先 reset 只置 null，在途 Promise 回来仍写回 dataCache）。
  const gen = userScopedGeneration()
  // 首屏分段归因：__perf 会原样带到响应 config，各拦截器往里追加阶段耗时
  // （排队/凭据/加密/发送/解密），最后由 bootSummary 汇总成一条。
  const perfLog = createPhaseLog()
  if (!bootMarked) { bootMarked = true; bootMark('首页数据发起') }
  const req = axios.get('/api/dashboard', { __perf: perfLog }).then((res) => {
    bootSummary('就绪', res && res.config, perfLog)
    if (gen !== userScopedGeneration()) {
      if (pending === req) pending = null
      dataCache = null
      // 直接走 fetchAll 而不是 ensureDashboardData：后者会复用旧 pending，
      // 旧 pending 正是本次要作废的请求，会绕回这里形成递归。
      return fetchAll()
    }
    return normalize(res && res.data)
  }, (err) => {
    // 失败要原样抛出去（dataCache 不写入、由调用方显示错误态），这里只旁路记一条。
    bootSummary('失败', err && err.config, perfLog)
    throw err
  })
  pending = req
  // 成功/失败都要清掉 pending；用 then 的双回调而不是 .finally()，
  // 否则 finally 返回的新 Promise 在失败时没人接，会变成 unhandledrejection。
  // 只在仍是自己时才清：换号后新请求可能已经接管 pending，别把新引用抹掉。
  req.then(() => { if (pending === req) pending = null }, () => { if (pending === req) pending = null })
  return req
}

// 取数据：force=true 时丢弃本地缓存重新拉取一次
export function ensureDashboardData(force = false) {
  if (force) dataCache = null
  if (dataCache) return Promise.resolve(dataCache)
  if (pending) return pending
  return fetchAll().then((d) => {
    dataCache = d
    return d
  })
}