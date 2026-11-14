<template>
  <!-- 二级弹窗：从「班级信息设置」里再开一层。
       z-index 比 ClassInfoDialog(10001) 高一级；Esc 的层次判断由 DialogShell 的
       dialogStack 负责（只有最上层响应），这里不用自己处理。 -->
  <DialogShell :visible="visible" :z-index="10002" @overlay="$emit('cancel')">
    <div class="bg-surface p-5 rounded-xl w-[400px] max-w-full shadow-lg dialog-card" @keydown="onKeydown">
      <h3 class="text-lg font-bold mb-4 text-text">新增班级</h3>

      <label class="block text-sm text-text-secondary mb-1">班级名称</label>
      <input
        ref="nameInput"
        v-model="name"
        type="text"
        maxlength="50"
        placeholder="如：初三九班"
        class="w-full px-3 py-2 text-sm rounded-lg bg-surface-hover border focus:outline-none"
        :class="duplicate ? 'border-danger focus:border-danger' : 'border-border focus:border-primary'"
      />
      <!-- 重名就地提示，不等请求回来：后端也会拦（409），但那要一次往返，
           而且错误提示会以全局通知的形式飘在右上角，和输入框离得很远。 -->
      <p v-if="duplicate" class="mt-1.5 text-xs text-danger">已有同名班级，请换个名字</p>
      <p v-else class="mt-1.5 text-xs text-text-muted">新班级是空的，创建后会进入该班</p>

      <div class="flex justify-end gap-2 mt-5">
        <button type="button" @click="$emit('cancel')" class="px-4 py-2 rounded-lg glass-cancel">取消</button>
        <button
          type="button"
          :disabled="busy || !name.trim() || duplicate"
          @click="submit"
          class="px-4 py-2 rounded-lg bg-primary text-text-inverse hover:bg-primary-hover transition-theme disabled:opacity-50 disabled:cursor-not-allowed"
        >{{ busy ? '创建中…' : '创建' }}</button>
      </div>
    </div>
  </DialogShell>
</template>

<script setup vapor>
import '../../styles/dialog-transition.css'
import { ref, computed, watch, nextTick } from 'vue'
import DialogShell from '../base/DialogShell.vue'

defineOptions({ name: 'AddClassDialog' })

const props = defineProps({
  visible: { type: Boolean, default: false },
  // 创建进行中：由父组件控制，防止连点重复建库（建库是不可回退的写操作）
  busy: { type: Boolean, default: false },
  // 该账号已有的班名：用于就地拦重名。后端也会拦（409），这里只是省一次往返 + 让错误
  // 出现在输入框下面，而不是飘在屏幕角落的全局通知里。
  existingNames: { type: Array, default: () => [] },
})
const emit = defineEmits(['confirm', 'cancel'])

const name = ref('')
const nameInput = ref(null)

// 与后端同一口径：trim 后严格相等（中文班名没有大小写问题；
// 大小写不敏感反而会让「Class 1 / class 1」这种想区分的名字建不出来）
const duplicate = computed(() => {
  const v = name.value.trim()
  if (!v) return false
  return props.existingNames.some((n) => String(n || '').trim() === v)
})

// 每次打开都清空：上一次没提交的名字留着，下次很容易误建一个同名的班
watch(() => props.visible, (v) => {
  if (!v) return
  name.value = ''
  nextTick(() => { nameInput.value?.focus() })
})

function submit() {
  const v = name.value.trim()
  if (!v || props.busy || duplicate.value) return
  // 不在这里关闭弹窗：创建成功会切班、整个父组件随之重建，弹窗自然消失；
  // 失败时留在原地，用户可以改个名字重试，不用重新点开。
  emit('confirm', v)
}

// 回车提交。按钮上按回车是「按这个按钮」，不再拦截（与 ClassInfoDialog 同一处理）。
function onKeydown(e) {
  if (e.key !== 'Enter' || e.isComposing) return
  const tag = e.target && e.target.tagName
  if (tag === 'BUTTON' || tag === 'A' || tag === 'TEXTAREA') return
  e.preventDefault()
  submit()
}
</script>

<style scoped>
/* 与 ClassInfoDialog 的取消按钮保持一致：半透明白遮罩 + 背景模糊 + 无边框 */
.glass-cancel {
  border: none !important;
  border-width: 0 !important;
  box-shadow: none !important;
  background-color: rgba(255, 255, 255, 0.5);
  backdrop-filter: blur(12px) saturate(1.3);
  color: var(--color-text);
  transition: background-color 0.15s ease;
}
.glass-cancel::before {
  display: none !important;
}
.glass-cancel:hover {
  background-color: rgba(255, 255, 255, 0.56);
}
</style>
