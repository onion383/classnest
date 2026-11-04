// =========================================================================
// killTree.cjs —— 结束子进程**及其后代**（跨平台）
//
// 为什么需要：
//   `child.kill()` 只杀**直接子进程**。而我们起的进程几乎都会再起孙进程：
//     · dev-vite.js（node）→ 再起 vite 的子进程
//     · electron → 再起渲染进程 / GPU 进程
//   Windows 上 `child.kill()` 更是只发 TerminateProcess 给那一个进程 ——
//   孙进程**残留** → 端口被占（下次跑报 EADDRINUSE）、进程泄漏、任务管理器里堆一堆。
//
// 做法：
//   · Windows：taskkill /pid <pid> /T /F（/T = 连树一起杀，/F = 强制）
//   · POSIX：先按进程组杀（kill(-pid)）。前提是 spawn 时传了 detached:true，
//     子进程才会自成进程组；没传时 kill(-pid) 只会 ESRCH（找不到这个组），
//     不会误伤别的进程，所以可以无条件先试，失败再退回单杀。
//     ※ 旧实现要求 caller 调 markDetached() 才走组杀，但全仓没有一个调用方，
//       导致 POSIX 上「杀树」从未真正生效（审查 v5 · V5-010）。
//
// 用法：const { killTree } = require('./killTree.cjs'); killTree(child)
// =========================================================================
const { spawn } = require('node:child_process')

/**
 * 结束子进程及其后代。**永不抛异常**（清理路径上抛异常会掩盖真正的错误）。
 * @param {import('node:child_process').ChildProcess|null|undefined} child
 * @param {{ force?: boolean }} [opts] force=false 时用温和信号（POSIX SIGTERM），默认强制
 */
function killTree(child, opts = {}) {
  if (!child || !child.pid) return
  // 已被信号杀死时 exitCode 仍是 null，必须同时看 signalCode
  if (child.exitCode !== null || child.signalCode !== null) return
  const signal = opts.force === false ? 'SIGTERM' : 'SIGKILL'
  try {
    if (process.platform === 'win32') {
      // /T = tree（连后代一起），/F = force
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    }
    // POSIX：整个进程组一起杀。不是组 leader 时只会 ESRCH，不会误伤别的进程组
    try {
      process.kill(-child.pid, signal)
      return
    } catch (_) { /* 没有以该 pid 为组号的进程组（spawn 未 detached）→ 退回单杀 */ }
    try { child.kill(signal) } catch (_) { /* 已退出 */ }
  } catch (_) { /* 清理路径不抛 */ }
}

module.exports = { killTree }
