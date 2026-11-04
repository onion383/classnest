// =========================================================================
// ipc-contract.js —— 主进程 IPC 结果契约（失败 / 取消 分离）
//
// 存在的原因（审查 v4 · B01-06）：
//   save-file 写盘失败时返回的是 `{ canceled: true, error: '...' }`，
//   而前端 utils/saveFile.js 只看 `!result.canceled`：
//
//     if (result && !result.canceled && result.filePath) { ...成功... }
//     return ''                                    // ← 失败与取消都落到这里
//
//   结果是**真写盘失败被当成用户点了取消**：文件没写出来，界面却一声不吭，
//   用户以为「我取消了」，实际是「保存失败了但没人告诉我」。
//
// 根因不是「漏了个 if」，而是「取消」和「失败」**共用一个字段**表达，
// 两者在前端根本无法区分。这个模块把三种结局拆成三种形状：
//
//   ok(payload)          成功
//   fail(error)          失败（操作没做成，且用户需要知道原因）
//   canceled()           取消（用户主动放弃，做成与否无关）
//
// 三者的判据互斥，前端可以用 isFailure() / isCanceled() 一眼分开。
//
// 为什么放在 electron/main/ 且不依赖 electron：
//   主进程各 handler 都要用它，前端也要用同一套判据（判断「是取消还是失败」），
//   但 preload 跑在 sandbox 里、不能 require 本地文件（见 preload.js 注释），
//   所以**前端侧只复制判据常量，不复制逻辑**——判据本身只有三个布尔字段，
//   复制不会漂移（真正的漂移风险在「字段名」，字段名由本文件定义）。
//
// 注意：不要在本模块里 require('electron') —— 顶层 require 会让单测直接崩。
// =========================================================================

// 三种结局的判别字段。用 Symbol 意义不大（要跨 IPC 序列化），
// 统一用固定字段名，前端按字段名判定。
const OUTCOME = {
  OK: 'ok',
  FAIL: 'fail',
  CANCELED: 'canceled',
}

// 成功。payload 可选（部分通道成功时不需要返回数据）。
// 形状：{ outcome: 'ok', success: true, ...payload }
function ok(payload) {
  return { outcome: OUTCOME.OK, success: true, ...(payload || {}) }
}

// 失败。error 是给人看的原因（必须是字符串，不能是 Error 对象 —— 要跨 IPC 序列化）。
// 形状：{ outcome: 'fail', success: false, canceled: false, error: '原因' }
function fail(error, extra) {
  return {
    outcome: OUTCOME.FAIL,
    success: false,
    canceled: false,
    error: toMessage(error),
    ...(extra || {}),
  }
}

// 取消。用户主动放弃（如系统保存对话框点了取消）—— 不是错误，不该弹错误提示。
// 形状：{ outcome: 'canceled', success: false, canceled: true, error: null }
function canceled(reason) {
  return {
    outcome: OUTCOME.CANCELED,
    success: false,
    canceled: true,
    error: reason ? toMessage(reason) : null,
  }
}

// 把任意抛出物转成能跨 IPC 的字符串。
// Error → message；字符串 → 原样；其它 → JSON 兜底（对象可能带循环引用，要 try）。
function toMessage(err) {
  if (err == null) return '未知错误'
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message || String(err)
  try {
    return JSON.stringify(err)
  } catch (_) {
    return String(err)
  }
}

// 判定：这是「失败」吗？（失败 ≠ 取消）
function isFailure(res) {
  if (!res || typeof res !== 'object') return false
  if (res.outcome) return res.outcome === OUTCOME.FAIL
  // 兼容没有 outcome 字段的旧形状：success === false 且没有 canceled → 视为失败
  return res.success === false && res.canceled !== true
}

// 判定：这是「用户取消」吗？
function isCanceled(res) {
  if (!res || typeof res !== 'object') return false
  if (res.outcome) return res.outcome === OUTCOME.CANCELED
  return res.canceled === true
}

// 判定：成功吗？（兼容旧形状：有 filePath / success:true 都算成功）
function isOk(res) {
  if (!res || typeof res !== 'object') return false
  if (res.outcome) return res.outcome === OUTCOME.OK
  if (res.outcome === undefined && res.success === undefined) return !!res.filePath
  return res.success === true
}

// 把一个「可能抛」的异步函数包成「异常不外泄」的 handler。
//
// 主进程侧的 IPC handler 一旦 reject，渲染层拿到的是 Electron 包装过的
// "Error invoking remote method 'xxx'" —— 真实原因（哪个文件、哪个盘）全丢了，
// 而渲染层的 catch 往往只提示「操作失败」。
//
// 用法：
//   ipcMain.handle('screenshot-capture', safe(async (event, options) => {
//     ...
//   }))
//
// safe(fn) 返回的函数：内部抛异常 → 转成 fail(err) 返回，**不会 reject**。
// 注意它只包「异常」，不改变返回值语义 —— 返回值原样透出。
//
// ⚠️ 两种模式必须分清，否则会破坏既有前端行为：
//   · safe(fn)      —— 异常转成 fail() **返回值**（不 reject）。
//                      适合「前端靠读 result.error 判断」的通道。
//   · safeReject(fn)—— 异常仍 **reject**，但把错误信息换成可读原因
//                      （保留 Error 类型，只是 message 更具体）。
//                      适合「前端靠 try/catch 捕获」的通道 ——
//                      若改成返回值，前端那个 catch 就永远不触发，错误提示静默消失。
//
// 判断依据：**前端现有代码是 try/catch 还是读返回值**，改之前先查消费点。
function safe(fn) {
  return async function (...args) {
    try {
      return await fn.apply(this, args)
    } catch (err) {
      return fail(err)
    }
  }
}

// 保留 reject 语义，但把异常换成带可读 message 的 Error。
// 前端 catch 到的是「具体原因」而不是 Electron 包装的 "Error invoking remote method"。
function safeReject(fn) {
  return async function (...args) {
    try {
      return await fn.apply(this, args)
    } catch (err) {
      // 已经是带可读 message 的 Error 就原样抛；否则包一层
      if (err instanceof Error) throw err
      throw new Error(toMessage(err))
    }
  }
}

module.exports = {
  OUTCOME,
  ok,
  fail,
  canceled,
  toMessage,
  isFailure,
  isCanceled,
  isOk,
  safe,
  safeReject,
}
