// 工具箱浮窗的四向预留布局几何（纯函数，不碰 DOM / IPC）。
// 窗口恒 520×784（内容区），图标恒在正中 (236,368)；面板贴在图标的左/右/上/下预留区。
// 注意：PANEL_H 是「面板实际高度」（限位用），与窗口高 784 无关——窗口大是为了图标居中，
// 面板保持内容自然高度 310，不需要为了限位把它撑高。
// 这里的数字必须与 WidgetApp.vue 的 CSS 定位、main.widget.js 的窗口尺寸保持一致，
// 单测会同时校验源码接线与 CSS 数值，防止任何一边单独漂移。

export const LAYOUT = Object.freeze({
  SHADOW: 16,
  ICON: 48,
  GAP: 8,
  PANEL_W: 228,
  PANEL_H: 310,
  WIN_W: 520,
  WIN_H: 784,
  ICON_OFF_X: 236,
  ICON_OFF_Y: 368,
})

// 面板预留区左上角相对「图标左上角」的偏移，与 CSS 四向端部对齐一一对应：
// right: left:292 top:368 → (+56, +0)；left: left:0 top:368 → (-236, +0)
// down:  left:292 top:424 → (+56, +56)
// up:    面板底边贴「图标底边-间隙」，即面板顶 = iy + ICON - GAP - PANEL_H = iy - 270。
//        这样上展开时面板底边与图标底边齐平，能一起贴住任务栏（不再差一个图标高度）。
export const PANEL_OFFSET = Object.freeze({
  right: Object.freeze([56, 0]),
  down: Object.freeze([56, 56]),
  left: Object.freeze([-236, 0]),
  up: Object.freeze([56, -270]),
})

// 优先级：用户要的默认布局是「图标 面板」右展开；放不下才依次退到 下 / 左 / 上。
export const DIRS = Object.freeze(['right', 'down', 'left', 'up'])

const { ICON, PANEL_W, PANEL_H } = LAYOUT

// 面板预留区在屏幕上的矩形（DIP）。ix/iy 是图标左上角。
// 锚点固定：面板按 PANEL_OFFSET 贴图标，展开后方向/锚点都不再变，
// 只靠联合限位把面板挡在工作区内（顶到任务栏就停），不做上下翻转。
export function panelRect(dir, ix, iy) {
  const off = PANEL_OFFSET[dir] || PANEL_OFFSET.right
  return { x: ix + off[0], y: iy + off[1], w: PANEL_W, h: PANEL_H }
}

// 四向里挑第一个能完整放下面板的方向；都不够时选溢出最少的一边。
export function pickDir(ix, iy, wa) {
  let best = DIRS[0]
  let bestMargin = -Infinity
  for (const dir of DIRS) {
    const margin = freeMargin(panelRect(dir, ix, iy), wa)
    if (margin >= 0) return dir
    if (margin > bestMargin) { bestMargin = margin; best = dir }
  }
  return best
}

// 矩形到工作区四边的最小余量：>=0 表示完整在工作区内，负数是最远溢出量。
export function freeMargin(rect, wa) {
  return Math.min(
    rect.x - wa.x,
    rect.y - wa.y,
    wa.x + wa.w - (rect.x + rect.w),
    wa.y + wa.h - (rect.y + rect.h)
  )
}

// 只夹图标：图标态拖拽用，保证圆形图标完整留在屏内（允许贴边）。
export function clampIcon(ix, iy, wa) {
  return [
    Math.max(wa.x, Math.min(ix, wa.x + wa.w - ICON)),
    Math.max(wa.y, Math.min(iy, wa.y + wa.h - ICON)),
  ]
}

// 图标 + 指定方向面板一起夹：保证图标和面板预留区同时完整留在工作区内。
// 面板偏移与图标偏移分别取交集再夹，因此「图标贴边」在方向可行时不会被破坏。
// 工作区本身放不下（交集为空）时退化为只夹图标——不能为了限位把图标凭空挪走。
export function clampIconWithPanel(ix, iy, wa, dir) {
  const base = clampIcon(ix, iy, wa)
  const off = PANEL_OFFSET[dir] || PANEL_OFFSET.right
  const loX = Math.max(wa.x, wa.x - off[0])
  const hiX = Math.min(wa.x + wa.w - ICON, wa.x + wa.w - PANEL_W - off[0])
  const loY = Math.max(wa.y, wa.y - off[1])
  const hiY = Math.min(wa.y + wa.h - ICON, wa.y + wa.h - PANEL_H - off[1])
  if (loX > hiX || loY > hiY) return base
  return [Math.max(loX, Math.min(base[0], hiX)), Math.max(loY, Math.min(base[1], hiY))]
}

// 四向都放不下时的兜底：在四个「图标 + 面板」可行域里挑离当前图标最近的位置。
// 用于展开前的最后一步摆位（展开时宁可挪一次图标，也不让面板被屏幕裁掉）。
// 全都不可能时退化为 clampIcon，图标仍完整可见。
export function nearestFeasibleIcon(ix, iy, wa) {
  let best = null
  let bestDist = Infinity
  for (const dir of DIRS) {
    const at = clampIconWithPanel(ix, iy, wa, dir)
    const dist = (at[0] - ix) ** 2 + (at[1] - iy) ** 2
    if (dist < bestDist) { bestDist = dist; best = at }
  }
  return best || clampIcon(ix, iy, wa)
}
