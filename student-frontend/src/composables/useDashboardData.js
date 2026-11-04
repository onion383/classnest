import axios from 'axios'
import { registerUserScopedReset, userScopedGeneration } from '../utils/userScopedCache.js'

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
  const req = axios.get('/api/dashboard').then((res) => {
    if (gen !== userScopedGeneration()) {
      if (pending === req) pending = null
      dataCache = null
      // 直接走 fetchAll 而不是 ensureDashboardData：后者会复用旧 pending，
      // 旧 pending 正是本次要作废的请求，会绕回这里形成递归。
      return fetchAll()
    }
    return normalize(res && res.data)
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