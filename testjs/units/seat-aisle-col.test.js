// =========================================================================
// seat-aisle-col.test.js —— 整列走廊（列头右键「左/右插入走廊」「删除这条走廊」）
// 运行：npm run test:units
//
// 四件事：
//   1. 几何语义：插入不动左右两列；删除逐格还原；cols 必须跟着变
//   2. 插入后的矩阵要过**后端** assertSeatTypes（走廊只能整行/整列）
//   3. 调用点接线：types/seats/cols 三者同笔写、撤销必须带上 cols、权重矩阵先对齐
//   4. colLabelMenu 的 ctx 映射（漏了就是「右键完全没反应」，而且模板上看不出来）
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
const load = () => import(GEOM)

// ---------------- 几何：插入 ----------------
test('insertAisleColumn：新列整列是走廊，左右两列的学生逐格不动', async () => {
  const { insertAisleColumn, formulaTypes, CELL } = await load()
  const rows = 3
  const cols = 5 // 座 走 座 走 座
  const types = formulaTypes(rows, cols, 'single')
  const seats = [
    [1, null, 2, null, 3],
    [4, null, 5, null, 6],
    [7, null, 8, null, 9],
  ]
  const out = insertAisleColumn(types, seats, rows, cols, 2)

  assert.equal(out.cols, cols + 1, 'cols 必须 +1（不带回去后端按旧 cols 裁掉末尾）')
  assert.equal(out.types.length, rows)
  assert.equal(out.types[0].length, cols + 1)
  for (let r = 0; r < rows; r++) {
    assert.equal(out.types[r][2], CELL.AISLE, `第 ${r} 行第 2 列必须是走廊（整列）`)
    assert.equal(out.seats[r][2], null, '走廊格不能承载学生')
    // 左侧原样、右侧整体后移一格
    assert.deepEqual(out.seats[r].slice(0, 2), [seats[r][0], seats[r][1]])
    assert.deepEqual(out.seats[r].slice(3), [seats[r][2], seats[r][3], seats[r][4]])
  }
})

test('insertAisleColumn：座位列序号不变（只是网格下标后移，不需要重映射数据）', async () => {
  const { insertAisleColumn, seatColumnIndices, formulaTypes } = await load()
  const cols = 5
  const types = formulaTypes(2, cols, 'single')
  const seats = types.map((line) => line.map(() => null))
  const out = insertAisleColumn(types, seats, 2, cols, 0)
  const before = seatColumnIndices(cols, types)
  const after = seatColumnIndices(out.cols, out.types)
  assert.equal(after.length, before.length, '座位列数量不该变（走廊列不是座位列）')
  assert.deepEqual(after, before.map((c) => c + 1), '所有座位列整体后移一格')
})

test('insertAisleColumn：at 越界时夹到 [0, cols]（不抛、不丢学生）', async () => {
  const { insertAisleColumn, formulaTypes, CELL } = await load()
  const cols = 3
  const types = formulaTypes(1, cols, 'single')
  const seats = [[1, null, 2]]
  const head = insertAisleColumn(types, seats, 1, cols, -5)
  assert.equal(head.types[0][0], CELL.AISLE, '负数夹到最前')
  assert.deepEqual(head.seats[0].slice(1), seats[0])
  const tail = insertAisleColumn(types, seats, 1, cols, 99)
  assert.equal(tail.types[0][tail.cols - 1], CELL.AISLE, '越界夹到最后')
  assert.deepEqual(tail.seats[0].slice(0, cols), seats[0])
})

// ---------------- 几何：删除 ----------------
test('removeGridColumn：删回后逐格还原，removedSeats 带回被删那列的人', async () => {
  const { insertAisleColumn, removeGridColumn, formulaTypes } = await load()
  const rows = 2
  const cols = 5
  const types = formulaTypes(rows, cols, 'single')
  const seats = [
    [1, null, 2, null, 3],
    [4, null, 5, null, 6],
  ]
  for (let at = 0; at <= cols; at++) {
    const ins = insertAisleColumn(types, seats, rows, cols, at)
    const back = removeGridColumn(ins.types, ins.seats, ins.rows, ins.cols, at)
    assert.deepEqual(back.types, types, `在 ${at} 处插了再删，必须逐格回到原样`)
    assert.deepEqual(back.seats, seats, `在 ${at} 处插了再删，学生必须回到原位置`)
    assert.equal(back.cols, cols)
    assert.deepEqual(back.removedSeats, new Array(rows).fill(null), '删的是刚插的空走廊，不带人')
  }
})

test('removeGridColumn：只剩一列 / 越界返回 null（删空没有几何）', async () => {
  const { removeGridColumn, formulaTypes } = await load()
  const one = formulaTypes(1, 1, 'single')
  assert.equal(removeGridColumn(one, [[1]], 1, 1, 0), null, 'cols=1 不许删')
  const two = formulaTypes(1, 2, 'single')
  assert.equal(removeGridColumn(two, [[1, null]], 1, 2, 2), null, '越界不许删')
  assert.equal(removeGridColumn(two, [[1, null]], 1, 2, -1), null)
  // 删座位列也要把这个人带回来（几何层不判断语义，但数据不能凭空消失）
  const cut = removeGridColumn(two, [[1, 2]], 1, 2, 1)
  assert.deepEqual(cut.removedSeats, [2])
  assert.deepEqual(cut.seats, [[1]])
})

// ---------------- 后端契约：插入后的矩阵必须合法 ----------------
test('插入走廊列后的 types 能过后端 assertSeatTypes（走廊只能整行/整列）', async () => {
  process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
  process.env.DATA_DIR = process.env.DATA_DIR || path.join(require('node:os').tmpdir(), 'seat-aisle-col-unit-' + process.pid)
  const backendRequire = require('node:module').createRequire(
    path.join(__dirname, '../../student-backend/package.json'))
  const { assertSeatTypes } = backendRequire('./services/businessRules')

  const { insertAisleColumn, removeGridColumn, formulaTypes } = await load()
  for (const mode of ['single', 'double']) {
    for (const cols of [3, 5, 7]) {
      const rows = 3
      const types = formulaTypes(rows, cols, mode)
      const seats = types.map((line) => line.map(() => null))
      for (let at = 0; at <= cols; at++) {
        const ins = insertAisleColumn(types, seats, rows, cols, at)
        assert.doesNotThrow(() => assertSeatTypes(ins.types, rows, ins.cols),
          `${mode}/${cols} 列在 ${at} 插入后被后端拒绝了`)
        assert.equal(ins.types[0].length, ins.cols, 'types 列数与 cols 必须一致（否则读回被裁）')
        const back = removeGridColumn(ins.types, ins.seats, rows, ins.cols, at)
        assert.doesNotThrow(() => assertSeatTypes(back.types, rows, back.cols), '删回后同样要合法')
        assert.deepEqual(back.types, types)
      }
    }
  }
})

// ---------------- 调用点判据（只测纯函数会假绿）----------------
function fnBody(src, name) {
  const start = src.indexOf(`async function ${name}`)
  assert.ok(start > 0, `${name} 必须存在`)
  // 结尾必须是「缩进 2 空格的行首 }」：这些函数定义在 useSeatGrid() 内部，
  // 用 '\n}\n' 会一路切到文件末尾（useSeatGrid 自己的收尾），把后面的函数全包进来 ——
  // 于是「A 函数里少了某行」会被 B 函数里的同一行补上，判据假绿（本文件真踩过）。
  // 用正则而不是 indexOf：本仓库源码是 CRLF，indexOf('\n  }\n') 永远找不到。
  const m = /\r?\n {2}\}\r?\n/.exec(src.slice(start))
  const end = m ? start + m.index : -1
  assert.ok(end > start, `${name} 的结尾没找到（函数应定义在 useSeatGrid 内部，缩进 2 空格）`)
  return src.slice(start, end)
}

test('insertAisleColAt / removeColAt：types/seats/cols 三者同写、整块保存、带上限', () => {
  const src = fs.readFileSync(USG, 'utf8')
  for (const [fn, label] of [['insertAisleColAt', '插入'], ['removeColAt', '删除']]) {
    const body = fnBody(src, fn)
    // 三行连续赋值：只写 types 会被后端按旧 cols 裁掉，只写 cols 走廊会变座位
    assert.match(body, /types\.value = next\.types\r?\n\s*seats\.value = next\.seats\r?\n\s*cols\.value = next\.cols/,
      `${label}走廊列必须 types/seats/cols 一起写`)
    assert.match(body, /await save\(\)/, `${label}走廊列必须走整块 save（单格 PATCH 不写 types/cols）`)
    assert.match(body, /restoreGeometry\(before\)/, `${label}失败必须回滚本地几何，否则界面留着一列库里没有的走廊`)
  }
  assert.match(fnBody(src, 'insertAisleColAt'), /cols\.value \+ 1 > SEAT_MAX_GRID_COLS/,
    '插入前要挡网格总列数上限（用座位列数去卡会把合法布局判越界）')
  assert.match(src, /insertAisleColumn\(types\.value, seats\.value, rows\.value, cols\.value, at\)/,
    '要复用它自己的几何纯函数，不能自己拼矩阵')
  assert.match(src, /removeGridColumn\(types\.value, seats\.value, rows\.value, cols\.value, at\)/)
  // 撤销：后端 grid_snapshot 只回写 JSON 列，不认 cols
  assert.match(src, /oldCols: before\.cols, newCols: cols\.value/,
    '撤销记录不带列数的话，撤掉插入后库里是「types 少一列、cols 还是多的」')
  // 快照/回滚也要认 cols —— 少了它，保存失败后 cols 停在 +1，下次保存直接对不上
  assert.match(src, /function snapshotGeometry\(\)[\s\S]{0,220}?cols: cols\.value/,
    'snapshotGeometry 必须快照 cols')
  assert.match(src, /function restoreGeometry\(snap\)[\s\S]{0,200}?cols\.value = snap\.cols/,
    'restoreGeometry 必须回滚 cols')
})

test('SeatView：权重矩阵先插列、再改 cols；两张表共用同一个撤销批次', () => {
  const src = fs.readFileSync(SEATVIEW, 'utf8')
  const start = src.indexOf('async function applyAisleColInsert')
  assert.ok(start > 0, 'applyAisleColInsert 必须存在（列头右键的插入动作）')
  const body = src.slice(start, src.indexOf('function askAisleColRemove'))
  const shiftAt = body.indexOf('shiftWeightCols(at, +1)')
  const gridAt = body.indexOf('insertAisleColAt(at,')
  assert.ok(shiftAt > 0 && gridAt > 0, '两个动作都得在 applyAisleColInsert 里')
  assert.ok(shiftAt < gridAt, '先对齐权重矩阵再改 cols，否则 resizeWeights 按网格下标裁补，右边各列整体左移')
  assert.equal((body.split('insertAisleColAt(at, { origin, ...opts })').length - 1), 2,
    '两张座位表的写入都要带同一个 origin（拆桌时还会展开 opts，不能只匹配字面量）')
  assert.match(body, /const origin = newUndoBatchId\(\)/, '要生成批次标识')

  const delStart = src.indexOf('async function applyAisleColRemove')
  const delBody = src.slice(delStart, delStart + 1400)
  assert.ok(delBody.indexOf('shiftWeightCols(at, -1)') < delBody.indexOf('removeColAt(at,'),
    '删列同理：先删权重那一列，再让座位表少一列')
  assert.match(delBody, /restoreWeightCol\(at, removed\)/, '失败要把权重那一列原样插回')

  // 删除确认框由行/列共用，必须按 kind 分流（否则删列会去删一行）
  assert.match(src, /if \(aisleConfirmKind\.value === 'col'\)/, '确认框要按 kind 分流')
  assert.match(src, /aisleConfirmKind\.value = 'col'/, '列删除要把 kind 设成 col')
})

test('GridView：colLabelMenu 必须映射进 ctx，否则右键直接抛 TypeError', () => {
  const src = fs.readFileSync(GRIDVIEW, 'utf8')
  assert.match(src, /colLabelMenu: \{ type: Boolean, default: false \}/, '要有 opt-in prop')
  assert.match(src, /colLabelMenu: toRef\(props, 'colLabelMenu'\)/,
    'ctx 必须映射 colLabelMenu（方法体读的是 ctx.colLabelMenu.value）')
  assert.match(src, /'col-label-menu'/, 'emit 列表要登记 col-label-menu')
  assert.match(src, /@contextmenu="onColLabelContextMenu\(\$event, colIdx\)"/, '列头 th 要接右键')
  // 历史坑：方法体读 ctx.X.value，而 ctx 里没映射 X → 右键直接抛 TypeError，
  // 模板上光标/事件全都在，看不出「少了一行 ctx 映射」。这里只校验**props 上的键**：
  // 被 ctx 读到、却既不是 props 也没映射的，才是真漏。
  const propNames = new Set()
  const propsBlock = src.slice(src.indexOf('const props = defineProps({'), src.indexOf('const emit = defineEmits'))
  for (const m of propsBlock.matchAll(/^ {4}([A-Za-z_$][\w$]*): \{/gm)) propNames.add(m[1])
  const missing = []
  for (const m of src.matchAll(/ctx\.([A-Za-z_$][\w$]*)\.value/g)) {
    const key = m[1]
    if (!propNames.has(key)) continue
    if (!src.includes(`${key}: toRef(props, '${key}')`)) missing.push(key)
  }
  assert.deepEqual([...new Set(missing)], [], `ctx 缺 props 映射：${[...new Set(missing)].join(', ')}`)
})

test('SeatView：两张座位表都开启 colLabelMenu 并接到各自的处理函数', () => {
  const src = fs.readFileSync(SEATVIEW, 'utf8')
  assert.equal((src.match(/:colLabelMenu="true"/g) || []).length, 2, '当前座位 + 座位模板都要开')
  assert.match(src, /@col-label-menu="onActiveColLabelMenu"/)
  assert.match(src, /@col-label-menu="onMasterColLabelMenu"/)
  assert.match(src, /:items="colMenuItems"/, '列右键菜单要挂到 ContextMenu 上')
})
