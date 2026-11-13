// =========================================================================
// services/thumbPurge.js —— 清理缩略图缓存文件（**只删图，不动索引**）
//
// 目录结构（见 albumThumbs.js）：
//   {THUMB_DIR}/{slug}/{photoId}.jpg    ← 现在：按库隔离，一个账号一个子目录
//   {THUMB_DIR}/{photoId}.jpg           ← 早期版本：扁平结构，兼容残留
//
// 为什么不做成「删整个目录再重建」：一是要如实回报「释放了多少字节」给用户对账，
// 二是 Windows 上被占用的文件删不掉（相册正开着、缩略图正在被读），必须逐文件容错，
// 一个失败不能中断整批，也不能瞒着用户报成功。
//
// 与索引的关系（这是本功能的关键点）：调用方**不许**动数据库。
//   · album_photos 的行一行不删 —— 那是照片索引，重建它要重扫整个文件夹
//   · thumb_path / thumb_v 也不清 —— 留着没有副作用，/thumb 接口读不到文件时会现场重建
//     （routes/album.js 的 sendThumb：readThumb 返回 null → genThumb → 写回库）
// 所以这里只需要「删文件」，剩下的恢复完全走已有的兜底路径。
// =========================================================================

const fsp = require('node:fs/promises')
const path = require('node:path')

// 删除并发度：实测 5000 个文件（本机 SSD，200B/个）
//   串行 6375ms / 并发 16 → 2453ms / 32 → 2390ms / 64 → 2418ms
// 16 以上就被磁盘与 libuv 线程池吃满了，取 32 留一点余量给同进程的 HTTP 请求。
const UNLINK_BATCH = 32

// 收集待删文件：根目录下的散文件（旧扁平结构）+ 每个 slug 子目录里的一层文件。
// 不递归更深：目录层级是我们自己定的，多一层就说明放的不是缩略图（别替用户删别的东西）。
// 符号链接天然跳过 —— Dirent 的 isFile()/isDirectory() 对链接都返回 false。
async function collectTargets(rootDir) {
  const targets = []
  let entries = []
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true })
  } catch (_) {
    return targets // 目录不存在 / 无权限：当作没有可清理的东西
  }
  for (const e of entries) {
    if (e.isFile()) {
      targets.push(path.join(rootDir, e.name))
      continue
    }
    if (!e.isDirectory()) continue
    const dir = path.join(rootDir, e.name)
    let inner = []
    try {
      inner = await fsp.readdir(dir, { withFileTypes: true })
    } catch (_) {
      continue // 单个账号目录读不到，跳过它，不影响其他账号
    }
    for (const f of inner) {
      if (f.isFile()) targets.push(path.join(dir, f.name))
    }
  }
  return targets
}

/**
 * 删除 rootDir 下的全部缩略图文件，返回 { files, bytes, failed }。
 * files/bytes 只统计**真的删掉**的那些；删不掉的计入 failed（被占用/无权限）。
 * 目录本身保留（不删 slug 子目录），下次生成时不用再 mkdir。
 */
async function purgeThumbFiles(rootDir) {
  const out = { files: 0, bytes: 0, failed: 0 }
  if (!rootDir) return out
  const targets = await collectTargets(rootDir)
  // 分批并发：删文件是纯 IO 等待，串行会让一万张的相册卡十几秒。
  // 单批内部的失败互不影响（每个文件各自 try），整批不会因为一个 EBUSY 中断。
  for (let i = 0; i < targets.length; i += UNLINK_BATCH) {
    const batch = targets.slice(i, i + UNLINK_BATCH)
    const results = await Promise.all(batch.map(async (p) => {
      let size = 0
      try {
        size = (await fsp.stat(p)).size
      } catch (_) {
        size = 0 // stat 失败仍然尝试删（可能是刚被删掉的残影）
      }
      try {
        await fsp.unlink(p)
        return { ok: true, size }
      } catch (_) {
        return { ok: false, size: 0 }
      }
    }))
    for (const r of results) {
      if (r.ok) {
        out.files += 1
        out.bytes += r.size
      } else {
        out.failed += 1
      }
    }
  }
  return out
}

module.exports = { purgeThumbFiles, collectTargets }
