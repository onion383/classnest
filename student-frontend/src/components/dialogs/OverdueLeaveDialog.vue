<template>
  <DialogShell :visible="visible" :z-index="70" overlay-class="bg-black/30">
      <div class="bg-surface rounded-lg p-5 shadow-card dialog-card flex flex-col" style="width: 460px; max-width: 90vw;">
        <div class="flex items-center gap-2 mb-1">
          <button @click="$emit('close')" :disabled="busy" class="dlg-close" title="关闭窗口" aria-label="关闭窗口">✕</button>
          <h4 class="text-base font-bold flex items-center gap-2"><IconGlyph name="clock" :size="16" /> 发现假期已结束</h4>
        </div>
        <p class="text-sm text-text-secondary mb-4">以下同学假期已经结束但尚未销假，请确认返校情况：</p>
        <div class="flex-1 overflow-auto space-y-3 mb-1" style="max-height: 340px;">
          <div
            v-for="rec in records"
            :key="rec.id"
            class="flex flex-wrap items-center justify-between gap-2 border border-border rounded p-2"
          >
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-text">{{ rec.姓名 }}</div>
              <div class="text-xs text-text-secondary">{{ rec._range }}</div>
            </div>
            <div class="flex gap-2 shrink-0">
              <button @click="$emit('not', rec)" class="bg-surface-hover border border-border px-3 py-1 rounded text-xs text-text cursor-pointer hover:bg-border transition-theme">未返校</button>
              <button @click="$emit('ret', rec)" class="bg-success hover:bg-green-700 text-text-inverse px-3 py-1 rounded text-xs border-none cursor-pointer transition-theme">已经返校并销假</button>
            </div>
          </div>
        </div>
        <!-- 底部操作条：左上角 ✕ 与「关闭窗口」都只关窗、不改数据；「全部销假」由父组件二次确认后执行 -->
        <div class="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-border shrink-0">
          <button @click="$emit('close')" :disabled="busy" class="bg-surface-hover border border-border px-4 py-1.5 rounded text-sm text-text cursor-pointer hover:bg-border transition-theme disabled:opacity-50">关闭窗口</button>
          <button @click="$emit('retall')" :disabled="busy || !records.length" class="bg-success hover:bg-green-700 text-text-inverse px-4 py-1.5 rounded text-sm border-none cursor-pointer transition-theme disabled:opacity-50">{{ busy ? '处理中…' : '全部销假' }}</button>
        </div>
      </div>
  </DialogShell>
</template>

<script setup vapor>
import '../../styles/dialog-transition.css'
import DialogShell from '../base/DialogShell.vue'
import IconGlyph from '../base/IconGlyph.vue'

defineOptions({ name: 'OverdueLeaveDialog' })
defineProps({
  visible: Boolean,
  records: { type: Array, default: () => [] },
  // 批量销假执行中：三个关闭入口与「全部销假」一起禁用，避免重复提交
  busy: Boolean
})
// 事件名统一用全小写，避免 Vapor 下 camelCase 事件监听匹配不上
defineEmits(['not', 'ret', 'close', 'retall'])
</script>