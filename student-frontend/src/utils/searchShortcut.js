// =========================================================================
// searchShortcut.js —— 全局搜索快捷键（Ctrl/Cmd + K）的纯判定
//
// 只做「这个键盘事件是否该触发全局搜索」的判定，副作用（打开弹窗、preventDefault）
// 留给调用方 App.vue。拆成纯函数是为了让判据能真正变异反证，而不是只测接线字符串。
// =========================================================================

/**
 * 是否命中全局搜索快捷键：Ctrl+K（Win/Linux）或 Cmd+K（macOS）。
 * 不加 Shift/Alt —— 那两类组合键在浏览器/Electron 里有别的语义，不应抢。
 * @param {KeyboardEvent|{key:string,ctrlKey?:boolean,metaKey?:boolean,shiftKey?:boolean,altKey?:boolean}} e
 * @returns {boolean}
 */
export function isGlobalSearchShortcut(e) {
  if (!e || e.shiftKey || e.altKey) return false
  if (!e.ctrlKey && !e.metaKey) return false
  return String(e.key || '').toLowerCase() === 'k'
}
