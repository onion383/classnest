<template>
  <DialogShell :visible="visible" :z-index="10001" overlay-class="bg-black/50">
    <div class="bg-surface p-6 rounded-lg w-[750px] max-h-[85vh] flex flex-col shadow-card dialog-card relative">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold flex items-center gap-2"><IconGlyph name="timer" :size="18" /> 作息时间设置</h3>
        <button
          @click="importVisible = true"
          class="bg-warning text-text-inverse px-3 py-1.5 rounded text-sm flex items-center gap-1.5"
          title="从 Excel 批量导入节次与时间"
        >
          <IconGlyph name="download" :size="14" tint="current" /> 从 Excel 表格批量导入
        </button>
      </div>

      <!-- 学期开始日期 -->
      <div v-if="showSemesterStart" class="mb-4">
        <span class="font-semibold">学期开始日期</span>
        <input
          type="date"
          :value="semesterStart"
          @input="$emit('update:semesterStart', $event.target.value)"
          class="border p-1 rounded text-sm mt-1 w-full"
        />
      </div>

      <!-- 一周天数 -->
      <div class="mb-4">
        <span class="font-semibold">一周天数</span>
        <div class="flex items-center gap-2 mt-1">
          <AppSelect v-model="startDay" :options="dayOptions" class="w-24" />
          <span class="text-sm">到</span>
          <AppSelect v-model="endDay" :options="dayOptions" class="w-24" />
        </div>
      </div>

      <!-- 各时段 -->
      <div ref="bodyRef" class="flex-1 overflow-y-auto space-y-4 mb-4 app-custom-scroll">
        <!-- 上午 -->
        <div class="border border-border rounded-xl p-3 bg-surface-hover">
          <div class="flex items-center justify-between mb-2">
            <h4 class="font-semibold">上午</h4>
            <button @click="addItem('morning')" class="bg-primary text-text-inverse px-2 py-1 rounded text-sm">＋ 新加上午时间段</button>
          </div>
          <div v-for="(item, idx) in sections.morning" :key="idx" class="flex items-center gap-2 mb-1">
            <AppSelect v-model="item.type" :options="[{ value: 'lesson', label: '学习' }, { value: 'rest', label: '休息' }]" class="w-24" />
            <input v-model="item.name" placeholder="名称" class="border p-1 text-sm rounded w-24" />
            <input type="time" v-model="item.start" class="border p-1 text-sm rounded w-20" />
            <span class="text-sm">到</span>
            <input type="time" v-model="item.end" class="border p-1 text-sm rounded w-20" />
            <button @click="removeItem('morning', idx)" class="text-danger text-sm">删除</button>
          </div>
        </div>

        <!-- 中午 -->
        <div class="border border-border rounded-xl p-3 bg-surface-hover">
          <div class="flex items-center justify-between mb-2">
            <h4 class="font-semibold">中午</h4>
            <button @click="addItem('noon')" class="bg-primary text-text-inverse px-2 py-1 rounded text-sm">＋ 新加中午时间段</button>
          </div>
          <div v-for="(item, idx) in sections.noon" :key="idx" class="flex items-center gap-2 mb-1">
            <AppSelect v-model="item.type" :options="[{ value: 'lesson', label: '学习' }, { value: 'rest', label: '休息' }]" class="w-24" />
            <input v-model="item.name" placeholder="名称" class="border p-1 text-sm rounded w-24" />
            <input type="time" v-model="item.start" class="border p-1 text-sm rounded w-20" />
            <span class="text-sm">到</span>
            <input type="time" v-model="item.end" class="border p-1 text-sm rounded w-20" />
            <button @click="removeItem('noon', idx)" class="text-danger text-sm">删除</button>
          </div>
        </div>

        <!-- 下午 -->
        <div class="border border-border rounded-xl p-3 bg-surface-hover">
          <div class="flex items-center justify-between mb-2">
            <h4 class="font-semibold">下午</h4>
            <button @click="addItem('afternoon')" class="bg-primary text-text-inverse px-2 py-1 rounded text-sm">＋ 新加下午时间段</button>
          </div>
          <div v-for="(item, idx) in sections.afternoon" :key="idx" class="flex items-center gap-2 mb-1">
            <AppSelect v-model="item.type" :options="[{ value: 'lesson', label: '学习' }, { value: 'rest', label: '休息' }]" class="w-24" />
            <input v-model="item.name" placeholder="名称" class="border p-1 text-sm rounded w-24" />
            <input type="time" v-model="item.start" class="border p-1 text-sm rounded w-20" />
            <span class="text-sm">到</span>
            <input type="time" v-model="item.end" class="border p-1 text-sm rounded w-20" />
            <button @click="removeItem('afternoon', idx)" class="text-danger text-sm">删除</button>
          </div>
        </div>

        <!-- 傍晚 -->
        <div class="border border-border rounded-xl p-3 bg-surface-hover">
          <div class="flex items-center justify-between mb-2">
            <h4 class="font-semibold">傍晚</h4>
            <button @click="addItem('evening')" class="bg-primary text-text-inverse px-2 py-1 rounded text-sm">＋ 新加傍晚时间段</button>
          </div>
          <div v-for="(item, idx) in sections.evening" :key="idx" class="flex items-center gap-2 mb-1">
            <AppSelect v-model="item.type" :options="[{ value: 'lesson', label: '学习' }, { value: 'rest', label: '休息' }]" class="w-24" />
            <input v-model="item.name" placeholder="名称" class="border p-1 text-sm rounded w-24" />
            <input type="time" v-model="item.start" class="border p-1 text-sm rounded w-20" />
            <span class="text-sm">到</span>
            <input type="time" v-model="item.end" class="border p-1 text-sm rounded w-20" />
            <button @click="removeItem('evening', idx)" class="text-danger text-sm">删除</button>
          </div>
        </div>

        <!-- 晚上 -->
        <div class="border border-border rounded-xl p-3 bg-surface-hover">
          <div class="flex items-center justify-between mb-2">
            <h4 class="font-semibold">晚上</h4>
            <button @click="addItem('night')" class="bg-primary text-text-inverse px-2 py-1 rounded text-sm">＋ 新加晚上时间段</button>
          </div>
          <div v-for="(item, idx) in sections.night" :key="idx" class="flex items-center gap-2 mb-1">
            <AppSelect v-model="item.type" :options="[{ value: 'lesson', label: '学习' }, { value: 'rest', label: '休息' }]" class="w-24" />
            <input v-model="item.name" placeholder="名称" class="border p-1 text-sm rounded w-24" />
            <input type="time" v-model="item.start" class="border p-1 text-sm rounded w-20" />
            <span class="text-sm">到</span>
            <input type="time" v-model="item.end" class="border p-1 text-sm rounded w-20" />
            <button @click="removeItem('night', idx)" class="text-danger text-sm">删除</button>
          </div>
        </div>
      </div>
      <CustomScrollbar :target="bodyRef" />

      <div class="text-right">
        <button @click="$emit('cancel')" class="bg-surface-hover px-4 py-2 rounded mr-2 text-text">取消</button>
        <button @click="save" class="bg-info text-text-inverse px-4 py-2 rounded">保存设置</button>
      </div>

      <!-- 从 Excel 导入作息：只填充当前弹窗表单，仍需点「保存设置」才落库 -->
      <ImportExcel
        v-if="importMounted"
        :visible="importVisible"
        :existingFields="importFields"
        :requiredFields="['时段', '名称', '开始时间', '结束时间']"
        :templateName="'作息时间标准导入表'"
        @import-data="onImportData"
        @cancel="importVisible = false"
      />
    </div>
  </DialogShell>
</template>

<script setup vapor>
import '../../styles/dialog-transition.css'
import DialogShell from '../base/DialogShell.vue'
import AppSelect from '../base/AppSelect.vue'
import CustomScrollbar from '../base/CustomScrollbar.vue'
import IconGlyph from '../base/IconGlyph.vue'
import { useNotification } from '../../composables/useNotification.js'
import { ref, watch, defineAsyncComponent } from 'vue'

// Excel 导入：弹窗提前加载一次，导入组件本身仍按需懒加载
const loadImportExcel = () => import('../import-export/ImportExcel.vue')
const ImportExcel = defineAsyncComponent(loadImportExcel)

defineOptions({ name: 'SettingsDialog' })

const props = defineProps({
  visible: Boolean,
  settings: { type: Object, default: () => ({}) },
  semesterStart: { type: String, default: '' } ,
  showSemesterStart: { type: Boolean, default: true }   // 补上这一行  // 新增
})
const emit = defineEmits(['save', 'cancel', 'update:semesterStart'])  // 新增

// 弹窗正文滚动容器（自定义滚动条的目标）
const bodyRef = ref(null)

const startDay = ref(1);
const endDay = ref(5);
const sections = ref({
  morning: [],
  noon: [],
  afternoon: [],
  evening: [],
  night: []
});
const dayOptions = ref([
  { label: '周一', value: 1 },
  { label: '周二', value: 2 },
  { label: '周三', value: 3 },
  { label: '周四', value: 4 },
  { label: '周五', value: 5 },
  { label: '周六', value: 6 },
  { label: '周日', value: 7 }
]);

watch(() => props.settings, (val) => {
  if (val.sections) {
    sections.value = {
      morning: val.sections.morning?.map(i => ({...i})) || [],
      noon: val.sections.noon?.map(i => ({...i})) || [],
      afternoon: val.sections.afternoon?.map(i => ({...i})) || [],
      evening: val.sections.evening?.map(i => ({...i})) || [],
      night: val.sections.night?.map(i => ({...i})) || []
    };
  } else {
    // 没有作息设置时保持空表，不再自动填入默认节次时间
    sections.value = { morning: [], noon: [], afternoon: [], evening: [], night: [] };
  }
  if (val.days) {
    const dayMap = { '周一':1,'周二':2,'周三':3,'周四':4,'周五':5,'周六':6,'周日':7 };
    startDay.value = dayMap[val.days[0]] || 1;
    endDay.value = dayMap[val.days[val.days.length-1]] || 5;
  }
}, {
  deep: true,
  immediate: true
});

function addItem(section) {
  sections.value[section].push({ name: '', start: '08:00', end: '08:45', type: 'lesson' });
}
function removeItem(section, idx) {
  sections.value[section].splice(idx, 1);
}

// ==================== 从 Excel 导入作息 ====================
const importVisible = ref(false)
const importMounted = ref(false)
watch(importVisible, (v) => { if (v) importMounted.value = true })
const importFields = [
  { name: '时段' },
  { name: '类型' },
  { name: '名称' },
  { name: '开始时间' },
  { name: '结束时间' }
]
// 时段 → sections 的内部键；导入表里的「时段」列用中文名
const SECTION_MAP = { '上午': 'morning', '中午': 'noon', '下午': 'afternoon', '傍晚': 'evening', '晚上': 'night' }
const SECTIONS = ['morning', 'noon', 'afternoon', 'evening', 'night']
function normTime(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})/)
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''
}
function onImportData({ fields, rows }) {
  importVisible.value = false
  const objects = rows.map(row => {
    const obj = {}
    fields.forEach((name, i) => { obj[name] = String(row[i] ?? '').trim() })
    return obj
  })
  const errors = []
  const next = { morning: [], noon: [], afternoon: [], evening: [], night: [] }
  objects.forEach((obj, idx) => {
    const rowNo = idx + 1
    const sec = SECTION_MAP[obj['时段']]
    if (!sec) { errors.push(`第 ${rowNo} 行：时段「${obj['时段'] || '空'}」无效（应为 上午/中午/下午/傍晚/晚上）`); return }
    if (!obj['名称']) { errors.push(`第 ${rowNo} 行缺少「名称」`); return }
    const start = normTime(obj['开始时间'])
    const end = normTime(obj['结束时间'])
    if (!start || !end) { errors.push(`第 ${rowNo} 行：「开始时间」和「结束时间」需为 HH:mm 格式`); return }
    const typeText = (obj['类型'] || '学习').toLowerCase()
    const type = typeText === '休息' || typeText === 'rest' ? 'rest' : 'lesson'
    next[sec].push({ type, name: obj['名称'], start, end })
  })
  if (errors.length) {
    useNotification().error(errors[0] + (errors.length > 1 ? `（共 ${errors.length} 处问题）` : ''))
    return
  }
  if (!objects.length) return useNotification().info('没有可导入的作息数据')
  for (const key of SECTIONS) {
    if (!Array.isArray(next[key])) next[key] = []
  }
  sections.value = next
  useNotification().success('已导入作息时间，请确认后点「保存设置」')
}
function save() {
  // 开始日晚于结束日会生成空 days 数组，后端保存后课表直接没有可用星期
  if (startDay.value > endDay.value) {
    useNotification().error('开始日不能晚于结束日')
    return
  }
  const dayNames = ['周一','周二','周三','周四','周五','周六','周日'];
  const days = [];
  for (let i = startDay.value; i <= endDay.value; i++) days.push(dayNames[i-1]);

  const sectionsData = JSON.parse(JSON.stringify(sections.value));
  const periods = [];
  ['morning','noon','afternoon','evening','night'].forEach(key => {
    sectionsData[key].forEach(item => {
      periods.push({ name: item.name, start: item.start, end: item.end, type: item.type });
    });
  });

  emit('save', { sections: sectionsData, periods, days });
}

</script>