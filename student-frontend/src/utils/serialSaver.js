// =========================================================================
// serialSaver.js —— 串行保存器（防并发覆盖 + 防抖 + 失败可感知）
//
// 课表这类「每次编辑就 PUT 整块数据」的页面，连续操作会并发发出多个 PUT：
// 后端按到达顺序写库，先发的请求可能后到，最终库里留下的是**更旧**的状态。
// 同时调用处不 await，请求失败时静默，用户以为已保存，刷新后改动消失。
//
// 本工具保证：
//   · 同一时刻最多一个保存请求在途；
//   · 在途期间再来的更新只记一次「脏」，结束后用 saveFn 读取**最新状态**再存一次；
//   · **静默期防抖**：距最后一次 request 满 quietMs 才真正发出保存 ——
//     连打 10 个字只发 1 次整表 PUT（原先每次编辑都发一次）；
//   · 失败后停止本批（不自动重试，避免网络抖动时无限重试），request() 返回 false，
//     由调用方决定是否提示。
// =========================================================================

// 默认静默期（ms）。
// 为什么需要：值日表 / 座位表 / 课表都是「每次编辑就 PUT 整块」，
//   连打 10 个字 = 10 次整表 PUT（每次都带上全部行列）—— 请求量与写库压力都是浪费，
//   而且中途失败会留下半截状态。
// 为什么是 300ms：低于人连续打字的单键间隔（约 100~200ms）的 1.5 倍，
//   既能合并住连续输入，又不会让「点一下保存」明显变慢（用户感知不到 0.3s 延迟）。
const DEFAULT_QUIET_MS = 300

export function createSerialSaver(saveFn, options = {}) {
  const quietMs = Number.isFinite(options.quietMs) ? Math.max(0, options.quietMs) : DEFAULT_QUIET_MS
  let inFlight = false
  let dirty = false
  let lastError = null
  // 在途期间追加的请求：统一等在途保存结束后拿同一个结果（合并成一轮）
  let waiters = []
  // 最后一次 request() 的时刻（静默期以它为基准）
  let lastRequestAt = 0

  const settle = (ok) => {
    const ws = waiters
    waiters = []
    ws.forEach((resolve) => resolve(ok))
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // 等到「距最后一次请求已满 quietMs」为止。
  // 循环等待的原因：等待期间可能又来新的 request（lastRequestAt 被推后），
  //   单次等待会在新输入到达前就放行 → 存了一次「还在改」的中间状态。
  async function waitQuiet() {
    if (!quietMs) return
    for (;;) {
      const remain = quietMs - (Date.now() - lastRequestAt)
      if (remain <= 0) return
      await sleep(remain)
    }
  }

  async function drain() {
    if (inFlight) return new Promise((resolve) => waiters.push(resolve))
    inFlight = true
    let ok = true
    try {
      do {
        // ⚠️ 顺序要紧：**先等静默期，再清 dirty**。
        //   反过来（先清 dirty 再等）会多存一轮：静默期里没有新输入时，
        //   dirty 仍为 true → 循环再跑一次 → 明明只有一次改动却 PUT 了两次
        //   （这正是「连打 10 字仍 2 次整表 PUT」要解决的问题）。
        //
        //   quietMs=0 时**不能 await**：waitQuiet 是 async 函数，
        //   即使立即 return 也会让出微任务 → saveFn 被推迟到微任务之后，
        //   而调用方常在 request() 之后**同步**检查「是否已在途」。
        if (quietMs) await waitQuiet()
        // 清 dirty 要放在 waitQuiet 之后：此刻起 saveFn 读到的是最新状态，
        // 这一轮存完就没有待存的了（除非 saveFn 执行期间又有新输入）。
        dirty = false
        try {
          await saveFn()
          lastError = null
        } catch (e) {
          lastError = e
          ok = false
          dirty = false // 失败后不再继续合并轮次（避免把旧状态又写一遍）
        }
      } while (dirty && ok)
    } finally {
      inFlight = false
      settle(ok)
    }
    return ok
  }

  return {
    // 请求一次保存；返回 boolean（不 reject，调用方漏写 catch 也不会产生未处理拒绝）
    request() {
      dirty = true
      lastRequestAt = Date.now()
      return drain()
    },
    get busy() { return inFlight },
    get error() { return lastError },
    /** 静默期（ms）；传 0 可关闭防抖（每次 request 立即保存） */
    get quietMs() { return quietMs }
  }
}
