<template>
  <div>
    <!-- 读取中 -->
    <div v-if="loading" class="px-2 py-1.5 text-xs text-text-muted">正在整理网格预览…</div>
    <!-- 无法还原成网格：由调用方回退到其它展示方式（此处仅提示） -->
    <div v-else-if="error" class="rounded-lg border border-border px-3 py-2 text-xs text-text-muted">{{ error }}</div>
    <!-- 只读网格：直接复用各页面同款 GridView 组件 -->
    <!-- maxHeight=0：本组件总是出现在弹窗/面板里（外层自带滚动），再限高会形成嵌套滚动条 -->
    <GridView
      v-else
      readonly
      :colHeaders="colHeaders"
      :rows="rows"
      :hideMetaColumns="hideMetaColumns"
      :showRowNumber="showRowNumber"
      :rowHeaderLabel="rowHeaderLabel"
      :showPeriodColumn="showPeriodColumn"
      :minTableHeight="120"
      :maxHeight="0"
    />
  </div>
</template>

<script>
import { apiFetch } from '../../utils/apiUrl.js'
import { registerUserScopedReset } from '../../utils/userScopedCache.js'
// 带账号代次的进程内缓存（换号时连在途响应一起作废）；见该文件头部的泄漏事故说明
import { createSequencedCache } from '../../utils/sequencedCache.js'

// 日期表头兜底（课表/值日缺省时）
const DEFAULT_DAYS = ['周一', '周二', '周三', '周四', '周五']
// 课表时段分组名称与顺序（与课程表页保持一致）
const SECTION_NAMES = { morning: '上午', noon: '中午', afternoon: '下午', evening: '傍晚', night: '晚上' }
const SECTION_ORDER = ['morning', 'noon', 'afternoon', 'evening', 'night']

// 各网格表所属家族，决定用哪种方式还原（不在此列的表面包表无法网格预览，回退原样展示）
const FAMILY = {
  seat_layout: 'seat',
  seat_template: 'seat',
  seat_weight: 'seatWeight',
  schedule: 'schedule',
  master_schedule: 'schedule',
  duty_layout: 'duty',
  duty_template: 'duty',
}
// 供提案预览 / 记录块判断是否走网格展示
export const GRID_TABLES = Object.keys(FAMILY)

// 学生 id→姓名 映射：座位表里存的是学生 id，需还原成姓名展示。
// 用 utils/sequencedCache 而不是自己写 TTL：模块级缓存 + 异步加载 + 换号三者凑一起时，
// 「登出时清缓存」挡不住「清完之后旧响应才回来」——A 的姓名会被写回缓存给 B 看。
// 那个模块在写入前核对账号代次，是这类缓存唯一被允许的写法。
const studentMapCache = createSequencedCache({ load: loadStudentList, ttl: 60 * 1000 })

async function loadStudentList() {
  try {
    const r = await apiFetch('/api/students')
    const j = await r.json()
    // /api/students 返回 { data: [...], fields: [...] }；这里兼容几种可能的包裹形式
    const list = Array.isArray(j) ? j
      : Array.isArray(j.data) ? j.data
      : (j.data && j.data.rows) || j.rows || []
    return new Map(list.map((s) => [s.id, s.姓名 || '']))
  } catch (e) {
    // 拉取失败不能缓存空表（否则之后永远显示空白）：返回 null = 本次没拿到，下次重新请求
    return null
  }
}

async function getStudentMap() {
  // 没拿到（失败 / 换了号）时给空表：这次预览短暂显示 id，也绝不跨账号显示姓名
  return (await studentMapCache.get()) || new Map()
}

// 这份 id→姓名 映射是**跟着登录用户走**的进程内缓存，登记到用户级清理表：
// invalidate 同时做两件事 —— 清值 + 让在途请求作废（少任一件都还会泄漏）。
registerUserScopedReset(() => studentMapCache.invalidate())
</script>

<script setup vapor>
import GridView from './GridView/GridView.vue'
import { generateColHeaders, buildSeatLikeRows } from '../../composables/useSeatGrid.js'
// 组件内「只认最后一次请求」的序号守卫（换表/换 override 时丢弃旧响应）
import { createLatest } from '../../utils/latestOnly.js'
import { ref, watch } from 'vue'

// AI 网格预览：按表名取当前行（id=1），还原成 GridView 的 colHeaders + rows 只读展示。
// override 用于提案预览——用「将要写入的新值」覆盖当前行对应列后再还原。
defineOptions({ name: 'AiGridPreview' })

const props = defineProps({
  table: { type: String, required: true },
  override: { type: Object, default: null },
})

const loading = ref(true)
const error = ref('')
const colHeaders = ref([])
const rows = ref([])
const hideMetaColumns = ref(false)
const showRowNumber = ref(false)
const rowHeaderLabel = ref('行号')
const showPeriodColumn = ref(false)

watch(() => props.table, load)
watch(() => props.override, load)

// 列值可能是 JSON 文本（取数接口原样返回），也可能已是对象（提案里的新值）
function parse(v, fallback) {
  if (v == null) return fallback
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch (e) { return fallback }
}
function applyStyle(o) {
  colHeaders.value = o.colHeaders
  rows.value = o.rows
  hideMetaColumns.value = !!o.hideMetaColumns
  showRowNumber.value = !!o.showRowNumber
  rowHeaderLabel.value = o.rowHeaderLabel || '行号'
  showPeriodColumn.value = !!o.showPeriodColumn
}
// 表名/覆盖值可能连续变化（watch 会连续触发 load）：
// 用请求序号丢弃旧响应，避免旧表的数据覆盖新表的预览（B11-06）
async function load() {
  const my = seq.begin()
  loading.value = true; error.value = ''
  const family = FAMILY[props.table]
  if (!family) { error.value = '该表暂不支持网格预览'; loading.value = false; return }
  try {
    const r = await apiFetch(`/api/ai/records/${props.table}?ids=1`)
    const j = await r.json()
    if (!seq.isCurrent(my)) return
    if (!r.ok || !j.success) throw new Error(j.error || '读取失败')
    const base = (j.data && j.data.rows && j.data.rows[0]) || {}
    const row = { ...base, ...(props.override || {}) }
    let built = null
    if (family === 'schedule') built = buildSchedule(row)
    else if (family === 'seatWeight') built = buildSeatWeight(row)
    else if (family === 'seat') built = await buildSeat(row)
    else if (family === 'duty') built = buildDuty(row)
    // buildSeat 里还 await 了学生名映射，期间可能已切到别的表：再核对一次序号
    if (!seq.isCurrent(my)) return
    if (!built) { error.value = '该数据暂无法还原成网格'; return }
    applyStyle(built)
  } catch (e) {
    if (!seq.isCurrent(my)) return
    error.value = e.message || '读取失败'
  } finally {
    // 只由最新请求关闭 loading
    if (seq.isCurrent(my)) loading.value = false
  }
}
// 座位表：与座位页同款几何（讲台行 + 真实走廊列 + 空位），数值格把学生 id 还原成姓名。
// 几何来自 types（网格矩阵），不再按 mode/showAisle 自己插走廊列 —— 插两次就会翻倍。
async function buildSeat(row) {
  const rowsN = Number(row.rows) || 0
  const colsN = Number(row.cols) || 0
  if (!rowsN || !colsN) return null
  const seats = parse(row.seats, []) || []
  const types = parse(row.types, []) || []
  const map = await getStudentMap()
  const valueAt = (r, c) => {
    const v = seats[r] && seats[r][c]
    let name = ''
    if (v != null) name = typeof v === 'number' ? (map.get(v) || String(v)) : String(v)
    return { course: name }
  }
  return {
    colHeaders: generateColHeaders(colsN, types),
    rows: buildSeatLikeRows(rowsN, colsN, types, valueAt),
    hideMetaColumns: true, showRowNumber: true, rowHeaderLabel: '行号', showPeriodColumn: false,
  }
}
// 座位权重表：几何与座位表同一套 types，数值格放权重数字
function buildSeatWeight(row) {
  const rowsN = Number(row.rows) || 0
  const colsN = Number(row.cols) || 0
  if (!rowsN || !colsN) return null
  const types = parse(row.types, []) || []
  const weights = parse(row.weights, []) || []
  const valueAt = (r, c) => { const v = weights[r] && weights[r][c]; return { course: v == null ? '' : String(v) } }
  return {
    colHeaders: generateColHeaders(colsN, types),
    rows: buildSeatLikeRows(rowsN, colsN, types, valueAt),
    hideMetaColumns: true, showRowNumber: true, rowHeaderLabel: '行号', showPeriodColumn: false,
  }
}
// 课表：settings.sections 有则按「上午/中午…」分组，否则一节一行
function buildSchedule(row) {
  const cells = parse(row.cells, []) || []
  const settings = parse(row.settings, {}) || {}
  const days = (settings.days && settings.days.length) ? settings.days : DEFAULT_DAYS
  const sections = settings.sections
  const rows = []
  if (sections) {
    let lessonIdx = 0
    SECTION_ORDER.forEach((secKey) => {
      const items = sections[secKey] || []
      const sectionName = SECTION_NAMES[secKey] || secKey
      items.forEach((item, idx) => {
        const r = {
          _rowKey: `${secKey}_${idx}`, label: item.name,
          time: item.start && item.end ? `${item.start}-${item.end}` : '',
          _isSeparator: false, _mergeCells: item.type !== 'lesson', _isReadonly: item.type !== 'lesson',
          periodLabel: idx === 0 ? sectionName : '', _periodRowSpan: idx === 0 ? items.length : 0, cells: [],
        }
        if (item.type === 'lesson') {
          const lessonCells = (cells[lessonIdx] || []).slice(0, days.length)
          while (lessonCells.length < days.length) lessonCells.push({ course: '' })
          r.cells = lessonCells; r._lessonIdx = lessonIdx; lessonIdx++
        } else {
          r.cells = Array(days.length).fill({ course: '' })
        }
        rows.push(r)
      })
    })
  } else {
    cells.forEach((lessonCells, i) => {
      const cs = (lessonCells || []).slice(0, days.length)
      while (cs.length < days.length) cs.push({ course: '' })
      rows.push({ _rowKey: 'l' + i, label: `第${i + 1}节`, time: '', _isSeparator: false, _isReadonly: false, cells: cs, _lessonIdx: i })
    })
  }
  return { colHeaders: days, rows, hideMetaColumns: false, showRowNumber: false, rowHeaderLabel: '节次', showPeriodColumn: !!sections }
}
// 值日：cells 形如 {项目:{星期:[人名]}}，每个项目按人数拆成多行，首行跨行合并显示项目名
function buildDuty(row) {
  const cells = parse(row.cells, {}) || {}
  const settings = parse(row.settings, {}) || {}
  const items = Object.keys(cells)
  if (!items.length) return null
  let days = (settings.days && settings.days.length) ? settings.days : []
  if (!days.length) {
    const seen = []
    items.forEach((it) => Object.keys(cells[it] || {}).forEach((d) => { if (!seen.includes(d)) seen.push(d) }))
    days = seen.length ? seen : DEFAULT_DAYS
  }
  const rows = []
  items.forEach((name) => {
    const perDay = cells[name] || {}
    let n = 1
    days.forEach((d) => { const arr = perDay[d]; if (Array.isArray(arr)) n = Math.max(n, arr.length) })
    for (let k = 0; k < n; k++) {
      rows.push({
        _rowKey: `${name}_${k}`, label: name, _isReadonly: true,
        _rowHeaderRowSpan: k === 0 ? n : 0,
        cells: days.map((d) => ({ course: (perDay[d] && perDay[d][k]) || '' })),
      })
    }
  })
  return { colHeaders: days, rows, hideMetaColumns: true, showRowNumber: true, rowHeaderLabel: '劳动项目', showPeriodColumn: false }
}

// 请求序号挂实例上：Options API 没有 setup 作用域；序号不参与渲染，不必进 data
const seq = createLatest()
load()
</script>
