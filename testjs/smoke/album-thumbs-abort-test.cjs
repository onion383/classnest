/**
 * album-thumbs-abort-test.cjs —— 「滑走就中断」回归
 *
 * 场景：用户看到一屏图正在生成，马上滑到另一屏。前端会 abort 这批请求，
 * 后端**也必须**跟着停 —— Node 不会因为 HTTP 断开就中断 handler，
 * 不显式检查的话 CPU 照跑完，配额一直占着，新的一屏反而排不进队。
 *
 * 断言：
 *   ① 请求发出后立刻 destroy 连接 → 落盘的缩略图数量**明显少于**请求张数
 *   ② 正常请求（不 destroy）→ 全部生成（说明上面少的那部分确实是「被中断」，不是生成失败）
 *
 * 为了有足够长的生成窗口，用 40 张 4000x3000 的大图（decode 成本高）。
 *
 * 跑法：node testjs/smoke/album-thumbs-abort-test.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { makeTempDir, removeDirWithRetry } = require('./_tmpdir.cjs')
const { parseFrames } = require('./_thumb-frames.cjs')

const ROOT = path.join(__dirname, '..', '..')
const BACKEND = path.join(ROOT, 'student-backend')
const BM = path.join(BACKEND, 'node_modules')

const DATA_DIR = makeTempDir('album-thumbs-abort-')
process.env.DB_MASTER_KEY = 'album-thumbs-abort-smoke-key'
process.env.DATA_DIR = DATA_DIR
process.env.ALBUM_THUMBS_DIR = path.join(DATA_DIR, 'album-thumbs')

const express = require(path.join(BM, 'express'))
const sharp = require(path.join(BM, 'sharp'))
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const albumThumbs = require(path.join(BACKEND, 'albumThumbs'))
const albumRouter = require(path.join(BACKEND, 'routes', 'album'))

const N = 40
const USERNAME = 'thumbs-abort-smoke'

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && detail !== undefined) {
    console.log('    →', typeof detail === 'string' ? detail.slice(0, 400) : JSON.stringify(detail).slice(0, 400))
  }
}

const thumbPathOf = (s, id) => path.join(dbManager.thumbsDir, albumThumbs.safeSlug(s), `${id}.jpg`)
const countOnDisk = (s) => {
  let n = 0
  for (let i = 1; i <= N; i++) if (fs.existsSync(thumbPathOf(s, i))) n++
  return n
}

/** 发批量请求，返回「请求对象」，由调用方决定何时 destroy */
function startBatch(port, ids) {
  const payload = JSON.stringify({ ids })
  const req = http.request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/api/album/photo/thumbs',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  })
  req.on('error', () => { /* destroy 之后必然报错，忽略 */ })
  req.end(payload)
  return req
}

async function main() {
  const srcDir = path.join(DATA_DIR, 'src')
  fs.mkdirSync(srcDir, { recursive: true })

  const { slug } = dbManager.createTeacher(USERNAME, 'not-a-real-hash', 'teacher')
  dbManager.withDb(slug, () => {
    const conn = dbManager.current()
    conn.prepare('INSERT INTO albums (id, name, folder_path, kind) VALUES (1, ?, ?, ?)').run('中断', DATA_DIR, 'folder')
    const ins = conn.prepare('INSERT INTO album_photos (id, album_id, file_path, file_name, file_size) VALUES (?, 1, ?, ?, 0)')
    for (let i = 1; i <= N; i++) ins.run(i, path.join(srcDir, `${i}.jpg`), `${i}.jpg`)
  })

  // 大图：让生成窗口足够长，中断与否才测得出来
  for (let i = 1; i <= N; i++) {
    await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: (5 * i) % 256, g: 90, b: 160 } } })
      .jpeg({ quality: 95 }).toFile(path.join(srcDir, `${i}.jpg`))
  }

  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use('/api/album', (rq, rs, next) => {
    rq.user = { username: USERNAME, role: 'teacher', dbSlug: slug }
    dbManager.withDb(slug, () => next())
  }, albumRouter)
  const server = http.createServer(app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const ids = Array.from({ length: N }, (_, i) => i + 1)

  // ---------- ① 发出后立刻掐断 ----------
  const req = startBatch(port, ids)
  await new Promise((r) => setTimeout(r, 120))   // 让头一两批真的跑起来
  req.destroy()
  // 给后端足够时间把「已经在跑的那批」跑完（并发生成不会再启动新批）
  await new Promise((r) => setTimeout(r, 3000))
  const afterAbort = countOnDisk(slug)
  check(`中断后落盘 ${afterAbort} 张 < 请求的 ${N} 张（剩余不再生成）`, afterAbort < N, { afterAbort, N })

  // ---------- ② 正常请求必须能把剩下的补齐（证明①少的是被中断，不是失败） ----------
  const batch = await new Promise((resolve) => {
    const payload = JSON.stringify({ ids })
    const r = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/album/photo/thumbs',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }))
    })
    r.on('error', (e) => resolve({ status: 0, error: e.message }))
    r.setTimeout(120000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }) })
    r.end(payload)
  })
  const got = parseFrames(batch.buf || Buffer.alloc(0))
  check(`再请求一次 → 200 且补齐 ${N} 张（中断没把索引/任务弄坏）`, batch.status === 200 && got.length === N, {
    status: batch.status,
    got: got.length,
    error: batch.error,
  })
  check('文件全部落盘', countOnDisk(slug) === N, countOnDisk(slug))

  await new Promise((r) => server.close(r))
}

main()
  .then(async () => {
    await removeDirWithRetry(DATA_DIR).catch(() => {})
    console.log(failed ? `\n失败 ${failed} 条` : '\n全部通过')
    process.exit(failed ? 1 : 0)
  })
  .catch(async (err) => {
    console.error('执行异常：', err && err.stack || err)
    await removeDirWithRetry(DATA_DIR).catch(() => {})
    process.exit(1)
  })
