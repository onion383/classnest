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
        class="fixed inset-0 flex items-center justify-center"
        :class="overlayClass"
        :style="{ zIndex }"
        @click.self="$emit('overlay')"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<script setup vapor>
import '../../styles/dialog-transition.css'
import { onBeforeUnmount, onMounted, watch } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  // 与各弹窗原来的 z-[xxxx] 保持一致，默认沿用确认框的层级
  zIndex: { type: Number, default: 10006 },
  // 遮罩附加 class：默认沿用确认框样式；个别弹窗需要不同遮罩浓度/对齐方式时整体覆盖
  overlayClass: { type: String, default: 'bg-black/50 pointer-events-auto' },
})

const emit = defineEmits(['overlay'])

// Esc 关闭：与「点遮罩」同义，走各弹窗既有的遮罩语义 ——
// 有的弹窗按设计不关、只提示「请先处理」，共用一条路径才不会出现两套语义。
//
// 为什么要维护一个栈：设置类弹窗里还会再开确认框（两层 DialogShell 同时可见），
// 不做层次判断的话一次 Esc 会把两层一起关掉。只有最上层响应。
const openStack = []
const self = {}
watch(
  () => props.visible,
  (v) => {
    const i = openStack.indexOf(self)
    if (v && i < 0) openStack.push(self)
    else if (!v && i >= 0) openStack.splice(i, 1)
  },
  { immediate: true },
)

function onKeydown(e) {
  if (!props.visible || e.key !== 'Escape') return
  if (openStack[openStack.length - 1] !== self) return
  // 内层自己处理过 Esc（下拉展开、过滤框）就别再关弹窗
  if (e.defaultPrevented) return
  e.preventDefault()
  emit('overlay')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  const i = openStack.indexOf(self)
  if (i >= 0) openStack.splice(i, 1)
})
</script>
