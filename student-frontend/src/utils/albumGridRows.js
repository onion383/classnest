// =========================================================================
// albumGridRows.js —— 相册「组内按行虚拟裁剪」的纯计算
//
// 为什么需要：原来的虚拟滚动只裁剪到**日期分组**（usePhotoTimeline.visibleGroups），
// 组内仍是 `v-for="p in g.photos"` 全量渲染。一天有几千张照片时，DOM 里就挂着几千个
// 格子：改窗口大小 → cell 每变 3px 全部重排；measureViewportIds 每 80ms 逐个
// getBoundingClientRect；FLIP 也遍历全部格子 —— 这就是「一天照片多就卡死」的根因。
//
// 这里把「这一组该渲染哪几行」算成纯数据，模板只渲染这些行（每行一个绝对定位容器）。
// 格子尺寸固定、列数已知，所以行的位置可以直接用算术算出来，完全不需要碰 DOM。
//
// 与分页加载的关系：照片是按**天整组**加载的（albumPhotoPages.mergePhotoGroups），
// photos 要么是 null（整组未加载），要么就是这一天的全部照片。
// 因此「组中部还没加载」这种情况不存在，按行切片不会拿到空洞。
// =========================================================================

/**
 * @param {object} p
 * @param {number} p.offset    组在滚动内容里的绝对顶部（layout.items[].offset）
 * @param {number} p.count     该组总张数（日期索引；预留高度用）
 * @param {Array|null} p.photos 该组照片，null = 还没加载
 * @param {number} p.scrollTop 滚动容器当前 scrollTop
 * @param {number} p.clientH   滚动容器可视高度
 * @param {number} p.cols      列数
 * @param {number} p.cell      单格边长
 * @param {number} p.gap       格子间距
 * @param {number} p.header    组标题占的高度（与 usePhotoTimeline.groupHeight 同源）
 * @param {number} p.buffer    上下预渲染范围
 * @param {number} p.extraRows 上下再多渲染几行（抗亚像素/边界闪）
 * @returns {{contentH:number, loaded:boolean, allRows:number,
 *   rows:Array<{n:number, top:number, photos:Array}>}}
 */
export function visibleGridRows({
  offset, count = 0, photos = null,
  scrollTop, clientH, cols, cell,
  gap = 12, header = 40, buffer = 900, extraRows = 1,
}) {
  const loaded = Array.isArray(photos)
  const nPhotos = loaded ? photos.length : 0
  // 高度必须按 count 预留：照片还没加载时也要占住位置，否则滚动条会自己跳。
  // **口径必须与 usePhotoTimeline.groupHeight 完全一致**（count != null 时优先用 count）：
  // 这里若用 max(count, photos.length)，扫描期间 count 落后于实际张数时会多预留几行，
  // 而 layout 里下一组的 top 仍按 groupHeight 算 —— 两组内容直接叠在一起。
  const total = (count != null && count !== '' ? Number(count) : nPhotos) || 0
  const allRows = cols > 0 ? Math.ceil(total / cols) : 0
  const rowH = cell + gap
  const contentH = allRows > 0 ? allRows * cell + (allRows - 1) * gap : 0
  if (!loaded || !allRows || !rowH) return { contentH, loaded, allRows, rows: [] }

  // 行 n 的绝对顶部 ≈ offset + header + n*rowH；只保留与「视口 ± buffer」相交的行。
  const top = scrollTop - buffer
  const bottom = scrollTop + clientH + buffer
  const base = offset + header
  let first = Math.floor((top - base) / rowH) - extraRows
  let last = Math.ceil((bottom - base) / rowH) + extraRows
  first = Math.max(0, Math.min(first, allRows - 1))
  last = Math.max(0, Math.min(last, allRows - 1))

  const rows = []
  for (let n = first; n <= last; n++) {
    const from = n * cols
    // count 比实际加载的多（扫描期间刚删过）时，末尾行会是空的 —— 跳过即可，
    // 预留高度仍按 count 算，滚动条不会跳。
    const slice = photos.slice(from, Math.min(from + cols, nPhotos))
    if (!slice.length) continue
    rows.push({ n, top: n * rowH, photos: slice })
  }
  return { contentH, loaded, allRows, rows }
}
