// ===== 值日权重表：同一项目的多个子行（人数 > 1）之间「联动」 =====
//
// 背景：权重表按项目的人数拆成多行（倒垃圾 3 人 → 3 行），但底层数据是
//   {项目: {星期: 权重}} —— 一个项目只有一个权重值，多行显示的是同一个数。
//   GridView 的编辑事件只把「被编辑的那一格」换掉，其余子行仍是旧值，
//   所以不能只读首个子行（改了第 2/3 行会被丢掉）。
//
// 做法：拿改动前的值当参照，逐子行比对，找出「与旧值不同的那一行」= 用户刚改的那格，
//   再把它写回该项目的所有天 → 多行自然同步（联动）。
//
// 一维（单列「权重」）的显示值是各天权重的均值（见 weightItemValue），
//   所以旧值参照要用同一个均值口径，否则比对不上。

// 单元格取文本：GridView 编辑后给的 cell 是 { course }，其余是 { course, _bg, _fg }
function cellText(cells, colIdx) {
  const raw = cells?.[colIdx]?.course
  return (raw == null ? '' : String(raw)).trim()
}

// 从一组子行的文本里挑出「用户刚改的那一格」的值。
// 参照值 oldText 是改动前显示的值；与它不同的那个就是编辑结果。
// 全都与旧值相同（没改或改回原值）→ 沿用旧值。
export function pickEditedText(texts, oldText) {
  for (const t of texts) {
    if (t !== oldText) return t
  }
  return oldText
}

// 权重文本 → 数值：空/非数字 → 0，超范围夹到 [min, max]
export function parseWeightText(text, min = 0, max = 1) {
  const s = (text == null ? '' : String(text)).trim()
  if (s === '') return 0
  const num = Number(s)
  if (!Number.isFinite(num)) return 0
  return Math.max(min, Math.min(max, num))
}

// 显示口径的文本格式化：一维显示均值（保留 3 位），二维显示原始值
function displayText(v) {
  if (v == null || v === '') return ''
  return String(v)
}

// 计算下一份权重矩阵。
// groups: { 项目名: 子行的 cells 数组[] }（同项目的多行在一起）
// prevWeights: 改动前的 {项目: {星期: 值}}（二维）；一维不用
// avgOf(name): 一维时该项目的显示值（各天均值）
export function resolveWeightGroups({ groups, prevWeights = {}, days = [], weekdayWeighted, avgOf = () => null, min = 0, max = 1 }) {
  const next = {}
  for (const name of Object.keys(groups || {})) {
    const subRows = groups[name] || []
    next[name] = {}
    if (!weekdayWeighted) {
      // 一维：单列，所有天共用同一个权重
      const oldText = displayText(avgOf(name))
      const text = pickEditedText(subRows.map(c => cellText(c, 0)), oldText)
      const value = parseWeightText(text, min, max)
      for (const day of days) next[name][day] = value
      continue
    }
    // 二维：每天一列，逐列独立比对
    for (let i = 0; i < days.length; i++) {
      const day = days[i]
      const oldText = displayText(prevWeights?.[name]?.[day])
      const text = pickEditedText(subRows.map(c => cellText(c, i)), oldText)
      next[name][day] = parseWeightText(text, min, max)
    }
  }
  return next
}
