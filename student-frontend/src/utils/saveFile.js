// 保存文件的唯一出口：文件名清洗 → 系统保存对话框 → 成功后用系统默认应用打开。
// 供数据管理导出（exportFormats）、课表/座位导出（ExportExcel）、AI 导出（aiFiles）共用——
// 此前这三处各写了一份同样的 SAVE_FILE→OPEN_FILE 样板，改一处漏一处（PDF 导出就曾漏掉清洗）。
//
// 返回值语义（审查 v4 · B01-06 修）：
//   返回文件路径字符串 = 成功；
//   返回空串 = **用户取消**（正常，不该弹错误提示）；
//   **抛异常** = 保存失败（调用方的 try/catch 接住 → 弹错误提示）。
//
// 原先的 bug：主进程写盘失败时返回 { canceled: true, error }，而这里只判断 !result.canceled，
// 于是「写盘失败」和「用户取消」都落到 return '' —— 调用方无法区分，
// 界面一声不吭，用户以为「我取消了」，实际是「文件根本没写出来」。
//
// 现在主进程区分了三种结局（见 electron/main/main.ipc-contract.js）：
//   outcome = 'ok' | 'fail' | 'canceled'。
// 本模块据此把「失败」**抛出去**，把「取消」**安静吞掉** —— 这样语义才和用户的心智模型对上：
//   用户点了取消 → 不打扰；保存失败了 → 必须告诉他。
import { INVOKE } from '../electronChannels.js'
import { sanitizeFileName } from './fileName.js'
import { classifySaveResult } from './saveResult.js'

// 判定逻辑抽在 saveResult.js（纯函数）：AiChart / RecoveryKeyDialog 等直连
// save-file 的消费点也复用同一口径，避免各写一份「只判 canceled」的副本。
const classify = classifySaveResult

export async function saveBlobWithDialog(defaultName, blob) {
  // 文件名来自用户输入 / AI 生成，落盘前统一清洗（非法字符 / 末尾点空格 / 超长）
  const safeName = sanitizeFileName(defaultName)
  const arrayBuffer = await blob.arrayBuffer()
  const result = await window.electron.invoke(INVOKE.SAVE_FILE, { defaultName: safeName, data: arrayBuffer })
  const kind = classify(result)
  if (kind === 'ok') {
    // 新契约的 outcome='ok' 必须真的带回 filePath：否则「保存成功」是一句空话，
    // 后续打开文件/提示都会落在不存在的路径上（审查 v5 · V5-043）。
    if (!result.filePath) throw new Error((result && result.error) || '保存文件失败（未返回文件路径）')
    // 保存成功后用系统默认应用打开文件
    window.electron.invoke(INVOKE.OPEN_FILE, { filePath: result.filePath }).catch(() => {})
    return result.filePath
  }
  if (kind === 'canceled') return ''
  // 失败：把原因抛出去，让调用方的 catch 弹错误提示（原先被静默吞成「取消」）
  throw new Error((result && result.error) || '保存文件失败')
}
