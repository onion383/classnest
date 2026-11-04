// =========================================================================
// export-format-probe.cjs —— 导出格式三处清单对账（审查 v4 · B01-07）
//
// 问题背景：
//   「哪些文件格式允许导出」这件事，在本项目里有**三份彼此独立维护的清单**：
//     1) 后端  student-backend/routes/ai/ai.tools/tools.executors/executors.js
//              → EXPORT_FORMATS（AI export_file 工具接受什么）
//     2) 前端  student-frontend/src/composables/exportFormats.js
//              → FORMAT_OPTIONS（表格导出对话框给用户选什么）
//              → 以及各 exporter 里 saveBlobWithDialog(`${filename}.xxx`) 的实际扩展名
//     3) 主进程 electron/main/main.dialogs.js
//              → ALLOWED_SAVE_EXTS（save-file 通道允许落盘什么扩展名）
//
//   三处不同步的后果：
//     · 后端加了格式、前端能生成、主进程白名单没加 → 导出走到最后一步被拒，
//       用户看到「不支持保存为该文件类型」，但**不知道是主进程漏登记**；
//     · 前端加了格式、后端枚举没加 → AI 选了新格式直接被后端拒；
//     · 白名单比实际能力宽 → 主进程成了「任意扩展名写盘入口」，纵深防御失效。
//
//   台账 v4 的 B01-07 原文写的是「白名单仍 9 项，AI 自由格式 .docx/.pptx/.zip 导出被拒」，
//   但复核代码发现：后端 export_file 的 format 枚举就是 xlsx/csv/md/txt/json，
//   前端也只产这几种，**白名单一项都没拒** —— 原文的前提不成立。
//   真正成立的是「三处清单无对账机制」，本探针锁的就是这个。
//
// 判据：
//   1) 主进程 ALLOWED_SAVE_EXTS ⊇ 前端所有 exporter 实际用到的扩展名
//      （少一个 = 那个格式导出必然失败）
//   2) 主进程 ALLOWED_SAVE_EXTS ⊇ 后端 EXPORT_FORMATS（AI 导出走同一条 save-file 通道）
//   3) 后端 EXPORT_FORMATS ⊆ 后端 schema 的 format 枚举
//      （枚举与校验不一致 = schema 骗模型，模型选了却被拒）
//   4) 前端 FORMAT_OPTIONS 的每个 value 都能走到某个 exporter（有分支实现）
//
// 运行：node testjs/probe/export-format-probe.cjs
// =========================================================================

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let failed = 0
const failures = []
function assert(cond, msg) {
  if (!cond) { failed++; failures.push(msg) }
}

// ---- 1) 主进程白名单 ----
const dialogsSrc = read('electron/main/main.dialogs.js')
const m = dialogsSrc.match(/const ALLOWED_SAVE_EXTS = new Set\(\[([\s\S]*?)\]\)/)
assert(!!m, 'main.dialogs.js 里找不到 ALLOWED_SAVE_EXTS 定义')
const allowedExts = new Set(
  m ? (m[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')) : []
)
assert(allowedExts.size > 0, 'ALLOWED_SAVE_EXTS 解析出 0 项')

// ---- 2) 前端实际用到的扩展名（扫所有 saveBlobWithDialog 调用点）----
// 形如 saveBlobWithDialog(`${filename}.csv`, ...) / saveBlobWithDialog(`${name}.${ext}`, ...)
// 动态的 ${ext} 单独处理（其取值来自后端 EXPORT_FORMATS）
const frontendDir = path.join(ROOT, 'student-frontend/src')
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(vue|js)$/.test(e.name)) out.push(p)
  }
  return out
}
const frontendExts = new Set()
let hasDynamicExt = false
for (const f of walk(frontendDir)) {
  const src = fs.readFileSync(f, 'utf8')
  const re = /saveBlobWithDialog\(\s*`[^`]*?\.([A-Za-z0-9]+)`/g
  let mm
  while ((mm = re.exec(src))) {
    if (mm[1] === '${ext}') hasDynamicExt = true
    else frontendExts.add('.' + mm[1].toLowerCase())
  }
  // 另一种写法：saveBlobWithDialog(name + '.xlsx', ...)
  const re2 = /saveBlobWithDialog\([^,)]*\+\s*'\.([A-Za-z0-9]+)'/g
  while ((mm = re2.exec(src))) frontendExts.add('.' + mm[1].toLowerCase())
}
assert(frontendExts.size > 0, '前端没扫到任何 saveBlobWithDialog 扩展名（判据失效）')

// ---- 3) 后端 EXPORT_FORMATS ----
const execSrc = read('student-backend/routes/ai/ai.tools/tools.executors/executors.js')
const em = execSrc.match(/const EXPORT_FORMATS = \[([^\]]*)\]/)
assert(!!em, 'executors.js 里找不到 EXPORT_FORMATS')
const backendFormats = em
  ? (em[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, ''))
  : []

// ---- 4) 后端 schema 的 format 枚举 ----
const schemaSrc = read('student-backend/routes/ai/ai.tools/tools.schema.js')
const schemaBlock = schemaSrc.match(/name: 'export_file'[\s\S]*?format: \{ type: 'string', enum: \[([^\]]*)\]/m)
assert(!!schemaBlock, 'schema.js 里找不到 export_file 的 format 枚举')
const schemaFormats = schemaBlock
  ? (schemaBlock[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, ''))
  : []

// ---- 5) 前端 FORMAT_OPTIONS ----
const fmtSrc = read('student-frontend/src/composables/exportFormats.js')
const fmtOptions = (fmtSrc.match(/\{ value: '([a-z]+)', label:/g) || []).map((s) => {
  const mm = s.match(/value: '([a-z]+)'/)
  return mm ? mm[1] : null
}).filter(Boolean)
// format → 落盘扩展名（image 走 PNG，其余同名）
const FORMAT_TO_EXT = { image: '.png', html: '.html', pdf: '.pdf' }

// ---- 6) 收据能上传的类型（收据「另存」也是 save-file 通道的出口）----
// 收据另存时的文件名来自文件本身，扩展名是动态的，扫不出字面量；
// 但「能传什么类型」有一份真实定义在后端 uploadSignatures.js 的 KINDS 里，
// 能传上去就必须能另存下来 —— 否则用户传了 jpg 却存不出来。
const uploadSrc = read('student-backend/services/uploadSignatures.js')
const receiptExts = new Set(
  [...uploadSrc.matchAll(/exts:\s*\[([^\]]*)\]/g)]
    .flatMap((x) => (x[1].match(/'([^']+)'/g) || []).map((e) => '.' + e.replace(/'/g, '').toLowerCase()))
)

// ================= 判据 =================

// 判据 1：主进程白名单 ⊇ 前端实际用到的扩展名
for (const ext of frontendExts) {
  assert(allowedExts.has(ext),
    `主进程 ALLOWED_SAVE_EXTS 缺少前端在用的扩展名 ${ext} —— 该格式导出必然被拒（用户看到「不支持保存为该文件类型」）`)
}

// 判据 2：主进程白名单 ⊇ 后端 EXPORT_FORMATS（AI 导出走同一条 save-file 通道）
for (const f of backendFormats) {
  const ext = '.' + f.toLowerCase()
  assert(allowedExts.has(ext),
    `主进程 ALLOWED_SAVE_EXTS 缺少后端 EXPORT_FORMATS 的 ${f}（AI 导出 ${f} 会被 save-file 拒掉）`)
}

// 判据 3：后端枚举 ⊆ schema 枚举（否则模型按 schema 选了却被校验拒）
for (const f of backendFormats) {
  assert(schemaFormats.includes(f),
    `后端 EXPORT_FORMATS 含 ${f}，但 schema 的 format 枚举里没有 —— schema 骗模型，模型选了必被拒`)
}

// 判据 4：schema 枚举 ⊆ EXPORT_FORMATS（反方向也要一致）
for (const f of schemaFormats) {
  assert(backendFormats.includes(f),
    `后端 schema 的 format 枚举含 ${f}，但 EXPORT_FORMATS 里没有 —— 同上`)
}

// 判据 5：前端 FORMAT_OPTIONS 的每个 value 都有实现分支（否则点了没反应）
const switchBlock = fmtSrc.match(/switch \(format\) \{([\s\S]*?)\n  \}/)
assert(!!switchBlock, 'exportFormats.js 里找不到 runTableExport 的 switch')
const implemented = switchBlock
  ? (switchBlock[1].match(/case '([a-z]+)'/g) || []).map((s) => s.replace(/case '/, '').replace(/'/, ''))
  : []
for (const opt of fmtOptions) {
  assert(implemented.includes(opt),
    `前端 FORMAT_OPTIONS 里的 ${opt} 没有对应的 exporter 分支 —— 选它会走 default（静默导出成 html）`)
}

// 判据 6：主进程白名单不得比「已实现能力」宽太多 —— 白名单里的每个扩展名
//         必须真的被某个出口使用，否则它就是白给的一个写盘口子。
const knownExts = new Set([
  ...frontendExts,
  ...backendFormats.map((f) => '.' + f.toLowerCase()),
  ...fmtOptions.map((o) => FORMAT_TO_EXT[o] || ('.' + o)),
  ...receiptExts,
])
for (const ext of allowedExts) {
  assert(knownExts.has(ext),
    `主进程白名单里的 ${ext} 没有任何出口在用 —— 白名单比实际能力宽，多余的扩展名等于多开一个写盘口子`)
}

// 判据 7：收据能上传的类型必须都能另存（两条都走 save-file 通道）
//         收据「另存/下载」用的文件名来自文件本身，扩展名动态；
//         白名单里没有它 = 用户传了却存不出来，报「不支持保存为该文件类型」。
for (const ext of receiptExts) {
  assert(allowedExts.has(ext),
    `收据支持上传 ${ext}，但主进程 ALLOWED_SAVE_EXTS 里没有 —— 收据「另存」这一步必然被拒`)
}

// ---- 输出 ----
if (failed) {
  console.error('✗ export-format-probe 失败：')
  for (const f of failures) console.error('   - ' + f)
  process.exit(1)
}
console.log('✓ export-format-probe 通过')
console.log('  主进程白名单：', [...allowedExts].sort().join(' '))
console.log('  前端在用：    ', [...frontendExts].sort().join(' ') + (hasDynamicExt ? ' + ${ext}(后端枚举)' : ''))
console.log('  后端枚举：    ', backendFormats.join(' ') || '(空)')
console.log('  schema 枚举： ', schemaFormats.join(' ') || '(空)')
console.log('  前端选项：    ', fmtOptions.join(' ') || '(空)')
