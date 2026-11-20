<template>
  <!--
    一级入口弹窗：AI 助手页标题栏「数据保护」按钮的落地层。
    本文件只负责外壳（标题栏 + 滚动区），开关与文案全在 AiPrivacyPanel 里，
    逻辑不重复一份；面板本身不知道自己被谁装着。
  -->
  <DialogShell :visible="show" :z-index="10005" overlay-class="bg-black/50" @overlay="close">
    <div class="dialog-card bg-surface rounded-lg p-6 w-[38rem] max-w-[calc(100vw-2rem)] border border-border shadow-lg flex flex-col relative" style="max-height: 90vh;">
      <div class="flex items-center justify-between mb-4 flex-shrink-0">
        <h3 class="text-lg font-extrabold text-text tracking-wide flex items-center gap-2">
          <IconGlyph name="shieldCheck" :size="18" /> AI 数据保护
        </h3>
        <button @click="close" class="dlg-close" title="关闭">✕</button>
      </div>

      <div class="flex-1 overflow-y-auto overflow-x-hidden min-h-0 app-custom-scroll">
        <AiPrivacyPanel />
      </div>
    </div>
  </DialogShell>
</template>

<script setup vapor>
import DialogShell from '../base/DialogShell.vue'
import IconGlyph from '../base/IconGlyph.vue'
import AiPrivacyPanel from '../data-manage/AiPrivacyPanel.vue'

defineProps({
  show: { type: Boolean, default: false },
})
const emit = defineEmits(['close'])

function close() { emit('close') }
</script>
