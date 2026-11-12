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
// 对位口径不动：权重仍取 weights[r][c]，与座位表同一套网格坐标（B2-03 未改语义）。
// =========================================================================

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
 * @param {Array<{snap_date?: string, seats?: any[][]}>} opts.days 每日快照（区间并集）
 * @param {number[][]} opts.weights 位置权重矩阵
 * @param {string} opts.ledgerTo 账本上限（YYYY-MM-DD）
 * @param {string} opts.indexTo 指数上限（YYYY-MM-DD；'' = 不设上限）
 * @param {(id: number) => string} opts.studentName 学号 → 姓名
 * @returns {{ ledger: Record<number, number>, acc: Record<string, number> }}
 */
export function aggregateSeatDaily({ days = [], weights = [], ledgerTo = '', indexTo = '', studentName = () => '' } = {}) {
  const ledger = {}
  const acc = {}
  if (!Array.isArray(weights) || !Array.isArray(days) || !days.length) return { ledger, acc }

  for (const day of days) {
    const d = (day && day.snap_date) || ''
    // 各自按自己的上限截断：账本不含今天，指数不含所选周之后的补存天
    const forLedger = !!ledgerTo && (!d || d <= ledgerTo)
    const forIndex = !indexTo || !d || d <= indexTo
    if (!forLedger && !forIndex) continue

    const seats = (day && day.seats) || []
    for (let r = 0; r < seats.length; r++) {
      const wRow = weights[r]
      const sRow = seats[r]
      if (!Array.isArray(wRow) || !Array.isArray(sRow)) continue
      for (let c = 0; c < sRow.length; c++) {
        const w = wRow[c]
        if (typeof w !== 'number') continue
        const val = sRow[c]
        // 账本口径（原 loadSeatLedger）：只认落在座位上的「学号」数字，键就是 id
        if (forLedger && typeof val === 'number') ledger[val] = (ledger[val] || 0) + w
        if (!forIndex) continue
        // 指数口径（原 seatIndexRows）：数字翻成姓名、字符串原样当姓名，空值跳过
        if (val === null || val === undefined || val === '') continue
        const name = typeof val === 'number' ? studentName(val) : val
        if (!name) continue
        acc[name] = (acc[name] || 0) + w
      }
    }
  }
  return { ledger, acc }
}
