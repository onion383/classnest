<template>
  <div class="min-w-0">
    <div class="w-full bg-surface shadow-md rounded-xl mb-6 px-5 py-3 border border-border min-h-[4.5rem] flex items-center">
      <h1 class="text-2xl font-bold text-text flex items-center gap-2"><IconGlyph name="students" /> 学生管理</h1>
    </div>

    <!-- 学生信息 / 班干部管理 Tab 切换 -->
    <Tabs :tabs="tabsList" v-model="activeTab" class="mb-4" />

    <!-- 班干部管理 -->
    <CadreManage v-if="activeTab === 'cadres'" ref="cadreRef" />

    <!-- 学生信息 -->
    <template v-else>
    <!-- 工具栏按钮 -->
    <div class="mb-4 flex flex-wrap items-center gap-3 opbar">
      <button @click="openAddDialog" @mouseenter="prefetch(loadAddStudentDialog)" class="bg-primary hover:bg-primary-hover text-text-inverse px-5 py-2 rounded transition-theme">
        ＋ 添加学生
      </button>
      <button @click="searchPanelOpen = !searchPanelOpen" class="btn-search px-4 py-2 rounded flex items-center gap-1.5" title="搜索">
        <IconGlyph name="search" :size="14" tint="current" /> 搜索
      </button>
      <button @click="refreshStudents" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded flex items-center gap-1 btn-refresh transition-theme" title="刷新表格">
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
      :extraText="dialog.extraText"
      v-model:columnName="columnForm.name"
      v-model:columnType="columnForm.dataType"
      :errorMsg="columnForm.error"
      @confirm="onDialogConfirm"
      @cancel="onDialogCancel"
      @extra="onDialogExtra"
    />

    <ContextMenu
      v-if="contextMenuMounted"
      :visible="contextMenu.visible"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :items="contextMenu.items"
      @close="hideContextMenu"
    />

    <DynamicTable
      ref="dynamicTable"
      :fields="visibleFields"
      :rows="displayRows"
      :displayIndexes="displayIndexes"
      :newRow="newRow"
      :protectedColumns="['学号', '姓名']"
      emptyLabel="学生"
      empty-import-text="从 Excel 表格批量导入"
      :load-error="loadError"
      error-text="学生名单加载失败"
      @retry="fetchStudents"
      :sortField="sortField"
      :sortOrder="sortOrder"
      :editingCell="editingCell"
      :search-active="searchActive"
      :search-no-result="searchNoResult"
      @clear-search="onClearSearch"
      @contextmenu="openContextMenu"
      @search="onOpenStructuralSearch"
      @toggleSort="toggleSort"
      @saveNewRow="saveNewRow"
      @cancelNewRow="cancelNewRow"
      @startEdit="startEditCell"
      @saveCell="saveCell"
      @moveRow="moveRow"
      @deleteRow="deleteStudent"
      @addNewRowAtBottom="addNewRowAtBottom"
      @updateNewRow="onUpdateNewRow"
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
      :rows="students"
      :fields="visibleFields"
      :selectedRowKeys="selectedRowKeys"
      :tableElement="tableElement"
      defaultFilename="学生信息"
      @export-finish="onExportFinish"
    />
    <ImportExcel
      v-if="importMounted"
      :visible="importDialogVisible"
      :existingFields="visibleFields"
      :requiredFields="['姓名']"
      :templateColumns="allBusinessFields"
      :templateName="'学生信息标准导入表'"
      @import-data="onImportData"
      @cancel="importDialogVisible = false"
    />
    <DeduplicateDialog
      v-if="dedupeMounted"
      :visible="dedupeDialogVisible"
      :rows="students"
      :fields="allBusinessFields"
      @delete-rows="onDeleteDuplicates"
      @cancel="dedupeDialogVisible = false"
    />
    <AddStudentDialog
      v-if="addMounted"
      :visible="addDialogVisible"
      :fields="visibleFields"
      :required-field="'姓名'"
      :title="editingRow ? '修改学生' : '添加学生'"
      :initial-values="addInitialValues"
      @confirm="onSubmitStudent"
      @import="openBatchImportFromAdd"
      @cancel="addDialogVisible = false"
    />
    </template>
   </div>
</template>

<script setup vapor>
import { prefetch } from '../utils/dialogPrefetch.js'
import { reportError } from '../utils/reportError.js'
import { ref, computed, watch, onMounted, onActivated, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import axios from 'axios'
import SearchBar from '../components/base/SearchBar.vue'
import DynamicTable from '../components/tables/DynamicTable/DynamicTable.vue'
import Tabs from '../components/base/Tabs.vue'
import { useTableCRUD } from '../composables/useTableCRUD.js'
import { useUndoShortcut, recordRowDelete, recordRowInsert, recordRowUpdate, recordStudentCascadeDelete } from '../composables/useUndo.js'
import { undoById } from '../api/undo'
import { useNotification } from '../composables/useNotification.js'
import { applyRouteRowFocus, createRowFocusHost } from '../composables/useRowFocus.js'

// 学生信息 / 班干部管理 Tab
const tabsList = [
  { value: 'students', label: '学生信息' },
  { value: 'cadres', label: '班干部管理' }
]
const activeTab = ref('students')
// 班干部子组件的实例（撤销/重做后要让它重拉职务树）
const cadreRef = ref(null)

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

// 班干部管理：切到该 Tab 时才下载其代码 chunk 并实例化（v-if 控制挂载）
const CadreManage = defineAsyncComponent(() => import('../components/CadreManage.vue'))

const exportDialogVisible = ref(false)
const addDialogVisible = ref(false)

// 懒加载弹窗保活：首次打开后保持挂载，关闭只降 visible，
// 让组件内部 <Transition> 能播放关闭的缩小淡出动画（懒加载不砍动画）
const exportMounted = ref(false)
const importMounted = ref(false)
const dedupeMounted = ref(false)
const dialogMounted = ref(false)
const contextMenuMounted = ref(false)
const addMounted = ref(false)

const API_BASE = '/api'
const DEFAULT_FIELDS = [
  { name: 'id', type: '整数' },
  { name: 'position', type: '整数' },
  { name: '学号', type: '文字' },
  { name: '年级', type: '文字' },
  { name: '班级', type: '文字' },
  { name: '姓名', type: '文字' },
  { name: '年龄', type: '整数' },
  { name: '备注', type: '文字' }
]

const dynamicTable = ref(null)

const table = useTableCRUD(`${API_BASE}/students`, DEFAULT_FIELDS, {
  requiredField: '姓名',
  protectedColumns: ['学号', '姓名'],
  undoTableKey: 'students'
})

// 跨页定位：标题栏全局搜索点「学生」结果跳转 /students?focus=<id> 时，
// 先切回「学生信息」页签，再滚动到目标行并高亮闪动
const route = useRoute()
const router = useRouter()
// 行定位宿主：显式传路由对象（身份稳定供 useRowFocus 记签名；不再经实例代理）
const rowFocusHost = createRowFocusHost(route, router)
// 班干部结果（focus=cadre:<职务id>）：这里只切页签，定位交给 CadreManage 自己做。
// 不能在这里调 applyRouteRowFocus —— 它解析成功后会 router.replace 清掉 query，
// 而 CadreManage 是 v-if 懒加载、切页签后才挂载，清早了它就永远收不到 focus。
const applyFocus = () => {
  if (String(route.query.focus || '').startsWith('cadre:')) {
    activeTab.value = 'cadres'
    return
  }
  applyRouteRowFocus(rowFocusHost, {
    parse: (key) => { activeTab.value = 'students'; return key }
  })
}
onMounted(applyFocus)
onActivated(applyFocus)
watch(() => route.query.focus, applyFocus)

// 为了兼容原有模板，创建别名
const students = table.rows
const {
  newRow, editingCell, contextMenu, dialog, columnForm, loadError,
  sortField, sortOrder, searchField, searchKeyword,
  selectedCount, selectedRowKeys,
  importDialogVisible, dedupeDialogVisible,
  displayRows, displayIndexes, visibleFields, allBusinessFields,
  searchNoResult,
  fetchRows, applyUndoChange, showAlert, showConfirm, onDialogConfirm, onDialogCancel, onDialogExtra,
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
watch(() => addDialogVisible.value, v => { if (v) addMounted.value = true })
watch(() => dialog.value.visible, v => { if (v) dialogMounted.value = true })
watch(() => contextMenu.value.visible, v => { if (v) contextMenuMounted.value = true })

const fetchStudents = fetchRows
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

// 工具栏搜索下拉的可选列：剔除 id / position 等结构性字段，仅保留业务字段
const searchableFields = computed(() =>
  visibleFields.value.filter(f => !['id', 'position'].includes(f.name))
)
// 搜索过滤进行中：表格行进入/离开采用上下级联动画。
// 用「已选搜索列」判断而非关键字非空：清空关键字/恢复全表时同样保持级联，避免回退成水平滑动
const searchActive = computed(() => !!searchField.value)

// Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y：撤销、重做「当前 Tab」的数据。
// key 必须跟着 Tab 走：班干部 Tab 用「班干部」，否则在这一页按 Ctrl+Z 会撤到学生表的记录上。
// 两边的撤销记录各自独立分组，互不影响。
function afterUndoRedo(action, label, change) {
  if (activeTab.value === 'cadres') {
    if (cadreRef.value) cadreRef.value.reload()
  } else if (!applyUndoChange(change)) {
    fetchRows()
  }
  notifySuccess(label ? `已${action}：${label}` : `已${action}`)
}
useUndoShortcut(() => (activeTab.value === 'cadres' ? '班干部' : 'students'), {
  onAfterUndo: (label, change) => afterUndoRedo('撤销', label, change),
  onAfterRedo: (label, change) => afterUndoRedo('重做', label, change)
})

async function refreshStudents() {
  // fetchRows 失败时不再抛错，而是返回 false：不按返回值判断就会「刷新失败也提示成功」
  const ok = await fetchStudents()
  if (ok) notifySuccess('已刷新学生数据')
  else notifyError('刷新失败，请稍后重试')
}

// 弹窗处于编辑模式时持有的那一行；null = 新增模式。
// 弹窗共用一套表单，差异全在这里：预填该行、标题改「修改学生」、提交走 PUT /:id。
const editingRow = ref(null)
const addInitialValues = computed(() => (editingRow.value ? { ...editingRow.value } : {}))

function openAddDialog() {
  // 打开弹窗前，若存在未保存的内联新行先取消，避免两套新增状态并存
  if (newRow.value) newRow.value = null
  editingRow.value = null
  addDialogVisible.value = true
}

// 添加学生弹窗左上角的「从 Excel 表格批量导入」：先关掉单条新增，再打开同一个导入弹窗
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

async function onSubmitStudent(data) {
  const isEdit = !!editingRow.value
  try {
    if (isEdit) {
      // 弹窗整行提交不走共享 CRUD 的 saveCell，撤销要在这里按完整行登记（Q2-07）。
      // oldRow/newRow 都取完整行：row_update 的 undo 按列回写，学生改名还要反向级联关联表里只存姓名的引用。
      const oldRow = { ...editingRow.value }
      await axios.put(`${API_BASE}/students/${oldRow.id}`, data)
      addDialogVisible.value = false
      await fetchStudents()
      recordRowUpdate('students', oldRow, table.rowSnapshotById(oldRow.id, { ...oldRow, ...data }))
      notifySuccess('已保存修改')
    } else {
      const res = await axios.post(`${API_BASE}/students`, data)
      addDialogVisible.value = false
      await fetchStudents()
      // POST 只回 id，redo 要靠完整行重建；共享层按 id 从刚刷新的全表快照里取。
      recordRowInsert('students', table.rowSnapshotById(res.data.id, data))
      notifySuccess('已添加学生')
    }
  } catch (err) {
    reportError(err, { action: isEdit ? '保存' : '添加' })
  }
}

// 表格空态里的「从 Excel 表格批量导入」：先预取导入弹窗 chunk，再打开。
// 空表是首次使用最常见的入口，用户不必回工具栏再找一遍「从 Excel 表格批量导入」。
function openImportDialog() {
  prefetch(loadImportExcel)
  importDialogVisible.value = true
}

const tableElement = computed(() => {
  return dynamicTable.value?.rootEl || null
})

async function deleteStudent(id) {
  if (selectedCount.value > 1) {
    onBatchDelete()
    return
  }
  // 删前先问后端：该生被哪些记录引用（请假/加分/座位/值日），据结果决定提示与处理方式
  let rel = { leave: 0, score: 0, seat: 0, duty: 0, total: 0 }
  try {
    const res = await axios.get(`${API_BASE}/students/${id}/relations`)
    rel = res.data || rel
  } catch (_) { /* 预览失败按“无关联”处理，不阻断删除 */ }

  const finish = async () => {
    await fetchStudents()
    selectedCount.value = 0
    selectedRowKeys.value = []
  }

  if (!rel.total) {
    // 无关联记录的学生：直接删 + 撤销条，不弹二次确认。删除可撤销（recordRowDelete 存整行，
    // 撤销走后端真恢复），比弹窗更顺；弹窗还会正好挡住用户要确认的那一行。
    // 有关联的那种情况（下面那段）仍然保留弹窗 —— 级联删除要讲清影响，撤销成本也高。
    const row = students.value.find(s => s.id === id)
    try {
      // 先开行动画窗：必须在数据变化之前，否则那一行已经从列表里消失、离场动画播不出来
      dynamicTable.value?.beginRowsAnimWindow()
      await axios.delete(`${API_BASE}/students/${id}`)
      await finish()
      // 删完再登记撤销；拿到 id 后走 undoById，不依赖 performUndo 的「当前激活表」
      const undoId = row ? await recordRowDelete('students', row) : null
      if (undoId) {
        notifyUndo(`已删除学生「${row['姓名']}」`, async () => {
          dynamicTable.value?.beginRowsAnimWindow() // 恢复也是行数变化，同样给行出入动画
          await undoById(undoId)
          await finish()
        })
      } else {
        notifySuccess('已删除学生')
      }
    } catch (err) {
      showAlert(err.response?.data?.error || '删除失败')
    }
    return
  }

  const student = students.value.find(s => s.id === id)
  const parts = []
  if (rel.leave) parts.push(`${rel.leave} 条请假记录`)
  if (rel.score) parts.push(`${rel.score} 条加减分记录`)
  if (rel.seat) parts.push(`${rel.seat} 个座位`)
  if (rel.duty) parts.push(`${rel.duty} 个值日岗位`)
  if (rel.group) parts.push(`${rel.group} 处小组成员`)
  if (rel.cadre) parts.push(`${rel.cadre} 个班干部职务`)
  const who = student ? `「${student['姓名']}」` : '该学生'
  const msg = `${who}还有 ${parts.join('、')}。\n\n「一并删除」会同时删除这些关联记录；\n「仅删学生」保留它们（可能成为指向不存在学生的孤儿数据）；\n「取消」不做任何操作。`

  showConfirm(msg, async () => {
    try {
      dynamicTable.value?.beginRowsAnimWindow() // 级联删除同样要行离场动画
      const res = await axios.post(`${API_BASE}/students/${id}/delete-with-relations`, {
        relations: { leave: true, score: true, seat: true, duty: true, group: true, cadre: true }
      })
      await finish()
      // 级联删除也要可撤销：后端把七处（学生/请假/加减分/小组/班干部/座位/值日）
      // 的快照整包返回，登记成**一条**命令 —— 否则 Ctrl+Z 只回来学生，关联还得再撤六次。
      const removed = res.data?.removed
      const undoId = await recordStudentCascadeDelete(removed)
      const name = removed?.student?.['姓名'] || '该学生'
      if (undoId) {
        notifyUndo(`已删除学生「${name}」及关联记录`, async () => {
          dynamicTable.value?.beginRowsAnimWindow()
          await undoById(undoId)
          await finish()
        })
      } else {
        notifySuccess('已删除学生及关联记录')
      }
    } catch (err) {
      showAlert(err.response?.data?.error || '删除失败')
    }
  }, null, {
    extraText: '仅删学生',
    onExtra: async () => {
      try {
        dynamicTable.value?.beginRowsAnimWindow()
        await axios.delete(`${API_BASE}/students/${id}`)
        await finish()
        // 「仅删学生」原先不登记撤销 —— 删完只能重新录入。学生整行就在手边，直接登记。
        const undoId = student ? await recordRowDelete('students', student) : null
        if (undoId) {
          notifyUndo(`已删除学生「${student['姓名']}」（保留关联记录）`, async () => {
            dynamicTable.value?.beginRowsAnimWindow()
            await undoById(undoId)
            await finish()
          })
        } else {
          notifySuccess('已删除学生（保留关联记录）')
        }
      } catch (err) {
        showAlert(err.response?.data?.error || '删除失败')
      }
    }
  })
}

function onExportFinish() {
  // 保持与原有事件兼容
}

// 导出学生信息：无数据时直接提示，不弹导出选项弹窗
function openExport() {
  if (students.value.length === 0) return useNotification().info('暂无学生数据可导出')
  exportDialogVisible.value = true
}
</script>

<style scoped>
/* 可根据需要添加样式 */
</style>
