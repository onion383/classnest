import axios from 'axios'
import { registerUserScopedReset, userScopedGeneration } from './userScopedCache.js'

// 学期开始日期（/api/schedule/settings 里的 semester_start）。
//
// 它在一学期内不会变，但值日指数、座位指数、课表加载都会去取它 ——
// 每次切周 / 补存 / 撤销都多发一个 GET，纯属重复。这里做进程内缓存：
//   · 并发调用共享同一个在途请求（不会因为同时进两个页面而发两次）
//   · 失败**不缓存**，下次调用会自动重试（后端没起来时不至于一直空着）
//   · 设置页保存学期后调用 invalidateSemesterStart() 失效
let cached = null
let inflight = null

export async function getSemesterStart() {
  if (cached !== null) return cached
  if (!inflight) {
    // 代次守卫：请求发出时记下登录代次，回来时若已换号，这份开学日属于上一个库，
    // 不能写 cached / 不能返回给界面，改为按新用户重拉（审查 v5 · V5-004）。
    const gen = userScopedGeneration()
    const req = axios.get('/api/schedule/settings')
      .then((r) => {
        if (gen !== userScopedGeneration()) {
          if (inflight === req) inflight = null
          cached = null
          return getSemesterStart()
        }
        const v = (r.data && r.data.semester_start) || ''
        cached = v
        return v
      })
      .finally(() => { if (inflight === req) inflight = null })
    inflight = req
  }
  return inflight
}

// 学期设置被改动后调用；不清的话值日/座位会一直按旧的开学期结算
export function invalidateSemesterStart() {
  cached = null
  inflight = null
}

// 登出/换号也必须失效：开学日是**某个库**的设置，换一个账号看到的是别人的学期
registerUserScopedReset(invalidateSemesterStart)
