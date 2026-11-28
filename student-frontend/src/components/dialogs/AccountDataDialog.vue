<template>
  <DialogShell :visible="visible" :z-index="10012" @overlay="close">
    <div class="bg-surface rounded-lg border border-border shadow-card dialog-card flex flex-col p-5 w-[720px] max-w-[92vw]">
      <div class="flex items-center justify-between mb-4 flex-shrink-0">
        <div class="flex items-center gap-1.5">
          <h3 class="text-lg font-bold text-text">账号数据管理</h3>
          <AppHelp
            text="默认永久保存：程序不会自动清理。选好档位后点「确定」才生效；若已有数据超期会先提示。「删除全部」是手动立即清空，需二次确认。AI 会话只清无消息的空壳，不会连带删聊天记录。清空回收站后，对应删除不能再撤销还原。"
            aria-label="账号数据管理说明"
            :size="13"
          />
        </div>
        <button class="dlg-close" title="关闭" @click="close">✕</button>
      </div>

      <div v-if="loading" class="text-sm text-text-muted py-8 text-center">加载中…</div>
      <div v-else-if="error" class="text-sm text-danger py-4">{{ error }}</div>
      <div v-else>
        <div class="space-y-3">
          <!-- AI 聊天记录：一行一个档位选择器 + 管理 + 删除全部 -->
          <div class="flex items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2.5">
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-text">AI 聊天记录</div>
              <div class="text-xs text-text-muted">{{ fmtBytes(stats.messages.bytes) }} · {{ stats.messages.count }} 条</div>
            </div>
            <AppSelect
              aria-label="AI 聊天记录保留期"
              :model-value="draft.messages"
              :options="POLICY_OPTIONS"
              compact
              class="w-20 flex-shrink-0"
              @change="(v) => draft.messages = v"
            />
            <button
              @click="emit('view')"
              class="snap-view flex-shrink-0 text-sm px-4 py-1.5 rounded border border-border bg-surface hover:bg-surface-hover text-text transition-theme"
            >管理</button>
            <button
              @click="askDelete('messages', 'AI 聊天记录')"
              class="flex-shrink-0 text-sm px-4 py-1.5 rounded border border-border bg-surface hover:bg-surface-hover text-danger transition-theme"
            >删除全部</button>
          </div>

          <!-- AI 会话空壳：消息被清后遗留的无消息会话，只清空壳（删会话会 CASCADE 删消息） -->
          <div class="flex items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2.5">
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-text">AI 会话空壳</div>
              <div class="text-xs text-text-muted">{{ fmtBytes(stats.conversations.bytes) }} · {{ stats.conversations.count }} 个</div>
            </div>
            <AppSelect
              aria-label="AI 会话空壳保留期"
              :model-value="draft.conversations"
              :options="POLICY_OPTIONS"
              compact
              class="w-20 flex-shrink-0"
              @change="(v) => draft.conversations = v"
            />
            <button
              @click="askDelete('conversations', 'AI 会话空壳')"
              class="flex-shrink-0 text-sm px-4 py-1.5 rounded border border-border bg-surface hover:bg-surface-hover text-danger transition-theme"
            >删除全部</button>
          </div>

          <!-- 历史快照：与 AI 行同构（名称+占用 / 档位 / 管理 / 删除全部） -->
          <div class="flex items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2.5">
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-text">历史快照</div>
              <div class="text-xs text-text-muted">{{ fmtBytes(stats.history.bytes) }} · {{ stats.history.count }} 条</div>
            </div>
            <AppSelect
              aria-label="历史快照保留期"
              :model-value="draft.history"
              :options="POLICY_OPTIONS"
              compact
              class="w-20 flex-shrink-0"
              @change="(v) => draft.history = v"
            />
            <button
              @click="emit('viewSnapshots')"
              class="snap-view flex-shrink-0 text-sm px-4 py-1.5 rounded border border-border bg-surface hover:bg-surface-hover text-text transition-theme"
            >管理</button>
            <button
              @click="askDelete('history', '历史快照')"
              class="flex-shrink-0 text-sm px-4 py-1.5 rounded border border-border bg-surface hover:bg-surface-hover text-danger transition-theme"
            >删除全部</button>
          </div>

          <!-- 回收站：文件目录（非 SQL 表），同款档位 + 管理 + 删除全部；恢复在管理弹窗内 -->
          <div class="flex items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2.5">
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-text">相册回收站</div>
              <div class="text-xs text-text-muted">{{ fmtBytes(stats.albumTrash.bytes) }} · {{ stats.albumTrash.count }} 个文件</div>
            </div>
            <AppSelect
              aria-label="相册回收站保留期"
              :model-value="draft.albumTrash"
              :options="POLICY_OPTIONS"
              compact
              class="w-20 flex-shrink-0"
              @change="(v) => draft.albumTrash = v"
            />
            <button
              @click="emit('viewTrash', 'albumTrash')"
              class="flex-shrink-0 text-sm px-4 py-1.5 rounded border border-border bg-surface hover:bg-surface-hover text-text transition-theme"
            >管理</button>
            <button
              @click="askDelete('albumTrash', '相册回收站', true)"
              class="flex-shrink-0 text-sm px-4 py-1.5 rounded border border-border bg-surface hover:bg-surface-hover text-danger transition-theme"
            >删除全部</button>
          </div>
          <div class="flex items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2.5">
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-text">收据回收站</div>
              <div class="text-xs text-text-muted">{{ fmtBytes(stats.receiptTrash.bytes) }} · {{ stats.receiptTrash.count }} 个文件</div>
            </div>
            <AppSelect
              aria-label="收据回收站保留期"
              :model-value="draft.receiptTrash"
              :options="POLICY_OPTIONS"
              compact
              class="w-20 flex-shrink-0"
              @change="(v) => draft.receiptTrash = v"
            />
            <button
              @click="emit('viewTrash', 'receiptTrash')"
              class="flex-shrink-0 text-sm px-4 py-1.5 rounded border border-border bg-surface hover:bg-surface-hover text-text transition-theme"
            >管理</button>
            <button
              @click="askDelete('receiptTrash', '收据回收站', true)"
              class="flex-shrink-0 text-sm px-4 py-1.5 rounded border border-border bg-surface hover:bg-surface-hover text-danger transition-theme"
            >删除全部</button>
          </div>
        </div>

        <!-- 底部操作：与其他弹窗同款居中「取消 / 确定」 -->
        <div class="flex justify-center gap-2 mt-4">
          <button
            @click="cancelDraft"
            class="text-sm px-4 py-1.5 rounded border border-border bg-surface hover:bg-surface-hover text-text transition-theme"
          >取消</button>
          <button
            @click="saveDraft"
            class="text-sm px-4 py-1.5 rounded bg-info hover:bg-info-hover text-text-inverse transition-theme"
          >确定</button>
        </div>
      </div>
    </div>

    <!-- 删除全部 / 已有数据超期 两种确认共用 -->
    <ConfirmDialog
      :visible="confirm.open"
      :message="confirm.message"
      :title="confirm.title"
      :show-cancel="true"
      :z-index="10013"
      :confirm-text="confirm.confirmText"
      :confirm-disabled="confirm.disabled"
      @confirm="onConfirm"
      @cancel="onCancelConfirm"
    />
  </DialogShell>
</template>

<script setup vapor>
import { ref, reactive, computed, watch, onBeforeUnmount } from 'vue'
import axios from 'axios'
import { useDisposables } from '../../utils/disposables.js'
import DialogShell from '../base/DialogShell.vue'
import ConfirmDialog from '../base/ConfirmDialog.vue'
import AppSelect from '../base/AppSelect.vue'
import AppHelp from '../base/AppHelp.vue'
import { useNotification } from '../../composables/useNotification.js'
import '../../styles/dialog-transition.css'

defineOptions({ name: 'AccountDataDialog' })

const props = defineProps({
  visible: { type: Boolean, default: false },
})
const emit = defineEmits(['update:visible', 'view', 'viewSnapshots', 'viewTrash', 'changed'])
const notify = useNotification()

// 文案尽量短：选择器 w-20（80px），长文案会被截成「…近一个月」。
const POLICY_OPTIONS = [
  { value: '7d', label: '7 天' },
  { value: '30d', label: '一个月' },
  { value: '180d', label: '半年' },
  { value: 'forever', label: '永久' },
]
const ALL_KINDS = ['messages', 'conversations', 'history', 'albumTrash', 'receiptTrash']
const loading = ref(false)
const error = ref('')
const stats = reactive({
  messages: { bytes: 0, count: 0 }, conversations: { bytes: 0, count: 0 },
  history: { bytes: 0, count: 0 },
  albumTrash: { bytes: 0, count: 0 }, receiptTrash: { bytes: 0, count: 0 },
})
const policy = reactive({
  messages: 'forever', conversations: 'forever', history: 'forever',
  albumTrash: 'forever', receiptTrash: 'forever'
})
// 用户选择先落在 draft，点「确定」才提交；「取消」还原成 policy。
const draft = reactive({
  messages: 'forever', conversations: 'forever', history: 'forever',
  albumTrash: 'forever', receiptTrash: 'forever'
})
const dirty = computed(() => ALL_KINDS.some(k => draft[k] !== policy[k]))
const confirm = reactive({ open: false, title: '', message: '', confirmText: '确定', disabled: false, kind: '', mode: '' })
// 删除全部的 5 秒冷静期：与危险区同款「确定键先置灰 + 倒计时」。
// 定时器走 disposables：关弹窗/卸载时真取消，不留孤立的 interval。
const d = useDisposables()
let cancelCountdown = null
function stopCountdown() {
  if (cancelCountdown) { cancelCountdown(); cancelCountdown = null }
}
function startCountdown() {
  stopCountdown()
  let remain = 5
  confirm.disabled = true
  confirm.confirmText = `删除全部(${remain})`
  cancelCountdown = d.interval(() => {
    remain -= 1
    if (remain <= 0) {
      stopCountdown()
      confirm.disabled = false
      confirm.confirmText = '删除全部'
    } else {
      confirm.confirmText = `删除全部(${remain})`
    }
  }, 1000)
}
onBeforeUnmount(() => { stopCountdown(); d.dispose() })

function fmtBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
  return (v / 1024 / 1024).toFixed(2) + ' MB'
}

function close() {
  stopCountdown()
  confirm.open = false
  emit('update:visible', false)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await axios.get('/api/retention')
    if (!data || !data.ok) throw new Error((data && data.error) || '读取失败')
    Object.assign(policy, data.policy)
    Object.assign(draft, data.policy)
    Object.assign(stats, data.stats)
  } catch (e) {
    error.value = e.response?.data?.error || e.message || '读取失败'
  } finally {
    loading.value = false
  }
}

function cancelDraft() {
  Object.assign(draft, policy)
  close()
}

// 点「确定」：先问后端按新档位会不会删掉已有数据，会则先确认。
async function saveDraft() {
  // 没改档位就是普通「确定」：直接关弹窗，不白跑一次预览/保存
  if (!dirty.value) { close(); return }
  try {
    const { data } = await axios.post('/api/retention/preview', { ...draft })
    const willDelete = (data && data.willDelete) || {}
    const n = ALL_KINDS.reduce((sum, k) => sum + (willDelete[k] || 0), 0)
    if (n > 0) {
      confirm.mode = 'apply'
      confirm.title = '提示'
      confirm.message = '有部分数据超过了设置的保留时间，点击确定将会删除，确定吗'
      confirm.confirmText = '确定'
      confirm.disabled = false
      confirm.open = true
      return
    }
    await doSave()
  } catch (e) {
    notify.error('检查失败：' + (e.response?.data?.error || e.message))
  }
}

async function doSave() {
  try {
    const { data } = await axios.put('/api/retention', { ...draft, applyNow: true })
    if (!data || !data.ok) throw new Error((data && data.error) || '保存失败')
    Object.assign(policy, data.policy)
    Object.assign(draft, data.policy)
    if (data.stats) Object.assign(stats, data.stats)
    confirm.open = false
    notify.success('保留期已生效')
    emit('changed')
    close()
  } catch (e) {
    notify.error('保存失败：' + (e.response?.data?.error || e.message))
  }
}

function askDelete(kind, label, isTrash = false) {
  confirm.mode = 'delete'
  confirm.kind = kind
  confirm.title = '删除全部'
  confirm.message = isTrash
    ? `确定清空「${label}」吗？\n文件删除后无法找回，对应的删除记录也不能再撤销还原。`
    : `确定删除「${label}」的全部记录吗？\n此操作不可撤销，删除后无法找回。`
  confirm.confirmText = '删除全部'
  confirm.open = true
  startCountdown()
}

function onConfirm() {
  // 倒计时未结束时按钮本就禁用，这里再挡一层（防绕过 UI 直接触发）
  if (confirm.disabled) return
  stopCountdown()
  confirm.open = false
  if (confirm.mode === 'apply') return doSave()
  if (confirm.mode === 'delete') return doDelete()
}
function onCancelConfirm() {
  stopCountdown()
  confirm.open = false
}

// 删除在途闸门：确认弹窗关闭到请求返回之间还有一帧可点，重复点会发第二次清空请求
// （V10-F02-02）。confirmed 后立刻置位，finally 释放，失败也能重试。
const deleting = ref(false)
async function doDelete() {
  if (deleting.value) return
  deleting.value = true
  try {
    const { data } = await axios.post('/api/retention/clear', { kind: confirm.kind })
    if (!data || !data.ok) throw new Error((data && data.error) || '删除失败')
    Object.assign(stats, data.stats)
    // 回收站两类删的是文件，其余三类删的是记录行（V10-F02-02）。
    const unit = confirm.kind === 'albumTrash' || confirm.kind === 'receiptTrash' ? '个文件' : '条'
    notify.success(`已删除 ${data.deleted} ${unit}`)
    emit('changed')
  } catch (e) {
    notify.error('删除失败：' + (e.response?.data?.error || e.message))
  } finally {
    deleting.value = false
  }
}

watch(() => props.visible, v => { if (v) load() })
</script>
