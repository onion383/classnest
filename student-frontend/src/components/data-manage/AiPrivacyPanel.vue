<template>
  <div class="ai-privacy-panel space-y-5">
    <p class="text-xs text-text-muted leading-relaxed">
      开启后，发给第三方模型的数据里，学生姓名与电话会换成代号；模型写回时系统自动还原成真值，
      你界面上看到的、导出的、库里存的仍然都是真名。
    </p>

    <!-- 总开关 -->
    <div class="flex items-center justify-between gap-4">
      <div class="space-y-1">
        <h4 class="text-sm font-medium text-text">数据保护总开关</h4>
        <p class="text-xs text-text-muted">默认关闭。开启会改变发给模型的内容，需你显式选择。</p>
      </div>
      <AppSwitch :model-value="cfg.enabled" :disabled="busy" @update:model-value="(v) => update('enabled', v)" />
    </div>

    <div v-if="cfg.enabled" class="border-t border-border pt-4 space-y-5">
      <!-- 三个子项 -->
      <div>
        <h4 class="text-sm font-medium text-text mb-2">保护内容</h4>
        <div class="space-y-3">
          <label v-for="it in subItems" :key="it.key" class="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" class="mt-0.5" :checked="cfg[it.key]" :disabled="busy" @change="update(it.key, $event.target.checked)" />
            <span class="text-sm text-text-secondary">
              <span class="text-text font-medium">{{ it.label }}</span> — {{ it.hint }}
            </span>
          </label>
        </div>
      </div>

      <!-- 按表关闭：这些表的自由文本（备注/简介等）不受替换保护，可直接关掉 AI 读取 -->
      <div>
        <h4 class="text-sm font-medium text-text mb-1">按表关闭 AI 读取</h4>
        <p class="text-xs text-text-muted mb-2 leading-relaxed">
          勾选的表将完全禁止 AI 读取（查询时会明确告知「已在设置中关闭」）。适用于备注、简介里写了隐私、但替换规则管不住的表。
        </p>
        <div class="max-h-52 overflow-auto border border-border rounded p-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
          <label v-for="t in tables" :key="t.key" class="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" class="mt-0.5" :checked="cfg.closed_tables.includes(t.key)" :disabled="busy" @change="toggleTable(t.key, $event.target.checked)" />
            <span class="text-xs text-text-secondary leading-tight">
              <span class="font-mono text-text">{{ t.key }}</span>
              <span class="block text-text-muted truncate" :title="t.description">{{ t.description }}</span>
            </span>
          </label>
        </div>
        <p v-if="!tables.length" class="text-xs text-text-muted">可读表清单暂时为空。</p>
      </div>
    </div>

    <!-- 文案三条：把能力边界写清楚，避免用户误以为万无一失 -->
    <div class="bg-bg-secondary rounded p-3 space-y-1.5">
      <p class="text-xs text-text-muted leading-relaxed">• 只保护已入库的值：本轮新贴进来的截图 / 文档里的新名字、新号码原样透传。</p>
      <p class="text-xs text-text-muted leading-relaxed">• 图片和自由文本管不住：识别后的文字里若含隐私，建议直接关掉对应表的 AI 读取。</p>
      <p class="text-xs text-text-muted leading-relaxed">• 关闭某张表后，AI 会失去对该表的数据查询能力（不是返回空结果，而是明确拒绝）。</p>
    </div>

    <p v-if="error" class="text-sm text-danger">{{ error }}</p>
    <p v-if="saved" class="text-sm text-info">已保存，下次对话起生效。</p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import AppSwitch from '../base/AppSwitch.vue'
import { useNotification } from '../../composables/useNotification.js'

const notify = useNotification()
const busy = ref(false)
const error = ref('')
const saved = ref(false)
const cfg = ref({ enabled: false, hide_phone: true, hide_path: true, hide_album: true, closed_tables: [], tables: [] })

const subItems = [
  { key: 'hide_phone', label: '电话', hint: '家长 / 学生联系电话换成令牌。' },
  { key: 'hide_path', label: '本地路径', hint: '抹掉盘符与用户名，只留层级末段。' },
  { key: 'hide_album', label: '相册路径', hint: '相册相关路径同样归一化。' },
]

// 表名与说明由后端 GET /api/ai/privacy 下发，READ_TABLES 是唯一来源，前端不另存一份。
const tables = computed(() => Array.isArray(cfg.value.tables) ? cfg.value.tables : [])

async function load() {
  try {
    const r = await axios.get('/api/ai/privacy')
    if (r.data && r.data.success) cfg.value = { ...cfg.value, ...(r.data.data || {}) }
  } catch (e) { error.value = '读取设置失败：' + (e.response?.data?.error || e.message) }
}

async function update(key, value) {
  busy.value = true
  error.value = ''
  saved.value = false
  try {
    const r = await axios.put('/api/ai/privacy', { [key]: value })
    if (r.data && r.data.success) cfg.value = { ...cfg.value, ...(r.data.data || {}) }
    saved.value = true
  } catch (e) {
    error.value = '保存失败：' + (e.response?.data?.error || e.message)
    notify.error(error.value)
    await load() // 回滚到服务器上的真实状态
  } finally { busy.value = false }
}

function toggleTable(key, checked) {
  const set = new Set(cfg.value.closed_tables || [])
  if (checked) set.add(key); else set.delete(key)
  update('closed_tables', [...set])
}

onMounted(() => { load().catch(() => {}) })
</script>
