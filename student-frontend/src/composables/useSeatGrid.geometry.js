// ==================== 座位网格几何（纯函数，零依赖）====================
//
// 单独成文件的原因：本模块要在 node 下单测（testjs/units/seat-geometry.test.js）。
// 放在 useSeatGrid.js 里的话，一 import 就把 axios / useUndo（用了路径别名）拉进来，
// 单测环境解析不了。这里只允许**纯计算**，不引 vue / axios / 任何带副作用的模块。
//
// 数据模型（异形网格改造后）：
//   seats  rows×cols 二维数组，值与 types **同下标**；走廊格 / 空位格恒为 null
//   types  rows×cols 整数矩阵：0=座位 1=走廊 2=空位
//   cols   网格总列数（含走廊列），不再是「座位列数」
//
// 走廊从此是**数据里的真实列/行**，渲染期不再插虚拟列。旧的
// getDisplayColCount / isAisleCol / displayColOfReal / realColMap 这套
// 「显示列 ↔ 真实列」换算已随本模型整体删除 —— 需要座位列序号时用
// seatColumnIndices() 现算，不要再引入第二份换算表。
export const CELL = { SEAT: 0, AISLE: 1, BLANK: 2 }

// 座位行数上限，与后端 services/sanitize.js 的 SEAT_MAX_ROWS 同值。
// 前端只用它做「别让用户白操作一次」的前置拦截（超了后端也会 400，但那个提示是通用文案）；
// 真正的权威仍是后端 —— 改这里必须同步改 sanitize.js。
export const SEAT_MAX_ROWS = 50

// 网格**总列数**上限（含走廊列），与后端 services/sanitize.js 的 SEAT_MAX_GRID_COLS 同值。
// 别和 SEAT_MAX_COLS（座位列数，设置界面的语义）混用：用座位列数的上限去卡网格坐标，
// 会把「30 个座位列 + 29 条走廊列 = 59 列」这种合法布局判成越界。改这里必须同步 sanitize.js。
export const SEAT_MAX_GRID_COLS = 60

// types 规整到 rows×cols：超出截断、不足补「座位」，非法值一律按座位处理。
// 宽松而非严格：这里只保证渲染不会越界，严格形状校验在后端（normalizeCellTypes）。
export function normalizeTypes(types, rows, cols) {
  const arr = Array.isArray(types) ? types : []
  const out = []
  for (let r = 0; r < rows; r++) {
    const src = Array.isArray(arr[r]) ? arr[r] : []
    const line = []
    for (let c = 0; c < cols; c++) {
      const v = src[c]
      line.push(v === CELL.AISLE || v === CELL.BLANK ? v : CELL.SEAT)
    }
    out.push(line)
  }
  return out
}

// 可用座位数：types 里值为「座位」的格子数。走廊与空位都不算 ——
// 智能排表能坐多少人、还差几个座位，全都以这个数为准（与后端 assertSeatCapacity 同口径）。
export function usableSeatCount(types) {
  let n = 0
  const arr = Array.isArray(types) ? types : []
  for (const line of arr) {
    if (!Array.isArray(line)) continue
    for (const v of line) if (v === CELL.SEAT) n++
  }
  return n
}

// 「设置空位」画笔的单格 toggle：座位 ↔ 空位，返回**新** types，不改入参。
// 三种拒绝理由都是「放行就静默出错」的：
//   outside  —— 坐标越界（键盘/程序路径），不能让它写坏矩阵
//   aisle    —— 走廊是几何骨架，逐格改成空位会让整条走廊塌成半截（后端也会拒）
//   occupied —— 有人的格子挖洞 = 那个人从座位表上消失，档案还在（9.6）
export function toggleHole(types, seats, r, c) {
  const line = Array.isArray(types) ? types[r] : null
  if (!Array.isArray(line) || !Number.isInteger(c) || c < 0 || c >= line.length) {
    return { ok: false, reason: 'outside' }
  }
  const cur = line[c]
  if (cur === CELL.AISLE) return { ok: false, reason: 'aisle' }
  if (cur === CELL.SEAT) {
    const v = Array.isArray(seats) && Array.isArray(seats[r]) ? seats[r][c] : null
    if (v !== null && v !== undefined && v !== '') return { ok: false, reason: 'occupied', value: v }
  }
  const next = types.map((l) => (Array.isArray(l) ? [...l] : []))
  next[r][c] = cur === CELL.BLANK ? CELL.SEAT : CELL.BLANK
  return { ok: true, types: next, to: next[r][c] }
}

// 全清空位：把 2 全部变回 0，走廊原样保留。
export function clearHoles(types) {
  const arr = Array.isArray(types) ? types : []
  return arr.map((line) => (Array.isArray(line)
    ? line.map((v) => (v === CELL.BLANK ? CELL.SEAT : v))
    : []))
}

// 按公式生成 types（cols 为网格总列数）：单桌每列后一条走廊，同桌每两列后一条。
// 只用于「设置变更时重建几何」——2B 阶段 types 除了迁移产物就只可能来自公式，
// 所以重建是无损的。
export function formulaTypes(rows, cols, mode) {
  const out = []
  for (let r = 0; r < rows; r++) {
    const line = []
    for (let c = 0; c < cols; c++) {
      // mixed 的初始几何与 double 完全一样（用户要求「混合桌初始化也是双桌模式」），
      // 之后拆桌子只改桌型序列，不改几何。
      const aisle = (mode === 'double' || mode === 'mixed') ? (c >= 2 && (c - 2) % 3 === 0) : (c % 2 === 1)
      line.push(aisle ? CELL.AISLE : CELL.SEAT)
    }
    out.push(line)
  }
  return out
}

// 每列是「走廊列」还是「座位列」：整列都是走廊才算走廊列。
// 后端校验保证走廊只能整行或整列，所以整列判定对合法数据是准确的；
// 局部走廊（行走廊与列走廊交叉）归到「座位列」侧，宁可多算一列也不吞掉数据。
export function columnKinds(cols, types) {
  const arr = Array.isArray(types) ? types : []
  const kinds = []
  for (let c = 0; c < cols; c++) {
    let allAisle = arr.length > 0
    for (let r = 0; r < arr.length; r++) {
      if (!Array.isArray(arr[r]) || arr[r][c] !== CELL.AISLE) { allAisle = false; break }
    }
    kinds.push(allAisle ? 'aisle' : 'seat')
  }
  return kinds
}

// 座位列在网格里的下标（升序），相当于旧的「真实列」。
export function seatColumnIndices(cols, types) {
  const kinds = columnKinds(cols, types)
  const out = []
  for (let c = 0; c < cols; c++) if (kinds[c] === 'seat') out.push(c)
  return out
}

// 网格列下标 → 座位列序号（dense 下标）；走廊列为 -1。
// seatColumnIndices 是 dense→grid，这个是它的逆映射，供「网格渲染 + dense 数据」并用时取值。
export function gridToDenseCols(cols, types) {
  const idx = seatColumnIndices(cols, types)
  const map = new Array(cols).fill(-1)
  idx.forEach((c, k) => { map[c] = k })
  return map
}

// 每行是否整行都是走廊（行走廊）。
export function rowIsAisle(types, r) {
  const line = Array.isArray(types) ? types[r] : null
  if (!Array.isArray(line) || !line.length) return false
  return line.every((v) => v === CELL.AISLE)
}

// 表头：走廊列标「走廊」，其余按座位列序号标「列N」。
export function generateColHeaders(cols, types) {
  const kinds = columnKinds(cols, types)
  const headers = []
  let seatNo = 0
  for (let c = 0; c < cols; c++) {
    headers.push(kinds[c] === 'aisle' ? '走廊' : `列${++seatNo}`)
  }
  return headers
}

// 设置弹窗里用户填的「座位列数」→ 网格总列数（含走廊列）。
// 这个换算是**写入时的一次性换算**：输入框语义始终是「有几个座位列」，
// 与 storage 里的 cols（网格列数）解耦。
export function seatColsToGrid(seatCols, mode) {
  const n = Number(seatCols) || 0
  if (n < 1) return 1
  return (mode === 'double' || mode === 'mixed') ? n + Math.floor((n - 1) / 2) : n + (n - 1)
}

// 网格总列数 → 座位列数（设置弹窗回显用），按整列走廊扣减。
export function gridColsToSeat(cols, types) {
  const kinds = columnKinds(cols, types)
  if (!kinds.length) return cols
  return Math.max(1, kinds.filter((k) => k === 'seat').length)
}

// ---------- 桌型：单座 / 双桌 / 混合 ----------
// deskPattern：每张桌坐几人（只能是 1 或 2）。它描述的是**桌**，不是座位列 ——
// 所以长度 = 桌数，元素之和 = 座位列数。这两条必须同时成立，否则桌号会越界或有的列没有桌。
// null / 不合法 → 按 mode 推：single 全 1、double 全 2。
// 为什么用「回退」而不是报错：老数据没有这个字段，mode 就是唯一真相；
// 而「长度对不上」只可能是改了座位列数之后没跟着重算，那种情况按 mode 兜底比留着一份
// 自相矛盾的桌型安全（否则会出现「第 7 列属于第 5 张桌」这种越界桌号）。
export function deskPatternOf(mode, seatCount, pattern) {
  const n = Math.max(0, Math.floor(Number(seatCount) || 0))
  const fallback = () => {
    // mixed 的兜底与 double 相同：混合模式初始化 = 双桌模式（用户可以再拆）
    if (mode !== 'double' && mode !== 'mixed') return new Array(n).fill(1)
    // double：每 2 个座位列一张桌，末尾落单的那列自成一桌（与「双人桌 7 列时
    // 实际是 3 张双人桌 + 1 个单座」同一口径）。不能直接 fill(2) —— 那样和会是 2n，
    // 与座位列数对不上，deskIndexOfPattern 会产出越界桌号。
    const out = []
    for (let rest = n; rest > 0; rest -= 2) out.push(rest >= 2 ? 2 : 1)
    return out
  }
  if (!Array.isArray(pattern) || !pattern.length) return fallback()
  const out = []
  let sum = 0
  for (const raw of pattern) {
    const v = Number(raw)
    if (v !== 1 && v !== 2) return fallback()
    out.push(v)
    sum += v
  }
  // 和必须等于座位列数：少了 = 有座位列没桌，多了 = 桌号越界。两种都回退，
  // 否则排表算法拿到的 deskIndex 是错位的（而且错得很隐蔽：每行都错同样多）。
  return sum === n ? out : fallback()
}

// 每张桌占几个座位列 → 每列（dense 座位列序号）属于第几桌。桌号从 0 起。
export function deskIndexOfPattern(pattern) {
  const out = []
  let desk = 0
  for (const size of Array.isArray(pattern) ? pattern : []) {
    for (let i = 0; i < size; i++) out.push(desk)
    desk++
  }
  return out
}

// 网格列 → 桌号（走廊列恒 -1）。渲染桌缝与排表算法查表都用它。
// 座位列与走廊列是两套下标，所以必须经 seatColumnIndices 转一次：
// 直接用网格下标去查 dense 数组，插过走廊之后整个错位。
// 从几何直接派生桌型：走廊列就是桌与桌的分界，不需要另存一份会跟撤销脱节的序列。
//   · single：每个座位列一张单人桌
//   · double：整行按「每 2 列一桌」切，走廊只是过道、不拆桌（保持老语义）
//   · mixed ：先按走廊把座位列切成连续块，块内每 2 列一桌，块尾落单的自成单人桌
// mixed 在双桌布局下（每 2 个座位列后一条走廊）天然派生出全 2 —— 这正是
// 「混合桌初始化 = 双桌模式」；在中间插一条走廊后，那一块被切成两个 1 列块，
// 于是同桌自动变成两张单人桌。拆桌/合并只改几何，撤销链路天然完整。
export function deriveDeskPattern(cols, types, mode) {
  const seatIdx = seatColumnIndices(cols, types)
  if (mode === 'single') return new Array(seatIdx.length).fill(1)
  if (mode === 'double') return deskPatternOf('double', seatIdx.length, [])
  const out = []
  let block = []
  let prev = -2
  const flush = () => {
    for (let i = 0; i < block.length; i += 2) out.push(i + 1 < block.length ? 2 : 1)
    block = []
  }
  for (const c of seatIdx) {
    if (block.length && c !== prev + 1) flush()
    block.push(c)
    prev = c
  }
  flush()
  return out
}

// 网格列 → 它所在的那张桌有几人（走廊列 0）。菜单靠它区分「能拆」和「能并」：
// 双人桌才能拆，两张单人桌才能并；只看桌号会把「两张双人桌」也当成可并（然后并出 3 人桌）。
export function deskSizeIndexOfGrid(cols, types, mode) {
  const seatIdx = seatColumnIndices(cols, types)
  const pattern = deskPatternOf(mode, seatIdx.length, deriveDeskPattern(cols, types, mode))
  const denseDesk = deskIndexOfPattern(pattern)
  const counts = new Map()
  for (const d of denseDesk) counts.set(d, (counts.get(d) || 0) + 1)
  const out = new Array(cols).fill(0)
  seatIdx.forEach((c, k) => { out[c] = counts.get(denseDesk[k]) || 0 })
  return out
}

export function deskIndexOfGrid(cols, types, mode, deskPattern = null) {
  const seatIdx = seatColumnIndices(cols, types)
  // 不传序列就从几何派生（生产路径）；传了显式序列则以它为准（兼容调用方/测试）
  const pattern = deskPatternOf(mode, seatIdx.length, deskPattern || deriveDeskPattern(cols, types, mode))
  const dense = deskIndexOfPattern(pattern)
  const out = new Array(cols).fill(-1)
  seatIdx.forEach((c, k) => { out[c] = dense[k] ?? -1 })
  return out
}

// dense（算法）坐标下的桌号：排表算法压掉走廊列后，「隔着一条走廊的两列」
// 在 dense 里看起来就是相邻的。必须把桌号一起带进去，否则混合桌拆开之后
// 算法仍会按「每 2 列一桌」把它们当成同桌。
export function deskIndexOfDense(cols, types, mode) {
  const grid = deskIndexOfGrid(cols, types, mode)
  return seatColumnIndices(cols, types).map((c) => grid[c] ?? -1)
}

// 列头右键的桌型动作（网格列下标）。抽成纯函数是因为菜单判据用源码正则会假绿：
// 之前「拆完能合并」只判右侧，右键被拆出来的右半张桌会删掉**再右边**那条走廊，
// 把隔壁那列并过来 —— 界面看不出，数据上是一张隔着一整条过道的怪桌。
//   · splitAt：这一列所在双人桌要拆开时，该在哪插一条走廊（左右两列都能拆）
//   · mergeLeftAt / mergeRightAt：与左/右相邻单人桌合回一张桌时，该删哪条走廊
export function deskActionsOfCol(cols, types, mode, c) {
  const none = { splitAt: -1, mergeLeftAt: -1, mergeRightAt: -1 }
  if (!Number.isInteger(c) || c < 0 || c >= cols) return none
  const kinds = columnKinds(cols, types)
  if (kinds[c] !== 'seat') return none
  const desk = deskIndexOfGrid(cols, types, mode)
  const sizes = deskSizeIndexOfGrid(cols, types, mode)
  const inGrid = (x) => x >= 0 && x < cols
  const sameDesk = (a, b) => inGrid(a) && inGrid(b) && desk[a] >= 0 && desk[a] === desk[b]
  // 只有「两张单人桌」才能合：双人桌 + 单人桌并起来会得到一张 3 人桌
  const twoSingles = (a, b) => inGrid(a) && inGrid(b) && sizes[a] === 1 && sizes[b] === 1 && desk[a] !== desk[b]
  let splitAt = -1
  if (sizes[c] === 2) {
    if (kinds[c + 1] === 'seat' && sameDesk(c, c + 1)) splitAt = c + 1
    else if (kinds[c - 1] === 'seat' && sameDesk(c - 1, c)) splitAt = c
  }
  let mergeLeftAt = -1
  let mergeRightAt = -1
  if (sizes[c] === 1) {
    if (kinds[c - 1] === 'aisle' && twoSingles(c, c - 2)) mergeLeftAt = c - 1
    if (kinds[c + 1] === 'aisle' && twoSingles(c, c + 2)) mergeRightAt = c + 1
  }
  return { splitAt, mergeLeftAt, mergeRightAt }
}
// 构造与座位表同构的显示行（讲台行 + 每行数据格）。
// valueAt(rowIdx, gridCol) 返回 { course, extra? }；extra 并入数据格属性。
export function buildSeatLikeRows(rows, cols, types, valueAt) {
  const grid = normalizeTypes(types, rows, cols)
  const kinds = columnKinds(cols, grid)
  const result = []
  result.push({ _rowKey: 'podium', label: '讲  台', _isPodium: true, _isSeparator: false, _mergeCells: false, _isReadonly: true, cells: [] })

  // 整行走廊（横走廊）：渲染成一格 colspan=cols，中间写「走廊」。
  const aisleRows = []
  for (let r = 0; r < rows; r++) aisleRows.push(rowIsAisle(grid, r))

  // 竖走廊（整列）的 rowspan 必须在横走廊处**断开**：
  // 横走廊是「一格跨全部列」，竖走廊若照旧 rowspan=rows，两者会争同一列 ——
  // 表格模型里 rowspan 已经占住该格，再加一个 colspan 覆盖它的 td，浏览器只能把
  // 后面整行右移，表现为「插一条横走廊，下面各排全错位」。
  // 所以按「连续的非横走廊行」分段，每段一条 rowspan；视觉上竖走廊在交叉处截断，
  // 交叉点由横走廊那一大格盖住（跟教室的十字过道一致）。
  // 段边界只由「哪些行是横走廊」决定，与列无关，所以一张表只算一次。
  const segStartOf = new Array(rows).fill(-1) // 行 → 所属段的首行
  const segLenOf = new Array(rows).fill(0) // 段首行 → 段长
  for (let r = 0; r < rows;) {
    if (aisleRows[r]) { r++; continue }
    let end = r
    while (end + 1 < rows && !aisleRows[end + 1]) end++
    segLenOf[r] = end - r + 1
    for (let i = r; i <= end; i++) segStartOf[i] = r
    r = end + 1
  }

  for (let r = 0; r < rows; r++) {
    const aisleRow = aisleRows[r]
    const rowCells = []
    for (let c = 0; c < cols; c++) {
      if (aisleRow) {
        // 横走廊：首格跨全部列，其余格不渲染。
        // 用 _isAisleHidden 而不是真的少放对象 —— cells 长度必须恒等于 cols，
        // 否则 applyEditedRows / 列对齐这些按下标取值的地方会整体错一位。
        rowCells.push(c === 0
          ? { course: '走廊', _isAisle: true, _aisleRowSpan: 0, _aisleColSpan: cols, _isAisleHidden: false }
          : { course: '', _isAisle: false, _isAisleHidden: true })
        continue
      }
      const t = grid[r][c]
      if (t === CELL.AISLE) {
        if (kinds[c] === 'aisle') {
          // 整列走廊：每个连续段的首行一条 rowspan，段内其余行隐藏
          if (segStartOf[r] === r) {
            rowCells.push({ course: '走廊', _isAisle: true, _aisleRowSpan: segLenOf[r], _isAisleHidden: false })
          } else {
            rowCells.push({ course: '', _isAisle: false, _isAisleHidden: true })
          }
        } else {
          // 局部走廊（既不整行也不整列，理论上后端会拒绝，渲染上按独立灰格兜底）
          rowCells.push({ course: '', _isAisle: true, _aisleRowSpan: 0, _isAisleHidden: false })
        }
      } else if (t === CELL.BLANK) {
        // 空位：不是座位、也不是走廊（异形教室里被墙/门占掉的格子）。
        // **不给 _bg/_fg**：底色交给 GridView 的 .cell-hole 用主题变量画（虚线斜纹）。
        // 原来写死 '#f3f4f6' 在深色主题下会是一块刺眼的白，而 _bg 非 null 还会被
        // 当成热力图单元格（.cell-heat），空位被打上热力色更像「有数据」。
        rowCells.push({ course: '', _blank: true, _isAisle: false, _isAisleHidden: false })
      } else {
        const v = valueAt(r, c) || {}
        rowCells.push({ course: v.course, _isAisle: false, _isAisleHidden: false, ...(v.extra || {}) })
      }
    }
    result.push({
      _rowKey: `row_${r}`,
      // 行走廊行的行标签写「走廊」，与列头对称（整列走廊的列头就是「走廊」）。
      // 写「第3行」会让人把它当成一排座位 —— 可它不能坐人、也不能拖，右键唯一
      // 能做的就是删掉。普通行仍按**数据行号**编号（走廊行处跳号，不连续重排）：
      // 右键菜单的「第 N 行」提示、画笔落点用的都是数据行号，标签跟它对齐才不会
      // 又出现「显示行号与数据行号差一格」那类错位（讲台行同理，它也不占号）。
      label: aisleRow ? '走廊' : `第${r + 1}行`,
      cells: rowCells,
      // 行走廊行整体只读：不可编辑、不可拖动交换（拖了会让走廊位置和数据错位）
      _isReadonly: aisleRow,
      _isAisleRow: aisleRow,
      _lessonIdx: r,
      _periodRowSpan: 0,
      periodLabel: '',
    })
  }
  return result
}

// ---------- 编辑回写 ----------
// 把 GridView 回传的显示行还原成 seats 网格。
// prevSeats 是当前网格（用于保住「显示行里没出现的行」），resolveCell(cell) 由调用方
// 决定「这格的文本该落成学生 id 还是姓名」（依赖名册，所以不放进纯函数）。
// 走廊/空位格一律写 null：几何由 types 表达，数据位不该承载内容。
export function applyEditedRows(prevSeats, newRows, cols, types, resolveCell) {
  const next = (Array.isArray(prevSeats) ? prevSeats : []).map(r => (Array.isArray(r) ? [...r] : []))
  for (const row of newRows) {
    // 用 _lessonIdx 对齐而不是循环计数：讲台/分隔/合并行不占座位行号
    const r = row._lessonIdx
    if (r == null || r < 0) continue
    if (!Array.isArray(next[r])) next[r] = new Array(cols).fill(null)
    for (let c = 0; c < row.cells.length; c++) {
      const t = types[r]?.[c]
      if (t === CELL.AISLE || t === CELL.BLANK) { next[r][c] = null; continue }
      next[r][c] = resolveCell(row.cells[c])
    }
  }
  return next
}

// ---------- 改几何时搬数据 ----------
// 把旧网格里的座位数据搬到新几何上，按**座位列序号**对齐，而不是按网格列下标。
// 按网格下标搬会在改 mode（走廊位置变化）时把旧走廊列（值全是 null）搬到新座位列上，
// 座位集体错位 —— 这是最容易在验收时被误认为「数据丢了」的坑。
export function remapSeatsToGeometry(prevSeats, prevCols, prevTypes, rows, gridCols, types) {
  const oldIdx = seatColumnIndices(prevCols, prevTypes)
  const newIdx = seatColumnIndices(gridCols, types)
  const out = []
  for (let r = 0; r < rows; r++) {
    const src = Array.isArray(prevSeats) && Array.isArray(prevSeats[r]) ? prevSeats[r] : []
    const line = new Array(gridCols).fill(null)
    for (let k = 0; k < newIdx.length; k++) {
      const from = oldIdx[k]
      if (from == null) break
      line[newIdx[k]] = src[from] ?? null
    }
    // 非座位格必须没有数据：空位（挖的洞）与走廊（整行挖的走廊）都不承载学生 ——
    // 几何与数据脱节时，界面会显示「空位/走廊里有个人」，排表算法也会把这格当成可坐
    for (let c = 0; c < gridCols; c++) {
      const t = types?.[r]?.[c]
      if (t === CELL.BLANK || t === CELL.AISLE) line[c] = null
    }
    out.push(line)
  }
  return out
}

// 草稿是按「排表当时的几何」存的（rows / cols / types 随座位结果一起落库）。
// 恢复时若座位表设置已经改过，直接拿草稿矩阵按**当前**几何解读会错位：
// 旧走廊列被当成座位列（学生「坐」在走廊上）、旧座位列被当成走廊列（学生直接看不见），
// 行列数变了还会被裁掉或补出空行。所以恢复前先按座位列序号把草稿搬到当前几何；
// 几何完全一致时原样返回（连数组都不复制，避免每次打开都多做一层拷贝）。
export function alignDraftSeats(draft, rows, gridCols, types) {
  const seats = Array.isArray(draft?.seats) ? draft.seats : []
  const dRows = Number(draft?.rows) || 0
  const dCols = Number(draft?.cols) || 0
  const dTypes = Array.isArray(draft?.types) ? draft.types : []
  if (dRows === rows && dCols === gridCols && sameCellTypes(dTypes, types)) return seats
  // 草稿没存 cols/types 时（老草稿）无从比较，只能按当前几何解读 —— 与改动前行为一致
  return remapSeatsToGeometry(seats, dCols || gridCols, dTypes, rows, gridCols, types)
}

// types 逐格比较，非法值按「座位」归一（与 normalizeTypes 同口径）。
// 不比较行数/列数本身：调用方已经比过 dCols/gridCols，这里只判类型分布是否相同。
function sameCellTypes(a, b) {
  const rowCount = Math.max(a.length, b.length)
  for (let r = 0; r < rowCount; r++) {
    const la = Array.isArray(a[r]) ? a[r] : []
    const lb = Array.isArray(b[r]) ? b[r] : []
    const colCount = Math.max(la.length, lb.length)
    for (let c = 0; c < colCount; c++) {
      const va = la[c] === CELL.AISLE || la[c] === CELL.BLANK ? la[c] : CELL.SEAT
      const vb = lb[c] === CELL.AISLE || lb[c] === CELL.BLANK ? lb[c] : CELL.SEAT
      if (va !== vb) return false
    }
  }
  return true
}

// 改设置时保住**手绘整行走廊**。
// 公式生成的 types 只有列走廊（按 mode 算），行走廊是用户在行标签上挖的 ——
// 与空位同理，直接拿公式矩阵就会把它冲掉（改完行数/列数，整行走廊自己变回座位）。
// 按**行号**搬（行是不压缩的，第 r 行还是第 r 行），新几何列数变了就铺满整行。
// 顺序上要在 carryHoleTypes 之后：整行走廊覆盖该行一切（包括洞）。
export function carryAisleRows(prevTypes, baseTypes) {
  const next = (Array.isArray(baseTypes) ? baseTypes : []).map((line) => (Array.isArray(line) ? [...line] : []))
  const prev = Array.isArray(prevTypes) ? prevTypes : []
  const limit = Math.min(prev.length, next.length)
  for (let r = 0; r < limit; r++) {
    if (!rowIsAisle(prev, r)) continue
    for (let c = 0; c < next[r].length; c++) next[r][c] = CELL.AISLE
  }
  return next
}

// ---------- 插入 / 删除行走廊（行标签右键）----------
// 语义是**插入一行**，不是「把这一行变成走廊」。
// 覆盖式的旧做法会把那一排学生整体移出座位表（可撤销，但用户往往只是想「在这儿加条过道」），
// 而插入不动任何数据：新走廊占一行，被右键那行以下的行号整体后移。
//
// 为什么必须把 rows 一起返回：types 的形状就是几何，后端 normalizeCellTypes 按 rows×cols
// 去裁。只给 types 加一行而 rows 不变 → 读回时最后一行被截掉，新走廊「凭空消失」；
// 反过来只改 rows 不改 types 会让走廊格变回座位。
//
// at 是**插入位置**（0..rows 闭区间）：at=k 表示插在第 k 行之前，at=rows 表示追加到末尾。
// 数据格一律补 null：走廊不承载学生（后端 assertHolesEmpty 同口径，走廊里有人会被拒）。
function seatLineOf(seats, r, cols) {
  const src = Array.isArray(seats) ? seats[r] : null
  const line = new Array(cols).fill(null)
  if (Array.isArray(src)) for (let c = 0; c < cols; c++) line[c] = src[c] ?? null
  return line
}

export function insertAisleRow(types, seats, rows, cols, at) {
  const grid = normalizeTypes(types, rows, cols)
  const k = Number.isInteger(at) ? Math.max(0, Math.min(rows, at)) : rows
  const outTypes = []
  const outSeats = []
  for (let r = 0; r < rows; r++) {
    if (r === k) {
      outTypes.push(new Array(cols).fill(CELL.AISLE))
      outSeats.push(new Array(cols).fill(null))
    }
    outTypes.push([...grid[r]])
    outSeats.push(seatLineOf(seats, r, cols))
  }
  if (k >= rows) {
    outTypes.push(new Array(cols).fill(CELL.AISLE))
    outSeats.push(new Array(cols).fill(null))
  }
  return { types: outTypes, seats: outSeats, rows: rows + 1 }
}

// 删除第 at 行（走廊行专用入口，但不限于走廊行：几何层不判断语义）。// 返回 null 表示越界或者只剩一行（后端 validateSeatSize 要求 rows ≥ 1，删空没有意义）。
// removedSeats 交给调用方：撤不动时至少能把「这一行原本有谁」放进提示里。
export function removeGridRow(types, seats, rows, cols, at) {
  const r = Number.isInteger(at) ? at : -1
  if (rows <= 1 || r < 0 || r >= rows) return null
  const grid = normalizeTypes(types, rows, cols)
  const outTypes = []
  const outSeats = []
  for (let i = 0; i < rows; i++) {
    if (i === r) continue
    outTypes.push([...grid[i]])
    outSeats.push(seatLineOf(seats, i, cols))
  }
  return {
    types: outTypes, seats: outSeats, rows: rows - 1,
    removedSeats: seatLineOf(seats, r, cols),
  }
}

// 插入整列走廊（列头右键「左侧/右侧插入走廊」）。
// 与 insertAisleRow 完全对称：几何层只搬矩阵，不判断语义、也不动别人的数据 ——
// 插入**不改变**任何座位列的序号（只是在两列之间塞了一条走廊），所以学生和权重
// 都不需要重映射，只是网格下标整体后移。
// cols 必须随返回值一起交给调用方并落库：只写 types 的话后端按旧 cols 裁掉末尾，
// 新插的那一列下次读回来就没了（与插入行的 rows 同源，别只搬一半）。
export function insertAisleColumn(types, seats, rows, cols, at) {
  const grid = normalizeTypes(types, rows, cols)
  const k = Number.isInteger(at) ? Math.max(0, Math.min(cols, at)) : cols
  const outTypes = []
  const outSeats = []
  for (let r = 0; r < rows; r++) {
    const line = [...grid[r]]
    const seatLine = seatLineOf(seats, r, cols)
    line.splice(k, 0, CELL.AISLE)
    seatLine.splice(k, 0, null)
    outTypes.push(line)
    outSeats.push(seatLine)
  }
  return { types: outTypes, seats: outSeats, rows, cols: cols + 1 }
}

// 删除第 at 列（列走廊专用入口，几何层不判断这一列是不是走廊）。
// 返回 null 表示越界或只剩一列（后端要求 cols ≥ 1，删空没有几何可言）。
// removedSeats 交给调用方：这一列原本坐着谁，只能从这里拿到（矩阵里已经没有它了）。
export function removeGridColumn(types, seats, rows, cols, at) {
  const c = Number.isInteger(at) ? at : -1
  if (cols <= 1 || c < 0 || c >= cols) return null
  const grid = normalizeTypes(types, rows, cols)
  const outTypes = []
  const outSeats = []
  const removedSeats = []
  for (let r = 0; r < rows; r++) {
    const line = [...grid[r]]
    const seatLine = seatLineOf(seats, r, cols)
    line.splice(c, 1)
    removedSeats.push(seatLine.splice(c, 1)[0] ?? null)
    outTypes.push(line)
    outSeats.push(seatLine)
  }
  return { types: outTypes, seats: outSeats, rows, cols: cols - 1, removedSeats }
}

// 改几何时保住**手绘空位**。
// baseTypes 是按公式为新尺寸重建的矩阵，公式只知道「座位/走廊」，不知道用户在哪儿挖过洞 ——
// 直接用它就把空位全冲掉了（改完行数/列数洞自动填平，且没有任何提示）。
// 所以按与 remapSeatsToGeometry 相同的「座位列序号」把旧空位搬过去，两边必须同源：
// 若空位按别的规则搬，就会出现「洞在 A 格、人被搬到 B 格」→ 空位里有学生。
// 走廊列仍由公式决定（手绘整行走廊由 carryAisleRows 单独搬），这里只搬 CELL.BLANK。
export function carryHoleTypes(prevTypes, prevCols, rows, gridCols, baseTypes) {
  const next = (Array.isArray(baseTypes) ? baseTypes : []).map((line) => (Array.isArray(line) ? [...line] : []))
  const prev = Array.isArray(prevTypes) ? prevTypes : []
  const oldIdx = seatColumnIndices(prevCols, prevTypes)
  const newIdx = seatColumnIndices(gridCols, next)
  const limit = Math.min(rows, prev.length, next.length)
  for (let r = 0; r < limit; r++) {
    const line = prev[r]
    if (!Array.isArray(line)) continue
    for (let k = 0; k < oldIdx.length && k < newIdx.length; k++) {
      if (line[oldIdx[k]] === CELL.BLANK) next[r][newIdx[k]] = CELL.BLANK
    }
  }
  return next
}

// 改行列/桌子模式时的**唯一决策入口**：新几何 + 搬过去的空位 + 搬过去的座位。
// 抽成纯函数而不是留在 useSeatGrid.saveSettings 里，是因为这段有三条必须同源的规则
// （空位按座位列序号搬、座位按座位列序号搬、空位格清数据），
// 分散写在组件里只能靠肉眼保证一致 —— 而且它在 node 下可单测。
export function reshapeGeometry(prevSeats, prevCols, prevTypes, rows, seatCols, mode) {
  const gridCols = seatColsToGrid(seatCols, mode)
  // 三种「手绘痕迹」都必须活过设置变更：先按公式重建，再叠空位、最后叠整行走廊。
  // 顺序不能换：整行走廊覆盖整行，若先叠它再叠空位，洞会出现在走廊里。
  const withHoles = carryHoleTypes(prevTypes, prevCols, rows, gridCols, formulaTypes(rows, gridCols, mode))
  const types = carryAisleRows(prevTypes, withHoles)
  const seats = remapSeatsToGeometry(prevSeats, prevCols, prevTypes, rows, gridCols, types)
  return { gridCols, types, seats }
}

// ---------- 网格 ↔ dense（「座位列」压缩视图）----------
// dense 是**排表算法的坐标空间**：只保留座位列，连续排列，算法里的 `%2 == 0 为同桌`
// 这类判据才能在任意走廊布局下继续成立（异形网格改造原则：只压列、不压行）。
// 边界只出现在智能排表弹窗：进来时 toDenseSeats 压、出去时 fromDenseSeats 展开。
// 注意：dense 视图会丢掉行走廊与空位的位置 —— 弹窗另用 `denseTypes` 掩码把这些格子
// 从算法的可选格集合里排除，否则学生会排进走廊格。
export function toDenseSeats(seats, cols, types) {
  const idx = seatColumnIndices(cols, types)
  return (Array.isArray(seats) ? seats : []).map((row) => idx.map((c) => (Array.isArray(row) ? (row[c] ?? null) : null)))
}

export function fromDenseSeats(dense, rows, cols, types) {
  const idx = seatColumnIndices(cols, types)
  const out = []
  for (let r = 0; r < rows; r++) {
    const src = Array.isArray(dense) ? (dense[r] || []) : []
    const line = []
    for (let c = 0; c < cols; c++) line.push(null)
    for (let k = 0; k < idx.length; k++) line[idx[k]] = src[k] ?? null
    out.push(line)
  }
  return out
}

// ---------- 权重表的几何清理 ----------
// 权重表与座位表共用同一份 types（几何只有座位表一个真相源），但**权重矩阵是独立存储**：
// 把一行设成走廊、或在某格挖洞时，座位表那一行/那一格已经不能坐人了，权重矩阵里对应位置
// 的数字却还留着 —— 界面上走廊格/空位格不显示权重（course 被替换成「走廊」），所以看不出来；
// 一旦取消走廊，这些旧数字就"冒回来"，看起来像新填的权重。
// 因此任何几何变更后都要把权重矩阵按新 types 洗一遍：非座位格恒 null。
// 只在「行列数不变」的几何变更里用（改尺寸走 remapSeatsToGeometry，那边按座位列序号搬家）。
export function clearNonSeatWeights(weights, rows, cols, types) {
  const grid = normalizeTypes(types, rows, cols)
  const out = []
  for (let r = 0; r < rows; r++) {
    const src = Array.isArray(weights) ? weights[r] : null
    const line = []
    for (let c = 0; c < cols; c++) {
      const v = Array.isArray(src) ? src[c] : null
      line.push(grid[r][c] === CELL.SEAT && v != null && v !== '' ? v : null)
    }
    out.push(line)
  }
  return out
}
