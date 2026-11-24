<template>
  <DialogShell :visible="visible" :z-index="zIndex" overlay-class="bg-black/40" @overlay="$emit('close')">
    <div class="bg-surface rounded-lg border border-border shadow-card dialog-card p-5 w-[360px] max-w-[92vw]">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold text-text">管理快照</h3>
        <button class="dlg-close" title="关闭" @click="$emit('close')">✕</button>
      </div>
      <div class="space-y-2">
        <button
          v-for="d in DOMAINS"
          :key="d.key"
          @click="$emit('pick', d.key)"
          class="w-full text-left text-sm px-3 py-2 rounded border border-border bg-bg hover:bg-surface-hover text-text transition-theme"
        >管理（{{ d.label }}快照）</button>
      </div>
    </div>
  </DialogShell>
</template>

<script setup vapor>
// 快照选择弹窗：账号数据管理点「管理」后单独一层，列三个域再进入对应管理界面。
import DialogShell from '../base/DialogShell.vue'
import '../../styles/dialog-transition.css'

defineOptions({ name: 'SnapshotPickerDialog' })
const props = defineProps({
  visible: { type: Boolean, default: false },
  zIndex: { type: Number, default: 10014 },
})
defineEmits(['close', 'pick'])

const DOMAINS = [
  { key: 'seat', label: '座位' },
  { key: 'duty', label: '值日' },
  { key: 'schedule', label: '课表' },
]
</script>
