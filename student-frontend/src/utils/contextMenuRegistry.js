// ==================== 右键菜单互斥 ====================
// 同一时刻只允许一个右键菜单存在。座位页的行标签菜单和列头菜单是**两个组件实例**，
// 彼此看不见对方的 visible；把「当前是谁」放在模块级，新菜单登记时让上一个自己
// emit('close')（受控组件不直接改 props，仍由调用方把 visible 置 false）。
// 四个使用点因此自动互斥，以后新增菜单源也不用逐个改调用方。
//
// 各 Electron 窗口 / 子窗口有独立的 JS 模块实例，不会跨窗口误关。
let current = null

/**
 * 登记一个刚打开的菜单；若已有**别的**菜单打开，先调用它的 close 回调。
 * @param {symbol} token 本组件实例的唯一标识
 * @param {Function} close 让当前组件自行关闭的回调
 * @returns {Function} release —— 本实例关闭/卸载时调用，只在自己仍是当前菜单时清空
 */
export function claimContextMenu(token, close) {
  const previous = current
  current = { token, close }
  // 同一个实例在别处重新定位（visible 已经是 true）不算「两个菜单」，不关自己
  if (previous && previous.token !== token) previous.close()
  // 只在自己仍是当前菜单时清空：新菜单可能已经顶上来，不能把它一起清掉
  return () => {
    if (current && current.token === token) current = null
  }
}

// 单测隔离用：清空登记表（生产不调用）
export function resetContextMenuRegistry() {
  current = null
}
