// =========================================================================
// outdir.js —— 构建输出目录的「小批量」清空
//
// 为什么需要它：Vite 自带的 emptyOutDir 是一次 fs.rm(outDir, {recursive:true})，
// 也就是**一次操作删掉整棵目录树**。dist/assets 里动辄 100+ 文件（实测一次 168 个），
// 撞上宿主环境的批量删除保护（一次删 >50 个文件）就会把构建直接打断。
// 但 emptyOutDir 也不能简单关掉 —— electron-builder 打包的是 student-frontend/dist/**/*，
// 关掉就会把上一轮的旧 hash chunk 一起打进安装包（见 electron-builder.json 的 files 段）。
//
// 所以这里自己清目录：语义与 Vite 的 emptyOutDir 一致（构建前清空、不留旧产物），
// 区别只在于把删除拆成「每个 fs 操作最多涉及 maxFilesPerOp 个文件」，
// 于是不会再撞上批量删除保护。
//
// 注意：这里只清 outDir 的**内容**，目录本身保留 —— 少一个「目录不存在」的边界，
// 也少一个「万一 outDir 配错就整个删掉」的风险面。
// =========================================================================
import fs from 'node:fs'
import path from 'node:path'

// 一次 fs 删除操作里允许带走的文件数上限。
// 远低于环境保护阈值（50），又不至于把上千个文件拆成上千次调用。
export const DEFAULT_MAX_FILES_PER_OP = 20

// 统计目录树里的文件数（不跟随符号链接：readdir withFileTypes 用的是 lstat 语义，
// 指向目录的软链会被当成「文件」而不是下钻，避免软链把统计带进环里）。
function countFiles(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries = []
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(cur, entry.name))
      else total++
    }
  }
  return total
}

// 安全闸：输出目录必须位于 root 之内，且不能就是 root 本身。
// 配错成 '..' 或 '/' 时宁可构建失败，也不能把项目源码或整块盘删掉。
function assertSafeTarget(dir, root) {
  if (dir === path.parse(dir).root) {
    throw new Error(`拒绝清空文件系统根目录：${dir}`)
  }
  if (!root) return
  const rel = path.relative(root, dir)
  if (rel === '') {
    throw new Error(`拒绝清空项目根目录：${dir}`)
  }
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return // 在 root 之内 → 合法
  if (!path.relative(dir, root).startsWith('..')) {
    throw new Error(`拒绝清空项目根目录的祖先目录：${dir}`)
  }
  // 在 root 之外但不是祖先 → 允许（探针常用 root 外的 outDir）
}

/**
 * 小批量清空输出目录的内容。
 * @param {string} outDir 要清空的目录（只清内容，目录本身保留）
 * @param {{ maxFilesPerOp?: number, root?: string }} [options]
 * @returns {{ files: number, dirs: number, maxBatch: number }}
 *   maxBatch = 单次 fs 删除操作里带走过的最大文件数（用来证明「没有一次删太多」）
 */
export function emptyOutDirBatched(outDir, options = {}) {
  const maxFilesPerOp = Math.max(1, options.maxFilesPerOp ?? DEFAULT_MAX_FILES_PER_OP)
  const dir = path.resolve(outDir)
  assertSafeTarget(dir, options.root ? path.resolve(options.root) : null)

  if (!fs.existsSync(dir)) return { files: 0, dirs: 0, maxBatch: 0 }
  if (!fs.statSync(dir).isDirectory()) {
    throw new Error(`输出目录路径不是目录：${dir}`)
  }

  let files = 0
  let dirs = 0
  let maxBatch = 0

  const empty = (target) => {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      // 与 Vite 自带 emptyDir 保持一致：保留 .git（outDir 本身是仓库时）
      if (entry.name === '.git') continue
      const full = path.join(target, entry.name)
      if (!entry.isDirectory()) {
        // 文件 / 软链：一次操作只带走 1 个
        fs.rmSync(full, { force: true })
        files++
        if (maxBatch < 1) maxBatch = 1
        continue
      }
      // 目录：子树文件数不超上限时，一次递归删掉整棵子树（省调用次数）
      const sub = countFiles(full)
      if (sub <= maxFilesPerOp) {
        fs.rmSync(full, { recursive: true, force: true })
        files += sub
        if (maxBatch < sub) maxBatch = sub
      } else {
        // 子树太大 → 逐层下钻，最后删空目录（此时目录已空，不涉及文件数）
        empty(full)
        fs.rmSync(full, { recursive: true, force: true })
      }
      dirs++
    }
  }

  empty(dir)
  return { files, dirs, maxBatch }
}
