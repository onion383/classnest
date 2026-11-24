<template>
  <span
    class="clip-text"
    :class="{ 'clip-text-long': isLong }"
    :title="isLong ? '点击查看完整内容' : undefined"
    :role="isLong ? 'button' : undefined"
    :tabindex="isLong ? 0 : undefined"
    aria-haspopup="dialog"
    :aria-expanded="isLong ? open : undefined"
    @click.stop="isLong && (open = true)"
    @keydown.enter.prevent="isLong && (open = true)"
    @keydown.space.prevent="isLong && (open = true)"
  >
    <span v-if="isLong">{{ clipped }}…</span>
    <span v-else>{{ text }}</span>
  </span>

  <!-- 完整内容浮窗：复用项目统一弹窗范式 -->
  <DialogShell :visible="open" :z-index="10005" :label="title" @overlay="close">
    <div class="bg-surface p-5 rounded-xl w-[420px] max-w-full shadow-lg dialog-card">
      <h3 class="text-lg font-bold mb-3 text-text">{{ title }}</h3>
      <div class="text-sm text-text leading-relaxed whitespace-pre-wrap break-words max-h-[50vh] overflow-y-auto">{{ text }}</div>
      <div class="flex justify-end gap-2 mt-4">
        <button @click="close" class="px-4 py-2 rounded-lg bg-primary text-text-inverse hover:bg-primary-hover transition-theme">关闭</button>
      </div>
    </div>
  </DialogShell>
</template>

<script setup vapor>
import { ref, computed } from 'vue'
import '../styles/dialog-transition.css'
import DialogShell from './base/DialogShell.vue'

const props = defineProps({
  // 要展示的文本
  text: { type: [String, Number], default: '' },
  // 超过该字符数即截断，并允许点击查看完整内容
  max: { type: Number, default: 28 },
  // 浮窗标题
  title: { type: String, default: '完整内容' },
})

const open = ref(false)
const isLong = computed(() => String(props.text).length > props.max)
const clipped = computed(() => String(props.text).slice(0, props.max))

function close() { open.value = false }
</script>

<style scoped>
.clip-text {
  white-space: pre-wrap; /* 保留换行 */
}

/* 被截断的文本提示可点击 */
.clip-text-long {
  cursor: pointer;
  border-bottom: 1px dashed rgba(0, 0, 0, 0.35);
}
.clip-text-long:hover {
  border-bottom-style: solid;
  opacity: 0.85;
}
</style>