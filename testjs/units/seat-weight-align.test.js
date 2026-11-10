// =========================================================================
// seat-weight-align.test.js —— 权重表跟随座位表几何
//
// 背景：权重表不存自己的一份几何（读回来也不采信后端副本），types 恒取自座位表。
// 但**权重矩阵是独立存储的**：把一行设成走廊、或在某格挖洞之后，权重矩阵里对应位置
// 的数字还在。界面上走廊/空位格不显示数字，所以平时看不出来；一旦取消走廊，这些旧
// 数字就"冒回来"，看着像刚填的权重。
// 这里锁两件事：① 清洗纯函数的口径；② 两个几何变更入口真的调了它（只测纯函数会假绿）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const GEOM = pathToFileURL(path.join(__dirname, '../../student-frontend/src/composables/useSeatGrid.geometry.js')).href
const SEATVIEW = path.join(__dirname, '../../student-frontend/src/views/SeatView.vue')
const load = () => import(GEOM)

// 单桌 3 个座位列 → 网格列：座 走 座 走 座
const W5 = () => [
  [0, 1, 0, 1, 0],
]

test('clearNonSeatWeights：整行走廊的权重全清 null，其他行不动', async () => {
  const { clearNonSeatWeights, CELL } = await load()
  const types = [
    [CELL.SEAT, CELL.AISLE, CELL.SEAT, CELL.AISLE, CELL.SEAT],
    [CELL.AISLE, CELL.AISLE, CELL.AISLE, CELL.AISLE, CELL.AISLE],
  ]
  const weights = [
    [0.1, null, 0.2, null, 0.3],
    [0.9, 0.9, 0.9, 0.9, 0.9],
  ]
  const out = clearNonSeatWeights(weights, 2, 5, types)
  assert.deepEqual(out[0], [0.1, null, 0.2, null, 0.3], '座位行的权重必须原样保留')
  assert.deepEqual(out[1], [null, null, null, null, null], '走廊行的残留权重必须清掉')
})

test('clearNonSeatWeights：空位格的权重也清 null（取消空位后不会冒回来）', async () => {
  const { clearNonSeatWeights } = await load()
  const types = W5()
  types[0][2] = 2 // 第 3 格挖成空位
  const weights = [[0.1, null, 0.25, null, 0.3]]
  const out = clearNonSeatWeights(weights, 1, 5, types)
  assert.deepEqual(out, [[0.1, null, null, null, 0.3]])
})

test('clearNonSeatWeights：权重 0 是合法值，不能被当成空值清掉', async () => {
  const { clearNonSeatWeights } = await load()
  const out = clearNonSeatWeights([[0, null, 0.5, null, 1]], 1, 5, W5())
  assert.deepEqual(out, [[0, null, 0.5, null, 1]], '0 与 1 都是有效权重（0 = 完全不优先）')
})

test('clearNonSeatWeights：矩阵行数为空或比几何短时补 null，不抛错也不缩行', async () => {
  const { clearNonSeatWeights } = await load()
  const types = [[0, 1, 0, 1, 0], [0, 1, 0, 1, 0]]
  assert.deepEqual(clearNonSeatWeights([], 2, 5, types), [
    [null, null, null, null, null],
    [null, null, null, null, null],
  ], '空矩阵要按几何补齐，否则保存时行列数与 types 对不上')
  assert.deepEqual(clearNonSeatWeights([[0.4, null, 0.6, null, 0.8]], 2, 5, types), [
    [0.4, null, 0.6, null, 0.8],
    [null, null, null, null, null],
  ], '缺的行补空，已有的行保留')
})

// ---------------- 调用点判据 ----------------
// 切片到函数结尾（顶格 `}`），不用固定字符数：函数一长窗口就截断，
// 判据会从「没同步」变成「我以为同步了」，而实际上只是没匹配到。
function fnBody(src, name) {
  const start = src.indexOf(`async function ${name}`)
  assert.ok(start > 0, `${name} 必须存在`)
  // 行尾可能是 CRLF（仓库在 Windows 上编辑过），别用 '\n}\n' 硬匹配
  const m = /\r?\n\}\r?\n/.exec(src.slice(start))
  assert.ok(m, `${name} 的结尾没找到`)
  return src.slice(start, start + m.index + 1)
}

test('插入/删除行走廊保存成功后调用了权重同步（调用点判据）', () => {
  const src = fs.readFileSync(SEATVIEW, 'utf8')
  for (const fn of ['applyAisleInsert', 'applyAisleRemove']) {
    assert.match(fnBody(src, fn), /await syncWeightGeometry\(\)/,
      `${fn} 之后必须洗一遍权重矩阵（否则走廊格留着旧权重，删掉走廊时冒回来）`)
  }
})

// 顺序判据：weightRows 是 rows 的派生，rows 一变 watch 就按网格下标裁补（不认「中间插一行」）。
// 所以「权重矩阵先对齐」必须排在「座位表改 rows」之前，反了就是把下面各行权重整体上移一格。
test('权重插行/删行必须发生在座位表改 rows 之前', () => {
  const src = fs.readFileSync(SEATVIEW, 'utf8')
  const insert = fnBody(src, 'applyAisleInsert')
  const shiftAt = insert.indexOf('shiftWeightRows(at, +1)')
  const gridAt = insert.search(/insertAisleRowAt\(at\b/)
  assert.ok(shiftAt > 0 && gridAt > 0, '两个动作都得在 applyAisleInsert 里')
  assert.ok(shiftAt < gridAt, '先对齐权重矩阵再改 rows，否则 resizeWeights 会按下标裁补')

  const remove = fnBody(src, 'applyAisleRemove')
  const unshiftAt = remove.indexOf('shiftWeightRows(at, -1)')
  const delAt = remove.search(/removeRowAt\(at\b/)
  assert.ok(unshiftAt > 0 && delAt > 0, '两个动作都得在 applyAisleRemove 里')
  assert.ok(unshiftAt < delAt, '删行同理：先删权重那一行，再让座位表少一行')
})

// 两张座位表一起改（几何共享），撤销必须也一步退完：两笔记录要共用同一个批次标识，
// 否则按一次 Ctrl+Z 只撤掉一张（常常还是没在显示的那张），界面看着毫无反应。
test('两张座位表的插入/删除共用同一个撤销批次', () => {
  const src = fs.readFileSync(SEATVIEW, 'utf8')
  for (const fn of ['applyAisleInsert', 'applyAisleRemove']) {
    const body = fnBody(src, fn)
    assert.match(body, /const origin = newUndoBatchId\(\)/, `${fn} 要生成批次标识`)
    assert.equal((body.match(/\{ origin \}/g) || []).length, 2,
      `${fn} 的两笔写入都要带上同一个 origin（少一个就退不干净）`)
    // 带 origin 的记录不逐条刷状态（避免 N 次 /status），由调用方整批登记完刷一次。
    // 漏掉这个 flush，标题栏的撤销按钮会一直停在「不可撤销」。
    assert.match(body, /flushUndoStatus\(\)/, `${fn} 整批登记完要刷一次撤销可用态`)
  }
})

test('空位保存成功后调用了权重同步（调用点判据）', () => {
  const src = fs.readFileSync(SEATVIEW, 'utf8')
  const start = src.indexOf('async function confirmHoleMode')
  const body = src.slice(start, start + 700)
  assert.match(body, /await syncWeightGeometry\(\)/,
    '空位确认后必须洗一遍权重矩阵（空位格里不该留权重）')
})

test('权重未加载成功时不同步：拿空矩阵写回去会清空整张权重表', () => {
  const src = fs.readFileSync(SEATVIEW, 'utf8')
  const start = src.indexOf('async function syncWeightGeometry')
  assert.ok(start > 0, 'syncWeightGeometry 必须存在')
  const body = src.slice(start, start + 600)
  assert.match(body, /if \(!weightLoaded\.value\) return/,
    '守卫丢了的话，权重加载失败时一次设走廊就能把权重表写空')
  assert.match(body, /clearNonSeatWeights\(/, '同步时必须真的洗一遍矩阵，不能只提交 types')
})

// ---------------- 改设置：两张表 + 权重表一起走 ----------------
test('改座位设置必须同时 reshape 两张座位表（不能只动当前显示那张）', () => {
  const src = fs.readFileSync(SEATVIEW, 'utf8')
  const start = src.indexOf('async function applySharedSettings')
  assert.ok(start > 0, 'applySharedSettings 必须存在')
  const body = src.slice(start, start + 900)
  assert.match(body, /activeGrid\.saveSettings\(settings\)/, '当前座位表必须跟着改')
  assert.match(body, /masterGrid\.saveSettings\(settings\)/, '座位模板必须一起改：设置是共享的，只改一张会让几何分叉')
  assert.match(body, /remapSeatsToGeometry\(/, '权重矩阵要按座位列序号重映射，不能只 resize（几何一变就错位）')
  assert.match(body, /await saveWeight\(\)/, '重映射后的权重与新的 types 必须落库')
  assert.match(body, /if \(!weightLoaded\.value\) return/,
    '权重未加载时不能回写：空矩阵会把整张权重表清空')
})

test('权重表的几何取自座位表，不采信后端存的那份 types 副本', () => {
  const src = fs.readFileSync(SEATVIEW, 'utf8')
  // weightTypes 必须由 activeTypes / masterTypes 派生
  const wt = src.match(/const weightTypes = computed\(\(\) => \([^)]*\)\)/)
  assert.ok(wt, 'weightTypes 必须是一个 computed')
  assert.match(wt[0], /activeTypes\.value/, '当前表切换后权重表要跟随当前表的几何')
  assert.match(wt[0], /masterTypes\.value/, '座位模板视图下要跟随模板的几何')
  // loadWeight 只能取 weights，不得把后端的 types 落到本地状态
  const start = src.indexOf('async function loadWeight')
  const body = src.slice(start, start + 700)
  assert.match(body, /res\.data\.weights/, '权重矩阵照常读后端')
  assert.doesNotMatch(body, /(weightTypes|types)\.value\s*=\s*res\.data\.types/,
    '采信后端副本会让「改了座位设置、权重表还按老走廊摆」的错位重现')
})
