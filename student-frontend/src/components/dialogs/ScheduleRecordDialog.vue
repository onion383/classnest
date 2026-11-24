<template>
  <DialogShell :visible="visible" :z-index="zIndex" overlay-class="bg-black/40" @overlay="$emit('close')">
    <div class="bg-surface rounded-lg p-5 shadow-card dialog-card border border-border flex flex-col overflow-hidden w-[560px] max-w-[92vw] max-h-[80vh]">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold">管理周课表记录</h3>
        <button class="dlg-close" title="关闭" @click="$emit('close')">✕</button>
      </div>

      <div class="flex-1 overflow-auto border border-border rounded">
        <div v-if="loading" class="text-xs text-text-muted p-3">加载中…</div>
        <div v-else-if="error" class="text-xs text-danger p-3">{{ error }}</div>
        <div v-else-if="!weeks.length" class="text-xs text-text-muted p-3">暂无周记录</div>
        <template v-else>
        <div
          v-for="w in weeks"
          :key="w.week_start"
          class="flex items-center gap-3 px-3 py-2 border-b border-border last:border-b-0"
        >
          <span class="font-medium text-text">{{ w.week_start }}</span>
          <span class="text-xs text-text-muted">{{ w.count || '' }}</span>
          <button
            @click="askDelete(w)"
            :disabled="deleting === w.week_start"
            class="ml-auto bg-danger text-text-inverse px-3 py-1 rounded disabled:opacity-40"
          >删除</button>
        </div>
        </template>
      </div>

      <div class="flex justify-end mt-4">
        <button @click="$emit('close')" class="bg-surface-hover px-4 py-2 rounded text-text border border-border">关闭</button>
      </div>

      <ConfirmDialog
        :visible="confirmOpen"
        title="删除周记录"
        :message="`确定删除 ${pending} 这一周的课表记录吗？删除后不可恢复。`"
        confirm-text="删除"
        :show-cancel="true"
        :z-index="zIndex + 1"
        @confirm="doDelete"
        @cancel="confirmOpen = false"
      />
    </div>
  </DialogShell>
</template>

<script setup vapor>
// 课表历史快照管理：列周 + 删除。与座位/值日的 RecordSettingsDialog 同职责，
// 但课表历史入口原本内联在 ScheduleView，没有独立弹窗，这里补一个供设置页直达。
import axios from 'axios'
import { ref, watch } from 'vue'
import DialogShell from '../base/DialogShell.vue'
import ConfirmDialog from '../base/ConfirmDialog.vue'
import { useNotification } from '../../composables/useNotification.js'
import '../../styles/dialog-transition.css'

defineOptions({ name: 'ScheduleRecordDialog' })
const props = defineProps({
  visible: { type: Boolean, default: false },
  zIndex: { type: Number, default: 10014 },
})
defineEmits(['close', 'changed'])
const notify = useNotification()

const weeks = ref([])
const loading = ref(false)
const error = ref('')
const deleting = ref('')
const confirmOpen = ref(false)
const pending = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await axios.get('/api/schedule/history')
    weeks.value = Array.isArray(data) ? data : []
  } catch (e) {
    error.value = e.response?.data?.error || e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function askDelete(w) {
  pending.value = w.week_start
  confirmOpen.value = true
}

async function doDelete() {
  const week = pending.value
  confirmOpen.value = false
  deleting.value = week
  try {
    await axios.delete(`/api/schedule/history/${encodeURIComponent(week)}`)
    notify.success('已删除')
    await load()
  } catch (e) {
    notify.error('删除失败：' + (e.response?.data?.error || e.message))
  } finally {
    deleting.value = ''
  }
}

watch(() => props.visible, v => { if (v) load() }, { immediate: true })
</script>
