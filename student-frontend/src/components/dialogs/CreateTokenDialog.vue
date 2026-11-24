<template>
  <DialogShell :visible="show" :z-index="10070" overlay-class="bg-black/50" @overlay="close">
    <div class="dialog-card bg-surface rounded-lg p-6 w-[30rem] max-w-[calc(100vw-2rem)] border border-border shadow-lg">
      <div class="flex items-center justify-between mb-5 flex-shrink-0">
        <h3 class="text-lg font-bold text-text">令牌选项</h3>
        <button @click="close" class="dlg-close" title="关闭">✕</button>
      </div>

      <div class="space-y-4">
        <div class="flex items-center gap-4">
          <label class="text-sm font-medium text-text w-20 flex-shrink-0">令牌名称</label>
          <input v-model="form.label" maxlength="80" placeholder="如「Claude Desktop」，留空用默认名"
            class="flex-1 min-w-0 border border-border bg-surface text-text px-3 py-2 rounded" aria-label="如「Claude Desktop」，留空用默认名"/>
        </div>
        <div class="flex items-start gap-4">
          <label class="text-sm font-medium text-text w-20 flex-shrink-0 pt-1.5">令牌有效期</label>
          <div class="flex-1 flex flex-wrap gap-2">
            <button v-for="opt in expiryOptions" :key="opt.days" type="button" @click="form.validDays = opt.days"
              class="px-3 py-1.5 rounded text-sm border transition-theme cursor-pointer"
              :class="form.validDays === opt.days
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-text hover:bg-surface-hover'">
              {{ opt.label }}
            </button>
          </div>
        </div>

        <p v-if="error" class="text-xs text-danger">{{ error }}</p>
        <p class="text-xs text-text-muted leading-relaxed">到期后令牌自动失效，外部客户端会连不上；届时重新生成一个并把新配置填进去即可。</p>

        <div class="flex items-center justify-end gap-3 pt-1">
          <button @click="close" class="border border-border text-text px-4 py-2 rounded hover:bg-surface-hover cursor-pointer transition-theme">取消</button>
          <button @click="submit" :disabled="busy"
            class="bg-primary hover:bg-primary-hover text-text-inverse px-5 py-2 rounded transition-theme disabled:opacity-40 cursor-pointer">
            {{ busy ? '创建中…' : '确定' }}
          </button>
        </div>
      </div>
    </div>
  </DialogShell>
</template>

<script setup vapor>
import { ref, watch } from 'vue'
import axios from 'axios'
import DialogShell from '../base/DialogShell.vue'

defineOptions({ name: 'CreateTokenDialog' })

const props = defineProps({
  show: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'created'])

const expiryOptions = [
  { label: '1天', days: 1 },
  { label: '2天', days: 2 },
  { label: '1个月', days: 30 },
  { label: '半年', days: 180 },
  { label: '一年', days: 365 },
]

const form = ref({ label: '', validDays: 30 })
const busy = ref(false)
const error = ref('')

watch(() => props.show, (v) => {
  if (!v) return
  form.value = { label: '', validDays: 30 }
  error.value = ''
})

function close() {
  if (busy.value) return // 创建请求在飞时别让弹窗消失，避免用户重复点「新增令牌」
  emit('close')
}

async function submit() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    await axios.post('/api/mcp/tokens', {
      label: String(form.value.label || '').trim() || '外部 AI 客户端',
      validDays: form.value.validDays,
    })
    emit('created')
    emit('close')
  } catch (e) {
    error.value = (e.response && e.response.data && e.response.data.error) || e.message || '创建失败'
  } finally {
    busy.value = false
  }
}
</script>
