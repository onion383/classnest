// =========================================================================
// drag-probe.js —— 网格表格（GridView）行拖拽的离线探针页
//
// 目的：不依赖真实业务页面，直接挂一个 GridView + 造一份「课表结构」的假数据
// （含大课间/午休/休息这类 _mergeCells 的固定行），然后用**真实的 mousedown /
// mousemove / mouseup** 连拖几次，把每次拖完的 DOM 结果打出来：
//   · 行 label 的视觉顺序（从 DOM 读，绕过数据）
//   · 每行的 transform（残留检测）
//   · 相邻行是否重叠（乱掉的判据）
//
// 用法：electron 打开 http://127.0.0.1:5173/drag-probe.html
//       探针跑完会 console.log('__PROBE_DONE__')
// =========================================================================
import { createApp, h, nextTick } from 'vue'
import GridView from './components/tables/GridView/GridView.vue'

const DAYS = ['周一', '周二', '周三', '周四', '周五']
const emptyCell = () => ({ course: '' })
const cell = (t) => ({ course: t || '' })

// 与 ScheduleView.buildDisplayRows 同构：section 首行带 periodLabel + _periodRowSpan，
// type !== 'lesson' 的行是休息行（_isReadonly + _mergeCells）
function buildRows() {
  const sections = [
    { name: '上午', span: 5, items: [['第1节', '08:10-08:55', 'lesson'], ['第2节', '09:05-09:50', 'lesson'], ['大课间', '09:50-10:20', 'rest'], ['第3节', '10:20-11:05', 'lesson'], ['第4节', '11:15-12:00', 'lesson']] },
    { name: '中午', span: 2, items: [['午休', '12:00-13:00', 'rest'], ['午自习', '13:00-14:00', 'rest']] },
    { name: '下午', span: 2, items: [['第5节', '14:30-15:15', 'lesson'], ['第6节', '15:25-16:10', 'lesson']] },
    { name: '晚上', span: 2, items: [['晚修1', '19:00-19:45', 'lesson'], ['晚修2', '19:55-20:40', 'lesson']] },
  ]
  const rows = []
  let lesson = 0
  // 讲台行：真实课表第一行就是它（_isPodium，不可拖、不可作落点）
  rows.push({
    _rowKey: 'podium',
    _isPodium: true,
    label: '讲台',
    cells: DAYS.map(emptyCell),
  })
  sections.forEach((sec) => {
    sec.items.forEach((it, idx) => {
      const [label, time, type] = it
      const isLesson = type === 'lesson'
      const r = {
        _rowKey: `${sec.name}_${idx}`,
        label,
        time,
        _isSeparator: false,
        _isReadonly: !isLesson,
        _mergeCells: !isLesson,
        periodLabel: idx === 0 ? sec.name : '',
        _periodRowSpan: idx === 0 ? sec.span : 0,
        cells: [],
      }
      if (isLesson) {
        r.cells = DAYS.map((_, d) => cell(`${label}-${DAYS[d]}`))
        // 复现真实数据：长文本（截图里那种三四十字的内容）
        if (label === '第2节') r.cells[0] = cell('回家吧把喝酒不喝酒不喝酒比较方便方便常见的吃吧吃吧动画剧场版动画剧本成绩不好不喜欢疾病的信号基本分析部分九八四进行VS规划VS官方v覆盖全省规划')
        r._lessonIdx = lesson++
      } else {
        r.cells = DAYS.map(emptyCell)
      }
      rows.push(r)
    })
  })
  return rows
}

const rows = buildRows()
const app = createApp({
  setup() {
    return () => h(GridView, {
      colHeaders: DAYS,
      rows,
      showPeriodColumn: true,
      rowHeaderLabel: '节次',
      maxHeight: 560,
      disableRowDrag: false,
      // 拖行时组件会 emit swapRows；探针里自己按 splice 落位，保证「再拖一次」是新数据
      onSwapRows: (from, to) => {
        const lessonRows = rows.filter((r) => r._lessonIdx !== undefined)
        const a = lessonRows[from] && lessonRows[from]._lessonIdx
        const b = lessonRows[to] && lessonRows[to]._lessonIdx
        if (a == null || b == null) return
        const moved = rows.filter((r) => r._lessonIdx !== undefined)
        // 直接改 cells 顺序，模拟父组件的落位
        const cellsList = moved.map((r) => r.cells)
        const [m] = cellsList.splice(a, 1)
        cellsList.splice(b, 0, m)
        moved.forEach((r, i) => { r.cells = cellsList[i] })
      },
    })
  },
})
window.__ROWDBG = true
app.mount('#app')

// ---------------------------------------------------------------- 自动化
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fire = (el, type, x, y) => el.dispatchEvent(new MouseEvent(type, {
  bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0,
}))

function snap(tag) {
  const trs = Array.from(document.querySelectorAll('#app tbody tr'))
  // 被隐藏的源行（visibility:hidden）不参与重叠判定：它不绘制，rect 仍在只是布局占位
  const items = trs.filter((tr) => {
    // 源行的内容层被隐藏（visibility:hidden），它不绘制，rect 仍占位 → 不参与判定
    const c = tr.querySelector('[data-cell-content]')
    return getComputedStyle(c || tr).visibility !== 'hidden'
  }).map((tr) => {
    const r = tr.getBoundingClientRect()
    const label = ((tr.querySelector('td:nth-child(2)') || {}).textContent || '').replace('⠿', '')
    // 行本身不再位移（网格不动），视觉位置看**内容层** [data-cell-content]
    const c = tr.querySelector('[data-cell-content]')
    const cr = c ? c.getBoundingClientRect() : r
    return {
      label: label.trim(),
      top: Math.round(cr.top),
      bottom: Math.round(cr.bottom),
      transform: c ? (c.style.transform || '') : '',
      opacity: getComputedStyle(tr).opacity,
      vis: c ? getComputedStyle(c).visibility : getComputedStyle(tr).visibility,
    }
  })
  // 乱掉的判据：**按视觉 top 排序后**，相邻两行垂直方向重叠超过 2px。
  // 不能按 DOM 顺序比较 —— 让位后行序在视觉上会换（第3节跑到大课间上面），
  // 按 DOM 顺序比必然误报。
  const sorted = items.slice().sort((a, b) => a.top - b.top)
  const overlaps = []
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].top < sorted[i - 1].bottom - 2) {
      overlaps.push(`${sorted[i - 1].label || '空行'}(${sorted[i - 1].top}-${sorted[i - 1].bottom})↔${sorted[i].label || '空行'}(${sorted[i].top}-${sorted[i].bottom})`)
    }
  }
  // 合并格（上午/下午/晚上）对不齐诊断：td 的实际矩形 vs 它 rowspan 覆盖那几行的视觉范围
  const trAll = Array.from(document.querySelectorAll('#app tbody tr'))
  const periods = Array.from(document.querySelectorAll('#app [data-period-cell]')).map((td) => {
    const tr = td.closest('tr')
    const idx = trAll.indexOf(tr)
    const span = Number(td.getAttribute('rowspan') || 1)
    const rows = trAll.slice(idx, idx + span)
    // 量内层元素（拖动时被临时撑高/偏移的就是它），td 的布局高度永远不变
    const r = (td.firstElementChild || td).getBoundingClientRect()
    const top = Math.min(...rows.map((x) => x.getBoundingClientRect().top))
    const bottom = Math.max(...rows.map((x) => x.getBoundingClientRect().bottom))
    return {
      label: (td.textContent || '').trim(),
      span,
      td: `${Math.round(r.top)}-${Math.round(r.bottom)}`,
      rows: `${Math.round(top)}-${Math.round(bottom)}`,
      aligned: Math.abs(r.top - top) <= 2 && Math.abs(r.bottom - bottom) <= 2,
    }
  })
  if (periods.length) console.log(`[probe] ${tag} period=${JSON.stringify(periods)}`)
  console.log(`[probe] ${tag} overlaps=${overlaps.length ? overlaps.join(',') : 'none'}`)
  console.log(`[probe] ${tag} order=${items.map((i) => i.label).join(' | ')}`)
  const dirty = items.filter((i) => i.transform || i.opacity !== '1')
  if (dirty.length) console.log(`[probe] ${tag} dirty=${JSON.stringify(dirty)}`)
  return { items, overlaps }
}

// 找到「第 n 个可拖行的行手柄」中心点
function handleAt(rowIdx) {
  const trs = Array.from(document.querySelectorAll('#app tbody tr'))
  const tr = trs[rowIdx]
  if (!tr) return null
  const h = tr.querySelector('.drag-handle')
  if (!h) return null
  const r = h.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
}

function rowCenterY(rowIdx) {
  const tr = document.querySelectorAll('#app tbody tr')[rowIdx]
  if (!tr) return 0
  const r = tr.getBoundingClientRect()
  return Math.round(r.top + r.height / 2)
}

async function dragRow(fromIdx, toIdx) {
  const tr = document.querySelectorAll('#app tbody tr')[fromIdx]
  const handle = tr && tr.querySelector('.drag-handle')
  if (!handle) { console.log(`[probe] no handle for row ${fromIdx}`); return }
  const hr = handle.getBoundingClientRect()
  const p = { x: Math.round(hr.left + hr.width / 2), y: Math.round(hr.top + hr.height / 2) }
  const ghostCount = () => document.querySelectorAll('body > div[style*="position: fixed"]').length
  const before = ghostCount()
  fire(handle, 'mousedown', p.x, p.y)
  await sleep(60)
  console.log(`[probe]   mousedown → ghost ${before}→${ghostCount()} handleRect=${JSON.stringify({ x: p.x, y: p.y, w: Math.round(hr.width), h: Math.round(hr.height) })}`)
  // 虚影体检：内容层方案下，源行内容被 visibility:hidden，如果虚影克隆的是「隐藏后」的 DOM，
  // 虚影里就是空白 —— 这是「虚影根本没出来」的真正原因候选
  const dumpGhost = (tag) => {
    const ghosts = Array.from(document.querySelectorAll('body > div[style*="position: fixed"]'))
    const info = ghosts.map((g) => {
      const txt = (g.innerText || '').replace(/\s+/g, ' ').trim()
      const r = g.getBoundingClientRect()
      return { text: txt.slice(0, 30), len: txt.length, top: Math.round(r.top), h: Math.round(r.height), op: getComputedStyle(g).opacity }
    })
    console.log(`[probe]   ghost@${tag} ` + JSON.stringify(info))
  }
  dumpGhost('down')
  const y0 = rowCenterY(fromIdx)
  const y1 = rowCenterY(toIdx)
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    const y = Math.round(y0 + ((y1 - y0) * i) / steps)
    fire(window, 'mousemove', p.x, y)
    await sleep(16)
  }
  await sleep(200)
  dumpGhost('mid')
  // 关键判据必须在 mouseup **之前**采：松手后位移会被 clearShift 清掉
  snap(`mid#${fromIdx}->${toIdx}`)
  fire(window, 'mouseup', p.x, y1)
  await sleep(320)
}

async function main() {
  await sleep(1500)
  console.log('[probe] mounted rows=' + document.querySelectorAll('#app tbody tr').length)
  // 列宽体检：内容层若脱离文档流，td 会按最小宽度塌缩（文字被挤出去）
  const firstDataRow = document.querySelectorAll('#app tbody tr')[1]
  if (firstDataRow) {
    const widths = Array.from(firstDataRow.children).map((td) => td.getBoundingClientRect().width | 0)
    console.log('[probe] colWidths=' + JSON.stringify(widths) + ' total=' + (document.querySelector('#app table').getBoundingClientRect().width | 0))
  }
  snap('initial')

  // 用 label 定位，避免行索引随数据变化而失效
  const idxOf = (label) => Array.from(document.querySelectorAll('#app tbody tr'))
    .findIndex((tr) => ((tr.querySelector('td:nth-child(2)') || {}).textContent || '').replace('⠿', '').trim() === label)
  const plan = [
    ['第2节', '第3节', '跨 大课间（1 个固定行）'],
    ['第3节', '第5节', '跨 午休+午自习（连续 2 个固定行）'],
    ['第1节', '第6节', '跨 大课间+午休+午自习（多段）'],
    ['第1节', '第2节', '相邻，无固定行'],
  ].map(([a, b, d]) => [idxOf(a), idxOf(b), d])
  for (let i = 0; i < plan.length; i++) {
    const [a, b, desc] = plan[i]
    console.log(`[probe] --- drag#${i + 1}: ${desc}`)
    await dragRow(a, b)
    snap(`after#${i + 1}`)
  }
  console.log('__PROBE_DONE__')
}

nextTick(() => { main().catch((e) => { console.log('[probe] ERROR ' + (e && e.stack || e)); console.log('__PROBE_DONE__') }) })
