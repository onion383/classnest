<template>
  <!-- 临时学生：值日 / 座位 / 分组 / 加分里直接填名字时自动建的档，由学生管理工具栏独立入口进来统一转正 -->
  <DialogShell :visible="visible" :z-index="10001" @overlay="close">
        <div class="bg-surface rounded-lg border border-border shadow-card dialog-card flex flex-col p-5 relative ps-card">
          <div class="flex items-center justify-between mb-2 flex-shrink-0">
            <h3 class="text-lg font-bold flex items-center gap-1.5">
              临时学生
              <!-- 口径说明收进 ⓘ：转正只改状态位、不搬数据，属于「想知道再看」的信息，不占弹窗常驻空间 -->
              <AppHelp
                :text="helpText"
                aria-label="临时学生说明"
                :z-index="10002"
              />
            </h3>
            <button class="dlg-close" title="关闭" @click="close">✕</button>
          </div>

          <div v-if="loading" class="text-sm text-text-muted py-8 text-center">正在加载…</div>

          <div v-else-if="loadError" class="text-sm py-6 text-center">
            <span class="text-danger">加载失败</span>
            <button class="ps-btn ml-2" @click="load">重试</button>
          </div>

          <EmptySnapshot
            v-else-if="!rows.length"
            icon="students"
            icon-size="32"
            text="暂无"
            min-height="180px"
            bare
          />

          <template v-else>
            <div class="flex items-center justify-between px-1 pb-2 flex-shrink-0">
              <label class="flex items-center gap-2 cursor-pointer text-sm text-text-secondary">
                <input type="checkbox" :checked="allChecked" @change="onToggleAll($event.target.checked)" />
                全选
              </label>
              <span class="text-xs text-text-muted">共 {{ rows.length }} 人 · 已选 {{ selectedIds.length }}</span>
            </div>

            <div class="flex-1 min-h-0 overflow-y-auto app-custom-scroll border border-border rounded-lg ps-list">
              <label
                v-for="s in rows"
                :key="s.id"
                class="flex items-start gap-2.5 px-3 py-2 border-b border-border last:border-b-0 hover:bg-surface-hover cursor-pointer transition-theme"
              >
                <input
                  type="checkbox"
                  class="mt-0.5"
                  :checked="selectedIds.includes(s.id)"
                  @change="onToggle(s.id, $event.target.checked)"
                />
                <span class="min-w-0">
                  <span class="text-sm text-text">{{ s['姓名'] }}</span>
                  <span v-if="s['学号']" class="text-xs text-text-muted ml-2">学号 {{ s['学号'] }}</span>
                  <span class="block text-xs text-text-muted">{{ relText(s.relations) }}</span>
                </span>
              </label>
            </div>
          </template>

          <div class="flex items-center justify-end gap-2 mt-4 flex-shrink-0">
            <button class="ps-btn" @click="close">取消</button>
            <button class="ps-btn primary" :disabled="!selectedIds.length || converting" @click="confirmOpen = true">
              {{ converting ? '正在转换…' : (selectedIds.length ? `转为正式学生 (${selectedIds.length})` : '转为正式学生') }}
            </button>
          </div>
        </div>
  </DialogShell>

    <!-- 批量转正确认：状态翻转后需要再编辑才能回退，先问一句（F02-08） -->
    <ConfirmDialog
      :visible="confirmOpen"
      :z-index="10010"
      title="转为正式学生"
      :message="`确定把选中的 ${selectedIds.length} 名临时学生转为正式学生吗？`"
      confirm-text="确定转正"
      cancel-text="取消"
      :show-cancel="true"
      @confirm="convert"
      @cancel="confirmOpen = false"
    />
</template>

<script setup vapor>
// 转正只改 students.is_provisional，id 与所有引用都不动（后端 /provisional/convert 就是这么实现的）。
// 列表里的 relations 与「删除学生」用的是同一个统计口径（services/studentRelations），
// 让老师在转正前看清这个人还挂在哪些表里。
import { ref, computed, watch } from 'vue'
import axios from 'axios'
import { useNotification } from '../../composables/useNotification'
import AppHelp from '../base/AppHelp.vue'
import DialogShell from '../base/DialogShell.vue'
import EmptySnapshot from '../base/EmptySnapshot.vue'
import ConfirmDialog from '../base/ConfirmDialog.vue'
import '../../styles/dialog-transition.css'

defineOptions({ name: 'ProvisionalStudentsDialog' })

// ⓘ 气泡内容：口径说明（转正只改状态位、不搬数据，资料要自己补）。\n 在气泡里换行。
const helpText = [
  '这些名字是在值日、座位、分组或加分里直接填写、名册中没有的姓名，系统自动建的档。',
  '转为正式学生只改成员状态，所有引用（值日 / 座位 / 分组 / 加减分）保持不变；学号等资料需要你补全。',
  '若名册里已经有同名的人，转正后会变成两条同名记录。',
].join('\n')

const props = defineProps({
  visible: { type: Boolean, default: false },
})
const emit = defineEmits(['update:visible', 'converted'])
const { success: notifySuccess, error: notifyError } = useNotification()

const rows = ref([])
const selectedIds = ref([])
const loading = ref(false)
const loadError = ref(false)
const converting = ref(false)
// 批量转正确认框是否打开（F02-08）
const confirmOpen = ref(false)

watch(() => props.visible, (v) => {
  if (v) { load() } else { selectedIds.value = [] }
}, { immediate: true })

const allChecked = computed(() => rows.value.length > 0 && selectedIds.value.length === rows.value.length)

function close() { emit('update:visible', false) }
function errMsg(err) {
  return (err && err.response && err.response.data && err.response.data.error) || (err && err.message) || '操作失败'
}

async function load() {
  loading.value = true
  loadError.value = false
  selectedIds.value = []
  try {
    const { data } = await axios.get('/api/students/provisional')
    rows.value = data.data || []
  } catch (_) {
    rows.value = []
    loadError.value = true
  } finally {
    loading.value = false
  }
}

function onToggle(id, checked) {
  const rest = selectedIds.value.filter((x) => x !== id)
  selectedIds.value = checked ? [...rest, id] : rest
}
function onToggleAll(checked) {
  selectedIds.value = checked ? rows.value.map((s) => s.id) : []
}

// 与删除学生确认框同一套措辞，避免同一个数字在两处说法不一样
function relText(rel) {
  if (!rel || !rel.total) return '暂未被引用'
  const parts = []
  if (rel.leave) parts.push(`${rel.leave} 条请假`)
  if (rel.score) parts.push(`${rel.score} 条加减分`)
  if (rel.seat) parts.push(`${rel.seat} 个座位`)
  if (rel.duty) parts.push(`${rel.duty} 个值日岗位`)
  if (rel.group) parts.push(`${rel.group} 处小组成员`)
  if (rel.cadre) parts.push(`${rel.cadre} 个班干部职务`)
  return '已被引用：' + parts.join('、')
}

async function convert() {
  confirmOpen.value = false
  if (!selectedIds.value.length || converting.value) return
  converting.value = true
  try {
    const { data } = await axios.post('/api/students/provisional/convert', { ids: selectedIds.value })
    notifySuccess(data.message || '已转换')
    emit('converted')
    close()
  } catch (err) {
    notifyError(errMsg(err))
  } finally {
    converting.value = false
  }
}
</script>

<style scoped>
.ps-card {
  width: 580px;
  max-width: 92vw;
  max-height: 84vh;
}
/* 列表滚动区：人多时在弹窗内滚动，不把整卡撑高 */
.ps-list {
  max-height: 46vh;
}
/* 行内按钮：与数据管理弹窗的 .row-btn 同一观感（那边是 scoped，跨组件拿不到，这里复刻一份） */
.ps-btn {
  font-size: 13px;
  line-height: 1;
  padding: 7px 13px;
  border-radius: var(--radius-control);
  border: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
  color: var(--color-text);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.ps-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-text) 12%, transparent);
}
.ps-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ps-btn.primary {
  background: var(--color-primary);
  border-color: transparent;
  color: var(--color-text-inverse);
}
.ps-btn.primary:hover:not(:disabled) {
  background: var(--color-primary-hover, var(--color-primary));
}
</style>
