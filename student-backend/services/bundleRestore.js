// =========================================================================
// bundleRestore.js —— 把「已校验通过的 v3 备份包」落到磁盘
//
// 这一步动的是用户的**整库和全部文件**，所以它只有一份实现，两个入口共用：
//   · 登录中恢复（POST /api/account/restore-zip，slug 取自 JWT）
//   · 新机离线恢复（POST /api/account/restore-zip-offline，slug 取自包内 meta）
// 两个入口的差别只有「slug 从哪来 / 要不要确认覆盖 / 要不要签发登录态」，
// 落盘逻辑若各写一份，任何一份漏掉「空目录不替换」就是一次静默的数据清空。
//
// 调用约定：receiveAndVerify() 必须先跑完（包是好的），applyVerifiedBundle() 才开始动数据。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')
const dbManager = require('../dbManager/dbManager')
// service 反向引用 route 层唯一的一处，是为了让「整库被换掉 → 列缓存必须失效」
// 跟着落盘一起做：拆给调用方去调，就等于又留了一个「谁忘了调」的坑。
// ai.helpers 只依赖 db + dbManager，不依赖本文件，不存在循环。
const aiHelpers = require('../routes/ai/ai.helpers')
const { extractAndVerify, replaceDir } = require('./backupArchive')

// 上传落地的临时文件 → 解到数据目录下的 .restore-<时间戳> → 逐项校验清单。
// **这一步不碰任何现有数据**：包坏、缺项、名字不安全全在这里失败，用户的库和文件还是原样。
async function receiveAndVerify(file) {
  if (!file || !file.path) throw new Error('没有收到备份文件')
  const tmpDir = path.join(dbManager.dataDir, `.restore-${Date.now()}`)
  try {
    const verified = await extractAndVerify(file.path, tmpDir)
    return { tmpDir, ...verified }
  } catch (err) {
    dropTmp(tmpDir, null)
    throw err
  }
}

function dropTmp(tmpDir, filePath) {
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) { /* 清不掉不影响结果 */ } }
  if (filePath) { try { fs.rmSync(filePath, { force: true }) } catch (_) { /* 同上 */ } }
}

// 包里的目录 → 本机落点。顺序即替换顺序，旧目录一律改名成 .bak-<stamp>，不删。
function dirPlanOf(slug) {
  return [
    { prefix: 'uploads', dest: dbManager.uploadsDir },
    { prefix: 'ai-skills', dest: dbManager.skillsDir(slug) },
    { prefix: 'album-trash', dest: dbManager.trashDir },
    { prefix: 'receipt-trash', dest: path.join(dbManager.dataDir, 'receipt-trash') },
    { prefix: 'snapshots', dest: dbManager.snapshotsDir(slug) },
  ]
}

/**
 * 把已校验的备份包落盘。
 *
 * @param {object} p
 * @param {string} p.tmpDir    解包目录（receiveAndVerify 返回的那个）
 * @param {object} p.meta      bundle.json
 * @param {object} p.manifest  manifest.json（含 fileCount / totalBytes / omitted）
 * @param {string} p.slug      目标库标识
 * @param {string} p.username  目标账号名
 * @param {object} [p.body]    请求体：password / mnemonic（解库钥匙用）
 * @returns {{slug,username,restoredFiles,restoredBytes,dirs,omitted}}
 */
async function applyVerifiedBundle({ tmpDir, meta, manifest, slug, username, body }) {
  const stamp = Date.now()

  // 库文件：db/ 下那个非 -wal/-shm 的 .db
  const dbDir = path.join(tmpDir, 'db')
  let dbFile = null
  try {
    dbFile = (fs.readdirSync(dbDir) || []).find((n) => n.endsWith('.db') && !/-(wal|shm)$/.test(n)) || null
  } catch (_) { /* 目录不存在 → 下面统一报错 */ }
  if (!dbFile) throw new Error('备份包里没有数据库文件')

  const isEncrypted = !(meta.encrypted === false || meta.encrypted === 0 || meta.encrypted === '0')
  const dbKey = isEncrypted
    ? dbManager.decryptBundleKey({
      key: meta.key,
      wrappedByPassword: meta.wrappedByPassword,
      wrappedByMnemonic: meta.wrappedByMnemonic,
      password: body && body.password,
      mnemonic: body && body.mnemonic,
    })
    : null

  // restoreBundle 内部已经做了「先断连接 → 写临时文件 → integrity_check → 通过才覆盖」，
  // 这里不再自己写一遍（两处写库逻辑迟早会分叉）。
  // 传 srcPath 而不是 base64：解包出来的库文件已经在磁盘上，再读进内存转 base64 只会在
  // 100MB 级库上白占约 230MB 堆（133MB 字符串 + 100MB Buffer）—— 2-11 要消的就是这段。
  const result = dbManager.restoreBundle({ slug, username, srcPath: path.join(dbDir, dbFile), dbKey, encrypted: isEncrypted })
  aiHelpers.clearTableColumnsCache()

  // 目录替换：只在包里**确实有内容**时替换。
  // 否则一个「只含库文件」的小包会把现有收据目录整片清空 —— 那是最典型的静默数据丢失。
  const replaced = []
  for (const it of dirPlanOf(slug)) {
    const src = path.join(tmpDir, it.prefix)
    let has = false
    try { has = fs.statSync(src).isDirectory() && fs.readdirSync(src).length > 0 } catch (_) { has = false }
    if (!has) continue
    replaced.push({ dir: it.prefix, backup: replaceDir(src, it.dest, stamp) })
  }

  // AI 长期记忆：包里有就覆盖（v3 把它放在根目录 memory.md）
  const memPath = path.join(tmpDir, 'memory.md')
  if (fs.existsSync(memPath)) dbManager.writeMemory(slug, fs.readFileSync(memPath, 'utf8'))

  return {
    slug: result.slug || slug,
    username: result.username || username,
    restoredFiles: manifest.fileCount,
    restoredBytes: manifest.totalBytes,
    dirs: replaced,
    omitted: manifest.omitted || [],
  }
}

module.exports = { receiveAndVerify, applyVerifiedBundle, dropTmp, dirPlanOf }
