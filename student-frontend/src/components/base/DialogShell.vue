<template>
  <!--
    弹窗公共外壳：Teleport + 遮罩 + 过渡动画
    各业务弹窗只负责面板内容（放在默认插槽里），遮罩点击是否关闭由使用方决定。
    外壳渲染的 DOM 与各弹窗原来手写的一致（同样的 overlay class），故视觉零变化。
  -->
  <Teleport to="body">
    <Transition name="dialog">
      <div
        v-if="visible"
        ref="overlayEl"
        class="fixed inset-0 flex items-center justify-center"
        :class="overlayClass"
        :style="{ zIndex }"
        role="dialog"
        aria-modal="true"
        :aria-label="label || undefined"
        tabindex="-1"
        @click.self="$emit('overlay')"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<script setup vapor>
import '../../styles/dialog-transition.css'
import { onBeforeUnmount, watch, nextTick, ref } from 'vue'
import { useDisposables } from '../../utils/disposables.js'
import { pushDialog, removeDialog, isTopDialog } from '../../utils/dialogStack.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  // 与各弹窗原来的 z-[xxxx] 保持一致，默认沿用确认框的层级
  zIndex: { type: Number, default: 10006 },
  // 遮罩附加 class：默认沿用确认框样式；个别弹窗需要不同遮罩浓度/对齐方式时整体覆盖
  overlayClass: { type: String, default: 'bg-black/50 pointer-events-auto' },
  // 弹窗可访问名：不传则由面板内的标题等元素自行承担（读屏按序朗读）
  label: { type: String, default: '' },
})

const emit = defineEmits(['overlay'])

// Esc 关闭：与「点遮罩」同义，走各弹窗既有的遮罩语义 ——
// 有的弹窗按设计不关、只提示「请先处理」，共用一条路径才不会出现两套语义。
//
// 为什么要维护一个栈：设置类弹窗里还会再开确认框（两层 DialogShell 同时可见），
// 不做层次判断的话一次 Esc 会把两层一起关掉。只有最上层响应。
// 栈必须**跨实例共享**，所以放在 utils/dialogStack.js 的模块作用域，
// 不能写在 setup 里（每个实例一份，等于没有层级判断 —— 审查 v5 · V5-003）。
const self = {}
const overlayEl = ref(null)
// 打开前的焦点位置：关闭时还回去（键盘/读屏用户不能每次关完弹窗就掉到 body）
let lastFocus = null

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

function focusables(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE))
    .filter((el) => el.getClientRects().length > 0)
}

watch(
  () => props.visible,
  (v) => {
    if (!v) {
      removeDialog(self)
      if (lastFocus && typeof lastFocus.focus === 'function') {
        try { lastFocus.focus() } catch (_) { /* 触发点已被移除 */ }
      }
      lastFocus = null
      return
    }
    lastFocus = document.activeElement
    pushDialog(self)
    // 打开后把焦点移进弹窗：优先第一个可聚焦控件，没有就聚焦容器本身（N5-11）
    nextTick(() => {
      const root = overlayEl.value
      if (!root) return
      const first = focusables(root)[0]
      if (first) first.focus()
      else root.focus()
    })
  },
  { immediate: true },
)

// Tab 焦点陷阱：只在最上层弹窗里循环，不能 Tab 到被遮住的页面背后（N5-11）
function trapTab(e) {
  const root = overlayEl.value
  if (!root) return
  const list = focusables(root)
  if (!list.length) { e.preventDefault(); return }
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  // 焦点不在本层（上层灯箱/另一个 Shell）时不要抢焦点，否则 Tab 会把用户从上层拽回来
  if (!root.contains(active)) return
  if (e.shiftKey) {
    if (active === first) { e.preventDefault(); last.focus() }
  } else if (active === last) {
    e.preventDefault(); first.focus()
  }
}

function onKeydown(e) {
  if (!props.visible) return
  if (e.key === 'Tab') {
    if (isTopDialog(self)) trapTab(e)
    return
  }
  if (e.key !== 'Escape') return
  if (!isTopDialog(self)) return
  // 内层自己处理过 Esc（下拉展开、过滤框）就别再关弹窗
  if (e.defaultPrevented) return
  e.preventDefault()
  emit('overlay')
}

// 键盘监听走 disposables：配对卸载自动移除，不再手写 onMounted / onBeforeUnmount 两张清单。
const d = useDisposables()
d.listen(window, 'keydown', onKeydown)
onBeforeUnmount(() => removeDialog(self))
</script>
