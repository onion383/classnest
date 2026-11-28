// =========================================================================
// aiMemoryGuard.js —— AI 记忆「读取失败不能拿空内容覆盖」的守卫
//
// 背景：数据管理弹窗的 AI 记忆走「读取 → 编辑框 → 保存」三步。读取失败时若把
// 内容置空且不报错，用户看到空白编辑框，一保存就把已有记忆整体清空。这与同弹窗
// 的聊天记录/技能文件读取失败要 notifyError 的口径不一致。
//
// 守卫只做一件事：记忆读取失败态下，任何保存都必须拦住。技能文件（target !== 'memory'）
// 不受影响——它们各自在打开编辑框时单独读取，失败当场报错，不共享这份状态。
//
// 纯函数、无副作用，便于单测真跑 + loadMutated 变异反证。
// =========================================================================

/**
 * 记忆保存守卫。
 * @param {{ target: string, loadFailed: boolean, content?: string }} ctx
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function memorySaveGuard({ target, loadFailed, content } = {}) {
  if (target !== 'memory') return { allowed: true }
  if (loadFailed) {
    return { allowed: false, reason: '记忆加载失败，不能保存以免覆盖已有内容' }
  }
  // content 参数保留给调用方做二次确认（例如内容为空且记忆原本非空），
  // 守卫本身只判失败态——空记忆本身是合法的（用户可能主动清空）。
  void content
  return { allowed: true }
}
