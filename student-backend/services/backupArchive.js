// =========================================================================
// backupArchive.js —— 整库备份包 v3（ZIP：库 + 用户文件 + 清单）
//
// 为什么要有 v3：v2 备份包（`/api/account/backup-export`）只带「库文件 + AI 长期记忆」。
// 收据原件（uploads/）、AI 技能、相册/收据回收站、整库快照全都不在包里 ——
// 换台机器恢复出来的是一个「收据全都打不开」的库，而界面不会告诉用户少了什么
// （审查 v6 · N2-02）。v3 把用户文件全部带上，并在 manifest 里逐项记字节数与 sha256，
// 还原时可以逐项核对「到底恢复了几个文件」。
//
// 这个模块只做「写包」，不碰还原（还原要覆盖当前库，是另一条更危险的路径）。
// 包里三个固定文件：
//   bundle.json   包身份（slug / 用户名 / 是否加密 / 库钥匙或包裹后的钥匙）
//   <各目录>       真实用户文件，路径已过 sanitizeEntryName
//   manifest.json 最后写：每项 {path,size,sha256} + totalBytes + omitted
//
// 「omitted」是刻意留的：album-thumbs（缩略图）是派生数据，重建成本低且体积大，
// 不入包 —— 但必须写进清单，否则用户又会以为「备份漏了东西」。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const { Transform } = require('node:stream')
const { createZipWriter } = require('./zipStream')
const { sanitizeEntryName } = require('./zipWriter')
const { createRequire } = require('node:module')
const { BACKEND_ROOT } = require('../utils/backendRoot')

const ROOT = BACKEND_ROOT
const yauzl = createRequire(path.join(ROOT, 'package.json'))('yauzl')

// 包里这三个文件由 v3 固定写入 / 读取
const META_ENTRY = 'bundle.json'
const MANIFEST_ENTRY = 'manifest.json'

// 派生数据：可由原图重建，不入包（写进 manifest.omitted 让用户知道）
const RECONSTRUCTIBLE = ['album-thumbs']

function listFiles(root) {
  const out = []
  const walk = (dir, prefix) => {
    let items
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const it of items) {
      const abs = path.join(dir, it.name)
      const rel = prefix ? `${prefix}/${it.name}` : it.name
      if (it.isDirectory()) { walk(abs, rel); continue }
      // 符号链接不跟：可能指向数据目录之外，打进包里等于把外部文件带出去
      if (it.isFile()) out.push({ abs, rel })
    }
  }
  walk(root, '')
  return out
}

/**
 * 写一个 v3 备份包。
 * @param {{
 *   meta: object,
 *   files?: Array<{name: string, path: string}>,
 *   dirs?: Array<{prefix: string, dir: string}>,
 *   texts?: Array<{name: string, data: string}>,
 *   omitted?: string[],
 * }} plan
 * @param {import('node:stream').Writable} writable
 * @returns {Promise<{entries:number, bytes:number, files:number, totalBytes:number}>}
 */
async function writeBundle(plan, writable) {
  const zip = createZipWriter(writable)
  const meta = plan.meta || {}
  await zip.add({ name: 'bundle.json', data: JSON.stringify(meta, null, 2) })

  const records = []
  const push = (rec) => { records.push(rec); return rec }

  for (const it of plan.files || []) {
    if (!it || !it.path || !fs.existsSync(it.path)) continue
    const rec = await zip.add({ name: it.name, path: it.path, hash: true })
    push({ path: rec.name, size: rec.size, sha256: rec.sha256 })
  }
  for (const t of plan.texts || []) {
    if (!t || typeof t.data !== 'string') continue
    const rec = await zip.add({ name: t.name, data: t.data, hash: true })
    push({ path: rec.name, size: rec.size, sha256: rec.sha256 })
  }
  for (const src of plan.dirs || []) {
    if (!src || !src.dir || !fs.existsSync(src.dir)) continue
    for (const f of listFiles(src.dir)) {
      const rec = await zip.add({ name: `${src.prefix}/${f.rel}`, path: f.abs, hash: true })
      push({ path: rec.name, size: rec.size, sha256: rec.sha256 })
    }
  }

  const manifest = {
    version: 3,
    generatedAt: new Date().toISOString(),
    // 排序让两次备份的清单可 diff（文件遍历顺序依赖文件系统）
    files: records.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    fileCount: records.length,
    totalBytes: records.reduce((s, r) => s + r.size, 0),
    omitted: (plan.omitted || []).concat(RECONSTRUCTIBLE.map((n) => `${n}（派生数据，可由原图重建）`)),
  }
  await zip.add({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) })
  const stats = await zip.close()
  return { ...stats, files: manifest.fileCount, totalBytes: manifest.totalBytes }
}

module.exports = { writeBundle, listFiles, RECONSTRUCTIBLE }

// =========================================================================
// 以下为「还原」侧：解包 → 校验 → 换目录。
// 这里的原则：**先证明包里东西是齐的、名字是安全的，再动任何现有文件**。
// 中途失败宁可什么都不改，也不能出现「库换了一半、文件还是旧的」。
// =========================================================================

function isUnsafeName(raw) {
  // 合法备份不会出现这些：盘符、绝对路径、`.` / `..` 段。
  // 出现就整包拒绝，而不是静默改名 —— 改名会把文件放错地方，比失败更难查。
  const s = String(raw || '')
  if (!s) return true
  if (/^[a-zA-Z]:/.test(s)) return true
  if (s.startsWith('/') || s.startsWith('\\')) return true
  return s.split(/[\\/]/).some((seg) => seg === '..' || seg === '.')
}

/**
 * 把 zip 解到 destDir（逐条流式写，不整包进内存）。
 * 任何不安全条目名 → 整个包拒绝。
 *
 * 资源闸（N2-06）：恶意构造的备份包可以靠「高压缩比条目」在解压阶段撑爆磁盘，
 * 或塞几十万个小条目耗 CPU。这里限条目数与解压后的累计字节（按**实际写入**字节算，
 * 不信任 ZIP 头里声明的 uncompressedSize），超限即中断并让调用方拿到 400。
 * 上限在 ZIP64 后放宽：写侧 zipStream 已支持 >4GB 的包（照片多的账号很常见），
 * 读侧闸必须同步放宽，否则「写得出来、恢复不了」。防护靠的是「按实际写入字节算 +
 * 超限中断」这个机制，不是具体数字——数字只决定能扛多大的正常备份。
 */
const MAX_ENTRIES = 20000
const ZIP64_LIMITS = {
  maxEntryBytes: 64 * 1024 * 1024 * 1024,   // 单个条目 64GB（照片/视频不可能更大）
  maxTotalBytes: 512 * 1024 * 1024 * 1024,  // 解压总量 512GB（覆盖多年备份，仍挡压缩炸弹）
  uploadBytes: 512 * 1024 * 1024 * 1024,     // 上传包体上限（与解包总量对齐）
}
const { maxEntryBytes: MAX_ENTRY_BYTES, maxTotalBytes: MAX_TOTAL_BYTES } = ZIP64_LIMITS

function extractZip(zipPath, destDir) {
  const root = path.resolve(destDir)
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err)
      let entries = 0
      let totalBytes = 0
      let rejected = false
      const fail = (e) => { if (!rejected) { rejected = true; reject(e) } }
      zip.on('error', fail)
      zip.on('entry', (entry) => {
        if (rejected) return
        const rawName = entry.fileName
        // 目录条目：自己建目录即可，不依赖包里的空目录
        if (/\/$/.test(rawName)) { zip.readEntry(); return }
        entries += 1
        if (entries > MAX_ENTRIES) return fail(new Error(`备份包条目过多（上限 ${MAX_ENTRIES} 个）`))
        if (isUnsafeName(rawName)) {
          return fail(new Error(`备份包包含不安全的路径：${rawName}`))
        }
        const safe = sanitizeEntryName(rawName)
        const target = path.resolve(root, safe)
        if (target !== root && !target.startsWith(root + path.sep)) {
          return fail(new Error(`备份包条目越界：${rawName}`))
        }
        // entry 回调由 yauzl 在事件循环里调用，这里同步抛错不会进 Promise 的 reject，
        // 会变成 uncaughtException 直接崩掉后端（路径冲突：目标是已存在的文件/权限问题等）。
        // 必须就地 catch 转成 rejection，让调用方拿到 400 而不是整个进程挂掉。
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true })
          zip.openReadStream(entry, (e, rs) => {
            if (e) return fail(e)
            try {
              let entryBytes = 0
              const guard = new Transform({
                transform(chunk, _enc, cb) {
                  entryBytes += chunk.length
                  totalBytes += chunk.length
                  if (entryBytes > MAX_ENTRY_BYTES) return cb(new Error('备份包单个条目解压后过大'))
                  if (totalBytes > MAX_TOTAL_BYTES) return cb(new Error(`备份包解压后总大小超过上限（${MAX_TOTAL_BYTES} 字节）`))
                  cb(null, chunk)
                },
              })
              pipeline(rs, guard, fs.createWriteStream(target))
                .then(() => { zip.readEntry() })
                .catch(fail)
            } catch (err) { fail(err) }
          })
        } catch (err) {
          fail(err)
        }
      })
      zip.on('end', () => { if (!rejected) resolve({ entries }) })
      zip.readEntry()
    })
  })
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** 按 manifest 逐项核对「文件在不在、大小对不对、内容有没有变」 */
async function verifyManifest(destDir, manifest) {
  const problems = []
  const files = Array.isArray(manifest && manifest.files) ? manifest.files : []
  if (!files.length) problems.push('清单里没有任何文件项')
  const root = path.resolve(destDir)
  for (const rec of files) {
    const abs = path.resolve(destDir, rec.path)
    // 与 extractZip 同一根目录约束（K04-06）：被篡改的清单不能借 verify 去 stat/读哈希
    // 目录外的文件。落盘侧已挡穿越条目，这里补上清单侧的第二道闸。
    if (abs !== root && !abs.startsWith(root + path.sep)) { problems.push(`清单路径越界：${rec.path}`); continue }
    let st
    try { st = fs.statSync(abs) } catch (_) { problems.push(`缺少文件：${rec.path}`); continue }
    if (st.size !== rec.size) { problems.push(`大小不符：${rec.path}（清单 ${rec.size}，实际 ${st.size}）`); continue }
    if (rec.sha256) {
      const got = await sha256File(abs)
      if (got !== rec.sha256) problems.push(`内容校验失败：${rec.path}`)
    }
  }
  // 反向核对（N2-04）：解压目录里出现清单没登记的文件也要报。
  // 只放过包自身的两个元文件；其余「多出来的」一律视为被人为夹带。
  const allowed = new Set(files.map((r) => String(r.path).replace(/\\/g, '/')))
  allowed.add(META_ENTRY)
  allowed.add(MANIFEST_ENTRY)
  for (const it of listFiles(root)) {
    if (!allowed.has(it.rel)) problems.push(`包内存在未登记文件：${it.rel}`)
  }
  return problems
}

/**
 * 解包 + 校验。成功后 destDir 里就是可信的内容。
 * @returns {Promise<{meta:object, manifest:object, entries:number}>}
 */
async function extractAndVerify(zipPath, destDir) {
  const { entries } = await extractZip(zipPath, destDir)
  const readJson = (rel) => {
    const abs = path.join(destDir, rel)
    if (!fs.existsSync(abs)) throw new Error(`备份包缺少 ${rel}`)
    return JSON.parse(fs.readFileSync(abs, 'utf8'))
  }
  const meta = readJson(META_ENTRY)
  // v4：库钥匙包裹改用 scrypt（salt + 参数随包）；v3 的单次 SHA-256 包不再支持。
  if (meta.version !== 4) throw new Error(`不支持的备份包版本：${meta.version}`)
  const manifest = readJson(MANIFEST_ENTRY)
  const problems = await verifyManifest(destDir, manifest)
  if (problems.length) {
    throw new Error(`备份包校验未通过（${problems.length} 项）：${problems.slice(0, 5).join('；')}${problems.length > 5 ? ' …' : ''}`)
  }
  return { meta, manifest, entries }
}

/**
 * 用 srcDir 替换 destDir（同卷 rename，快且原子性最好）。
 * 旧目录不删除，改名成 `<destDir>.bak-<stamp>` —— 出问题时用户还能拿回来。
 * 但回滚壳只建不收会让反复恢复 N 次留 N 份完整旧目录（N2-10），
 * 所以每次替换后只保留最近两代 `.bak`（当前 + 上一代），更早的清掉。
 * @returns {string|null} 备份目录路径（没有旧目录时为 null）
 */
function pruneDirBackups(destDir) {
  try {
    const parent = path.dirname(destDir)
    const prefix = path.basename(destDir) + '.bak-'
    const olds = fs.readdirSync(parent).filter((n) => n.startsWith(prefix)).sort()
    const drop = olds.slice(0, Math.max(0, olds.length - 2))
    for (const n of drop) {
      try { fs.rmSync(path.join(parent, n), { recursive: true, force: true }) } catch (_) { /* best-effort: 占用中留给下次 */ }
    }
  } catch (_) { /* best-effort: 目录不可读时不阻断恢复 */ }
}

function replaceDir(srcDir, destDir, stamp) {
  let bak = null
  if (fs.existsSync(destDir)) {
    bak = `${destDir}.bak-${stamp}`
    fs.renameSync(destDir, bak)
  }
  fs.mkdirSync(path.dirname(destDir), { recursive: true })
  if (fs.existsSync(srcDir)) fs.renameSync(srcDir, destDir)
  else fs.mkdirSync(destDir, { recursive: true })
  if (bak) pruneDirBackups(destDir)
  return bak
}

/**
 * 把 srcDir 的文件合并进 destDir：同名覆盖，dest 里 src 没有的文件原样保留。
 * 用于恢复**全局共享目录**（uploads / album-trash / receipt-trash）：这些目录
 * 被所有班级共用，用 replaceDir 整体替换会让别的班引用的文件凭空消失（#11）。
 * 递归逐文件复制，不做删除；旧文件不改名成 .bak（合并是可叠加的，不需要回滚壳）。
 * @returns {number} 复制的文件数
 */
function mergeDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  let count = 0
  const walk = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name)
      const dest = path.join(to, entry.name)
      if (entry.isDirectory()) { walk(src, dest); continue }
      if (!entry.isFile()) continue
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      count += 1
    }
  }
  if (fs.existsSync(srcDir)) walk(srcDir, destDir)
  return count
}

module.exports = { writeBundle, listFiles, RECONSTRUCTIBLE, extractZip, extractAndVerify, verifyManifest, replaceDir, mergeDir, isUnsafeName, META_ENTRY, MANIFEST_ENTRY, ZIP64_LIMITS }
