// =========================================================================
// _tmpdir.cjs —— 临时数据目录的删除助手（冒烟脚本共用）
//
// 为什么要单独抽出来：
//   Windows 上 SQLite 连接刚关闭时文件句柄可能还被占用，单次 rmSync 立刻抛 EBUSY/EPERM。
//   各脚本原先都写成 `try { fs.rmSync(dir, ...) } catch (_) {}` —— 清理失败被静默吞掉，
//   于是系统 temp 里越堆越多。实测（2026-11-04，本机）：
//     banji-api-routes-*  49 个
//     cadre-undo-*        13 个
//     undo-batch-*        11 个
//     banji-photo-info-*   9 个
//     banji-file-etag-*    7 个
//     banji-viewer-load-*  6 个
//   全是「跑一次漏一个」，因为失败没有任何输出，谁都不知道。
//
// 正确做法：先 evict/close 库连接，再**重试删除**；重试仍失败就打印目录路径，
// 让失败可见。下划线前缀是刻意的：run-smoke.cjs 会跳过 `_` 开头的文件，不会被当测试跑。
// =========================================================================
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// 临时目录根。由运行器（run-smoke.cjs）通过 SMOKE_TMP_ROOT 注入一个「本次运行专属」的根目录，
// 运行结束由**父进程**整体删除 —— 因为子进程删不掉自己的数据目录：index.db 的连接在进程内
// 一直开着，Windows 上 rmSync 必然 EBUSY，重试也没用（实测 8×150ms 仍然失败）。
// 单独手工跑某个脚本时没有这个环境变量，退回系统 temp（那种情况漏 1 个，可接受）。
function tempRoot() {
  return process.env.SMOKE_TMP_ROOT || os.tmpdir()
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(tempRoot(), prefix))
}

async function removeDirWithRetry(dir, { tries = 8, waitMs = 150 } = {}) {
  if (!dir) return true
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return true
    } catch (_) {
      // 句柄释放有延迟：等一会儿再试，别第一次失败就放弃
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
  console.error(`[tmpdir] 清理失败（句柄仍被占用），已留在：${dir}`)
  return false
}

module.exports = { removeDirWithRetry, tempRoot, makeTempDir }
