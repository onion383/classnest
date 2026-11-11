import { onMounted, onUnmounted, onActivated, onDeactivated, reactive, watch } from 'vue'
import { pushUndo, undoStatus, applyUndo } from '../api/undo'
import { reportError } from '../utils/reportError.js'
import {
  recordUndo, configureUndoRecorder, warnUndoFailed,
} from '../utils/undoRecorder.js'

// 对外保持原 API：其它页面一直从本文件 import 这两个名字。
// 实现已下沉到 utils/undoRecorder.js —— 登记入口只能有一处，失败反馈不能各写一份。
export { warnUndoFailed, newUndoBatchId } from '../utils/undoRecorder.js'

// 把真实副作用装配给纯模块：transport 走全局 axios（安全通道），
// onRegistered 刷 Ctrl+Z 可用态。装配放在这里是因为所有撤销页面都加载本模块。
configureUndoRecorder({
  transport: pushUndo,
  notifyFailure: warnUndoFailed,
  onRegistered: () => refreshUndoStatus(true),
})

// ==================== 记录一条单元格编辑撤销 ====================
// 供非 useTableCRUD 页面复用。
// key = 后端 undo 分组的表 key（须在 undo.js ALLOWED_TABLES 内）
export function recordCellUndo(key, rowId, fieldName, oldVal, newVal) {
  return recordUndo({
    key,
    type: 'cell_update',
    label: `${fieldName}：「${oldVal == null ? '' : oldVal}」→「${newVal == null ? '' : newVal}」`,
    payload: { table: key, rowId, field: fieldName, oldValue: oldVal, newValue: newVal },
  })
}

// 单元格展示文案：纯值或课表 {course} 对象都取可读文本
export function cellText(v) {
  if (v == null) return ''
  if (typeof v === 'object') return v.course || ''
  return v
}

// ==================== 批次标识 ====================
// 新批次标识与批次登记共用 utils/undoRecorder.js 的入口（见文件顶部 re-export）。

// 批次登记结束后统一刷一次可用态。
// 批次内每条登记都 force 刷新会发 N 次 /status（一次粘贴上百格就是上百次请求），
// 所以 recordGridCellUndo 在带批次时跳过刷新，改由调用方在循环结束后调这里。
export function flushUndoStatus() {
  refreshUndoStatus(true)
}

// ==================== 记录一条网格单格编辑撤销 ====================
// table 必须是后端 GRID_SOURCES 中的表名，row/col 为格子坐标（从 0 开始）。
// label：可选，传入则优先后端反馈展示（用于值日等需要自定义文案的场景）
// origin：可选，同一次动作的多条记录传同一个批次标识（见 newUndoBatchId）
export function recordGridCellUndo(key, table, row, col, oldVal, newVal, label, origin) {
  const payload = { table, row, col, oldValue: oldVal, newValue: newVal }
  if (label) payload.label = label
  const text = label || `格子(${row + 1},${col + 1})：「${cellText(oldVal)}」→「${cellText(newVal)}」`
  return recordUndo({ key, type: 'grid_cell', label: text, payload, origin: origin || '' })
}

// ==================== 记录一条网格整块覆盖撤销 ====================
// 用于整行/整列换位等批量操作，oldArr/newArr 为整个网格（数组或对象）快照。
// label：可选，传递时用于通知条展示详细文案（默认「整块变更」，后端有兜底维度文案）
// opts：可选
//   oldRows / newRows / oldCols / newCols —— 座位表「插入/删除走廊行、走廊列」会改变几何。
//     后端 grid_snapshot 只回写 JSON 列、不认行数列数，撤掉一次「插入一行/一列」之后库里
//     会变成「types 少一行、rows 还是多的」，读回被裁/降级，破坏「types 与行数列数必须同时写」。
//     四个字段必须成对透传（历史上就是只带了行、漏了列，导致第一次修复只修好一半）。
//   origin —— 批次标识。两张座位表要一起插一行（几何是共享的），撤销也得一步退完；
//     同 origin 的记录会被后端整批回退（见 routes/undo/undo.js 的 /table/:key/undo）。
export function recordGridSnapshotUndo(key, table, oldArr, newArr, label, opts = null) {
  const payload = { table, oldValue: oldArr, newValue: newArr }
  if (opts && opts.oldRows !== undefined) payload.oldRows = opts.oldRows
  if (opts && opts.newRows !== undefined) payload.newRows = opts.newRows
  // 列数必须和行数一起带：只带行数的话，撤销「插入/删除走廊列」后 types 已经多一列、
  // 后端却拿不到 cols，几何与矩阵当场分叉（读库按 cols 裁 → 座位图整体错列）。
  // 后端现在以快照里 types 的形状为准，这两个字段是老记录（没有 types）的兜底，
  // 但「同一件事抄两遍必然漏一遍」就是从这里来的，所以成对透传，别再漏。
  if (opts && opts.oldCols !== undefined) payload.oldCols = opts.oldCols
  if (opts && opts.newCols !== undefined) payload.newCols = opts.newCols
  if (label) payload.label = label
  const origin = (opts && opts.origin) || ''
  return recordUndo({ key, type: 'grid_snapshot', label: label || '整块变更', payload, origin })
}

// ==================== 记录一条动态表 增/改/删 撤销 ====================
// row 为完整记录对象（须含 id 及所有可回填列字段）。
// 返回 Promise<撤销记录 id | null>：调用方拿到 id 后可以 undoById(id) 精确撤销这一条，
// 不必走 performUndo 的「当前激活表」上下文（用户删完立刻切页面时，那个上下文已经换表了）。
// 不接返回值的既有调用方行为不变。
function pushRow(type, key, row) {
  // 返回值语义保持不变：成功给撤销记录 id（调用方据此做「撤销」提示条），失败 null。
  // 失败反馈不再由这里单独决定，统一由入口负责（原先只 console.warn，用户看不见）。
  return recordUndo({
    key,
    type,
    label: row ? `${row.姓名 || row.group_name || row.主题 || row.名称 || `#${row.id}`}` : '',
    payload: { table: key, row },
  })
}
// 添加加分/记录：undo=删除该行，redo=重新插入
export function recordRowInsert(key, row) {
  pushRow('row_insert', key, row)
}
// 删除加分/记录：undo=恢复该行，redo=再次删除。
// 返回 Promise<撤销记录 id | null>，供「撤销」提示条直接按 id 撤销（见 pushRow 说明）。
export function recordRowDelete(key, row) {
  return pushRow('row_delete', key, row)
}
// 编辑加分/记录（整条替换）：payload { rowId, oldRow, newRow }
export function recordRowUpdate(key, oldRow, newRow) {
  const payload = { table: key, rowId: newRow ? newRow.id : oldRow.id, oldRow, newRow }
  const name = (newRow || oldRow)?.姓名 || (newRow || oldRow)?.group_name || (newRow || oldRow)?.主题 || (newRow || oldRow)?.名称 || `#${payload.rowId}`
  return recordUndo({ key, type: 'row_update', label: `${name}`, payload })
}

// 删除学生（级联）：后端 delete-with-relations 一次动了七处（学生 / 请假 / 加减分 /
// 小组 / 班干部 / 座位 / 值日），必须整包登记成**一条**命令。
// 拆成多条的话，用户按 Ctrl+Z 只回来学生本身，关联还要再撤六次，中途放弃就留下半个人。
// removed 即后端响应里的快照（含 student 整行），原样存进 payload 供撤销重建。
export function recordStudentCascadeDelete(removed) {
  const student = removed && removed.student
  if (!student) return Promise.resolve(null)
  return recordUndo({
    key: 'students',
    type: 'student_cascade_delete',
    label: `删除学生「${student['姓名'] || `#${student.id}`}」及关联记录`,
    payload: removed,
  })
}

// ==================== 行顺序 / 批量行操作 ====================
// 这三种命令覆盖「一次动作改多行」的写路径（拖拽排序、勾选批量删除、Excel 导入）。
// 逐行登记会把一步操作拆成几十条撤销记录：用户要按 N 次 Ctrl+Z，且每 key 50 条上限
// 会让导入几百行时最早那批根本撤不回来。所以统一整批记一条。

// 只保留真实列：行对象上可能挂着 _rowKey / _isNew 等前端内部字段，
// redo 时按真实列重建，带进去也没用（还会把 payload 撑大）。
function plainRow(row) {
  if (!row || !Number.isInteger(row.id)) return null
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('_')) continue
    out[k] = v
  }
  return out
}

// 参与排序的行的槽位快照。position 缺失时按数组下标兜底（后端列表本来就是按 position 排的）。
function positionSnapshot(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && Number.isInteger(r.id))
    .map((r, i) => ({ id: r.id, position: Number.isInteger(r.position) ? r.position : i + 1 }))
}

// 记录一次行顺序调整：beforeRows 是动作前的全表行，afterRows 是动作后的全表行。
// 顺序没变就不登记（表头点排序、拖到自己原位等），别用空操作污染撤销栈。
export function recordRowReorder(key, beforeRows, afterRows) {
  if (!key) return Promise.resolve(null)
  const before = positionSnapshot(beforeRows)
  const after = positionSnapshot(afterRows)
  if (!before.length && !after.length) return Promise.resolve(null)
  if (JSON.stringify(before) === JSON.stringify(after)) return Promise.resolve(null)
  return recordUndo({
    key,
    type: 'row_reorder',
    label: '调整行顺序',
    payload: { table: key, before, after },
  })
}

// 记录一次批量新增（Excel 导入）：rows 为本次真正新建的完整行
export function recordRowsBatchInsert(key, rows) {
  if (!key) return Promise.resolve(null)
  const list = (Array.isArray(rows) ? rows : []).map(plainRow).filter(Boolean)
  if (!list.length) return Promise.resolve(null)
  return recordUndo({
    key,
    type: 'rows_batch_insert',
    label: `批量导入 ${list.length} 条记录`,
    payload: { table: key, rows: list },
  })
}

// 记录一次批量删除（勾选删除 / 重复项清理）：rows 为删除前的完整行
export function recordRowsBatchDelete(key, rows) {
  if (!key) return Promise.resolve(null)
  const list = (Array.isArray(rows) ? rows : []).map(plainRow).filter(Boolean)
  if (!list.length) return Promise.resolve(null)
  return recordUndo({
    key,
    type: 'rows_batch_delete',
    label: `批量删除 ${list.length} 条记录`,
    payload: { table: key, rows: list },
  })
}

// ==================== 全局撤销/重做状态（供标题栏按钮读取）====================
// 与快捷键共用同一套「当前激活页」上下文：一次只作用于最近激活的那张表。
export const undoState = reactive({
  key: null,        // 当前激活页的表 key；null 表示该页不支持撤销
  canUndo: false,
  canRedo: false,
  undoLabel: '',
  redoLabel: '',
  busy: false,      // 正在执行撤销/重做，防连点
})

// 当前激活页上下文：{ pageId, resolveKey, onAfterUndo, onAfterRedo }
let activeCtx = null
let pageCounter = 0

// 状态查询节流：同 key 在 400ms 内不重复请求（force=true 时忽略），并将过期结果丢弃
let _lastProbe = { key: '', at: 0 }
let _probeSeq = 0

// 拉取当前激活页的撤销可用态。force=true 用于「执行后/写入后/切换页」等必须即时更新的场景。
export function refreshUndoStatus(force = false) {
  const key = activeCtx ? activeCtx.resolveKey() : null
  undoState.key = key || null
  if (!key) {
    undoState.canUndo = false
    undoState.canRedo = false
    undoState.undoLabel = ''
    undoState.redoLabel = ''
    return
  }
  const now = Date.now()
  if (!force && _lastProbe.key === key && now - _lastProbe.at < 400) return
  _lastProbe = { key, at: now }
  const seq = ++_probeSeq
  undoStatus(key)
    .then(({ data }) => {
      // 过期或已切页的结果直接丢弃，避免旧 key 的状态覆盖新 key
      if (seq !== _probeSeq || undoState.key !== key) return
      undoState.canUndo = !!data.canUndo
      undoState.canRedo = !!data.canRedo
      undoState.undoLabel = data.undoLabel || ''
      undoState.redoLabel = data.redoLabel || ''
    })
    .catch(() => { /* 静默：状态查询失败不打断用户 */ })
}

// 执行撤销/重做：供标题栏按钮与快捷键共用。redo=false 撤销，redo=true 重做。
export function performUndo(redo = false) {
  const ctx = activeCtx
  if (!ctx || undoState.busy) return Promise.resolve(false)
  const key = ctx.resolveKey()
  if (!key) return Promise.resolve(false)
  undoState.busy = true
  return applyUndo(key, redo)
    .then(({ data }) => {
      if (data.ok) {
        if (redo) { if (ctx.onAfterRedo) ctx.onAfterRedo(data.label, data.change) }
        else if (ctx.onAfterUndo) ctx.onAfterUndo(data.label, data.change)
        refreshUndoStatus(true)
        return true
      }
      // 后端明确回绝（没记录可撤 / 记录已被占用）：必须给反馈。
      // 原样返回 false 的话，用户按 Ctrl+Z 或点按钮后界面毫无变化（审查 v4 · B10-05）。
      reportError(new Error(data.message || data.error || '没有可撤销的记录'), { action: redo ? '重做' : '撤销' })
      return false
    })
    .catch((err) => {
      // 网络错误同理：静默吞掉就等于「点了没反应」
      reportError(err, { action: redo ? '重做' : '撤销', hint: '本次操作未生效' })
      return false
    })
    .finally(() => { undoState.busy = false })
}

// ==================== 全局撤销/重做快捷键 ====================
// 全局 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y。每次只作用于"当前页面/当前激活的那张表"，
// 避免多表互相干扰：多个页面同时挂载时，只有最近注册（focus 激活）的那个生效。
// key 可为字符串（表 key），也可为返回字符串的函数（单个页面含多张表时按需动态切换，如班级活动/倒计时）。
export function useUndoShortcut(key, options = {}) {
  const { onAfterUndo, onAfterRedo } = options
  // 数值型"页面身份"，避免两张同页表共享一个字符串 key 时互相覆盖激活态
  const myId = ++pageCounter
  const resolveKey = () => (typeof key === 'function' ? key() : key)

  function onKeydown(e) {
    if (!activeCtx || activeCtx.pageId !== myId) return
    // 仅在表格/页面上生效，避免与输入框内原生 Ctrl+Z / 弹窗内操作冲突
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    if (!e.ctrlKey && !e.metaKey) return
    const k = e.key.toLowerCase()
    // Ctrl+Z 撤销；Ctrl+Shift+Z 或 Ctrl+Y 重做
    if (k !== 'z' && k !== 'y') return
    const redo = (k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey)
    e.preventDefault()
    performUndo(redo)
  }

  // 路由视图外层被 <KeepAlive> 包裹：切换页面不会触发 onUnmounted/onMounted。
  // 因此用 onActivated/onDeactivated 来维护「当前激活视图」的正确性（KeepAlive 也会在首次挂载时触发一次 onActivated），
  // onMounted 仅负责注册全局 keydown 监听，onUnmounted 负责移除。
  const setActive = () => {
    activeCtx = { pageId: myId, resolveKey, onAfterUndo, onAfterRedo }
    refreshUndoStatus(true)
  }
  const clearActive = () => {
    if (activeCtx && activeCtx.pageId === myId) {
      activeCtx = null
      refreshUndoStatus(true)
    }
  }

  // 页内动态 key（如活动/倒计时 tab 切换）：key 变化时刷新可用态
  watch(resolveKey, () => { if (activeCtx && activeCtx.pageId === myId) refreshUndoStatus(true) })

  onMounted(() => { setActive(); window.addEventListener('keydown', onKeydown) })
  onActivated(setActive)
  onDeactivated(clearActive)
  onUnmounted(() => { clearActive(); window.removeEventListener('keydown', onKeydown) })

  return { undoCombo: onKeydown }
}