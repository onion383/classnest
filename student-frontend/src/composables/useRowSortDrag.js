// =========================================================================
// useRowSortDrag.js —— 纵向列表的指针拖拽排序（条件行这类"一排可调序的卡片"）
//
// 能力与 GridView 的行/列拖拽对齐：
//   按下拖拽柄 → 克隆整行做跟手虚影 → 拖动中相邻行实时让位（180ms）
//   → 松手重排 + 被移动行 200ms 滑入落点。
//
// 为什么不用原生 HTML5 拖拽：
//   1. drag 会话期间 Chromium 不推进 CSS transition，让位只能「瞬间跳过去」；
//   2. 默认拖动快照只是被拖的那个元素（比如一个 ⠿ 手柄），要整行得靠 setDragImage，
//      而它对正在拖拽的源元素不可靠。
//
// 为什么松手全程要临时关过渡 + 用 transition（而非 el.animate）做落位：
//   1. clearShift 只清 inline 的 transform/transition，样式层的 `transition: transform` 还在，
//      于是所有让位行会先「滑回原位」再被重排推走 —— 看起来整体抖一下；
//   2. 落位那一行如果交给 WAAPI，第一帧要到下一帧才生效，而这一帧它已经在新位置了，
//      会先闪一下新位置再跳回旧位置 —— 就是「被拖的行回来时跳一下」。
//   所以顺序固定为：全员 transition:none → 清位移 → 重排 → 钉住旧位置 → void offsetHeight
//   强制提交 → 恢复过渡 → 置空 transform 滑回。
//
// 用法：
//   const sort = useRowSortDrag({ items, dragIdx, overIdx, attr: 'data-cond-idx', rowClass: 'cond-row-dragging' })
//   模板：行容器加 :attr="items.indexOf(item)"、:class="{ [rowClass]: dragIdx === items.indexOf(item) }"，
//        手柄 @mousedown="sort.handleDown($event, items.indexOf(item))"，容器 @scroll="sort.onScroll"
// =========================================================================
import { nextTick, onBeforeUnmount } from 'vue'
import { applyRowShift, clearShift, createEdgeAutoScroll } from './tableDragFx'
import { useDisposables } from '../utils/disposables.js'

const EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)'
// 插入位判定的滞回死区（px）：交界处上下微抖不切换
const INSERT_DEAD = 5
// 新增/删除行的高度过渡：height + opacity + margin 一起走，收完后行距不会残留空隙
const ROW_MS = 200
const ROW_TRANS = `height ${ROW_MS}ms ${EASE}, opacity ${ROW_MS}ms ease, margin-bottom ${ROW_MS}ms ${EASE}`

export function useRowSortDrag({ items, dragIdx, overIdx, attr, rowClass = '', onMoved = null }) {
  const sel = `[${attr}]`
  // 资源登记表：行进/行出的动画收尾定时器登记在这里，组件卸载时自动清掉
  // （原先不落盘 → 卸载后仍在改已销毁元素的样式）。
  const disposables = useDisposables()

  // 拖拽期临时状态（非响应式：每帧读写，不参与渲染）
  let list = null   // 行所在容器
  let rows = null   // 行元素数组（与 items 同序）
  let geom = null   // 各行上下边界缓存
  let avgH = 0
  let ghost = null  // 跟手虚影
  let grab = null
  let lastEv = null
  let raf = 0
  let onMove = null
  let onUp = null
  let autoScroll = null // 边缘自动滚动句柄（列表限高可滚时才有意义）
  let lastScrollTop = 0 // 缓存几何时的 scrollTop，用于滚动补偿
  let lastP = 0         // 当前插入位（滞回判定的基准）

  // 拖动开始时一次性量出各行边界：拖动中只做数值比较，不再读布局
  function cacheGeom() {
    rows = []
    geom = []
    avgH = 0
    if (!list) return
    const nodes = list.querySelectorAll(sel)
    let sum = 0
    for (const n of nodes) {
      const b = n.getBoundingClientRect()
      rows.push(n)
      geom.push({ top: b.top, bottom: b.bottom })
      sum += b.bottom - b.top
    }
    avgH = rows.length ? Math.round(sum / rows.length) : 0
    lastScrollTop = list.scrollTop
  }

  // 滚动补偿：拖动中让位的行带着 transform，此时 getBoundingClientRect 量到的是**视觉位置**，
  // 一旦重新测量，缓存就被污染，后面每一格让位都按错基准算 —— 表现就是「滚出来那几行偏移离谱」。
  // 所以滚动后只把缓存整体按滚动量平移，绝不重新测量。
  function syncScroll() {
    if (!list) return
    const st = list.scrollTop
    const dy = st - lastScrollTop
    if (!dy) return
    lastScrollTop = st
    if (geom) for (const r of geom) if (r) { r.top -= dy; r.bottom -= dy }
  }

  // 鼠标纵坐标 → 插入位 p（0..len）：落在某行上半就插到它之前，下半插到它之后。
  // 边界带 5px 死区（滞回）：鼠标停在两行交界处上下微抖时，插入位不跟着翻 ——
  // 否则那一行会「让位 / 复位 / 再让位」反复抽（表现就是"某行在纠结要不要让位"）。
  // 规则：当前已经在第 i 行之前(lastP===i)时要退到「中线 + 死区」以下才切到 i+1；
  //       已经在之后(lastP===i+1)时要越过「中线 - 死区」才切回 i。
  function insertAtY(clientY) {
    if (!geom || !geom.length) return 0
    const cur = lastP
    for (let i = 0; i < geom.length; i++) {
      const r = geom[i]
      if (!r) continue
      if (clientY < r.bottom) {
        const mid = (r.top + r.bottom) / 2
        const edge = cur === i ? mid + INSERT_DEAD : (cur === i + 1 ? mid - INSERT_DEAD : mid)
        const p = clientY < edge ? i : i + 1
        lastP = p
        return p
      }
    }
    lastP = geom.length
    return lastP
  }

  // 插入位 → 让位用的「目标行下标」：applyRowShift 表达的是「移到第几行」，往后插要减 1
  function targetRow(from, p) {
    const len = items.value.length
    const at = Math.max(0, Math.min(p, len))
    const row = from < at ? at - 1 : at
    return Math.max(0, Math.min(row, len - 1))
  }

  // 克隆整行作为跟手虚影：宽度按原件实测固定，否则行内 flex 会重新分配
  function createGhost(rowEl) {
    const r = rowEl.getBoundingClientRect()
    if (!r.width || !r.height) return null
    const wrap = document.createElement('div')
    wrap.style.cssText = 'position:fixed;left:0;top:0;z-index:100000;pointer-events:none;overflow:hidden;'
      + 'will-change:transform;contain:layout paint;box-shadow:0 6px 18px rgba(0,0,0,.18);border-radius:8px;'
      + `width:${r.width}px;height:${r.height}px;opacity:.92`
    const g = rowEl.cloneNode(true)
    if (rowClass) g.classList.remove(rowClass)
    g.style.cssText = `margin:0;width:${r.width}px;transition:none`
    wrap.appendChild(g)
    document.body.appendChild(wrap)
    return wrap
  }

  // rAF 帧内执行：虚影跟手 + 目标行变了才重算让位（每帧无条件全量遍历是卡顿主因）
  function applyMove() {
    if (!ghost || !lastEv) return
    syncScroll() // 先补偿滚动，再判定落点
    const ev = lastEv
    ghost.style.transform = `translate(${ev.clientX - grab.x}px, ${ev.clientY - grab.y}px)`
    const to = targetRow(dragIdx.value, insertAtY(ev.clientY))
    if (to === overIdx.value) return
    overIdx.value = to
    applyRowShift(rows, dragIdx.value, to, geom, avgH)
  }

  /** 关掉/恢复整批行的过渡（松手重排期间用） */
  function setTransition(els, value) {
    if (!els) return
    for (const el of els) if (el && el.isConnected) el.style.transition = value
  }

  /** 清理拖拽现场。只清位移与状态，过渡由 finish 统一掌控（见下方 FLIP） */
  function clear() {
    if (autoScroll) { autoScroll.stop(); autoScroll = null }
    if (list) clearShift(list)
    list = null
    rows = null
    geom = null
    avgH = 0
    lastScrollTop = 0
    if (dragIdx) dragIdx.value = null
    if (overIdx) overIdx.value = null
  }

  /**
   * 拖拽中途被卸载（切页/关弹窗）：必须原地放弃，不能走 finish ——
   * finish 会按 lastEv 的落点把行真的挪过去，用户没松手却改了顺序。
   * 原先完全没有 onBeforeUnmount：ghost 留在 body、window 上挂着 mousemove/mouseup、
   * rAF 与自动滚动的帧还在跑，指向已经销毁的行元素（审查 v4 · B10-08）。
   */
  function abortDrag() {
    if (onMove) window.removeEventListener('mousemove', onMove)
    if (onUp) window.removeEventListener('mouseup', onUp)
    onMove = null
    onUp = null
    if (raf) { cancelAnimationFrame(raf); raf = null }
    if (autoScroll) { try { autoScroll.stop() } catch (_) { /* 已停止 */ } autoScroll = null }
    if (ghost) { ghost.remove(); ghost = null }
    lastEv = null
    if (rows) {
      setTransition(rows, 'none')
      clear()
      setTransition(rows, '')
    }
    dragIdx.value = null
    if (overIdx) overIdx.value = null
  }

  onBeforeUnmount(abortDrag)

  function finish(ev) {
    if (onMove) window.removeEventListener('mousemove', onMove)
    if (onUp) window.removeEventListener('mouseup', onUp)
    onMove = null
    onUp = null
    if (raf) { cancelAnimationFrame(raf); raf = null }
    applyMove() // 冲刷最后一帧

    const from = dragIdx.value
    const y = ev && typeof ev.clientY === 'number' ? ev.clientY : (lastEv ? lastEv.clientY : null)
    const p = y === null || from === null ? from : insertAtY(y)
    const els = rows
    const movedEl = els && from !== null ? els[from] : null
    // FLIP 起点：松手这一刻的实测位置（不要用按下时缓存的几何——拖动中容器滚动/其它行高度变化都会让它过期）
    const oldTop = movedEl ? movedEl.getBoundingClientRect().top : null
    lastEv = null
    if (ghost) { ghost.remove(); ghost = null }

    // 整个「清位移 → 重排 → 钉住 FLIP 起点」都在 transition:none 下完成：
    // 否则样式层的过渡会让每一行先「滑回原位」再被重排推走，看起来整体抖一下。
    setTransition(els, 'none')
    // 先清位移再重排（同一 tick）：中间行重排后的真实位置正好等于它们让位到的位置
    clear()
    if (from === null || !movedEl || p === null) { setTransition(els, ''); return }

    const before = items.value.slice()
    const [moved] = items.value.splice(from, 1)
    items.value.splice(from < p ? p - 1 : p, 0, moved)
    if (onMoved) onMoved()
    // 顺序没变（插回原位）就不播落位动画
    if (before.every((n, i) => n === items.value[i])) { setTransition(els, ''); return }

    nextTick(() => {
      if (!movedEl.isConnected || oldTop === null) { setTransition(els, ''); return }
      const nb = movedEl.getBoundingClientRect()
      const dy = Math.round(oldTop - nb.top)
      if (!dy) { setTransition(els, ''); return }
      // 先把它钉在旧位置（此时过渡还是 none，不会看到任何中间态），
      // 再强制一次布局把起点提交掉，最后恢复过渡让它滑回 0。
      // 必须用 transition + offsetHeight 而不是 el.animate()：WAAPI 的第一帧要到下一帧才生效，
      // 这一帧元素已经在新位置了，会先闪一下再跳回旧位置——就是「松手时抖一下」。
      movedEl.style.transform = `translateY(${dy}px)`
      void movedEl.offsetHeight
      setTransition(els, '')
      movedEl.style.transition = `transform 200ms ${EASE}`
      movedEl.style.transform = ''
      // 动画结束后摘掉 inline 过渡，交回样式层
      setTimeout(() => { if (movedEl.isConnected) movedEl.style.transition = '' }, 240)
    })
  }

  /** 拖拽柄按下：进入指针拖拽（调用方在模板上绑 @mousedown） */
  function handleDown(e, index) {
    if (e.button !== 0) return
    const handle = e.currentTarget
    const rowEl = handle && handle.closest ? handle.closest(sel) : null
    if (!rowEl) return
    // 防御：手柄上若残留 draggable（老版本模板），浏览器会同时发起原生拖拽，
    // 表现为「跟着鼠标的只有 ⠿ 小图标」。这里显式摘掉，只走指针拖拽一条路。
    if (handle.removeAttribute) handle.removeAttribute('draggable')
    e.preventDefault()
    clear()
    const rect = rowEl.getBoundingClientRect()
    dragIdx.value = index
    lastP = index // 初始视为原地
    if (overIdx) overIdx.value = index
    // 容器直接取行的父元素：不依赖模板 ref（ref 没绑上时几何为空，让位会整体空转）
    list = rowEl.parentElement
    cacheGeom()
    ghost = createGhost(rowEl)
    grab = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    if (ghost) ghost.style.transform = `translate(${rect.left}px, ${rect.top}px)`

    const move = (ev2) => {
      lastEv = ev2
      // 拖到列表上下边缘时按距离加速滚动（列表限高时才起作用；不可滚则内部自动停）
      if (autoScroll) autoScroll.update(ev2.clientX, ev2.clientY)
      if (raf) return
      raf = requestAnimationFrame(() => { raf = null; applyMove() })
    }
    const up = (ev2) => finish(ev2)
    onMove = move
    onUp = up
    // passive：不阻止默认行为，声明后不阻塞滚动/合成路径
    window.addEventListener('mousemove', move, { passive: true })
    window.addEventListener('mouseup', up, { passive: true })

    // 边缘自动滚动：滚动本身由 syncScroll() 统一补偿几何（见该函数注释），
    // 这里只负责推动一帧重算落点，别在这里再减一次滚动量 —— 会和 scroll 补偿叠加成双倍偏移。
    // 参数说明：条件区只有 112px 高，默认 edge=56 会让上下触发区把整个容器铺满（每处都在滚、
    // 永远停不下来）—— 压到 28，中间留 56px 安全区；maxSpeed 默认 22px/帧（≈1300px/s）对
    // 34px 高的条件行也太快，降到 10（≈600px/s）。
    autoScroll = createEdgeAutoScroll(() => list, () => {
      if (raf) return
      raf = requestAnimationFrame(() => { raf = null; applyMove() })
    }, { edge: 28, maxSpeed: 10 })
  }

  /** 容器滚动后几何失效：只做平移补偿，然后让让位位移跟上（不要重新测量） */
  function onScroll() {
    if (dragIdx.value === null) return
    syncScroll()
    applyRowShift(rows, dragIdx.value, overIdx ? overIdx.value : dragIdx.value, geom, avgH)
  }

  /** 当前列表里的行元素（按 DOM 顺序 = 数据顺序）。用于新增/删除的高度动画 */
  function rowEls() {
    const first = document.querySelector(sel)
    return first && first.parentElement ? Array.from(first.parentElement.querySelectorAll(sel)) : []
  }

  /** 把某行滚进可视区（列表限高时才需要）。只在被遮住时滚，滚到位就停，不硬拉到底 */
  function scrollRowIntoView(el, fullHeight) {
    const box = el.parentElement
    if (!box || box.scrollHeight <= box.clientHeight) return
    const er = el.getBoundingClientRect()
    const br = box.getBoundingClientRect()
    // 用完整高度算下沿：调用时机在把行压成 0 高之前，否则算出来的是"顶部那一行"
    const bottom = er.top + (fullHeight || er.height)
    if (bottom > br.bottom) {
      box.scrollTo({ top: box.scrollTop + (bottom - br.bottom), behavior: 'smooth' })
    } else if (er.top < br.top) {
      box.scrollTo({ top: box.scrollTop - (br.top - er.top), behavior: 'smooth' })
    }
  }

  /**
   * 新增行的高度展开：从 0 高淡入到实际高度。
   * 必须在 DOM 已渲染后调用（nextTick 里），否则量不到高度。
   * 行内下拉是 Teleport 到 body 的，所以临时加 overflow:hidden 不会裁掉菜单。
   */
  function enterAt(index) {
    const el = rowEls()[index]
    if (!el) return
    const h = el.getBoundingClientRect().height
    if (!h) return
    // 列表出现滚动条时，把新增的这一行滚进视野（此时还没压成 0 高，量得到下沿）
    scrollRowIntoView(el, h)
    el.style.height = '0px'
    el.style.opacity = '0'
    el.style.marginBottom = '0'
    el.style.overflow = 'hidden'
    void el.offsetHeight // 提交起点，否则浏览器合并成一次样式变更、动画不播
    el.style.transition = ROW_TRANS
    el.style.height = h + 'px'
    el.style.opacity = '1'
    el.style.marginBottom = '' // 交回 .mb-1
    disposables.timeout(() => {
      if (!el.isConnected) return
      el.style.height = ''
      el.style.opacity = ''
      el.style.marginBottom = ''
      el.style.overflow = ''
      el.style.transition = ''
    }, ROW_MS + 40)
  }

  /**
   * 删除行的高度收起：先量高钉住，再收到 0，动画结束后由 after 真正从数据里移除。
   * after 里请用对象身份定位下标（动画期间列表可能被再次修改）。
   */
  function leaveAt(index, after) {
    const el = rowEls()[index]
    const done = () => { if (after) after() }
    if (!el) { done(); return }
    const h = el.getBoundingClientRect().height
    if (!h) { done(); return }
    el.style.height = h + 'px'
    el.style.overflow = 'hidden'
    void el.offsetHeight
    el.style.transition = ROW_TRANS
    el.style.height = '0px'
    el.style.opacity = '0'
    el.style.marginBottom = '0'
    disposables.timeout(done, ROW_MS)
  }

  return { handleDown, clear, onScroll, enterAt, leaveAt }
}
