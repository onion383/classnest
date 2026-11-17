<template>
  <!-- 标题栏待办胶囊：没有待办时整个不渲染（不是显示「0 项」）。
       放在 window-controls 内是为了复用它的 no-drag（标题栏整条是拖拽区）。 -->
  <button
    v-if="total > 0"
    class="tb-todo"
    :title="`有 ${total} 项待处理，点击查看`"
    @click="$emit('open')"
  >
    <span class="tb-bell-icon">
      <IconGlyph name="bell" tint="current" glyph :size="14" :stroke-width="1.8" />
    </span>
    <span>{{ total }} 项待处理</span>
  </button>
</template>

<script setup vapor>
import IconGlyph from './IconGlyph.vue'

defineProps({
  total: { type: Number, default: 0 },
})
defineEmits(['open'])
</script>

<style scoped>
/* 从 App.vue 的原销假铃铛搬过来：贴在窗口控制按钮左侧，宽度按文案自适应。
   app-region 不继承，容器设了 no-drag 仍要逐个子元素显式覆盖，否则点不动。
   配色全走 currentColor，四套主题的顶栏文字色都能自动跟上。 */
.tb-todo {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  margin-right: 8px;
  border: none !important;
  box-shadow: none !important;
  border-radius: var(--radius-control);
  background: color-mix(in srgb, currentColor 8%, transparent);
  color: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: background-color 0.12s ease;
  /* 胶囊本体稍后从右滑入；铃铛先淡入（见下方 .tb-bell-icon）。
     transform 不参与布局，标题栏右侧的窗口按钮不会被顶动。 */
  animation: todo-capsule-in 0.34s cubic-bezier(0.22, 1, 0.36, 1) 0.1s both;
}
/* 毛玻璃主题的全局 button::before 发光必须压掉，否则胶囊上多出一层 */
.tb-todo::before { display: none !important; }
.tb-todo:hover { background: color-mix(in srgb, currentColor 16%, transparent); }

.tb-bell-icon {
  display: inline-flex;
  align-items: center;
  /* 无延迟：先于胶囊滑入开始淡入 */
  animation: todo-bell-fade 0.24s ease-out both;
}

@keyframes todo-bell-fade {
  from { opacity: 0; transform: scale(0.7); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes todo-capsule-in {
  from { opacity: 0; transform: translateX(30px); }
  to { opacity: 1; transform: translateX(0); }
}
/* 全局 html.no-animations * 已把 animation-duration/delay 压到 0，
   这里不用再写 prefers-reduced-motion，避免两套开关口径分叉。 */
</style>
