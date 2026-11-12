// =========================================================================
// pkg-size-probe.cjs —— 打包体积构成 + 生产依赖存在性（v6 性能专题 · 1-12）
//
// 回答两个问题：
//   ① 装出来的包到底被什么撑大的？（app.asar / 解出来的 node_modules / locales / ffmpeg …）
//   ② package.json 的 dependencies 里每个包是不是真的能解析到？（漏装的 prod 依赖
//      在打包后才会表现为「启动时 require 失败」，本探针把它提前到构建期）
//
// 用法：
//   node testjs/probe/pkg-size-probe.cjs                 # 自动找 release*/win-unpacked
//   node testjs/probe/pkg-size-probe.cjs --dir=release-perf/win-unpacked
//   node testjs/probe/pkg-size-probe.cjs --json          # 机器可读
//   node testjs/probe/pkg-size-probe.cjs --selftest      # 自证分桶/格式化逻辑
//
// 只读：不写文件、不改配置。
// =========================================================================

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.CLASSNEST_ROOT || path.resolve(__dirname, '../..')

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// 把一个相对路径归到「体积桶」。纯函数，便于自证。
// 目的不是精确到文件，而是回答「哪一类占了最多」。
function bucketOf(rel) {
  const p = String(rel).split(path.sep).join('/')
  if (/^resources\/app\.asar$/.test(p)) return 'resources/app.asar'
  const unpacked = /^resources\/app\.asar\.unpacked\/(.+)$/.exec(p)
  if (unpacked) {
    const rest = unpacked[1]
    // 后端自己的 node_modules 与根 node_modules 分开算：两者装的是不同的包
    const backend = /^student-backend\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(rest)
    if (backend) return `backend-dep ${backend[1]}`
    const dep = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(rest)
    if (dep) return `dep ${dep[1]}`
    return 'resources/unpacked-other'
  }
  if (/^locales\//.test(p)) return 'locales'
  if (/^resources\//.test(p)) return 'resources/other'
  // 只有根目录下的二进制才算 exe / dll：resources 里的 ffmpeg 等已归入 resources/other，
  // 它们由下面「大文件」那一节单独列出，避免把 8MB 的 ffmpeg 混进 234MB 的主程序里。
  if (/\.exe$/i.test(p)) return 'exe'
  if (/\.dll$/i.test(p)) return 'dll'
  return 'other'
}

function walk(dir, base = dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return out }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) walk(abs, base, out)
    else {
      let size = 0
      try { size = fs.statSync(abs).size } catch (_) { /* 读不到按 0 算 */ }
      out.push({ rel: path.relative(base, abs), size })
    }
  }
  return out
}

// 返回 [{ bucket, bytes }]，按体积降序。
function summarize(files) {
  const map = new Map()
  for (const f of files) {
    const b = bucketOf(f.rel)
    map.set(b, (map.get(b) || 0) + (f.size || 0))
  }
  return [...map.entries()]
    .map(([bucket, bytes]) => ({ bucket, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
}

function findPackageDir(explicit) {
  if (explicit) {
    const abs = path.resolve(ROOT, explicit)
    return fs.existsSync(abs) ? abs : null
  }
  let names = []
  try { names = fs.readdirSync(ROOT) } catch (_) { return null }
  const candidates = names
    .filter((n) => /^release/.test(n))
    .map((n) => path.join(ROOT, n, 'win-unpacked'))
    .filter((p) => fs.existsSync(p))
  return candidates[0] || null
}

// 生产依赖存在性：能 resolve 到才算「打包后不会启动即崩」。
function checkProdDeps(root = ROOT) {
  let pkg = {}
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) } catch (_) { return [] }
  return Object.keys(pkg.dependencies || {}).map((name) => {
    let ok = false
    let resolved = ''
    try {
      resolved = require.resolve(name, { paths: [root] })
      ok = true
    } catch (_) { /* 解析失败就是缺 */ }
    return { name, ok, resolved }
  })
}

function printReport(dir) {
  const files = walk(dir)
  const total = files.reduce((s, f) => s + f.size, 0)
  const rows = summarize(files)
  const deps = checkProdDeps()

  console.log(`目录：${dir}`)
  console.log(`总大小：${fmtBytes(total)}（${files.length} 个文件）`)
  console.log('')
  console.log('体积构成（前 15 项）：')
  for (const r of rows.slice(0, 15)) {
    const pct = total ? ((r.bytes / total) * 100).toFixed(1) : '0.0'
    console.log(`  ${String(r.bytes).padStart(12)} B  ${pct.padStart(5)}%  ${fmtBytes(r.bytes).padStart(9)}  ${r.bucket}`)
  }
  // 大项必须可见：ffmpeg 与字体
  const big = files.filter((f) => /ffmpeg\.exe$|\.ttf$|\.otf$/i.test(f.rel)).sort((a, b) => b.size - a.size)
  if (big.length) {
    console.log('')
    console.log('大文件（ffmpeg / 字体）：')
    for (const f of big.slice(0, 8)) console.log(`  ${fmtBytes(f.size).padStart(9)}  ${f.rel}`)
  }
  console.log('')
  console.log('生产依赖可解析性：')
  for (const d of deps) console.log(`  ${d.ok ? 'OK  ' : 'MISS'} ${d.name}${d.ok ? '' : '（打包后会在 require 时失败）'}`)
  return { total, rows, deps }
}

function selftest() {
  let failed = 0
  const eq = (a, b, msg) => { if (a !== b) { failed++; console.error(`✗ ${msg}：期望 ${b}，实际 ${a}`) } }

  eq(fmtBytes(0), '0 B', '0 字节')
  eq(fmtBytes(1023), '1023 B', '字节边界')
  eq(fmtBytes(1024), '1.0 KB', 'KB 边界')
  eq(fmtBytes(5 * 1024 * 1024), '5.0 MB', 'MB')
  eq(bucketOf('resources/app.asar'), 'resources/app.asar', 'asar')
  eq(bucketOf('resources/app.asar.unpacked/node_modules/koffi/build/koffi.node'), 'dep koffi', '根依赖')
  eq(bucketOf('resources/app.asar.unpacked/node_modules/@scope/pkg/a.js'), 'dep @scope/pkg', '作用域依赖')
  eq(bucketOf('resources/app.asar.unpacked/student-backend/node_modules/sharp/a.js'), 'backend-dep sharp', '后端依赖')
  eq(bucketOf('locales/zh-CN.pak'), 'locales', '语言包')
  eq(bucketOf('ffmpeg.exe'), 'exe', '可执行')

  const rows = summarize([
    { rel: 'resources/app.asar', size: 100 },
    { rel: 'resources/app.asar', size: 50 },
    { rel: 'locales/a.pak', size: 10 },
  ])
  eq(rows[0].bucket, 'resources/app.asar', '分桶排序（最大在前）')
  eq(rows[0].bytes, 150, '同桶累加')
  eq(rows.length, 2, '桶去重')

  const deps = checkProdDeps()
  if (!deps.length) { failed++; console.error('✗ 没有读到任何生产依赖') }
  for (const d of deps) if (!d.ok) { failed++; console.error(`✗ 生产依赖无法解析：${d.name}`) }

  if (failed) { console.error(`\n✗ pkg-size-probe 自证失败 ${failed} 条`); process.exit(1) }
  console.log('✓ pkg-size-probe 自证通过')
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--selftest')) return selftest()
  const dirArg = args.find((a) => a.startsWith('--dir='))
  const dir = findPackageDir(dirArg ? dirArg.slice(6) : null)
  if (!dir) {
    console.error('未找到打包产物（release*/win-unpacked）。先执行 npm run electron:build，或用 --dir= 指定。')
    process.exit(1)
  }
  const out = printReport(dir)
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 2))
  const missing = out.deps.filter((d) => !d.ok)
  if (missing.length) process.exit(1)
}

if (require.main === module) main()

module.exports = { fmtBytes, bucketOf, summarize, walk, checkProdDeps, findPackageDir }
