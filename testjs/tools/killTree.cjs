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
//   · POSIX：进程组 kill（spawn 时用 detached:true 建独立进程组，
//     然后 kill(-pid) 杀整组）。若没 detached，退化成 kill 单进程。
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
  try {
    if (process.platform === 'win32') {
      // /T = tree（连后代一起），/F = force
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    }
    // POSIX：detached 的子进程自成进程组，kill(-pid) 杀整组
    if (child.spawnargs && child.__detachedForKill) {
      try { process.kill(-child.pid, opts.force === false ? 'SIGTERM' : 'SIGKILL') } catch (_) { /* 组已退出 */ }
      return
    }
    try { child.kill(opts.force === false ? 'SIGTERM' : 'SIGKILL') } catch (_) { /* 已退出 */ }
  } catch (_) { /* 清理路径不抛 */ }
}

/**
 * 让 child 之后能被 killTree 整组杀（POSIX 专用）。
 * 必须在 spawn 时传 detached:true，本函数只做标记。
 */
function markDetached(child) {
  if (child) child.__detachedForKill = true
  return child
}

module.exports = { killTree, markDetached }
