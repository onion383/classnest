// =========================================================================
// arrange-desk-mixed.test.js —— 智能排表按「桌号表」工作（方案 §11.2 / §11.4）
// 运行：npm run test:units
//
// 为什么单独建这个文件：
//   算法原先靠「列号奇偶」判断同桌。混合桌拆桌后两列之间多了一条走廊，但算法的
//   dense 坐标会把走廊压掉 —— 那两列看起来仍是相邻下标，于是「拆了等于没拆」：
//   同桌条件、同桌槽位、原同桌对提取、随机/公平切块全都会按老的双人桌口径继续跑。
//
// 两类判据一起用（只测纯函数会假绿，只 grep 源码也会假绿）：
//   1. **运行时**：直接加载三个算法模块 + 真实几何派生，调用 5 处方法，
//      与「旧奇偶实现」逐项对比（纯 single/double/mixed 初始必须完全等价），
//      再验混排拆桌后的新语义。
//   2. **接线**：vue 必须把 deskIndex 挂进 ctx，否则算法里 `ctx.deskIndex.value`
//      直接 TypeError —— 单测自建 ctx 照样全绿，这是本文件最想防的假绿。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../..')
const GEOM = pathToFileURL(path.join(ROOT, 'student-frontend/src/composables/useSeatGrid.geometry.js')).href
const DIR = path.join(ROOT, 'student-frontend/src/components/dialogs/SmartArrangementDialog')
const ARRANGE_VUE = path.join(DIR, 'SmartArrangementDialog.vue')
const PIPELINE = path.join(DIR, 'SmartArrangementDialog.pipeline.js')
const OPTIONS = path.join(DIR, 'SmartArrangementDialog.options.js')
const BLOCKS = path.join(DIR, 'SmartArrangementDialog.blocks.js')

const loadGeom = () => import(GEOM)
const loadPipeline = () => import(pathToFileURL(PIPELINE).href)
const loadOptions = () => import(pathToFileURL(OPTIONS).href)
const loadBlocks = () => import(pathToFileURL(BLOCKS).href)

function roster(n) {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, 姓名: `S${i + 1}` }))
}

// dense 网格：按行顺序填入学生 id（后面留几个空位，顺便覆盖「单人 / 空位」分支）
function fillSeats(rows, cols, people) {
  const out = []
  let k = 0
  for (let r = 0; r < rows; r++) {
    const line = []
    for (let c = 0; c < cols; c++) line.push(k < people.length - 1 ? people[k++].id : null)
    out.push(line)
  }
  return out
}

function regionOf(rows, cols) {
  const out = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ r, c })
  return out
}

// 造一个和组件 ctx 同形状的运行时上下文（算法模块经 ctx 闭包互调）
async function makeCtx({ mode, types, cols, rows = 3, people, baseSeats }) {
  const g = await loadGeom()
  const pattern = g.deriveDeskPattern(cols, types, mode)
  const ctx = {
    rows: { value: rows },
    cols: { value: g.seatColumnIndices(cols, types).length },
    mode: { value: mode },
    deskIndex: { value: g.deskIndexOfDense(cols, types, mode) },
    nonUniformDesk: { value: mode === 'mixed' && pattern.includes(1) && pattern.includes(2) },
    students: { value: people },
    baseSeats: { value: baseSeats },
    satisfaction: { value: {} },
    conditions: { value: [] },
  }
  const [p, o, b] = await Promise.all([loadPipeline(), loadOptions(), loadBlocks()])
  Object.assign(ctx,
    p.useSmartArrangementPipeline(ctx, {}),
    b.useSmartArrangementBlocks(ctx),
    o.useSmartArrangementOptions(ctx, {}))
  return ctx
}

// ---------------- 旧实现（改造前的「算奇偶」），用于逐项等价对比 ----------------
function oldRegionSlots(region, mode) {
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
      if (mode !== 'single' && c % 2 === 0 && inRow.has(c + 1)) {
        slots.push([{ r, c }, { r, c: c + 1 }]); i += 2
      } else { slots.push([{ r, c }]); i += 1 }
    }
  }
  return slots
}

function oldIsTwoAdjacent(pa, pb, mode) {
  if (pa[0] !== pb[0]) return false
  if (Math.abs(pa[1] - pb[1]) !== 1) return false
  if (mode !== 'single') return Math.min(pa[1], pb[1]) % 2 === 0
  return true
}

function oldDeskmateBlocks(region) {
  const map = new Map()
  for (const p of region) {
    const k = p.r + ',' + Math.floor(p.c / 2)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(p.c)
  }
  return [...map.values()].map((a) => a.sort((x, y) => x - y))
}

function oldPairs(ctx) {
  const pairs = [], singles = [], used = new Set()
  const src = ctx.baseSeats.value
  for (let r = 0; r < ctx.rows.value; r++) {
    const row = src?.[r] || []
    for (let c = 0; c < ctx.cols.value; c += 2) {
      const a = row[c], b = row[c + 1]
      const sa = typeof a === 'number' ? ctx.students.value.find((s) => s.id === a) : null
      const sb = typeof b === 'number' ? ctx.students.value.find((s) => s.id === b) : null
      if (sa && sb) { pairs.push([sa.id, sb.id]); used.add(sa.id); used.add(sb.id) }
      else if (sa) { singles.push(sa.id); used.add(sa.id) }
      else if (sb) { singles.push(sb.id); used.add(sb.id) }
    }
  }
  return {
    pairs, singles,
    orphans: ctx.students.value.filter((s) => !used.has(s.id)).map((s) => s.id),
  }
}

function oldTryTogether(grid, pa, pb, inRegion, mode) {
  const moved = grid[pb[0]][pb[1]]
  if (!moved) return false
  const [ra, ca] = pa
  for (const dc of [-1, 1]) {
    const nc = ca + dc
    if (!inRegion([ra, nc])) continue
    if (grid[ra][nc] !== null) continue
    if (mode !== 'single' && Math.min(ca, nc) % 2 !== 0) continue
    grid[ra][nc] = moved
    grid[pb[0]][pb[1]] = null
    return true
  }
  return false
}

// =========================================================================
// 1. 纯 single / double / mixed(初始全双桌)：5 处必须与旧奇偶实现逐项等价
// =========================================================================
test('regionSlots / isTwoAdjacent / splitRegion / extractOriginalPairs / tryTogether 在纯模式下与旧实现等价', async () => {
  const g = await loadGeom()
  for (const mode of ['single', 'double', 'mixed']) {
    for (const gridCols of [5, 8, 10]) {
      const rows = 3
      // mixed 的初始几何与 double 完全相同
      const types = g.formulaTypes(rows, gridCols, mode === 'single' ? 'single' : 'double')
      const denseCols = g.seatColumnIndices(gridCols, types).length
      const people = roster(rows * denseCols + 3)
      const baseSeats = fillSeats(rows, denseCols, people)
      const ctx = await makeCtx({ mode, types, cols: gridCols, rows, people, baseSeats })
      const region = regionOf(rows, denseCols)
      const tag = `${mode}/${gridCols}格`

      // ① 同桌槽位
      assert.deepEqual(ctx.regionSlots(region), oldRegionSlots(region, mode), `${tag} regionSlots`)

      // ② 是否同桌（穷举同行相邻列 + 隔行/隔列干扰项）。
      // 只比**存在的**两列：老实现对越界列（如 dense 只有 7 列却问 6、7）会按
      // min%2===0 答 true，那是个无害的历史空转，不该拿它当等价性要求。
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < denseCols; c++) {
          for (const d of [-2, -1, 1, 2]) {
            if (c + d < 0 || c + d >= denseCols) continue
            const pa = [r, c], pb = [r, c + d]
            assert.equal(ctx.isTwoAdjacent(pa, pb), oldIsTwoAdjacent(pa, pb, mode),
              `${tag} isTwoAdjacent(${r},${c},${c + d})`)
          }
        }
      }
      assert.equal(ctx.isTwoAdjacent([0, 0], [1, 0]), false, `${tag} 跨行不算同桌`)

      // ③ deskmate 切块（scope/unit 用）
      const newBlocks = ctx.splitRegion(region, 'deskmate').map((b) => b.pos.map((p) => p.c).sort((a, b) => a - b))
      assert.deepEqual(newBlocks, oldDeskmateBlocks(region), `${tag} splitRegion(deskmate)`)

      // ④ 原座位里的同桌对
      const got = ctx.extractOriginalPairs()
      assert.deepEqual({
        pairs: got.pairs.map((p) => p.map((s) => s.id)),
        singles: got.singles.map((s) => s.id),
        orphans: got.orphans.map((s) => s.id),
      }, oldPairs(ctx), `${tag} extractOriginalPairs`)

      // ⑤ 特殊关系「作为同桌」的落点（改的是 grid，每次都要新副本）
      for (let ca = 0; ca < denseCols; ca++) {
        const inRegion = ([r, c]) => r >= 0 && r < rows && c >= 0 && c < denseCols
        const seed = () => {
          const grid = Array.from({ length: rows }, () => new Array(denseCols).fill(null))
          grid[0][ca] = { id: 901, 姓名: 'A' }
          grid[1][0] = { id: 902, 姓名: 'B' }
          return grid
        }
        const a = seed(), b = seed()
        const okA = ctx.tryTogetherInRegion(a, [0, ca], [1, 0], inRegion)
        const okB = oldTryTogether(b, [0, ca], [1, 0], inRegion, mode)
        assert.equal(okA, okB, `${tag} tryTogetherInRegion(ca=${ca}) 返回值`)
        assert.deepEqual(a, b, `${tag} tryTogetherInRegion(ca=${ca}) 落点`)
      }
    }
  }
})

// =========================================================================
// 2. 混排拆桌后：算法必须真的不再把「隔走廊的两列」当同桌
// =========================================================================
async function splitScene() {
  const g = await loadGeom()
  const rows = 3, gridCols = 8
  const types = g.formulaTypes(rows, gridCols, 'double')
  const seats = types.map((line) => line.map(() => null))
  const ins = g.insertAisleColumn(types, seats, rows, gridCols, 1)
  const denseCols = g.seatColumnIndices(ins.cols, ins.types).length
  const people = roster(rows * denseCols + 3)
  const baseSeats = fillSeats(rows, denseCols, people)
  const ctx = await makeCtx({ mode: 'mixed', types: ins.types, cols: ins.cols, rows, people, baseSeats })
  return { g, rows, ins, denseCols, people, ctx, region: regionOf(rows, denseCols) }
}

test('拆桌后桌号真的分家：dense 里相邻的两列不再是同桌', async () => {
  const { ctx } = await splitScene()
  assert.equal(ctx.isTwoAdjacent([0, 0], [0, 1]), false, '拆开的两列不是同桌')
  // 只取被拆开的这两列：后面还有没拆的双人桌，全表槽位里仍有 2 格槽
  const slots = ctx.regionSlots([{ r: 0, c: 0 }, { r: 0, c: 1 }])
  assert.deepEqual(slots, [[{ r: 0, c: 0 }], [{ r: 0, c: 1 }]], '两张单人桌各占一个单格槽')
  // 与旧实现对比：旧的会把它俩并成一对 —— 这正是这次要修的故障
  assert.equal(oldRegionSlots([{ r: 0, c: 0 }, { r: 0, c: 1 }], 'double').length, 1)
})

test('拆桌后被拆的两列各成一块、原同桌对拆成单座，人数守恒', async () => {
  const { ctx, region } = await splitScene()
  const blocks = ctx.splitRegion(region, 'deskmate')
  // 桌型 [1,1,2,2]：2 张单人桌 + 2 张双人桌 → 每行 4 块，不是「每列一块」；
  // 没拆的那两张双人桌本来就该整块保留。
  assert.equal(blocks.length, 12, '3 行 × 4 张桌')
  const row0 = blocks.filter((b) => b.br === 0)
  assert.equal(row0.length, 4)
  assert.deepEqual(row0.map((b) => b.pos.length).sort((a, b) => a - b), [1, 1, 2, 2])
  const col = (c) => row0.find((b) => b.pos.some((p) => p.c === c))
  assert.equal(col(0).pos.length, 1, 'dense 列 0 单独一张桌')
  assert.equal(col(1).pos.length, 1, 'dense 列 1 单独一张桌')
  assert.equal(col(2).pos.length, 2, '没拆的双人桌仍是 2 格一块')

  const got = ctx.extractOriginalPairs()
  const old = oldPairs(ctx)
  assert.ok(got.pairs.length < old.pairs.length, '被拆的两列不再配成同桌对')
  assert.ok(got.singles.length > old.singles.length, '被拆的人都变成单座')
  const cover = (x) => x.pairs.length * 2 + x.singles.length + x.orphans.length
  assert.equal(cover(got), cover(old), '总人数守恒（不能静默丢人）')
})

test('拆桌后「作为同桌」不会把人挪到隔走廊的相邻格', async () => {
  const { ctx, denseCols } = await splitScene()
  const rows = 3
  const inRegion = ([r, c]) => r >= 0 && r < rows && c >= 0 && c < denseCols
  const grid = Array.from({ length: rows }, () => new Array(denseCols).fill(null))
  grid[0][0] = { id: 901, 姓名: 'A' }
  grid[1][0] = { id: 902, 姓名: 'B' }
  // dense 列 0 的右邻列 1 隔着一条走廊，不能当成同桌落点
  assert.equal(ctx.tryTogetherInRegion(grid, [0, 0], [1, 0], inRegion), false)
  assert.deepEqual(grid[0][1], null, '没把 B 挪进隔走廊的那格')
})

// =========================================================================
// 3. §11.4 四/六位置灰：只有「1 人桌与 2 人桌并存」才禁
// =========================================================================
test('groupOptions：纯模式与混合桌初始不置灰，非均匀混排才禁用四/六位', async () => {
  const g = await loadGeom()
  const rows = 3, gridCols = 8
  const check = async (mode, types, cols, expected) => {
    const denseCols = g.seatColumnIndices(cols, types).length
    const people = roster(denseCols * rows + 2)
    const ctx = await makeCtx({ mode, types, cols, rows, people, baseSeats: fillSeats(rows, denseCols, people) })
    const opts = ctx.groupOptions()
    for (const v of ['four', 'six']) {
      const o = opts.find((x) => x.value === v)
      assert.ok(o, `${mode} 仍要保留 ${v} 选项（置灰不是删掉）`)
      assert.equal(!!o.disabled, expected, `${mode} ${v} disabled`)
    }
  }
  const single = g.formulaTypes(rows, gridCols, 'single')
  const double = g.formulaTypes(rows, gridCols, 'double')
  await check('single', single, gridCols, false)
  await check('double', double, gridCols, false)
  await check('mixed', double, gridCols, false) // 混合桌初始化 = 全双桌，行为不变
  const ins = g.insertAisleColumn(double, double.map((l) => l.map(() => null)), rows, gridCols, 1)
  await check('mixed', ins.types, ins.cols, true)
})

// =========================================================================
// 4. 拆 → 合并同桌往返：两边右键都要能合回去，且删的是同一条走廊
// =========================================================================
test('deskActionsOfCol：拆桌后左右两半张桌都能右键合并，且指向同一条走廊', async () => {
  const g = await loadGeom()
  const rows = 3, gridCols = 8
  const types = g.formulaTypes(rows, gridCols, 'double')
  const seats = types.map((l) => l.map(() => null))

  // 初始：一张双人桌的左右两列都能拆，插走廊位置相同
  const left = g.deskActionsOfCol(gridCols, types, 'mixed', 0)
  const right = g.deskActionsOfCol(gridCols, types, 'mixed', 1)
  assert.equal(left.splitAt, 1)
  assert.equal(right.splitAt, 1, '右键右半列也要能拆（不在两列之间来回找菜单）')
  assert.equal(left.mergeLeftAt, -1, '双人桌不该给合并项')
  assert.equal(left.mergeRightAt, -1)

  const ins = g.insertAisleColumn(types, seats, rows, gridCols, left.splitAt)
  assert.deepEqual(g.deriveDeskPattern(ins.cols, ins.types, 'mixed'), [1, 1, 2, 2])

  // 拆完：左半张桌往右合、右半张桌往左合，都删刚插的那条走廊（下标 1）
  const l = g.deskActionsOfCol(ins.cols, ins.types, 'mixed', 0)
  const r = g.deskActionsOfCol(ins.cols, ins.types, 'mixed', 2)
  assert.equal(l.mergeRightAt, 1)
  assert.equal(r.mergeLeftAt, 1)
  assert.equal(r.mergeRightAt, -1, '右边是双人桌，不能并出 3 人桌')
  assert.equal(l.mergeRightAt, r.mergeLeftAt, '两边指向同一条走廊')

  // 真的删掉它 → 几何逐格还原、桌型回到全双桌
  const back = g.removeGridColumn(ins.types, ins.seats, ins.rows, ins.cols, r.mergeLeftAt)
  assert.deepEqual(back.types, types)
  assert.deepEqual(g.deriveDeskPattern(back.cols, back.types, 'mixed'), [2, 2, 2])
})

test('deskActionsOfCol：走廊列 / 越界列不给任何桌型动作', async () => {
  const g = await loadGeom()
  const types = g.formulaTypes(2, 5, 'double')
  const none = { splitAt: -1, mergeLeftAt: -1, mergeRightAt: -1 }
  assert.deepEqual(g.deskActionsOfCol(5, types, 'mixed', 2), none, '走廊列')
  assert.deepEqual(g.deskActionsOfCol(5, types, 'mixed', -1), none)
  assert.deepEqual(g.deskActionsOfCol(5, types, 'mixed', 99), none)
})

// =========================================================================
// 5. 接线判据：算法模块是经 ctx 闭包互调的，漏挂 deskIndex 会运行时 TypeError
// =========================================================================
test('SmartArrangementDialog.vue 把桌号表与非均匀判据挂进 ctx', () => {
  const src = fs.readFileSync(ARRANGE_VUE, 'utf8')
  assert.match(src, /deskIndexOfDense\(props\.cols, gridTypes\.value, props\.mode\)/,
    '桌号表必须从几何派生（不要在组件里再算一遍）')
  assert.match(src, /deriveDeskPattern\(props\.cols, gridTypes\.value, props\.mode\)/, '桌型序列同源')
  assert.match(src, /deskIndex: denseDeskIndex,/, 'ctx 必须挂 deskIndex（算法要读 .value）')
  assert.match(src, /nonUniformDesk,/, 'ctx 必须挂 nonUniformDesk（置灰要读 .value）')
})

test('算法 5 处不再有奇偶算术（只剩 single 的历史口径特判）', () => {
  const pipeline = fs.readFileSync(PIPELINE, 'utf8')
  const options = fs.readFileSync(OPTIONS, 'utf8')
  const blocks = fs.readFileSync(BLOCKS, 'utf8')
  assert.ok(!/c % 2 === 0/.test(pipeline), 'regionSlots 不能改回 c%2')
  assert.ok(!/Math\.min\(pa\[1\], pb\[1\]\) % 2 === 0/.test(options), 'isTwoAdjacent 不能改回奇偶')
  assert.ok(!/Math\.min\(ca, nc\) % 2 !== 0/.test(blocks), 'tryTogetherInRegion 不能改回奇偶')
  assert.ok(!/c \+= 2/.test(options), 'extractOriginalPairs 不能改回固定步长 2')
  // splitRegion 只在 pure single 保留 floor(c/2)：其它模式必须查桌号
  assert.match(pipeline, /ctx\.mode\.value === 'single' \? Math\.floor\(p\.c \/ 2\) : \(ctx\.deskIndex\.value\[p\.c\]/,
    'desc 分支必须按桌号切块')
  // 统一的同桌判定入口，5 处都走它
  assert.match(pipeline, /isDeskmateCols\(ca, cb\)/, '要有统一判定入口')
  const uses = (pipeline + options + blocks).match(/ctx\.isDeskmateCols\(/g) || []
  assert.ok(uses.length >= 4, `至少要 4 处调用统一入口，实得 ${uses.length}`)
})
