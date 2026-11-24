// 更改审查四个入口（回退 / 撤销一步 / 只撤一条 / 重做）的结果文案。
// 抽成纯函数是为了能直接跑行为断言：文案分支不再依赖源码文本切片判断。
// 口径：有 label 时带上操作对象，否则用通用文案；失败优先用后端给出的原因。

export function rewindNotice(data) {
  const tail = data.batch > 1 ? `（连带回退 ${data.batch} 项）` : ''
  return (data.label ? `已回退：${data.label}` : '已成功回退') + tail
}

export function replayNotice(data) {
  const tail = data.batch > 1 ? `（连带重做 ${data.batch} 项）` : ''
  return (data.label ? `已重做：${data.label}` : '已成功重做') + tail
}

export function undoStepNotice(data) {
  return data.label ? `已撤销：${data.label}` : '已撤销这一步'
}

export function undoMemberNotice(data) {
  return data.label ? `已撤销：${data.label}` : '已撤销这一条'
}

// 后端错误体里的原因优先，缺失时才用本地兜底文案。
export function apiErrorNotice(err, fallback) {
  return err?.response?.data?.error || fallback
}
