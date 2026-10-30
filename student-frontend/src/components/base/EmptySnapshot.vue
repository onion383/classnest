<template>
  <!-- 空态占位：整行铺满（与表格/骨架屏同宽同高），底色走主题 surface（毛玻璃主题下即白色磨砂玻璃）
       text/icon/minHeight 可覆盖默认值，供「非表格位置」的空态复用（如座位指数条列表）。
       不传时与原来完全一致，既有调用方无需改动。 -->
  <div class="snapshot-empty bg-surface" :style="{ minHeight }">
    <span class="snapshot-empty-icon">{{ icon }}</span>
    <span class="snapshot-empty-text">{{ text }}</span>
  </div>
</template>

<script setup>
defineOptions({ name: 'EmptySnapshot' })
defineProps({
  text: { type: String, default: '暂未有历史快照' },
  icon: { type: String, default: '🗓' },
  // 与同位置的内容块保持等高，避免空态↔数据切换时页面跳动
  minHeight: { type: String, default: '320px' }
})
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
