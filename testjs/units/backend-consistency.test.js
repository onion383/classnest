// =========================================================================
// backend-consistency.test.js —— 「跨库多步写」与「信号透传」的行为断言
//
// 覆盖 v4 台账 B02-05 / B02-03 / B02-06（批 15）：
//   · B02-05 PUT /username：用户名存在**两处** —— index.db 的 registry 登记表
//     （跨库的登录真源）与业务库的 users 表。两个 SQLite 文件，事务无法跨库，
//     所以只能**显式补偿**：业务库写失败时把 registry 改回旧名，让「旧名仍可登录」
//     重新成立。原实现只改 registry 就返回 500，users 写失败 → 新旧两个名字都登不进去。
//   · B02-03 改名跳过级联时后端已回 skipped='duplicate-name'，前端**完全没消费**
//     → 用户以为改名全部生效，实际关联表还挂着旧名。
//   · B02-06 album 的 DELETE /:id：两条 DELETE 各自提交 → 中途失败留「照片索引已删、
//     相册还在」的半截状态。
//
// 运行：npm run test:units
// =========================================================================
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')
const express = backendRequire('express')

process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'consistency-unit-' + process.pid)

const { initSchema } = require('../../student-backend/schema/schema')
const { renameUsernameWithCompensation } = require('../../student-backend/services/accountRename')

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

const albumRouter = require('../../student-backend/routes/album')

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

// ---------------------------------------------------------------------------
// B02-05：跨库两写的补偿
// ---------------------------------------------------------------------------

// 一个内存版的 registry（模拟 index.db），行为与 dbManager.registryRename 一致
function makeRegistry(initial) {
  const rows = new Map(initial.map((r) => [r.slug, { ...r }]))
  return {
    rows,
    findBySlug(slug) { return rows.get(slug) || null },
    rename(slug, name) {
      const r = rows.get(slug)
      if (!r) return 0
      r.username = name
      return 1
    },
  }
}

test('accountRename：业务库写失败时必须把 registry 改回旧名（旧名要仍能登录）', () => {
  const registry = makeRegistry([{ slug: 's1', username: 'oldName' }])
  const result = renameUsernameWithCompensation({
    registry,
    slug: 's1',
    newName: 'newName',
    fallbackOldName: 'oldName',
    applyUsersUpdate: () => { throw new Error('磁盘满') },
  })
  assert.equal(result.ok, false, '业务库写失败时不得报成功')
  assert.equal(result.reason, 'users-update-failed', '失败原因应明确（实际 ' + JSON.stringify(result) + '）')
  assert.equal(result.compensated, true, '应当完成补偿（实际 ' + JSON.stringify(result) + '）')
  assert.equal(
    registry.findBySlug('s1').username, 'oldName',
    'registry 必须改回旧名，否则新旧两个名字都登不进去（实际 ' + registry.findBySlug('s1').username + '）'
  )
})

test('accountRename：业务库写失败但补偿期间 registry 被并发改过 → 不得覆盖它', () => {
  const registry = makeRegistry([{ slug: 's1', username: 'oldName' }])
  const result = renameUsernameWithCompensation({
    registry,
    slug: 's1',
    newName: 'newName',
    fallbackOldName: 'oldName',
    applyUsersUpdate: () => {
      // 模拟：写业务库的同时，另一个窗口把 registry 改成了别的名字
      registry.rows.get('s1').username = 'otherName'
      throw new Error('磁盘满')
    },
  })
  assert.equal(result.ok, false, '业务库写失败时不得报成功')
  assert.equal(result.compensated, false, '并发改名时不得执行补偿（实际 ' + JSON.stringify(result) + '）')
  assert.equal(
    registry.findBySlug('s1').username, 'otherName',
    '并发写入的新名必须保留，不能被补偿覆盖成旧名'
  )
})

test('accountRename：业务库 UPDATE 没命中任何行也算失败（不得留下半改状态）', () => {
  const registry = makeRegistry([{ slug: 's1', username: 'oldName' }])
  const result = renameUsernameWithCompensation({
    registry,
    slug: 's1',
    newName: 'newName',
    fallbackOldName: 'oldName',
    // users 行已被并发删掉 → changes = 0
    applyUsersUpdate: () => ({ changes: 0 }),
  })
  assert.equal(result.ok, false, 'changes=0 必须当失败处理（实际 ' + JSON.stringify(result) + '）')
  assert.equal(result.compensated, true, '应当完成补偿')
  assert.equal(registry.findBySlug('s1').username, 'oldName', 'registry 应改回旧名')
})

test('accountRename：两处都写成功时不得做任何补偿', () => {
  const registry = makeRegistry([{ slug: 's1', username: 'oldName' }])
  const result = renameUsernameWithCompensation({
    registry,
    slug: 's1',
    newName: 'newName',
    fallbackOldName: 'oldName',
    applyUsersUpdate: () => ({ changes: 1 }),
  })
  assert.equal(result.ok, true, '两处都写成功应报成功（实际 ' + JSON.stringify(result) + '）')
  assert.equal(registry.findBySlug('s1').username, 'newName', 'registry 应是新名')
  assert.equal(result.compensated, undefined, '成功路径不得有补偿标记')
})

test('accountRename：registry 本身写失败时不得动业务库', () => {
  const registry = makeRegistry([{ slug: 's1', username: 'oldName' }])
  registry.rename = () => 0
  let usersCalled = false
  const result = renameUsernameWithCompensation({
    registry,
    slug: 's1',
    newName: 'newName',
    fallbackOldName: 'oldName',
    applyUsersUpdate: () => { usersCalled = true; return { changes: 1 } },
  })
  assert.equal(result.ok, false, 'registry 写失败应报失败')
  assert.equal(result.reason, 'registry-update-failed', '失败原因应明确')
  assert.equal(usersCalled, false, 'registry 没写成时不得去写业务库')
})

// ---------------------------------------------------------------------------
// B02-03：前端必须消费改名跳过信号
// ---------------------------------------------------------------------------

test('renameOutcome：后端回 skipped=duplicate-name 时必须产出可展示的提示', async () => {
  const { readRenameOutcome } = await import(
    pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/renameOutcome.js')).href
  )
  const out = readRenameOutcome({
    data: { renamed: { changed: false, skipped: 'duplicate-name', counts: { duty: 0, seat: 0 } } },
  })
  assert.equal(out.skipped, true, '必须识别出「级联被跳过」（实际 ' + JSON.stringify(out) + '）')
  assert.ok(out.message && out.message.length > 0, '必须给出可展示的提示文案（实际 ' + JSON.stringify(out) + '）')
  assert.ok(
    out.message.includes('同名') || out.message.includes('关联'),
    '提示应说明「同名 / 关联记录未同步」（实际 ' + out.message + '）'
  )
})

test('renameOutcome：正常改名（无 skipped）不得误报', async () => {
  const { readRenameOutcome } = await import(
    pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/renameOutcome.js')).href
  )
  const out = readRenameOutcome({ data: { renamed: { changed: true, counts: { duty: 3, seat: 1 } } } })
  assert.equal(out.skipped, false, '正常改名不得误报（实际 ' + JSON.stringify(out) + '）')
  assert.equal(out.message, '', '正常改名不得弹提示')
  assert.equal(out.counts.duty, 3, 'counts 仍应透出（供调用方按需使用）')
})

test('renameOutcome：响应里没有 renamed 字段时不得报错（其他表的 PUT 也有这个接口）', async () => {
  const { readRenameOutcome } = await import(
    pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/renameOutcome.js')).href
  )
  const out = readRenameOutcome({ data: { message: '修改成功' } })
  assert.equal(out.skipped, false, '无 renamed 字段时应安静通过')
  assert.equal(out.message, '')
})

test('album 的 PATCH /:id：相册名与路径必须清洗（零宽字符/控制字符不能原样落库）', async () => {
  const conn = freshDb()
  conn.prepare(
    "INSERT INTO albums (id, name, folder_path, kind, sort_order, created_at, updated_at) VALUES (1, '相册甲', 'C:/x', 'folder', 0, '', '')"
  ).run()
  active.conn = conn
  active.state = { writes: 0, failAt: 0 }

  // 名字里塞零宽字符（U+200B）与控制字符，路径里塞首尾空格
  const r = await callApi([['/api/album', albumRouter]], 'PATCH', '/api/album/1', {
    name: '相\u200b册\u0007甲',
    folder_path: '  C:/x  ',
  })
  assert.equal(r.status, 200, '修改应成功（实际 ' + r.status + '：' + r.text.slice(0, 160) + '）')

  const row = conn.prepare('SELECT name, folder_path FROM albums WHERE id = 1').get()
  assert.ok(
    !/[\u200b\u0007]/.test(row.name),
    '零宽字符/控制字符不能落库（实际 ' + JSON.stringify(row.name) + '）'
  )
  assert.equal(row.name, '相册甲', '名字应清洗成正常文本（实际 ' + JSON.stringify(row.name) + '）')
  assert.equal(row.folder_path, 'C:/x', '路径应去掉首尾空格（实际 ' + JSON.stringify(row.folder_path) + '）')
})

test('album 的 PATCH /:id：清洗后为空的名字必须被拒（不能写进空名相册）', async () => {
  const conn = freshDb()
  conn.prepare(
    "INSERT INTO albums (id, name, folder_path, kind, sort_order, created_at, updated_at) VALUES (1, '相册甲', 'C:/x', 'folder', 0, '', '')"
  ).run()
  active.conn = conn
  active.state = { writes: 0, failAt: 0 }

  const r = await callApi([['/api/album', albumRouter]], 'PATCH', '/api/album/1', { name: '   ' })
  assert.equal(r.status, 400, '空名应被拒（实际 ' + r.status + '：' + r.text.slice(0, 160) + '）')
  const row = conn.prepare('SELECT name FROM albums WHERE id = 1').get()
  assert.equal(row.name, '相册甲', '原名不该被覆盖（实际 ' + JSON.stringify(row.name) + '）')
})

// ---------------------------------------------------------------------------
// B02-06：album 删除的两条 DELETE 必须原子
// ---------------------------------------------------------------------------

test('album 的 DELETE /:id：两条 DELETE 中途失败不能留下「照片没了相册还在」的半截状态', async () => {
  const conn = freshDb()
  const ins = conn.prepare(
    "INSERT INTO albums (id, name, folder_path, kind, sort_order, created_at, updated_at) VALUES (?, '相册甲', 'C:/x', 'folder', 0, '', '')"
  )
  ins.run(1)
  const insP = conn.prepare(
    "INSERT INTO album_photos (album_id, file_path, file_name, file_size, mtime, photo_date, exif_date, date_src, thumb_path) VALUES (1, 'C:/x/a.jpg', 'a.jpg', 1, 0, '', '', '', '')"
  )
  insP.run()
  active.conn = conn
  // 第 1 次写 = 删 album_photos；第 2 次写 = 删 albums → 在这里失败
  active.state = { writes: 0, failAt: 2 }

  const r = await callApi([['/api/album', albumRouter]], 'DELETE', '/api/album/1')
  assert.ok(r.status >= 400, '删除中途失败应报错（实际 ' + r.status + '：' + r.text.slice(0, 160) + '）')

  const albums = conn.prepare('SELECT COUNT(*) AS c FROM albums').get().c
  const photos = conn.prepare('SELECT COUNT(*) AS c FROM album_photos').get().c
  assert.equal(albums, 1, '相册必须还在（实际删掉了 ' + albums + ' 个）')
  assert.equal(
    photos, 1,
    '照片索引必须还在（实际 ' + photos + ' 条）—— 删一半会让相册变成空壳且再删也删不掉'
  )
})
