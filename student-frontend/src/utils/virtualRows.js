// =========================================================================
// virtualRows.js —— 固定行高的「可见行窗口」纯计算
//
// 结构照 DynamicTable 的行虚拟滚动（rowPrefix + lowerBound + padTop/padBottom +
// 两屏 overscan），但把可变行高换成了固定步长：
//   · 表格行高会随单元格换行/编辑变化，所以那边要 rowHeights 测量 + 前缀和二分
//   · 这里的卡片高度是常量（内容超出由 CSS 裁掉），行位置 = index * step，直接除
// 换来的是不需要 measureRows、不需要测量后补 scrollTop —— 那一套是表格里最容易
// 出偏差的部分（窗口重算与补偿交错时曾把首屏顶到表尾）。
//
// 渲染方必须用「上垫片 + 行 + 下垫片」的正常流，不要用绝对定位：
// 垫片撑住滚动条长度，浏览器自己维持 scrollTop，不需要我们补偿。
//
// 行间距算进 step（每行都带 gap，含最后一行），所以总高 = count * step，
// 末尾多出的一格 gap 无害；换来 padTop/padBottom 与行位置永远对齐。
// =========================================================================

/**
 * @param {object} p
 * @param {number} p.scrollTop 滚动容器当前 scrollTop
 * @param {number} p.viewH     滚动容器可视高度
 * @param {number} p.rowH      单行高度（卡片本身）
 * @param {number} p.gap       行间距
 * @param {number} p.count     总条数
 * @param {number} p.overscan  缓冲行数下限（实际会放大到两屏，同 DynamicTable）
 * @returns {{contentH:number, padTop:number, padBottom:number,
 *   start:number, end:number, rows:number[]}}
 */
export function visibleFixedRows({
  scrollTop = 0, viewH = 0, rowH = 0, gap = 0, count = 0, overscan = 8,
} = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0))
  const h = Number(rowH) || 0
  const step = h + (Number(gap) || 0)
  if (!n || step <= 0) {
    return { contentH: 0, padTop: 0, padBottom: 0, start: 0, end: 0, rows: [] }
  }

  const vh = Number(viewH) || 0
  const contentH = n * step
  const top = Math.max(0, (Number(scrollTop) || 0))
  const bottom = top + vh

  // 与表格同一口径：至少留两整屏，窗口切换更稀，甩动/惯性滚动不会露出垫片
  const osc = Math.max(Number(overscan) || 0, Math.ceil(vh / step) * 2)
  let start = Math.floor(top / step) - osc
  let end = Math.ceil(bottom / step) + osc
  start = Math.max(0, Math.min(start, n))
  end = Math.max(start, Math.min(end, n))

  const rows = []
  for (let i = start; i < end; i += 1) rows.push(i)

  return {
    contentH,
    padTop: start * step,
    padBottom: (n - end) * step,
    start,
    end,
    rows,
  }
}
