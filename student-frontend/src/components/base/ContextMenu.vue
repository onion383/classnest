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
    >
      <div
        v-for="item in items"
        :key="item.label"
        class="px-4 py-2 cursor-pointer hover:bg-surface-hover text-sm text-text transition-theme"
        role="menuitem"
        tabindex="-1"
        @click="item.action"
      >
        {{ item.label }}
      </div>
    </div>
  </Transition>
</template>

<script setup vapor>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { claimContextMenu } from '../../utils/contextMenuRegistry.js'

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

watch(() => props.visible, (v) => {
  if (!v) {
    removeViewportListeners();
    releaseSelf();
    // **不在这里重置 measured**：Transition 的离场动画还要播 ~100ms，而 menuStyle
    // 用 measured 控制 inline visibility —— 一重置就把菜单藏了，离场一帧都看不见。
    // 改成下次打开时先隐藏再量，两件事都在同一帧内完成。
    return;
  }
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
function addViewportListeners() {
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
}
function removeViewportListeners() {
  window.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
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