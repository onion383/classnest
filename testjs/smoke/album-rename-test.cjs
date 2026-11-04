/**
 * 相册重命名冒烟：PATCH /api/album/:id
 *
 * 为什么单独测：v5 给 PATCH 加了 cleanText 清洗，顺手把「路径非空」写成了无条件校验，
 * 但虚拟相册的 folder_path 按设计就是空串（创建/合并时写 ''）——
 * 结果虚拟相册只要重命名就 100% 返 400（审查 v5 · V5-008）。
 *
 * 正反都要覆盖：
 *   正常：虚拟相册只改名 → 200；虚拟相册显式传空路径 → 200
 *   正常：文件夹相册只改名 → 200 且路径不被清空；显式给合法路径 → 200
 *   异常：文件夹相册路径清洗后为空 → 400；名称为空 → 400；不存在的 id → 404
 *
 * 跑法：node testjs/smoke/album-rename-test.cjs
 */
const http = require('node:http')
const { makeTempDir, removeDirWithRetry } = require('./_tmpdir.cjs')
const path = require('node:path')

const BACKEND = path.join(__dirname, '..', '..', 'student-backend')
const BACKEND_MODULES = path.join(BACKEND, 'node_modules')

// 隔离环境：必须早于 require dbManager（它在加载时校验主密钥）
const DATA_DIR = makeTempDir('banji-album-rename-')
process.env.DB_MASTER_KEY = 'album-rename-smoke-key'
process.env.DATA_DIR = DATA_DIR
process.env.ALBUM_THUMBS_DIR = path.join(DATA_DIR, 'album-thumbs')

const express = require(path.join(BACKEND_MODULES, 'express'))
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const albumRouter = require(path.join(BACKEND, 'routes', 'album'))

const USERNAME = 'album-rename-smoke'
const { slug } = dbManager.createTeacher(USERNAME, 'not-a-real-hash', 'teacher')

let server = null
async function cleanup() {
  if (server) {
    await new Promise((r) => {
      const t = setTimeout(r, 2000)
      try { server.closeAllConnections?.() } catch (_) { /* 老版本无此方法 */ }
      server.close(() => { clearTimeout(t); r() })
    })
    server = null
  }
  try { dbManager.evictConn(slug) } catch (_) { /* best-effort */ }
  await removeDirWithRetry(DATA_DIR)
}

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && detail !== undefined) {
    console.log('    →', typeof detail === 'string' ? detail.slice(0, 200) : JSON.stringify(detail).slice(0, 200))
  }
}

function request(port, { method = 'GET', path: reqPath = '/', body = null } = {}) {
  return new Promise((resolve) => {
    const payload = body === null ? null : JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1', port, method, path: reqPath,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = raw ? JSON.parse(raw) : null } catch (_) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, json, raw })
      })
    })
    req.on('error', (e) => resolve({ status: 0, error: e.message, json: null }))
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, error: 'timeout', json: null }) })
    if (payload) req.write(payload)
    req.end()
  })
}

;(async () => {
  // 1 = 虚拟相册（folder_path=''）；2 = 文件夹相册（folder_path 指向存在的目录）
  dbManager.withDb(slug, () => {
    const conn = dbManager.current()
    conn.prepare('INSERT INTO albums (id, name, folder_path, kind, sort_order) VALUES (?, ?, ?, ?, ?)')
      .run(1, '虚拟相册', '', 'virtual', 1)
    conn.prepare('INSERT INTO albums (id, name, folder_path, kind, sort_order) VALUES (?, ?, ?, ?, ?)')
      .run(2, '文件夹相册', DATA_DIR, 'folder', 2)
  })

  const app = express()
  app.use(express.json({ limit: '4mb' }))
  const bind = (req, res, next) => {
    req.user = { username: USERNAME, role: 'teacher', dbSlug: slug }
    dbManager.withDb(slug, () => next())
  }
  app.use('/api/album', bind, albumRouter)

  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const port = server.address().port
  const rowOf = (id) => dbManager.withDb(slug, () =>
    dbManager.current().prepare('SELECT name, folder_path, kind FROM albums WHERE id = ?').get(id))

  try {
    // ---------- 正常：虚拟相册只改名 ----------
    const r1 = await request(port, { method: 'PATCH', path: '/api/album/1', body: { name: '虚拟相册-新名' } })
    check('虚拟相册只改名 → 200', r1.status === 200, `status=${r1.status} body=${r1.raw}`)
    check('虚拟相册名称已更新', rowOf(1).name === '虚拟相册-新名')
    check('虚拟相册 folder_path 仍为空串（未被误写成 undefined/null）', rowOf(1).folder_path === '', rowOf(1).folder_path)

    // ---------- 正常：虚拟相册显式传空路径 ----------
    const r2 = await request(port, { method: 'PATCH', path: '/api/album/1', body: { name: '虚拟相册-再改', folder_path: '' } })
    check('虚拟相册显式传空路径 → 200（不再误判 400）', r2.status === 200, `status=${r2.status} body=${r2.raw}`)

    // ---------- 正常：文件夹相册只改名，路径必须保留 ----------
    const r3 = await request(port, { method: 'PATCH', path: '/api/album/2', body: { name: '文件夹相册-新名' } })
    check('文件夹相册只改名 → 200', r3.status === 200, `status=${r3.status} body=${r3.raw}`)
    check('文件夹相册路径不被清空', rowOf(2).folder_path === DATA_DIR, rowOf(2).folder_path)

    // ---------- 正常：文件夹相册显式给合法路径 ----------
    const r4 = await request(port, { method: 'PATCH', path: '/api/album/2', body: { folder_path: DATA_DIR } })
    check('文件夹相册显式给合法路径 → 200', r4.status === 200, `status=${r4.status} body=${r4.raw}`)

    // ---------- 异常：文件夹相册路径清洗后为空 ----------
    const r5 = await request(port, { method: 'PATCH', path: '/api/album/2', body: { folder_path: '   ' } })
    check('文件夹相册路径为空白 → 400', r5.status === 400, `status=${r5.status}`)
    check('400 后路径保持不变', rowOf(2).folder_path === DATA_DIR, rowOf(2).folder_path)

    // ---------- 异常：名称为空 ----------
    const r6 = await request(port, { method: 'PATCH', path: '/api/album/1', body: { name: '   ' } })
    check('虚拟相册名称空白 → 400（名称校验没被削弱）', r6.status === 400, `status=${r6.status}`)

    // ---------- 异常：不存在的 id ----------
    const r7 = await request(port, { method: 'PATCH', path: '/api/album/99', body: { name: 'x' } })
    check('不存在的相册 → 404', r7.status === 404, `status=${r7.status}`)
  } finally {
    await cleanup()
  }

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
})().catch(async (e) => {
  console.error('冒烟异常：', e)
  await cleanup()
  process.exit(2)
})
