<template>
  <!-- 离场动画播完前 DOM 会保留，measured 不能在关闭时立刻重置（见下面 watch 的说明）。 -->
  <Transition name="ctx-menu">
    <div
      v-if="visible"
      ref="menuEl"
      class="context-menu-popup fixed bg-surface border border-border shadow-md z-[9999] min-w-[120px] py-1 pointer-events-auto"
      :style="menuStyle"
      role="menu"
      @contextmenu.prevent
      @keydown="onKeydown"
    >
      <div
        v-for="item in items"
        :key="item.label"
        class="px-4 py-2 cursor-pointer hover:bg-surface-hover text-sm text-text transition-theme"
        :class="{ 'opacity-50 cursor-not-allowed': item.disabled }"
        role="menuitem"
        :aria-disabled="item.disabled ? 'true' : undefined"
        tabindex="-1"
        @click="pick(item)"
      >
        {{ item.label }}
      </div>
    </div>
  </Transition>
</template>

<script setup vapor>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { claimContextMenu } from '../../utils/contextMenuRegistry.js'
import { useDisposables } from '../../utils/disposables.js'

defineOptions({ name: 'ContextMenu' })

const emit = defineEmits(['close'])
const props = defineProps({
  visible: Boolean,
  x: Number,
  y: Number,
  items: Array,
})

// measured：是否已量到真实宽高。未量到之前用 visibility:hidden 渲染 ——
// 菜单尺寸由文案决定（min-w-120px 只是下限），猜一个兜底值贴边时会溢出到视口外，
// 量完再修正就是一帧跳位。隐藏量一次再显示，用户永远看不到位置错误的那一帧。
const menuW = ref(0);
const menuH = ref(0);
const measured = ref(false);
const menuEl = ref(null);
// 键盘用户的开/关焦点：打开时从触发点移进菜单，关闭时还回去（F01-07）
let lastFocus = null;

// 互斥：打开时向登记表声明自己，登记表会先让**上一个**菜单自行 emit(close)。
// 放在模块级而不是组件里，是因为行标签菜单与列头菜单是两个实例，互不可见。
const menuToken = Symbol('ctx-menu');
let releaseMenu = null;
function closeSelf() {
  if (props.visible) emit('close');
}
function releaseSelf() {
  if (releaseMenu) { releaseMenu(); releaseMenu = null; }
}

// 右键坐标可能贴着屏幕右/下边缘：先按测量到的实际尺寸往回收，避免菜单被裁掉
const menuStyle = computed(() => {
  const pad = 4;
  let left = Number(props.x) || 0;
  let top = Number(props.y) || 0;
  if (measured.value) {
    const w = menuW.value;
    const h = menuH.value;
    if (left + w > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - w - pad);
    if (top + h > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - h - pad);
  }
  return {
    top: top + 'px',
    left: left + 'px',
    // visibility:hidden 仍参与布局，所以下面的量取能拿到真实尺寸
    visibility: measured.value ? 'visible' : 'hidden',
  };
});

// 视口监听按「展开/收起」反复挂摘，所以自己存取消函数；即使漏摘，卸载时 d 也会兜底。
const d = useDisposables();
let cancelViewport = [];

watch(() => props.visible, (v) => {
  if (!v) {
    removeViewportListeners();
    releaseSelf();
    // 键盘用户关闭后要把焦点还给触发点，否则焦点掉到 body（F01-07）
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (_) { /* best-effort: 触发点已被移除 */ }
    }
    lastFocus = null;
    // **不在这里重置 measured**：Transition 的离场动画还要播 ~100ms，而 menuStyle
    // 用 measured 控制 inline visibility —— 一重置就把菜单藏了，离场一帧都看不见。
    // 改成下次打开时先隐藏再量，两件事都在同一帧内完成。
    return;
  }
  // 记录触发菜单的元素，关闭/选择后还原焦点
  lastFocus = document.activeElement;
  // 先登记互斥：新菜单打开时，上一个菜单会收到 close 并由调用方收起。
  releaseMenu = claimContextMenu(menuToken, closeSelf);
  // 下次打开必须重新量：items 变了宽度也会变。先隐藏一帧，避免看到位置错误的那一帧。
  measured.value = false;
  // 菜单渲染后才能量到真实宽高
  nextTick(() => {
    const el = menuEl.value;
    if (el) {
      menuW.value = el.offsetWidth;
      menuH.value = el.offsetHeight;
      // 键盘用户：打开后焦点进入第一个可用项（F01-07）
      const first = el.querySelector('[role="menuitem"]:not([aria-disabled="true"])');
      if (first) first.focus();
    }
    // 量不到（el 为空）也要放行，否则菜单永久不可见
    measured.value = true;
  });
  // 菜单是 fixed 坐标：滚动/缩放后原坐标不再对应触发位置，直接收起。
  // 与 AppSelect 的视口变化处理保持一致，避免菜单悬空或出视口。
  addViewportListeners();
}, {
  // immediate：万一调用方挂载时 visible 就是 true，也要走一次量取，否则菜单永远隐藏
  immediate: true,
});

onBeforeUnmount(() => {
  removeViewportListeners();
  releaseSelf();
});

function onViewportChange() {
  if (props.visible) emit('close');
}

// 禁用项不执行动作；菜单项的 action 原本可能是 undefined（只读项）
function pick(item) {
  if (!item || item.disabled) return
  if (typeof item.action === 'function') item.action()
}

// 方向键在菜单项之间移动，Enter/Space 执行，Esc 关闭（F01-07）。
// Esc 要 stopPropagation：外层弹窗的 window 监听不该跟着一起关。
function onKeydown(e) {
  const el = menuEl.value
  if (!el) return
  const items = Array.from(el.querySelectorAll('[role="menuitem"]'))
  if (!items.length) return
  const idx = items.indexOf(document.activeElement)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const step = e.key === 'ArrowDown' ? 1 : -1
    let next = idx < 0 ? (step > 0 ? 0 : items.length - 1) : (idx + step + items.length) % items.length
    // 跳过禁用项；全部禁用时停在原处
    for (let i = 0; i < items.length && items[next] && items[next].getAttribute('aria-disabled') === 'true'; i++) {
      next = (next + step + items.length) % items.length
    }
    items[next] && items[next].focus()
  } else if (e.key === 'Home') {
    e.preventDefault()
    items[0].focus()
  } else if (e.key === 'End') {
    e.preventDefault()
    items[items.length - 1].focus()
  } else if (e.key === 'Enter' || e.key === ' ') {
    const it = items[idx]
    if (!it) return
    e.preventDefault()
    pick(props.items[idx])
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}
function addViewportListeners() {
  if (cancelViewport.length) return;
  cancelViewport = [
    d.listen(window, 'scroll', onViewportChange, true),
    d.listen(window, 'resize', onViewportChange),
  ];
}
function removeViewportListeners() {
  for (const c of cancelViewport) c();
  cancelViewport = [];
}
</script>
<style scoped>
/* 右键菜单从光标处轻微展开。离场更短，避免淡出的菜单挡住紧随其后的点击。
   时长与 AppHelp / SearchBar 的 popover 过渡保持一致，同样尊重 reduced-motion。 */
.ctx-menu-enter-active {
  transition: opacity 130ms ease-out, transform 130ms ease-out;
  transform-origin: top left;
}
.ctx-menu-leave-active {
  transition: opacity 90ms ease-in, transform 90ms ease-in;
  transform-origin: top left;
  /* 点菜单项后常会立刻弹确认框 / 执行动作，淡出期间不再接管指针 */
  pointer-events: none;
}
.ctx-menu-enter-from,
.ctx-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
@media (prefers-reduced-motion: reduce) {
  .ctx-menu-enter-active,
  .ctx-menu-leave-active {
    transition: none;
  }
}
</style>