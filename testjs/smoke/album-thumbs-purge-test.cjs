/**
 * album-thumbs-purge-test.cjs —— 「清理微缩图」接口级回归
 *
 * 要验证的不是「文件删掉了」这么简单，而是这条链路的三个承诺：
 *   ① 删得干净：当前账号的缩略图 + 其他账号（没登录、库没打开）的缩略图都要删
 *   ② 索引保留：album_photos 的行、thumb_path、thumb_v 一个都不许动
 *   ③ 能重建：清完后请求 /thumb 仍然 200，文件重新出现在磁盘上（走已有兜底路径）
 *
 * 做法与 api-routes-test.cjs 一致：临时 DATA_DIR + 测试主密钥建真实加密库，
 * 把真实 album 路由挂在最小 Express 上，走真实 HTTP + 真实 sharp 生成。
 * 不启动完整后端 —— 那需要 userData、端口与安全通道，结论会被环境噪声污染。
 *
 * 跑法：node testjs/smoke/album-thumbs-purge-test.cjs
 * 退出码：0 = 全部通过；1 = 有断言失败
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { makeTempDir, removeDirWithRetry } = require('./_tmpdir.cjs')

const ROOT = path.join(__dirname, '..', '..')
const BACKEND = path.join(ROOT, 'student-backend')
const BACKEND_MODULES = path.join(BACKEND, 'node_modules')

// 隔离环境：必须在 require dbManager 之前设置（缩略图目录在模块加载时定型）
const DATA_DIR = makeTempDir('album-thumbs-purge-')
process.env.DB_MASTER_KEY = 'album-thumbs-purge-smoke-master-key'
process.env.DATA_DIR = DATA_DIR
process.env.ALBUM_THUMBS_DIR = path.join(DATA_DIR, 'album-thumbs')

const express = require(path.join(BACKEND_MODULES, 'express'))
const sharp = require(path.join(BACKEND_MODULES, 'sharp'))
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const albumThumbs = require(path.join(BACKEND, 'albumThumbs'))
const { THUMB_VERSION } = require(path.join(BACKEND, 'albumScan'))
const albumRouter = require(path.join(BACKEND, 'routes', 'album'))

const USERNAME = 'thumbs-purge-smoke'
const { slug } = dbManager.createTeacher(USERNAME, 'not-a-real-hash', 'teacher')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && detail !== undefined) {
    console.log('    →', typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300))
  }
}

// ---------- HTTP ----------
function request(port, { method = 'GET', path: reqPath = '/' } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        let json = null
        try { json = JSON.parse(buf.toString('utf8')) } catch (_) { /* 二进制体 */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, json })
      })
    })
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }) })
    req.end()
  })
}

const thumbPathOf = (s, id) => path.join(dbManager.thumbsDir, albumThumbs.safeSlug(s), `${id}.jpg`)

async function main() {
  // ---------- 造两张真图 + 索引行 ----------
  const srcDir = path.join(DATA_DIR, 'src')
  fs.mkdirSync(srcDir, { recursive: true })
  const img1 = path.join(srcDir, 'red.jpg')
  const img2 = path.join(srcDir, 'blue.jpg')
  await sharp({ create: { width: 240, height: 180, channels: 3, background: { r: 220, g: 30, b: 30 } } })
    .jpeg({ quality: 80 }).toFile(img1)
  await sharp({ create: { width: 240, height: 180, channels: 3, background: { r: 30, g: 60, b: 220 } } })
    .jpeg({ quality: 80 }).toFile(img2)

  dbManager.withDb(slug, () => {
    const conn = dbManager.current()
    conn.prepare('INSERT INTO albums (id, name, folder_path, kind) VALUES (1, ?, ?, ?)')
      .run('清理测试', DATA_DIR, 'folder')
    const ins = conn.prepare('INSERT INTO album_photos (id, album_id, file_path, file_name, file_size) VALUES (?, 1, ?, ?, ?)')
    ins.run(1, img1, 'red.jpg', fs.statSync(img1).size)
    ins.run(2, img2, 'blue.jpg', fs.statSync(img2).size)
  })

  // 另一个账号的缩略图：不是当前登录库，模拟「库没打开」的那种
  const otherSlug = '@ffffffffffff'
  const otherFile = thumbPathOf(otherSlug, 1)
  fs.mkdirSync(path.dirname(otherFile), { recursive: true })
  fs.writeFileSync(otherFile, Buffer.alloc(1234, 9))

  // ---------- 最小 Express ----------
  const app = express()
  app.use(express.json({ limit: '4mb' }))
  const bind = (req, res, next) => {
    req.user = { username: USERNAME, role: 'teacher', dbSlug: slug }
    dbManager.withDb(slug, () => next())
  }
  app.use('/api/album', bind, albumRouter)
  const server = http.createServer(app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  // ---------- ① 先生成两张缩略图 ----------
  const t1 = await request(port, { path: '/api/album/photo/1/thumb' })
  const t2 = await request(port, { path: '/api/album/photo/2/thumb' })
  check('生成缩略图 1 → 200 且是 JPEG', t1.status === 200 && /image\/jpeg/.test(String(t1.headers['content-type'])), t1.status)
  check('生成缩略图 2 → 200 且是 JPEG', t2.status === 200 && /image\/jpeg/.test(String(t2.headers['content-type'])), t2.status)

  const f1 = thumbPathOf(slug, 1)
  const f2 = thumbPathOf(slug, 2)
  check('两张缩略图文件已落盘', fs.existsSync(f1) && fs.existsSync(f2), { f1: fs.existsSync(f1), f2: fs.existsSync(f2) })

  const before = dbManager.withDb(slug, () => dbManager.current()
    .prepare('SELECT id, thumb_path, thumb_v FROM album_photos ORDER BY id').all())
  check('库里 thumb_path 已回填（拿它作「索引保留」的对照）',
    before.length === 2 && before.every((r) => !!r.thumb_path), before)

  const bytesBefore = (fs.statSync(f1).size + fs.statSync(f2).size + fs.statSync(otherFile).size)

  // ---------- ② 清理 ----------
  const purge = await request(port, { method: 'POST', path: '/api/album/thumbs/purge' })
  check('purge 接口 → 200', purge.status === 200, purge.error || purge.status)
  const d = (purge.json && purge.json.data) || {}
  check('回报删除了 3 个文件（当前账号 2 + 其他账号 1）', d.files === 3, d)
  check('回报释放字节数与磁盘实际占用一致', d.bytes === bytesBefore, { reported: d.bytes, actual: bytesBefore })

  check('当前账号的缩略图文件已删除', !fs.existsSync(f1) && !fs.existsSync(f2))
  check('**其他账号（未登录）的缩略图也删除了**', !fs.existsSync(otherFile), otherFile)
  check('slug 子目录本身保留（下次生成不必再 mkdir）', fs.existsSync(path.dirname(f1)))

  // ③ 索引必须原样保留
  const after = dbManager.withDb(slug, () => dbManager.current()
    .prepare('SELECT id, thumb_path, thumb_v FROM album_photos ORDER BY id').all())
  check('album_photos 的行数没变', after.length === 2, after.length)
  check('thumb_path 字段原样保留（索引不动）',
    JSON.stringify(after.map((r) => r.thumb_path)) === JSON.stringify(before.map((r) => r.thumb_path)), after)
  check('内存缩略图索引已清空（否则进程内会继续吐旧图）', albumThumbs.cacheStats().index_count === 0, albumThumbs.cacheStats())

  // ---------- ④ 再请求 → 自动重建 ----------
  const again = await request(port, { path: '/api/album/photo/1/thumb' })
  check('清理后再取同一张 → 200（走现场重建）', again.status === 200, again.status)
  check('缩略图文件重新出现在磁盘上', fs.existsSync(f1), f1)
  const rebuilt = dbManager.withDb(slug, () => dbManager.current()
    .prepare('SELECT thumb_path, thumb_v FROM album_photos WHERE id = 1').get())
  check('重建后 thumb_v 仍是当前版本（写回没把它弄旧）',
    rebuilt && rebuilt.thumb_v === THUMB_VERSION, rebuilt)

  // ---------- 收尾 ----------
  await new Promise((r) => server.close(r))
}

main()
  .then(async () => {
    // 句柄释放有延迟（Windows），删不掉就留给临时目录，不能反过来影响结论
    await removeDirWithRetry(DATA_DIR).catch(() => {})
    console.log(failed ? `\n失败 ${failed} 条` : '\n全部通过')
    process.exit(failed ? 1 : 0)
  })
  .catch(async (err) => {
    console.error('执行异常：', err && err.stack || err)
    await removeDirWithRetry(DATA_DIR).catch(() => {})
    process.exit(1)
  })
