
<template>
  <!-- 表头切换组件 -->
  <div>
    <!-- 标签头：预留一行按钮高度，避免 tab 数据加载后填充/换行改变行高，造成下方内容位移（CLS） -->
    <div class="flex gap-2 mb-6 items-center min-h-[2.5rem]" role="tablist" @keydown="onKeydown">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        role="tab"
        :aria-selected="modelValue === tab.value"
        :tabindex="modelValue === tab.value ? 0 : -1"
        @click="$emit('update:modelValue', tab.value)"
        @mouseenter="$emit('hover', tab.value)"
        :class="[
          'tab-btn px-5 py-2.5 rounded-xl font-medium text-sm transition-[background-color,color,box-shadow,transform,scale] duration-300 ease-in-out',
          'hover:shadow-md hover:scale-105',
          modelValue === tab.value
            ? 'bg-info text-text-inverse shadow-lg shadow-info/30 tab-active'
            : 'bg-surface-hover text-text-secondary hover:bg-border hover:text-text'
        ]"
      >
        {{ tab.label }}
      </button>
      <slot name="extra" />
    </div>

    <!-- 内容区 -->
    <slot :activeTab="modelValue" />
  </div>
</template>

<script setup vapor>
defineOptions({ name: 'Tabs' })
const props = defineProps({
  tabs: { type: Array, required: true },
  modelValue: { type: String, required: true }
})
const emit = defineEmits(['update:modelValue', 'hover'])

// roving tabindex + 方向键：与 ViewSwitch 同一套口径（F01-03）。
// Tab 只停在当前选中项，左右/上下切换并把焦点带到新标签上。
function onKeydown(e) {
  const n = props.tabs.length
  if (!n) return
  const idx = props.tabs.findIndex(t => t.value === props.modelValue)
  let next = idx
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (Math.max(idx, 0) + 1) % n
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (Math.max(idx, 0) - 1 + n) % n
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = n - 1
  else return
  e.preventDefault()
  emit('update:modelValue', props.tabs[next].value)
  const tabs = e.currentTarget.querySelectorAll('[role="tab"]')
  if (tabs[next]) tabs[next].focus()
}
</script>