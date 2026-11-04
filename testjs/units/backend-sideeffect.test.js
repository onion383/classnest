// =========================================================================
// backend-sideeffect.test.js —— 「校验阶段副作用」与「文件+索引非原子」的行为断言
//
// 覆盖 v4 台账 B04-05 / B04-08（批 16）：
//   · B04-08 assertDutyRefs 在**校验阶段**就写库（建临时学生）。而 resolveNames
//     自带事务 → **提前提交**；后续 duty.js 的 setDoc 失败时救不回来 → 名册里
//     凭空多出一个学生，值日表却没存进去（孤儿）。
//   · B04-05 photo_trash 的 undo：先把文件从回收站搬回原位，再 INSERT 索引。
//     两步非原子 → 中间态「文件在、索引不在」，用户看不到这张照片，但文件已归位。
//
// 手法：沿用批 14/15 的脚手架 —— require.cache 换掉 db.js 的 db 导出（代理到真内存库
//      + 第 K 次写抛错），同进程起 Express 挂真实 router，fetch 打真实 HTTP。
//
// 运行：npm run test:units
// =========================================================================
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')
const express = backendRequire('express')

const TMP = path.join(os.tmpdir(), 'sideeffect-unit-' + process.pid)
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = TMP

const { initSchema } = require('../../student-backend/schema/schema')

// ---------- 故障注入：代理到真连接，第 K 次「写」抛错 ----------
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
    },
  })
}

const dbPath = require.resolve(path.join(ROOT, 'student-backend/db.js'))
const realDbModule = require(dbPath)
const active = { conn: null, state: { writes: 0, failAt: 0 } }
require.cache[dbPath].exports = {
  ...realDbModule,
  db: new Proxy({}, {
    get(_target, prop) {
      if (!active.conn) return undefined
      return makeFaultyDb(active.conn, active.state)[prop]
    },
  }),
  getFields: (tableName) => active.conn.prepare(
    `SELECT column_name AS name, data_type AS type FROM table_meta WHERE table_name = ? ORDER BY sort_order`
  ).all(tableName),
  renumber: () => {},
}

const dutyRouter = require('../../student-backend/routes/duty')

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
    try { json = JSON.parse(text) } catch (_) { /* 非 JSON 也是信息 */ }
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

// 配置值日项目（assertDutyRefs 会读 duty_settings 校验项目/星期是否已配置）
function seedDutySettings(conn, items, days) {
  conn.prepare('UPDATE duty_slots SET days = ?, items = ? WHERE kind = ?')
    .run(JSON.stringify(days), JSON.stringify(items), 'settings')
}

// ---------------------------------------------------------------------------
// B04-08：校验阶段的建档副作用
// ---------------------------------------------------------------------------

test('值日保存失败时不能留下孤儿临时学生（校验阶段建档的副作用必须与写库同生共死）', async () => {
  const conn = freshDb()
  seedDutySettings(conn, { 扫地: { 1: 1 } }, { 1: '周一' })
  active.conn = conn
  // 第 1 次写 = 建临时学生（校验阶段）；第 2 次写 = 值日表落库 → 在这里失败
  active.state = { writes: 0, failAt: 2 }

  const r = await callApi(
    [['/api/duty', dutyRouter]],
    'PUT', '/api/duty', {
      mode: 'daily',
      cells: { 扫地: { 1: ['新来的同学'] } },
    }
  )
  assert.ok(r.status >= 400, '值日表写失败应报错（实际 ' + r.status + '：' + r.text.slice(0, 200) + '）')

  const students = conn.prepare("SELECT 姓名 FROM students WHERE 姓名 = '新来的同学'").all()
  assert.equal(
    students.length, 0,
    '值日表没存进去时，名册里不能凭空多出一个「新来的同学」（实际有 ' + students.length + ' 条）'
  )
})

test('值日保存成功时，名册外的姓名必须照常建档（不能为了修副作用把功能改没了）', async () => {
  const conn = freshDb()
  seedDutySettings(conn, { 扫地: { 1: 1 } }, { 1: '周一' })
  active.conn = conn
  active.state = { writes: 0, failAt: 0 }

  const r = await callApi(
    [['/api/duty', dutyRouter]],
    'PUT', '/api/duty', {
      mode: 'daily',
      cells: { 扫地: { 1: ['新来的同学'] } },
    }
  )
  assert.equal(r.status, 200, '保存应成功（实际 ' + r.status + '：' + r.text.slice(0, 200) + '）')

  const students = conn.prepare("SELECT 姓名 FROM students WHERE 姓名 = '新来的同学'").all()
  assert.equal(students.length, 1, '名册外姓名必须建成学生（实际 ' + students.length + ' 条）')
})

// ---------------------------------------------------------------------------
// B04-05：photo_trash 撤销的文件 + 索引原子性
// ---------------------------------------------------------------------------

test('photo_trash 的 undo：文件搬回与索引插入必须同生共死（不能留「文件在、索引不在」）', async () => {
  const conn = freshDb()
  active.conn = conn
  active.state = { writes: 0, failAt: 0 }

  // 直接调执行器：把「文件搬回成功、索引插入失败」这个中间态造出来
  const { executors } = require('../../student-backend/routes/undo/undo.executors')
  const ex = executors.photo_trash
  assert.ok(ex, 'photo_trash 执行器必须存在')

  // 造一个真实的文件：原路径 + 回收站副本
  const photoDir = path.join(TMP, 'photos')
  fs.mkdirSync(photoDir, { recursive: true })
  const originalPath = path.join(photoDir, 'a.jpg')
  fs.writeFileSync(originalPath, 'PHOTO')

  const albumOps = require('../../student-backend/albumOps')
  // ⚠️ trashPathFor 的文件名来自 photo.file_name —— 造数据与调用必须用**同一个** photo 对象，
  //    否则算出两个不同的回收站路径 → restoreToOriginal 找不到源文件直接 return false，
  //    「文件没被搬走」这个断言就假绿了。
  const photo = { id: 9001, album_id: 1, file_path: originalPath, file_name: 'a.jpg' }
  const trashSrc = albumOps.trashPathFor(photo)

  // 把文件放进回收站（模拟已删除状态）
  fs.mkdirSync(path.dirname(trashSrc), { recursive: true })
  fs.copyFileSync(originalPath, trashSrc)
  fs.unlinkSync(originalPath)

  // 让「索引插入」这一步失败：注入第 1 次写失败
  active.state = { writes: 0, failAt: 1 }
  await assert.rejects(
    () => ex.undo({ photo }),
    '索引插入失败时应抛错'
  )

  // 关键断言：文件不应留在原位（否则就是「文件在、索引不在」的中间态）
  assert.equal(
    fs.existsSync(originalPath), false,
    '索引没插进去时，文件必须留在回收站（实际已搬回原位 → 照片在磁盘上但索引里没有，用户看不到也清不掉）'
  )
})
