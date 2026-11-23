/**
 * unzipSafe 回归（替代 extract-zip 自研解压）
 *
 * 覆盖：正常嵌套目录 / 空目录条目 / 符号链接 / 路径穿越 / 绝对路径 / 反斜杠路径。
 * 样本用 Python zipfile 生成（jszip 造不出 symlink 和恶意路径）。
 *
 * 跑法：node testjs/smoke/unzip-safe-test.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { unzipSafe } = require('../../student-backend/services/unzipSafe')

// 本次运行的独占沙箱：样本、输出、"泄漏"落点全在里面。
// 原写法把样本放仓库固定目录，还去系统 temp 删通用文件名 evil.txt —— 会删别人的文件。
// 现在用 mkdtemp + 随机 marker 隔离，退出时兜底清理。
const RUN_ID = crypto.randomBytes(4).toString('hex')
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'unzipsafe-'))
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch (_) {} })
const TMP = path.join(SANDBOX, 'samples')
// 输出放深两层：恶意条目的 ../../ 落点仍在沙箱内，可被检测，不外溢到系统 temp
const OUT_ROOT = path.join(SANDBOX, 'a', 'b', 'out')
// 绝对路径恶意样本指向沙箱内位置（unzipSafe 若失守，才会出现这个文件）
const ABS_EVIL = path.join(SANDBOX, `absolute-evil-${RUN_ID}.txt`)
const PY = process.env.PYTHON || 'python'

// 样本依赖 Python 的 zipfile（jszip 造不出 symlink / 恶意路径）；
// 没装 python 时按「环境不具备」跳过（退出码 3），而不是抛 ENOENT 记成失败。
function pythonAvailable() {
  try {
    execFileSync(PY, ['--version'], { stdio: 'ignore' })
    return true
  } catch (_) { return false }
}

// 找本次沙箱里所有「泄漏证据」文件：用 RUN_ID 做 marker，绝不与外部文件名撞名。
// 不再去系统 temp / 仓库 tmp 删通用文件名 evil.txt —— 那是别人的文件。
function leakedFiles() {
  const marker = `evil-${RUN_ID}`
  const found = []
  function walk(dir) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.includes(marker)) found.push(p)
    }
  }
  walk(SANDBOX)
  return found
}

function buildSamples() {
  fs.mkdirSync(TMP, { recursive: true })
  // 沙箱独占新建，没有"上一轮残留"要清；检测只认本次 marker，不与外部文件混淆。
  const code = `
import zipfile, os
d = r'${TMP.replace(/\\/g, '/')}'
marker = '${RUN_ID}'
abs_evil = r'${ABS_EVIL.replace(/\\/g, '/')}'
big = 'X' * (512 * 1024)   # 512KB，验证流式不整体读入

# ① 正常包：嵌套目录 + 空目录 + 大文件
with zipfile.ZipFile(os.path.join(d,'ok.zip'),'w',zipfile.ZIP_DEFLATED) as z:
    z.writestr('ffmpeg/bin/ffmpeg.exe', big)
    z.writestr('ffmpeg/README.txt', 'hello')
    z.writestr('ffmpeg/empty/', '')
    z.writestr('LICENSE', 'MIT')

# ② 符号链接
with zipfile.ZipFile(os.path.join(d,'symlink.zip'),'w') as z:
    zi = zipfile.ZipInfo('link'); zi.create_system = 3; zi.external_attr = (0o120777 << 16)
    z.writestr(zi, '/etc/passwd')

# ③ 路径穿越（落点带 marker，仍在本次独占沙箱内，可被检测）
with zipfile.ZipFile(os.path.join(d,'traversal.zip'),'w') as z:
    z.writestr('../../evil-' + marker + '.txt', 'x')

# ④ 绝对路径（指向沙箱内的独占位置，不碰系统 /tmp 的通用文件名）
with zipfile.ZipFile(os.path.join(d,'abs.zip'),'w') as z:
    z.writestr(abs_evil, 'x')

# ⑤ 反斜杠路径
with zipfile.ZipFile(os.path.join(d,'backslash.zip'),'w') as z:
    z.writestr('sub\\\\..\\\\..\\\\evil-' + marker + '.txt', 'x')
`
  execFileSync(PY, ['-c', code], { stdio: 'inherit' })
}

const cases = [
  ['ok.zip', true],
  ['symlink.zip', false],
  ['traversal.zip', false],
  ['abs.zip', false],
  ['backslash.zip', false],
]

;(async () => {
  if (!pythonAvailable()) {
    console.log('SKIP：未找到 python（可用 PYTHON 环境变量指定），unzipSafe 回归跳过')
    process.exit(3)
  }
  buildSamples()
  let failed = 0

  for (const [file, shouldPass] of cases) {
    const out = path.join(OUT_ROOT, 'out-' + file.replace('.zip', ''))
    let passed = false
    let msg = ''
    try {
      await unzipSafe(path.join(TMP, file), out)
      passed = true
    } catch (e) {
      msg = e.message
    }
    const ok = passed === shouldPass
    if (!ok) failed++
    console.log(`${ok ? '✓' : '✗'} ${file.padEnd(16)} 期望${shouldPass ? '成功' : '拒绝'}  实际${passed ? '成功' : '拒绝'}${msg ? '  → ' + msg : ''}`)
  }

  // 正常包的内容完整性
  const base = path.join(OUT_ROOT, 'out-ok')
  const checks = [
    ['ffmpeg/bin/ffmpeg.exe', 512 * 1024],
    ['ffmpeg/README.txt', 5],
    ['LICENSE', 3],
  ]
  for (const [rel, size] of checks) {
    const p = path.join(base, rel)
    const ok = fs.existsSync(p) && fs.statSync(p).size === size
    if (!ok) failed++
    console.log(`${ok ? '✓' : '✗'} 解压内容 ${rel}（期望 ${size} 字节）`)
  }
  const emptyDirOk = fs.existsSync(path.join(base, 'ffmpeg/empty'))
  if (!emptyDirOk) failed++
  console.log(`${emptyDirOk ? '✓' : '✗'} 空目录条目已创建`)

  // 恶意包不应该在目标目录外产生任何东西：只查本次沙箱里带 marker 的文件，
  // 不碰系统 temp / 仓库 tmp 的通用文件名。
  const leaked = leakedFiles()
  if (leaked.length) failed++
  console.log(`${leaked.length ? '✗' : '✓'} 目标目录外没有产生文件${leaked.length ? '（发现 ' + leaked.join(',') + '）' : ''}`)

  console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
  fs.rmSync(SANDBOX, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
})()
