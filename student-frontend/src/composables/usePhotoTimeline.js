// =========================================================================
// usePhotoTimeline.js —— 相册「按日期分组的照片网格」窗口化虚拟滚动
//
// 纯代码搬运：逻辑与原 AlbumView.vue 里的实现一致（含注释），抽出后由
// 相册页（AlbumView）与「选择照片」弹窗（PhotoPickerDialog）共用，
// 避免两处各写一份窗口计算、尺寸测量与滚动监听。
//
// 以“日期分组”为窗口单元：外部用总高度撑起滚动条，
// 内部只挂载视口附近（含缓冲）的分组，其余用绝对定位占位。
// 分组内部 grid 用固定尺寸的方形格子（flex-wrap），
// 列数由容器宽度按「目标格宽 200px」反推、格子尺寸再据此平均分配，
// 保证各分组高度可精确预算，无需测量。
// =========================================================================
import { ref, computed, nextTick, watch, onBeforeUnmount } from 'vue'

export function usePhotoTimeline(groupsRef, options = {}) {
  const GAP = options.gap ?? 12       // 格子间距（与模板 gap-3 一致）
  const HEADER = options.header ?? 40 // 分组日期标题高度约值
  const GROUP_GAP = options.groupGap ?? 32 // 组间距（与模板 mb-8 一致）
  const BUFFER = options.buffer ?? 900     // 上下预留缓冲，提前渲染避免闪过空白
  // 单张格子的最小宽度（CSS px）：列数由此反推，格子永远不会比它更窄
  const CELL_MIN = options.cellMin ?? 200
  // 最少列数：放到 1 —— 窗口很窄时干脆只排一张，格子铺满宽度（正方形）。
  const MIN_COLS = options.minCols ?? 1
  const MAX_COLS = options.maxCols ?? 12
  // 宽度量化台阶（CSS px）：容器宽度每变化满 3px 才真正重算一次格子尺寸。
  // 拖窗口时 resize 每帧都来，宽度动 1px 就重算一次的话：cell 每帧变 1px →
  // 每个可见组的 top、每张格子的 width/height 每帧都在改 → 整片照片跟着画面重排，
  // 手一停就停、手一动就抖，正是「静止稳定、拖动乱跳」的观感来源。
  // 量化到台阶之后，台阶内部一个字节都不改 DOM，跨台阶才动一次（且幅度仅 1~3px）。
  const WIDTH_STEP = options.widthStep ?? 3

  const containerRef = ref(null)
  const scrollTop = ref(0)
  const clientH = ref(0)
  const viewW = ref(0)
  const cols = ref(6)
  const cell = ref(150)
  let rafId = 0

  // ===== 列数自适应：单一宽度区间映射 =====
  // 规则：单张格子宽 ≥ CELL_MIN 的前提下，尽量少用列数（格子尽量大）。
  //   n = 满足「n 列时 cellAt(n) ≥ CELL_MIN」的最大 n
  // 于是格子宽被夹在一个固定区间里：
  //   3 列 ≈ 200~270、5 列 ≈ 200~240、8 列 ≈ 200~226（列越多波动越小）
  // 宽度在这个区间内增大 → 只是格子变大，不动列数；越过上沿才加一列，
  // 格子回落到 CELL_MIN 附近，再继续往上长，直到下一次过阈值。
  //
  // 【必须是「只依赖宽度」的纯函数 —— 这里踩过坑，别再改回带滞回的版本】
  // 旧实现是「以当前列数为起点」的滞回：加列要 cellAt(n+1) ≥ 200、减列要
  // cellAt(n) < 188。那 12px 死区（格子 188~200，宽约 788~836px）里 3 列和 4 列
  // 都能过判定 —— 从 3 列来停在 3，从 4 列来停在 4。同一宽度于是有两个合法答案，
  // 取决于历史：窗口从大拖小、从小拖大、切页回来重新 measure，三条路径落到不同列数，
  // 表现出来就是用户说的「一下判定 3 列、一下 4 列，反复横跳」。
  // 每横跳一次，格子尺寸、组内换行、每组高度、FLIP 飞位全部重来一遍 → 整片照片乱跳。
  // 纯函数保证同一宽度恒得同一列数，任何调用时序、任何历史都无从产生横跳。
  function columnsFor(width) {
    if (!width) return 6
    // 满足 cellAt(n) ≥ CELL_MIN 的最大 n ⟺ width ≥ n*CELL_MIN + (n-1)*GAP
    const n = Math.floor((width + GAP) / (CELL_MIN + GAP))
    return Math.max(MIN_COLS, Math.min(MAX_COLS, n))
  }

  function measure() {
    const el = containerRef.value
    if (!el) return
    // KeepAlive 缓存的页面，DOM 被挪进一个未插入文档的 div。那种状态下 clientWidth
    // 读出来是 0，会把列数误判成「不限宽」的分支，切回来又是一次假变化。
    if (!el.isConnected) return
    const w = el.clientWidth
    const h = el.clientHeight
    // 宽度为 0（最小化、被 display:none 藏起）时不判定列数：columnsFor(0) 会走到
    // 默认的 6 列，等于凭空制造一次「列数变化」。
    if (!w) return
    // 向下量化到 WIDTH_STEP 的整数倍。必须「向下」：量化后的宽度不大于真实可用宽，
    // 据此算出的 cell 总和才永远塞得进一行（向上取整会让末张挤到下一行，
    // 一行少排一张 —— 那是比抖动更大的跳）。
    const wq = Math.max(WIDTH_STEP, w - (w % WIDTH_STEP))
    // 尺寸没变就什么都不用做。这是防抖动的第一道闸：measure 会被 mounted / activated /
    // reset / window resize 多处调用，其中不少是重复触发；没有变化还重算一遍，
    // 只会白白多出一次判断列数的机会（也就是多一次横跳的机会）。
    if (viewW.value === wq && clientH.value === h) return
    const first = viewW.value === 0
    // 首次测量不算「列数变化」，否则一进页面就播一段没意义的动画。
    // 注意这里不再把当前列数喂给 columnsFor —— 纯函数只认宽度（见上方注释）。
    // 列数判定用未量化的真实宽度：阈值间距 212px，量化 3px 不可能让它判错，
    // 但用量化值会让加列点整体左移一点，没必要。
    const n = columnsFor(w)
    const colsChanged = !first && n !== cols.value

    // 量旧位置之前必须先收掉上一轮 FLIP：否则 getBoundingClientRect 读到的是
    // 「过渡中途」的矩形（FLIP 的 transform 会算进 getBoundingClientRect 里），
    // 拿它当基准算出来的位移是错的 —— 误差会在下一轮被放大。
    if (colsChanged) clearFlip()
    const before = colsChanged ? captureCellRects(el) : null
    // 锚点无条件记录（必须在改 cols / cell 之前，读的是旧 layout）：
    // 只要格子尺寸变了，上方每一组都会跟着变高变矮，即使列数没变，视口里的内容
    // 也会整体上下漂 —— 这就是「拖动窗口时照片一直在跳」的另一半原因。
    const anchor = anchorGroup(el.scrollTop)

    viewW.value = wq
    clientH.value = h
    const prevCell = cell.value
    cols.value = n
    // 把剩余宽度平均分给每格，让格子尽量铺满容器（仍是正方形）。
    //
    // 【必须留余量 —— 这是「算 4 列、却只渲染 3 张一行」的真凶】
    // 内层是 flex-wrap，它判断「还放不放得下」用的是亚像素的真实可用宽度；
    // 而 clientWidth 是四舍五入后的整数。实测角标 w=864 / cols=4 / cell=207：
    //   4 × 207 + 3 × 12(gap) = 828 + 36 = 864，跟报上来的宽度一模一样。
    // 容器实际只有 863.5 时也会报 864 → 差 0.5px → 第 4 张被挤到下一行，
    // 但行高预算是按 4 列算的。于是「列数」和「每行实际张数」永远对不上，
    // 窗口挪 1px 那零点几像素就翻一次 → 看起来就是 3 列↔4 列反复横跳。
    // 留 2px 吸收这个取整误差：4 列时 4×206+36 = 860 < 863.5，稳稳放得下。
    const FIT_SLACK = 2
    cell.value = cols.value > 1
      ? Math.floor((wq - (cols.value - 1) * GAP - FIT_SLACK) / cols.value)
      : wq
    const cellChanged = cell.value !== prevCell

    if (!colsChanged && !cellChanged) return
    // 先补偿滚动位置（layout 已按新列数 / 新格子尺寸重算过），再等 DOM 落地后飞位。
    // 列数不变、只是格子尺寸变时同样要补：否则上面每组矮 1px，累积十几组，
    // 视口顶部的照片就整体上浮几像素（每帧漂一点，看起来就是不停在跳）。
    restoreScroll(el, anchor)
    /* 只在「列数变了」时播飞位动画。拖动中每 3px 一次测量都可能走到这里，
       所以动画会不断被下一轮 clearFlip 收掉、从头再来 —— 这是「跟手」换来的代价：
       连续变化时动画本来就播不完，收干净比硬扛好看。
       注意不要再回到「用时间间隔猜是不是还在拖」那套：它和任何一种延迟落位方案
       都会互相打架，最后把真正该播的那一次也吞掉。 */
    if (colsChanged) nextTick(() => playFlip(el, before))
  }

  const cellStyle = computed(() => ({ width: cell.value + 'px', height: cell.value + 'px' }))

  function groupHeight(g) {
    const n = g.photos ? g.photos.length : 0
    const rows = n ? Math.ceil(n / cols.value) : 0
    return HEADER + (rows ? rows * cell.value + (rows - 1) * GAP : 0)
  }

  const layout = computed(() => {
    const groups = groupsRef.value || []
    let offset = 0
    const items = []
    for (const g of groups) {
      const h = groupHeight(g)
      items.push({ g, offset, h })
      offset += h + GROUP_GAP
    }
    return { total: offset, items }
  })

  const totalH = computed(() => layout.value.total)

  const visibleGroups = computed(() => {
    const top = scrollTop.value - BUFFER
    const bottom = scrollTop.value + clientH.value + BUFFER
    return layout.value.items
      .filter(v => v.offset + v.h >= top && v.offset <= bottom)
      .map(v => ({ g: v.g, offset: v.offset }))
  })

  /* =========================================================================
     列数变化时的 FLIP 飞位动画

     为什么不直接给格子宽高挂 transition：列数一变，格子尺寸、组内换行位置、
     每组高度、每一组的绝对定位 offset 会同时变。CSS 只能过渡「尺寸」，
     位置照样瞬移（第 5 张从第二行跳回第一行），看起来是「缩了一下然后跳开」。

     所以走 FLIP：先量旧位置 → DOM 更新后量新位置 → 用 transform 把它们拉回旧位置
     → 下一帧放开（transform 归零，由 transition 补这一段）。视觉上照片从旧位置飞到新位置。

     拖窗口时 resize 每帧都来，动画必然被下一次布局变化打断。这里从两头解决：
     拖动期间不 measure（尺寸冻结，见 schedule），所以动画不会被逐帧打断；
     真出现「上一轮还没播完又变了」，clearFlip() 把 inline transform 收干净再重来。
     ========================================================================= */
  const FLIP_MS = 200
  let flipSeq = 0
  let flipTimer = 0
  let flipNodes = []

  // 记录可见格子在「滚动容器视口」里的位置。
  // 用视口坐标而不是内容坐标：动画要对齐的是屏幕上的位置，
  // 而列数变化时滚动位置也会被补偿（见 restoreScroll），内容坐标反而不直观。
  function captureCellRects(el) {
    const base = el.getBoundingClientRect()
    const map = new Map()
    for (const node of el.querySelectorAll('[data-cell-id]')) {
      const r = node.getBoundingClientRect()
      map.set(node.dataset.cellId, { left: r.left - base.left, top: r.top - base.top, w: r.width })
    }
    return map
  }

  function clearFlip() {
    flipSeq++
    if (flipTimer) { clearTimeout(flipTimer); flipTimer = 0 }
    for (const node of flipNodes) {
      node.style.transition = ''
      node.style.transformOrigin = ''
      node.style.transform = ''
    }
    flipNodes = []
  }

  function playFlip(el, before) {
    clearFlip()
    if (!before || !before.size) return
    const seq = flipSeq
    const base = el.getBoundingClientRect()
    const moved = []
    for (const node of el.querySelectorAll('[data-cell-id]')) {
      const old = before.get(node.dataset.cellId)
      if (!old) continue // 滚动补偿后新进视口的照片没有旧位置，直接以终态出现
      const r = node.getBoundingClientRect()
      const dx = old.left - (r.left - base.left)
      const dy = old.top - (r.top - base.top)
      const scale = r.width ? old.w / r.width : 1
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.005) continue
      node.style.transition = 'none'
      node.style.transformOrigin = '0 0'
      node.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) scale(${scale.toFixed(4)})`
      moved.push(node)
    }
    if (!moved.length) return
    flipNodes = moved
    /* 【这一行是动画能不能播出来的关键】
       反向位移（transform）是在 nextTick 微任务里设的，此时浏览器还没算过样式；
       紧接着注册的 rAF 回调，在同一帧里跑在「样式计算 / 布局」之前。于是浏览器
       第一次真正计算样式的时候，看到的已经是我们在 rAF 里改完的样子 —— 起点被
       清空、终点也是空，前后状态一模一样 → 它认为没有任何变化 → transition 不触发。
       表现出来就是：松手后瞬间跳过去，一点过渡都没有。
       读 offsetHeight 会同步 flush 样式与布局，把「反向位移」这一刻固定成真正的起点；
       之后 rAF 里再清空 transform，浏览器才有「从 A 过渡到 B」这件事可做。 */
    void el.offsetHeight
    requestAnimationFrame(() => {
      if (seq !== flipSeq) return // 期间又变了列数，这一批已经被 clearFlip 收拾过
      for (const node of moved) {
        node.style.transition = `transform ${FLIP_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`
        node.style.transform = ''
      }
      flipTimer = setTimeout(clearFlip, FLIP_MS + 60)
    })
  }

  // 当前视口顶部停在哪一组（必须在改 cols 之前调用，读的是旧 layout）
  function anchorGroup(scroll) {
    const items = layout.value.items
    if (!items.length) return null
    let hit = items[0]
    for (const it of items) {
      if (it.offset <= scroll) hit = it
      else break
    }
    return { date: hit.g.date, delta: scroll - hit.offset }
  }

  // 列数变了 → 每组行数、内容总高全都变。不补偿的话，视口里原本看着 5 月，
  // 加一列之后会变成看着 4 月（内容整体往上漂）。这里让「顶部那一组」停在原处。
  function restoreScroll(el, anchor) {
    const items = layout.value.items
    const max = Math.max(0, layout.value.total - el.clientHeight)
    const hit = anchor ? items.find(it => it.g.date === anchor.date) : null
    const top = hit ? Math.min(Math.max(0, hit.offset + anchor.delta), max) : Math.min(el.scrollTop, max)
    el.scrollTop = top
    // 必须同步写：scroll 事件走 rAF，晚一帧的话虚拟窗口会先用旧 scrollTop 算一遍可见组
    scrollTop.value = top
  }

  function onScroll() {
    const el = containerRef.value
    if (!el) return
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      scrollTop.value = el.scrollTop
      clientH.value = el.clientHeight
    })
  }

  // ===== 直接跟着容器尺寸走（拖动中每帧重算）=====
  // 曾经试过「拖动期间冻结尺寸、松手才落位」，结果是一次拖动里格子尺寸变两次
  // （跨档一次、松手微调一次），后半段没动画 → 观感是「飞位播完又突然胀大」。
  // 回到最初做法：窗口怎么变，格子就怎么跟，一次拖动只产生一条连续的尺寸曲线。
  // 代价是每帧都会重排一次，交给上面 WIDTH_STEP 的 3px 台阶压一压频率。
  function schedule() {
    const el = containerRef.value
    if (!el || !el.isConnected) return
    if (el.clientHeight && el.clientHeight !== clientH.value) clientH.value = el.clientHeight
    measure()
  }

  function onResize() {
    schedule()
  }

  // ===== 盯住容器自身尺寸（不能只靠 window resize）=====
  // 容器宽度会因「与窗口无关」的原因变化：侧边栏折叠（Sidebar 有
  // transition: width 0.15s）、外层布局动画、详情面板开合……
  // 这些情况下窗口尺寸没变、resize 事件不触发，而 cell 仍是按旧（更宽）容器均分的：
  // 3 列的 270px 格子塞进已经变窄的容器，一行只排得下 2 张 —— 看起来就是
  // 「列数莫名掉了一档、过一会儿又自己回来」。ResizeObserver 直接量容器，
  // 把这类盲区一次堵掉（侧边栏过渡期间每帧都会回调，格子尺寸全程跟手）。
  // 回调只调 schedule，重复触发由 measure 开头的尺寸比对闸门拦掉。
  const resizeObs = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => schedule())
    : null
  watch(containerRef, (el, prev) => {
    if (!resizeObs) return
    if (prev) resizeObs.unobserve(prev)
    if (el) resizeObs.observe(el)
  }, { immediate: true })

  // 回到顶部并重新计量（切换相册 / 刷新后调用）
  async function reset() {
    scrollTop.value = 0
    const el = containerRef.value
    if (el) el.scrollTop = 0
    measure()
  }

  onBeforeUnmount(() => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
    if (resizeObs) resizeObs.disconnect()
    clearFlip()
  })

  return {
    containerRef, scrollTop, clientH, viewW, cols, cell,
    cellStyle, layout, totalH, visibleGroups,
    measure, onScroll, onResize, reset,
  }
}
