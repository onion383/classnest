#!/usr/bin/env node
// ci-staged.cjs —— 提交前一键验证：在隔离 worktree 里模拟「提交后的 HEAD」跑 CI 闸门
//
// 用法：
//   npm run ci:staged              静态闸门 + 快测（默认，约 2 分钟）
//   npm run ci:staged -- --full    再加 build + 冒烟（对齐 CI 的 test job，约 4 分钟）
//   npm run ci:staged -- --keep    失败时保留 worktree 供排查（默认无论成败都清理）
//
// 为什么需要它：
//   CI 跑的是提交后的 HEAD，不含工作区里未提交的改动。本地直接跑检查时，
//   并行会话的未提交文件会混进来，导致「本地绿、CI 红」或反之。
//   本脚本建一个 detach worktree，把暂存区 patch 应用上去，得到与 CI 一致的代码状态，
//   在那里跑全套闸门，全绿才让提交。
//
// 闸门清单与 CI（.github/workflows/ci.yml 的 test job）逐项对齐：
//   版本号一致性 / lint / boundaries / ipc-policy / channels / schema /
//   docs:verify / coverage / guards / 快测(units+behavior+probe)
//   --full 再加 build + 冒烟（需起 Vite，较慢）。
//
// 依赖：worktree 里没有 node_modules，脚本用 fs.symlinkSync 把它们 junction 到主仓库
//   （Windows junction / POSIX dir symlink），不额外装依赖。
// 清理：无论成败都 remove worktree（--keep 除外），主工作区完全不动。
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const args = process.argv.slice(2)
const full = args.includes('--full')
const keep = args.includes('--keep')

function run(cmd, args_, cwd, label) {
  const t = Date.now()
  // Windows 下 npm 是 npm.cmd 批处理，必须 shell:true 才找得到；POSIX 无需 shell
  const r = spawnSync(cmd, args_, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  return { ok: r.status === 0, ms: Date.now() - t, label }
}

function git(args_, cwd = ROOT) {
  const r = spawnSync('git', args_, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

// ---------- 0. 前置检查 ----------
const staged = git(['diff', '--cached', '--name-only'])
if (!staged.ok) { console.error('git diff --cached 失败:', staged.err); process.exit(2) }
if (!staged.out) {
  console.error('暂存区为空 —— 先 git add 要提交的文件，再跑 ci:staged。')
  process.exit(2)
}
const stagedFiles = staged.out.split('\n').filter(Boolean)
console.log(`暂存 ${stagedFiles.length} 个文件，开始隔离验证…\n`)

// ---------- 1. 建 worktree ----------
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'classnest-ci-staged-'))
const wt = path.join(workdir, 'tree')
let created = false
try {
  const add = git(['worktree', 'add', '--detach', wt, 'HEAD'])
  if (!add.ok) { console.error('建 worktree 失败:', add.err); process.exit(2) }
  created = true

  // ---------- 2. 应用暂存 patch ----------
  const patchPath = path.join(workdir, 'staged.patch')
  const diff = spawnSync('git', ['diff', '--cached', '--binary'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (diff.status !== 0) { console.error('导出暂存 patch 失败:', diff.stderr); process.exit(2) }
  fs.writeFileSync(patchPath, diff.stdout, 'utf8')
  const apply = git(['apply', patchPath], wt)
  if (!apply.ok) { console.error('应用暂存 patch 失败:', apply.err); process.exit(2) }
  const applied = git(['status', '--short'], wt)
  console.log(`隔离副本已应用 ${applied.out.split('\n').filter(Boolean).length} 个文件（与提交后的 HEAD 一致）\n`)

  // ---------- 3. 链接 node_modules ----------
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  // 只链接 CI test job 真正会装的 3 处依赖。不要因为主仓有 vue36 就顺手链进来 ——
  // 那会让本地全绿、CI 全红（vue36 被 gitignore，CI 不装）；ci:staged 必须和 CI 同构。
  for (const rel of [
    'node_modules',
    'student-backend/node_modules',
    'student-frontend/node_modules',
  ]) {
    const src = path.join(ROOT, rel)
    const dst = path.join(wt, rel)
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.symlinkSync(src, dst, linkType)
  }

  // ---------- 4. 跑闸门 ----------
  // 版本号一致性：脚本内直接读 worktree 文件（用 node -e 在 Windows shell 下引号会被吃）
  function checkVersion() {
    const t = Date.now()
    const p = JSON.parse(fs.readFileSync(path.join(wt, 'package.json'), 'utf8')).version
    const iss = fs.readFileSync(path.join(wt, 'electron/inno/setup.iss'), 'utf8')
    const m = /#define MyAppVersion "([^"]+)"/.exec(iss)
    const ok = !!m && m[1] === p
    console.log(ok ? `版本号一致: ${p}` : `版本号不一致: package.json=${p} setup.iss=${m && m[1]}`)
    return { ok, ms: Date.now() - t, label: '版本号一致性' }
  }
  const checks = [
    { label: '版本号一致性', fn: checkVersion },
    { label: 'ESLint', cmd: 'npm', args: ['run', 'lint'] },
    { label: 'boundaries', cmd: 'npm', args: ['run', 'check:boundaries:strict'] },
    { label: 'ipc-policy', cmd: 'npm', args: ['run', 'check:ipc-policy'] },
    { label: 'channels', cmd: 'npm', args: ['run', 'channels:gen', '--', '--check'] },
    { label: 'schema', cmd: 'npm', args: ['run', 'check:schema'] },
    { label: 'docs', cmd: 'npm', args: ['run', 'docs:verify'] },
    { label: 'coverage', cmd: 'npm', args: ['run', 'check:coverage'] },
    { label: 'guards', cmd: 'npm', args: ['run', 'check:guards'] },
    { label: '快测 units/behavior/probe', cmd: 'npm', args: ['test'] },
  ]
  if (full) {
    checks.push({ label: 'build', cmd: 'npm', args: ['run', 'build'] })
    checks.push({ label: '冒烟 smoke', cmd: 'npm', args: ['run', 'test:all', '--', '--only=smoke'] })
  }

  const results = []
  for (const c of checks) {
    console.log(`\n──── ${c.label} ────`)
    const r = c.fn ? c.fn() : run(c.cmd, c.args, wt, c.label)
    results.push(r)
    if (!r.ok && !keep) break // 失败即停，省时间；--keep 时继续跑完收集全部问题
  }

  console.log('\n========================================================')
  console.log(full ? '提交前验证（全量）：' : '提交前验证（快测）：')
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(26)} ${r.ok ? 'PASS' : 'FAIL'}  (${r.ms}ms)`)
  const failed = results.filter((r) => !r.ok)
  console.log(failed.length ? `\n✗ ${failed.length} 项未通过 —— 修好后重新 git add && npm run ci:staged` : '\n✓ 全部通过，可以提交')

  if (failed.length && keep) console.log(`\nworktree 保留在：${wt}`)
  process.exitCode = failed.length ? 1 : 0
} catch (err) {
  console.error('ci-staged 异常:', err && err.stack || err)
  process.exitCode = 2
} finally {
  if (created && !keep) {
    const rm = git(['worktree', 'remove', '--force', wt])
    if (!rm.ok) console.error('清理 worktree 失败:', rm.err)
  }
  if (!keep) fs.rmSync(workdir, { recursive: true, force: true })
}
