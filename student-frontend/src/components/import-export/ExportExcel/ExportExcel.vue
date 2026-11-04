<template>
  <!-- 导出表格组件 -->
  <Teleport to="body">
  <Transition name="dialog">
  <div v-if="effectiveVisible" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10001]">
    <div class="bg-surface p-5 rounded-lg min-w-[400px] max-w-xl shadow-card border border-border dialog-card">
      <h3 class="text-lg font-bold mb-3">{{ title }}</h3>

      <!-- 调用方自定义选项（如相册索引导出的「选择相册 / 索引分组 / 顺序」），插在选列区块之前 -->
      <slot name="extraOptions" />

      <template v-if="!hideFieldPicker">
        <div class="mb-4">
          <p class="font-semibold mb-2">{{ isGroupMode ? '选择导出的小组：' : '选择要导出的列：' }}</p>
          <!-- 普通模式：选列 -->
          <div v-if="!isGroupMode" class="flex flex-wrap gap-2">
            <label v-for="field in fields" :key="field.name" class="flex items-center gap-1 text-sm">
              <input type="checkbox" :value="field.name" v-model="selectedColumns" />
              {{ field.name }}
            </label>
          </div>
          <!-- 分组模式：选小组 -->
          <div v-else class="flex flex-wrap gap-2">
            <label v-for="(g, i) in groupSource.groups" :key="i" class="flex items-center gap-1 text-sm">
              <input type="checkbox" :value="i" v-model="selectedGroups" />
              {{ g.name }} ({{ g.members.length }})
            </label>
          </div>
          <p v-if="!isGroupMode && selectedColumns.length === 0" class="text-danger text-sm mt-1">请至少选择一列</p>
          <p v-else-if="isGroupMode && selectedGroups.length === 0" class="text-danger text-sm mt-1">请至少选择一个小组</p>
        </div>

        <div class="mb-4" v-if="!isGroupMode">
          <p class="font-semibold mb-2">导出行：</p>
          <label class="flex items-center gap-2 mb-1">
            <input type="radio" value="all" v-model="rowMode" /> 全部行
          </label>
          <label class="flex items-center gap-2 mb-1">
            <input type="radio" value="selected" v-model="rowMode" :disabled="selectedCount === 0" /> 仅选中行 ({{ selectedCount }})
          </label>
        </div>
      </template>

      <div class="mb-4">
        <p class="font-semibold mb-2">导出格式：</p>
        <AppSelect v-model="exportFormat" class="w-full" :options="formatOptions" no-scroll />
      </div>

      <div class="mb-4">
        <label class="font-semibold block mb-1">文件名</label>
        <input v-model="filename" class="filename-input border border-border bg-surface text-text p-2 w-full !rounded-[12px]" />
      </div>

      <div class="text-right">
        <button @click="cancel" :disabled="exporting" class="bg-surface-hover text-text border border-border px-4 py-1.5 rounded-lg mr-2 cursor-pointer transition-opacity duration-200 disabled:opacity-60 disabled:cursor-not-allowed">取消</button>
        <button ref="exportBtnRef" @click="doExport" class="export-btn bg-info text-text-inverse border-none px-4 py-1.5 rounded-lg cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed" :style="exportBtnStyle" :disabled="exportDisabled || exporting">
          <span class="export-label">{{ exportBtnLabel }}</span>
        </button>
      </div>
    </div>
  </div>
  </Transition>
  </Teleport>
</template>

<script setup vapor>
import { ref, computed, watch, toRef, onMounted, nextTick } from 'vue'
import AppSelect from '../../base/AppSelect.vue'
import { useNotification } from '../../../composables/useNotification';
import { useExportFormats } from './ExportExcel.exporters.js';
import { localDateStr } from '../../../utils/dateTime.js';
import '../../../styles/dialog-transition.css'

defineOptions({ name: 'ExportExcel' })
const props = defineProps({
  rows: { type: Array, required: true },
  fields: { type: Array, required: true },
  selectedRowKeys: { type: Array, default: () => [] },
  defaultFilename: { type: String, default: '导出数据' },
  tableElement: { type: Object, default: null },
  // 分组导出模式：传入后弹窗改为「选择导出的小组」，数据从该对象取
  groupSource: { type: Object, default: null },
  // 受控模式：传入后显示由外部 isVisible 决定（配合 v-if 可实现懒加载）；不传则用 open() 自管理，向后兼容
  isVisible: { type: Boolean, default: undefined },
  // 弹窗标题，默认沿用通用的「导出选项」
  title: { type: String, default: '导出选项' },
  // 要屏蔽的格式（如相册相册索引导出不能出图片，html2canvas 截长表会崩）：传 ['image']
  excludeFormats: { type: Array, default: () => [] },
  // 隐藏「选择要导出的列 / 导出行」区块：数据不是表格行、列固定时使用（如相册索引）
  hideFieldPicker: Boolean,
  // 外部强制禁用「导出」按钮（如数据还在异步加载，避免导出空表）
  disableExport: Boolean
})
const emit = defineEmits(['export-start', 'export-finish', 'export-error', 'update:isVisible'])

const FORMAT_LABELS = {
  csv: '表格 (.csv)',
  html: 'HTML 表格 (.html)',
  xlsx: 'Excel 表格 (.xlsx)',
  md: 'Markdown 文档 (.md)',
  txt: '纯文本 (.txt)',
  json: 'JSON 数据 (.json)',
  image: 'PNG 图片 (.png)',
  pdf: 'PDF 文档 (.pdf)'
};

// 可选导出格式（顺序即下拉框顺序）；调用方可用 excludeFormats 去掉某个格式
const ALL_FORMATS = [
  { value: 'html', label: 'HTML 表格 (.html)' },
  { value: 'xlsx', label: 'Excel (.xlsx) - 带边框' },
  { value: 'csv', label: 'CSV (.csv) - 无样式' },
  { value: 'md', label: 'Markdown 文档 (.md)' },
  { value: 'txt', label: '纯文本 (.txt)' },
  { value: 'json', label: 'JSON 数据 (.json)' },
  { value: 'image', label: '图片 (.png)' },
  { value: 'pdf', label: 'PDF (.pdf)' }
];

const { success: notifySuccess, error: notifyError, info: notifyInfo } = useNotification()

const visible = ref(false)
const selectedColumns = ref([])
const selectedGroups = ref([])
const rowMode = ref('all')
const exportFormat = ref('html')
const filename = ref('')

const selectedCount = computed(() => props.selectedRowKeys.length);
const isGroupMode = computed(() => !!(props.groupSource && Array.isArray(props.groupSource.groups) && props.groupSource.groups.length));
const isControlled = computed(() => props.isVisible !== undefined);
const effectiveVisible = computed(() => isControlled.value ? props.isVisible : visible.value);
// 按 excludeFormats 过滤后的格式下拉项
const formatOptions = computed(() => {
  const blocked = Array.isArray(props.excludeFormats) ? props.excludeFormats : [];
  const list = ALL_FORMATS.filter(f => !blocked.includes(f.value));
  return list.length ? list : ALL_FORMATS;
});
// 隐藏选列区块时不再要求「至少选一列」，否则按钮会永远置灰
const exportDisabled = computed(() => {
  if (props.disableExport) return true;
  if (props.hideFieldPicker) return false;
  return selectedColumns.value.length === 0;
});

// 导出进行中：按钮置灰并显示进度（各格式在耗时阶段通过 ctx.reportProgress 上报）
const exporting = ref(false)
const exportProgress = ref(0)
function reportProgress(pct) {
  if (!exporting.value) return
  const n = Number(pct)
  if (!Number.isFinite(n)) return
  exportProgress.value = Math.max(0, Math.min(100, Math.round(n)))
}

// 导出按钮：默认保持「导出」的原生宽度；导出时用显式宽度 + CSS transition 双向平滑展开/收起
const exportBtnRef = ref(null)
const exportBtnLabel = computed(() => (exporting.value ? `导出中 ${exportProgress.value}%` : '导出'))
const idleWidth = ref(0)
const busyWidth = ref(0)
const exportBtnStyle = computed(() => {
  if (!idleWidth.value || !busyWidth.value) return {}
  return {
    width: `${exporting.value ? busyWidth.value : idleWidth.value}px`,
    // 内联 transition：避免被主题的全局 button 过渡规则覆盖
    transition: 'width 0.22s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.2s ease, background-color 0.2s ease, color 0.2s ease'
  }
})
// 用 canvas 按按钮实际字体量两段文案宽度，不依赖隐藏节点是否参与布局
let measureCanvas = null
function measureExportWidths() {
  const el = exportBtnRef.value
  if (!el) return
  const cs = getComputedStyle(el)
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
  if (!measureCanvas) measureCanvas = document.createElement('canvas')
  const c2d = measureCanvas.getContext('2d')
  if (!c2d) return
  c2d.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  idleWidth.value = Math.ceil(c2d.measureText('导出').width + pad) + 2
  busyWidth.value = Math.ceil(c2d.measureText('导出中 100%').width + pad) + 2
}
onMounted(() => { nextTick(measureExportWidths) })
// 弹窗从隐藏变可见时重新量一次（懒加载/主题切换后字体度量可能变化）
watch(effectiveVisible, (v) => { if (v) nextTick(measureExportWidths) })

// 跨模块共享的上下文：状态为 ref（模块内 .value 访问），通知函数与方法直接挂上；
// useExportFormats 的返回方法与本组件方法在下方 Object.assign 回填
const ctx = {
  visible, selectedColumns, selectedGroups, rowMode, exportFormat, filename,
  selectedCount, isGroupMode, isControlled, effectiveVisible, formatOptions, exportDisabled,
  rows: toRef(props, 'rows'),
  fields: toRef(props, 'fields'),
  selectedRowKeys: toRef(props, 'selectedRowKeys'),
  groupSource: toRef(props, 'groupSource'),
  excludeFormats: toRef(props, 'excludeFormats'),
  hideFieldPicker: toRef(props, 'hideFieldPicker'),
  tableElement: toRef(props, 'tableElement'),
  isVisible: toRef(props, 'isVisible'),
  title: toRef(props, 'title'),
  defaultFilename: toRef(props, 'defaultFilename'),
  disableExport: toRef(props, 'disableExport'),
  notifySuccess, notifyError, notifyInfo,
  emit,
  exporting,
  reportProgress,
}
const fmt = useExportFormats(ctx)

function open() {
  if (isControlled.value) emit('update:isVisible', true);
  else visible.value = true;
  emit('export-start');
}
function close() {
  if (isControlled.value) emit('update:isVisible', false);
  else visible.value = false;
}
function cancel() { close(); }
async function doExport() {
  if (exporting.value) return
  // ---------- 分组导出模式 ----------
  if (isGroupMode.value) {
    if (selectedGroups.value.length === 0) { notifyInfo('请至少选择一个小组'); return; }
    const dateStr = localDateStr();
    const finalFilename = `${filename.value}_${dateStr}`;
    exportProgress.value = 10
    exporting.value = true
    try {
      let saved = true;
      switch (exportFormat.value) {
        case 'csv': saved = await ctx.exportGroupCSV(selectedGroups.value, finalFilename); break;
        case 'html': saved = await ctx.exportGroupHTML(selectedGroups.value, finalFilename); break;
        case 'md': saved = await ctx.exportGroupMD(selectedGroups.value, finalFilename); break;
        case 'txt': saved = await ctx.exportGroupTXT(selectedGroups.value, finalFilename); break;
        case 'json': saved = await ctx.exportGroupJSON(selectedGroups.value, finalFilename); break;
        case 'image': saved = await ctx.exportGroupImage(selectedGroups.value, finalFilename); break;
        case 'pdf': saved = await ctx.exportGroupPDF(selectedGroups.value, finalFilename); break;
        case 'xlsx': saved = await ctx.exportGroupXLSX(selectedGroups.value, finalFilename); break;
        default: saved = await ctx.exportGroupHTML(selectedGroups.value, finalFilename);
      }
      if (saved) {
        reportProgress(100)
        notifySuccess(`已成功导出 ${FORMAT_LABELS[exportFormat.value] || '文件'}`)
        emit('export-finish');
        close();
      }
      // saved 为空串：用户在系统保存对话框中点了取消（或保存失败），保留弹窗便于重新导出
  } catch (err) {
    console.error('导出失败:', err);
    // 把具体原因带出来（写盘失败/权限不足等）：笼统的「请重试」对用户没有帮助
    notifyError(err && err.message ? '导出失败：' + err.message : '导出失败，请重试')
    emit('export-error', err);
  } finally {
    exporting.value = false
    exportProgress.value = 0
  }
  return;
}

  // ---------- 普通表格导出 ----------
  // 隐藏选列区块时视为「全列 / 全部行」，不再做列与行的筛选
  if (!props.hideFieldPicker && selectedColumns.value.length === 0) return;
  let exportRows = [...props.rows];
  if (!props.hideFieldPicker && rowMode.value === 'selected') {
    exportRows = exportRows.filter(r => props.selectedRowKeys.includes(r.id) || props.selectedRowKeys.includes(r._rowKey));
  }
  if (!exportRows.length) { notifyInfo('没有数据可以导出'); close(); return; }

  const selectedFields = props.hideFieldPicker
    ? props.fields
    : props.fields.filter(f => selectedColumns.value.includes(f.name));
  const dateStr = localDateStr();
  const finalFilename = `${filename.value}_${dateStr}`;

  exportProgress.value = 10
  exporting.value = true
  try {
    let saved = true
    switch (exportFormat.value) {
      case 'csv': saved = await ctx.exportCSV(exportRows, selectedFields, finalFilename); break;
      case 'html': saved = await ctx.exportHTMLTable(exportRows, selectedFields, finalFilename); break;
      case 'xlsx': saved = await ctx.exportXLSX(exportRows, selectedFields, finalFilename); break;
      case 'md': saved = await ctx.exportMD(exportRows, selectedFields, finalFilename); break;
      case 'txt': saved = await ctx.exportTXT(exportRows, selectedFields, finalFilename); break;
      case 'json': saved = await ctx.exportJSON(exportRows, selectedFields, finalFilename); break;
      case 'image': saved = await ctx.exportImage(exportRows, selectedFields, finalFilename); break;
      case 'pdf': saved = await ctx.exportPDF(exportRows, selectedFields, finalFilename); break;
      default: saved = await ctx.exportHTMLTable(exportRows, selectedFields, finalFilename);
    }
    if (saved) {
      reportProgress(100)
      const label = FORMAT_LABELS[exportFormat.value] || '文件'
      notifySuccess(`已成功导出 ${label}`)
      emit('export-finish');
      close();
    }
    // saved 为空串：用户在系统保存对话框中点了取消（或保存失败），保留弹窗便于重新导出
  } catch (err) {
    console.error('导出失败:', err);
    // 把具体原因带出来（写盘失败/权限不足等）：笼统的「请重试」对用户没有帮助
    notifyError(err && err.message ? '导出失败：' + err.message : '导出失败，请重试')
    emit('export-error', err);
  } finally {
    exporting.value = false
    exportProgress.value = 0
  }
}

Object.assign(ctx, fmt, { open, close, cancel, doExport })

// immediate：挂载时（含 v-if 懒加载后首次可见）即初始化默认全选，
// 否则首次打开弹窗时 selectedColumns 为空，需开关一次才补全
watch(effectiveVisible, (val) => {
  if (val) {
    selectedColumns.value = props.fields.map(f => f.name);
    selectedGroups.value = props.groupSource ? props.groupSource.groups.map((_, i) => i) : [];
    rowMode.value = 'all';
    // 默认 HTML，被 excludeFormats 屏蔽时退回第一个可用格式（如相册索引默认 Excel）
    const values = formatOptions.value.map(f => f.value);
    exportFormat.value = values.includes('html') ? 'html' : (values[0] || 'html');
    filename.value = props.defaultFilename;
  }
}, { immediate: true })

// 与原 Options 全量暴露等价的常用入口（受控模式之外，父级可 ref 调用）
defineExpose({ open, close })
</script>

<style scoped>
/* 文件名输入框：聚焦时显示与登录框一致的蓝色边缘，白色高亮带过渡 */
.filename-input {
  transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}
/* 导出按钮：宽度在「导出」与「导出中 100%」两个实测值之间双向过渡（transition 由内联样式给出） */
.export-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
}
.export-label { display: inline-block; }
.filename-input:focus {
  border-color: #3b82f6 !important;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.28) !important;
  outline: none;
  background-color: rgba(255, 255, 255, 0.98) !important;
}
</style>