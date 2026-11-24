<template>
  <!-- Markdown 文件编辑窗口：文件名（输入框）+ 内容（大输入框），底部 取消 / 保存 -->
  <DialogShell :visible="visible" :z-index="10001" @overlay="cancel">
    <div class="bg-surface rounded-lg border border-border shadow-card dialog-card md-card flex flex-col p-5">
      <h3 class="text-lg font-bold mb-4">{{ isNew ? '新增 Markdown 文件' : '编辑 Markdown 文件' }}</h3>

      <label class="block mb-1.5 text-sm font-semibold">文件名</label>
      <input
        v-model="name"
        :disabled="nameDisabled"
        class="md-input border border-border bg-surface text-text p-2 w-full !rounded-[12px] disabled:opacity-60"
        placeholder="输入文件名（无需 .md 后缀）" aria-label="输入文件名（无需 .md 后缀）"/>
      <p v-if="nameDisabled" class="text-xs text-text-muted mt-1">此文件的名称固定，不可修改</p>

      <label class="block mt-4 mb-1.5 text-sm font-semibold">内容</label>
      <textarea
        v-model="content"
        class="md-textarea flex-1 border border-border bg-surface text-text p-3 w-full !rounded-[12px] font-mono text-sm leading-relaxed"
        placeholder="在此编写 Markdown 内容…" aria-label="在此编写 Markdown 内容…"></textarea>

      <div class="text-right mt-4">
        <button @click="cancel" :disabled="pending" class="bg-surface-hover text-text border border-border px-4 py-1.5 rounded-lg mr-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">取消</button>
        <button @click="save" :disabled="!name.trim() || pending" class="bg-info text-text-inverse border-none px-4 py-1.5 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">{{ pending ? '保存中…' : '保存' }}</button>
      </div>
    </div>
  </DialogShell>
</template>

<script setup vapor>
import { ref, watch } from 'vue'
import DialogShell from '../base/DialogShell.vue'
import '../../styles/dialog-transition.css'
import { sanitizeFileName } from '../../utils/fileName.js'

defineOptions({ name: 'MarkdownEditDialog' })
const props = defineProps({
  visible: { type: Boolean, default: false },
  // isNew=true 为「新增文件」；否则为编辑既有文件（原文件名 originalName 用于后端重命名）
  isNew: { type: Boolean, default: false },
  // 文件名是否只读（如「AI 记忆文件」名称固定，不可改名）
  nameDisabled: { type: Boolean, default: false },
  originalName: { type: String, default: '' },
  initialName: { type: String, default: '' },
  initialContent: { type: String, default: '' },
  // 父级保存请求在途：由父级置位/复位，弹窗层据此禁用按钮并拦重复提交（F02-03）
  pending: { type: Boolean, default: false },
})
const emit = defineEmits(['update:visible', 'save'])
// Esc 关闭由 DialogShell 统一处理（含焦点还原与 Tab 圈定）
const name = ref('')
const content = ref('')

watch(
  () => props.visible,
  (v) => {
    if (v) {
      name.value = props.initialName || ''
      content.value = props.initialContent || ''
    }
  },
  { immediate: true }
)

function cancel() { emit('update:visible', false) }
function save() {
  // 双击保存会连发两次写请求：父级 await 期间弹窗仍开着，必须在这里也拦一道
  if (props.pending) return
  // 文件名会落成磁盘上的 <name>.md：非法字符/末尾点空格先清洗，
  // 清成空串（只输了非法字符）时直接不保存，避免创建出诡异的空名文件
  const safeName = sanitizeFileName(name.value, '')
  if (!safeName) return
  emit('save', { original: props.originalName, name: safeName, content: content.value })
}
</script>

<style scoped>
.md-card {
  width: 760px;
  max-width: 92vw;
  height: 660px;
  max-height: 90vh;
}
.md-textarea {
  resize: none;
  min-height: 0;
}
.md-input,
.md-textarea {
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.md-input:focus,
.md-textarea:focus {
  border-color: #3b82f6 !important;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.28) !important;
  outline: none;
}
</style>
