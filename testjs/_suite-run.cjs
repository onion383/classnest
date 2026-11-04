// =========================================================================
// _suite-run.cjs —— 测试板块轻量运行器核心（run-units / run-behavior 共用）
//
// 与 run-smoke 的边界：units/behavior 无环境依赖（不起端口、不碰产物、无 SKIP 约定），
// 这里只做「并行逐文件跑 node --test + 与 run-smoke 同款的 per-file PASS/FAIL 与汇总输出」。
// 并行度对齐 node --test 自身（子进程池），保证不比裸跑慢。不要往这里加 run-smoke
// 的环境机制——那是冒烟的环境依赖逼出来的。
//
// 用法（由 run-units.js / run-behavior.js 封装）：
//   [--only=xx]  只跑文件名含 xx 的（可重复传）
//   [--skip=xx]  跳过文件名含 xx 的（可重复传）
//   [--bail]     第一个失败文件出现后不再启动新文件（在途的跑完）
//   [--list]     只列出会跑哪些文件
// =========================================================================
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function parseArgs(argv) {
  const opt = { only: [], skip: [], bail: false, list: false }
  for (const a of argv) {
    if (a.startsWith('--only=')) opt.only.push(a.slice(7))
    else if (a.startsWith('--skip=')) opt.skip.push(a.slice(7))
    else if (a === '--bail') opt.bail = true
    else if (a === '--list') opt.list = true
  }
  return opt
}

// 从 node --test 的 TAP 输出里取 # tests / # pass / # fail
function parseCounts(tap) {
  const get = (k) => {
    const m = tap.match(new RegExp('^# ' + k + ' (\\d+)', 'm'))
    return m ? Number(m[1]) : null
  }
  return { tests: get('tests'), pass: get('pass'), fail: get('fail') }
}

// 单个测试文件的最长运行时间。卡片级测试正常情况下毫秒~秒级完成；
// 没有这道闸时，一个死循环（例如重定向环未设上限）会把整个板块挂住 7 分钟以上，
// 被中断后还会留下孤儿进程继续吃 CPU。
// 可用环境变量 TEST_FILE_TIMEOUT_MS 覆盖（冒烟/行为测试若确有慢文件可调大）。
const FILE_TIMEOUT_MS = Number(process.env.TEST_FILE_TIMEOUT_MS) || 120000

// Windows 下 node --test 会再 fork 一个跑用例的子进程，只 kill 父进程会留下孤儿；
// POSIX 下同理，worker 是另行 fork 出来的（审查 v5 · V5-013）。
// 子进程在 POSIX 上用 detached 自成进程组，超时清理时整组杀。
function killTree(child) {
  if (!child || !child.pid) return
  // 被信号杀死时 exitCode 仍是 null，必须同时看 signalCode
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    // 不是组 leader 时只会 ESRCH，安全退回单杀
    process.kill(-child.pid, 'SIGKILL')
    return
  } catch (_) { /* 没有独立进程组 */ }
  try { child.kill('SIGKILL') } catch (_) { /* 已退出 */ }
}

function runOne(full) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    // 显式指定 tap：Node 22+ 默认 reporter 随版本/终端而变，不指定时汇总行可能
    // 变成 `ℹ tests 5`，导致下面的 parseCounts 全部取不到（总数显示 0）。
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', full], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX：自成进程组，超时后 kill(-pid) 能带走 node --test 的 worker 子进程
      detached: process.platform !== 'win32',
    })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, FILE_TIMEOUT_MS)
    timer.unref()
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, ms: Date.now() - t0, tap: String(e), counts: {} })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const tap = timedOut
        ? out + `\n# 超时：${full} 超过 ${FILE_TIMEOUT_MS}ms 未结束，已终止\n`
        : out
      resolve({ ok: !timedOut && code === 0, ms: Date.now() - t0, tap, counts: parseCounts(out) })
    })
  })
}

async function runSuite({ dir, label }) {
  const opt = parseArgs(process.argv.slice(2))
  const suiteDir = path.join(__dirname, dir)
  if (!fs.existsSync(suiteDir)) {
    console.error(`未找到测试目录：${suiteDir}`)
    process.exit(2)
  }
  const files = fs
    .readdirSync(suiteDir)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => (opt.only.length ? opt.only.some((k) => f.includes(k)) : true))
    .filter((f) => (opt.skip.length ? !opt.skip.some((k) => f.includes(k)) : true))
    .sort()

  if (opt.list) {
    for (const f of files) console.log(f)
    return
  }
  if (!files.length) {
    console.error('没有匹配的测试文件')
    process.exit(2)
  }

  // 并行跑满（对齐 node --test 的子进程池）；--bail 时首个失败后不再启动新文件
  const results = []
  let stopped = false
  const queue = [...files]
  const limit = Math.min(files.length, Math.max(2, os.cpus().length || 2))
  async function worker() {
    while (queue.length) {
      if (stopped) return
      const f = queue.shift()
      const r = await runOne(path.join(suiteDir, f))
      r.f = f
      results.push(r)
      if (r.ok) {
        console.log(`── PASS  ${f}  (${r.counts.tests ?? '?'} tests, ${r.ms}ms)`)
      } else {
        // 失败时把完整 TAP 倒出来，让断言信息可见
        process.stdout.write(r.tap)
        console.log(`── FAIL  ${f}  (${r.counts.pass ?? 0}/${r.counts.tests ?? '?'} tests, ${r.ms}ms)`)
        if (opt.bail) stopped = true
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))

  results.sort((a, b) => files.indexOf(a.f) - files.indexOf(b.f))
  const failed = results.filter((x) => !x.ok)
  const totalTests = results.reduce((s, x) => s + (x.counts.tests || 0), 0)
  const totalPass = results.reduce((s, x) => s + (x.counts.pass || 0), 0)
  console.log('\n========================================================')
  console.log(
    `${label}汇总：文件 ${results.length - failed.length} 过 / ${failed.length} 挂` +
    `（共 ${files.length} 个文件 / ${totalTests} 条测试，过 ${totalPass} 条）`
  )
  if (failed.length) {
    console.log('失败文件：')
    for (const x of failed) console.log(`  - ${x.f}`)
  }
  if (stopped) console.log('（--bail：首个失败后未再启动剩余文件）')
  process.exit(failed.length ? 1 : 0)
}

module.exports = { runSuite }
