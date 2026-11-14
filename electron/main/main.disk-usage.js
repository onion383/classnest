// =========================================================================
// main.disk-usage.js —— 性能面板「空间管理」的磁盘占用统计
//
// 只做只读扫描（readdir + stat，不删不改），按六类归账：
//   app            软件本体   —— 程序安装目录（exe 所在目录，含 resources）
//   currentAccount 该账号数据 —— 当前登录账号的库文件（@slug.db + -wal/-shm）
//   otherAccounts  其他账号数据 —— 其余 @slug.db
//   uploads        上传文件   —— uploads / album-trash / receipt-trash（多账号共享的用户文件）
//   thumbs         图片微缩图 —— 缩略图目录（album-thumbs，所有账号合计）
//   logs           日志       —— backend.log / inp.log / startup.log / desktop-layer.log
//   other          其他       —— index.db、快照、AI 记忆等剩余部分
//
// 不 require('electron')：主进程入口只传目录进来，这样本模块能被 node 直接单测。
// 软件本体在进程内缓存一次（安装目录运行期不变）；数据目录每次重算，因为库文件与
// 缩略图会随使用增长。
// =========================================================================

const fsp = require('node:fs/promises')
const path = require('node:path')

// 账号库文件名：@ + 12 位十六进制（见后端 dbManager.account.js 的 createTeacher）
const ACCOUNT_DB_RE = /^@([0-9a-f]{12})\.db(?:-(?:wal|shm))?$/i
const THUMBS_DIRNAME = 'album-thumbs'
// 归「上传文件」的目录：uploads 是班费收据等共享用户文件；
// 两个回收站里的东西本质也是用户数据（只是待清理），归到「其他」会让人以为是可以随手删的垃圾。
const UPLOAD_DIRNAMES = new Set(['uploads', 'album-trash', 'receipt-trash'])
// 日志出口（见 main.logRotator.js）：只认固定文件名，别的 .log 不替他做主
const LOG_FILENAMES = new Set(['backend.log', 'inp.log', 'startup.log', 'desktop-layer.log'])

// 单个目录里文件的 stat 并发度：Windows 上单次 stat 约 0.1ms，
// 缩略图目录动辄几千个 jpg，串行 await 要几百 ms（实测整次统计 1s），分批并发可压到 1/5 以内。
const STAT_BATCH = 64

// 迭代遍历算目录字节数：异步 readdir 不长时间占住主线程，单条失败跳过不中断整次统计。
// 用显式栈而不是递归，避免深层目录把调用栈打爆。
async function dirSize(root) {
  let total = 0
  const stack = [root]
  while (stack.length) {
    const cur = stack.pop()
    let entries = []
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true })
    } catch (_) {
      continue // 目录不存在 / 无权限：按 0 计，不抛出
    }
    const files = []
    for (const e of entries) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else files.push(p)
    }
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const batch = files.slice(i, i + STAT_BATCH)
      const sizes = await Promise.all(batch.map((p) => fsp.stat(p).then((st) => st.size, () => 0)))
      for (const s of sizes) total += s
    }
  }
  return total
}

// 数据目录顶层条目的归类（纯函数，便于单测）：
// 账号库 / 缩略图目录 / 其余一律进「其他」。slug 为空时所有账号库都算「其他账号」。
// 注意 slug 的两种写法：库内 db_slug 带 @ 前缀（形如 @1310e52f7763，登录态给前端的就是它），
// 文件名正则的捕获组不带 —— 比较前统一去掉前导 @，否则当前账号永远匹配不上。
function normalizeSlug(s) {
  return String(s || '').toLowerCase().replace(/^@/, '')
}

function classifyEntry(name, slug) {
  if (name === THUMBS_DIRNAME) return 'thumbs'
  if (UPLOAD_DIRNAMES.has(name)) return 'uploads'
  if (LOG_FILENAMES.has(name)) return 'logs'
  const m = ACCOUNT_DB_RE.exec(name)
  if (m) {
    const cur = normalizeSlug(slug)
    return cur && normalizeSlug(m[1]) === cur ? 'currentAccount' : 'otherAccounts'
  }
  return 'other'
}

// 额外日志目录里只数四个固定日志文件：desktop-layer.log 在 userData 根、
// startup.log/backend.log 在 userData/data，数据目录被改到别处后它们都不在 dataDir 里。
async function logBytesIn(dir) {
  let total = 0
  for (const name of LOG_FILENAMES) {
    try { total += (await fsp.stat(path.join(dir, name))).size } catch (_) { /* 不存在按 0 */ }
  }
  return total
}

// 日志出口的绝对路径清单（按目录去重）：统计与「清理日志」共用这一份，
// 避免两处对「哪些文件算日志」的判断漂移。
function logFilePaths(dataDir, logDirs = []) {
  const seen = new Set()
  const files = []
  for (const dir of [dataDir, ...(Array.isArray(logDirs) ? logDirs : [])]) {
    if (!dir) continue
    const resolved = path.resolve(dir)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    for (const name of LOG_FILENAMES) files.push(path.join(resolved, name))
  }
  return files
}

// 软件本体体积缓存：安装目录在运行期不会变（升级要重启），只扫一次
let appSizeCache = { dir: '', bytes: 0 }

async function appSizeBytes(appDir) {
  if (!appDir) return 0
  const dir = path.resolve(appDir)
  if (appSizeCache.dir === dir) return appSizeCache.bytes
  const bytes = await dirSize(dir)
  // 扫描失败（目录读到一半报错）也给个结果，但别替下一次背这个 0
  appSizeCache = { dir, bytes }
  return bytes
}

// 仅供测试：清掉软件本体缓存
function resetAppSizeCache() {
  appSizeCache = { dir: '', bytes: 0 }
}

async function scanDiskUsage({ appDir, dataDir, thumbsDir, logDirs, slug } = {}) {
  if (!dataDir) throw new Error('scanDiskUsage 需要 dataDir')

  const out = {
    app: await appSizeBytes(appDir),
    currentAccount: 0,
    otherAccounts: 0,
    uploads: 0,
    thumbs: 0,
    logs: 0,
    other: 0,
    total: 0,
  }

  // v2 分层布局：数据根目录下固定 core / content / cache / logs 四层。
  // 顶层只剩四个目录名，原先「按顶层条目名分类」会全归进 other，因此逐层扫描、
  // 每层用自己的分类器；classifyEntry 仍在 core 层负责账号库与 index.db 的区分。
  const layers = [
    { dir: path.join(dataDir, 'core'), classify: (name) => classifyEntry(name, slug) },
    { dir: path.join(dataDir, 'content'), classify: (name) => UPLOAD_DIRNAMES.has(name) ? 'uploads' : 'other' },
    { dir: path.join(dataDir, 'cache'), classify: (name) => name === THUMBS_DIRNAME ? 'thumbs' : 'other' },
    { dir: path.join(dataDir, 'logs'), classify: (name) => LOG_FILENAMES.has(name) ? 'logs' : 'other' },
  ]
  const thumbsResolved = thumbsDir ? path.resolve(thumbsDir) : ''
  let thumbsSeen = false
  for (const layer of layers) {
    let entries = []
    try {
      entries = await fsp.readdir(layer.dir, { withFileTypes: true })
    } catch (_) {
      continue // 目录不存在：按 0 计
    }
    // 层内各项并行扫：库文件是零散大文件、uploads 等是成千上万小文件，
    // 串行累加会让最慢的那项决定整体耗时。
    const parts = await Promise.all(entries.map(async (e) => {
      const p = path.join(layer.dir, e.name)
      const isThumbs = thumbsResolved && path.resolve(p) === thumbsResolved
      if (isThumbs) thumbsSeen = true
      const bucket = isThumbs ? 'thumbs' : layer.classify(e.name)
      if (e.isDirectory()) return { bucket, bytes: await dirSize(p) }
      try {
        return { bucket, bytes: (await fsp.stat(p)).size }
      } catch (_) {
        return { bucket, bytes: 0 } // 单条失败忽略（文件刚被删/占用是常态）
      }
    }))
    for (const part of parts) out[part.bucket] += part.bytes
  }

  // 缩略图目录指在四层之外时单独补扫一次；已扫过的不重复加。
  if (thumbsResolved && !thumbsSeen) {
    out.thumbs += await dirSize(thumbsResolved)
  }

  // 额外的日志出口（desktop-layer.log 仍在 userData 根）；logs/ 层已扫过，
  // 与它同目录的传参要跳过，避免同一份日志被数两遍。
  const seenLogDirs = new Set([path.resolve(dataDir), path.resolve(path.join(dataDir, 'logs'))])
  for (const dir of Array.isArray(logDirs) ? logDirs : []) {
    if (!dir) continue
    const resolved = path.resolve(dir)
    if (seenLogDirs.has(resolved)) continue
    seenLogDirs.add(resolved)
    out.logs += await logBytesIn(resolved)
  }

  out.total = out.app + out.currentAccount + out.otherAccounts + out.uploads + out.thumbs + out.logs + out.other
  return out
}

module.exports = {
  scanDiskUsage,
  classifyEntry,
  dirSize,
  resetAppSizeCache,
  logFilePaths,
  ACCOUNT_DB_RE,
  THUMBS_DIRNAME,
}
