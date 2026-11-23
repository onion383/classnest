<template>
  <div class="roll-call">
    <div class="header">
      <IconGlyph name="rollcall" :size="16" />
      <span>点名器</span>
      <!-- 让「排除不在校」的效果肉眼可见：设置开启且确实排除了人时才显示 -->
      <span v-if="excludedCount" class="excluded-hint">已排除 {{ excludedCount }} 位不在校</span>
    </div>
    <div class="content">
      <div v-if="error" class="error-area">
        <div class="error-msg">{{ error }}</div>
        <button class="btn-primary" @click="$emit('close')">关闭</button>
      </div>
      <template v-else>
        <div v-if="loading" class="hint">{{ hintText }}</div>
        <div v-else class="result-card">
          <div class="avatar"><IconGlyph name="user" :size="32" /></div>
          <div class="info">
            <div class="row">
              <span class="label">学号：</span>
              <span class="value" :class="{ rolling: isRolling }">{{ truncateStart(currentStudent.学号, 6) }}</span>
            </div>
            <div class="row">
              <span class="label">姓名：</span>
              <span class="value" :class="{ rolling: isRolling }">{{ truncateStart(currentStudent.姓名, 4) }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>
    <div class="actions">
      <button class="btn-primary" :disabled="isRolling || loading" @click="confirm">完成</button>
    </div>
  </div>
</template>

<script setup vapor>
import { getToken } from '../../utils/authStorage.js'
import { filterPresentStudents } from '../../utils/leaveState.js'
import { ref, onMounted, onUnmounted } from 'vue'
import { useDisposables } from '../../utils/disposables.js'
import axios from 'axios'
import IconGlyph from '../../components/base/IconGlyph.vue'

const emit = defineEmits(['close'])

function truncateStart(str, maxLen) {
  const s = String(str || '')
  if (s.length <= maxLen) return s
  return '...' + s.slice(-maxLen)
}

const students = ref([])
const isRolling = ref(false)
const error = ref('')
const loading = ref(true)
const hintText = ref('准备中...')
const currentStudent = ref({ 学号: '----', 姓名: '----' })
// 本次点名被排除的不在校人数（开关关闭时恒为 0）
const excludedCount = ref(0)
// 滚动定时器与「3 秒后自动关闭」都用 disposables：卸载时不用再逐个 if 判断
const d = useDisposables()
const scheduleAutoClose = d.defer()
let cancelRoll = null
// 组件可能在拉名单途中被关闭（点名器随工具面板一起卸载）
let disposed = false

async function fetchStudents() {
  const token = getToken()
  if (!token) throw new Error('未登录，请先登录主应用')

  // 开关取设置页的持久值。读不到就明确报错，不能静默退回「全员点名」——
  // 那样用户以为开关生效了，结果还是可能点到请假的同学。
  let settings
  try {
    settings = await axios.get('/api/widget-settings')
  } catch (_) {
    throw new Error('无法读取工具箱设置，本次点名已取消')
  }
  // 默认只点正式学生（formal=1）；只有设置里显式开了「点名包含临时学生」才取全量。
  // 开关读不到时按默认（过滤）处理，不静默把临时学生放进来。
  const includeProvisional = !!settings?.data?.data?.rollcallIncludeProvisional
  const res = await axios.get(includeProvisional ? '/api/students' : '/api/students?formal=1')
  const all = res.data.data || []
  if (!settings?.data?.data?.rollcallExcludeAbsent) return { list: all, excludedCount: 0 }

  let leaves
  try {
    leaves = await axios.get('/api/leaves')
  } catch (_) {
    // 拿不到请假记录时宁可不点，也不能拿全班名单冒充「已排除不在校」
    throw new Error('无法获取请假记录，为避免点到不在校的同学，本次点名已取消')
  }
  return filterPresentStudents(all, leaves.data.data || [])
}

function pickRandomStudent() {
  const idx = Math.floor(Math.random() * students.value.length)
  return students.value[idx]
}

function stopRoll() {
  if (cancelRoll) { cancelRoll(); cancelRoll = null }
}

async function startRoll() {
  // 加载数据
  if (students.value.length === 0) {
    hintText.value = '加载中...'
    try {
      const result = await fetchStudents()
      if (disposed) return
      students.value = result.list
      excludedCount.value = result.excludedCount
    } catch (err) {
      if (disposed) return
      error.value = err.response?.data?.error || err.message || '获取名单失败'
      loading.value = false
      return
    }
    if (students.value.length === 0) {
      error.value = excludedCount.value > 0 ? '今天没有在校的同学可点名' : '暂无学生数据'
      loading.value = false
      return
    }
  }

  loading.value = false
  isRolling.value = true
  let count = 0

  // 开始滚动，学号姓名一起变
  cancelRoll = d.interval(() => {
    currentStudent.value = pickRandomStudent()
    count++
    if (count >= 25) {
      stopRoll()
      const finalStudent = pickRandomStudent()
      currentStudent.value = finalStudent
      isRolling.value = false
      // 3秒后自动关闭回到图标
      scheduleAutoClose(() => {
        emit('close')
      }, 3000)
    }
  }, 80)
}

function confirm() {
  scheduleAutoClose.cancel()
  emit('close')
}

// 组件一显示就直接开始，不需要任何按钮
onMounted(startRoll)

onUnmounted(() => {
  disposed = true
  stopRoll()
  scheduleAutoClose.cancel()
})
</script>

<style scoped>
.roll-call {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  overflow: hidden;
}

.header {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text, #111827);
  margin-bottom: 10px;
}

.excluded-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--color-text-muted, #9ca3af);
  white-space: nowrap;
}

.content {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 10px;
  width: 100%;
}

.result-card {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--color-bg, #f9fafb);
  border-radius: var(--radius-card);
  padding: 12px 10px;
  border: 1px solid var(--color-border, #e5e7eb);
  height: 72px;
  box-sizing: border-box;
}

.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  flex-shrink: 0;
}

.info {
  text-align: left;
  height: 44px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.row {
  font-size: 13px;
  color: var(--color-text, #111827);
  line-height: 1.5;
  display: flex;
  align-items: center;
  height: 22px;
}

.label {
  color: var(--color-text-secondary, #6b7280);
  width: 44px;
  text-align: justify;
  text-align-last: justify;
  flex-shrink: 0;
}

.value {
  font-size: 16px;
  font-weight: 600;
  display: inline-block;
  width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.value.rolling {
  color: var(--color-primary, #22c55e);
}

.hint {
  font-size: 13px;
  color: var(--color-text-muted, #9ca3af);
}

.error-area {
  text-align: center;
}

.error-msg {
  font-size: 13px;
  color: var(--color-danger, #ef4444);
  margin-bottom: 12px;
}

.actions {
  display: flex;
  justify-content: center;
}

.btn-primary {
  padding: 6px 20px;
  border-radius: var(--radius-control);
  border: none;
  background: var(--color-primary, #22c55e);
  color: white;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.btn-primary:disabled {
  background: var(--color-text-muted, #9ca3af);
  cursor: not-allowed;
  opacity: 0.7;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}
</style>
