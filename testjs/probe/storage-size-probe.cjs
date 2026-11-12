// =========================================================================
// storage-size-probe.cjs —— 目录 / 日志体积只读探针（v6 性能专题 · 0-5）
//
// 用途：给 3-1（回收站保留期）与 1-1（日志轮转）提供「现在到底占多少」的基线。
// 只读：遍历目录与 stat，不删不改。
//
// 用法：
//   node testjs/probe/storage-size-probe.cjs <dataDir> [--user-data=<dir>] [--json]
//   node testjs/probe/storage-size-probe.cjs --selftest
//
// 目录口径：`dataDir` 下的 uploads / album-trash / receipt-trash / album-thumbs /
// snapshots / ai-memory / ai-skills / ffmpeg；日志口径：dataDir 的 backend.log、inp.log，
// userData 根的 desktop-layer.log、startup.log（默认取 dataDir 的上一级）。
// =========================================================================
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DIRS = ['uploads', 'album-trash', 'receipt-trash', 'album-thumbs', 'snapshots', 'ai-memory', 'ai-skills', 'ffmpeg']
const LOGS_IN_DATA = ['backend.log', 'inp.log']
const LOGS_IN_USER = ['desktop-layer.log', 'startup.log']
const MB = 1048576
const round = (n, digits = 2) => Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : 0

// 迭代遍历，避免深目录递归爆栈；单条失败跳过，不中断整次统计
function dirSize(root) {
  const out = { bytes: 0, files: 0, dirs: 0, missing: false }
  let stack = [root]
  let first = true
  while (stack.length) {
    const cur = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch (_) {
      if (first && cur === root) out.missing = true
      first = false
      continue
    }
    first = false
    for (const e of entries) {
      const abs = path.join(cur, e.name)
      if (e.isDirectory()) {
        out.dirs++
        stack.push(abs)
      } else if (e.isFile()) {
        out.files++
        try { out.bytes += fs.statSync(abs).size } catch (_) { /* 读取失败跳过 */ }
      }
    }
  }
  return out
}

function fileInfo(file) {
  try {
    const st = fs.statSync(file)
    return st.isFile() ? { path: file, bytes: st.size } : { path: file, bytes: 0, missing: true }
  } catch (_) {
    return { path: file, bytes: 0, missing: true }
  }
}

function inspectStorage({ dataDir, userDataDir } = {}) {
  if (!dataDir) throw new Error('inspectStorage 需要 dataDir')
  const userDir = userDataDir || path.dirname(dataDir)
  const dirs = DIRS.map((name) => {
    const abs = path.join(dataDir, name)
    return { name, path: abs, ...dirSize(abs) }
  })
  const logs = [
    ...LOGS_IN_DATA.map((name) => ({ name, ...fileInfo(path.join(dataDir, name)) })),
    ...LOGS_IN_USER.map((name) => ({ name, ...fileInfo(path.join(userDir, name)) })),
  ]
  const dirBytes = dirs.reduce((s, d) => s + d.bytes, 0)
  const logBytes = logs.reduce((s, l) => s + l.bytes, 0)
  return { dataDir, userDataDir: userDir, dirs, logs, totalBytes: dirBytes + logBytes, dirBytes, logBytes }
}

function formatReport(r) {
  const lines = [`[storage] data=${r.dataDir}  user=${r.userDataDir}`]
  for (const d of r.dirs) {
    if (d.missing) { lines.push(`  ${d.name.padEnd(14)} (不存在)`); continue }
    lines.push(`  ${d.name.padEnd(14)} ${String(round(d.bytes / MB)).padStart(8)}MB  ${d.files} 个文件`)
  }
  for (const l of r.logs) {
    if (l.missing) { lines.push(`  ${l.name.padEnd(18)} (不存在)`); continue }
    lines.push(`  ${l.name.padEnd(18)} ${String(round(l.bytes / MB)).padStart(8)}MB`)
  }
  lines.push(`  合计 ${round(r.totalBytes / MB)}MB（目录 ${round(r.dirBytes / MB)}MB / 日志 ${round(r.logBytes / MB)}MB）`)
  return lines
}

// 自证：造两级目录 + 两个日志文件，必须按文件字节累加；不存在的目录不能算 0 个文件蒙混。
function runSelftest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-size-probe-'))
  const dataDir = path.join(root, 'data')
  try {
    fs.mkdirSync(path.join(dataDir, 'uploads', 'deep'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'uploads', 'a.bin'), Buffer.alloc(100))
    fs.writeFileSync(path.join(dataDir, 'uploads', 'deep', 'b.bin'), Buffer.alloc(200))
    fs.writeFileSync(path.join(dataDir, 'backend.log'), Buffer.alloc(50))
    fs.writeFileSync(path.join(dataDir, 'inp.log'), Buffer.alloc(25))
    fs.writeFileSync(path.join(root, 'startup.log'), Buffer.alloc(10))

    const r = inspectStorage({ dataDir })
    const uploads = r.dirs.find((d) => d.name === 'uploads')
    if (uploads.bytes !== 300) throw new Error(`uploads 字节数不对：${uploads.bytes}`)
    if (uploads.files !== 2) throw new Error(`uploads 文件数不对：${uploads.files}`)
    if (r.logBytes !== 85) throw new Error(`日志总字节不对：${r.logBytes}`)
    const trash = r.dirs.find((d) => d.name === 'album-trash')
    if (!trash.missing) throw new Error('不存在的目录必须标记 missing')
    return r
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch (_) { /* 忽略 */ }
  }
}

function main(argv) {
  const args = argv.slice(2)
  if (args.includes('--selftest')) {
    const r = runSelftest()
    console.log(`[selftest] OK：目录 ${round(r.dirBytes / MB)}MB / 日志 ${round(r.logBytes / MB)}MB`)
    return
  }
  const dataDir = args.find((a) => !a.startsWith('--'))
  if (!dataDir) {
    console.error('用法：node testjs/probe/storage-size-probe.cjs <dataDir> [--user-data=<dir>] [--json] [--selftest]')
    process.exitCode = 1
    return
  }
  const userArg = args.find((a) => a.startsWith('--user-data='))
  const userDataDir = userArg ? userArg.slice('--user-data='.length) : undefined
  const r = inspectStorage({ dataDir, userDataDir })
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else for (const line of formatReport(r)) console.log(line)
}

if (require.main === module) main(process.argv)

module.exports = { dirSize, inspectStorage, runSelftest, DIRS }
