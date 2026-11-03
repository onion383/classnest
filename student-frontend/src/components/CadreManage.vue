<template>
  <div class="h-full flex flex-col relative">
    <!-- 工具栏按钮：修改 + 添加职务 + 增加下级 + 刷新 -->
    <div class="mb-4 flex items-center gap-3 opbar">
      <button @click="onEditSelected" :disabled="!selectedNode" class="bg-primary hover:bg-primary-hover text-text-inverse px-4 py-2 rounded transition-theme flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
        <IconGlyph name="edit" :size="14" tint="current" /> 修改
      </button>
      <button @click="onAddRoot" class="bg-primary hover:bg-primary-hover text-text-inverse px-4 py-2 rounded transition-theme flex items-center gap-1.5 cursor-pointer">＋ 添加职务</button>
      <button @click="onAddChildSelected" :disabled="!selectedNode" class="bg-primary hover:bg-primary-hover text-text-inverse px-4 py-2 rounded transition-theme flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">＋ 增加下级</button>
      <button @click="onRefresh" class="bg-text-muted text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 btn-refresh"><IconGlyph name="refresh" :size="14" tint="current" /> 刷新</button>
      <button @click="openExport" @mouseenter="prefetch(loadExportExcel)" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded transition-theme flex items-center gap-1.5 cursor-pointer">
        <IconGlyph name="download" :size="14" tint="current" /> 导出 Excel
      </button>
      <button @click="importVisible = true" @mouseenter="prefetch(loadImportExcel)" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded transition-theme flex items-center gap-1.5 cursor-pointer">
        <IconGlyph name="download" :size="14" tint="current" /> 从 Excel 表格批量导入
      </button>
    </div>

    <!-- ====== 树状视图（智能排表式嵌套列表） ====== -->
    <div ref="treeScrollRef" class="tree-scroll bg-surface shadow-md rounded-xl border border-border p-4 flex-1 min-h-0 overflow-y-auto overflow-x-hidden app-custom-scroll" @click.self="selectedId = null">
      <!-- 空状态 -->
      <div v-if="!loading && tree.length === 0" class="text-center text-text-muted py-12">
        <p class="text-lg mb-2">还没有任何职务</p>
        <p class="text-sm">点击上方「＋ 添加职务」创建班主任、班长等职务，并逐级添加下级与担任学生。</p>
        <button @click="onAddRoot" class="mt-4 bg-primary hover:bg-primary-hover text-text-inverse px-4 py-2 rounded transition-theme cursor-pointer">＋ 添加职务</button>
      </div>

      <!-- 职务树：智能排表式嵌套列表，可拖拽排序（拖空白区可上移为顶级） -->
      <div v-else class="pb-2" @dragover.prevent @drop="onDropEmpty" @click.self="selectedId = null">
        <p class="text-xs text-text-muted mb-2">点击任意职务行可选中（选中后高亮蓝框）；选中后可用上方「增加下级」「修改」。按住 <span class="font-bold">⠿</span> 拖动可调整顺序；拖到某职务行前后可在同级重排，拖到某职务下方虚线框可将它变为下级；成员可跨职务拖动。操作即时保存。</p>
        <CadreTreeList
          v-for="root in tree"
          :key="root.id"
          :node="root"
          :all-students="allStudents"
          :level="0"
          :selected-id="selectedId"
          @select="selectedId = $event"
          @add-student="onAddStudentInline"
          @add-child="onAddChild"
          @edit="onEdit"
          @remove="onRemove"
          @remove-member="onRemoveMember"
          @drop-move="handleMove"
        />
      </div>
    </div>
    <!-- 职务树：细滑块 + 淡入；根容器 relative，覆盖层落在卡片右侧内边距里 -->
    <CustomScrollbar :target="treeScrollRef" compact :arrows="false" auto-hide :min-thumb="22" />

    <!-- ============ 导出弹窗（复用 ExportExcel，导出去平后的职务名单） ============ -->
    <ExportExcel
      v-if="exportMounted"
      :is-visible="exportVisible"
      :rows="exportRows"
      :fields="exportFields"
      default-filename="班干部名单"
      title="导出班干部名单"
      @update:is-visible="exportVisible = $event"
    />

    <!-- ============ 导入弹窗（与导出列一致，可直接把导出文件导回） ============ -->
    <ImportExcel
      v-if="importMounted"
      :visible="importVisible"
      :existingFields="importFields"
      :requiredFields="['职务']"
      :templateName="'班干部标准导入表'"
      @import-data="onImportData"
      @cancel="importVisible = false"
    />

    <!-- ============ 新增/编辑职务弹窗 ============ -->
    <Teleport to="body">
    <Transition name="dialog">
    <div v-if="nodeDialogVisible" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10003]" @click.self="nodeDialogVisible = false">
      <div class="bg-surface p-6 rounded-xl w-96 shadow-card dialog-card border border-border">
        <div class="flex items-center gap-3 mb-4">
          <h3 class="text-lg font-bold text-text">{{ editTarget ? '编辑职务' : (parentTarget ? '添加下级职务' : '添加职务') }}</h3>
          <button
            v-if="!editTarget"
            type="button"
            @click="openImportFromNodeDialog"
            class="bg-warning hover:bg-warning-hover text-text-inverse px-3 py-1.5 rounded text-sm flex items-center gap-1.5 transition-theme cursor-pointer"
            title="从 Excel 表格批量导入"
          >
            <IconGlyph name="download" :size="14" tint="current" /> 从 Excel 表格批量导入
          </button>
        </div>
        <label class="block text-sm text-text-secondary mb-1">职务名称</label>
        <input v-model="nodeForm.name" placeholder="如：学习委员、组长" class="border border-border bg-surface text-text px-3 py-2 rounded w-full mb-4" autofocus />
        <label class="block text-sm text-text-secondary mb-1">可担任人数</label>
        <input v-model.number="nodeForm.max_count" type="number" min="1" max="99" class="border border-border bg-surface text-text px-3 py-2 rounded w-full mb-4" />
        <div class="flex justify-end gap-2">
          <button @click="nodeDialogVisible = false" class="bg-surface-hover text-text border border-border px-4 py-2 rounded transition-theme cursor-pointer">取消</button>
          <button @click="submitNode" class="bg-primary text-text-inverse px-4 py-2 rounded transition-theme cursor-pointer">确定</button>
        </div>
      </div>
    </div>
    </Transition>
    </Teleport>

    <!-- ============ 二次确认弹窗 ============ -->
    <Teleport to="body">
    <Transition name="dialog">
    <div v-if="confirmMsg" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10004]" @click.self="confirmMsg = null">
      <div class="bg-surface p-6 rounded-xl w-96 shadow-card dialog-card border border-border">
        <h3 class="text-lg font-bold text-text mb-3">确认操作</h3>
        <p class="text-text-secondary mb-4">{{ confirmMsg }}</p>
        <div class="flex justify-end gap-2">
          <button @click="confirmMsg = null" class="bg-surface-hover text-text border border-border px-4 py-2 rounded transition-theme cursor-pointer">取消</button>
          <button @click="doConfirmDelete" class="bg-danger text-white px-4 py-2 rounded transition-theme cursor-pointer">删除</button>
        </div>
      </div>
    </div>
    </Transition>
    </Teleport>
  </div>
</template>

<script setup vapor>
import { getToken } from '../utils/authStorage.js'
import { ref, reactive, computed, onMounted, watch, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { prefetch } from '../utils/dialogPrefetch.js'
import axios from 'axios'
import CadreTreeList from './CadreTreeList.vue'
import CustomScrollbar from './base/CustomScrollbar.vue'
import { useNotification } from '../composables/useNotification'
import { applyRouteRowFocus } from '../composables/useRowFocus.js'
import { pushUndo } from '../api/undo'
import { refreshUndoStatus } from '../composables/useUndo.js'

// 导出弹窗懒加载：首次点开时才加载 ExportExcel 的代码块
const loadExportExcel = () => import('./import-export/ExportExcel/ExportExcel.vue')
const ExportExcel = defineAsyncComponent(loadExportExcel)
const loadImportExcel = () => import('./import-export/ImportExcel.vue')
const ImportExcel = defineAsyncComponent(loadImportExcel)

const { success, error, info } = useNotification()

const API_BASE = '/api'
const tree = ref([])
const loading = ref(false)
const allStudents = ref([])

// 职务树滚动容器（自定义滚动条的目标）
const treeScrollRef = ref(null)

// 跨页定位：标题栏全局搜索点「班干部」结果 → /students?focus=cadre:<职务id>。
// 父级 ClassroomView 只负责切到「班干部管理」页签、不消费 query —— 它若照常走
// applyRouteRowFocus，成功后会 router.replace 把 focus 清掉，而本组件是 v-if 懒加载、
// 切页签后才挂载，就永远收不到这个 focus 了。所以定位由这里自己做。
const route = useRoute()
const router = useRouter()
const rowFocusHost = { route, router }
function applyFocus() {
  const key = String(route.query.focus || '')
  if (!key.startsWith('cadre:')) return
  applyRouteRowFocus(rowFocusHost, {
    parse: (k) => {
      const id = String(k).slice('cadre:'.length)
      // 职务树是异步加载的：还没到就返回空值，交给 helper 的重试；数据到位后才清 query
      if (!id || loading.value || !tree.value.length) return null
      return id
    },
    container: () => treeScrollRef.value,
  })
}

// 当前选中的职务行（选中后高亮蓝框，供工具栏「增加下级 / 修改」使用）
const selectedId = ref(null)
const selectedNode = computed(() => (selectedId.value == null ? null : findNode(tree.value, selectedId.value)))

const api = (options = {}) => {
  const opts = {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    ...options
  }
  return axios({ baseURL: API_BASE, method: 'get', ...opts })
}

// ============ 撤销登记 ============
// key 与 ClassroomView 的 Ctrl+Z 上下文保持一致：班干部 Tab 激活时父页面把上下文切到「班干部」，
// 学生 Tab 下切回 'students'（见 ClassroomView 的 useUndoShortcut 动态 key）。
const UNDO_KEY = '班干部'
// 登记一条撤销记录；失败不影响主流程（与 useUndo.js 既有做法一致）
function recordUndo(type, label, payload) {
  try {
    return pushUndo({ key: UNDO_KEY, type, label, payload })
      .then(() => refreshUndoStatus(true))
      .catch(() => {})
  } catch {
    return Promise.resolve()
  }
}
// 职务行 / 担任学生行：只取真实列，树节点多带的 children/members 由后端按表结构过滤
function cadreRow(n) {
  return {
    id: n.id,
    name: n.name,
    parent_id: n.parent_id == null ? 0 : n.parent_id,
    max_count: n.max_count,
    sort_order: n.sort_order
  }
}
function memberRow(m) {
  return {
    id: m.id,
    cadre_id: m.cadre_id,
    student_id: m.student_id == null ? null : m.student_id,
    student_name: m.student_name,
    sort_order: m.sort_order == null ? 0 : m.sort_order
  }
}
// 拖拽排序的前后态：职务记「归属 + 排序」，成员记「所属职务 + 排序」
function cadreState(list) {
  const rows = []
  const walk = (nodes) => {
    for (const n of nodes || []) {
      rows.push({ id: n.id, parent_id: n.parent_id == null ? 0 : n.parent_id, sort_order: n.sort_order })
      walk(n.children)
    }
  }
  walk(list)
  return rows
}
function memberState(list) {
  const rows = []
  const walk = (nodes) => {
    for (const n of nodes || []) {
      for (const m of n.members || []) {
        rows.push({ id: m.id, cadre_id: m.cadre_id, sort_order: m.sort_order == null ? 0 : m.sort_order })
      }
      walk(n.children)
    }
  }
  walk(list)
  return rows
}
function findMemberName(list, id) {
  for (const n of list || []) {
    const hit = (n.members || []).find(m => m.id === id)
    if (hit) return hit.student_name
    const deeper = findMemberName(n.children, id)
    if (deeper) return deeper
  }
  return ''
}
// 拖拽结束后对比前后态：没实际变化（拖回原处）不留撤销记录
function recordMoveUndo(before, res, label) {
  const treeAfter = (res.data && res.data.tree) || []
  const after = { cadres: cadreState(treeAfter), members: memberState(treeAfter) }
  if (JSON.stringify(before.cadres) === JSON.stringify(after.cadres)
    && JSON.stringify(before.members) === JSON.stringify(after.members)) return
  recordUndo('cadre_order', label, { before, after })
}

async function loadTree() {
  loading.value = true
  try {
    const res = await api({ url: '/cadres' })
    tree.value = res.data.tree || []
    return true
  } catch (e) {
    error('加载职务树失败')
    return false
  } finally {
    loading.value = false
  }
}
// 工具栏「刷新」：重新拉取职务树并给出提示条反馈（失败时 loadTree 已弹错误提示，不再叠加成功提示）
async function onRefresh() {
  if (await loadTree()) success('已刷新班干部数据')
}

// ============ 导出（复用 ExportExcel，导出去平后的职务名单） ============
const exportMounted = ref(false)
const exportVisible = ref(false)
// 固定列：层级用「上级职务 + 层级」表达，同一职务的多名担任学生合并到一行
const exportFields = [
  { name: '序号' },
  { name: '职务' },
  { name: '上级职务' },
  { name: '层级' },
  { name: '担任学生' },
  { name: '已担任人数' },
  { name: '可担任人数' }
]
// 先序遍历职务树，保证导出顺序与页面从上到下的展示顺序一致
const exportRows = computed(() => {
  const rows = []
  let seq = 0
  const walk = (nodes, parentName, level) => {
    for (const node of nodes || []) {
      seq += 1
      const members = node.members || []
      rows.push({
        id: node.id,
        序号: seq,
        职务: node.name,
        上级职务: parentName || '',
        层级: level,
        担任学生: members.map(m => m.student_name).join('、'),
        已担任人数: members.length,
        可担任人数: node.max_count
      })
      walk(node.children, node.name, level + 1)
    }
  }
  walk(tree.value, '', 1)
  return rows
})
function openExport() {
  if (tree.value.length === 0) return info('暂无班干部数据可导出')
  exportMounted.value = true
  exportVisible.value = true
}

// ============ 导入（列与导出表一致，序号/层级/已担任人数是派生列，导入时忽略） ============
const importVisible = ref(false)
const importMounted = ref(false)
watch(importVisible, (n) => { if (n) importMounted.value = true })
const importFields = [
  { name: '职务' },
  { name: '上级职务' },
  { name: '担任学生' },
  { name: '可担任人数' }
]
async function onImportData({ fields, rows }) {
  importVisible.value = false
  try {
    const res = await api({ url: '/cadres/import', method: 'post', data: { fields, rows } })
    tree.value = (res.data && res.data.tree) || []
    // 只回滚本次真正新建的职务/成员；导入前已有的数据不受影响
    const created = res.data && res.data.created
    if (created && (created.cadres.length || created.members.length)) {
      recordUndo('cadre_import', `导入班干部：${created.cadres.length} 个职务、${created.members.length} 名担任学生`, {
        cadres: created.cadres,
        members: created.members
      })
    }
    success((res.data && res.data.message) || '导入成功')
  } catch (e) {
    error((e.response && e.response.data && e.response.data.error) || e.message)
  }
}

async function fetchStudents() {
  try {
    const res = await api({ url: '/students' })
    // 只接受数组或 {data:数组}：异常形状（如旧缓存解不开的 {d}）不覆盖现有名册，
    // 否则 CadreTreeList 里的 .filter/.find 会直接崩
    const body = res && res.data
    const list = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : null)
    if (!list) { console.error('[students] 响应形状异常', body); return }
    allStudents.value = list
  } catch (e) { /* 学生列表不可用时不阻塞 */ }
}

onMounted(() => { loadTree(); fetchStudents(); applyFocus() })
watch(() => route.query.focus, applyFocus)

// ============ 职务新增 / 编辑 / 删除 ============
const nodeDialogVisible = ref(false)
const editTarget = ref(null)
const parentTarget = ref(null)
const nodeForm = reactive({ name: '', max_count: 1 })

function onAddRoot() {
  editTarget.value = null
  parentTarget.value = null
  Object.assign(nodeForm, { name: '', max_count: 1 })
  nodeDialogVisible.value = true
}
// 添加职务弹窗左上角的批量导入：关掉单条新增，直接打开导入弹窗
function openImportFromNodeDialog() {
  nodeDialogVisible.value = false
  importVisible.value = true
}
function onAddChild(node) {
  editTarget.value = null
  parentTarget.value = node
  Object.assign(nodeForm, { name: '', max_count: 1 })
  nodeDialogVisible.value = true
}
function onEdit(node) {
  editTarget.value = node
  parentTarget.value = null
  Object.assign(nodeForm, { name: node.name, max_count: node.max_count })
  nodeDialogVisible.value = true
}
// 工具栏「增加下级」：为当前选中职务增加下级
function onAddChildSelected() {
  if (!selectedNode.value) return info('请先选择一个职务')
  onAddChild(selectedNode.value)
}
// 工具栏「修改」：编辑当前选中职务（与行内「编辑职务」一致）
function onEditSelected() {
  if (!selectedNode.value) return info('请先选择一个职务')
  onEdit(selectedNode.value)
}
// 职务下方行内「添加学生」确认后添加担任学生
async function onAddStudentInline({ nodeId, student }) {
  const node = findNode(tree.value, nodeId)
  if (node && node.members.length >= node.max_count) {
    return info(`「${node.name}」人数已达上限 ${node.max_count} 人`)
  }
  try {
    const res = await api({ url: `/cadres/${nodeId}/members`, method: 'post', data: { student_id: student.id, student_name: student.姓名 } })
    const nodeAfter = findNode((res.data && res.data.tree) || [], nodeId)
    const added = nodeAfter && (nodeAfter.members || []).find(m => m.id === Number(res.data && res.data.id))
    if (added) recordUndo('row_insert', `添加担任学生：${added.student_name}`, { table: 'cadre_members', row: memberRow(added) })
    success('已添加担任学生')
    await loadTree()
  } catch (e) {
    error(e.response?.data?.error || '添加失败')
  }
}

async function submitNode() {
  const name = String(nodeForm.name || '').trim()
  if (!name) return error('请输入职务名称')
  const maxCount = Math.max(1, Math.min(99, Number(nodeForm.max_count) || 1))
  try {
    if (editTarget.value) {
      const oldRow = cadreRow(editTarget.value)
      await api({ url: `/cadres/${editTarget.value.id}`, method: 'put', data: { name, max_count: maxCount } })
      // 名称/名额都没改时不登记：打开「修改」又直接确定，不该在撤销栈里留一条空记录
      if (oldRow.name !== name || oldRow.max_count !== maxCount) {
        recordUndo('row_update', `修改职务：${name}`, {
          table: 'cadres',
          rowId: oldRow.id,
          oldRow,
          newRow: { ...oldRow, name, max_count: maxCount }
        })
      }
      success('已保存')
    } else {
      const res = await api({ url: '/cadres', method: 'post', data: { name, max_count: maxCount, parent_id: parentTarget.value ? parentTarget.value.id : 0 } })
      const created = findNode((res.data && res.data.tree) || [], Number(res.data && res.data.id))
      if (created) recordUndo('row_insert', `添加职务：${created.name}`, { table: 'cadres', row: cadreRow(created) })
      success('已添加')
    }
    nodeDialogVisible.value = false
    await loadTree()
  } catch (e) {
    error(e.response?.data?.error || '保存失败')
  }
}

const confirmMsg = ref(null)
const pendingDelete = ref(null)
function onRemove(node) {
  const hasChildren = node.children && node.children.length > 0
  pendingDelete.value = { id: node.id }
  confirmMsg.value = hasChildren
    ? `确定删除职务「${node.name}」吗？其担任学生将一并删除，下级职务将上移到其上级。`
    : `确定删除职务「${node.name}」吗？其担任学生将一并删除。`
}
async function doConfirmDelete() {
  const p = pendingDelete.value
  if (!p) return
  const node = findNode(tree.value, p.id)
  // 删之前先拍下「被删职务 + 其担任学生 + 直接下级」：后端删除是三件事一起做的
  // （删成员、下级上移到 node.parent_id、删职务行），撤销必须整批回滚。
  const snapshot = node && {
    node: cadreRow(node),
    members: (node.members || []).map(memberRow),
    children: (node.children || []).map(c => ({ id: c.id, parent_id: c.parent_id }))
  }
  try {
    await api({ url: `/cadres/${p.id}`, method: 'delete' })
    if (snapshot) recordUndo('cadre_delete', `删除职务：${snapshot.node.name}`, snapshot)
    success('已删除')
    confirmMsg.value = null
    pendingDelete.value = null
    await loadTree()
  } catch (e) {
    error(e.response?.data?.error || '删除失败')
  }
}

// ============ 担任学生 ============
async function onRemoveMember(node, m) {
  const row = memberRow(m)
  try {
    await api({ url: `/cadres/members/${m.id}`, method: 'delete' })
    recordUndo('row_delete', `移除担任学生：${row.student_name}`, { table: 'cadre_members', row })
    success('已移除担任学生')
    await loadTree()
  } catch (e) {
    error(e.response?.data?.error || '移除失败')
  }
}

// ============ 拖拽排序（职务 & 成员，智能排表式） ============
function readDrag(e) {
  try { return JSON.parse(e.dataTransfer.getData('text/plain')) } catch (err) { return null }
}
function findNode(list, id) {
  for (const n of list) {
    if (n.id === id) return n
    if (n.children) { const r = findNode(n.children, id); if (r) return r }
  }
  return null
}
// 判断 parentId 是否在 id 的子树内（防循环）
function isDescendant(id, parentId) {
  const self = findNode(tree.value, id)
  return !!findNode(self ? self.children : [], parentId)
}
async function handleMove(payload) {
  const dragged = payload && payload.dragged
  if (!dragged) return
  const target = payload.target || {}
  try {
    if (dragged.type === 'member') await moveMember(dragged.id, target)
    else await moveCadre(dragged.id, target)
  } catch (e) {
    error(e.response?.data?.error || '移动失败')
  }
}
// 拖到设置面板 / 树状视图的空白区：职务上移到顶级并排在末尾
async function onDropEmpty(e) {
  const dragged = readDrag(e)
  if (!dragged || dragged.type !== 'cadre') return
  await handleMove({ dragged, target: { kind: 'empty' } })
}
async function moveCadre(id, target) {
  const kind = target.kind
  let parentId = 0
  let index = null
  if (kind === 'empty') {
    parentId = 0
    index = tree.value.map(n => n.id).filter(x => x !== id).length
  } else if (kind === 'child') {
    parentId = target.nodeId
    if (parentId === id || isDescendant(id, parentId)) return
  } else if (kind === 'node') {
    const t = findNode(tree.value, target.nodeId)
    if (!t) return
    parentId = t.parent_id || 0
    const sibs = parentId ? (findNode(tree.value, parentId) || { children: tree.value }).children : tree.value
    const arr = (sibs || []).map(n => n.id).filter(x => x !== id)
    let idx = arr.indexOf(target.nodeId)
    index = target.position === 'after' ? idx + 1 : idx
    if (index < 0) index = arr.length
    if (parentId === id || isDescendant(id, parentId)) return
  } else {
    return
  }
  const movedNode = findNode(tree.value, id)
  const before = { cadres: cadreState(tree.value), members: memberState(tree.value) }
  const res = await api({ url: `/cadres/${id}/move`, method: 'post', data: { parent_id: parentId, index } })
  recordMoveUndo(before, res, `调整职务：${(movedNode && movedNode.name) || `#${id}`}`)
  success('已保存职务调整')
  await loadTree()
}
async function moveMember(id, target) {
  if (!target.nodeId) return
  let cadreId = target.nodeId
  let index = null
  if (target.kind === 'member') {
    const node = findNode(tree.value, target.nodeId)
    const arr = (node?.members || []).map(m => m.id).filter(x => x !== id)
    const idx = arr.indexOf(target.memberId)
    index = idx < 0 ? arr.length : idx
  }
  const memberName = findMemberName(tree.value, id)
  const before = { cadres: cadreState(tree.value), members: memberState(tree.value) }
  const res = await api({ url: `/cadres/members/${id}/move`, method: 'post', data: { cadre_id: cadreId, index } })
  recordMoveUndo(before, res, `调整担任学生：${memberName || `#${id}`}`)
  success('已保存学生调整')
  await loadTree()
}

// 供 ClassroomView 在撤销/重做后刷新职务树（Ctrl+Z 的页面上下文由父页面持有）
defineExpose({ reload: loadTree })
</script>

