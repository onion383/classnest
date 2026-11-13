// =========================================================================
// seat-hole-paint.test.js —— 「设置空位」画笔（阶段 B）
//
// 三块判据，缺一块就会假绿：
//   ① 纯函数：toggleHole / usableSeatCount / clearHoles 的规则对不对
//   ② 真实写入口：PUT /api/seats 能存下空位、拒绝「有人的格子挖洞」、
//      拒绝「把座位改少到坐不下」（9.1）；模板表不受人数约束
//   ③ 接线：GridView 真的在 paintMode 下短路编辑/框选，SeatView 真的把
//      paintMode / paint-cell 传到两张表上，confirmHoleMode 真的 save + 登记撤销
//      （只测 ① 的话，组件没接上照样全绿）
//
// 手法与 seat-types.test.js 一致：真内存库 + 真 schema + 真 Express router + 真 HTTP。
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')

const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'seat-hole' })
const { executors } = require('../../student-backend/routes/undo/undo.executors')

const GEOM = pathToFileURL(path.join(ROOT, 'student-frontend/src/composables/useSeatGrid.geometry.js')).href
const geom = () => import(GEOM)

test.before(() => fx.mount('/api/seats', 'student-backend/routes/seats.js'))
test.after(() => fx.close())

function freshDb() {
  const conn = fx.reset()
  return conn
}
function seedStudents(n) {
  const stmt = fx.conn.prepare(
    "INSERT INTO students (position, 学号, 年级, 班级, 姓名, 年龄, 家长联系电话, 备注) VALUES (?,?,?,?,?,?,?,?)"
  )
  for (let i = 1; i <= n; i++) stmt.run(i, String(i).padStart(3, '0'), '初二', '3班', `学生${i}`, 14, '1', '')
}

// ---------------------------------------------------------------------------
// ① 纯函数
// ---------------------------------------------------------------------------
test('toggleHole：座位 ↔ 空位可逆，且不改入参', async () => {
  const { toggleHole, CELL } = await geom()
  const types = [[CELL.SEAT, CELL.AISLE, CELL.SEAT]]
  const seats = [[null, null, null]]

  const on = toggleHole(types, seats, 0, 0)
  assert.equal(on.ok, true)
  assert.equal(on.types[0][0], CELL.BLANK)
  assert.equal(types[0][0], CELL.SEAT, '原矩阵不能被就地改掉（调用方要能回滚）')

  const off = toggleHole(on.types, seats, 0, 0)
  assert.equal(off.types[0][0], CELL.SEAT, '再点一次回到座位')
})

test('toggleHole：有人的格子不许挖洞（9.6）', async () => {
  const { toggleHole, CELL } = await geom()
  const types = [[CELL.SEAT]]
  const res = toggleHole(types, [[12]], 0, 0)
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'occupied')
  assert.equal(res.value, 12, '要把那个学生的 id 带回去，提示里才好说「这一格有张三」')
})

test('toggleHole：走廊格 / 越界坐标都拒绝', async () => {
  const { toggleHole, CELL } = await geom()
  const types = [[CELL.SEAT, CELL.AISLE]]
  assert.equal(toggleHole(types, [[null, null]], 0, 1).reason, 'aisle')
  assert.equal(toggleHole(types, [[null, null]], 0, 9).reason, 'outside')
  assert.equal(toggleHole(types, [[null, null]], 5, 0).reason, 'outside')
  assert.equal(toggleHole(types, [[null, null]], 0, 1.5).reason, 'outside')
})

test('usableSeatCount / clearHoles：只数座位，走廊与空位都不算', async () => {
  const { usableSeatCount, clearHoles, CELL } = await geom()
  const types = [
    [CELL.SEAT, CELL.AISLE, CELL.BLANK, CELL.SEAT],
    [CELL.SEAT, CELL.AISLE, CELL.SEAT, CELL.BLANK],
  ]
  assert.equal(usableSeatCount(types), 4)
  assert.equal(usableSeatCount(null), 0)

  const cleared = clearHoles(types)
  assert.equal(usableSeatCount(cleared), 6, '全清空位后 6 格都是座位')
  assert.equal(cleared[0][1], CELL.AISLE, '走廊必须保留')
  assert.equal(types[0][2], CELL.BLANK, 'clearHoles 不改入参')
})

// ---------------------------------------------------------------------------
// ② 真实写入口
// ---------------------------------------------------------------------------
const ROWS = 2
const COLS = 2
const ALL_SEAT = [[0, 0], [0, 0]]
const ONE_HOLE = [[2, 0], [0, 0]]
const EMPTY = Array.from({ length: ROWS }, () => Array(COLS).fill(null))

test('PUT 能存下空位（types=2），GET 原样回来', async () => {
  freshDb()
  const put = await fx.call('PUT', '/api/seats', { mode: 'single', rows: ROWS, cols: COLS, seats: EMPTY, types: ONE_HOLE })
  assert.equal(put.status, 200, put.text.slice(0, 200))
  const got = await fx.call('GET', '/api/seats')
  assert.deepEqual(got.json.types, ONE_HOLE)
})

test('把座位改少到坐不下时拒绝（9.1），且文案说清差几个', async () => {
  freshDb()
  seedStudents(4) // 4 个学生、4 个座位
  const ok = await fx.call('PUT', '/api/seats', { mode: 'single', rows: ROWS, cols: COLS, seats: EMPTY, types: ALL_SEAT })
  assert.equal(ok.status, 200, ok.text.slice(0, 200))

  // 挖 1 个洞 → 可用 3 个、学生 4 人、比原来更少 → 必须拦
  const bad = await fx.call('PUT', '/api/seats', { mode: 'single', rows: ROWS, cols: COLS, seats: EMPTY, types: ONE_HOLE })
  assert.ok(bad.status >= 400, '应拒绝，实际 ' + bad.status + '：' + bad.text.slice(0, 160))
  assert.match(bad.json.error, /还差 1 个座位/)

  // 学生减到 3 人后，同一个布局（可用 3）就合法了 —— 说明拦的是「这次改少了」，不是「有洞」
  fx.conn.prepare('DELETE FROM students WHERE id = 4').run()
  const again = await fx.call('PUT', '/api/seats', { mode: 'single', rows: ROWS, cols: COLS, seats: EMPTY, types: ONE_HOLE })
  assert.equal(again.status, 200, again.text.slice(0, 200))
})

test('历史库里本来就坐不下时，不拦「没把座位改少」的保存', async () => {
  freshDb()
  // 先按 2 个座位建立布局，随后名册涨到 5 人 —— 历史遗留的「坐不下」
  seedStudents(2)
  await fx.call('PUT', '/api/seats', { mode: 'single', rows: ROWS, cols: COLS, seats: EMPTY, types: ALL_SEAT })
  seedStudents(5)
  fx.conn.prepare('DELETE FROM students WHERE id IN (3,4,5)').run()
  seedStudents(5) // 重新种 5 个（id 复用从 1 开始，覆盖成 5 人）

  // 改一格座位（可用数没变少）：不能被容量守卫卡住，否则用户连挪个人都存不进去
  const put = await fx.call('PUT', '/api/seats', {
    mode: 'single', rows: ROWS, cols: COLS,
    seats: [[null, null], [null, null]], types: ALL_SEAT,
  })
  assert.equal(put.status, 200, put.text.slice(0, 200))
})

test('座位模板不受人数约束（模板是布局样板，不是本班座位）', async () => {
  freshDb()
  seedStudents(4)
  const put = await fx.call('PUT', '/api/seats/master', { mode: 'single', rows: ROWS, cols: COLS, seats: EMPTY, types: ONE_HOLE })
  assert.equal(put.status, 200, put.text.slice(0, 200))
  const got = await fx.call('GET', '/api/seats/master')
  assert.deepEqual(got.json.types, ONE_HOLE)
})

// ---------------------------------------------------------------------------
// ③ 撤销：整块快照必须把几何一起回滚
// ---------------------------------------------------------------------------
test('撤销「设置空位」会把洞一起撤掉（grid_snapshot 带 types）', async () => {
  freshDb()
  const before = { seats: [[null, null], [null, null]], types: ALL_SEAT }
  const after = { seats: [[null, null], [null, null]], types: ONE_HOLE }
  fx.conn.prepare("UPDATE seat_slots SET seats = ?, types = ? WHERE kind = 'current'")
    .run(JSON.stringify(after.seats), JSON.stringify(after.types))

  executors.grid_snapshot.undo({ table: 'seat_layout', oldValue: before })
  const row = fx.conn.prepare("SELECT seats, types FROM seat_slots WHERE kind = 'current'").get()
  assert.deepEqual(JSON.parse(row.types), ALL_SEAT, '只写 seats 的话洞会留下 → 人和洞错位')
  assert.deepEqual(JSON.parse(row.seats), before.seats)

  executors.grid_snapshot.redo({ table: 'seat_layout', newValue: after })
  const row2 = fx.conn.prepare("SELECT types FROM seat_slots WHERE kind = 'current'").get()
  assert.deepEqual(JSON.parse(row2.types), ONE_HOLE, '重做要能把洞再挖回去')
})

test('老格式撤销记录（纯数组 seats）仍然可用 —— 历史记录不必迁移', async () => {
  freshDb()
  fx.conn.prepare("UPDATE seat_slots SET seats = ?, types = ? WHERE kind = 'current'")
    .run(JSON.stringify([[1, null], [null, null]]), JSON.stringify(ALL_SEAT))
  executors.grid_snapshot.undo({ table: 'seat_layout', oldValue: [[null, null], [null, null]] })
  const row = fx.conn.prepare("SELECT seats, types FROM seat_slots WHERE kind = 'current'").get()
  assert.deepEqual(JSON.parse(row.seats), [[null, null], [null, null]])
  assert.deepEqual(JSON.parse(row.types), ALL_SEAT, '老格式不带 types，几何应保持原样不被清空')
})

// ---------------------------------------------------------------------------
// ④ 接线判据（纯函数测试防不住「组件根本没接上」）
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('GridView：paintMode 下短路框选/编辑/拖拽', () => {
  const src = read('student-frontend/src/components/tables/GridView/GridView.vue')
  assert.match(src, /paintMode: \{ type: Boolean, default: false \}/, '必须有 paintMode prop')
  assert.match(src, /paintMode: toRef\(props, 'paintMode'\)/, '必须挂到 ctx（否则 methods 里读不到）')

  // 三个短路点分别覆盖「点一格会同时框选/换位」「双击弹输入框把洞覆盖掉」「拖行搬走数据搬不走洞」
  const mousedown = src.slice(src.indexOf('onCellMouseDown(event, rowIdx, colIdx)'))
  // 中间允许夹注释（行号换算的说明就写在 emit 上面）
  assert.match(mousedown.slice(0, 900), /if \(ctx\.paintMode\.value\) \{[\s\S]{0,400}?emit\('paint-cell'/, '单击必须直接转发 paint-cell')
  const dbl = src.slice(src.indexOf('onCellDoubleClick(event, rowIdx, colIdx)'))
  assert.match(dbl.slice(0, 400), /if \(ctx\.paintMode\.value\) return/, '双击必须不进编辑')
  // 注意锚到方法定义（模板里也有 canDragRow(row) 调用，会先命中）
  const drag = src.slice(src.indexOf('canDragRow(row) {'))
  assert.match(drag.slice(0, 300), /if \(ctx\.paintMode\.value\) return false/, '画笔下行不可拖')
})

test('SeatView：两张座位表都接了 paintMode / paint-cell', () => {
  const src = read('student-frontend/src/views/SeatView.vue')
  assert.match(src, /:paintMode="activeGrid\.holeMode\.value"/)
  assert.match(src, /:paintMode="masterGrid\.holeMode\.value"/)
  assert.match(src, /@paint-cell="onActivePaintCell"/)
  assert.match(src, /@paint-cell="onMasterPaintCell"/)
})

test('useSeatGrid.confirmHoleMode：改成空位必须 save + 登记撤销（含 types）', () => {
  const src = read('student-frontend/src/composables/useSeatGrid.js')
  const start = src.indexOf('async function confirmHoleMode')
  assert.ok(start > 0, 'useSeatGrid.js 里应有 confirmHoleMode')
  const end = src.indexOf('\n  }', start)
  const body = src.slice(start, end > start ? end : undefined)
  assert.match(body, /await save\(\)/, '必须整块保存（单格 PATCH 不写 types）')
  assert.match(body, /recordGridSnapshotUndo\(/, '必须登记撤销')
  assert.match(body, /types: before\.types/, '撤销快照必须带 types，否则撤销后洞还在')
})

test('行列交换必须把几何一起搬（否则洞留在原地、人落到洞上）', () => {
  const src = read('student-frontend/src/composables/useSeatGrid.js')
  for (const name of ['onSwapRows', 'onSwapColumns']) {
    const start = src.indexOf(`async function ${name}`)
    assert.ok(start > 0, `应有 ${name}`)
    const body = src.slice(start, src.indexOf('\n  }', start))
    assert.match(body, /types\.value = /, `${name} 必须同步搬 types`)
    assert.match(body, /recordGridSnapshotUndo\([\s\S]*types: prevTypes/, `${name} 的撤销快照必须带 types`)
  }
})

test('笔画的洞必须跟着「设置空位」一起落库（confirm 走整块 save 而不是单格 PATCH）', () => {
  const src = read('student-frontend/src/composables/useSeatGrid.js')
  const start = src.indexOf('async function confirmHoleMode')
  const body = src.slice(start, src.indexOf('\n  }', start))
  assert.ok(!/saveSingleCell/.test(body), '单格 PATCH 只写 seats，洞会被丢掉')
})

// ---- 进入画笔模式不能改变表格几何（列宽/行高）----
// 表格是 auto 布局：任何一格的内容变宽都会撑宽整列。所以「画笔模式」这种纯状态切换
// 只能改颜色和光标，不能增减 DOM 占位、不能给空位格加有宽度的文字。
test('画笔模式不能摘掉列拖拽手柄（摘了列头变窄，整张表列宽重排）', () => {
  const src = read('student-frontend/src/components/tables/GridView/GridView.vue')
  const start = src.indexOf('<span', src.indexOf('grid-col-head'))
  const seg = src.slice(start, start + 700)
  assert.ok(seg.includes('drag-handle'), '列头手柄必须存在')
  assert.doesNotMatch(seg, /v-if=["']!paintMode["']/,
    '手柄不能用 v-if 摘掉：它占约 18px，一摘所有列头变窄 → 进画笔等于换一张表')
  assert.match(seg, /paintMode\s*\?\s*'invisible'/, '画笔模式下只能 invisible（保留宽度）')
})

test('空位标记必须是绝对定位（否则「空位」两字会把那一列顶宽）', () => {
  const src = read('student-frontend/src/components/tables/GridView/GridView.vue')
  const start = src.indexOf('.cell-hole-mark')
  assert.ok(start > 0, '应有 .cell-hole-mark 样式')
  const body = src.slice(start, src.indexOf('}', start))
  assert.match(body, /position:\s*absolute/, '绝对定位：装饰文字不能参与布局')
  assert.match(body, /inset:\s*0/, '相对 td（td 已是 relative）铺满，用于居中')
})

test('空位格要自己撑高度（整行都是空位时行高不能塌）', () => {
  const src = read('student-frontend/src/components/tables/GridView/GridView.vue')
  assert.match(src, /\.cell-hole::after\s*\{[^}]*height:/,
    '空位格没有文字内容，不撑一下高度会让整行矮一截')
})

// ---- 显示行下标 vs 数据行下标（点一格，洞画到下面一格的根因）----
// 座位表的 rows[0] 是「讲台」装饰行，v-for 拿到的显示下标比数据下标大 1。
// 改 types/seats 的地方必须用数据下标（行构造时写在 _lessonIdx 上）。
test('buildSeatLikeRows：数据行带 _lessonIdx（讲台行没有），且等于座位行号', async () => {
  const { buildSeatLikeRows, formulaTypes } = await geom()
  const cols = 5
  const types = formulaTypes(3, cols, 'single')
  const rows = buildSeatLikeRows(3, cols, types, () => ({}))
  assert.equal(rows.length, 4, '1 行讲台 + 3 行座位')
  assert.equal(rows[0]._isPodium, true, '第 0 行是讲台')
  assert.equal(rows[0]._lessonIdx, undefined, '讲台不是数据行，不能有 _lessonIdx')
  for (let r = 0; r < 3; r++) {
    assert.equal(rows[r + 1]._lessonIdx, r, `显示第 ${r + 1} 行对应数据第 ${r} 行`)
  }
})

test('GridvView 画笔/行菜单必须发数据行下标（否则洞和走廊都错一格）', () => {
  const src = read('student-frontend/src/components/tables/GridView/GridView.vue')
  assert.match(src, /function dataRowIdxOf\(row, displayIdx\)/, '必须有显示行→数据行换算')
  assert.match(src, /row\._lessonIdx != null \? row\._lessonIdx : displayIdx/,
    '换算必须取 _lessonIdx，不能直接返回显示下标')
  assert.match(src, /emit\('paint-cell', \{ rowIdx, dataRowIdx: dataRowIdxOf\(row, rowIdx\)/,
    'paint-cell 必须带 dataRowIdx')
  assert.match(src, /emit\('row-label-menu', \{ rowIdx, dataRowIdx: dataRowIdxOf\(row, rowIdx\)/,
    'row-label-menu 必须带 dataRowIdx')
})

test('SeatView 改 types 一律用 dataRowIdx（画笔与整行走廊）', () => {
  const src = read('student-frontend/src/views/SeatView.vue')
  assert.match(src, /grid\.toggleHoleAt\(dataRowIdx \?\? rowIdx, colIdx\)/,
    '画笔不能用显示行号，否则点第 1 行画到第 2 行')
  assert.match(src, /rowMenuRowIdx\.value = payload\.dataRowIdx \?\? payload\.rowIdx/,
    '整行走廊同理')
})

// ---- 空位格不可写入 ----
// 空位不是座位：seats 里是 null、types 里是 HOLE。往它写入只会造出
// 「seats 有名字 / types 还是洞」的错位状态 —— 界面上看不出来（格子里仍写着「空位」），
// 但排表按洞跳过、导出按洞输出，这个学生就这么静默丢了。
test('GridView 双击空位格不进入编辑', () => {
  const src = read('student-frontend/src/components/tables/GridView/GridView.vue')
  assert.match(src, /function isHoleCell\(row, colIdx\) \{[\s\S]{0,220}?cell\._blank/,
    'isHoleCell 必须只看 _blank（空位标记），别拿 seats 为空当条件（同桌空座也是 null）')
  const body = src.slice(src.indexOf('onCellDoubleClick(event, rowIdx, colIdx)')).slice(0, 1200)
  assert.match(body, /if \(isHoleCell\(row, colIdx\)\) return/,
    '双击空位必须直接 return，否则进编辑框、提交时把名字写进 seats')
  assert.ok(body.indexOf('isHoleCell(row, colIdx)') < body.indexOf('editingCell.value = {'),
    '拦截必须排在设置 editingCell 之前 —— 写在后面等于没拦')
})

test('GridView 不让长按换位写空位格（拖动源与落点都要拦）', () => {
  const src = read('student-frontend/src/components/tables/GridView/GridView.vue')
  const downBody = src.slice(src.indexOf('onCellMouseDown(event, rowIdx, colIdx)')).slice(0, 1600)
  assert.ok(downBody.indexOf('if (ctx.paintMode.value)') < downBody.indexOf('if (isHoleCell(row, colIdx)) return'),
    '画笔判断要排在前面：画笔模式下点空位是合法操作（第二下取消这个洞）')
  assert.match(downBody, /if \(isHoleCell\(row, colIdx\)\) return/,
    '空位格不能当拖动源（否则会把洞跟别的格对调）')
  const enterBody = src.slice(src.indexOf('onCellMouseEnter(rowIdx, colIdx) {')).slice(0, 800)
  assert.match(enterBody, /if \(isHoleCell\(row, colIdx\)\) \{ ctx\.dragTarget\.value = null; return; \}/,
    '空位格不能当落点：松手会 swapCells，学生直接住进洞里')
})

test('空位格光标不是 pointer（看着能点、点了没反应）', () => {
  const src = read('student-frontend/src/components/tables/GridView/GridView.vue')
  assert.match(src, /paintMode \? 'cursor-crosshair' : cell\._blank \? 'cursor-not-allowed' : \(row\._isReadonly \? '' : 'cursor-pointer'\)/,
    '三者必须互斥：同格同时挂两个 cursor-* 时生效顺序取决于 CSS 生成顺序')
})
