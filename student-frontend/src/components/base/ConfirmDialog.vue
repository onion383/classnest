<template>
  <DialogShell :visible="visible" :z-index="zIndex" @overlay="handleOverlayClick">
    <div class="bg-surface p-5 rounded-lg min-w-[300px] max-w-[600px] text-center shadow-card dialog-card">
      <h3 v-if="title" class="text-lg font-bold mb-3">{{ title }}</h3>
      <!-- 添加列：显示列名输入 + 类型选择 -->
      <p v-if="message" class="mb-3 whitespace-pre-line break-words text-sm leading-relaxed">{{ message }}</p>
      <div v-if="type === 'columnAdd'" class="text-left">
        <label class="block mb-2">新列名：
          <input
            :value="columnName"
            @input="$emit('update:columnName', $event.target.value)"
            class="w-4/5 border border-border rounded px-2 py-1 mt-1"
          />
        </label>
        <label class="block mb-2">数据类型：
          <AppSelect
            :model-value="columnType"
            @change="$emit('update:columnType', $event)"
            class="w-4/5 mt-1"
            :options="[{ value: '文字', label: '文字' }, { value: '整数', label: '整数' }, { value: '小数', label: '小数' }, { value: '日期', label: '日期' }]"
          />
        </label>
        <p v-if="errorMsg" class="text-danger text-sm mt-1">{{ errorMsg }}</p>
      </div>

      <!-- 重命名列：只显示列名输入框 -->
      <div v-if="type === 'columnRename'" class="text-left">
        <label class="block mb-2">新列名：
          <input
            :value="columnName"
            @input="$emit('update:columnName', $event.target.value)"
            class="w-4/5 border border-border rounded px-2 py-1 mt-1"
          />
        </label>
        <p v-if="errorMsg" class="text-danger text-sm mt-1">{{ errorMsg }}</p>
      </div>

      <div class="mt-4">
        <button v-if="showCancel" @click="$emit('cancel')" class="bg-surface-hover border-none px-4 py-1.5 rounded mr-2 cursor-pointer">{{ cancelText }}</button>
        <button v-if="extraText" @click="$emit('extra')" class="bg-surface-hover border-none px-4 py-1.5 rounded mr-2 cursor-pointer">{{ extraText }}</button>
        <button @click="$emit('confirm')" :disabled="confirmDisabled" class="bg-info text-text-inverse border-none px-4 py-1.5 rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">{{ confirmText }}</button>
      </div>
    </div>
  </DialogShell>
</template>

<script setup vapor>
import '../../styles/dialog-transition.css'
import DialogShell from './DialogShell.vue'
// AppSelect 在表格 / 设置页 / 各业务弹窗里共有 35 处静态引用，早就同步躺在主 chunk 里，
// 这里再包 defineAsyncComponent 只是多一层包装（构建期报 INEFFECTIVE_DYNAMIC_IMPORT）。
// 下拉确实只在「添加列」弹窗用到，但拆不出去，就不必假装懒加载。
import AppSelect from './AppSelect.vue'

defineOptions({ name: 'ConfirmDialog' })
const props = defineProps({
  visible: Boolean,
  message: String,
  title: String,
  type: String,
  showCancel: Boolean,
  // 确定按钮禁用（如倒计时未结束时置灰不可点）
  confirmDisabled: Boolean,
  confirmText: { type: String, default: '确定' },
  cancelText: { type: String, default: '取消' },
  // 可选的第三个按钮（如「仅删学生/保留记录」）；为空则不显示
  extraText: { type: String, default: '' },
  columnName: String,
  columnType: String,
  errorMsg: String,
  // 弹窗层级：从已打开的弹窗（MCP 令牌弹窗 10070）里再开确认框时必须高于父弹窗，
  // 否则确认框被压在遮罩下面，看起来像「点了没反应」。默认沿用原来的 10006。
  zIndex: { type: Number, default: 10006 },
})
const emit = defineEmits(['confirm', 'cancel', 'extra', 'update:columnName', 'update:columnType'])

function handleOverlayClick() {
  if (props.showCancel) emit('cancel');
}
</script>