// =========================================================================
// AlbumYearRuler.math.js —— 年份尺的纯数学关系（组件与测试共用同一份）
//
// 为什么单独抽出来：这块最容易出的错不是写崩，而是**差量**
// （手柄大小没算、分母用错、吸附漏终点），而旧测试在文件里复刻公式，
// 组件公式改坏时测试不会红（循环论证）。抽成模块后：
//   组件 import 它 → 改公式就是在改这里；
//   测试 import 它 → 测的就是组件真正在跑的那份公式。
// =========================================================================

// 手柄固定高度：不随内容比例变化 —— 照片多少、窗口多高，长出来的都是同一个形状。
export const THUMB_H = 44

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

export function maxScrollOf(total, clientH) {
  return Math.max(0, (Number(total) || 0) - (Number(clientH) || 0))
}

// 手柄高度固定（只有轨道本身比手柄还短时才退让，避免溢出轨道）
export function thumbHeightOf(trackH) {
  return Math.min(THUMB_H, Math.max(0, Number(trackH) || 0))
}

// 手柄能走的行程 = 轨道高度 − 手柄自身高度。手柄顶点的活动区间就是它。
export function thumbRangeOf(trackH) {
  return Math.max(0, (Number(trackH) || 0) - thumbHeightOf(trackH))
}

// 手柄位置：滚动进度 → 行程区间。
// 没有可滚动内容时用 manualTop（纯手感，不影响任何滚动），否则跟真实滚动位置走。
export function thumbTopOf({ trackH, maxScroll, scrollTop, manualTop = 0 }) {
  const range = thumbRangeOf(trackH)
  if (!range) return 0
  if (!maxScroll) return clamp(manualTop, 0, range)
  return clamp((scrollTop / maxScroll) * range, 0, range)
}

// 刻度必须和手柄同源换算：同一个 maxScroll 分母、同一段行程，
// 否则拖到某一年时手柄中心会和那年的刻度线对不上。
export function markTopOf({ trackH, maxScroll, total, offset }) {
  const h = Number(trackH) || 0
  if (!h) return 0
  if (!maxScroll) {
    // 内容不足一屏：没有可滚动行程，刻度按内容比例铺满轨道（此时手柄停在顶端）
    const t = Number(total) || 0
    return t ? clamp((offset / t) * h, 0, h) : 0
  }
  // + thumbH/2：滚到该位置时手柄中心落在哪儿，刻度就画在哪儿
  return clamp((offset / maxScroll) * thumbRangeOf(h) + thumbHeightOf(h) / 2, 0, h)
}

// 按手柄顶部位置换算滚动位置（拖轨道 / 拖手柄共用）。
export function seekOf({ top, trackH, maxScroll }) {
  const range = thumbRangeOf(trackH)
  if (!range || !maxScroll) return 0
  return (clamp(top, 0, range) / range) * maxScroll
}
