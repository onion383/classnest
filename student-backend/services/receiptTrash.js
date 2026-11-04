// =========================================================================
// receiptTrash.js —— 收据文件移进回收站
//
// 收据从「只收图片」扩到 pdf/office/视频后，删除如果只改数据库数组，
// uploads 会悄悄涨到几个 G（而用户以为已经删了）。
//
// 安全边界：这个函数只接受「/uploads/xxx」这类路径，一律取 basename 再拼回
// uploads 根目录。任何 ../ 或绝对路径都会被压平成目录内的文件名，穿越不出去 ——
// 否则它就是「把机器上任意文件挪走」的入口。
// =========================================================================
const fs = require('fs')
const path = require('path')

/**
 * @param {string[]} list 形如 ['/uploads/1728-123.jpg'] 的路径
 * @param {string} uploadsDir uploads 根目录
 * @param {string} trashDir 回收站目录
 * @returns {number} 实际移动的文件数
 */
function moveReceiptsToTrash(list, uploadsDir, trashDir) {
  const root = path.resolve(uploadsDir)
  fs.mkdirSync(trashDir, { recursive: true })
  let moved = 0
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue;
    // 取 basename 是关键：'../../secret.txt' → 'secret.txt'，再怎么拼都出不了 root
    const name = path.basename(item)
    if (!name || name === '.' || name === '..') continue
    const abs = path.join(root, name)
    if (!abs.startsWith(root + path.sep)) continue
    try {
      if (!fs.existsSync(abs)) continue
      const stamp = Date.now() + '-' + Math.round(Math.random() * 1e6)
      fs.renameSync(abs, path.join(trashDir, `${stamp}-${name}`))
      moved += 1
    } catch (_) {
      // 单个文件移动失败（被占用等）不影响其它文件，也不该让保存失败
    }
  }
  return moved
}

module.exports = { moveReceiptsToTrash }
