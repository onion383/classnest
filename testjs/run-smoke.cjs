#!/usr/bin/env node
// =========================================================================
// run-smoke.cjs —— 冒烟测试总入口
//
// 作用：一次跑完 smoke/ 下所有冒烟脚本，汇总通过/失败。
// 每个脚本**仍然可以单独跑**：node testjs/smoke/<文件名>
// 判定标准：进程退出码 0 = 通过，非 0 = 失败（脚本内部自己 assert 并 exit(1)）。
//
// 用法：
//   node testjs/run-smoke.cjs                跑全部
//   node testjs/run-smoke.cjs --list         只列出会跑哪些
//   node testjs/run-smoke.cjs --only=auth    只跑文件名含 auth 的（可重复传）
//   node testjs/run-smoke.cjs --skip=pdf     跳过文件名含 pdf 的（可重复传）
//   node testjs/run-smoke.cjs --require-pass=secure-channel-retry
//                                            点名关键用例：SKIP 或未收集也算失败（可重复传）
//   node testjs/run-smoke.cjs --bail         第一个失败就停
//
// 设计说明：
//   · **串行**执行。冒烟脚本会各占端口、临时目录（testjs/tmp/…），并行会互相干扰。
//   · stdio 直接透传，脚本自己的彩色输出/断言信息原样可见，不做二次包装。
//   · 退出码 3 = 脚本自己判定「环境不具备，跳过」（如缺产物文件），不计失败。
//   · 需要真后端的脚本一律自起隔离后端（见 smoke/_isolated-backend.cjs），
//     本运行器不再探测外部端口、也不会替脚本判 SKIP。
// =========================================================================

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const os = require('node:os')

// 关键回归名单（V10-T01-01）：以前只写在 CI 命令行，本地 npm run smoke 不拦任何
// SKIP。移到这里做单一出处——无参运行默认带上，CI 的 --require-pass 仍可覆盖追加。
// 名字必须能在 smoke/ 下匹配到文件，否则 require-pass 永远 missingRequired。
const DEFAULT_REQUIRE_PASS = [
  'secure-channel-retry',
  'undo-batch-test',
  'cadre-undo-test',
  'unzip-safe-test',
  'api-routes-test',
]

// 本次运行专属的临时根目录：所有冒烟脚本的数据目录都建在它下面，
// 由**本进程**在全部子脚本退出后整体删除。
// 为什么不由子脚本自己删：sqlite 的 index.db 连接在子进程内一直开着，
// Windows 上 rmSync 必然 EBUSY（重试也删不掉），所以「谁创建谁删」在进程内做不到，
// 只能交给生命周期更长的父进程。实测旧做法每跑一次漏一个目录：
// api-routes 49 个 / cadre-undo 13 个 / undo-batch 11 个。
// 惰性创建：本文件被单测 require 时只取导出函数，不能凭空造临时目录。
let TMP_ROOT = null
function getTmpRoot() {
  if (!TMP_ROOT) TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'classnest-smoke-run-'))
  return TMP_ROOT
}

async function removeTmpRoot() {
  if (!TMP_ROOT) return
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); TMP_ROOT = null; return } catch (_) {
      // 最后一个子进程刚退出时句柄可能还差一点释放，等一下再试
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  console.error(`[run-smoke] 临时根目录未能删除：${TMP_ROOT}`)
}

const SMOKE_DIR = path.join(__dirname, 'smoke')
const NODE_EXT = new Set(['.cjs', '.mjs', '.js'])
// 传给子脚本的 PORT（脚本可忽略）。原先还维护一份 NEEDS_BACKEND 集合 + 一次 backendAlive()
// 探测，用来把「依赖外部后端」的脚本判成 SKIP；auth-smoke 早已改成自起隔离后端，
// 集合空了以后那套逻辑只剩副作用：**每次跑都白探一次 3000 端口**（不通时白等 600ms），
// 外加一条永远走不到的 SKIP 分支。现已整段删除。
// 新脚本需要真后端时请自己起隔离后端（smoke/_isolated-backend.cjs），别再引入外部依赖判定。
const BACKEND_PORT = Number(process.env.PORT) || require('../config/ports.cjs').backendPort
// 单个冒烟脚本的超时上限（ms）。
// 正常脚本 1~30 秒；给 180 秒是为了容忍慢机器上启 Electron 的那几个。
// 超时按**失败**计入（不能当成通过）—— 否则「脚本卡死了」会被算成「跑过了」。
const SMOKE_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 180000
// 有产物依赖的脚本必须按顺序跑：pdf-subset-verify.mjs 先生成 subset-out*.ttf，
// font-subset-verify.mjs 再读取产物校验。只按文件名字典序会反过来，干净检出必假失败。
const ORDER_HINT = new Map([
  ['pdf-subset-verify.mjs', 0],
  ['font-subset-verify.mjs', 1],
])

// ---------- 参数 ----------
function parseArgs(argv) {
  const opt = { list: false, bail: false, only: [], skip: [], requirePass: [] }
  // V10-T01-01：本地与 CI 共用的关键回归名单，固化在这里做单一出处。
  // CI 命令行里的 --require-pass 仍有效（覆盖追加），本地 npm run smoke 也拦这些 SKIP。
  // 只在「跑全量且没点名」时补默认：--only/--skip 是定向跑，不应被 5 个关键用例的缺失拦红。
  if (!argv.some((a) => a.startsWith('--require-pass=')) &&
      !argv.some((a) => a.startsWith('--only=') || a.startsWith('--skip='))) {
    opt.requirePass.push(...DEFAULT_REQUIRE_PASS)
  }
  for (const a of argv) {
    if (a === '--list') opt.list = true
    else if (a === '--bail') opt.bail = true
    else if (a.startsWith('--only=')) opt.only.push(a.slice(7))
    else if (a.startsWith('--skip=')) opt.skip.push(a.slice(7))
    else if (a.startsWith('--require-pass=')) opt.requirePass.push(a.slice(15))
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 24).join('\n').replace(/^\/\/ ?/gm, ''))
      process.exit(0)
    } else {
      console.error(`未知参数：${a}（用 --help 看用法）`)
      process.exit(2)
    }
  }
  return opt
}

// ---------- 收集脚本 ----------
function collect(opt) {
  if (!fs.existsSync(SMOKE_DIR)) {
    console.error(`未找到 smoke 目录：${SMOKE_DIR}`)
    process.exit(2)
  }
  return fs
    .readdirSync(SMOKE_DIR)
    .filter((f) => {
      const ext = path.extname(f).toLowerCase()
      return NODE_EXT.has(ext)
    })
    .filter((f) => !f.startsWith('_') && !f.startsWith('.'))
    .filter((f) => (opt.only.length ? opt.only.some((k) => f.includes(k)) : true))
    .filter((f) => (opt.skip.length ? !opt.skip.some((k) => f.includes(k)) : true))
    .sort((a, b) => {
      const oa = ORDER_HINT.has(a) ? ORDER_HINT.get(a) : 100
      const ob = ORDER_HINT.has(b) ? ORDER_HINT.get(b) : 100
      return oa - ob || a.localeCompare(b)
    })
}

function runOne(file) {
  const full = path.join(SMOKE_DIR, file)
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(process.execPath, [full], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      env: { ...process.env, PORT: String(BACKEND_PORT), SMOKE_TMP_ROOT: getTmpRoot() },
    })
    // ⚠️ 必须有超时：单个冒烟脚本 hang（等端口 / 等锁 / 子进程不退出）时，
    //   没有超时 = 整个冒烟批次**永久挂起**，CI/本地都只能强杀 —— 看不到任何失败信息。
    // 超时后主动 kill 并按失败计入（不能当成通过）。
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      console.error(`\n[run-smoke] ${file} 超时（${SMOKE_TIMEOUT_MS}ms），强制结束`)
      try { child.kill('SIGKILL') } catch (_) { /* 已退出 */ }
    }, SMOKE_TIMEOUT_MS)
    const done = (code, signal) => {
      clearTimeout(timer)
      resolve({ file, code, ms: Date.now() - t0, timedOut })
    }
    child.on('error', (e) => done(-1, null))
    child.on('exit', (code, signal) => {
      if (timedOut) { done(-1, null); return }
      done(code ?? (signal ? -1 : 0), signal)
    })
  })
}

// ---------- 汇总判定（唯一实现，单测直接 require 执行） ----------
// 退出码 0 只表示「没有失败、且被点名的关键用例都真跑过了」。
// SKIP（code=null）与「没收集到」本身不算失败，但**被 --require-pass 点名**时算。
function resolveSmokeExit(results, requirePass = []) {
  const pass = results.filter((r) => r.code === 0)
  const fail = results.filter((r) => r.code !== 0 && r.code !== null)
  const skip = results.filter((r) => r.code === null)
  // 被点名的「必须通过」用例若没跑（SKIP）或没被收集到，算失败 —— 关键回归不许悄悄跳过。
  // CI 用 --require-pass=secure-channel-retry 保证 401 重试真的跑过。
  const missingRequired = requirePass.filter((key) =>
    !results.some((r) => r.file.includes(key) && r.code === 0)
  )
  return { pass, fail, skip, missingRequired, exit: fail.length || missingRequired.length ? 1 : 0 }
}

async function main() {
  const opt = parseArgs(process.argv.slice(2))
  const files = collect(opt)
  if (!files.length) {
    console.error('没有匹配到任何冒烟脚本（检查 --only/--skip）')
    await removeTmpRoot()
    process.exit(2)
  }

  if (opt.list) {
    console.log(`smoke/ 下共 ${files.length} 个脚本：`)
    files.forEach((f) => console.log(`  ${f}`))
    await removeTmpRoot()
    process.exit(0)
  }

  const results = []
  for (const f of files) {
    console.log(`\n── RUN   ${f}`)
    const r = await runOne(f)
    if (r.code === 3) {
      // 脚本自己判定「环境不具备」→ 跳过，不算失败
      results.push({ file: f, code: null, ms: r.ms, reason: '环境不具备' })
      console.log(`── SKIP  ${f}  (${r.ms}ms)`)
      continue
    }
    results.push(r)
    const tag = r.code === 0 ? 'PASS' : 'FAIL'
    // runOne 的返回值没有 err 字段（原写法是死引用，永远不显示）
    console.log(`── ${tag}  ${f}  (${r.ms}ms)`)
    if (r.code !== 0 && opt.bail) break
  }

  // ---------- 汇总 ----------
  const { pass, fail, skip, missingRequired, exit } = resolveSmokeExit(results, opt.requirePass)

  console.log('\n' + '='.repeat(56))
  console.log(`冒烟汇总：通过 ${pass.length} / 失败 ${fail.length} / 跳过 ${skip.length}（共 ${results.length}）`)
  if (fail.length) {
    console.log('\n失败项：')
    fail.forEach((r) => console.log(`  ✗ ${r.file}  exit=${r.code}`))
  }
  if (skip.length) {
    console.log('\n跳过项：')
    skip.forEach((r) => console.log(`  - ${r.file}  ${r.reason || '缺少运行时'}`))
  }
  if (missingRequired.length) {
    console.log('\n未运行的关键用例（--require-pass）：')
    missingRequired.forEach((k) => console.log(`  ✗ ${k}  被跳过或未收集`))
  }
  console.log('='.repeat(56))
  await removeTmpRoot()
  process.exit(exit)
}

module.exports = { resolveSmokeExit, parseArgs, DEFAULT_REQUIRE_PASS }

if (require.main === module) main()
