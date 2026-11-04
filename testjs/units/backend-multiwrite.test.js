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
// 手法：把 student-backend/db.js 的 db 导出换成「代理到真内存库 + 第 K 次写抛错」的代理，
//      再在同进程起 Express 挂真实 router，用 fetch 打真实 HTTP。
//      路由、slotStore、SQLite、事务全是真的 —— 只有「写」这一下是注入的故障。
//      （隔离后端是独立子进程，注入不进；所以这层只能在同进程做。）
//
// 运行：npm run test:units
// =========================================================================
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')
const express = backendRequire('express')

// db.js 会连带 require dbManager（需要主密钥），先给环境变量
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'multiwrite-unit-' + process.pid)

const { initSchema } = require('../../student-backend/schema/schema')

// ---------- 日期工具（路由内部各有一份，这里自己算一份用于造数据） ----------
const pad = (n) => String(n).padStart(2, '0')
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function shiftDate(s, n) {
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + n)
  return dateStr(dt)
}

// ---------- 故障注入：代理到真连接，第 K 次「写」抛错 ----------
// 只包 run（写）；get / all 不算写 —— 这样「第 K 次写失败」才对应业务上的第 K 次落库。
function makeFaultyDb(conn, state) {
  return new Proxy({}, {
    get(_target, prop) {
      const value = conn[prop]
      if (typeof value !== 'function') return value
      if (prop === 'prepare') {
        return (sql) => {
          const stmt = conn.prepare(sql)
          return new Proxy(stmt, {
            get(s, p) {
              const v = s[p]
              if (p === 'run') {
                return (...args) => {
                  state.writes += 1
                  if (state.failAt > 0 && state.writes === state.failAt) {
                    throw new Error('注入故障：第 ' + state.writes + ' 次写入失败')
                  }
                  return v.apply(s, args)
                }
              }
              if (typeof v === 'function') return v.bind(s)
              return v
            }
          })
        }
      }
      return value.bind(conn)
    }
  })
}

// ---------- 把 db.js 的 db 导出换成故障代理（必须在 require 路由/slotStore 之前） ----------
const dbPath = require.resolve(path.join(ROOT, 'student-backend/db.js'))
const realDbModule = require(dbPath)
// 活动连接与故障状态做成可变引用：多个用例共用一份已注入的模块，靠切换 active 来换库
const active = { conn: null, state: { writes: 0, failAt: 0 } }
require.cache[dbPath].exports = {
  ...realDbModule,
  db: new Proxy({}, {
    get(_target, prop) {
      if (!active.conn) return undefined
      return makeFaultyDb(active.conn, active.state)[prop]
    }
  }),
}

// 路由必须在上面对 db.js 做替换之后才 require（它们连带 require slotStore → ../db）
const dutyRouter = require('../../student-backend/routes/duty')
const seatsRouter = require('../../student-backend/routes/seats')
const groupManageRouter = require('../../student-backend/routes/groupManage')

// ---------- 起一个同进程的 Express，真打 HTTP ----------
async function callApi(routes, method, urlPath, body) {
  const app = express()
  app.use(express.json())
  for (const [prefix, router] of routes) app.use(prefix, router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const port = server.address().port
  try {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch (_) { /* Express 默认错误页不是 JSON，也是信息 */ }
    return { status: res.status, text, json }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function freshDb() {
  const conn = new Database(':memory:')
  initSchema(conn)
  return conn
}

function insertSemester(conn, start, end) {
  conn.prepare('INSERT INTO semesters (name, start_date, end_date, is_current) VALUES (?,?,?,1)')
    .run('测试学期', start, end)
}

// ---------------------------------------------------------------------------

test('duty 的 snapshot/backfill：写循环中途失败不能留下半截快照', async () => {
  const conn = freshDb()
  const today = dateStr(new Date())
  insertSemester(conn, shiftDate(today, -5), today)
  active.conn = conn
  active.state = { writes: 0, failAt: 3 }

  const r = await callApi(
    [['/api/duty', dutyRouter]],
    'POST', '/api/duty/snapshot/backfill', { mode: 'daily', includeToday: true }
  )
  assert.equal(r.status, 500, '补存中途失败应回 500（实际 ' + r.status + '：' + r.text.slice(0, 200) + '）')

  const left = conn.prepare("SELECT COUNT(*) AS c FROM domain_history WHERE domain = 'duty'").get().c
  assert.equal(left, 0, '补存中途失败后不能留下半截快照（实际留下 ' + left + ' 条）')
})

test('seats 的 snapshot/backfill：写循环中途失败不能留下半截快照（同款拷贝）', async () => {
  const conn = freshDb()
  const today = dateStr(new Date())
  insertSemester(conn, shiftDate(today, -5), today)
  active.conn = conn
  active.state = { writes: 0, failAt: 3 }

  const r = await callApi(
    [['/api/seats', seatsRouter]],
    'POST', '/api/seats/snapshot/backfill', { includeToday: true }
  )
  assert.equal(r.status, 500, '补存中途失败应回 500（实际 ' + r.status + '：' + r.text.slice(0, 200) + '）')

  const left = conn.prepare("SELECT COUNT(*) AS c FROM domain_history WHERE domain = 'seat'").get().c
  assert.equal(left, 0, '补存中途失败后不能留下半截快照（实际留下 ' + left + ' 条）')
})

test('groupManage 的 dimensions/move：排序更新中途失败不能改坏已有排序', async () => {
  const conn = freshDb()
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
  active.conn = conn
  active.state = { writes: 0, failAt: 2 }

  const r = await callApi(
    [['/api/group-manage', groupManageRouter]],
    'POST', '/api/group-manage/dimensions/move', { id: 3, direction: 'up' }
  )
  assert.ok(r.status >= 400, '排序更新中途失败应报错（实际 ' + r.status + '）')

  const rows = conn.prepare('SELECT name, sort_order FROM group_dimensions ORDER BY id').all()
  assert.deepEqual(
    rows.map((x) => x.sort_order), [5, 7, 9],
    '排序更新中途失败后 sort_order 必须原样保留（实际 ' + JSON.stringify(rows) + '）'
  )
})

test('groupManage 的 dimensions/move：排序失败时不能把「新建默认维度」留在库里', async () => {
  const conn = freshDb()
  // 只预置 2 个普通维度，**故意不留内置默认维度**：
  // ensureDefaultDim 会先写一条默认维度（排序之前）。它与排序不在同一事务时，
  // 排序失败后这条默认维度会留在库里 —— 一个「移动排序」的动作凭空多出一个维度。
  const ins = conn.prepare(
    `INSERT INTO group_dimensions (name, leader_title, members_per_group, group_count, is_default, sort_order, male_group_count, female_group_count)
     VALUES (?, '组长', 6, 0, 0, ?, 0, 0)`
  )
  ins.run('维度甲', 1)
  ins.run('维度乙', 2)
  active.conn = conn
  // 第 1 次写 = ensureDefaultDim 建默认维度；第 2 次写 = 排序 UPDATE → 在这里失败
  active.state = { writes: 0, failAt: 2 }

  const r = await callApi(
    [['/api/group-manage', groupManageRouter]],
    'POST', '/api/group-manage/dimensions/move', { id: 1, direction: 'down' }
  )
  assert.ok(r.status >= 400, '排序更新中途失败应报错（实际 ' + r.status + '）')

  const count = conn.prepare('SELECT COUNT(*) AS c FROM group_dimensions').get().c
  assert.equal(count, 2, '排序失败后不能凭空多出「内置默认维度」（实际 ' + count + ' 个维度）')
})
