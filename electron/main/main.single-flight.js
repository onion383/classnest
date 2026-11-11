// ==================== 单飞（single-flight）====================
// 把一个异步任务收敛成「同一时刻只跑一份」：在途期间的重复调用拿到**同一个** Promise，
// 不会各自再跑一遍；任务结束后清空，下次调用重新开始。
//
// 为什么需要它：`startBackend()` 是 fire-and-forget（10 处调用点），而真正 fork 子进程的
// `compileBackendProcess()` 是 async（fork 前要 await 主密钥）。两次快速调用会在 await
// 期间各跑一遍 → fork 出两个后端抢同一个端口 → EADDRINUSE 无限重试 → 启动卡死/白屏。
//
// 不依赖 electron：纯 Promise 语义，可以直接 node 单测。
function createSingleFlight(task) {
  if (typeof task !== 'function') throw new TypeError('createSingleFlight 需要函数');
  let inflight = null;
  return function run(...args) {
    if (inflight) return inflight;
    // 用 async 立即执行而不是 Promise.resolve().then()：任务体里的**同步副作用**
    // （置 backendReady=false、广播状态）必须在这一刻就发生，不能延后一个微任务。
    inflight = (async () => task(...args))().finally(() => { inflight = null; });
    return inflight;
  };
}

module.exports = { createSingleFlight };
