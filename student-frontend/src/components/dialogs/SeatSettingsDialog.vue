<template>
  <DialogShell :visible="visible" :z-index="50" overlay-class="bg-black/30">
    <div class="bg-surface rounded-lg p-6 w-80 shadow-card dialog-card">
      <h3 class="text-lg font-bold mb-4">座位设置</h3>
      <div class="mb-3">
        <label class="block text-sm font-medium">行数</label>
        <input v-model.number="localRows" type="number" min="1" max="50" class="w-full border px-3 py-2 rounded" />
      </div>
      <div class="mb-4">
        <div class="flex items-center gap-1.5 mb-1">
          <label class="block text-sm font-medium">座位列数</label>
          <AppHelp text="只数「坐人的列」，不含走廊。走廊列由座位模式自动加在列间：单座每列后一条，双座每两列后一条，混合桌初始与双座相同。" aria-label="座位列数说明" />
        </div>
        <input v-model.number="localCols" type="number" min="1" max="30" class="w-full border px-3 py-2 rounded" />
      </div>
      <div class="mb-4">
        <label class="block text-sm font-medium mb-1">座位模式</label>
        <select v-model="localMode" class="w-full border px-3 py-2 rounded bg-surface text-text">
          <option value="single">单座</option>
          <option value="double">双座</option>
          <option value="mixed">混合桌</option>
        </select>
        <p v-if="localMode === 'mixed'" class="mt-2 text-xs text-text-muted leading-relaxed">
          初始按双座排布。列头右键可「拆成两张单人桌」或「与右侧一列同桌」，桌子之间会自动插入 / 删除走廊。
        </p>
      </div>
      <div class="flex justify-end gap-2">
        <button @click="$emit('cancel')" class="bg-surface-hover px-4 py-2 rounded text-text">取消</button>
        <button @click="save" class="bg-info text-text-inverse px-4 py-2 rounded">保存</button>
      </div>
    </div>
  </DialogShell>
</template>

<script setup vapor>
import { ref, watch } from 'vue'
import { useNotification } from '../../composables/useNotification.js'
import '../../styles/dialog-transition.css'
import AppHelp from '../base/AppHelp.vue'
import DialogShell from '../base/DialogShell.vue'

defineOptions({ name: 'SeatSettingsDialog' })
const props = defineProps({
  visible: Boolean,
  rows: { type: Number, required: true },
  // 座位列数（不含走廊列）。换算成网格总列数由 useSeatGrid.saveSettings 负责。
  cols: { type: Number, required: true },
  mode: { type: String, default: 'single' }
})
const emit = defineEmits(['save', 'cancel'])
const { error: notifyError } = useNotification()

const localRows = ref(props.rows)
const localCols = ref(props.cols)
const localMode = ref(props.mode)

watch(() => props.visible, (val) => {
  if (val) {
    localRows.value = props.rows
    localCols.value = props.cols
    localMode.value = props.mode
  }
})
// 同桌模式下列数必须为偶数（每两列为一组）；切到同桌时自动把奇数取整为偶数
watch(localMode, (val) => {
  if (val === 'double' && localCols.value % 2 !== 0) {
    localCols.value = Math.max(2, Math.min(30, localCols.value + 1))
  }
})

function save() {
  if (!Number.isInteger(localRows.value) || !Number.isInteger(localCols.value)) {
    notifyError('行数和列数必须是整数')
    return
  }
  if (localRows.value < 1 || localRows.value > 50) {
    notifyError('设置的行/列过大\n过大的行和列会引起显示问题和程序卡顿')
    return
  }
  if (localCols.value < 1 || localCols.value > 30) {
    notifyError('设置的行/列过大\n过大的行和列会引起显示问题和程序卡顿')
    return
  }
  if (localMode.value === 'double' && localCols.value % 2 !== 0) {
    notifyError('同桌模式下列数必须为偶数\n如需单桌，请自行留空该座位')
    return
  }
  emit('save', {
    rows: localRows.value,
    cols: localCols.value,
    mode: localMode.value
  })
}
</script>