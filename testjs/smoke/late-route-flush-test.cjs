/**
 * late-route-flush-test.cjs —— 启动期「延后路由按需注册」真实 HTTP 回归
 *
 * 背景：app.js 把 /api/data、/api/fee-records 的 require 延后 800ms（让出首屏）。
 * 但界面可见在 ~479ms，这 800ms 里用户点进「数据管理 / 班费明细」原本会拿到 404。
 * 修法：命中延后前缀的中间件同步 flush 注册，再 next() 让本次请求继续走。
 *
 * 这里用隔离后端做行为断言，专门补源码判据抓不到的东西：
 *   · 就绪后 0ms 打 /api/ai/config 也不是 404 —— 首屏依赖的路由已在 listen 之前挂好，
 *     不再等让路链跑到链尾（慢机器上链要 ~85ms，AI 入口原本会消失到下次刷新）；
 *   · 环境变量真的生效（日志里出现「让路链延后 800ms」），否则「不是 404」可能是
 *     路由压根没延后造成的假绿；
 *   · 请求处理期间 app.use 追加的 layer，同一次请求就能命中；
 *   · 前缀边界精确，不能把 /api/datax 也一起放行；
 *   · 定时到点复用同一入口后，路由仍可用（幂等没把栈弄坏）。
 *
 * 跑法：node testjs/smoke/late-route-flush-test.cjs
 * 退出码：0 = 全部通过；1 = 有断言失败
 */
const { startIsolatedBackend } = require('./_isolated-backend.cjs')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  → ${detail}`}`)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const h = await startIsolatedBackend({
    env: { CLASSNEST_LATE_LOAD_DELAY_MS: '800', PERF_STARTUP: '1' },
  })
  try {
    const hit = async (p) => {
      const r = await fetch(h.base + p)
      return r.status
    }

    // 第一个请求必须是 ai：就绪后 0ms 打，此刻让路链还在 warmup（~68ms）/ loader 阶段，
    // 排在链尾的 /api/ai 完整 router 尚未注册 —— 这正是原先 404 的复现窗口。
    const ai = await hit('/api/ai/config')
    check('就绪后 0ms /api/ai/config 不是 404（首屏依赖不等让路链）', ai !== 404, `status=${ai}`)

    // 就绪后立刻打：此刻 800ms 延后远未走完。
    const data = await hit('/api/data')
    const fee = await hit('/api/fee-records')
    const boundary = await hit('/api/datax')
    check('延后窗口内 /api/data 不是 404（按需注册生效）', data !== 404, `status=${data}`)
    check('延后窗口内 /api/fee-records 不是 404（按需注册生效）', fee !== 404, `status=${fee}`)
    check('相似前缀 /api/datax 仍是 404（门卫没误伤）', boundary === 404, `status=${boundary}`)

    await wait(1000)
    const after = await hit('/api/data')
    check('定时到点后 /api/data 仍可用（两条路径共用一次注册）', after !== 404, `status=${after}`)
    check('后端确实进入了 800ms 延后窗口（防环境变量没生效的假绿）', h.log().includes('让路链延后 800ms'))
  } finally {
    await h.stop()
  }

  console.log(failed ? `\n失败 ${failed} 条` : '\n全部通过')
  process.exit(failed ? 1 : 0)
})().catch((err) => {
  console.error('[late-route-flush] 执行失败:', err)
  process.exit(1)
})
