/**
 * album-thumbs-sweep-test.cjs —— 「回收孤儿微缩图」接口级回归
 *
 * 要验证的是「精准」二字：
 *   ① 默认只读：只报数，一个文件都不删
 *   ② apply=true 只删没索引引用的（含删账号残留目录、旧扁平结构），正在用的图不动
 *   ③ 库文件还在但登记丢了 → 跳过，不猜
 *   ④ 索引一行不动，正常图仍能 200 取到
 *   ⑤ 幂等：再扫一次 0 孤儿
 *
 * 做法与 album-thumbs-purge-test.cjs 一致：临时 DATA_DIR + 真实加密库 + 最小 Express。
 * 跑法：node testjs/smoke/album-thumbs-sweep-test.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { makeTempDir, removeDirWithRetry } = require('./_tmpdir.cjs')

const ROOT = path.join(__dirname, '..', '..')
const BACKEND = path.join(ROOT, 'student-backend')
const MODULES = path.join(BACKEND, 'node_modules')

const DATA_DIR = makeTempDir('album-thumbs-sweep-')
process.env.DB_MASTER_KEY = 'album-thumbs-sweep-smoke-key'
process.env.DATA_DIR = DATA_DIR
process.env.ALBUM_THUMBS_DIR = path.join(DATA_DIR, 'album-thumbs')

const express = require(path.join(MODULES, 'express'))
const sharp = require(path.join(MODULES, 'sharp'))
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const albumThumbs = require(path.join(BACKEND, 'albumThumbs'))
const albumRouter = require(path.join(BACKEND, 'routes', 'album'))

const USERNAME = 'thumbs-sweep-smoke'
const { slug } = dbManager.createTeacher(USERNAME, 'not-a-real-hash', 'teacher')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && detail !== undefined) {
    console.log('    →', typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300))
  }
}

function request(port, { method = 'GET', path: reqPath = '/', body = null } = {}) {
  return new Promise((resolve) => {
    const payload = body == null ? null : JSON.stringify(body)
    const headers = { 'Content-Type': 'application/json' }
    if (payload != null) headers['Content-Length'] = Buffer.byteLength(payload)
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
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
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }) })
    req.end(payload)
  })
}

const thumbPathOf = (s, id) => path.join(dbManager.thumbsDir, albumThumbs.safeSlug(s), `${id}.jpg`)

async function main() {
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
      .run('回收测试', DATA_DIR, 'folder')
    const ins = conn.prepare('INSERT INTO album_photos (id, album_id, file_path, file_name, file_size) VALUES (?, 1, ?, ?, ?)')
    ins.run(1, img1, 'red.jpg', fs.statSync(img1).size)
    ins.run(2, img2, 'blue.jpg', fs.statSync(img2).size)
  })

  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use('/api/album', (req, res, next) => {
    req.user = { username: USERNAME, role: 'teacher', dbSlug: slug }
    dbManager.withDb(slug, () => next())
  }, albumRouter)
  const server = http.createServer(app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  try {
    // ---------- 造两张真图（走真实 /thumb 落盘） ----------
    const t1 = await request(port, { path: '/api/album/photo/1/thumb' })
    const t2 = await request(port, { path: '/api/album/photo/2/thumb' })
    check('两张正常缩略图生成成功', t1.status === 200 && t2.status === 200, [t1.status, t2.status])
    const f1 = thumbPathOf(slug, 1)
    const f2 = thumbPathOf(slug, 2)
    check('两张已落盘', fs.existsSync(f1) && fs.existsSync(f2))

    // ---------- 造 4 类文件 ----------
    const orphan = path.join(path.dirname(f1), '3.jpg')           // 库里没有 id=3
    fs.writeFileSync(orphan, Buffer.alloc(1111, 7))
    const temp = path.join(path.dirname(f1), '4.abc123.jpg')      // 刚写的临时文件（太新）
    fs.writeFileSync(temp, Buffer.alloc(222, 8))
    const otherDir = path.join(dbManager.thumbsDir, '@ffffffffffff')
    fs.mkdirSync(otherDir, { recursive: true })
    const other = path.join(otherDir, '1.jpg')                    // 账号和库都没了
    fs.writeFileSync(other, Buffer.alloc(3333, 9))
    const legacy = path.join(dbManager.thumbsDir, '9.jpg')        // 旧扁平结构
    fs.writeFileSync(legacy, Buffer.alloc(444, 6))
    const notes = path.join(path.dirname(f1), 'notes.txt')       // 不是我们的文件
    fs.writeFileSync(notes, 'keep me')
    // 库文件还在、但 registry 里没登记 → 不敢判无主，必须跳过
    const staleDir = path.join(dbManager.thumbsDir, '@stale0000')
    fs.mkdirSync(staleDir, { recursive: true })
    const stale = path.join(staleDir, '1.jpg')
    fs.writeFileSync(stale, Buffer.alloc(555, 5))
    fs.writeFileSync(path.join(DATA_DIR, '@stale0000.db'), 'not-a-real-db')

    const before = dbManager.withDb(slug, () => dbManager.current()
      .prepare('SELECT id, thumb_path, thumb_v FROM album_photos ORDER BY id').all())

    // ---------- ① 只读对账 ----------
    const probe = await request(port, { method: 'POST', path: '/api/album/thumbs/sweep' })
    check('sweep 探测 → 200', probe.status === 200, probe.error || probe.status)
    const d = (probe.json && probe.json.data) || {}
    check('报出 3 张孤儿（3.jpg / 无主账号 / 旧扁平）', d.orphans === 3, d)
    check('**只读探测一个文件都不删**', d.deleted === 0 && fs.existsSync(orphan) && fs.existsSync(other) && fs.existsSync(legacy))
    check('库登记丢了但库文件还在 → 列入 skipped，不猜',
      Array.isArray(d.skipped) && d.skipped.some(s => s.slug === '@stale0000'), d.skipped)
    check('跳过目录的统计为 0 孤儿',
      Array.isArray(d.slugs) && !d.slugs.some(s => s.slug === '@stale0000'), d.slugs)

    // ---------- ② 确认删除 ----------
    const apply = await request(port, { method: 'POST', path: '/api/album/thumbs/sweep', body: { apply: true } })
    check('apply=true → 200', apply.status === 200, apply.error || apply.status)
    const r = (apply.json && apply.json.data) || {}
    check('正好删掉 3 张', r.deleted === 3 && r.failed === 0, r)
    check('3 张孤儿确实不在了', !fs.existsSync(orphan) && !fs.existsSync(other) && !fs.existsSync(legacy))
    check('**正在用的两张缩略图一张没动**', fs.existsSync(f1) && fs.existsSync(f2))
    check('太新的临时文件 / 非 jpg / 不敢判无主的目录都保留',
      fs.existsSync(temp) && fs.existsSync(notes) && fs.existsSync(stale))
    check('slug 子目录本身保留', fs.existsSync(path.dirname(f1)))

    // ---------- ③ 索引与可用性 ----------
    const after = dbManager.withDb(slug, () => dbManager.current()
      .prepare('SELECT id, thumb_path, thumb_v FROM album_photos ORDER BY id').all())
    check('album_photos 一行不动，thumb_path / thumb_v 原样',
      JSON.stringify(after) === JSON.stringify(before), { before, after })
    const again = await request(port, { path: '/api/album/photo/1/thumb' })
    check('正常图仍能 200 取到（没被误删）', again.status === 200, again.status)

    // ---------- ④ 幂等 ----------
    const second = await request(port, { method: 'POST', path: '/api/album/thumbs/sweep' })
    const d2 = (second.json && second.json.data) || {}
    check('再扫一次 0 孤儿', d2.orphans === 0, d2)

    // ---------- ⑤ 源头：删账号不再留下一整个孤儿目录 ----------
    const { slug: slug2 } = dbManager.createTeacher('thumbs-sweep-account-2', 'not-a-real-hash', 'teacher')
    const dir2 = albumThumbs.thumbsDirFor(slug2)
    fs.writeFileSync(path.join(dir2, '1.jpg'), 'orphan-to-be')
    dbManager.deleteTeacher(slug2)
    let gone = false
    for (let i = 0; i < 20 && !gone; i++) {
      await new Promise((r) => setTimeout(r, 50))
      gone = !fs.existsSync(dir2)
    }
    check('删账号会清掉该账号的缩略图目录（源头不再产生孤儿）', gone, dir2)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

main().then(async () => {
  await removeDirWithRetry(DATA_DIR)
  console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过')
  process.exit(failed ? 1 : 0)
}).catch(async (err) => {
  console.error('冒烟异常:', err)
  await removeDirWithRetry(DATA_DIR)
  process.exit(1)
})
