// =========================================================================
// saveResult.js —— 主进程 save-file 返回值的三态判定（纯函数，零依赖）
//
// 为什么单独抽出来：判定逻辑原先只写在 utils/saveFile.js 里，但 AiChart.vue、
// RecoveryKeyDialog.vue 又各自手写一份「只判 canceled」的副本 —— 主进程写盘失败
// 会被当成「用户取消」或「保存成功」，用户被告知已保存、实际没有文件（审查 v5 · V5-002）。
// 抽成纯函数后所有消费点共用同一口径，也便于正反用例直接测。
//
// 兼容两种形状：
//   1) 新契约：{ outcome: 'ok'|'fail'|'canceled', success, canceled, error }
//   2) 旧形状：{ canceled: true }（取消）/ { success: false, error }（失败）
// =========================================================================

export function classifySaveResult(res) {
  if (!res || typeof res !== 'object') return 'fail'
  if (res.outcome === 'ok') return 'ok'
  if (res.outcome === 'fail') return 'fail'
  if (res.outcome === 'canceled') return 'canceled'
  // 旧形状兜底
  if (res.canceled === true) return 'canceled'
  if (res.success === false) return 'fail'
  if (res.filePath) return 'ok'
  return 'fail'
}
