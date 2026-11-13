// =========================================================================
// services/thumbSweep.js —— 回收「没有索引引用」的缩略图（孤儿文件）
//
// 与 thumbPurge.js 的区别：purge 是**全删**（用来强制重建缓存），
// sweep 是**按库对账后只删没人引用的**，正在使用的图一张不动。
//
// 为什么需要它：album_photos.id 是 AUTOINCREMENT，删掉的照片 id 永不重用，
// 所以它的 jpg 永远不会被新照片覆盖。正常删除路径会顺手删图，但下面几种会漏：
//   · 删账号：deleteTeacher 只删 .db / registry，不删 {THUMB_DIR}/{slug}/
//   · Windows 上文件被占用，各删除点的 unlink().catch(() => {}) 静默失败
//   · 进程被强杀 / 断电，genThumb 的 {id}.{ts}.jpg 临时文件没人收
//   · 早期版本的扁平结构 {THUMB_DIR}/{id}.jpg
//
// 判据（保守优先，宁可留着不猜）：
//   · 库能打开 → 只删「id 不在 album_photos.id 集合里」的 {id}.jpg
//   · 账号与库文件都不存在 → 整个 slug 目录判为孤儿
//   · 库打不开（超级隐私未解锁 / 库损坏）→ **整个目录跳过**，绝不把「读不到」当成「没有」
//   · 库文件还在但登记丢了 → 跳过（可能是数据迁移，不敢判无主）
//   · 临时文件 {id}.{ts}.jpg 只有超过 TEMP_MIN_AGE_MS 才删，避免误删正在生成的
//   · 非 .jpg 一律不动：这个目录里可能有用户放的东西，不替他做主
//
// 默认 apply=false（只读对账）。真正删除必须由调用方显式传 apply=true。
// =========================================================================

const fsp = require('node:fs/promises')
const path = require('node:path')

const UNLINK_BATCH = 32
// genThumb 是「写临时文件 → rename」，正常路径几百毫秒内就结束。
// 10 分钟还留着的只可能是崩溃残骸；留足余量是为了不和正在生成的任务抢文件。
const TEMP_MIN_AGE_MS = 10 * 60 * 1000

const NUM_JPG = /^(\d+)\.jpg$/
const TEMP_JPG = /^\d+\..+\.jpg$/

/**
 * @param {string} rootDir THUMB_DIR
 * @param {object} opts
 * @param {(slug:string)=>Promise<Set<number>|null|undefined>} opts.getLiveIds
 *        Set   = 该库当前有效的 photoId；null = 账号与库都没了；undefined = 无法对账（跳过）
 * @param {boolean} opts.apply true 才真的删
 * @param {number} opts.now 可注入的当前时间（单测用）
 * @returns {Promise<{scanned:number,orphans:number,bytes:number,deleted:number,freed:number,
 *   failed:number,legacyRoot:number,skipped:Array<{slug:string,reason:string}>,
 *   slugs:Array<{slug:string,files:number,orphans:number,reason:string}>}>}
 */
async function sweepThumbOrphans(rootDir, { getLiveIds, apply = false, now = Date.now() } = {}) {
  const out = {
    scanned: 0,      // 扫到的 .jpg 总数
    orphans: 0,      // 判定为孤儿的数量
    bytes: 0,        // 孤儿占的字节（dryRun 也能给用户看数字）
    deleted: 0,
    freed: 0,
    failed: 0,       // 被占用 / 无权限，留给下次回收
    legacyRoot: 0,   // 根目录扁平结构遗留
    skipped: [],     // 不敢对账、一个文件都没动的 slug
    slugs: [],
  }
  if (!rootDir || typeof getLiveIds !== 'function') return out

  let entries = []
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true })
  } catch (_) {
    return out // 目录不存在 / 无权限
  }

  const targets = []
  const add = (p, size) => targets.push({ p, size })

  for (const e of entries) {
    if (e.isFile()) {
      if (!e.name.endsWith('.jpg')) continue
      // 现在所有缩略图都在 {slug}/ 下；根目录的散 jpg 只可能是早期扁平结构残留
      const p = path.join(rootDir, e.name)
      let size = 0
      try { size = (await fsp.stat(p)).size } catch (_) { continue }
      out.scanned++
      out.legacyRoot++
      out.orphans++
      out.bytes += size
      add(p, size)
      continue
    }
    if (!e.isDirectory()) continue // 符号链接等：Dirent 对链接都返回 false，天然跳过

    const slug = e.name
    const dir = path.join(rootDir, slug)
    const stat = { slug, files: 0, orphans: 0, reason: '' }
    let names = []
    try {
      names = await fsp.readdir(dir, { withFileTypes: true })
    } catch (_) {
      out.skipped.push({ slug, reason: '目录不可读' })
      continue
    }

    let live
    try {
      live = await getLiveIds(slug)
    } catch (err) {
      out.skipped.push({ slug, reason: (err && err.message) || '库打不开' })
      continue
    }
    if (live === undefined) {
      // 「读不到」≠「没有」。隐私库未解锁时若按空集处理，会把整个账号的图全删掉。
      out.skipped.push({ slug, reason: '库未解锁，未对账' })
      continue
    }
    const orphanDir = live === null // 账号与库文件都不在了

    for (const f of names) {
      if (!f.isFile() || !f.name.endsWith('.jpg')) continue
      const p = path.join(dir, f.name)
      let st
      try { st = await fsp.stat(p) } catch (_) { continue }
      out.scanned++
      stat.files++

      const m = NUM_JPG.exec(f.name)
      let isOrphan = false
      if (orphanDir) {
        isOrphan = true
      } else if (m) {
        isOrphan = !live.has(Number(m[1]))
      } else if (TEMP_JPG.test(f.name)) {
        isOrphan = (now - st.mtimeMs) >= TEMP_MIN_AGE_MS
      }
      // 其它名字的 .jpg：不认识，不动
      if (!isOrphan) continue
      out.orphans++
      out.bytes += st.size
      stat.orphans++
      add(p, st.size)
    }
    if (orphanDir) stat.reason = '账号已删除'
    out.slugs.push(stat)
  }

  if (!apply) return out

  for (let i = 0; i < targets.length; i += UNLINK_BATCH) {
    const batch = targets.slice(i, i + UNLINK_BATCH)
    const rs = await Promise.all(batch.map(async ({ p, size }) => {
      try {
        await fsp.unlink(p)
        return size
      } catch (_) {
        return null
      }
    }))
    for (const r of rs) {
      if (r === null) out.failed++
      else { out.deleted++; out.freed += r }
    }
  }
  return out
}

module.exports = { sweepThumbOrphans, UNLINK_BATCH, TEMP_MIN_AGE_MS, NUM_JPG, TEMP_JPG }
