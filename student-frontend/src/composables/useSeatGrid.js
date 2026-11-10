import { ref, computed } from 'vue'
import axios from 'axios'
import { recordGridCellUndo, recordGridSnapshotUndo, newUndoBatchId, flushUndoStatus } from './useUndo.js'
import { useNotification } from './useNotification.js'
import { createSerialSaver } from '../utils/serialSaver.js'
import { createRowReuseCache } from '../utils/rowReuse.js'
import {
  CELL, normalizeTypes, columnKinds, seatColumnIndices, rowIsAisle,
  generateColHeaders, buildSeatLikeRows, applyEditedRows, reshapeGeometry,
  usableSeatCount, toggleHole, clearHoles, insertAisleRow, removeGridRow, SEAT_MAX_ROWS,
  insertAisleColumn, removeGridColumn, SEAT_MAX_GRID_COLS,
} from './useSeatGrid.geometry.js'

// 几何纯函数（types 规整 / 表头 / 显示行 / dense 互转）都在 useSeatGrid.geometry.js，
// 这里转发出去保持既有导入点不变（SeatView / AiGridPreview / useSeatDraft 都从这里取）。
export * from './useSeatGrid.geometry.js'

export function useSeatGrid(apiBase, options = {}) {
  // undo.{key, table}：开启撤销记录；cellBase 为单格更新接口（如 /api/seats/master/cell）
  const { getStudentName = () => '', getStudentId = () => null, undo = null, cellBase = null } = options

  const loaded = ref(false)
  // 加载失败标志：原来失败只 console.error，loaded 一直是 false →
  // 表格永远停在「判定中」占位，看起来像卡住了。提到外面让表格能显示告警 + 重试。
  const loadError = ref(false)
  const rows = ref(6)
  // 网格总列数（含走廊列）。设置弹窗里的「座位列数」是另一个口径，见 seatColsToGrid。
  const cols = ref(7)
  const seats = ref([])
  const types = ref([])
  const mode = ref('single')
  const settings = ref({})
  const settingsVisible = ref(false)
  const currentEditExcludeIds = ref([])
  // 行对象复用缓存：编辑一格时只重建真正变化的那一行，避免整表重画
  const reuseRows = createRowReuseCache()

  // ==================== Computed ====================
  const colHeaders = computed(() => generateColHeaders(cols.value, types.value))

  const displayRows = computed(() => reuseRows(buildSeatLikeRows(rows.value, cols.value, types.value, (r, c) => {
    const seatVal = seats.value[r]?.[c]
    let displayName = ''
    if (seatVal === null || seatVal === undefined) {
      displayName = ''
    } else if (typeof seatVal === 'number') {
      displayName = getStudentName(seatVal) || ''
    } else {
      displayName = seatVal
    }
    return { course: displayName, extra: { _studentId: seatVal } }
  })))

  const exportFields = computed(() => {
    const fields = [{ name: '行号' }]
    colHeaders.value.forEach(h => fields.push({ name: h }))
    return fields
  })

  const exportRows = computed(() => {
    const headers = colHeaders.value
    const rows = displayRows.value
    return rows.map(row => {
      if (row._isPodium) return { '行号': '讲台', _isPodium: true, label: '讲  台' }
      const obj = { '行号': row.label }
      row.cells.forEach((cell, idx) => {
        const headerName = headers[idx] || `列${idx + 1}`
        if (cell._isAisle || cell._isAisleHidden) {
          obj[headerName] = '走廊'
          obj._aisleCell = true
        } else if (cell._blank) {
          // 与后端 tSeats 同口径：空位写「空位」，留白会跟「空着的座位」混淆
          obj[headerName] = '空位'
        } else {
          obj[headerName] = cell.course || ''
        }
      })
      return obj
    })
  })

  // ==================== 核心方法 ====================
  // 一格的文本落成什么值：候选框里明确点选的学生直接用它的 id（同名正式/临时也能区分）；
  // 手输的名字没有 _studentId，退回按姓名解析；仍解析不到就暂存姓名（等名字同步后下次保存再转 id）。
  function resolveCellValue(cell) {
    const name = cell?.course?.trim() || ''
    const pickedId = Number.isInteger(cell?._studentId) ? cell._studentId : null
    const studentId = pickedId != null ? pickedId : getStudentId(name)
    if (studentId != null) return studentId
    if (name === '') return null
    return name
  }

  function syncCellsToSeats(newRows) {
    seats.value = applyEditedRows(seats.value, newRows, cols.value, types.value, resolveCellValue)
  }

  async function load() {
    try {
      const res = await axios.get(apiBase)
      rows.value = res.data.rows
      cols.value = res.data.cols
      mode.value = res.data.mode || 'single'
      seats.value = res.data.seats || []
      types.value = normalizeTypes(res.data.types, rows.value, cols.value)
      settings.value = res.data.settings || {}
      loaded.value = true
      loadError.value = false
    } catch (e) { console.error(e); loadError.value = true }
  }

  // 串行保存器：每次编辑都 PUT 整块座位，连续操作会并发发出多个 PUT —— 后端按到达顺序写库，
  // 先发的可能后到，库里最后留下的是**更旧**的状态。串行器保证同一时刻只有一个在途，
  // 在途期间的改动合并成一轮、用最新 seats 再存一次。
  // types 必须一起提交：后端在「已有 types」时拒绝单独改 cols 的写入（防静默截掉走廊列）。
  const saver = createSerialSaver(() => axios.put(apiBase, {
    rows: rows.value, cols: cols.value, seats: seats.value,
    mode: mode.value, types: types.value,
  }))

  async function save() {
    const ok = await saver.request()
    if (!ok) {
      console.error('[seat] 保存失败', saver.error)
      // 原来只 console.error：用户看不到任何反馈，以为已经存上了。
      // 文案固定，靠 useNotification 的同文案合并避免连续编辑时刷屏。
      useNotification().error('座位保存失败，改动未保存')
    }
    return ok
  }

  // 单格更新：有 cellBase（单格接口）则只提单格，否则回退到整块 save
  async function saveSingleCell(row, col, value) {
    if (cellBase) {
      try {
        await axios.patch(cellBase, { row, col, value })
        return true
      } catch (e) {
        console.error(e)
        useNotification().error('座位保存失败，改动未保存')
      }
      return false
    }
    await save()
    return true
  }

  async function onCellsUpdate(newRows) {
    // 计算新座位矩阵并逐格对比旧值，只对发生变化的格子做单格提交 + 撤销记录
    const prev = seats.value.map(r => [...r])
    syncCellsToSeats(newRows)
    const next = seats.value
    const changed = []
    const maxR = Math.max(prev.length, next.length)
    for (let r = 0; r < maxR; r++) {
      const pr = prev[r] || []
      const nr = next[r] || []
      const maxC = Math.max(pr.length, nr.length)
      for (let c = 0; c < maxC; c++) {
        if (pr[c] !== nr[c]) changed.push([r, c])
      }
    }
    // 一次更新改动多格时共用一个批次标识：Ctrl+Z 一步退回整次改动，而不是按格数退。
    // 只改一格不加批次，保持原来的单条增量行为。
    const undoBatch = changed.length > 1 ? newUndoBatchId() : ''
    if (cellBase && changed.length) {
      // 串行提交每个格子，避免并发 PATCH 到达顺序乱序导致数据覆盖。
      // 撤销记录必须在**该格保存成功之后**再登记：原实现先登记后保存，
      // 保存失败时按 Ctrl+Z 会「撤销」一个根本没落库的改动（B12-06）。
      ;(async () => {
        for (const [r, c] of changed) {
          const ok = await saveSingleCell(r, c, next[r]?.[c] ?? null)
          if (!ok) {
            // 保存失败：以库里的真实数据为准回滚界面，并停止后续格子（避免半新半旧）
            await load()
            return
          }
          if (undo) recordGridCellUndo(undo.key, undo.table, r, c, prev[r]?.[c] ?? null, next[r]?.[c] ?? null, null, undoBatch)
        }
        // 批次登记期间不逐条刷状态，全部登记完统一刷一次（见 flushUndoStatus）
        if (undoBatch) flushUndoStatus()
      })()
    } else {
      const ok = await save()
      if (!ok) {
        await load() // 整块保存失败：回滚到库中真实数据
        return
      }
      if (undo) {
        for (const [r, c] of changed) recordGridCellUndo(undo.key, undo.table, r, c, prev[r]?.[c] ?? null, next[r]?.[c] ?? null, null, undoBatch)
        if (undoBatch) flushUndoStatus()
      }
    }
  }

  async function onSwapRows(fromIdx, toIdx) {
    if (fromIdx === 0 || toIdx === 0) return
    if (fromIdx === toIdx) return
    const seatFrom = fromIdx - 1, seatTo = toIdx - 1
    if (seatFrom < 0 || seatTo < 0 || seatFrom >= seats.value.length || seatTo >= seats.value.length) return
    // 行走廊行不参与交换：拖了只会移动数据、不会移动走廊，两者的相对位置就错了
    if (rowIsAisle(types.value, seatFrom) || rowIsAisle(types.value, seatTo)) return
    const prev = seats.value.map(r => [...r])
    const prevTypes = types.value.map(r => [...r])
    const s = [...seats.value]
    // 移动语义：取出源行后插入目标位置，中间行顺移（与拖动时的让位预览一致）
    const [moved] = s.splice(seatFrom, 1)
    s.splice(seatTo, 0, moved)
    seats.value = s
    // 几何必须跟着行一起搬：这一行上的空位（没有桌子）属于这一行，
    // 只搬 seats 会有学生落到原处留下的洞上 —— 洞里有一个人，界面看不出来。
    const t = [...types.value]
    const [movedTypes] = t.splice(seatFrom, 1)
    t.splice(seatTo, 0, movedTypes)
    types.value = t
    // 与 onCellsUpdate 统一：保存成功后才登记撤销；失败以库中数据回滚。
    const ok = await save()
    if (!ok) { await load(); return }
    if (undo) recordGridSnapshotUndo(undo.key, undo.table, { seats: prev, types: prevTypes }, { seats: s, types: t })
  }

  async function onSwapColumns(fromCol, toCol) {
    if (fromCol === toCol) return
    const kinds = columnKinds(cols.value, types.value)
    if (kinds[fromCol] !== 'seat' || kinds[toCol] !== 'seat') return
    // 含走廊格的列（局部走廊 / 行列表交叉）不动：只搬 seats 不搬 types 会让走廊与数据错位
    const hasAisleCell = (c) => (types.value || []).some(line => Array.isArray(line) && line[c] === CELL.AISLE)
    if (hasAisleCell(fromCol) || hasAisleCell(toCol)) return
    const prev = seats.value.map(r => [...r])
    const prevTypes = types.value.map(r => [...r])
    // 移动语义：源列取出后插入目标位置，中间列的数据顺移（表头固定不动）
    const move = (line) => {
      const nr = [...line]
      const [moved] = nr.splice(fromCol, 1)
      nr.splice(toCol, 0, moved)
      return nr
    }
    const newSeats = seats.value.map(move)
    seats.value = newSeats
    // 同理：这一列上的空位跟着列一起走，否则洞留在原地、学生被搬到洞上
    const newTypes = types.value.map(move)
    types.value = newTypes
    // 与 onCellsUpdate 统一：保存成功后才登记撤销；失败以库中数据回滚。
    const ok = await save()
    if (!ok) { await load(); return }
    if (undo) recordGridSnapshotUndo(undo.key, undo.table, { seats: prev, types: prevTypes }, { seats: newSeats, types: newTypes })
  }

  function onCellDblClick({ rowIdx, colIdx }) {
    const row = displayRows.value[rowIdx]
    if (!row || row._isReadonly || row._isPodium) return
    const cell = row.cells[colIdx]
    if (cell._isAisle || cell._isAisleHidden || cell._blank) return
    const seatRowIdx = row._lessonIdx
    if (seatRowIdx < 0 || seatRowIdx >= seats.value.length) return
    const occupied = new Set()
    seats.value.forEach((r, ri) => {
      r.forEach((id, ci) => {
        if (id && !(ri === seatRowIdx && ci === colIdx)) occupied.add(id)
      })
    })
    currentEditExcludeIds.value = Array.from(occupied)
  }

  // 设置：newCols 是「座位列数」（用户视角），内部换算成网格总列数再落库。
  // 几何决策（含「手绘空位必须跟着座位列序号搬」）全在 reshapeGeometry 里：
  // 这里只做接线，不要再自己拼 formulaTypes —— 那会把空位全冲掉，且无任何提示。
  async function saveSettings({ rows: newRows, cols: newCols, mode: newMode }) {
    const next = reshapeGeometry(seats.value, cols.value, types.value, newRows, newCols, newMode)
    rows.value = newRows
    cols.value = next.gridCols
    mode.value = newMode
    types.value = next.types
    seats.value = next.seats
    settingsVisible.value = false
    await save()
  }

  // ==================== 设置空位（画笔）====================
  // 画笔模式下 types 就地改（界面立刻能看到洞），但**不落库**：
  // 用户可能点错好几格，必须能「退出/取消」一次回到进入前的状态。
  // 所以进入时留一份快照，取消用它回滚、确认用它登记撤销。
  const holeMode = ref(false)
  // 非响应式：只给回滚/对比用，不需要参与渲染
  let holeSnapshot = null
  const usableSeats = computed(() => usableSeatCount(types.value))

  function enterHoleMode() {
    holeSnapshot = {
      types: JSON.parse(JSON.stringify(types.value)),
      seats: (seats.value || []).map((r) => (Array.isArray(r) ? [...r] : [])),
    }
    holeMode.value = true
  }

  // 退出画笔。revert=true 表示取消：把 types/seats 恢复到进入前。
  function exitHoleMode(revert = true) {
    if (revert && holeSnapshot) {
      // 拷贝：快照本身要保持干净，否则「退出 → 再进入 → 退出」会用上一次的快照回滚
      types.value = holeSnapshot.types.map((r) => [...r])
      seats.value = holeSnapshot.seats.map((r) => [...r])
    }
    holeSnapshot = null
    holeMode.value = false
  }

  // 点一格：座位 ↔ 空位。返回 { ok, reason }，由调用方决定怎么提示
  // （校验规则在 geometry.toggleHole 里，纯函数可单测）。
  function toggleHoleAt(rowIdx, colIdx) {
    if (!holeMode.value) return { ok: false, reason: 'idle' }
    const line = types.value[rowIdx]
    if (!Array.isArray(line)) return { ok: false, reason: 'outside' }
    const res = toggleHole(types.value, seats.value, rowIdx, colIdx)
    if (!res.ok) return res
    types.value = res.types
    // 空位格必须没有数据：挖洞成功后把该格清掉（toggleHole 已保证挖之前是空的，
    // 这里再写一次是为了「从别处搬来的人」这类不一致数据也能自愈）
    if (res.to === CELL.BLANK && Array.isArray(seats.value[rowIdx])) seats.value[rowIdx][colIdx] = null
    return { ok: true, to: res.to }
  }

  function clearAllHoles() {
    if (!holeMode.value) return
    types.value = clearHoles(types.value)
  }

  // 确认空位：一次整块提交（seats + types）。
  // 不能走单格 PATCH —— 那条路只写 seats，几何不会跟着走（见 routes/seats.js 的注释）。
  async function confirmHoleMode() {
    const before = holeSnapshot
    const nextTypes = types.value
    const nextSeats = seats.value
    holeMode.value = false
    holeSnapshot = null
    if (!before) return true
    const changed = JSON.stringify(before.types) !== JSON.stringify(nextTypes)
    if (!changed) return true
    const ok = await save()
    if (!ok) {
      // 保存失败：回滚到进入前的几何，否则界面留着一份库里没有的「洞」
      types.value = before.types.map((r) => [...r])
      seats.value = before.seats.map((r) => [...r])
      return false
    }
    if (undo) {
      recordGridSnapshotUndo(
        undo.key, undo.table,
        { seats: before.seats, types: before.types },
        { seats: nextSeats, types: nextTypes },
        '设置空位'
      )
    }
    return true
  }

  // 整块替换座位并保存。
  // 失败时本地已经是新数据、库里还是旧的 —— 重新 load 一次把界面拉回真实状态，
  // 并把 ok 返回给调用方：否则调用方会无条件弹「导入成功」，用户以为存上了。
  async function saveSeats(newSeats) {
    seats.value = newSeats
    const ok = await save()
    if (!ok) {
      try { await load() } catch (_) { /* 回滚也失败时保留 save 已给出的失败提示 */ }
    }
    return ok
  }

  // 行走廊：行标签右键「上方/下方插入走廊」与「删除这条走廊」。
  // 与空位一样走**整块**保存（seats + types 一起提交），单格 PATCH 那条路只写 seats，
  // rows/types 不会跟着走。插入/删除都会改变 rows —— 必须连 rows 一起落库，
  // 否则后端按旧 rows 裁 types，界面上的新走廊下次读回来就没了。
  // 返回 { ok, reason }：reason 区分「超上限」和「保存失败」，方便调用方给准确提示。
  async function insertAisleRowAt(at, opts = {}) {
    if (rows.value + 1 > SEAT_MAX_ROWS) return { ok: false, reason: 'limit' }
    const before = snapshotGeometry()
    const next = insertAisleRow(types.value, seats.value, rows.value, cols.value, at)
    types.value = next.types
    seats.value = next.seats
    rows.value = next.rows
    const ok = await save()
    if (!ok) {
      restoreGeometry(before)
      return { ok: false, reason: 'save' }
    }
    recordGeometryUndo(before, '插入走廊行', opts)
    return { ok: true, rows: next.rows }
  }

  async function removeRowAt(at, opts = {}) {
    const next = removeGridRow(types.value, seats.value, rows.value, cols.value, at)
    // rows ≤ 1 或越界：删了就没有几何了，调用方按「不能删」处理
    if (!next) return { ok: false, reason: 'invalid' }
    const before = snapshotGeometry()
    types.value = next.types
    seats.value = next.seats
    rows.value = next.rows
    const ok = await save()
    if (!ok) {
      restoreGeometry(before)
      return { ok: false, reason: 'save' }
    }
    recordGeometryUndo(before, '删除走廊行', opts)
    return { ok: true, rows: next.rows, removedSeats: next.removedSeats }
  }

  // 列走廊：列头右键「左侧/右侧插入走廊」与「删除这条走廊」。与行版完全对称 ——
  // 同样整块保存（types + seats + cols 一起提交），同样返回 { ok, reason } 让调用方
  // 区分「超上限」和「保存失败」。删除列的 removedSeats 是该列原本坐着的人。
  async function insertAisleColAt(at, opts = {}) {
    // opts.mode：拆桌/合并桌子时会把模式切成 mixed（「动过合并按钮就显示混合桌」）。
    // 它跟几何同一笔 save —— 分两次请求会出现「列已经插了、模式还是单座」的中间态。
    // 撤销不需要管 mode：mixed 按走廊分桌，几何退回后桌型自然也跟着退回。
    const beforeMode = mode.value
    if (opts.mode) mode.value = opts.mode
    if (cols.value + 1 > SEAT_MAX_GRID_COLS) { mode.value = beforeMode; return { ok: false, reason: 'limit' } }
    const before = snapshotGeometry()
    const next = insertAisleColumn(types.value, seats.value, rows.value, cols.value, at)
    types.value = next.types
    seats.value = next.seats
    cols.value = next.cols
    const ok = await save()
    if (!ok) {
      restoreGeometry(before)
      mode.value = beforeMode
      return { ok: false, reason: 'save' }
    }
    recordGeometryUndo(before, '插入走廊列', opts)
    return { ok: true, cols: next.cols }
  }

  async function removeColAt(at, opts = {}) {
    // opts.mode：拆桌/合并桌子时会把模式切成 mixed（「动过合并按钮就显示混合桌」）。
    // 它跟几何同一笔 save —— 分两次请求会出现「列已经插了、模式还是单座」的中间态。
    // 撤销不需要管 mode：mixed 按走廊分桌，几何退回后桌型自然也跟着退回。
    const beforeMode = mode.value
    if (opts.mode) mode.value = opts.mode
    const next = removeGridColumn(types.value, seats.value, rows.value, cols.value, at)
    // cols ≤ 1 或越界：删了就没有几何了
    if (!next) { mode.value = beforeMode; return { ok: false, reason: 'invalid' } }
    const before = snapshotGeometry()
    types.value = next.types
    seats.value = next.seats
    cols.value = next.cols
    const ok = await save()
    if (!ok) {
      restoreGeometry(before)
      mode.value = beforeMode
      return { ok: false, reason: 'save' }
    }
    recordGeometryUndo(before, '删除走廊列', opts)
    return { ok: true, cols: next.cols, removedSeats: next.removedSeats }
  }

  function snapshotGeometry() {
    return {
      rows: rows.value,
      cols: cols.value,
      types: (types.value || []).map((line) => [...line]),
      seats: (seats.value || []).map((line) => (Array.isArray(line) ? [...line] : [])),
    }
  }

  function restoreGeometry(snap) {
    rows.value = snap.rows
    cols.value = snap.cols
    types.value = snap.types
    seats.value = snap.seats
  }

  // 撤销登记：oldRows/newRows（以及列版的 oldCols/newCols）必须一起带上 ——
  // 后端 grid_snapshot 只回写 JSON 列，不认行数/列数；不带的话撤掉一次插入之后
  // 库里是「types 少一行/一列、rows 或 cols 还是多的」，读回被裁/降级。
  // opts.origin：两张座位表一起插入时共用一个批次标识 —— 一次 Ctrl+Z 整批退回一步，
  // 否则按一次只撤一张表，界面看着没反应（撤的那张不是当前显示的）。
  function recordGeometryUndo(before, label, opts = {}) {
    if (!undo) return
    recordGridSnapshotUndo(
      undo.key, undo.table,
      { seats: before.seats, types: before.types },
      { seats: seats.value, types: types.value },
      label,
      {
        oldRows: before.rows, newRows: rows.value,
        oldCols: before.cols, newCols: cols.value,
        origin: opts.origin || '',
      }
    )
  }

  // 该行当前有几名学生（删除行前用于确认提示；走廊里不该有人，也一并统计）
  function rowStudentCount(r) {
    const line = seats.value?.[r]
    return Array.isArray(line) ? line.filter((v) => v != null && v !== '').length : 0
  }

  // 该列当前有几名学生（删除列前用于确认提示）
  function colStudentCount(c) {
    let n = 0
    for (const line of seats.value || []) {
      if (!Array.isArray(line)) continue
      const v = line[c]
      if (v != null && v !== '') n++
    }
    return n
  }

  return {
    loaded, loadError, rows, cols, seats, types, mode, settings, settingsVisible, currentEditExcludeIds,
    colHeaders, displayRows, exportFields, exportRows,
    load, save, saveSeats, onCellsUpdate, onSwapRows, onSwapColumns, onCellDblClick, saveSettings,
    generateColHeaders, seatColumnIndices,
    // 设置空位（画笔）
    holeMode, usableSeats, enterHoleMode, exitHoleMode, toggleHoleAt, clearAllHoles, confirmHoleMode,
    // 整行走廊（行标签右键）—— 插入/删除整行，不是「把某行覆盖成走廊」
    insertAisleRowAt, removeRowAt, rowStudentCount,
    // 整列走廊（列头右键）—— 与行版对称
    insertAisleColAt, removeColAt, colStudentCount,

  }
}
