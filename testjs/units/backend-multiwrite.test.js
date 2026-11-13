// =========================================================================
// backend-multiwrite.test.js —— 「多步写缺一致性保障」的行为断言
//
// 覆盖 v4 台账 B02-07 / B02-08（批 14）：
//   · duty 的 POST /snapshot/backfill：逐日写历史快照。写循环没有事务时，
//     中途失败会留下半截快照（前几天已提交、后几天没有）。
//   · groupManage 的 POST /dimensions/move：逐条改 sort_order。没有事务时，
//     中途失败会让排序乱掉；而且「确保内置默认维度存在」这个写发生在排序之前，
//     它与排序不在同一个事务里 → 排序失败时默认维度已经落库。
//
// 手法：用公共夹具（_db-express-fixture.cjs，faults:true）—— db.js 的 db 导出换成
//      「代理到真内存库 + 第 K 次写抛错」的代理，再在同进程起 Express 挂真实 router，
//      用 fetch 打真实 HTTP。路由、slotStore、SQLite、事务全是真的 —— 只有「写」是注入的。
//      （隔离后端是独立子进程，注入不进；所以这层只能在同进程做。）
//
// 运行：npm run test:units
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'multiwrite', faults: true })

test.before(async () => {
  await fx.mount('/api/duty', 'student-backend/routes/duty.js')
  await fx.mount('/api/seats', 'student-backend/routes/seats.js')
  await fx.mount('/api/group-manage', 'student-backend/routes/groupManage.js')
})
test.after(() => fx.close())

// ---------- 日期工具（路由内部各有一份，这里自己算一份用于造数据） ----------
const pad = (n) => String(n).padStart(2, '0')
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function shiftDate(s, n) {
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + n)
  return dateStr(dt)
}

function insertSemester(conn, start, end) {
  conn.prepare('INSERT INTO semesters (name, start_date, end_date, is_current) VALUES (?,?,?,1)')
    .run('测试学期', start, end)
}

// ---------------------------------------------------------------------------

test('duty 的 snapshot/backfill：写循环中途失败不能留下半截快照', async () => {
  const conn = fx.reset()
  const today = dateStr(new Date())
  insertSemester(conn, shiftDate(today, -5), today)
  fx.inject({ failAt: 3 })

  const r = await fx.call('POST', '/api/duty/snapshot/backfill', { mode: 'daily', includeToday: true })
  assert.equal(r.status, 500, '补存中途失败应回 500（实际 ' + r.status + '：' + r.text.slice(0, 200) + '）')

  const left = conn.prepare("SELECT COUNT(*) AS c FROM domain_history WHERE domain = 'duty'").get().c
  assert.equal(left, 0, '补存中途失败后不能留下半截快照（实际留下 ' + left + ' 条）')
})

test('seats 的 snapshot/backfill：写循环中途失败不能留下半截快照（同款拷贝）', async () => {
  const conn = fx.reset()
  const today = dateStr(new Date())
  insertSemester(conn, shiftDate(today, -5), today)
  fx.inject({ failAt: 3 })

  const r = await fx.call('POST', '/api/seats/snapshot/backfill', { includeToday: true })
  assert.equal(r.status, 500, '补存中途失败应回 500（实际 ' + r.status + '：' + r.text.slice(0, 200) + '）')

  const left = conn.prepare("SELECT COUNT(*) AS c FROM domain_history WHERE domain = 'seat'").get().c
  assert.equal(left, 0, '补存中途失败后不能留下半截快照（实际留下 ' + left + ' 条）')
})

test('groupManage 的 dimensions/move：排序更新中途失败不能改坏已有排序', async () => {
  const conn = fx.reset()
  // 预置 3 个维度（第一个是内置默认维度）—— ensureDefaultDim 因此不会写。
  //
  // ⚠️ sort_order 故意用 5 / 7 / 9（不从 1 开始）：move 是「交换相邻两个」，
  // 而交换后第一个维度的目标 sort_order 恒为 1。若原值就是 1，第一次写
  // 「把 sort_order 写成 1」是**无变化**的 —— 失败点落在第二次写时，
  // 已提交的那次什么都没改，于是「部分更新」根本观测不到 → 断言会假绿。
  // 用 5/7/9 时第一次写就有变化，部分更新才看得见。
  const ins = conn.prepare(
    `INSERT INTO group_dimensions (name, leader_title, members_per_group, group_count, is_default, sort_order, male_group_count, female_group_count)
     VALUES (?, '组长', 6, 0, ?, ?, 0, 0)`
  )
  ins.run('默认维度', 1, 5)
  ins.run('维度甲', 0, 7)
  ins.run('维度乙', 0, 9)
  fx.inject({ failAt: 2 })

  const r = await fx.call('POST', '/api/group-manage/dimensions/move', { id: 3, direction: 'up' })
  assert.ok(r.status >= 400, '排序更新中途失败应报错（实际 ' + r.status + '）')

  const rows = conn.prepare('SELECT name, sort_order FROM group_dimensions ORDER BY id').all()
  assert.deepEqual(
    rows.map((x) => x.sort_order), [5, 7, 9],
    '排序更新中途失败后 sort_order 必须原样保留（实际 ' + JSON.stringify(rows) + '）'
  )
})

test('groupManage 的 dimensions/move：排序失败时不能把「新建默认维度」留在库里', async () => {
  const conn = fx.reset()
  // 只预置 2 个普通维度，**故意不留内置默认维度**：
  // ensureDefaultDim 会先写一条默认维度（排序之前）。它与排序不在同一事务时，
  // 排序失败后这条默认维度会留在库里 —— 一个「移动排序」的动作凭空多出一个维度。
  const ins = conn.prepare(
    `INSERT INTO group_dimensions (name, leader_title, members_per_group, group_count, is_default, sort_order, male_group_count, female_group_count)
     VALUES (?, '组长', 6, 0, 0, ?, 0, 0)`
  )
  ins.run('维度甲', 1)
  ins.run('维度乙', 2)
  // 第 1 次写 = ensureDefaultDim 建默认维度；第 2 次写 = 排序 UPDATE → 在这里失败
  fx.inject({ failAt: 2 })

  const r = await fx.call('POST', '/api/group-manage/dimensions/move', { id: 1, direction: 'down' })
  assert.ok(r.status >= 400, '排序更新中途失败应报错（实际 ' + r.status + '）')

  const count = conn.prepare('SELECT COUNT(*) AS c FROM group_dimensions').get().c
  assert.equal(count, 2, '排序失败后不能凭空多出「内置默认维度」（实际 ' + count + ' 个维度）')
})

// ---------------------------------------------------------------------------
// 夹具契约：注入的故障不能漏到下一个用例
// ---------------------------------------------------------------------------

// 这条测的不是业务，是夹具本身：reset() 必须把写入计数与注入规则一起清掉。
// 不清的话，下一个用例「明明没注入」却会在第 N 次写时莫名抛错 —— 排查成本极高
// （症状是「业务代码偶发 500」，而实际来源是上一个用例留下的状态）。
test('夹具契约：reset() 必须清掉上一次注入的故障', () => {
  const { db } = require('../../student-backend/db')
  const bump = (n) => db.prepare('UPDATE semesters SET name = ? WHERE id = 999').run(n)

  fx.reset()
  fx.inject({ failAt: 3 })
  bump('a') // 第 1 次写，未到期
  bump('b') // 第 2 次写，未到期
  fx.reset() // 换库，同时必须把计数清零
  assert.doesNotThrow(
    () => bump('c'),
    'reset() 之后不应再带着上一个用例的故障（第 3 次写被注入的 failAt 命中）'
  )
})
