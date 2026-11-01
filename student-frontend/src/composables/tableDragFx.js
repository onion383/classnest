// =========================================================================
// tableDragFx.js —— 表格拖拽的「实时让位」与「边缘自动滚动」
//
// 只做视觉与滚动辅助，不碰数据：
//   · 让位：把源与目标之间的行/列整体平移一格，腾出目标位置的「空槽」，
//     松手后由表格既有的重排逻辑（splice 删除 + 插入）真正落位，并播放各自的 FLIP 动画。
//   · 自动滚动：拖动到滚动容器上下左右边缘时按距离加速滚动，并把拖拽几何缓存
//     同步减去滚动量，保证命中判定与落点高亮框始终跟手。
//
// 之所以只用 transform：
//   不动 DOM 顺序 → 与 Vue 的渲染完全解耦，不会让 v-for 的 key/复用错乱；
//   行/列自身的 CSS 过渡会让位移平滑（表格已给 tr/td 配了 transform 过渡）。
// =========================================================================

const SHIFT_ATTR = 'data-drag-shift'
const SHIFT_EASE = '180ms cubic-bezier(0.22, 0.61, 0.36, 1)'

// 每个元素记录「上次写入的位移」，值没变就直接跳过写样式。
// 拖拽时本函数每帧会被调一次（行/列全量遍历），无条件写 transform/transition
// 会持续触发样式重算，是卡顿的主要来源之一。
const DX = '__dsx'
const DY = '__dsy'

function markShift(el, dx, dy) {
  if (!el) return
  if (el[DX] === dx && el[DY] === dy) return
  el[DX] = dx
  el[DY] = dy
  if (!el.hasAttribute(SHIFT_ATTR)) {
    el.setAttribute(SHIFT_ATTR, '1')
    el.style.transition = `transform ${SHIFT_EASE}`
  }
  el.style.transform = `translate(${dx}px, ${dy}px)`
}

function unmarkShift(el) {
  if (!el) return
  if (!el.hasAttribute(SHIFT_ATTR) && el[DX] === 0 && el[DY] === 0) return
  // 保留 transition，让"退出让位"也是滑回去的；transition 由 clearShift 统一收尾清掉
  if (el[DX] !== 0 || el[DY] !== 0) {
    el[DX] = 0
    el[DY] = 0
    el.style.transform = ''
  }
  el.removeAttribute(SHIFT_ATTR)
}

/** 清除范围内所有让位位移（拖拽结束/取消时调用） */
export function clearShift(root) {
  if (!root || !root.querySelectorAll) return
  const els = root.querySelectorAll(`[${SHIFT_ATTR}]`)
  for (const el of els) {
    el.style.transform = ''
    el.style.transition = ''
    el[DX] = 0
    el[DY] = 0
    // 标记必须一起摘掉：否则下次拖动的 unmarkShift 会认为它仍在让位态，
    // 白白清一次 transition，且 clearShift 每次都要多扫一遍
    el.removeAttribute(SHIFT_ATTR)
  }
  // 兜底：属性可能挂在 root 自身
  if (root.hasAttribute && root.hasAttribute(SHIFT_ATTR)) {
    root.style.transform = ''
    root.style.transition = ''
    root.removeAttribute(SHIFT_ATTR)
  }
}

/**
 * 行让位：中间行整体挪一格，把目标位置的「空槽」让出来。
 *
 * 位移 = **被拖行自身的高度**，整块平移这么多：
 * 块内各行的相对位置不变，只在目标一端空出一个与被拖行等大的槽。
 * 早期版本按「几何逐行补偿」（每行挪到邻行原来的位置），等价于用**相邻行的高差**当位移，
 * 只在所有行等高时成立；行高不等时每格差值不同、累积错位（学生管理、成员表都踩过）。
 * 需要的输入是每行的 top/bottom（缓存一次），不需要平均值。
 *
 * @param {Array<HTMLElement>} rows 与数据顺序一致的 <tr> 列表（可含 null 占位）
 * @param {number|null} from 源索引
 * @param {number|null} to 目标索引
 * @param {Array<{top:number,bottom:number}>|number} geom 各行的几何缓存（左右边界/top），或回退用的统一高度
 * @param {((el:HTMLElement)=>HTMLElement|null)|null} counterOf 取「需要反向位移」的子元素（如序号列内容）：
 *        行往上让位时它往下补同样的距离，净位移为 0，看起来固定不动
 */
/**
 * 行让位：块内**连续重排**（与列的 computeColReorder 完全同构，只是轴换成 top/height）。
 *
 * 为什么不能再用「恒定位移 ±h(from)」：
 *   区间里若夹着**固定行**（课表的大课间/午休/休息、讲台、分隔行），
 *   这些行不参与移动，可让位的行就没办法连续铺开 ——
 *   每行上移 h(from) 会直接撞到不动的固定行上，虚影/蓝框全跟着乱。
 *
 * 做法：块内元素按新顺序从块顶依次铺开，每项占自身高度。
 *   固定行当作「走廊」处理：不能作落点，但**跟着块一起平移**（否则铺不开）；
 *   松手后落位只换数据、固定行回原位（父组件的 splice 语义）。
 *
 * @returns {{hasFixed:boolean, nextTop:Map<number,number>, seq:number[]}}
 */
export function computeRowReorder(geom, from, to) {
  const out = { hasFixed: false, nextTop: new Map(), seq: [] }
  const g = Array.isArray(geom) ? geom : null
  if (!g || from === null || to === null || from === to) return out
  const cellOf = (k) => g[k] || null
  const fixedOf = (k) => !!(cellOf(k) && cellOf(k).fixed)
  const hOf = (k) => (cellOf(k) ? Math.round(cellOf(k).bottom - cellOf(k).top) : 0)

  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  for (let k = lo; k <= hi; k++) { if (fixedOf(k)) { out.hasFixed = true; break } }

  const movables = []
  const fixedIdxs = []
  for (let k = lo; k <= hi; k++) {
    if (!cellOf(k)) continue
    if (fixedOf(k)) fixedIdxs.push(k)
    else movables.push(k)
  }
  const ri = movables.indexOf(from)
  const ti = movables.indexOf(to)
  if (ri < 0 || ti < 0 || movables.length < 2) return out

  const order = movables.slice()
  const [moved] = order.splice(ri, 1)
  order.splice(ti, 0, moved)

  // 固定行**占住自己原来的位置**（不能改变顺序），可让位行依次填进其余位置。
  //
  // 走过两种错法：
  //   ① 「每个可让位行后面插一个固定行」—— 固定行比可让位行多时，多出来的被堆到块尾；
  //   ② 「固定行跟着前面那个可让位行走」—— 拖第3节到第2节位置时，大课间被带着跑到
  //      块尾（用户实测：大课间应该还在第二、三节之间）。
  // 正确语义就是「位置不动」：第 2/3/4 三个位置里，3 始终是大课间，2 和 4 互换。
  const seq = []
  let oi = 0
  for (let k = lo; k <= hi; k++) {
    if (!cellOf(k)) { seq.push(null); continue }
    seq.push(fixedOf(k) ? k : order[oi++])
  }
  // 去掉空位（几何里可能有没有 rect 的行）
  const clean = seq.filter((x) => x != null)

  let cursor = Math.round(cellOf(lo).top)
  for (const idx of clean) {
    out.nextTop.set(idx, cursor)
    cursor += hOf(idx)
  }
  out.seq = clean
  return out
}

export function applyRowShift(rows, from, to, geom, fallback = 0, counterOf = null) {
  if (!rows || !rows.length) return
  if (typeof window !== 'undefined' && window.__ROWDBG) {
    console.log('[rowdbg] applyRowShift from=' + from + ' to=' + to
      + ' rows=' + rows.length
      + ' geom=' + (Array.isArray(geom) ? geom.length : String(geom))
      + ' fixed=' + (Array.isArray(geom) ? geom.map((g) => (g && g.fixed ? 'F' : '.')).join('') : '-'))
  }
  const active = from !== null && to !== null && from !== to
  // 取整：125% 缩放下行高是 33.6 这种小数，原样写进 translate 会让行落在半像素上
  const uniform = Math.round(typeof geom === 'number' ? geom : fallback)
  const g = Array.isArray(geom) ? geom : null
  // 块内连续重排：每行移到「新顺序下自己该占的 top」，位移 = 新 top − 原 top。
  // 固定行（课表休息行/讲台/分隔行）也参与铺开，否则可让位行会撞上它们。
  // 没有几何缓存时退回恒定位移（±h(from)）的老口径。
  const reorder = (active && g) ? computeRowReorder(g, from, to) : { nextTop: new Map() }
  const nextTop = reorder.nextTop
  const hFrom = g && g[from] ? Math.round(g[from].bottom - g[from].top) : uniform
  const step = hFrom > 0 ? hFrom : uniform
  for (let i = 0; i < rows.length; i++) {
    const el = rows[i]
    if (!el) continue
    let dy = 0
    if (active) {
      if (i === from) {
        // 源行原件留在原位（它是 opacity-30 的「被拿起」残影，由跟手虚影代表），
        // 让位由其余行去填它的槽。列那边源列是 visibility:hidden，看不出来，可以一起挪。
        dy = 0
      } else if (g && nextTop.has(i) && g[i]) {
        dy = Math.round(nextTop.get(i) - g[i].top)
      } else if (!g) {
        // 无几何兜底：整块平移一个被拖行高度
        if (to > from && i > from && i <= to) dy = -step
        else if (to < from && i >= to && i < from) dy = step
      }
    }
    // counterOf 可返回单个元素或数组：这些元素（时段/节次/时间这类「位置」格）
    // 做反向位移，视觉上钉住不动 —— 让位只应该移动数据格。
    const counter = counterOf ? counterOf(el) : null
    const counters = counter ? (Array.isArray(counter) ? counter : [counter]) : []
    if (dy) {
      markShift(el, 0, dy)
      for (const c of counters) markShift(c, 0, -dy)
    } else {
      unmarkShift(el)
      for (const c of counters) unmarkShift(c)
    }
  }
}

/**
 * 列让位：中间列整体挪一格，把目标位置的「空槽」让出来。
 *
 * 位移 = **被拖列自身的宽度**，整块平移（走廊列也一起平移）。
 * 走廊列只是「不能作为落点、不能单独拖」，它的位置必须跟着块走 ——
 * 若把它钉住不动，其他列平移时就会压在它身上，跨走廊拖动整排错位。
 *
 * @param {Array<Array<HTMLElement>>} colEls 索引 = 数据列序号；每项是该列需一起平移的元素
 * @param {number|null} from 源列
 * @param {number|null} to 目标列
 * @param {Array<{left:number,right:number}>|number} geom 各列的左右边界缓存，或回退用的统一宽度
 */
/**
 * 列让位的「块内连续重排」几何（只对**有走廊列**的表格有意义）。
 *
 * 座位表的列宽不相等、走廊又是不随数据移动的分隔列，所以让位不能把邻列挪进「对方的固定槽位」
 * —— 宽度不同会在槽尾留空白。正确做法是把块内元素按新顺序从块顶依次铺开（每项占自身宽度），
 * 走廊跟着挪：块内首尾相接、块外不动（块总宽不变）。
 *
 * @returns {{hasAisle:boolean, nextLeft:Map<number,number>}} nextLeft: 显示列索引 → 新 left（含走廊）
 */
export function computeColReorder(geom, from, to) {
  const out = { hasAisle: false, nextLeft: new Map(), seq: [] }
  const g = Array.isArray(geom) ? geom : null
  if (!g || from === null || to === null || from === to) return out
  const cellOf = (k) => g[k] || null
  const isAisle = (k) => !!(cellOf(k) && cellOf(k).aisle)
  const wOf = (k) => (cellOf(k) ? Math.round(cellOf(k).right - cellOf(k).left) : 0)

  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  for (let k = lo; k <= hi; k++) { if (isAisle(k)) { out.hasAisle = true; break } }

  const reals = []
  const aisleIdxs = []
  for (let k = lo; k <= hi; k++) {
    if (!cellOf(k)) continue
    if (isAisle(k)) aisleIdxs.push(k)
    else reals.push(k)
  }
  const ri = reals.indexOf(from)
  const ti = reals.indexOf(to)
  if (ri < 0 || ti < 0 || reals.length < 2) return out

  const order = reals.slice()
  const [moved] = order.splice(ri, 1)
  order.splice(ti, 0, moved)
  // 新序列：真实列按新顺序，走廊按原相对次序插在相邻真实列之间
  const seq = []
  let ai = 0
  for (let i = 0; i < order.length; i++) {
    seq.push(order[i])
    if (i < order.length - 1 && ai < aisleIdxs.length) seq.push(aisleIdxs[ai++])
  }
  while (ai < aisleIdxs.length) seq.push(aisleIdxs[ai++])

  let cursor = Math.round(cellOf(lo).left)
  for (const idx of seq) {
    out.nextLeft.set(idx, cursor)
    cursor += wOf(idx)
  }
  out.seq = seq
  return out
}

export function applyColShift(colEls, from, to, geom, fallback = 0, counterOf = null) {
  if (!colEls || !colEls.length) return
  const active = from !== null && to !== null && from !== to
  // 取整：125% 缩放下行高是 33.6 这种小数，原样写进 translate 会让行落在半像素上
  const uniform = Math.round(typeof geom === 'number' ? geom : fallback)
  const g = Array.isArray(geom) ? geom : null
  const leftOf = (k) => (g && g[k] ? g[k].left : null)

  // 一律用「块内连续重排」：块内元素按新顺序从块左边界依次铺开，每项占自身宽度。
  // 早期版本无走廊时用「整块平移 w(from)」——只有全表等宽才成立，
  // 列宽不等时每列被平移同一个量，落到新位置就会互相重叠/留空（让位错位的真凶）。
  const reorder = active ? computeColReorder(g, from, to) : { hasAisle: false, nextLeft: new Map(), seq: [] }
  const nextLeft = reorder.nextLeft

  for (let i = 0; i < colEls.length; i++) {
    const els = colEls[i]
    if (!els || !els.length) continue
    let dx = 0
    if (active && nextLeft.has(i) && leftOf(i) != null) {
      dx = Math.round(nextLeft.get(i) - leftOf(i))
    }
    for (const el of els) {
      if (!el) continue
      // 表头 th 上的文字做反向位移：格子跟着让位走，但「列1/列2」这串字视觉上钉在原位，
      // 于是编号永远与位置一致（不会出现「列2 被挪到列1 的位置还写着列2」）。
      // 与行让位的 counterOf 完全同构，只是换了轴。
      const counter = counterOf ? counterOf(el) : null
      if (dx) {
        markShift(el, dx, 0)
        if (counter) markShift(counter, -dx, 0)
      } else {
        unmarkShift(el)
        if (counter) unmarkShift(counter)
      }
    }
  }
}

/**
 * 行互换让位：只把「源行」与「目标行」互相挪到对方位置，中间行不动。
 * 网格表格（座位/课程/值日）拖行的结果就是「两行交换」，所以预览也必须是互换，
 * 否则松手会看到中间行弹回原位。
 * @param {Array<HTMLElement>} rows 与数据顺序一致的 <tr> 列表
 * @param {number|null} from 源索引
 * @param {number|null} to 目标索引
 * @param {number} dyFrom 源行的垂直位移（= 目标行 top - 源行 top）
 * @param {number} dyTo 目标行的垂直位移（= 源行 top - 目标行 top）
 */
/**
 * 按「目标 top 表」渲染行位移：dy = target[i] − 原始 top[i]。
 *
 * 用于**步进式**行重排（跨固定行时把一次大跨越拆成多次单格重排）：
 * 调用方自己维护「每行当前该在哪」的 top 表，这里只负责写 transform，
 * 所以每行的位移永远相对自己的原始位置，不会累积误差。
 *
 * @param {Array<HTMLElement>} rows 与数据顺序一致的 <tr> 列表
 * @param {number[]} targetTops 第 i 行应显示的 top（视口坐标）
 * @param {Array<{top:number}>} geom 按下时缓存的原始几何
 * @param {((el:HTMLElement)=>HTMLElement|null)|null} counterOf 需要反向位移的子元素
 * @param {number|null} skipIdx 源行索引（原件留在原位，不参与位移）
 */
export function applyRowTops(rows, targetTops, geom, counterOf = null, skipIdx = null) {
  if (!rows || !rows.length || !Array.isArray(targetTops)) return
  for (let i = 0; i < rows.length; i++) {
    const el = rows[i]
    if (!el) continue
    const dy = (i === skipIdx || !geom || !geom[i] || targetTops[i] == null)
      ? 0
      : Math.round(targetTops[i] - geom[i].top)
    const counter = counterOf ? counterOf(el) : null
    if (dy) {
      markShift(el, 0, dy)
      if (counter) markShift(counter, 0, -dy)
    } else {
      unmarkShift(el)
      if (counter) unmarkShift(counter)
    }
  }
}

export function applyRowSwap(rows, from, to, dyFrom, dyTo) {
  if (!rows || !rows.length) return
  const active = from !== null && to !== null && from !== to
  for (let i = 0; i < rows.length; i++) {
    const el = rows[i]
    if (!el) continue
    let dy = 0
    if (active) {
      if (i === from) dy = Math.round(dyFrom)
      else if (i === to) dy = Math.round(dyTo)
    }
    if (dy) markShift(el, 0, dy)
    else unmarkShift(el)
  }
}

/**
 * 列互换让位：只把「源列」与「目标列」互相挪到对方位置，中间列不动。
 * 用于网格表格（座位/课表/值日）——它们的列拖拽结果是「交换两列数据、表头固定」，
 * 所以预览也必须是互换，不能像普通表格那样整排平移（否则松手会看到中间列弹回去）。
 * @param {Array<Array<HTMLElement>>} colEls 索引 = 数据列序号
 * @param {number|null} from 源列
 * @param {number|null} to 目标列
 * @param {number} dxFrom 源列的水平位移（= 目标列左边界 - 源列左边界）
 * @param {number} dxTo 目标列的水平位移（= 源列左边界 - 目标列左边界）
 */
export function applyColSwap(colEls, from, to, dxFrom, dxTo) {
  if (!colEls || !colEls.length) return
  const active = from !== null && to !== null && from !== to
  for (let i = 0; i < colEls.length; i++) {
    const els = colEls[i]
    if (!els || !els.length) continue
    let dx = 0
    if (active) {
      if (i === from) dx = Math.round(dxFrom)
      else if (i === to) dx = Math.round(dxTo)
    }
    for (const el of els) {
      if (!el) continue
      if (dx) markShift(el, dx, 0)
      else unmarkShift(el)
    }
  }
}

/**
 * 边缘自动滚动：拖动到容器边缘附近时按距离加速滚动，四向都支持。
 * @param {() => HTMLElement|null} getScroller 取滚动容器（每次取，兼容重建）
 * @param {(dx:number, dy:number) => void} onScrolled 实际滚动后回调（用于同步几何缓存）
 * @param {{edge?:number, maxSpeed?:number}} opts
 * @returns {{update:(x:number,y:number)=>void, stop:()=>void}}
 */
export function createEdgeAutoScroll(getScroller, onScrolled, opts = {}) {
  const edge = opts.edge || 56          // 触发区宽度（px）
  const maxSpeed = opts.maxSpeed || 22  // 每帧最大滚动量（px）
  let raf = null
  let px = 0
  let py = 0

  const speedOf = (dist) => Math.min(maxSpeed, Math.max(3, Math.round(dist / 3)))

  const step = () => {
    raf = null
    const el = typeof getScroller === 'function' ? getScroller() : getScroller
    if (!el) return
    const r = el.getBoundingClientRect()
    let dx = 0
    let dy = 0
    if (py < r.top + edge) dy = -speedOf(r.top + edge - py)
    else if (py > r.bottom - edge) dy = speedOf(py - (r.bottom - edge))
    if (px < r.left + edge) dx = -speedOf(r.left + edge - px)
    else if (px > r.right - edge) dx = speedOf(px - (r.right - edge))
    if (!dx && !dy) return
    const bx = el.scrollLeft
    const by = el.scrollTop
    if (dx) el.scrollLeft = bx + dx
    if (dy) el.scrollTop = by + dy
    const mx = el.scrollLeft - bx
    const my = el.scrollTop - by
    if (!mx && !my) return // 已到边界：停下，等下一次 mousemove 再判断
    if (onScrolled) onScrolled(mx, my)
    raf = requestAnimationFrame(step)
  }

  return {
    update(x, y) {
      px = x
      py = y
      if (!raf) raf = requestAnimationFrame(step)
    },
    stop() {
      if (raf) cancelAnimationFrame(raf)
      raf = null
    },
  }
}
