<template>
  <DialogShell :visible="visible" :z-index="10002" @overlay="$emit('cancel')">
    <div class="bg-surface p-5 rounded-lg w-[560px] max-w-[92vw] max-h-[80vh] flex flex-col shadow-card dialog-card">
      <h3 class="text-lg font-bold mb-3 text-text">同学同名处理</h3>
      <p class="text-sm text-text-secondary mb-3">
        <span class="font-medium text-text">{{ name }}</span> 同学和以下同学同名，请问是哪一位同学
      </p>
      <div class="flex-1 overflow-auto app-custom-scroll">
        <div
          v-for="row in rows"
          :key="row.key"
          class="flex items-center justify-between gap-4 px-3 py-2 border-b border-border last:border-b-0"
        >
          <span class="text-sm text-text truncate" :title="row.label">{{ row.label }}</span>
          <select
            :value="selections[row.key]"
            @change="onPick(row.key, $event)"
            class="w-[220px] shrink-0 px-2 py-1.5 text-sm rounded-lg bg-surface-hover border border-border text-text focus:outline-none focus:border-primary cursor-pointer"
            :aria-label="`为 ${row.label} 选择同学`"
          >
            <option v-for="opt in row.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>
      </div>
      <div class="flex justify-end gap-2 mt-4">
        <button type="button" @click="$emit('cancel')" class="bg-surface-hover px-4 py-1.5 rounded text-text cursor-pointer">取消</button>
        <button type="button" @click="onConfirm" class="bg-primary text-text-inverse px-4 py-1.5 rounded cursor-pointer">确定</button>
      </div>
    </div>
  </DialogShell>
</template>

<script setup vapor>
import DialogShell from '../base/DialogShell.vue'
import { ref, watch } from 'vue'
import '../../styles/dialog-transition.css'

defineOptions({ name: 'DuplicateNameDialog' })
const props = defineProps({
  visible: Boolean,
  name: { type: String, default: '' },
  // [{ key, label, options: [{ value, label }] }] —— value: 'id:<学生id>' 或 'new'
  rows: { type: Array, default: () => [] }
})
const emit = defineEmits(['confirm', 'cancel'])

// 每个同名行默认选第一个候选（用户看到的就是第一个），点选即改。
// 整体替换 ref 对象（不是改属性）：vapor 下稳定触发 select 的 value 更新。
const selections = ref({})
// ImportExcel 复用同一个弹窗连处理多组同名：visible 全程 true，只换 rows，
// 所以必须同时监听 rows，否则第二组还显示第一组的默认选择（V9-F02-02）。
watch([() => props.visible, () => props.rows], () => {
  if (!props.visible) return
  const next = {}
  for (const row of props.rows) {
    const first = row.options.find(o => o.value !== 'new')
    next[row.key] = first ? first.value : 'new'
  }
  selections.value = next
}, { immediate: true })

function onPick(key, e) { selections.value = { ...selections.value, [key]: e.target.value } }
function onConfirm() {
  emit('confirm', { ...selections.value })
}
</script>
