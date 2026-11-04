<template>
  <div>
    <div class="w-full bg-surface shadow-md rounded-xl mb-6 px-5 py-3 border border-border min-h-[4.5rem] flex items-center">
      <h1 class="text-2xl font-bold text-text flex items-center gap-2"><IconGlyph name="fee" /> 班费管理</h1>
    </div>

    <!-- 看板 -->
    <div class="grid grid-cols-3 gap-4 mb-6">
      <div class="bg-success/10 rounded-lg p-4">
        <div class="text-sm text-text-secondary">当前余额</div>
        <div class="text-2xl font-bold text-success">{{ balance }} 元</div>
      </div>
      <div class="bg-info/10 rounded-lg p-4">
        <div class="text-sm text-text-secondary">本月收入</div>
        <div class="text-2xl font-bold text-info">{{ monthlyIncome }} 元</div>
      </div>
      <div class="bg-danger/10 rounded-lg p-4">
        <div class="text-sm text-text-secondary">本月支出</div>
        <div class="text-2xl font-bold text-danger">{{ monthlyExpense }} 元</div>
      </div>
    </div>

    <!-- 工具栏按钮 -->
    <div class="mb-4 flex items-center gap-3 opbar">
      <button @click="openAddDialog" @mouseenter="prefetch(loadAddStudentDialog)" class="bg-primary hover:bg-primary-hover text-text-inverse px-5 py-2 rounded transition-theme">
        ＋ 添加记录
      </button>
      <button @click="searchPanelOpen = !searchPanelOpen" class="btn-search px-4 py-2 rounded flex items-center gap-1.5" title="搜索">
        <IconGlyph name="search" :size="14" tint="current" /> 搜索
      </button>
      <button @click="refreshRecords" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded flex items-center gap-1 btn-refresh transition-theme" title="刷新表格">
        <IconGlyph name="refresh" :size="14" tint="current" /> 刷新
      </button>
      <button
        @click="onBatchDelete"
        :disabled="selectedCount === 0"
        class="bg-danger hover:bg-danger-hover text-text-inverse px-4 py-2 rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-theme"
      >
        <IconGlyph name="trash" :size="14" tint="current" /> 批量删除 ({{ selectedCount }})
      </button>
      <button @click="importDialogVisible = true" @mouseenter="prefetch(loadImportExcel)" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 transition-theme">
        <IconGlyph name="download" :size="14" tint="current" /> 从 Excel 表格批量导入
      </button>
      <button
        @click="openExport"
        @mouseenter="prefetch(loadExportExcel)"
        class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 transition-theme"
      >
        <IconGlyph name="download" :size="14" tint="current" /> 导出 Excel
      </button>
      <button @click="dedupeDialogVisible = true" @mouseenter="prefetch(loadDeduplicateDialog)" class="bg-danger hover:bg-danger-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 transition-theme">
        <IconGlyph name="search" :size="14" tint="current" /> 去除重复数据
      </button>
    </div>

    <SearchBar
      :fields="searchableFields"
      :visible="searchPanelOpen"
      :searchField="searchField"
      :keyword="searchKeyword"
      @update:keyword="searchKeyword = $event"
      @update:searchField="onPickSearchField"
      @close="onCloseSearch"
    />

    <ConfirmDialog
      v-if="dialogMounted"
      :visible="dialog.visible"
      :message="dialog.message"
      :type="dialog.type"
      :showCancel="dialog.showCancel"
      v-model:columnName="columnForm.name"
      v-model:columnType="columnForm.dataType"
      :errorMsg="columnForm.error"
      @confirm="onDialogConfirm"
      @cancel="onDialogCancel"
    />

    <ContextMenu
      v-if="contextMenuMounted"
      :visible="contextMenu.visible"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :items="contextMenu.items"
      @close="hideContextMenu"
    />

    <!-- 收据管理弹窗：上传 / 列表 / 预览 / 下载 / 删除，逻辑在独立组件里 -->
    <ReceiptDialog
      v-model:visible="receiptDialog.visible"
      :receipts="receiptDialog.items"
      :api-base="API_BASE"
      @change="onReceiptChange"
    />

    <DynamicTable
      ref="dynamicTable"
      :fields="visibleFields"
      :rows="displayRows"
      :displayIndexes="displayIndexes"
      :newRow="newRow"
      :sortField="sortField"
      :sortOrder="sortOrder"
      :editingCell="editingCell"
      :search-active="searchActive"
      :search-no-result="searchNoResult"
      @clear-search="onClearSearch"
      :protectedColumns="['收据']"
      emptyLabel="班费"
      empty-import-text="从 Excel 表格批量导入"
      :load-error="loadError"
      error-text="班费记录加载失败"
      @retry="fetchRecords"
      @contextmenu="openContextMenu"
      @search="onOpenStructuralSearch"
      @toggleSort="toggleSort"
      @saveNewRow="saveNewRow"
      @cancelNewRow="cancelNewRow"
      @startEdit="startEditCell"
      @saveCell="saveCell"
      @moveRow="moveRow"
      @deleteRow="deleteRecord"
      @addNewRowAtBottom="addNewRowAtBottom"
      @updateNewRow="onUpdateNewRow"
      @manageReceipt="handleManageReceipt"
      @swapRows="onSwapRows"
      @swapColumns="onSwapColumns"
      @selectionChange="onSelectionChange"
      @moveSelectedRows="onMoveSelectedRows"
      @edit-row="openEditDialog"
      @empty-import="openImportDialog"
    />
    <ExportExcel
      v-if="exportMounted"
      :is-visible="exportDialogVisible"
      @update:is-visible="exportDialogVisible = $event"
      :rows="feeExportRows"
      :fields="visibleFields"
      :selectedRowKeys="selectedRowKeys"
      :tableElement="tableElement"
      :custom-export="customExport"
      defaultFilename="班费记录"
      @export-finish="onExportFinish"
    >
      <template #afterRowOptions>
        <div class="mb-4">
          <AppSwitch v-model="exportWithReceipts">同时导出收据文件</AppSwitch>
          <p class="text-xs text-text-muted mt-1">
            开启后打包成 zip：收支表一个文件，收据按「收据文件/收支编码/原文件名」分目录存放
          </p>
        </div>
      </template>
    </ExportExcel>
    <ImportExcel
      v-if="importMounted"
      :visible="importDialogVisible"
      :existingFields="visibleFields"
      :requiredFields="['收支编码']"
      :templateColumns="allBusinessFields"
      :templateName="'班费记录标准导入表'"
      @import-data="onImportData"
      @cancel="importDialogVisible = false"
    />
    <DeduplicateDialog
      v-if="dedupeMounted"
      :visible="dedupeDialogVisible"
      :rows="feeRecords"
      :fields="allBusinessFields"
      @delete-rows="onDeleteDuplicates"
      @cancel="dedupeDialogVisible = false"
    />
    <AddStudentDialog
      v-if="addMounted"
      :visible="addDialogVisible"
      :fields="addFields"
      :required-field="'收支编码'"
      :title="editingRow ? '修改记录' : '添加记录'"
      :initial-values="addInitialValues"
      @confirm="onSubmitRecord"
      @import="openBatchImportFromAdd"
      @cancel="addDialogVisible = false"
    />
  </div>
</template>

<script setup>
import { prefetch } from '../utils/dialogPrefetch.js'
import { reportError } from '../utils/reportError.js'
import { ref, computed, watch, onMounted, onActivated, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import axios from 'axios'
import SearchBar from '../components/base/SearchBar.vue'
import AppSwitch from '../components/base/AppSwitch.vue'
import DynamicTable from '../components/tables/DynamicTable/DynamicTable.vue'
import { useTableCRUD } from '../composables/useTableCRUD.js'
import { useUndoShortcut, recordRowDelete } from '../composables/useUndo.js'
import { undoById } from '../api/undo'
import { useNotification } from '../composables/useNotification.js'
import { useExportFormats } from '../components/import-export/ExportExcel/ExportExcel.exporters.js'
import { saveBlobWithDialog } from '../utils/saveFile.js'
import { blobToBase64 } from '../utils/base64.js'
import { localDateStr } from '../utils/dateTime.js'
import '../styles/dialog-transition.css'
import { applyRouteRowFocus, createRowFocusHost } from '../composables/useRowFocus.js'

// 弹窗类组件懒加载：打开时才加载对应 chunk
const ConfirmDialog = defineAsyncComponent(() => import('../components/base/ConfirmDialog.vue'))
const ContextMenu = defineAsyncComponent(() => import('../components/base/ContextMenu.vue'))
const loadExportExcel = () => import('../components/import-export/ExportExcel/ExportExcel.vue')
const ExportExcel = defineAsyncComponent(loadExportExcel)
const loadImportExcel = () => import('../components/import-export/ImportExcel.vue')
const ImportExcel = defineAsyncComponent(loadImportExcel)
const loadDeduplicateDialog = () => import('../components/dialogs/DeduplicateDialog.vue')
const DeduplicateDialog = defineAsyncComponent(loadDeduplicateDialog)
const loadAddStudentDialog = () => import('../components/dialogs/AddStudentDialog.vue')
const AddStudentDialog = defineAsyncComponent(loadAddStudentDialog)

const exportDialogVisible = ref(false)

// 懒加载弹窗保活：首次打开后保持挂载，关闭只降 visible，
// 让组件内部 <Transition> 能播放关闭的缩小淡出动画（懒加载不砍动画）
const exportMounted = ref(false)
const importMounted = ref(false)
const dedupeMounted = ref(false)
const dialogMounted = ref(false)
const contextMenuMounted = ref(false)
const addMounted = ref(false)
const addDialogVisible = ref(false)

const API_BASE = '/api'
const DEFAULT_FIELDS = [
  { name: 'id', type: '整数' },
  { name: 'position', type: '整数' },
  { name: '收支编码', type: '文字' },
  { name: '收支类型', type: '文字', control: 'select', options: ['收入', '支出'] },
  { name: '收支金额', type: '小数' },
  { name: '收支时间', type: '日期' },
  { name: '备注', type: '文字' },
  { name: '收据', type: '文字' }
]

const dynamicTable = ref(null)

// 班费特有的金额校验
function customValidate(val, field) {
  if (field.name === '收支金额') {
    if (val === null || val === undefined || val === '') return true
    return /^-?\d+(\.\d+)?$/.test(String(val))
  }
  return true
}

const table = useTableCRUD(`${API_BASE}/fee-records`, DEFAULT_FIELDS, {
  requiredField: '收支编码',
  customValidate,
  undoTableKey: 'fee_records',
  protectedColumns: ['收据']
})

// 跨页定位：标题栏全局搜索点「班费记录」结果跳转 /fee?focus=<id> 时定位到该行
const route = useRoute()
const router = useRouter()
// 行定位宿主：显式传路由对象（身份稳定供 useRowFocus 记签名；不再经实例代理）
const rowFocusHost = createRowFocusHost(route, router)
const applyFocus = () => applyRouteRowFocus(rowFocusHost)
onMounted(applyFocus)
onActivated(applyFocus)
watch(() => route.query.focus, applyFocus)

const feeRecords = table.rows
const {
  newRow, editingCell, contextMenu, dialog, columnForm, loadError,
  sortField, sortOrder, searchField, searchKeyword,
  selectedCount, selectedRowKeys,
  importDialogVisible, dedupeDialogVisible,
  displayRows, displayIndexes, visibleFields, allBusinessFields,
  searchNoResult,
  fetchRows, applyUndoChange, showAlert, onDialogConfirm, onDialogCancel,
  startEditCell, saveCell,
  addNewRowAtBottom, cancelNewRow, saveNewRow,
  moveRow,
  toggleSort, openSearch, closeSearch, clearSearchKeyword, openContextMenu, hideContextMenu,
  onUpdateNewRow, onBatchDelete,
  onMoveSelectedRows, onSwapRows, onSwapColumns,
  onSelectionChange, onImportData, onDeleteDuplicates
} = table

// 弹窗首次打开时置 mounted=true（保活），此后保持挂载，关闭仅降 visible 以播放退出动画
watch(() => exportDialogVisible.value, v => { if (v) exportMounted.value = true })
watch(() => importDialogVisible.value, v => { if (v) importMounted.value = true })
watch(() => dedupeDialogVisible.value, v => { if (v) dedupeMounted.value = true })
watch(() => dialog.value.visible, v => { if (v) dialogMounted.value = true })
watch(() => contextMenu.value.visible, v => { if (v) contextMenuMounted.value = true })
watch(() => addDialogVisible.value, v => { if (v) addMounted.value = true })

const fetchRecords = fetchRows
const { success: notifySuccess, error: notifyError, undoable: notifyUndo } = useNotification()

// 搜索面板显隐（点工具「搜索」按钮弹出；表头🔍 触发的列搜索也用同一面板）
const searchPanelOpen = ref(false)
// 面板「取消」：关闭面板并清空搜索条件
const onCloseSearch = () => {
  searchPanelOpen.value = false
  closeSearch()
}
// 面板「下拉选列」/表头🔍 触发：切换搜索列并弹出面板
const onPickSearchField = name => {
  searchPanelOpen.value = true
  openSearch(name)
}
const onOpenStructuralSearch = onPickSearchField

// 表格空态里的「清除搜索」：清掉关键字、恢复全表。
// 保留搜索列的选择（不清 searchField），用户可以直接换个词再搜，不用重新选列。
const onClearSearch = () => {
  clearSearchKeyword()
}

// Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 撤销、重做本页班费表
useUndoShortcut('fee_records', {
  onAfterUndo: (label, change) => { if (!applyUndoChange(change)) fetchRows(); notifySuccess(label ? `已撤销：${label}` : '已撤销') },
  onAfterRedo: (label, change) => { if (!applyUndoChange(change)) fetchRows(); notifySuccess(label ? `已重做：${label}` : '已重做') }
})

async function refreshRecords() {
  // 同上：fetchRows 失败返回 false，不能无条件提示成功
  const ok = await fetchRecords()
  if (ok) notifySuccess('已刷新费用数据')
  else notifyError('刷新失败，请稍后重试')
}

// ==================== 看板统计 ====================
// 工具栏搜索下拉的可选列：业务字段剔除「收据」（收据为保护列，走收据管理流程，不在此填写）
const searchableFields = computed(() =>
  visibleFields.value.filter(f => f.name !== '收据')
)
// 搜索过滤进行中：表格行进入/离开采用上下级联动画。
// 用「已选搜索列」判断而非关键字非空：清空关键字/恢复全表时同样保持级联，避免回退成水平滑动
const searchActive = computed(() => !!searchField.value)

// 弹窗表单字段：业务字段剔除「收据」（收据为保护列，走收据管理流程，不在此填写）
const addFields = computed(() =>
  visibleFields.value.filter(f => f.name !== '收据')
)

// 弹窗处于编辑模式时持有的那一行；null = 新增模式。
// 弹窗本身不区分新增/编辑（同一套表单、同一个 @confirm），差异全在这里：
// 编辑时预填该行、标题改「修改记录」、提交走 PUT /:id。
const editingRow = ref(null)
const addInitialValues = computed(() => (editingRow.value ? { ...editingRow.value } : {}))

function openAddDialog() {
  // 打开弹窗前，若存在未保存的内联新行先取消，避免两套新增状态并存
  if (newRow.value) newRow.value = null
  editingRow.value = null
  addDialogVisible.value = true
}

// 添加记录弹窗左上角的「从 Excel 表格批量导入」：先关掉单条新增，再打开同一个导入弹窗
function openBatchImportFromAdd() {
  addDialogVisible.value = false
  importMounted.value = true
  importDialogVisible.value = true
}

// 操作列「修改」：打开同一个弹窗，只是预填 + 走更新分支
function openEditDialog(row) {
  if (newRow.value) newRow.value = null
  editingRow.value = row
  addDialogVisible.value = true
}

async function onSubmitRecord(data) {
  if (!data['收支类型']) { notifyError('请选择收支类型'); return }
  if (!data['收支金额']) { notifyError('请填写收支金额'); return }
  if (!data['收支时间']) { notifyError('请选择收支时间'); return }
  const isEdit = !!editingRow.value
  try {
    if (isEdit) {
      // 只提交表单里的字段（收据走独立的收据管理流程，这里不带，免得把已有收据清空）
      await axios.put(`${API_BASE}/fee-records/${editingRow.value.id}`, data)
      addDialogVisible.value = false
      await fetchRecords()
      notifySuccess('已保存修改')
    } else {
      // 弹窗不填收据，新增时置空，保持列存在
      await axios.post(`${API_BASE}/fee-records`, { ...data, '收据': '' })
      addDialogVisible.value = false
      await fetchRecords()
      notifySuccess('已添加记录')
    }
  } catch (err) {
    reportError(err, { action: isEdit ? '保存' : '添加' })
  }
}

const balance = computed(() => {
  // 收入为正，支出为负
  return feeRecords.value.reduce((sum, r) => {
    const amount = parseFloat(r['收支金额']) || 0
    return sum + (r['收支类型'] === '支出' ? -Math.abs(amount) : Math.abs(amount))
  }, 0).toFixed(2)
})

const monthlyIncome = computed(() => {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  return feeRecords.value
    .filter(r => {
      if (r['收支类型'] !== '收入') return false
      const time = r['收支时间']
      if (!time) return false
      const [y, m] = time.split('-').map(Number)
      return y === year && m === month
    })
    .reduce((sum, r) => sum + (Math.abs(parseFloat(r['收支金额'])) || 0), 0)
    .toFixed(2)
})

const monthlyExpense = computed(() => {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  return feeRecords.value
    .filter(r => {
      if (r['收支类型'] !== '支出') return false
      const time = r['收支时间']
      if (!time) return false
      const [y, m] = time.split('-').map(Number)
      return y === year && m === month
    })
    .reduce((sum, r) => sum + (Math.abs(parseFloat(r['收支金额'])) || 0), 0)
    .toFixed(2)
})

// ==================== 表格元素引用 ====================
const tableElement = computed(() => {
  return dynamicTable.value?.rootEl || null
})

// 表格空态里的「从 Excel 表格批量导入」：预取导入弹窗 chunk 后打开。
// 与工具栏的「从 Excel 表格批量导入」共用同一个弹窗，只是把入口也放到空表上。
function openImportDialog() {
  prefetch(loadImportExcel)
  importDialogVisible.value = true
}

// ==================== 删除记录 ====================
function deleteRecord(id) {
  if (selectedCount.value > 1) {
    onBatchDelete()
    return
  }
  // 单条删除不再弹二次确认：删除是可撤销的（recordRowDelete 存整行，撤销走后端真恢复），
  // 直接删掉再给一条 8 秒「撤销」提示。弹窗会被习惯性点掉，还正好挡着用户要确认的那一行；
  // 批量删除（上面那个分支）仍然走确认弹窗 —— 一次删 N 条，撤销成本高，值得先问一句。
  const row = feeRecords.value.find(r => r.id === id)
  ;(async () => {
    try {
      // 先开行动画窗：必须在数据变化之前，否则那一行已经从列表里消失、离场动画播不出来
      dynamicTable.value?.beginRowsAnimWindow()
      await axios.delete(`${API_BASE}/fee-records/${id}`)
      await fetchRecords()
      selectedCount.value = 0
      selectedRowKeys.value = []
      // 删完再登记撤销（顺序反了的话，删除失败会留下一条撤不动的记录）。
      // 拿到撤销记录 id 后走 undoById：不依赖 performUndo 的「当前激活表」，
      // 用户删完立刻切页面也不会撤到别的表上去。
      const undoId = row ? await recordRowDelete('fee_records', row) : null
      if (undoId) {
        notifyUndo('已删除 1 条记录', async () => {
          dynamicTable.value?.beginRowsAnimWindow() // 恢复也是行数变化，同样给行出入动画
          await undoById(undoId)
          await fetchRecords()
        })
      } else {
        notifySuccess('已删除 1 条记录')
      }
    } catch (err) {
      showAlert(err.response?.data?.error || '删除失败')
    }
  })()
}

function onExportFinish() {
  // 保持与原有事件兼容
}

// 导出班费记录：无数据时直接提示，不弹导出选项弹窗
function openExport() {
  if (feeRecords.value.length === 0) return useNotification().info('暂无班费记录可导出')
  // 每次打开都从「不带收据」开始：上一次勾没勾不该影响这一次
  exportWithReceipts.value = false
  exportDialogVisible.value = true
}

// ==================== 收据管理 ====================
// 收据弹窗内容变多（上传/列表/预览/下载/删除），抽成独立组件并懒加载
const ReceiptDialog = defineAsyncComponent(() => import('../components/dialogs/ReceiptDialog.vue'))

const receiptDialog = ref({
  visible: false,
  row: null,
  isNew: false,
  items: [],
})

// 收据在库里是 JSON 数组文本。历史数据是纯路径数组（["/uploads/a.jpg"]），
// 现在多了原始文件名和大小 → 对象数组。读取时两种都要认，否则老记录会读成空。
function normalizeReceipts(raw) {
  let list
  try { list = JSON.parse(raw || '[]') } catch { return [] }
  if (!Array.isArray(list)) return []
  return list
    .map((it) => {
      if (typeof it === 'string') {
        return { path: it, name: it.split('/').pop() || '收据', size: 0 }
      }
      if (!it || !it.path) return null
      return {
        path: it.path,
        name: it.name || String(it.path).split('/').pop() || '收据',
        size: Number(it.size) || 0,
      }
    })
    .filter(Boolean)
}

// 收据在库里是 JSON 数组文本（["/uploads/a.jpg", ...]）。
// 表格里走缩略图 / 「N 张」渲染，但导出拿到的是原始记录 —— 不转就会在
// Excel 单元格里出现一坨带引号方括号的裸 JSON。导出统一转成「a.jpg、b.jpg」。
function receiptText(raw) {
  if (!raw) return ''
  let list
  try { list = JSON.parse(raw) } catch { return String(raw) }
  if (!Array.isArray(list)) return ''
  return list
    .map((it) => (typeof it === 'string' ? it.split('/').pop() : (it && it.name) || ''))
    .filter(Boolean)
    .join('、')
}
const feeExportRows = computed(() =>
  feeRecords.value.map((r) => ({ ...r, 收据: receiptText(r['收据']) }))
)

function handleManageReceipt({ row, isNew }) {
  receiptDialog.value = { visible: true, row, isNew, items: normalizeReceipts(row['收据']) }
}

// 弹窗里每加/删一个文件就调这里 —— 拖进来就落库，不再等点「确定」。
// 文件在上传接口里已经写进 uploads 了，如果不立刻写这条关联，就会出现
// 「磁盘有文件、数据库没记录」，用户以为存上了其实刷新就没了。
// 新增行（还没入库）只能先记在 newRow 上，等整行保存时一起提交。
async function onReceiptChange({ items, removed }) {
  const d = receiptDialog.value
  const json = items.length ? JSON.stringify(items) : ''
  // 本地同步，保证弹窗与父级状态一致（弹窗内部已改，这里只是回写）
  receiptDialog.value.items = items
  if (d.isNew && newRow.value) {
    newRow.value['收据'] = json
    return
  }
  if (!d.row) return
  try {
    await axios.put(`${API_BASE}/fee-records/${d.row.id}`, { '收据': json })
    d.row['收据'] = json
    // 写库成功后再动磁盘：反过来的话一旦保存失败就变成「文件没了、记录还在」
    if (removed.length) {
      try {
        await axios.post(`${API_BASE}/fee-records/receipt-trash`, { paths: removed })
      } catch (_) {
        // 文件没移走只是磁盘残留，不影响数据正确性
      }
    }
  } catch (err) {
    notifyError(err.response?.data?.error || '保存收据失败')
  }
}

// ==================== 导出（可选带上收据文件）====================
const exportWithReceipts = ref(false)

// 勾选「同时导出收据文件」时才接管导出：主文件 + 收据按编码分目录打成 zip。
// 不勾选返回 null → ExportExcel 走原来的单文件保存，行为完全不变。
const customExport = computed(() => (exportWithReceipts.value ? runExportWithReceipts : null))

async function runExportWithReceipts({ format, filename, reportProgress }) {
  const BUILDERS = {
    xlsx: (c, r, f, n) => c.exportXLSX(r, f, n),
    csv: (c, r, f, n) => c.exportCSV(r, f, n),
    html: (c, r, f, n) => c.exportHTMLTable(r, f, n),
    md: (c, r, f, n) => c.exportMD(r, f, n),
    txt: (c, r, f, n) => c.exportTXT(r, f, n),
    json: (c, r, f, n) => c.exportJSON(r, f, n),
  }
  const build = BUILDERS[format]
  if (!build) throw new Error('不支持的导出格式')

  // 主文件仍用 ExportExcel 那套格式实现，只是把写盘出口换成收集器
  const collected = []
  const ctx = {
    reportProgress() {},
    notifySuccess() {},
    notifyError() {},
    notifyInfo() {},
    saveFile: async (name, blob) => { collected.push({ name, blob }); return name },
  }
  Object.assign(ctx, useExportFormats(ctx))

  await build(ctx, feeExportRows.value, visibleFields.value, filename)
  reportProgress(60)

  const entries = []
  for (const f of collected) entries.push({ name: f.name, data: await blobToBase64(f.blob) })

  // 收据按「收支编码」分组，后端按 收据文件/编码/原名 打进 zip
  const groups = []
  for (const r of feeRecords.value) {
    const list = normalizeReceipts(r['收据'])
    if (!list.length) continue
    groups.push({
      code: String(r['收支编码'] || ''),
      items: list.map((f) => ({ path: f.path, name: f.name })),
    })
  }

  const res = await axios.post(
    '/api/data/zip',
    { entries, receiptGroups: groups, filename },
    { responseType: 'blob' }
  )
  reportProgress(90)
  const base = String(filename || '班费记录').trim()
  const saved = await saveBlobWithDialog(`${base}_${localDateStr()}.zip`, res.data)
  // 空串 = 用户在保存对话框点了取消，不提示
  if (saved) notifySuccess(`已导出，含 ${groups.length} 条记录的收据文件`)
}
</script>
