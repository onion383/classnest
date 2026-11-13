// =========================================================================
// viewerPan.js —— 图片查看器「放大后拖动平移」的纯计算
//
// 为什么单独一份：查看器有两份同源拷贝（AlbumView.vue 内联版、MediaViewer.vue
// 给收据弹窗用），两份都只有 rotate + scale，缩放后超出舞台的部分被
// overflow-hidden 裁掉且没有任何办法移过来看。交互必须两边一致，所以把
// 「能移多少」和「夹到边界」抽成不依赖 Vue / DOM 的纯函数，由
// composables/useViewerPan.js 统一驱动。
//
// 边界怎么算：img 的 offsetWidth/offsetHeight 是**布局尺寸**（max-w-full 之后、
// transform 之前），舞台 clientWidth/clientHeight 是 padding box（overflow 就裁在
// 这条边上）。图片在 flex 里居中，两侧可露出的余量就是 (缩放后尺寸 - 舞台尺寸)/2。
// 旋转只可能是 90 的倍数（见 rotate），90/270 时视觉宽高互换，所以要换着算。
// =========================================================================

/** 平移量超过这个倍率才有意义；旋转 90/270 时即使 zoom=1 也可能被裁，见 canPan */
export const PAN_MIN_ZOOM = 1

/**
 * @param {object} p
 * @param {number} p.mediaW   img.offsetWidth（未 transform）
 * @param {number} p.mediaH   img.offsetHeight（未 transform）
 * @param {number} p.stageW   舞台 clientWidth
 * @param {number} p.stageH   舞台 clientHeight
 * @param {number} p.zoom     缩放倍率
 * @param {number} p.rotation 旋转角度（度，90 的倍数）
 * @returns {{maxX:number, maxY:number}} 各轴允许的最大绝对平移量（像素）
 */
export function panBounds({ mediaW, mediaH, stageW, stageH, zoom = 1, rotation = 0 }) {
  const swapped = Math.abs(rotation % 180) !== 0
  const w = (swapped ? mediaH : mediaW) * zoom
  const h = (swapped ? mediaW : mediaH) * zoom
  return {
    maxX: Math.max(0, (w - stageW) / 2),
    maxY: Math.max(0, (h - stageH) / 2),
  }
}

/** 把 (x, y) 夹进 bounds；非有限数当 0，避免 NaN 把 transform 写成 "translate(NaNpx, ...)" */
export function clampPanValue(x, y, bounds) {
  const maxX = Math.max(0, Number(bounds && bounds.maxX) || 0)
  const maxY = Math.max(0, Number(bounds && bounds.maxY) || 0)
  const clamp = (v, max) => Math.min(max, Math.max(-max, Number.isFinite(v) ? v : 0))
  return { x: clamp(x, maxX), y: clamp(y, maxY) }
}
