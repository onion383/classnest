// =========================================================================
// seatDailyAggregate.js —— 座位账本 / 座位指数单遍结算（v6 性能专题 · 1-9）
//
// 改造前 SeatView 里有两份 `D×R×C` 遍历：loadSeatLedger 逐天累加到「学号」账本，
// seatIndexRows 又把同一批快照逐天累加到「姓名」指数，且各拉一次 `/seats/daily`
// （区间只差一天）。这里把累加合并成一遍，两个消费方的上限口径**分别传入**：
//
//   ledgerTo —— 账本上限（昨日）：今天还没过完，不能算进去；
//   indexTo  —— 指数上限（所选周代表日）：'' 表示不设上限（该周没有快照时的旧口径）。
//
// 两个上限不可互相顶替：合并取的是区间并集，结算时必须按各自上限截断，
// 否则账本会多算「所选周之后」的天数、指数会多算「所选周之后」的补存天。
//
// 对位口径（v7 · 4-9 / H4）：历史快照里的 [r][c] 是**当时的网格坐标**，不能直接套
// 当前权重矩阵 —— 座位几何（插走廊列、加行、改模板）一变，同一个下标就指向另一个
// 物理位置，指数会串位。产品口径定为「按当前布局重算」：
//   历史坐标 → 逻辑座位（行序号 / 座位列序号，跳过整行走廊与整列走廊）
//            → 当前布局的同一逻辑座位 → 取当前权重
// 老快照没有 types 时按「全座位」解释（identity），与改造前完全一致。
// =========================================================================
import { seatColumnIndices, rowIsAisle } from '../composables/useSeatGrid.geometry.js'

// 网格下标 → 逻辑序号（走廊行为 -1、走廊列为 -1）
function axisMaps(rowsLen, colsLen, types) {
  const rowOrd = new Array(Math.max(0, rowsLen)).fill(-1)
  let ord = 0
  for (let r = 0; r < rowOrd.length; r += 1) {
    if (rowIsAisle(types, r)) continue
    rowOrd[r] = ord
    ord += 1
  }
  const colOrd = new Array(Math.max(0, colsLen)).fill(-1)
  seatColumnIndices(colsLen, types).forEach((c, k) => {
    if (c >= 0 && c < colOrd.length) colOrd[c] = k
  })
  return { rowOrd, colOrd }
}

// 逻辑序号 → 网格下标（反查表，长度为逻辑座位数）
function ordToGrid(ordArr) {
  const out = []
  ordArr.forEach((ord, grid) => { if (ord >= 0) out[ord] = grid })
  return out
}

/**
 * 取两个上限的并集（区间并集只拉一次）。'' 表示「不设上限」——
 * 任一为空（要全量）就返回空，不能把全量收窄成某一天。
 */
export function unionCutoff(a, b) {
  if (!a || !b) return ''
  return a > b ? a : b
}

/**
 * @param {object} opts
 * @param {Array<{snap_date?: string, rows?: number, cols?: number, types?: any[][], seats?: any[][]}>} opts.days 每日快照（区间并集）
 * @param {number[][]} opts.weights 当前布局的位置权重矩阵
 * @param {number} [opts.weightsRows] 当前布局行数（缺省取 weights 长度）
 * @param {number} [opts.weightsCols] 当前布局列数（缺省取最宽一行）
 * @param {any[][]} [opts.weightsTypes] 当前布局格型矩阵（走廊/空位；缺省按全座位解释）
 * @param {string} opts.ledgerTo 账本上限（YYYY-MM-DD）
 * @param {string} opts.indexTo 指数上限（YYYY-MM-DD；'' = 不设上限）
 * @param {(id: number) => string} opts.studentName 学号 → 姓名
 * @returns {{ ledger: Record<number, number>, acc: Record<string, number> }}
 */
export function aggregateSeatDaily({
  days = [], weights = [], weightsRows = 0, weightsCols = 0, weightsTypes = [],
  ledgerTo = '', indexTo = '', studentName = () => '',
} = {}) {
  const ledger = {}
  const acc = {}
  const accName = {}
  if (!Array.isArray(weights) || !Array.isArray(days) || !days.length) return { ledger, acc, accName }

  // 当前布局的逻辑座位 → 网格下标。行数/列数取声明值与矩阵实际尺寸的较大者，
  // 避免矩阵比声明宽/长时把尾部座位截掉。
  const matrixRows = weights.length
  const matrixCols = weights.reduce((mx, row) => Math.max(mx, Array.isArray(row) ? row.length : 0), 0)
  const curRows = Math.max(Number(weightsRows) || 0, matrixRows)
  const curCols = Math.max(Number(weightsCols) || 0, matrixCols)
  const curMaps = axisMaps(curRows, curCols, weightsTypes || [])
  const curRowGrid = ordToGrid(curMaps.rowOrd)
  const curColGrid = ordToGrid(curMaps.colOrd)

  for (const day of days) {
    const d = (day && day.snap_date) || ''
    // 各自按自己的上限截断：账本不含今天，指数不含所选周之后的补存天
    const forLedger = !!ledgerTo && (!d || d <= ledgerTo)
    const forIndex = !indexTo || !d || d <= indexTo
    if (!forLedger && !forIndex) continue

    const seats = (day && day.seats) || []
    // 历史几何：优先用快照自带的 types/cols；老快照没有就按「全座位」解释
    const histCols = Math.max(Number(day && day.cols) || 0,
      seats.reduce((mx, row) => Math.max(mx, Array.isArray(row) ? row.length : 0), 0))
    const histMaps = axisMaps(seats.length, histCols, (day && day.types) || [])

    for (let r = 0; r < seats.length; r++) {
      const sRow = seats[r]
      if (!Array.isArray(sRow)) continue
      const rowOrd = histMaps.rowOrd[r]
      if (rowOrd < 0) continue
      const gr = curRowGrid[rowOrd]
      if (gr === undefined) continue // 当前布局没有这一行（布局缩小）
      const wRow = weights[gr]
      if (!Array.isArray(wRow)) continue
      for (let c = 0; c < sRow.length; c++) {
        // 历史坐标换算成「第几个座位列」，再到当前布局取同一列的权重
        const colOrd = c < histMaps.colOrd.length ? histMaps.colOrd[c] : -1
        if (colOrd < 0) continue
        const gc = curColGrid[colOrd]
        if (gc === undefined) continue // 当前布局没有这一列（布局缩小）
        const w = wRow[gc]
        if (typeof w !== 'number') continue
        const val = sRow[c]
        // 账本口径（原 loadSeatLedger）：只认落在座位上的「学号」数字，键就是 id
        if (forLedger && typeof val === 'number') ledger[val] = (ledger[val] || 0) + w
        if (!forIndex) continue
        // 指数口径：数字是学号 → 按 id 归并（同名两人各算各的、改过名也不会拆成两条）；
        // 字符串是历史快照里的姓名，只能按姓名归并
        if (val === null || val === undefined || val === '') continue
        if (typeof val === 'number') {
          const name = studentName(val)
          if (!name) continue
          const key = `id:${val}`
          acc[key] = (acc[key] || 0) + w
          if (!accName[key]) accName[key] = name
          continue
        }
        const nm = String(val).trim()
        if (!nm) continue
        const key = `name:${nm}`
        acc[key] = (acc[key] || 0) + w
        accName[key] = nm
      }
    }
  }
  // 同名不同人：姓名后补 #id。不补的话指数表上会出现两行一模一样的名字，
  // 用户会以为其中一行是重复/脏数据（v7 §5-4 / #20）。
  const nameCount = new Map()
  for (const k of Object.keys(acc)) {
    const n = accName[k]
    nameCount.set(n, (nameCount.get(n) || 0) + 1)
  }
  for (const k of Object.keys(acc)) {
    if (nameCount.get(accName[k]) <= 1) continue
    if (k.startsWith('id:')) accName[k] = `${accName[k]}（#${k.slice(3)}）`
  }
  return { ledger, acc, accName }
}
