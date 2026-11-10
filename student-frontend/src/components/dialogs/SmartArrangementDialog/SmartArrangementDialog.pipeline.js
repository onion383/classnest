// ===== 智能排表：网格工具 + 统一条件流水线 =====
// 纯代码搬运自 SmartArrangementDialog.vue 的 methods，未改写逻辑；经 ctx 闭包调用（script setup）。
//
// 坐标口径（异形网格改造后）：本文件的算法一律在 **dense** 空间运行 ——
// 只有座位列、连续下标，行数与网格一致。压/展开由调用方（options.buildInitialSeats /
// buildSeatsOut）经 ctx 完成，算法内部不需要知道走廊在哪一列。
// 原先这里自带一份 generateColHeaders / getDisplayColCount / isAisleCol 公式拷贝，
// 用于在预览里「渲染期插走廊列」；走廊成为真实列后那三份拷贝已删除，改为
// 共用 composables/useSeatGrid.geometry.js（唯一几何来源）。
// Fisher-Yates 洗牌（组块置换模块也复用）
function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
export { shuffle }
// ctx 契约：状态 ref（.value 访问）与跨模块方法（运行时解析）。
export function useSmartArrangementPipeline(ctx, CONDITION_REGISTRY) {
  return {

    // ==================== 统一条件流水线（一层平铺，线性执行） ====================
    // 依据当前条件列表构建一张新的座位网格。
    // 每条条件都自带「作用域 scope」：先把区域按 scope 切成若干作用块，条件在每个块内生效；
    // 列表按顺序依次执行，越靠后的条件越晚执行、可部分覆盖前面的结果（越靠后越重要）。
    buildSeats() {
      ctx.satisfaction.value = {}
      const grid = ctx.initGrid()
      const all = ctx.allCells()
      for (const node of ctx.conditions.value) {
        // 作用域切块后取各块的格子列表，作为「区域」交给条件（条件内部再按 unit 切块）
        const regions = ctx.splitRegion(all, node.scope).map(b => b.pos)
        ctx.applyCondition(grid, regions, node)
      }
      return grid
    },

    // 应用单条条件（按条件类注册表查表分发）
    applyCondition(grid, regions, node) {
      if (!node) return
      const reg = CONDITION_REGISTRY[node.key]
      const fn = reg && reg.apply
      if (fn) this[fn](grid, regions, node)
    },

    // 初始化网格：从原座位表填满学生，未出现的学生补到空位
    // 只碰「可用格」（types 为座位的格子）：行走廊 / 空位在 dense 里仍是格子，
    // 不排除的话「全部同学」补位会把学生塞进走廊。
    initGrid() {
      const grid = Array.from({ length: ctx.rows.value }, () => new Array(ctx.cols.value).fill(null))
      const used = new Set()
      // 新同学(字符串名字)没有真实 id，给一个负 id 占位，使其能走通排表流水线
      let pseudoId = -1
      const pseudoCache = {}
      const ensurePseudo = n => {
        if (!pseudoCache[n]) pseudoCache[n] = { id: pseudoId--, 姓名: n }
        return pseudoCache[n]
      }
      for (let r = 0; r < ctx.rows.value; r++) {
        for (let c = 0; c < ctx.cols.value; c++) {
          if (!ctx.isUsable(r, c)) continue
          const val = ctx.baseSeats.value?.[r]?.[c]
          let s = null
          if (typeof val === 'number') {
            s = ctx.students.value.find(x => x.id === val)
          } else if (typeof val === 'string') {
            // 班级学生存 id，字符串名字均为"新同学"（未识别的自由文本）
            const n = val.trim()
            if (n && !(ctx.excludeNew.value && ctx.strangerNames.value.has(n))) s = ensurePseudo(n)
          } else if (val && typeof val === 'object') {
            const n = String(val.姓名 || '').trim()
            if (!(ctx.excludeNew.value && ctx.strangerNames.value.has(n))) {
              s = n ? ensurePseudo(n) : val
            }
          }
          if (s) { grid[r][c] = s; used.add(s.id) }
        }
      }
      // 数据源「现有排表表格」：只重排表里已有的人，空位保持空着；
      // 「全部同学」：把学生表里还没入座的同学补进空位
      if (ctx.dataSource.value !== 'table') {
        const rest = ctx.students.value.filter(s => !used.has(s.id))
        let k = 0
        for (let r = 0; r < ctx.rows.value && k < rest.length; r++) {
          for (let c = 0; c < ctx.cols.value && k < rest.length; c++) {
            if (!ctx.isUsable(r, c)) continue
            if (!grid[r][c]) { grid[r][c] = rest[k++]; used.add(rest[k - 1].id) }
          }
        }
      }
      return grid
    },
    // 全部可选格（dense 坐标）：走廊格 / 空位格不参与任何条件的作用域
    allCells() {
      const cells = []
      for (let r = 0; r < ctx.rows.value; r++) {
        for (let c = 0; c < ctx.cols.value; c++) {
          if (ctx.isUsable(r, c)) cells.push({ r, c })
        }
      }
      return cells
    },

    // dense 列坐标下，两列是否属于同一张桌。走廊被压掉后「隔走廊的两列」在 dense 里
    // 就是相邻下标，只看 c+1 会把它们当成同桌 —— 混合桌拆开后必须靠桌号表区分。
    // pure single/double 下桌号与老「算奇偶」完全等价（见 arrange-desk-mixed.test.js）。
    isDeskmateCols(ca, cb) {
      if (Math.abs(ca - cb) !== 1) return false
      const desk = ctx.deskIndex.value
      return desk[ca] != null && desk[ca] >= 0 && desk[ca] === desk[cb]
    },
    // 几何切块规则：column 一列（每列一块）| whole 一大组（整块）| six 相邻六位(3行×2列) | four 相邻四位(2行×2列)
    //             | student 同学（一人一格一块）| deskmate 同桌（同行左右相邻两人一块）
    shapeSpans(shape) {
      if (shape === 'column') return { rSpan: ctx.rows.value, cSpan: 1 }
      if (shape === 'whole') return { rSpan: ctx.rows.value, cSpan: ctx.cols.value }
      if (shape === 'six') return { rSpan: 3, cSpan: 2 }
      if (shape === 'student') return { rSpan: 1, cSpan: 1 }
      return { rSpan: 2, cSpan: 2 }
    },
    // 把区域按几何方式切成若干子块（scope 与 unit 共用此规则）
    splitRegion(region, shape) {
      // 同桌：不按矩形切，改按「同行相邻两列」成对（与人数桌模式无关，单/双人桌都适用）
      if (shape === 'deskmate') {
        const map = new Map()
        for (const p of region) {
          // 纯单座保留历史口径（每 2 列一块）；其余按桌号切 —— double 下桌号恰好
          // 等于 floor(c/2)，mixed 拆桌后每列自成一桌，不会再隔着走廊凑成一对。
          const key = ctx.mode.value === 'single' ? Math.floor(p.c / 2) : (ctx.deskIndex.value[p.c] ?? -1)
          const k = p.r + ',' + key
          let b = map.get(k)
          if (!b) { b = { br: p.r, bc: key, pos: [] }; map.set(k, b) }
          b.pos.push(p)
        }
        return [...map.values()]
      }
      const { rSpan, cSpan } = ctx.shapeSpans(shape)
      const map = new Map()
      for (const p of region) {
        const br = Math.floor(p.r / rSpan), bc = Math.floor(p.c / cSpan)
        const k = br + ',' + bc
        let b = map.get(k)
        if (!b) { b = { br, bc, pos: [] }; map.set(k, b) }
        b.pos.push(p)
      }
      return [...map.values()]
    },

    // 区域内单元格的"同桌槽位"：桌据模式（double）下偶数列相邻两格为一桌，其余为单格
    regionSlots(region) {
      const byRow = {}
      for (const p of region) (byRow[p.r] = byRow[p.r] || []).push(p.c)
      const slots = []
      const rows = Object.keys(byRow).map(Number).sort((a, b) => a - b)
      for (const r of rows) {
        const cols = byRow[r].sort((a, b) => a - b)
        const inRow = new Set(cols)
        let i = 0
        while (i < cols.length) {
          const c = cols[i]
          if (ctx.mode.value !== 'single' && ctx.isDeskmateCols(c, c + 1) && inRow.has(c + 1)) {
            slots.push([{ r, c }, { r, c: c + 1 }])
            i += 2
          } else {
            slots.push([{ r, c }])
            i += 1
          }
        }
      }
      return slots
    },
    cellOrder(region) {
      return [...region].sort((a, b) => (a.r - b.r) || (a.c - b.c))
    },
    // 把单元（同桌对 + 单座）填入区域槽位。返回成功保持相邻的同桌对数。
    //  - 同桌对不可拆分，优先占 2 格槽位；槽位不足时拆成两个单座（不丢学生）
    //  - 单座优先占 2 格槽位的左格（右侧留空，保持单桌视觉），槽位不足时填剩余空位
    fillSlots(grid, region, slots, units) {
      const twoSlots = slots.filter(s => s.length === 2)
      for (const p of region) grid[p.r][p.c] = null
      const pairs = units.filter(u => u.indivisible)
      const singles = units.filter(u => !u.indivisible)
      let placedPairs = 0
      pairs.forEach((u, i) => {
        if (i < twoSlots.length) {
          const s = twoSlots[i]
          grid[s[0].r][s[0].c] = u.cells[0]
          grid[s[1].r][s[1].c] = u.cells[1]
          placedPairs++
        } else {
          // 2 格槽位不足：拆成两个单座，保住学生
          singles.push({ cells: [u.cells[0]], indivisible: false })
          singles.push({ cells: [u.cells[1]], indivisible: false })
        }
      })
      // 单座优先占剩余 2 格槽位左格
      let si = 0
      for (let i = placedPairs; i < twoSlots.length && si < singles.length; i++) {
        grid[twoSlots[i][0].r][twoSlots[i][0].c] = singles[si].cells[0]
        si++
      }
      // 再填剩余空位
      const empties = ctx.cellOrder(region).filter(p => !grid[p.r][p.c])
      for (const p of empties) {
        if (si >= singles.length) break
        grid[p.r][p.c] = singles[si].cells[0]
        si++
      }
      return placedPairs
    },

    // 随机排表：在「作用域」内，按「操作单元」把内容整块打乱（单元即最小不可分割单位，成员不跨块）
    applyRandom(grid, regions, node) {
      const unit = node.unit || 'six'
      let total = 0
      for (const region of regions) {
        const blocks = ctx.splitRegion(region, unit)
        if (blocks.length >= 2) {
          ctx.applyPerm(grid, blocks, ctx.permWithinSizes(blocks))
        } else {
          // 只有一块时退化为「逐个学生」打乱，保证"换一换"仍能换出不同布局
          ctx.shuffleSingles(grid, region)
        }
        total += region.filter(p => grid[p.r][p.c]).length
      }
      ctx.trackSatisfaction(node.uid, total, total)
    },

    // 以「个人」为最小单位打乱（每个学生独立，不保留同桌对）
    shuffleSingles(grid, region) {
      const students = region.map(p => grid[p.r][p.c]).filter(s => s)
      const units = students.map(s => ({ cells: [s], indivisible: false }))
      ctx.fillSlots(grid, region, ctx.regionSlots(region), shuffle(units))
    },
  }
}
