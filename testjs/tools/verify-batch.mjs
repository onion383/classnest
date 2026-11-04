// =========================================================================
// verify-batch.mjs —— 一把跑批验证（压缩每批的验证开销）
//
// 为什么需要它：
//   修一批 bug 要跑 5 件事（units / smoke / eslint / docs:verify / build），
//   每件一次 Bash 调用 = 每批 5 次往返。批次一多，光等命令就占掉一半时间。
//   本脚本把 5 件事串成一次调用，并且：
//     · 任一环节失败**继续跑完其余环节**（一次看到全部问题，不用再来一轮）
//     · 输出按环节分段 + 末尾汇总表（哪几项挂了）
//     · 冒烟依赖 Vite（secure-channel-retry 需要 5173 端口），没起就跳过那一项并说明
//
// 用法：
//   node testjs/tools/verify-batch.mjs            # 全跑
//   node testjs/tools/verify-batch.mjs --fast     # 跳过 smoke 与 build（改后端逻辑时够用）
//   node testjs/tools/verify-batch.mjs --only=units,lint
//   node testjs/tools/verify-batch.mjs --skip=docs
//
// 退出码：0 = 全过；1 = 有环节失败。
// =========================================================================
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const FAST = args.includes('--fast')
const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1]
const skip = (args.find((a) => a.startsWith('--skip=')) || '').split('=')[1]

const onlySet = only ? new Set(only.split(',').map((s) => s.trim())) : null
const skipSet = skip ? new Set(skip.split(',').map((s) => s.trim())) : new Set()

function want(name) {
  if (skipSet.has(name)) return false
  if (onlySet) return onlySet.has(name)
  if (FAST && (name === 'smoke' || name === 'build')) return false
  return true
}

// ---------------------------------------------------------------------------
const STEPS = [
  {
    name: 'units',
    title: '单元测试',
    cmd: process.execPath,
    args: [path.join(ROOT, 'testjs', 'run-units.js')],
    cwd: ROOT,
  },
  {
    name: 'probe',
    title: '模式扫描探针',
    cmd: process.execPath,
    args: [path.join(ROOT, 'testjs', 'probe', 'pattern-sweep-probe.cjs')],
    cwd: ROOT,
  },
  {
    // 静态扫描，但必须是常驻回归资产：ESLint 抓不到「只写不读」，
    // 放进 probe/ 只手动跑等于白做（下次重构又会攒出一批）。
    name: 'woref',
    title: '只写不读扫描',
    cmd: process.execPath,
    args: [path.join(ROOT, 'testjs', 'probe', 'write-only-ref-probe.cjs')],
    cwd: ROOT,
  },
  {
    // 同理：通道删了功能没删、或功能加了忘了接 UI，都只能靠「调用点」判，
    // 靠「通道名在某个文件里出现过」判会漏（C01-08 就是这么误报一堆的）。
    name: 'ipcusage',
    title: 'IPC 通道使用面',
    cmd: process.execPath,
    args: [path.join(ROOT, 'testjs', 'probe', 'ipc-usage-probe.cjs')],
    cwd: ROOT,
  },
  {
    name: 'behavior',
    title: '行为测试',
    cmd: process.execPath,
    args: [path.join(ROOT, 'testjs', 'run-behavior.js')],
    cwd: ROOT,
  },
  {
    name: 'lint',
    title: 'ESLint',
    cmd: 'npx',
    args: ['eslint', 'student-backend', 'student-frontend/src'],
    cwd: ROOT,
  },
  {
    name: 'docs',
    title: '文档一致性',
    cmd: process.execPath,
    args: [path.join(ROOT, 'testjs', 'tools', 'docs-verify.mjs')],
    cwd: ROOT,
  },
  {
    name: 'smoke',
    title: '冒烟测试',
    cmd: process.execPath,
    args: [path.join(ROOT, 'testjs', 'run-smoke.cjs')],
    cwd: ROOT,
    // 冒烟里 secure-channel-retry 需要 Vite 在 5173；没起会自动跳过那一项，不算失败
    optional: true,
  },
  {
    name: 'build',
    title: '前端构建',
    cmd: 'npx',
    args: ['vite', 'build', '--outDir', '../testjs/tmp/build-verify', '--emptyOutDir'],
    cwd: path.join(ROOT, 'student-frontend'),
    optional: true,
  },
]

// ---------------------------------------------------------------------------
const results = []
for (const step of STEPS) {
  if (!want(step.name)) {
    console.log(`\n──── ${step.title} ────  跳过（--fast / --skip / --only）`)
    results.push({ name: step.name, title: step.title, status: 'skip' })
    continue
  }
  console.log(`\n──── ${step.title} ────`)
  const t0 = Date.now()
  const r = spawnSync(step.cmd, step.args, {
    cwd: step.cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env },
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = ((r.stdout || '') + (r.stderr || '')).trim()
  const code = r.status === null ? -1 : r.status
  const ok = code === 0
  // 输出尾部（成功时只给摘要，失败时给更多）
  const lines = out.split('\n')
  const tail = ok ? lines.slice(-12) : lines.slice(-40)
  console.log(tail.join('\n'))
  if (r.error) console.log('  spawn 错误：' + r.error.message)
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  results.push({
    name: step.name,
    title: step.title,
    status: ok ? 'pass' : 'fail',
    code,
    secs,
    optional: !!step.optional,
  })
  console.log(`  → ${ok ? '通过' : '失败'}（${secs}s）`)
}

// ---------------------------------------------------------------------------
console.log('\n════════ 汇总 ════════')
for (const r of results) {
  const mark = r.status === 'pass' ? '✓' : r.status === 'skip' ? '—' : '✗'
  const extra = r.status === 'fail' ? `  退出码 ${r.code}` : r.secs ? `  ${r.secs}s` : ''
  console.log(`  ${mark} ${r.title.padEnd(14, '　')}${extra}`)
}

const failed = results.filter((r) => r.status === 'fail')
const hardFailed = failed.filter((f) => !f.optional)
console.log('')
if (failed.length) {
  // optional 环节（冒烟/构建）失败只提示、不算整体失败：它们依赖 Vite/5173 等环境，
  // 在 CI 或未启动前端时失败属于环境错配，不该让「代码检查全过」变红
  // （审查 v5 · V5-032：optional 字段原先没人读，写了等于没写）。
  const soft = failed.filter((f) => f.optional)
  if (soft.length) console.log(`可选环节失败 ${soft.length} 项（不影响结果）：${soft.map((f) => f.title).join('、')}`)
}
if (hardFailed.length) {
  console.error(`失败 ${hardFailed.length} 项：${hardFailed.map((f) => f.title).join('、')}`)
  process.exit(1)
}
console.log('全部通过')
