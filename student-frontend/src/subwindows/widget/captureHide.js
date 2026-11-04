// =========================================================================
// captureHide.js —— 截屏前「把自己藏起来」的唯一实现（工具箱浮窗专用）
//
// 为什么不能用主进程的 hideWidget（setOpacity(0)）：
//   工具箱浮窗是 `transparent: true` 的（见 electron/main/main.widget.js 的
//   createWidgetWindow）。Windows 上 **setOpacity 对 transparent 窗口不生效**，
//   主进程「setOpacity(0) + 盲等 150ms」这条路等于什么都没做 ——
//   截出来的图里照样有浮窗自己（便签窗口那张「加载中」卡片就曾经被拍进注释背景）。
//
// 为什么 CSS visibility 就够：
//   窗口本身是 transparent 的，内容一隐藏，它在合成器里就等于不存在。
//   等两帧 + 一个宏任务，确保合成器已提交、DWM 已更新，之后抓屏即可。
//
// 为什么必须调用方自己藏、并把 hideWidget 传 false：
//   隐藏必须是「发出 IPC 之前」完成的同步动作，主进程没法替渲染进程做；
//   传 false 还能省掉主进程那段必然无效的 150ms 等待。
// =========================================================================

/**
 * 隐藏整窗内容，并等到「真的不在屏幕上了」再返回。
 * @returns {Promise<void>}
 */
export function hideForCapture() {
  document.documentElement.style.visibility = 'hidden'
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))
  })
}

/** 恢复整窗内容（放在 finally 里，截屏失败也必须恢复，否则窗口就"消失"了） */
export function restoreAfterCapture() {
  document.documentElement.style.visibility = ''
}
