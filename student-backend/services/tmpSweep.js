// =========================================================================
// tmpSweep.js —— 启动期回收崩溃遗留的临时文件（v8 审查 P2-08 · RC-TMP）
//
// 四条临时链路（AI 附件 / 备份还原上传 / 还原解包目录 / OCR 中转文件）正常路径
// 都有 finally 清理；缺的是「进程被强杀 / 断电」后的兜底：tmp 里的半截文件会
// 逐次累积，空间面板也看不到。
//
// 启动时扫一遍，只删「超过 24 小时」的条目 —— 正常在途文件都是本次启动后新写的，
// 不会被误删；同机其它实例（理论上单实例锁保证没有）留下的旧件也能顺手清掉。
// 失败一律静默：清理临时文件不能影响启动。
// =========================================================================
const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

function removeIfOld(fullPath, now, maxAgeMs) {
  try {
    const st = fs.lstatSync(fullPath)
    if (now - st.mtimeMs <= maxAgeMs) return 0
    fs.rmSync(fullPath, { recursive: true, force: true })
    return 1
  } catch (_) {
    return 0
  }
}

// 扫描一个目录里匹配的条目；match 收 name + isDirectory。
function sweepDir(dir, match, { now, maxAgeMs, dirsOnly = false }) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return 0 }
  let removed = 0
  for (const ent of entries) {
    if (dirsOnly && !ent.isDirectory()) continue
    if (!match(ent.name, ent.isDirectory())) continue
    removed += removeIfOld(path.join(dir, ent.name), now, maxAgeMs)
  }
  return removed
}

// 返回被清理的条目数（供日志/单测）。
function sweepTempOrphans({
  dataDir = '',
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  tmpRoot = os.tmpdir(),
} = {}) {
  let removed = 0
  // AI 附件 / 备份还原上传：整目录里的文件都是本应用写的
  for (const name of ['ai-uploads', 'classnest-restore']) {
    removed += sweepDir(path.join(tmpRoot, name), () => true, { now, maxAgeMs })
  }
  // OCR 中转：src 是输入临时件、out 是识别结果
  removed += sweepDir(tmpRoot, (name) => /^ocr-(src|out)-/.test(name), { now, maxAgeMs })
  // 还原解包目录：<dataDir>/.restore-<ts>（只清目录，别碰同目录的业务文件）
  if (dataDir) {
    removed += sweepDir(dataDir, (name) => name.startsWith('.restore-'), { now, maxAgeMs, dirsOnly: true })
    // 缩略图半成品：<dataDir>/cache/album-thumbs/<slug>/{id}.{ts}{rand}.jpg
    // 正常文件只有 {id}.jpg 一个点；多于一个点的是 rename 前被强杀留下的（K01-04）。
    const thumbRoot = path.join(dataDir, 'cache', 'album-thumbs')
    let slugs = []
    try { slugs = fs.readdirSync(thumbRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch (_) { /* best-effort: 未启用相册 */ }
    for (const s of slugs) {
      removed += sweepDir(path.join(thumbRoot, s), (name, isDir) => !isDir && name.split('.').length > 2, { now, maxAgeMs })
    }
  }
  return removed
}

module.exports = { sweepTempOrphans, DEFAULT_MAX_AGE_MS }
