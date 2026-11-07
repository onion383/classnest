// ===== 值日指数（公平账本）累加 =====
// 事实来自按天历史快照（GET /duty/daily 的 cells），单价来自值日项目权重表。
// 展示用的「值日指数」与排表用的「公平账本」只差结算区间（所选周快照日 / 昨日），
// 累加口径必须单源：此前两处各写一遍逐格累加，改一处不改另一处就会算出两个数。
// 纯函数：不依赖 Vue / 网络，行为单测可直接跑真实源码。

/**
 * @param {Array<{cells?: Record<string, Record<string, string[]>>}>} dailyRows 逐日快照
 * @param {Record<string, Record<string, number>>} weights 项目 × 星期 权重
 * @returns {Record<string, number>} 姓名 → 累计权重
 */
export function accumulateDutyIndex(dailyRows, weights) {
  const acc = {}
  if (!weights || typeof weights !== 'object') return acc
  for (const day of Array.isArray(dailyRows) ? dailyRows : []) {
    const cells = day && day.cells
    if (!cells || typeof cells !== 'object') continue
    for (const item of Object.keys(cells)) {
      const byDay = cells[item] || {}
      for (const dayName of Object.keys(byDay)) {
        const w = weights[item]?.[dayName]
        if (typeof w !== 'number') continue
        const names = byDay[dayName]
        if (!Array.isArray(names)) continue
        for (const name of names) {
          if (!name) continue
          acc[name] = (acc[name] || 0) + w
        }
      }
    }
  }
  return acc
}
