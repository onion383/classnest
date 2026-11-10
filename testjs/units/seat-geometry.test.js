// =========================================================================
// seat-geometry.test.js —— 座位网格几何（异形网格改造）
//
// 这是改造的**回归锚点**：迁移把 seats 从 dense 改成「网格 + types」之后，
// 同一份数据渲染出来必须与改造前逐格一致。所以这里把**改造前的旧公式原样冻结**
// 在测试里做参考实现，而不是拿新实现自己跟自己对。
// 旧公式一旦在源码里被删（它确实已被删），这份参考实现就是唯一的对照物 —— 不要
// 看到「测试里有重复代码」就把它合并回源码：那会让判据随源码漂移，改了也测不出来。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const GEOM = pathToFileURL(path.join(__dirname, '../../student-frontend/src/composables/useSeatGrid.geometry.js')).href
const load = () => import(GEOM)

// ---------------- 旧公式（改造前 composables/useSeatGrid.js 的实现，逐字冻结）----------------
function oldDisplayColCount(cols, mode) {
  return mode === 'single' ? cols + (cols - 1) : cols + Math.floor((cols - 1) / 2)
}
function oldIsAisleCol(displayIdx, cols, mode) {
  const total = oldDisplayColCount(cols, mode)
  if (mode === 'single') return displayIdx % 2 === 1
  return displayIdx >= 2 && (displayIdx - 2) % 3 === 0 && displayIdx < total
}
function oldColHeaders(cols, mode) {
  const headers = []
  if (mode === 'single') {
    for (let i = 0; i < cols; i++) { headers.push(`列${i + 1}`); if (i < cols - 1) headers.push('走廊') }
  } else {
    for (let i = 0; i < cols; i++) { headers.push(`列${i + 1}`); if ((i + 1) % 2 === 0 && i < cols - 1) headers.push('走廊') }
  }
  return headers
}
function oldBuildRows(rows, seatCols, mode, valueAt) {
  const displayCols = oldDisplayColCount(seatCols, mode)
  const out = []
  for (let r = 0; r < rows; r++) {
    const cells = []
    let realCol = 0
    for (let d = 0; d < displayCols; d++) {
      if (oldIsAisleCol(d, seatCols, mode)) {
        if (r === 0) cells.push({ course: '走廊', _isAisle: true, _aisleRowSpan: rows, _isAisleHidden: false })
        else cells.push({ course: '', _isAisle: false, _isAisleHidden: true })
      } else {
        const v = valueAt(r, realCol) || {}
        cells.push({ course: v.course, _isAisle: false, _isAisleHidden: false, ...(v.extra || {}) })
        realCol++
      }
    }
    out.push(cells)
  }
  return out
}

// ---------------- types 规整 ----------------
test('normalizeTypes：不足补座位、超出截断、非法值按座位处理', async () => {
  const { normalizeTypes, CELL } = await load()
  const got = normalizeTypes([[1, 1]], 2, 3)
  assert.deepEqual(got, [[1, 1, 0], [0, 0, 0]])
  // 非法值（字符串 / 3 / null）一律回到 0
  assert.deepEqual(normalizeTypes([[2, '1', 9, 1, 1]], 1, 3), [[2, 0, 0]])
  // 完全缺失 → 全座位
  assert.deepEqual(normalizeTypes(null, 1, 2), [[CELL.SEAT, CELL.SEAT]])
})

// ---------------- 公式几何与旧公式等价（核心回归） ----------------
for (const mode of ['single', 'double']) {
  for (const seatCols of [1, 2, 4, 6, 7, 10]) {
    test(`formulaTypes 与旧公式等价：${mode} / ${seatCols} 个座位列`, async () => {
      const { formulaTypes, generateColHeaders, buildSeatLikeRows, CELL } = await load()
      const gridCols = oldDisplayColCount(seatCols, mode)
      const types = formulaTypes(3, gridCols, mode)

      // types 与旧 isAisleCol 逐格一致（走廊位置必须一模一样）
      for (let c = 0; c < gridCols; c++) {
        const expected = oldIsAisleCol(c, seatCols, mode) ? CELL.AISLE : CELL.SEAT
        assert.equal(types[0][c], expected, `第 ${c} 列类型不一致`)
      }
      // 表头逐项一致
      assert.deepEqual(generateColHeaders(gridCols, types), oldColHeaders(seatCols, mode))

      // 显示行逐格一致：用同一份 dense 数据喂两边
      const dense = Array.from({ length: 3 }, (_, r) => Array.from({ length: seatCols }, (_, c) => r * 100 + c))
      const valueAt = (r, c) => ({ course: String(dense[r][c]), extra: { _studentId: dense[r][c] } })
      const oldRows = oldBuildRows(3, seatCols, mode, valueAt)

      // dense → 网格（模拟迁移产物），再用新构造器渲染
      const gridSeats = Array.from({ length: 3 }, () => new Array(gridCols).fill(null))
      const seatIdx = []
      for (let c = 0; c < gridCols; c++) if (!oldIsAisleCol(c, seatCols, mode)) seatIdx.push(c)
      for (let r = 0; r < 3; r++) for (let k = 0; k < seatIdx.length; k++) gridSeats[r][seatIdx[k]] = dense[r][k]

      const newRows = buildSeatLikeRows(3, gridCols, types, (r, c) => {
        const v = gridSeats[r][c]
        return v == null ? { course: '' } : { course: String(v), extra: { _studentId: v } }
      })

      for (let r = 0; r < 3; r++) {
        assert.deepEqual(newRows[r + 1].cells, oldRows[r], `第 ${r + 1} 行渲染与改造前不一致`)
      }
    })
  }
}

// ---------------- 座位列数 ↔ 网格列数 ----------------
test('seatColsToGrid / gridColsToSeat 互为逆运算', async () => {
  const { seatColsToGrid, gridColsToSeat, formulaTypes } = await load()
  for (const mode of ['single', 'double']) {
    for (const n of [1, 2, 3, 4, 7, 10, 20]) {
      const gridCols = seatColsToGrid(n, mode)
      const types = formulaTypes(2, gridCols, mode)
      assert.equal(gridColsToSeat(gridCols, types), n, `${mode} / ${n} 个座位列往返失败`)
    }
  }
  // 边界：0 / 负数 / 非数字都收敛到 1 列
  assert.equal(seatColsToGrid(0, 'single'), 1)
  assert.equal(seatColsToGrid(-3, 'single'), 1)
  assert.equal(seatColsToGrid('x', 'single'), 1)
})

// ---------------- 行走廊与空位 ----------------
test('行走廊：整行合并成一格（colspan=全部列），其余格不渲染', async () => {
  const { buildSeatLikeRows, formulaTypes, CELL } = await load()
  const types = formulaTypes(3, 3, 'single')
  types[1] = [CELL.AISLE, CELL.AISLE, CELL.AISLE] // 中间整行走廊
  const rows = buildSeatLikeRows(3, 3, types, () => ({ course: 'X' }))

  const aisleRow = rows[2] // rows[0] 是讲台
  assert.equal(aisleRow._isReadonly, true, '整行走廊必须只读（否则可拖动换行、走廊与数据错位）')
  assert.equal(aisleRow._isAisleRow, true)
  // cells 长度必须恒等于 cols：按下标取值的地方（applyEditedRows / 列对齐）全靠它
  assert.equal(aisleRow.cells.length, 3)
  assert.equal(aisleRow.cells[0].course, '走廊')
  assert.equal(aisleRow.cells[0]._isAisle, true)
  // 横走廊一格跨全部列；**不能**同时带 rowspan（两种跨度压在一起会把整行挤歪）
  assert.equal(aisleRow.cells[0]._aisleColSpan, 3)
  assert.equal(aisleRow.cells[0]._aisleRowSpan, 0)
  // 其余格走隐藏分支（display:none 的 td 不占列位），也不重复写字
  assert.equal(aisleRow.cells[1]._isAisleHidden, true)
  assert.equal(aisleRow.cells[2]._isAisleHidden, true)
  // 其余两行仍是普通座位行
  assert.equal(rows[1]._isReadonly, false)
  assert.equal(rows[3]._isReadonly, false)
})

test('空位：不是走廊也不是座位，标 _blank 但底色交给 CSS', async () => {
  const { buildSeatLikeRows, formulaTypes, CELL } = await load()
  const types = formulaTypes(2, 3, 'single')
  types[0][2] = CELL.BLANK
  const rows = buildSeatLikeRows(2, 3, types, () => ({ course: 'X' }))
  const cell = rows[1].cells[2]
  assert.equal(cell._blank, true)
  assert.equal(cell._isAisle, false, '空位不能标成走廊，否则导出会写「走廊」')
  assert.equal(cell.course, '')
  // 底色交给 GridView 的 .cell-hole（主题变量 + 斜纹），不再写死浅灰：
  // 写死的话深色主题下是一块刺眼的白，而且 _bg 非 null 会被当成热力图格（.cell-heat）。
  assert.equal(cell._bg, undefined, '空位不该带 _bg（会被当成热力图单元格）')
  assert.equal(cell._fg, undefined)
  assert.equal(cell._blank, true)
})

test('竖走廊遇到横走廊：竖的分段，横的整行合并（两种跨度不能压在同一列上）', async () => {
  const { buildSeatLikeRows, formulaTypes, CELL } = await load()
  // 3×3 单桌（c=1 整列走廊），再把第 1 行整行改成走廊 —— 两种走廊同时存在
  const types = formulaTypes(3, 3, 'single')
  types[1] = [CELL.AISLE, CELL.AISLE, CELL.AISLE]
  const rows = buildSeatLikeRows(3, 3, types, () => ({ course: 'X' }))

  // 横走廊那一行：一格跨 3 列，竖走廊的格不能同时出现在这一行里
  assert.equal(rows[2].cells[0]._aisleColSpan, 3)
  assert.equal(rows[2].cells[0].course, '走廊')
  assert.equal(rows[2].cells[1]._isAisleHidden, true, '横走廊行里不该再冒出一个竖走廊格')

  // 竖走廊被横走廊切成两段，各自从段首起 rowspan
  assert.equal(rows[1].cells[1]._aisleRowSpan, 1, '横走廊上方只剩 1 行，rowspan 不能还是 3')
  assert.equal(rows[1].cells[1].course, '走廊')
  assert.equal(rows[3].cells[1]._aisleRowSpan, 1, '横走廊下方要重新起一段')
  assert.equal(rows[3].cells[1].course, '走廊')
  // 两段的段首都得真的渲染，否则竖走廊整条消失
  assert.equal(rows[1].cells[1]._isAisleHidden, false)
  assert.equal(rows[3].cells[1]._isAisleHidden, false)
})

test('竖走廊没被横走廊打断时仍是一条贯通到底', async () => {
  const { buildSeatLikeRows, formulaTypes } = await load()
  const types = formulaTypes(4, 3, 'single') // c=1 整列走廊，4 行连续
  const rows = buildSeatLikeRows(4, 3, types, () => ({}))
  assert.equal(rows[1].cells[1]._aisleRowSpan, 4, '整段没断，rowspan 覆盖全部数据行')
  assert.equal(rows[1].cells[1].course, '走廊')
  assert.equal(rows[2].cells[1]._isAisleHidden, true)
  assert.equal(rows[4].cells[1]._isAisleHidden, true)
})

// ---------------- 编辑回写 ----------------
test('applyEditedRows：只改被编辑的格，走廊/空位恒写 null', async () => {
  const { applyEditedRows, formulaTypes, CELL } = await load()
  const types = formulaTypes(2, 3, 'single') // 座 走 座
  types[1][0] = CELL.BLANK // 第 2 行第 1 格设成空位
  const prev = [[1, null, 2], [3, null, 4]]

  const newRows = [
    { _isPodium: true, cells: [] },
    { _lessonIdx: 0, cells: [{ course: '甲', _studentId: 1 }, { course: '走廊' }, { course: '新同学' }] },
    { _lessonIdx: 1, cells: [{ course: '写了字也不该生效' }, { course: '走廊' }, { course: '丁', _studentId: 4 }] },
  ]
  const resolve = (cell) => (Number.isInteger(cell?._studentId) ? cell._studentId : (cell.course?.trim() || null))
  const next = applyEditedRows(prev, newRows, 3, types, resolve)

  assert.deepEqual(next, [[1, null, '新同学'], [null, null, 4]])
  // 走廊格即使显示层塞了文本，也不能落进数据位
  assert.equal(next[0][1], null)
  // 空位格同理
  assert.equal(next[1][0], null)
})

test('applyEditedRows：显示行里没有的行保持原样（不整表重建）', async () => {
  const { applyEditedRows, formulaTypes } = await load()
  const types = formulaTypes(3, 3, 'single')
  const prev = [[1, null, 2], [3, null, 4], [5, null, 6]]
  // 只回传第 0 行（模拟只改了一格）
  const newRows = [{ _lessonIdx: 0, cells: [{ course: '甲', _studentId: 1 }, {}, { course: '乙', _studentId: 9 }] }]
  const next = applyEditedRows(prev, newRows, 3, types, (cell) => (Number.isInteger(cell?._studentId) ? cell._studentId : null))
  assert.deepEqual(next, [[1, null, 9], [3, null, 4], [5, null, 6]])
})

// ---------------- 改几何时搬数据 ----------------
test('remapSeatsToGeometry：改 mode 时按座位列对齐，不把走廊当座位', async () => {
  const { remapSeatsToGeometry, formulaTypes, seatColsToGrid } = await load()
  const prevCols = 13 // 7 个座位列（单桌）
  const prevTypes = formulaTypes(1, prevCols, 'single')
  const prev = [[0, null, 1, null, 2, null, 3, null, 4, null, 5, null, 6]]

  const gridCols = seatColsToGrid(7, 'double') // 10 列 / 7 个座位列
  const nextTypes = formulaTypes(1, gridCols, 'double')
  const next = remapSeatsToGeometry(prev, prevCols, prevTypes, 1, gridCols, nextTypes)

  // 双人桌 10 列的座位列是 0,1,3,4,6,7,9；数据按序号原样搬过去，一个不丢
  assert.deepEqual(next, [[0, 1, null, 2, 3, null, 4, 5, null, 6]])
  // 走廊列必须是 null
  assert.equal(next[0][2], null)
  assert.equal(next[0][5], null)
  assert.equal(next[0][8], null)
})

test('remapSeatsToGeometry：座位列变少时截断，多余数据丢弃', async () => {
  const { remapSeatsToGeometry, formulaTypes, seatColsToGrid } = await load()
  const prevCols = 13
  const prevTypes = formulaTypes(1, prevCols, 'single')
  const prev = [[0, null, 1, null, 2, null, 3, null, 4, null, 5, null, 6]]

  const gridCols = seatColsToGrid(5, 'single') // 9 列 / 5 个座位列
  const nextTypes = formulaTypes(1, gridCols, 'single')
  const next = remapSeatsToGeometry(prev, prevCols, prevTypes, 1, gridCols, nextTypes)
  assert.deepEqual(next, [[0, null, 1, null, 2, null, 3, null, 4]])
})

// ---------------- 空位在手改几何时必须存活 ----------------
test('carryHoleTypes：改座位列数后空位跟着座位列序号走', async () => {
  const { carryHoleTypes, formulaTypes, seatColsToGrid, seatColumnIndices, CELL } = await load()
  const prevCols = 5 // 座 走 座 走 座 → 座位列 0/2/4
  const prevTypes = formulaTypes(2, prevCols, 'single')
  prevTypes[0][2] = CELL.BLANK // 第 1 行、座位列 2 挖洞
  prevTypes[1][4] = CELL.BLANK // 第 2 行、第 3 个座位列挖洞

  const gridCols = seatColsToGrid(4, 'single') // 7 列 → 座位列 0/2/4/6
  const next = carryHoleTypes(prevTypes, prevCols, 2, gridCols, formulaTypes(2, gridCols, 'single'))

  assert.deepEqual(seatColumnIndices(gridCols, next), [0, 2, 4, 6], '新几何的座位列是 0/2/4/6')
  assert.equal(next[0][2], CELL.BLANK, '洞必须留在「第 2 个座位列」')
  assert.equal(next[1][4], CELL.BLANK, '第 3 个座位列在两种几何里都落在网格第 4 列')
  assert.equal(next[0][0], CELL.SEAT)
  assert.equal(next[0][1], CELL.AISLE, '走廊仍由公式决定，不被空位逻辑影响')
})

test('carryHoleTypes：改 mode 时空位跟着座位列序号，不落到走廊上', async () => {
  const { carryHoleTypes, formulaTypes, seatColsToGrid, CELL } = await load()
  const prevCols = 13 // 单桌 7 个座位列
  const prevTypes = formulaTypes(1, prevCols, 'single')
  prevTypes[0][4] = CELL.BLANK // 座位列 3

  const gridCols = seatColsToGrid(7, 'double') // 10 列，座位列 0/1/3/4/6/7/9
  const next = carryHoleTypes(prevTypes, prevCols, 1, gridCols, formulaTypes(1, gridCols, 'double'))
  assert.equal(next[0][3], CELL.BLANK, '第 4 个座位列（双桌）在网格第 3 列')
  assert.equal(next[0][1], CELL.SEAT)
  assert.equal(next[0][2], CELL.AISLE)
})

test('carryHoleTypes：座位列变少时超出的洞丢弃，不会越界写', async () => {
  const { carryHoleTypes, formulaTypes, seatColsToGrid, CELL } = await load()
  const prevCols = 9 // 5 个座位列
  const prevTypes = formulaTypes(1, prevCols, 'single')
  prevTypes[0][8] = CELL.BLANK // 座位列 5

  const gridCols = seatColsToGrid(3, 'single') // 5 列，3 个座位列
  const next = carryHoleTypes(prevTypes, prevCols, 1, gridCols, formulaTypes(1, gridCols, 'single'))
  assert.equal(next[0].length, gridCols)
  assert.ok(next[0].every((v) => v !== CELL.BLANK), '洞在截断范围内没有落点，就不该凭空出现')
})

test('remapSeatsToGeometry：搬到空位格上的数据被清空', async () => {
  const { remapSeatsToGeometry, formulaTypes, CELL } = await load()
  const prevCols = 5
  const prevTypes = formulaTypes(1, prevCols, 'single')
  const prev = [[0, null, 1, null, 2]] // 座位列 0/1/2 都有人
  // 新几何在「第 2 个座位列」上挖了洞：那个人必须被清掉，不能显示成「空位里有学生」
  const nextTypes = formulaTypes(1, prevCols, 'single')
  nextTypes[0][2] = CELL.BLANK
  const next = remapSeatsToGeometry(prev, prevCols, prevTypes, 1, prevCols, nextTypes)
  assert.equal(next[0][0], 0)
  assert.equal(next[0][2], null, '空位格必须为 null')
  assert.equal(next[0][4], 2)
})

test('reshapeGeometry：改设置后空位与座位同时搬到新几何（整链）', async () => {
  const { reshapeGeometry, formulaTypes, CELL } = await load()
  const prevCols = 5 // 座 走 座 走 座
  const prevTypes = formulaTypes(2, prevCols, 'single')
  prevTypes[0][2] = CELL.BLANK // 座位列 2 挖洞
  const prev = [
    [7, null, null, null, 8], // 座位列 1 有人、座位列 3 有人
    [null, null, null, null, null],
  ]
  // 座位列 3 → 4 列（网格 7 列），单桌
  const next = reshapeGeometry(prev, prevCols, prevTypes, 2, 4, 'single')
  assert.equal(next.gridCols, 7)
  assert.equal(next.types[0][2], CELL.BLANK, '洞留在原座位列')
  assert.equal(next.types[0][1], CELL.AISLE)
  assert.equal(next.seats[0][4], 8, '座位按座位列序号搬，不因中间多一列而错位')
  assert.equal(next.seats[0][0], 7)
  assert.equal(next.seats[0][2], null, '空位格必须为空')
})

test('saveSettings 真的走 reshapeGeometry（调用点判据：只测纯函数会假绿）', async () => {
  // 纯函数测试证明「规则对」，但证明不了「组件真的调了它」。
  // 若把 saveSettings 改回自己拼 formulaTypes，空位照样被冲掉，而上面的测试全绿。
  const src = fs.readFileSync(path.join(__dirname, '../../student-frontend/src/composables/useSeatGrid.js'), 'utf8')
  const start = src.indexOf('async function saveSettings')
  assert.ok(start > 0, 'useSeatGrid.js 里应有 saveSettings')
  const end = src.indexOf('\n  }', start)
  const body = src.slice(start, end > start ? end : undefined)
  assert.match(body, /reshapeGeometry\(/, 'saveSettings 必须调 reshapeGeometry')
  assert.ok(!/formulaTypes\(/.test(body), 'saveSettings 不许自己拼公式（会冲掉手绘空位）')
})

// ---------------- dense 互转 ----------------
test('toDenseSeats / fromDenseSeats 往返一致（只压座位列）', async () => {
  const { toDenseSeats, fromDenseSeats, formulaTypes } = await load()
  const mode = 'single'
  const gridCols = 5 // 列0 座 列1 走廊 列2 座 列3 走廊 列4 座
  const types = formulaTypes(2, gridCols, mode)
  const grid = [
    [11, null, 12, null, 13],
    [null, null, 22, null, null],
  ]
  const dense = toDenseSeats(grid, gridCols, types)
  assert.deepEqual(dense, [[11, 12, 13], [null, 22, null]])
  const back = fromDenseSeats(dense, 2, gridCols, types)
  assert.deepEqual(back, grid)
  // 走廊格必须恒为 null（不能把 dense 的第 k 个数写到走廊列上）
  assert.equal(back[0][1], null)
  assert.equal(back[0][3], null)
})

test('fromDenseSeats：dense 比座位列多时截断、少时补 null', async () => {
  const { fromDenseSeats, formulaTypes } = await load()
  const types = formulaTypes(1, 3, 'single') // 列0 座 / 列1 走廊 / 列2 座
  assert.deepEqual(fromDenseSeats([[1, 2, 3]], 1, 3, types), [[1, null, 2]])
  assert.deepEqual(fromDenseSeats([[1]], 1, 3, types), [[1, null, null]])
})

// ---------------- 表头与列分类 ----------------
test('generateColHeaders：座位列按序号连续编号，走廊列不占号', async () => {
  const { generateColHeaders, formulaTypes, seatColumnIndices, CELL } = await load()
  const types = formulaTypes(1, 5, 'single') // 座 走 座 走 座
  assert.deepEqual(generateColHeaders(5, types), ['列1', '走廊', '列2', '走廊', '列3'])
  assert.deepEqual(seatColumnIndices(5, types), [0, 2, 4])

  // 行走廊不影响列分类（整行走廊不改变「这一列是座位列」）
  types[0] = [CELL.AISLE, CELL.AISLE, CELL.AISLE, CELL.AISLE, CELL.AISLE]
  assert.deepEqual(generateColHeaders(5, types), ['走廊', '走廊', '走廊', '走廊', '走廊'])
  // 但整列走廊才降级成走廊列 —— 只有最左列整列是走廊时才算
  const types2 = formulaTypes(1, 3, 'single')
  types2[0] = [CELL.AISLE, CELL.AISLE, CELL.AISLE]
  types2[0][2] = CELL.SEAT
  assert.deepEqual(seatColumnIndices(3, types2), [2])
})

// ---------------- 草稿恢复：几何变过也不能错位 ----------------
// 草稿的 rows/cols/types 与座位结果一起落库。若排完草稿后又改过座位表设置，
// 恢复时拿草稿矩阵按当前几何解读会把走廊当座位（错位）或越界裁人。
test('alignDraftSeats：几何完全一致时原样返回（不复制、不重排）', async () => {
  const { alignDraftSeats, formulaTypes } = await load()
  const cols = 5
  const types = formulaTypes(2, cols, 'single')
  const seats = [[1, null, 2, null, 3], [null, null, 4, null, 5]]
  const draft = { rows: 2, cols, seats, types }

  const out = alignDraftSeats(draft, 2, cols, types)
  assert.equal(out, seats, '几何一致时必须返回原数组（同一引用）')
})

test('alignDraftSeats：排完草稿又改了桌子模式，座位按座位列序号对齐、不落走廊', async () => {
  const { alignDraftSeats, formulaTypes, seatColsToGrid } = await load()
  // 草稿是单桌 7 个座位列（13 列网格）
  const dCols = 13
  const dTypes = formulaTypes(1, dCols, 'single')
  const dSeats = [[0, null, 1, null, 2, null, 3, null, 4, null, 5, null, 6]]
  const draft = { rows: 1, cols: dCols, seats: dSeats, types: dTypes }

  // 现在座位表改成了同桌模式（10 列网格，7 个座位列）
  const cols = seatColsToGrid(7, 'double')
  const types = formulaTypes(1, cols, 'double')
  const out = alignDraftSeats(draft, 1, cols, types)

  // 7 个学生一个不少，且走廊格（2/5/8）必须是 null
  assert.deepEqual(out, [[0, 1, null, 2, 3, null, 4, 5, null, 6]])
})

test('alignDraftSeats：座位列变少时截断，不越界写', async () => {
  const { alignDraftSeats, formulaTypes, seatColsToGrid } = await load()
  const dCols = 13
  const dTypes = formulaTypes(1, dCols, 'single')
  const dSeats = [[0, null, 1, null, 2, null, 3, null, 4, null, 5, null, 6]]
  const draft = { rows: 1, cols: dCols, seats: dSeats, types: dTypes }

  const cols = seatColsToGrid(3, 'single') // 只剩 3 个座位列
  const types = formulaTypes(1, cols, 'single')
  const out = alignDraftSeats(draft, 1, cols, types)
  assert.deepEqual(out, [[0, null, 1, null, 2]])
})

test('alignDraftSeats：草稿里的空位格恢复后仍为空（不能有人在洞里）', async () => {
  const { alignDraftSeats, formulaTypes, seatColsToGrid, CELL } = await load()
  const dCols = 5
  const dTypes = formulaTypes(1, dCols, 'single') // 座 走 座 走 座
  const dSeats = [[1, null, 2, null, 3]]
  const draft = { rows: 1, cols: dCols, seats: dSeats, types: dTypes }

  // 当前几何：3 个座位列，其中第 2 个座位列是空位（有人被搬过来也要清掉）
  const cols = seatColsToGrid(3, 'single') // 5 列网格（座 走 座 走 座）
  const types = formulaTypes(1, cols, 'single')
  types[0][2] = CELL.BLANK
  const out = alignDraftSeats(draft, 1, cols, types)
  // 第 2 个座位列（网格 c=2）是空位：原本会搬来 2，必须被清成 null；其余两列照旧
  assert.deepEqual(out, [[1, null, null, null, 3]])
})

// 调用点判据：只测纯函数会假绿 —— 把恢复处改回 draft.seats 上面四条依然全绿
test('恢复草稿真的走 alignDraftSeats（调用点判据）', async () => {
  const { readFileSync } = fs
  const src = readFileSync(path.join(__dirname,
    '../../student-frontend/src/components/dialogs/SmartArrangementDialog/SmartArrangementDialog.vue'), 'utf8')
  assert.match(src, /draftSeats\.value\s*=\s*alignDraftSeats\(draft/,
    '恢复草稿必须先按当前几何对齐（不能直接 draftSeats.value = draft.seats）')
  assert.doesNotMatch(src, /draftSeats\.value\s*=\s*draft\.seats/,
    '不能改回直接拿草稿矩阵按当前几何解读')
})
