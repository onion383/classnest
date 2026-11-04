// =========================================================================
// kill-tree.test.js —— 「杀进程树」端到端（V5-010/011/013）正反用例
//
// 报告发现的三处问题都指向同一件事：POSIX 分支要么要求没人调用的 markDetached，
// 要么只 child.kill —— 孙进程孤儿化。这里用**真实三层进程树**验证：
//   父（本测试 spawn）→ 子（临时脚本）→ 孙（长驻 node）
//   killTree 之后孙进程必须消失。
// 另外用静态判据锁住三处接线（Windows 分支无法验证 POSIX 代码路径）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../..')
const { killTree } = require(path.join(ROOT, 'testjs/tools/killTree.cjs'))

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch (_) { return false }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs, stepMs = 100) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true
    await sleep(stepMs)
  }
  return false
}

// 临时脚本：spawn 一个「长驻孙进程」，把孙 pid 写到文件，自己也不退出
const PARENT_SRC = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const out = process.argv[2]
const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
fs.writeFileSync(out, String(grand.pid))
setInterval(() => {}, 1000)
`

test('真实进程树：killTree 后孙进程必须一起消失', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-killtree-'))
  const script = path.join(dir, 'parent.cjs')
  const pidFile = path.join(dir, 'grand.pid')
  fs.writeFileSync(script, PARENT_SRC)

  // 父进程也 detached（POSIX）：它才是进程组 leader，孙进程同组
  const parent = spawn(process.execPath, [script, pidFile], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  })

  let grandPid = 0
  try {
    const ok = await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 3000)
    assert.ok(ok, '孙进程没起来，测试前置失败')
    grandPid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    assert.ok(grandPid > 0 && isAlive(grandPid), '孙进程应在运行')

    killTree(parent)

    const gone = await waitFor(() => !isAlive(grandPid), 4000)
    assert.ok(gone, `killTree 后孙进程 ${grandPid} 仍存活 —— 进程树没杀干净`)
  } finally {
    // 无论断言成败都别留下孤儿
    try { killTree(parent) } catch (_) { /* 已退出 */ }
    if (grandPid) { try { process.kill(grandPid, 'SIGKILL') } catch (_) { /* 已退出 */ } }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* 句柄延迟 */ }
  }
})

test('边界：空 child / 无 pid / 已退出都不抛', () => {
  assert.doesNotThrow(() => killTree(null))
  assert.doesNotThrow(() => killTree(undefined))
  assert.doesNotThrow(() => killTree({}))
  // 已正常退出：exitCode 非 null
  assert.doesNotThrow(() => killTree({ pid: 999999, exitCode: 0, signalCode: null }))
  // 被信号杀死：exitCode 仍为 null，必须看 signalCode
  assert.doesNotThrow(() => killTree({ pid: 999999, exitCode: null, signalCode: 'SIGTERM' }))
})

test('静态接线：三处 POSIX 分支都必须走进程组', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

  const tool = read('testjs/tools/killTree.cjs')
  assert.ok(/process\.kill\(-child\.pid/.test(tool), 'killTree.cjs 必须按进程组杀')
  assert.ok(/child\.signalCode !== null/.test(tool), '必须同时判断 signalCode（被信号杀死时 exitCode 为 null）')

  const suite = read('testjs/_suite-run.cjs')
  assert.ok(/process\.kill\(-child\.pid/.test(suite), '_suite-run 的 POSIX 分支必须按进程组杀')
  assert.ok(/detached: process\.platform !== 'win32'/.test(suite), 'spawn 必须 detached 才成组')

  const iso = read('testjs/smoke/_isolated-backend.cjs')
  assert.ok(/process\.kill\(-child\.pid/.test(iso), '_isolated-backend 的 POSIX 分支必须按进程组杀')
  assert.ok(/detached: process\.platform !== 'win32'/.test(iso), '后端 spawn 必须 detached 才成组')
})
