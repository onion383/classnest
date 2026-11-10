// =========================================================================
// seat-aisle-row.test.js —— 阶段 C：手绘整行走廊
// 运行：npm run test:units
//
// 三件事一起测：
//   1. 行标签右键「上方/下方插入走廊」「删除这条走廊」的几何语义
//      （插入 = 行数 +1 且不改动被右键那行；删除 = 逐格还原）
//   2. 手绘的行走廊要活过「改设置」（reshapeGeometry 重建几何时不能被公式冲掉）
//   3. 调用点接线：rows 与 types 必须同笔写、撤销必须带上行数
//
// 为什么必须单独锚定：
//   公式 types 只会生成**列**走廊，行走廊纯粹是用户手绘的。改造前 reshapeGeometry
//   只搬空位（carryHoleTypes），改一次行数/列数，手绘的走廊就整行变回座位 ——
//   界面上看不出是「被重置」，只像是「我画的走廊没了」。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const GEOM = pathToFileURL(path.join(__dirname, '../../student-frontend/src/composables/useSeatGrid.geometry.js')).href
const GRIDVIEW = path.join(__dirname, '../../student-frontend/src/components/tables/GridView/GridView.vue')
const load = () => import(GEOM)

// 手绘整行走廊：把第 r 行整行刷成走廊（原来的 toggleAisleRowTypes 已随「覆盖式改法」删除，
// 但「改设置时要保住手绘行走廊」这条规则还在，测试需要一个构造器）
const markAisleRow = (types, r) => types.map((line, i) => (i === r ? line.map(() => 1) : line))

// ---------------- 插入 / 删除行走廊（行标签右键）----------------
test('insertAisleRow：上方插入，原数据整体后移一行且一格不丢', async () => {
  const { insertAisleRow, formulaTypes, CELL } = await load()
  const cols = 5
  const types = formulaTypes(3, cols, 'single')
  const seats = [
    [1, null, 2, null, 3],
    [4, null, 5, null, 6],
    [7, null, 8, null, 9],
  ]
  const next = insertAisleRow(types, seats, 3, cols, 1) // 插在第 1 行之前
  assert.equal(next.rows, 4, '行数必须 +1（types 与 rows 同源）')
  assert.equal(next.types.length, 4)
  assert.deepEqual(next.types[1], new Array(cols).fill(CELL.AISLE), '新插入的那行整行是走廊')
  assert.deepEqual(next.seats[1], new Array(cols).fill(null), '走廊不承载学生')
  assert.deepEqual(next.seats[0], seats[0], '上方那行不动')
  assert.deepEqual(next.seats[2], seats[1], '原来第 2 行后移到第 3 行')
  assert.deepEqual(next.seats[3], seats[2])
  // 关键：只搬数据不搬 types 会让「学生坐在走廊上」，这里 types 也整体后移了
  assert.deepEqual(next.types[2], types[1])
})

test('insertAisleRow：下方插入的位置是 at=r+1，末尾追加都不越界', async () => {
  const { insertAisleRow, formulaTypes, CELL } = await load()
  const cols = 3
  const types = formulaTypes(2, cols, 'single')
  const seats = [[1, null, 2], [3, null, 4]]
  const below = insertAisleRow(types, seats, 2, cols, 1) // 第 1 行下方
  assert.deepEqual(below.seats[0], seats[0])
  assert.deepEqual(below.seats[1], new Array(cols).fill(null))
  assert.deepEqual(below.seats[2], seats[1])
  const tail = insertAisleRow(types, seats, 2, cols, 2) // 追加到最末
  assert.equal(tail.rows, 3)
  assert.deepEqual(tail.types[2], new Array(cols).fill(CELL.AISLE))
  assert.deepEqual(tail.seats[2], new Array(cols).fill(null))
})

test('insertAisleRow：at 越界一律夹到 [0, rows]，不会插到中间丢行', async () => {
  const { insertAisleRow, formulaTypes } = await load()
  const cols = 3
  const types = formulaTypes(2, cols, 'single')
  const seats = [[1, null, 2], [3, null, 4]]
  const neg = insertAisleRow(types, seats, 2, cols, -5)
  assert.equal(neg.rows, 3)
  assert.deepEqual(neg.seats[0], new Array(cols).fill(null), '负数按「插到最前」处理')
  const big = insertAisleRow(types, seats, 2, cols, 99)
  assert.equal(big.rows, 3)
  assert.deepEqual(big.seats[0], seats[0], '超上界按「追加到末尾」处理')
  assert.deepEqual(big.seats[2], new Array(cols).fill(null))
})

test('removeGridRow：删掉行走廊后行列数与数据都回到插入前', async () => {
  const { insertAisleRow, removeGridRow, formulaTypes } = await load()
  const cols = 5
  const types = formulaTypes(3, cols, 'single')
  const seats = [
    [1, null, 2, null, 3],
    [4, null, 5, null, 6],
    [7, null, 8, null, 9],
  ]
  const added = insertAisleRow(types, seats, 3, cols, 1)
  const back = removeGridRow(added.types, added.seats, added.rows, cols, 1)
  assert.equal(back.rows, 3)
  assert.deepEqual(back.types, types, '几何要逐格还原，不能只剩「行数对了」')
  assert.deepEqual(back.seats, seats)
  assert.deepEqual(back.removedSeats, new Array(cols).fill(null))
})

test('removeGridRow：只剩一行 / 越界行号返回 null（删空没有几何可言）', async () => {
  const { removeGridRow, formulaTypes } = await load()
  const cols = 3
  const t1 = formulaTypes(1, cols, 'single')
  assert.equal(removeGridRow(t1, [[1, null, 2]], 1, cols, 0), null, 'rows=1 时不许删')
  const t2 = formulaTypes(2, cols, 'single')
  assert.equal(removeGridRow(t2, [[1, null, 2], [3, null, 4]], 2, cols, 5), null, '越界不许删')
  assert.equal(removeGridRow(t2, [], 2, cols, -1), null)
})

// 光测纯函数不够：插入后的矩阵必须能过**后端写库校验**，否则前端算得再对，
// PUT 上去也是 400（「走廊只能整行或整列设置」这条最容易在行走廊上踩）。
// 用真后端规则跑单桌/双人桌 × 若干列宽 × 每个插入位置。
test('插入行走廊后的 types 能过后端 assertSeatTypes（走廊只能整行/整列）', async () => {
  process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
  process.env.DATA_DIR = process.env.DATA_DIR || path.join(require('node:os').tmpdir(), 'seat-aisle-unit-' + process.pid)
  const backendRequire = require('node:module').createRequire(
    path.join(__dirname, '../../student-backend/package.json'))
  const { assertSeatTypes } = backendRequire('./services/businessRules')

  const { insertAisleRow, removeGridRow, formulaTypes } = await load()
  for (const mode of ['single', 'double']) {
    for (const cols of [3, 5, 7]) {
      const rows = 3
      const types = formulaTypes(rows, cols, mode)
      const seats = types.map((line) => line.map(() => null))
      for (let at = 0; at <= rows; at++) {
        const ins = insertAisleRow(types, seats, rows, cols, at)
        assert.doesNotThrow(() => assertSeatTypes(ins.types, ins.rows, cols),
          `${mode}/${cols} 列在 ${at} 插入后被后端拒绝了`)
        assert.equal(ins.types.length, ins.rows, 'types 行数与 rows 必须一致（否则读回被裁）')
        const back = removeGridRow(ins.types, ins.seats, ins.rows, cols, at)
        assert.doesNotThrow(() => assertSeatTypes(back.types, back.rows, cols), '删回后同样要合法')
        assert.deepEqual(back.types, types, '删回必须逐格还原，不是「行数对上了」就算')
      }
    }
  }
})

// ---------------- 改设置：手绘行走廊要活下来 ----------------
test('carryAisleRows：列数变了，手绘行走廊仍铺满整行', async () => {
  const { carryAisleRows, formulaTypes, CELL } = await load()
  const prevCols = 5
  const prevTypes = markAisleRow(formulaTypes(3, prevCols, 'single'), 1)
  // 新几何：4 个座位列 → 7 列网格
  const nextBase = formulaTypes(3, 7, 'single')
  const next = carryAisleRows(prevTypes, nextBase)
  assert.deepEqual(next[1], new Array(7).fill(CELL.AISLE), '行走廊要铺满新列数')
  // 其它行保持公式结果（本来就有列走廊，不能整行被牵连）
  assert.deepEqual(next[0], nextBase[0])
  assert.deepEqual(next[2], nextBase[2])
})

test('reshapeGeometry：空位与整行走廊同时活过设置变更', async () => {
  const { reshapeGeometry, formulaTypes, CELL } = await load()
  const prevCols = 5
  const prevTypes = markAisleRow(formulaTypes(3, prevCols, 'single'), 1)
  prevTypes[0][0] = CELL.BLANK // 左上角挖个洞
  const prevSeats = [
    [null, null, 7, null, 8],
    [null, null, null, null, null],
    [9, null, 10, null, 11],
  ]

  const next = reshapeGeometry(prevSeats, prevCols, prevTypes, 3, 4, 'single')
  assert.equal(next.gridCols, 7)
  assert.equal(next.types[0][0], CELL.BLANK, '空位要跟着座位列序号搬过去')
  assert.deepEqual(next.types[1], new Array(7).fill(CELL.AISLE), '整行走廊不能被公式冲掉')
  assert.deepEqual(next.seats[1], new Array(7).fill(null), '走廊行不承载学生')
})

test('remapSeatsToGeometry：数据落到走廊格上必须清空', async () => {
  const { remapSeatsToGeometry, formulaTypes } = await load()
  const cols = 5
  const prevTypes = formulaTypes(2, cols, 'single')
  const seats = [
    [1, null, 2, null, 3],
    [4, null, 5, null, 6],
  ]
  const types = markAisleRow(prevTypes, 1) // 第 1 行整行是走廊
  const out = remapSeatsToGeometry(seats, cols, prevTypes, 2, cols, types)
  assert.deepEqual(out[1], new Array(5).fill(null), '走廊里不能有学生')
  assert.deepEqual(out[0], [1, null, 2, null, 3], '其它行原样')
})

// ---------------- 调用点判据（只测纯函数会假绿）----------------
test('insertAisleRowAt / removeRowAt 真的走几何纯函数并整块保存（调用点判据）', async () => {
  const src = fs.readFileSync(path.join(__dirname,
    '../../student-frontend/src/composables/useSeatGrid.js'), 'utf8')
  // 判据必须切到**函数体内**再匹配：两个函数里都有这三行，全文匹配的话
  // 删掉其中一个函数的 rows 赋值照样能过（实测踩过：假绿）。
  const insertBody = src.slice(src.indexOf('async function insertAisleRowAt'), src.indexOf('async function removeRowAt'))
  const removeBody = src.slice(src.indexOf('async function removeRowAt'), src.indexOf('function snapshotGeometry'))
  const triple = /types\.value = next\.types\s*\n\s*seats\.value = next\.seats\s*\n\s*rows\.value = next\.rows/
  assert.match(insertBody, triple,
    '插入行必须 types/seats/rows 三者同时写（只写 types 会被裁，只写 rows 走廊变座位）')
  assert.match(removeBody, triple, '删除行同样三者同笔')
  assert.match(insertBody, /insertAisleRow\(types\.value, seats\.value, rows\.value, cols\.value, at\)/,
    '要复用它自己的几何纯函数，不能自己拼矩阵')
  assert.match(removeBody, /removeGridRow\(types\.value, seats\.value, rows\.value, cols\.value, at\)/,
    '删除行走廊同理')
  assert.match(insertBody, /await save\(\)/, '行走廊必须走整块 save（单格 PATCH 不写 types/rows）')
  assert.match(removeBody, /await save\(\)/, '删除同理')
  // 行数上限：前端先拦一次，别让用户白等一次 400
  assert.match(src, /rows\.value \+ 1 > SEAT_MAX_ROWS/, '插入前要挡上限')

  // 撤销必须带上行数：后端 grid_snapshot 只回写 JSON 列，不认 rows
  assert.match(src, /oldRows: before\.rows, newRows: rows\.value/,
    '撤销记录不带行数的话，撤掉插入后库里是「types 少一行、rows 还是多的」')
})

test('行标签右键菜单：上下插入 + 删除，不再有「把这一行覆盖成走廊」', async () => {
  const seatSrc = fs.readFileSync(path.join(__dirname, '../../student-frontend/src/views/SeatView.vue'), 'utf8')
  assert.match(seatSrc, /label: '在上方插入走廊'/, '上方插入')
  assert.match(seatSrc, /label: '在下方插入走廊'/, '下方插入')
  assert.match(seatSrc, /label: '删除这条走廊'/, '走廊行要能删掉（行数 -1）')
  assert.doesNotMatch(seatSrc, /设为整行走廊|取消整行走廊/,
    '覆盖式改法必须整体消失：同一排学生被移出座位表是用户没要求的副作用')
})

test('行标签右键是 opt-in：座位表开启、GridView 对未开启的表格不接管', async () => {
  const seatSrc = fs.readFileSync(path.join(__dirname, '../../student-frontend/src/views/SeatView.vue'), 'utf8')
  assert.match(seatSrc, /:rowLabelMenu="true"[\s\S]{0,200}?@row-label-menu="onActiveRowLabelMenu"/,
    '当前座位表要开启行标签右键并处理事件')
  assert.match(seatSrc, /:rowLabelMenu="true"[\s\S]{0,200}?@row-label-menu="onMasterRowLabelMenu"/,
    '座位模板同样要开启')

  const gridSrc = fs.readFileSync(path.join(__dirname,
    '../../student-frontend/src/components/tables/GridView/GridView.vue'), 'utf8')
  assert.match(gridSrc, /onRowLabelContextMenu\(event, rowIdx, row\) \{[\s\S]{0,220}?if \(!ctx\.rowLabelMenu\.value\) return;/,
    '未开启 rowLabelMenu 的表格要直接返回，保留浏览器默认右键菜单')
  assert.match(gridSrc, /emit\('row-label-menu'/, '要真的把事件抛给调用方')
})

// 讲台行没有 _lessonIdx，dataRowIdxOf 会回退成显示下标 —— 右键它会把「设为整行走廊」
// 落到第一排学生身上（显示第 0 行 = 数据第 0 行 = 第一排）。必须早退。
test('行标签右键要跳过装饰行（讲台/分隔/合并表头），但不许拦走廊行', async () => {
  const gridSrc = fs.readFileSync(path.join(__dirname,
    '../../student-frontend/src/components/tables/GridView/GridView.vue'), 'utf8')
  const body = gridSrc.slice(gridSrc.indexOf('onRowLabelContextMenu(event, rowIdx, row) {')).slice(0, 900)
  assert.match(body, /if \(!row \|\| row\._isPodium \|\| row\._isSeparator \|\| row\._mergeCells\) return;[\s\S]{0,400}?emit\('row-label-menu'/,
    '装饰行必须在发事件前 return（顺序反了等于没拦）')
  assert.doesNotMatch(body.split("emit('row-label-menu'")[0], /_isReadonly\) return/,
    '不能拦 _isReadonly：走廊行本身就是 readonly，它恰恰要靠右键取消走廊')
  // 先吞默认菜单再早退：否则讲台行弹浏览器菜单、数据行不弹，同一张表两种行为
  assert.ok(body.indexOf('event.preventDefault()') < body.indexOf('row._isPodium'),
    'preventDefault 要排在装饰行判断之前')
})

// 这条是被真机打脸后补的：`rowLabelMenu` prop 声明了、模板上绑了、方法体读了
// `ctx.rowLabelMenu.value`，**但 ctx 字面量里漏了这条映射** → 右键一按就
// TypeError（undefined.value），控制台报错、界面毫无反应。
// 源码正则判据全部为绿 —— 因为「读了 ctx.X」和「ctx 里有 X」是两件事。
// 所以改成结构性判据：所有 `ctx.X.value` 用到的 X 必须在 ctx 定义里。
test('GridView 里每个 ctx.X.value 的 X 都必须在 ctx 字面量里定义', async () => {
  const raw = fs.readFileSync(path.join(__dirname,
    '../../student-frontend/src/components/tables/GridView/GridView.vue'), 'utf8')
  // 去掉整行注释：注释里出现过「ctx.X.value」这种举例，会被当成真实访问
  const src = raw.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')

  // ctx 先是字面量，随后用 Object.assign(ctx, {...}) 补挂计算属性 —— 两处都算已定义
  const start = src.indexOf('const ctx = {')
  const end = src.indexOf('\n}', start)
  assert.ok(start > 0 && end > start, '必须能定位 ctx 字面量')
  const blocks = [src.slice(start, end)]
  for (let i = src.indexOf('Object.assign(ctx, {'); i > 0; i = src.indexOf('Object.assign(ctx, {', i + 1)) {
    blocks.push(src.slice(i, src.indexOf('\n})', i)))
  }

  const defined = new Set()
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      for (const tok of line.split(',')) {
        const m = tok.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/)
        if (m) defined.add(m[1])
      }
    }
  }

  const used = new Set()
  for (const m of src.matchAll(/\bctx\.([A-Za-z_$][\w$]*)\.value\b/g)) used.add(m[1])

  const missing = [...used].filter((k) => !defined.has(k))
  assert.deepEqual(missing, [],
    `这些 key 被 ctx.X.value 读了但没进 ctx 字面量：${missing.join(', ')}（运行时是 undefined.value，直接抛 TypeError）`)
  assert.ok(defined.has('rowLabelMenu'), 'rowLabelMenu 必须映射进 ctx（右键菜单的开关就靠它）')
})

// ---------------- 行标签：走廊行显示「走廊」 ----------------
// 列走廊的列头是「走廊」，行走廊的行标签也得是「走廊」。
// 写「第3行」会让人把它当一排座位（它不能坐人、不能拖，右键只能删）。
test('buildSeatLikeRows：行走廊行标签写「走廊」，普通行仍是「第N行」且编号跳号不重排', async () => {
  const { buildSeatLikeRows, formulaTypes, insertAisleRow } = await load()
  const cols = 5
  const base = formulaTypes(3, cols, 'single')
  const ins = insertAisleRow(base, base.map(l => l.map(() => null)), 3, cols, 1)
  const rows = buildSeatLikeRows(ins.rows, cols, ins.types, () => ({}))

  // rows[0] 是讲台行，数据行从 rows[1] 开始
  assert.equal(rows[1].label, '第1行')
  assert.equal(rows[2].label, '走廊', '插入的走廊行必须显示「走廊」而不是「第2行」')
  assert.equal(rows[2]._isAisleRow, true)
  // 编号跳号：普通行仍按**数据行号**标，不重新连续编号 ——
  // 右键菜单的「第N行」提示、画笔落点用的都是数据行号，重排就会又错一格
  assert.equal(rows[3].label, '第3行')
  assert.equal(rows[4].label, '第4行')
})

test('buildSeatLikeRows：普通行（含列走廊）不受影响，仍显示「第N行」', async () => {
  const { buildSeatLikeRows, formulaTypes } = await load()
  const cols = 5
  const types = formulaTypes(2, cols, 'single') // 座 走 座 走 座
  const rows = buildSeatLikeRows(2, cols, types, () => ({}))
  assert.equal(rows[1].label, '第1行', '含列走廊的行不是行走廊，标签不变')
  assert.equal(rows[2].label, '第2行')
})

// ---------------- 横走廊合并的调用点判据（只测纯函数会假绿）----------------
// 几何层给出 _aisleColSpan 只是一半：模板不认就是「数据对了、界面还是十个小灰格」。
test('GridView 真的按 _aisleColSpan 渲染 colspan，且横走廊不带 rowspan', () => {
  const src = fs.readFileSync(GRIDVIEW, 'utf8')
  assert.match(src, /:colspan="cell\._aisleColSpan > 0 \? cell\._aisleColSpan : undefined"/,
    '模板必须消费 _aisleColSpan，否则合并只是数据结构里的一个没人读的字段')
  assert.match(src, /:rowspan="cell\._aisleRowSpan > 0 \? cell\._aisleRowSpan : undefined"/,
    'rowspan 必须改成条件绑定（横走廊那格 _aisleRowSpan 是 0）')
  // 分支条件要同时认两种跨度，否则横走廊掉进普通格分支 → 变成一个可点击的灰格
  assert.match(src, /v-if="cell\._isAisle && \(cell\._aisleRowSpan > 0 \|\| cell\._aisleColSpan > 0\)"/)
  // 横走廊跨列，不参与单列让位（登记 ref 会被列拖拽整体平移）
  assert.match(src, /:ref="cell\._aisleColSpan > 0 \? null : \(el => setCellRef\(rowIdx, colIdx, el\)\)"/,
    '横走廊那格不许登记 cellRef，否则列让位会把它当一格平移')
})

// 走廊块内部不能有线：横走廊（colspan 大格）与竖走廊（rowspan 段）相邻处一旦各画边框，
// 相交处就留一条十字线，看上去是两块拼起来的而不是一整块过道。
// 本体不画边框，边界由**邻格**（座位/空位/行标签）与表格外层容器提供。
test('走廊单元格自身不画边框（否则横竖走廊相交处会留一条线）', () => {
  const src = fs.readFileSync(GRIDVIEW, 'utf8')
  const at = src.indexOf('class="grid-aisle-cell')
  assert.ok(at > 0, '走廊格必须带 grid-aisle-cell 语义 class（判据锚点）')
  const line = src.slice(src.lastIndexOf('<td', at), at + 320)
  assert.ok(!/border border-border/.test(line), '走廊格不许有 border 类：交叉处会画出线')
  assert.match(line, /bg-text-muted/, '走廊格底色不能丢（否则走廊变成白块）')
})

test('隐藏格字段名与模板判断必须一字不差（_isAisleHidden）', () => {
  const src = fs.readFileSync(GRIDVIEW, 'utf8')
  assert.match(src, /v-else-if="cell\._isAisleHidden"/,
    '模板判断的字段名一改，隐藏格就渲染成空格子（每行多出几列）')
  // 历史上有过 _aisleHidden（少一个 is）的 typo，谁都不认它：几何层不许再出现
  const geom = fs.readFileSync(path.join(__dirname,
    '../../student-frontend/src/composables/useSeatGrid.geometry.js'), 'utf8')
  assert.ok(!/_aisleHidden/.test(geom.replace(/_isAisleHidden/g, '')),
    '几何层出现了少一个 is 的 _aisleHidden：模板不认这个字段，隐藏格会变成可见空格')
})
