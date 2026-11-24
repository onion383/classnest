// =========================================================================
// useDialogEscape.js —— 手写 Teleport 弹窗的 Esc 关闭（F02-05）
//
// DialogShell 系列已把 Esc 收口到 dialogStack：只有栈顶响应，内层下拉/确认框
// 处理过就放行。少数弹窗仍手写 `fixed inset-0` 遮罩、没接 DialogShell，于是
// 同一应用里出现两套关闭口径。迁移到 DialogShell 之前，先让它们接同一个栈，
// 保证「Esc 只关最上层」的语义不变。
//
// 用法：
//   useDialogEscape(() => props.visible, close)
// =========================================================================
import { watch, onBeforeUnmount } from 'vue'
import { pushDialog, removeDialog, isTopDialog } from '../utils/dialogStack.js'
import { useDisposables } from '../utils/disposables.js'

export function useDialogEscape(visible, onClose) {
  const self = {}
  watch(visible, (v) => {
    if (v) pushDialog(self)
    else removeDialog(self)
  }, { immediate: true })

  const d = useDisposables()
  d.listen(window, 'keydown', (e) => {
    if (!visible() || e.key !== 'Escape' || e.defaultPrevented) return
    if (!isTopDialog(self)) return
    e.preventDefault()
    onClose()
  })
  onBeforeUnmount(() => removeDialog(self))
}
