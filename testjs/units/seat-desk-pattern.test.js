// =========================================================================
// seat-desk-pattern.test.js —— 混合桌：桌型从「走廊在哪」派生
// 运行：npm run test:units
//
// 模型（用户 2026-11-10 拍板）：不画桌缝，拆桌 = 在两列之间插一条走廊，
// 合并 = 删掉中间那条走廊。所以桌型**不需要另存一份序列** —— 走廊就是分界：
//   · single：每列一张单人桌
//   · double：整行按 2 列切桌，走廊只是过道
//   · mixed ：先按走廊把座位列切成连续块，块内每 2 列一桌，块尾落单的自成单人桌
// mixed 在双桌布局下天然派生出全 2 —— 这就是「混合桌初始化 = 双桌模式」。
//
// 为什么必须钉住「几何 → 桌型」这条派生：拆桌/合并只改几何（types/cols），
// 撤销走已有的 grid_snapshot 就能完整回退；如果桌型另存一份字段，撤销不会回写它，
// 撤掉拆桌后走廊没了、序列还停在「两张单人桌」，用户会以为撤销坏了。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const GEOM = pathToFileURL(path.join(__dirname, '../../student-frontend/src/composables/useSeatGrid.geometry.js')).href
const USG = path.join(__dirname, '../../student-frontend/src/composables/useSeatGrid.js')
const SEATVIEW = path.join(__dirname, '../../student-frontend/src/views/SeatView.vue')
const GRIDVIEW = path.join(__dirname, '../../student-frontend/src/components/tables/GridView/GridView.vue')
const SETTINGS = path.join(__dirname, '../../student-frontend/src/components/dialogs/SeatSettingsDialog.vue')
const load = () => import(GEOM)

// ---------------- deskPatternOf：兜底语义 ----------------
test('deskPatternOf：合法序列原样返回（长度 = 桌数，和 = 座位列数）', async () => {
  const { deskPatternOf } = await load()
  assert.deepEqual(deskPatternOf('single', 6, [2, 1, 1, 2]), [2, 1, 1, 2])
  assert.deepEqual(deskPatternOf('single', 4, [2, 2]), [2, 2])
})

test('deskPatternOf：空 / 非法 / 和不符 → 按 mode 兜底', async () => {
  const { deskPatternOf } = await load()
  assert.deepEqual(deskPatternOf('single', 3, []), [1, 1, 1])
  // double / mixed 的兜底都是「每 2 列一桌，末尾落单自成一桌」—— 不能 fill(2)，
  // 那样和会是 2n，桌号越界
  assert.deepEqual(deskPatternOf('double', 3, []), [2, 1])
  assert.deepEqual(deskPatternOf('mixed', 3, []), [2, 1])
  assert.deepEqual(deskPatternOf('double', 4, []), [2, 2])
  assert.deepEqual(deskPatternOf('single', 3, [2, 2]), [1, 1, 1], '和 4 ≠ 3，整条回退')
  assert.deepEqual(deskPatternOf('double', 2, [2, 3]), [2], '元素非法')
  assert.deepEqual(deskPatternOf('double', 2, ['x', 1]), [2])
})

test('deskIndexOfPattern：按桌分组，桌号从 0 起', async () => {
  const { deskIndexOfPattern } = await load()
  assert.deepEqual(deskIndexOfPattern([2, 2]), [0, 0, 1, 1])
  assert.deepEqual(deskIndexOfPattern([1, 1, 2]), [0, 1, 2, 2])
})

// ---------------- 几何 → 桌型 ----------------
test('mixed 的几何公式与 double 完全一致（初始化 = 双桌模式）', async () => {
  const { formulaTypes, seatColsToGrid } = await load()
  for (const rows of [1, 3]) {
    for (const cols of [5, 7, 10]) {
      assert.deepEqual(formulaTypes(rows, cols, 'mixed'), formulaTypes(rows, cols, 'double'))
    }
  }
  for (const seatCols of [2, 4, 7]) {
    assert.equal(seatColsToGrid(seatCols, 'mixed'), seatColsToGrid(seatCols, 'double'))
  }
})

test('deriveDeskPattern：single 全单人桌、double 按 2 切、mixed 初始全双人桌', async () => {
  const { deriveDeskPattern, formulaTypes } = await load()
  const rows = 2
  const cols = 5 // double 公式：座 座 走 座 座 → 4 个座位列
  const types = formulaTypes(rows, cols, 'double')
  assert.deepEqual(deriveDeskPattern(cols, types, 'single'), [1, 1, 1, 1])
  assert.deepEqual(deriveDeskPattern(cols, types, 'double'), [2, 2])
  assert.deepEqual(deriveDeskPattern(cols, types, 'mixed'), [2, 2],
    '混合桌初始化必须是双桌模式，而不是全单人桌')
})

test('deriveDeskPattern：mixed 在两列之间插一条走廊 → 那张桌拆成两张单人桌', async () => {
  const { deriveDeskPattern, formulaTypes, insertAisleColumn, removeGridColumn } = await load()
  const rows = 2
  const cols = 5
  const types = formulaTypes(rows, cols, 'double')
  const seats = types.map((line) => line.map(() => null))
  // 在第 0、1 列之间（at=1）插一条走廊
  const split = insertAisleColumn(types, seats, rows, cols, 1)
  assert.deepEqual(deriveDeskPattern(split.cols, split.types, 'mixed'), [1, 1, 2],
    '被拆的那张双人桌变成两张单人桌，右边那张桌不受影响')
  // 删掉这条走廊 → 回到全双人桌（撤销同理，几何回退后桌型自动跟着回退）
  const merged = removeGridColumn(split.types, split.seats, split.rows, split.cols, 1)
  assert.deepEqual(deriveDeskPattern(merged.cols, merged.types, 'mixed'), [2, 2])
})

test('deriveDeskPattern：连续块是 3 列时切成一张双人桌 + 一张单人桌', async () => {
  const { deriveDeskPattern } = await load()
  const cols = 3
  const types = [[0, 0, 0]] // 没有走廊，3 个座位列连成一块
  assert.deepEqual(deriveDeskPattern(cols, types, 'mixed'), [2, 1])
  assert.deepEqual(deriveDeskPattern(cols, types, 'double'), [2, 1], 'double 忽略走廊分块，结果相同')
})

test('deskSizeIndexOfGrid：桌大小用于判断「能拆 / 能并」', async () => {
  const { deskSizeIndexOfGrid, formulaTypes, insertAisleColumn } = await load()
  const rows = 2
  const cols = 5
  const types = formulaTypes(rows, cols, 'double')
  const seats = types.map((line) => line.map(() => null))
  assert.deepEqual(deskSizeIndexOfGrid(cols, types, 'mixed'), [2, 2, 0, 2, 2],
    '走廊列 0，其余是所在桌的人数')
  const split = insertAisleColumn(types, seats, rows, cols, 1)
  assert.deepEqual(deskSizeIndexOfGrid(split.cols, split.types, 'mixed'), [1, 0, 1, 0, 2, 2],
    '拆开后两列都变成单人桌；只看桌号会把「两张双人桌」误判成可并')
})

test('deskIndexOfGrid：拆桌前后桌号确实分家，走廊列恒 -1', async () => {
  const { deskIndexOfGrid, formulaTypes, insertAisleColumn } = await load()
  const rows = 2
  const cols = 5
  const types = formulaTypes(rows, cols, 'double')
  const before = deskIndexOfGrid(cols, types, 'mixed')
  assert.deepEqual(before, [0, 0, -1, 1, 1])
  const split = insertAisleColumn(types, types.map((l) => l.map(() => null)), rows, cols, 1)
  const after = deskIndexOfGrid(split.cols, split.types, 'mixed')
  assert.notEqual(after[0], after[2], '拆开后两列必须是不同桌')
  assert.equal(after[1], -1, '走廊列不参与桌号')
})

// ---------------- 不画桌缝 ----------------
test('buildSeatLikeRows 不再产生 _deskGapLeft，GridView 也不渲染桌缝', async () => {
  const { buildSeatLikeRows } = await load()
  const cols = 4
  const types = [new Array(cols).fill(0)]
  const rows = buildSeatLikeRows(1, cols, types, () => ({ course: 'x' }))
  for (const cell of rows[1].cells) assert.equal(cell._deskGapLeft, undefined)
  const gv = fs.readFileSync(GRIDVIEW, 'utf8')
  assert.ok(!/desk-gap-left/.test(gv), '桌缝 class / CSS 都不该还在（用户要求「不显示桌缝」）')
  const geom = fs.readFileSync(path.join(__dirname,
    '../../student-frontend/src/composables/useSeatGrid.geometry.js'), 'utf8')
  assert.ok(!/_deskGapLeft/.test(geom), '几何层不该再产出桌缝标记')
})

// ---------------- 接线判据 ----------------
test('设置弹窗：单座 / 双座 / 混合桌 用下拉，且混合模式有说明', () => {
  const src = fs.readFileSync(SETTINGS, 'utf8')
  assert.match(src, /<select v-model="localMode"/, '必须是下拉菜单，不是 radio')
  for (const v of ['single', 'double', 'mixed']) {
    assert.match(src, new RegExp(`<option value="${v}">`), `下拉里要有 ${v}`)
  }
  assert.ok(!/type="radio"/.test(src), '旧的 radio 要删干净')
  assert.match(src, /localMode === 'mixed'/, '混合桌要有说明文字')
})

test('useSeatGrid：桌型从几何派生，插/删列同笔切到 mixed 且失败回滚', () => {
  const src = fs.readFileSync(USG, 'utf8')
  assert.ok(!/deskPattern/.test(src), '不该再读写独立的桌型序列（它会和撤销脱节）')
  assert.ok(!/deskMap|deskSizes/.test(src),
    '桌号表不再由 composable 单独持有：菜单与排表算法都改用几何纯函数按需派生')
  for (const fn of ['insertAisleColAt', 'removeColAt']) {
    const start = src.indexOf(`async function ${fn}`)
    const body = src.slice(start, start + 900)
    assert.match(body, /const beforeMode = mode\.value/, `${fn} 要留旧 mode`)
    assert.match(body, /if \(opts\.mode\) mode\.value = opts\.mode/, `${fn} 要同笔切到 mixed`)
    assert.match(body, /mode\.value = beforeMode/, `${fn} 保存失败 / 早退都要回滚 mode`)
  }
})

test('SeatView：桌型菜单走「插 / 删走廊列」，拆桌后两侧都能合并同桌', () => {
  const src = fs.readFileSync(SEATVIEW, 'utf8')
  assert.match(src, /label: '拆成两张单人桌（插入走廊）'/, '拆桌入口')
  assert.match(src, /label: '与右侧一列合并同桌'/, '右侧合并入口')
  assert.match(src, /label: '与左侧一列合并同桌'/, '左侧合并入口（被拆出的右半张桌要能合回去）')
  assert.match(src, /deskActionsOfCol\(g\.cols\.value, g\.types\.value, g\.mode\.value, colMenuColIdx\.value\)/,
    '菜单条件必须走几何纯函数，不在组件里自己拼「右侧走廊 + 单人桌」判据')
  assert.ok(!/applyDeskMerge\(\)/.test(src), '不能再用「右键列 + 1」猜要删哪条走廊')
  assert.match(src, /applyAisleColInsert\('right', \{ at: splitAt, mode: 'mixed'/, '拆桌必须切到 mixed')
  assert.match(src, /applyAisleColRemove\(at, \{ mode: 'mixed'/, '合并必须切到 mixed')
  // 两张表共用同一撤销批次（改成展开 opts 后仍在）
  for (const call of ['insertAisleColAt(at, { origin, ...opts })', 'removeColAt(at, { origin, ...opts })']) {
    assert.equal((src.split(call).length - 1), 2, `${call} 要出现在两张表上`)
  }
})

test('拆桌/合并后撤销：几何回退即可，桌型无需单独撤销', async () => {
  const { deriveDeskPattern, formulaTypes, insertAisleColumn, removeGridColumn } = await load()
  const rows = 2, cols = 5
  const types = formulaTypes(rows, cols, 'double')
  const seats = types.map((l) => l.map(() => null))
  const start = deriveDeskPattern(cols, types, 'mixed')
  const split = insertAisleColumn(types, seats, rows, cols, 1)
  assert.notDeepEqual(deriveDeskPattern(split.cols, split.types, 'mixed'), start, '拆桌确实改了桌型')
  const back = removeGridColumn(split.types, split.seats, split.rows, split.cols, 1)
  assert.deepEqual(deriveDeskPattern(back.cols, back.types, 'mixed'), start,
    '把几何退回（撤销做的事）后，桌型自动回到拆桌前 —— 不需要回写任何桌型字段')
})
