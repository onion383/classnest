// =========================================================================
// backend-kill-tree.test.js —— 后端子进程必须整树清理，不留孙进程
//
// 根因：后端是 fork 出来的长生命周期 Node 进程，自己还会起扫描/OCR/ffmpeg 孙进程。
// main.backend.js 三处用裸 proc.kill() —— Windows 上只杀直接子进程，孙进程残留占端口/句柄，
// 矩阵 process.kill_tree_detached 记 GAP。
// 修法：killBackendTree() Windows 用 taskkill /PID /T /F；POSIX 先试进程组杀（fork 未
// detached 时 ESRCH 不误伤）再退回单杀；三处调用点全部改用它。
//
// 判据：真跑抽出的 killBackendTree（注入假 platform/spawn/process.kill/假 proc），
// 验三条平台的调用与幂等；再扫 main.backend.js 确认三处裸 kill 都被替换。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const BACKEND = abs('electron/main/main.backend.js')
const code = fs.readFileSync(BACKEND, 'utf8')
const { extractFunctionInner } = require('#testjs/units/_mechanism.cjs')

function extractKillBackendTree() {
  return extractFunctionInner(code, 'killBackendTree')
}

function runKill({ platform, proc = { pid: 4242, exitCode: null, signalCode: null, kill: null }, groupKillThrows = false }) {
  const calls = []
  const procObj = { ...proc, kill: proc.kill || ((sig) => { calls.push('proc.kill:' + sig) }) }
  const fakeSpawn = (cmd, args, opts) => { calls.push('spawn:' + cmd + ' ' + args.join(' ')); return { unref() {} } }
  const fakeProcess = {
    platform,
    kill: (pid, sig) => {
      calls.push('process.kill:' + pid + ':' + sig)
      if (groupKillThrows) throw new Error('ESRCH')
    },
  }
  const body = extractKillBackendTree()
    .replace("const { spawn } = require('child_process')", 'const spawn = __spawn')
  const fn = new Function('__spawn', 'process', 'proc', body)
  fn(fakeSpawn, fakeProcess, procObj)
  return calls
}

test('Windows：taskkill 必须带 /T /F 整树杀', () => {
  const calls = runKill({ platform: 'win32' })
  assert.equal(calls.length, 1, 'Windows 只应走 taskkill 一次')
  assert.match(calls[0], /^spawn:taskkill \/PID 4242 \/T \/F$/, '必须整树杀，不能只 kill 直接子进程')
})

test('POSIX：组杀成功就不再单杀；不是组 leader（ESRCH）退回单杀', () => {
  const ok = runKill({ platform: 'linux' })
  assert.deepEqual(ok, ['process.kill:-4242:SIGKILL'], '组杀成功即可')
  const fallback = runKill({ platform: 'linux', groupKillThrows: true })
  assert.deepEqual(fallback, ['process.kill:-4242:SIGKILL', 'proc.kill:SIGKILL'], '组杀失败要退回单杀')
})

test('已退出 / 无 pid 的进程不重复清理', () => {
  assert.deepEqual(runKill({ platform: 'win32', proc: { pid: 1, exitCode: 0, signalCode: null } }), [])
  assert.deepEqual(runKill({ platform: 'win32', proc: { pid: null, exitCode: null, signalCode: null } }), [])
})

test('三处退出路径全部改用 killBackendTree，不再有裸 proc.kill()', () => {
  // @pin electron/main/main.backend.js#killBackendTree
  assert.match(code, /function killBackendTree\(proc\)/, '必须有整树清理函数')
  // stopBackendProcess / shutdownBackend / armSimCrash 三处都调用
  const callCount = (code.match(/killBackendTree\(/g) || []).length
  assert.ok(callCount >= 4, `调用点只有 ${callCount} 处（定义 + 三处调用）`)
  // @pin electron/main/main.backend.js#stopBackendProcess
  assert.ok(!/try \{ proc\.kill\(\) \}/.test(code), 'stopBackendProcess 不许再裸 kill')
  // @pin electron/main/main.backend.js#shutdownBackend
  assert.ok(!/backendProcess\.kill\(\)/.test(code), 'shutdownBackend 不许再裸 kill')
  // @pin electron/main/main.backend.js#killBackendTree
  assert.match(code, /armSimCrash[\s\S]{0,500}killBackendTree\(proc\)/, '模拟崩溃也要整树杀')
  // @pin electron/main/main.backend.js#killBackendTree
  assert.match(code, /module\.exports = \{[\s\S]{0,300}killBackendTree,/, '要导出供判据验证')
})
