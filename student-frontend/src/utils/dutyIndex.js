// ===== 值日指数（公平账本）累加 =====
// 事实来自按天历史快照（GET /duty/daily 的 cells），单价来自值日项目权重表。
// 纯函数：不依赖 Vue / 网络，行为单测可直接跑真实源码。
//
// 一次遍历产出**两份账本**，口径必然同源（分成两次遍历早晚会算出两个数）：
//   byId       按学生 id 归集 —— 指数展示与导出用。两个同名学生各算各的。
//   byName     按姓名归集 —— 排表算法用。它内部的人一律以姓名为标识
//              （participants / assigned / cells 全是姓名），同名只能合并。
//   unresolved 解析不到 id 的格子（名册外的人、或历史快照里同名分不清）——
//              按姓名单独记账，展示时也要列出来，不能因为认不出人就悄悄丢掉。
//
// 格子值的三种形态都要认：空白、学生 id（P2-2 之后的新写入）、姓名（老数据与手工输入）。

/**
 * @param {Array<{cells?: Record<string, Record<string, (string|number)[]>>}>} dailyRows 逐日快照
 * @param {Record<string, Record<string, number>>} weights 项目 × 星期 权重
 * @param {object} [opts]
 * @param {(v: string|number) => string} [opts.resolveName] 格子值 → 显示姓名
 * @param {(v: string|number) => (number|null)} [opts.resolveId] 格子值 → 学生 id；认不出返回 null
 * @returns {{ byId: Record<string, number>, byName: Record<string, number>, unresolved: Record<string, number> }}
 */
export function accumulateDutyIndex(dailyRows, weights, opts) {
  const byId = {}
  const byName = {}
  const unresolved = {}
  // 兼容旧调用（第三参直接传函数）：当作 resolveName
  const o = typeof opts === 'function' ? { resolveName: opts } : (opts || {})
  // 默认不转换：调用方没给 resolveName 时保持旧行为（0 / 空串这类 falsy 值一律跳过）
  const toName = typeof o.resolveName === 'function' ? o.resolveName : (v) => v
  const toId = typeof o.resolveId === 'function' ? o.resolveId : null
  if (!weights || typeof weights !== 'object') return { byId, byName, unresolved }

  for (const day of Array.isArray(dailyRows) ? dailyRows : []) {
    const cells = day && day.cells
    if (!cells || typeof cells !== 'object') continue
    for (const item of Object.keys(cells)) {
      const byDay = cells[item] || {}
      for (const dayName of Object.keys(byDay)) {
        const w = weights[item]?.[dayName]
        if (typeof w !== 'number') continue
        const list = byDay[dayName]
        if (!Array.isArray(list)) continue
        for (const raw of list) {
          if (raw === null || raw === undefined || raw === '') continue
          const name = toName(raw)
          const id = toId ? toId(raw) : null
          // 姓名账本无论认不认得出 id 都要加：排表按姓名查，漏掉一格就等于少算一次值日
          if (name) byName[name] = (byName[name] || 0) + w
          // 0 / 负数不是合法的学生 id（sanitize 只放正整数），当成认不出
          if (id != null && Number.isFinite(Number(id)) && Number(id) > 0) {
            const key = String(id)
            byId[key] = (byId[key] || 0) + w
          } else if (name) {
            // 认不出是谁（名册外 / 历史字符串同名歧义）：单独记账，展示时列出来
            unresolved[name] = (unresolved[name] || 0) + w
          }
        }
      }
    }
  }
  return { byId, byName, unresolved }
}
