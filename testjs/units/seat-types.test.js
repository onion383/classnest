// =========================================================================
// seat-types.test.js —— 座位「格子类型矩阵（types）」的存取契约
//
// 为什么单独一个测试文件：types 是后加的列，它必须穿过三层白名单才可能原样存取 ——
//   ① schema    ：seat_slots 的列 + seat_layout/seat_template/seat_draft 三个视图的 SELECT
//   ② slotStore ：SPEC[*].columns（漏写就是「PUT 不报错、GET 永远读到旧值」的静默丢字段）
//   ③ 路由      ：GET/PUT/apply-master/draft 是否真的读了、真的写了
// 任何一层漏掉，表现都是「保存后走廊没了，且控制台无报错」。所以这里逐层断言，
// 而不是只测一个「PUT 完 GET 回来一样」——那只能证明其中一层是对的。
//
// 手法与 backend-multiwrite.test.js 一致：真内存库 + 真 schema + 真 Express router + 真 HTTP。
// 走 run-units 时每个测试文件是独立子进程，所以替换 db.js 导出不会污染别的文件。
// =========================================================================
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb, Database } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'seat-types' })
const { migrateSeat } = require('../../student-backend/schema/schema.seat')

test.before(() => fx.mount('/api/seats', 'student-backend/routes/seats.js'))
test.after(() => fx.close())

function freshDb() {
  return fx.reset()
}

const ROWS = 3
const COLS = 5
// 第 2 列（索引 1）整列走廊：合法形态
const TYPES_OK = [
  [0, 1, 0, 0, 0],
  [0, 1, 0, 0, 0],
  [0, 1, 0, 0, 0],
]
const SEATS_EMPTY = Array.from({ length: ROWS }, () => Array(COLS).fill(null))

const baseBody = (extra = {}) => ({ mode: 'double', rows: ROWS, cols: COLS, seats: SEATS_EMPTY, ...extra })

// ---------------------------------------------------------------------------

test('types 能原样存取（current）：schema → slotStore → 路由三层都通', async () => {
  freshDb()
  const put = await fx.call('PUT', '/api/seats', baseBody({ types: TYPES_OK }))
  assert.equal(put.status, 200, '保存应成功：' + put.text.slice(0, 200))

  const got = await fx.call('GET', '/api/seats')
  assert.equal(got.status, 200)
  assert.deepEqual(got.json.types, TYPES_OK, 'GET 必须原样返回刚存的矩阵（少一层白名单就会变成 []）')
})

test('types 尺寸必须与 rows×cols 严格一致（不裁剪不补齐）', async () => {
  freshDb()
  // 只给 1 行 × 2 列
  const put = await fx.call('PUT', '/api/seats', baseBody({ types: [[1, 1]] }))
  assert.equal(put.status, 400, '尺寸不符应拒绝，实际 ' + put.status + '：' + put.text.slice(0, 160))
  assert.match(put.json.error, /应与座位(行数|列数)/)
})

test('未传 types 时不清空库里已有的矩阵（老客户端保存不能冲掉走廊）', async () => {
  freshDb()
  await fx.call('PUT', '/api/seats', baseBody({ types: TYPES_OK }))
  // 模拟老前端：不带 types 再保存一次
  const put = await fx.call('PUT', '/api/seats', baseBody())
  assert.equal(put.status, 200, put.text.slice(0, 200))

  const got = await fx.call('GET', '/api/seats')
  assert.deepEqual(got.json.types, TYPES_OK, '未传 types 应保持原值，而不是写成空矩阵')
})

test('types 值域非法时拒绝（3 / 字符串 / 小数）', async () => {
  freshDb()
  for (const bad of [3, -1, 1.5, 'x']) {
    const row = [0, 1, 0, 0, 0]
    row[4] = bad
    const r = await fx.call('PUT', '/api/seats', baseBody({ types: [row, [0, 1, 0, 0, 0], [0, 1, 0, 0, 0]] }))
    assert.equal(r.status, 400, `值 ${JSON.stringify(bad)} 应被拒绝，实际 ${r.status}：${r.text.slice(0, 120)}`)
  }
})

test('走廊只能整行或整列：半截走廊拒绝落库', async () => {
  freshDb()
  // 只有第 0 行第 1 列是走廊 → 该列不整列、该行也不整行
  const half = [
    [0, 1, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ]
  const r = await fx.call('PUT', '/api/seats', baseBody({ types: half }))
  // 注：validateRow 抛错走 PUT 的统一 catch，与既有的 assertSeatRefs 一样是 500（不是 400）。
  // 这里只断言「被拒绝 + 错误信息指向走廊结构」，不绑死状态码 —— 改状态码是另一件事。
  assert.ok(r.status >= 400, '半截走廊必须被拒绝，实际 ' + r.status)
  assert.match(r.json.error, /走廊只能整行或整列/)
})

test('迁移产出的宽网格能原样回写（列上限按「网格列数」算，不是座位列数）', async () => {
  freshDb()
  // 20 个座位列的单人桌，迁移后是 39 列（20 座位 + 19 走廊）。
  // 如果列上限仍按「座位列数 30」卡，迁移后的库每次保存都 400 ——
  // 用户看到的是「座位表存不进去」，而库里明明是合法布局。
  const cols = 39
  const types = [Array.from({ length: cols }, (_, i) => (i % 2 === 1 ? 1 : 0))]
  const put = await fx.call('PUT', '/api/seats', {
    mode: 'single', rows: 1, cols, seats: [Array(cols).fill(null)], types,
  })
  assert.equal(put.status, 200, '宽网格应可保存：' + put.text.slice(0, 200))

  const got = await fx.call('GET', '/api/seats')
  assert.equal(got.json.cols, cols)
  assert.deepEqual(got.json.types, types)
})

test('库里已有 types 时，不带 types 单独改列数必须拒绝（否则多出的列被静默截掉）', async () => {
  freshDb()
  await fx.call('PUT', '/api/seats', baseBody({ types: TYPES_OK })) // 网格 5 列

  // 老客户端 / 尺寸被改小：cols 变 3，但不带 types。
  // 若放行，写进去的是 cols=3 + 5 宽的 types，下次 GET 的 normalizeCellTypes
  // 只取前 3 列 —— 走廊列连同它代表的几何一起消失，且没有任何报错。
  const bad = await fx.call('PUT', '/api/seats', {
    mode: 'double', rows: ROWS, cols: 3, seats: Array.from({ length: ROWS }, () => Array(3).fill(null)),
  })
  assert.equal(bad.status, 400, '应拒绝，实际 ' + bad.status + '：' + bad.text.slice(0, 160))
  assert.match(bad.json.error, /格子类型矩阵不一致/)

  // 带上同尺寸的 types 就能改列数（正常尺寸调整路径）
  const okPut = await fx.call('PUT', '/api/seats', {
    mode: 'double',
    rows: ROWS,
    cols: 3,
    seats: Array.from({ length: ROWS }, () => Array(3).fill(null)),
    types: Array.from({ length: ROWS }, () => [0, 0, 0]),
  })
  assert.equal(okPut.status, 200, okPut.text.slice(0, 160))
  const got = await fx.call('GET', '/api/seats')
  assert.equal(got.json.cols, 3)
  assert.deepEqual(got.json.types, [[0, 0, 0], [0, 0, 0], [0, 0, 0]])
})

test('权重表与座位同形：GET 带回 types，改尺寸必须同时给 types', async () => {
  freshDb()
  // 默认 6 行 × 7 个座位列，矩阵化后是 13 列 —— 权重必须跟着一起展开，
  // 否则「权重[r][c] × 座位[r][c]」会从第一列之后整体错位（座位指数全错、界面看不出来）。
  const before = await fx.call('GET', '/api/seats/weight')
  assert.equal(before.json.cols, 13)
  assert.equal(before.json.types.length, 6)
  assert.ok(before.json.types.every((r) => r.length === 13))

  // 只发 weights、用旧口径的 7 列：必须拒绝，否则权重与几何脱节
  const bad = await fx.call('PUT', '/api/seats/weight', {
    mode: 'single', rows: 6, cols: 7, weights: Array.from({ length: 6 }, () => Array(7).fill(1)),
  })
  assert.equal(bad.status, 400, '应拒绝，实际 ' + bad.status + '：' + bad.text.slice(0, 160))
  assert.match(bad.json.error, /格子类型矩阵不一致/)

  // 带 types 的同尺寸写入正常（走廊列权重留 null）
  const types = [[0, 1, 0], [0, 1, 0]]
  const ok = await fx.call('PUT', '/api/seats/weight', {
    mode: 'single', rows: 2, cols: 3, weights: [[1, null, 2], [3, null, 4]], types,
  })
  assert.equal(ok.status, 200, ok.text.slice(0, 160))
  const got = await fx.call('GET', '/api/seats/weight')
  assert.deepEqual(got.json.types, types)
  assert.deepEqual(got.json.weights, [[1, null, 2], [3, null, 4]])
})

test('整行走廊合法（行走廊是异形教室的刚需）', async () => {
  freshDb()
  const rowAisle = [
    [0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0],
  ]
  const r = await fx.call('PUT', '/api/seats', baseBody({ types: rowAisle }))
  assert.equal(r.status, 200, '整行走廊应被接受：' + r.text.slice(0, 160))
  const got = await fx.call('GET', '/api/seats')
  assert.deepEqual(got.json.types, rowAisle)
})

test('模板（master）同样存取 types，且 apply-master 会把矩阵搬过去', async () => {
  freshDb()
  const putTpl = await fx.call('PUT', '/api/seats/master', baseBody({ types: TYPES_OK }))
  assert.equal(putTpl.status, 200, putTpl.text.slice(0, 200))

  const gotTpl = await fx.call('GET', '/api/seats/master')
  assert.deepEqual(gotTpl.json.types, TYPES_OK, '模板 GET 必须带回矩阵')

  // 当前座位先清空，避免读到上一份
  await fx.call('PUT', '/api/seats', baseBody())
  const apply = await fx.call('POST', '/api/seats/apply-master', {})
  assert.equal(apply.status, 200, apply.text.slice(0, 200))

  const got = await fx.call('GET', '/api/seats')
  assert.deepEqual(got.json.types, TYPES_OK, 'apply-master 必须连矩阵一起抄（只抄 seats 会让走廊变成座位格）')
})

test('草稿（draft）存取 types：恢复草稿后走廊/空位还在', async () => {
  freshDb()
  const seats = [[1, null, 3, 4, 5], [6, null, 8, 9, 10], [11, null, 13, 14, 15]]
  // 学生 id 必须真实存在，否则 validateRow 会拦
  const ins = fx.conn.prepare('INSERT INTO students (id, 姓名) VALUES (?, ?)')
  const ids = [1, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14, 15]
  for (const id of ids) ins.run(id, '学生' + id)

  const put = await fx.call('PUT', '/api/seats/draft', {
    mode: 'double', rows: ROWS, cols: COLS, seats, types: TYPES_OK,
  })
  assert.equal(put.status, 200, put.text.slice(0, 200))

  const got = await fx.call('GET', '/api/seats/draft')
  assert.equal(got.json.exists, true)
  assert.deepEqual(got.json.types, TYPES_OK, '草稿 GET 必须带回矩阵')
})

// ---------------------------------------------------------------------------
// 老库迁移：这是本批最关键的一条 —— 用户的库里 seat_slots 已经存在，
// CREATE TABLE IF NOT EXISTS 不会补列，必须靠 ALTER，否则视图一查就 no such column。
test('老库（无 types 列）能被迁移补列，且原有数据不丢', () => {
  const conn = new Database(':memory:')
  // 还原「改造前」的表结构：没有 types
  conn.exec(`
    CREATE TABLE seat_slots (
      kind TEXT PRIMARY KEY CHECK (kind IN ('current','template','draft','weight')),
      mode TEXT NOT NULL DEFAULT 'single',
      rows INTEGER NOT NULL DEFAULT 6,
      cols INTEGER NOT NULL DEFAULT 7,
      seats TEXT NOT NULL DEFAULT '[]',
      aisle_cols TEXT NOT NULL DEFAULT '[]',
      groups_config TEXT NOT NULL DEFAULT '[]',
      weights TEXT NOT NULL DEFAULT '[]',
      settings TEXT NOT NULL DEFAULT '{}',
      conditions TEXT NOT NULL DEFAULT '[]',
      saved_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO seat_slots (kind, mode, rows, cols, seats) VALUES ('current', 'double', 2, 3, '[[1,2,3],[4,5,6]]');
  `)

  migrateSeat(conn)

  const cols = conn.prepare('PRAGMA table_info(seat_slots)').all().map((c) => c.name)
  assert.ok(cols.includes('types'), '迁移后 seat_slots 必须有 types 列')

  // 视图能查（引用不存在的列会在 SELECT 时报 no such column）
  const rec = conn.prepare('SELECT mode, rows, cols, seats, types FROM seat_layout').get()
  assert.ok(rec, '迁移后 seat_layout 必须可查')
  assert.equal(rec.seats, '[[1,2,3],[4,5,6]]', '原有座位数据不能丢')
  assert.equal(rec.types, '[]', '新列默认空数组（前端按「全是座位」处理）')

  // 幂等：再跑一次不报错、不重复加列
  migrateSeat(conn)
  const again = conn.prepare('PRAGMA table_info(seat_slots)').all().filter((c) => c.name === 'types')
  assert.equal(again.length, 1, '重复迁移不能加出第二列 types')
})

// ---------------------------------------------------------------------------
// 历史快照：types 必须跟着 payload 一起持久化
// 座位指数是「按天快照 × 权重」逐日累加出来的，快照里缺 types 就等于把走廊列
// 当成空座位参与结算 —— 不报错、界面正常、数字永久偏移。所以这条单独守。
test('历史快照带 types：/snapshot/backfill → /history 与 /daily 都能读回几何', async () => {
  const conn = freshDb()
  // backfill 只在学期范围内补，先把学期区间铺开到覆盖今天
  const { localDateStr, shiftDateStr } = require('../../student-backend/utils/date')
  const today = localDateStr(new Date())
  const sem = conn.prepare('SELECT id FROM semesters ORDER BY id DESC LIMIT 1').get()
  const start = shiftDateStr(today, -3)
  if (sem) conn.prepare('UPDATE semesters SET start_date = ?, end_date = ? WHERE id = ?').run(start, today, sem.id)
  else conn.prepare("INSERT INTO semesters (name, start_date, end_date, is_current) VALUES ('t', ?, ?, 1)").run(start, today)

  const put = await fx.call('PUT', '/api/seats', baseBody({ types: TYPES_OK }))
  assert.equal(put.status, 200, put.text.slice(0, 200))

  const bf = await fx.call('POST', '/api/seats/snapshot/backfill', { includeToday: true })
  assert.equal(bf.status, 200, bf.text.slice(0, 200))
  assert.ok(bf.json.inserted > 0, '应当补出至少一天快照')

  const weeks = await fx.call('GET', '/api/seats/history')
  const week = weeks.json[0].week_start
  const snap = await fx.call('GET', `/api/seats/history/${week}`)
  assert.equal(snap.status, 200)
  assert.deepEqual(snap.json.types, TYPES_OK, '单周快照必须带回 types，否则走廊列会显示成空座位')

  const daily = await fx.call('GET', '/api/seats/daily')
  const day = (daily.json || []).find((d) => d.snap_date === today)
  assert.ok(day, '今天的快照应出现在 /daily 里')
  assert.deepEqual(day.types, TYPES_OK, '座位指数结算用的每日快照必须带 types')
})

test('空位格不许放人：有人的格子不能设为空位（防静默丢人）', async () => {
  freshDb()
  // 第 1 行第 5 列挖洞，但同时那个人还留在格子里。
  // 放行的话：界面按空位分支渲染、不显示名字；座位指数按 types 少算；排表把他当未入座重塞。
  const conn = fx.conn
  conn.prepare("INSERT INTO students (position, 学号, 年级, 班级, 姓名, 年龄, 家长联系电话, 备注) VALUES (1,'001','初二','3班','张三',14,'1','')").run()
  const withHole = [
    [0, 1, 0, 0, 2],
    [0, 1, 0, 0, 0],
    [0, 1, 0, 0, 0],
  ]
  // 注意：seats 里的数字一律被当成学生 id，0 也会被当 id=0 校验，所以空位必须写 null
  const occupied = [
    [null, null, null, null, 1],
    [null, null, null, null, null],
    [null, null, null, null, null],
  ]
  const bad = await fx.call('PUT', '/api/seats', baseBody({ seats: occupied, types: withHole }))
  assert.ok(bad.status >= 400, '空位里有学生必须被拒绝，实际 ' + bad.status)
  assert.match(bad.json.error, /空位.*还有学生/)

  // 把学生移走（格子里 null）后就能存，而且空位原样回来
  const empty = occupied.map((r) => [...r])
  empty[0][4] = null
  const ok = await fx.call('PUT', '/api/seats', baseBody({ seats: empty, types: withHole }))
  assert.equal(ok.status, 200, ok.text.slice(0, 200))
  const got = await fx.call('GET', '/api/seats')
  assert.deepEqual(got.json.types, withHole, '空位（types=2）必须原样存取')
})
