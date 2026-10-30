<template>
  <!-- 空态占位：整行铺满（与表格/骨架屏同宽同高），底色走主题 surface（毛玻璃主题下即白色磨砂玻璃）
       text/icon/minHeight 可覆盖默认值，供「非表格位置」的空态复用（如座位指数条列表）。
       不传时与原来完全一致，既有调用方无需改动。 -->
  <div class="snapshot-empty bg-surface" :style="{ minHeight }">
    <span class="snapshot-empty-icon">{{ icon }}</span>
    <span class="snapshot-empty-text">{{ text }}</span>
    <!-- 默认插槽：需要「空态 + 自定义内容」时塞进来。不传时渲染为空，既有调用方零改动。
         常规的「一行去某某的引导按钮」不必写插槽，传 actionText / actionIcon 即可。 -->
    <slot />
    <!-- 引导按钮：actionText 为空时不渲染，既有调用方不受影响。
         配色与内边距沿用值日页原先手写的那一份（bg-info 实心蓝 + text-text-inverse 主题反色字），
         所以从手写插槽迁过来观感零变化。
         为什么是 bg-info 而不是 bg-primary：--color-primary 在 base 主题是绿、minimal 近黑，
         只有 glass 系才是蓝；--color-info 全主题都是蓝。这条是用户定的口径（占位页按钮统一蓝色）。 -->
    <button
      v-if="actionText"
      type="button"
      class="bg-info text-text-inverse px-4 py-2 rounded flex items-center gap-1.5"
      @click="emit('action')"
    ><IconGlyph v-if="actionIcon" :name="actionIcon" :size="14" tint="current" /> {{ actionText }}</button>
  </div>
</template>

<script setup>
import IconGlyph from './IconGlyph.vue'

defineOptions({ name: 'EmptySnapshot' })
defineProps({
  text: { type: String, default: '暂未有历史快照' },
  icon: { type: String, default: '🗓' },
  // 与同位置的内容块保持等高，避免空态↔数据切换时页面跳动
  minHeight: { type: String, default: '320px' },
  // 引导按钮文案。留空则不渲染按钮（多数纯展示的空态不需要）
  actionText: { type: String, default: '' },
  // 引导按钮左侧图标（IconGlyph 的 name）。留空则只有文字
  actionIcon: { type: String, default: '' }
})

// 按钮点击：具体做什么由页面决定（组件不知道业务该打开哪个弹窗）
const emit = defineEmits(['action'])
</script>

<style scoped>
.snapshot-empty {
  box-sizing: border-box;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  /* 与同位置的表格容器保持同样的圆角与描边，避免切换时视觉跳变。
     故取 --radius-table（表格容器档），而不是另选一档。 */
  border-radius: var(--radius-table);
  border: 1px solid var(--color-border, #e5e7eb);
}
.snapshot-empty-icon {
  font-size: 44px;
  line-height: 1;
  opacity: 0.85;
}
.snapshot-empty-text {
  font-size: 18px;
  color: var(--color-text-muted, #94a3b8);
  letter-spacing: 1px;
}
</style>
