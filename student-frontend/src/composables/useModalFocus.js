// useModalFocus.js —— 手写全屏查看器（未套 DialogShell）的焦点管理（N5-11）
//
// 为什么单独存在：全屏灯箱的根节点自带 album-viewer 布局（flex 列 + 绝对定位控件），
// 套 DialogShell 会叠加居中/列布局类，视觉风险高，所以保留手写遮罩，
// 但焦点三件事必须与 DialogShell 一致：打开移入、Tab 圈定、关闭还原。
//
// 用法：
//   const rootEl = ref(null)
//   useModalFocus(() => !!viewer, rootEl, closeViewer)
//
// onEscape 可选；不传则 Esc 由调用方自己的 keydown 处理（如 MediaViewer）。
import { watch, nextTick } from 'vue'
import { useDisposables } from '../utils/disposables.js'

export const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

// Tab 圈定：在 root 内循环，只在最上层使用
export function trapTab(e, root) {
  if (!root) return
  const list = Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => el.getClientRects().length > 0)
  if (!list.length) { e.preventDefault(); return }
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  if (e.shiftKey) {
    if (active === first || !root.contains(active)) { e.preventDefault(); last.focus() }
  } else if (active === last || !root.contains(active)) {
    e.preventDefault(); first.focus()
  }
}

export function useModalFocus(isOpen, rootRef, onEscape) {
  let lastFocus = null

  function restore() {
    const el = lastFocus
    lastFocus = null
    if (el && typeof el.focus === 'function') {
      try { el.focus() } catch (_) { /* best-effort: 触发点已被移除 */ }
    }
  }

  watch(isOpen, (open) => {
    if (!open) {
      restore()
      return
    }
    lastFocus = document.activeElement
    nextTick(() => {
      const root = rootRef.value
      if (!root) return
      const first = root.querySelector(FOCUSABLE)
      if (first) first.focus()
      else root.focus()
    })
  }, { immediate: true })

  function onKeydown(e) {
    if (!isOpen()) return
    const root = rootRef.value
    if (!root) return
    if (e.key === 'Escape' && onEscape) {
      if (e.defaultPrevented) return
      e.preventDefault()
      onEscape()
      return
    }
    if (e.key !== 'Tab') return
    trapTab(e, root)
  }

  const d = useDisposables()
  d.listen(window, 'keydown', onKeydown)
  d.add(restore)
}
