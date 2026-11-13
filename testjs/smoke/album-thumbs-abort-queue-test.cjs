/**
 * album-thumbs-abort-queue-test.cjs —— 「还没开工的那几张，滑走后能不能退出队列」
 *
 * 用户原话：「40 张已经进去的没办法终止，还没进去的队列可以退出吗」。
 *
 * 要区分两段：
 *   ① 已经在 sharp 里解码的（最多 MAX_CONCURRENT_THUMBS=4 张）—— 掐不断，只能等它返回。
 *   ② 抢到并发槽位之前还在排队的 —— 这些**可以**退出，而且必须退出，
 *      否则它们会依次拿到槽位、把 4 次解码白跑一遍。
 *
 * 批量接口一次提交 GEN_BATCH=8 张：4 张立刻开工，4 张在 albumScan 的
 * acquireThumbSlot() 里排队。修复前 genThumb 拿到槽位后不检查取消，
 * 所以那 4 张照跑 —— 一次「滑走」白烧 4 张图的 CPU。
 *
 * 本测试用噪点大图（单张解码 ~80ms）把时间窗拉开，abort 卡在 40ms：
 *   有检查 → 落盘 ≈4 张（只有正在跑的那批）
 *   没检查 → 落盘 ≈8 张（排队那批也跑完了）
 *
 * 跑法：node testjs/smoke/album-thumbs-abort-queue-test.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { makeTempDir, removeDirWithRetry } = require('./_tmpdir.cjs')

const ROOT = path.join(__dirname, '..', '..')
const BACKEND = path.join(ROOT, 'student-backend')
const BM = path.join(BACKEND, 'node_modules')

const DATA_DIR = makeTempDir('album-abort-queue-')
process.env.DB_MASTER_KEY = 'album-abort-queue-smoke-key'
process.env.DATA_DIR = DATA_DIR
process.env.ALBUM_THUMBS_DIR = path.join(DATA_DIR, 'album-thumbs')

const express = require(path.join(BM, 'express'))
const sharp = require(path.join(BM, 'sharp'))
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const albumThumbs = require(path.join(BACKEND, 'albumThumbs'))
const albumRouter = require(path.join(BACKEND, 'routes', 'album'))

const USERNAME = 'abort-queue-smoke'
// 8 = GEN_BATCH，正好一批。想测「批内排队」就不能小于它。
const N = 16

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && detail !== undefined) {
    console.log('    →', typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const thumbPathOf = (s, id) => path.join(dbManager.thumbsDir, albumThumbs.safeSlug(s), `${id}.jpg`)
const countOnDisk = (s) => {
  let n = 0
  for (let i = 1; i <= N; i++) if (fs.existsSync(thumbPathOf(s, i))) n++
  return n
}

function startBatch(port, ids) {
  const payload = JSON.stringify({ ids })
  const req = http.request({
    host: '127.0.0.1', port, method: 'POST', path: '/api/album/photo/thumbs',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  })
  req.on('error', () => { /* destroy 之后必然报错 */ })
  req.end(payload)
  return req
}

async function main() {
  const srcDir = path.join(DATA_DIR, 'src')
  fs.mkdirSync(srcDir, { recursive: true })

  const { slug } = dbManager.createTeacher(USERNAME, 'not-a-real-hash', 'teacher')
  dbManager.withDb(slug, () => {
    const conn = dbManager.current()
    conn.prepare('INSERT INTO albums (id, name, folder_path, kind) VALUES (1, ?, ?, ?)').run('中断队列', DATA_DIR, 'folder')
    const ins = conn.prepare('INSERT INTO album_photos (id, album_id, file_path, file_name, file_size) VALUES (?, 1, ?, ?, 0)')
    for (let i = 1; i <= N; i++) ins.run(i, path.join(srcDir, `${i}.jpg`), `${i}.jpg`)
  })

  // **噪点**不是纯色：纯色图 decode 只要 20ms 上下，一批瞬间跑完，
  // 「正在跑」和「排队中」在时间轴上根本分不开（上一版中断冒烟就被这个坑过）。
  const W = 4000
  const H = 3000
  for (let i = 1; i <= N; i++) {
    const raw = Buffer.alloc(W * H * 3)
    for (let k = 0; k < raw.length; k += 3) {
      const v = (Math.random() * 255) | 0
      raw[k] = v; raw[k + 1] = v; raw[k + 2] = v
    }
    const p = path.join(srcDir, `${i}.jpg`)
    await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 85 }).toFile(p)
    dbManager.withDb(slug, () => {
      dbManager.current().prepare('UPDATE album_photos SET file_size = ? WHERE id = ?').run(fs.statSync(p).size, i)
    })
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

  // ---------- abort 卡在「第一批正在解码」的时刻 ----------
  const ids = Array.from({ length: N }, (_, i) => i + 1)
  const req = startBatch(port, ids)
  await sleep(40)          // 4 张已开工、4 张在排队、第二批还没提交
  req.destroy()
  // 留足时间：正在跑的那批要跑完；排队的那批要么被拦（快），要么白跑一遍（慢）
  await sleep(4000)

  const onDisk = countOnDisk(slug)
  // 上限取 6：正常是 4（正在跑的那批），加两张容差给机器抖动。
  // 修复前是 8（排队那批也跑完了）—— 8 > 6，一测就红。
  check(`中断后只落盘 ${onDisk} 张（≈4，排队中的没开工就被拦下）`, onDisk <= 6, { onDisk, N })
  check('确实不是「一张都没生成」（正在跑的那批该完成）', onDisk >= 2, { onDisk })

  // ---------- 剩下的重发必须能补齐（证明少的是被中断，不是失败） ----------
  const again = await new Promise((resolve) => {
    const payload = JSON.stringify({ ids })
    const r = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/album/photo/thumbs',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }))
    })
    r.on('error', () => resolve({ status: 0, buf: Buffer.alloc(0) }))
    r.setTimeout(60000, () => { r.destroy(); resolve({ status: 0, buf: Buffer.alloc(0) }) })
    r.end(payload)
  })
  check('重发一次 → 200 且一张不少（中断没把索引/队列弄坏）', again.status === 200 && countOnDisk(slug) === N, {
    status: again.status, onDisk: countOnDisk(slug), N,
  })

  await new Promise((r) => server.close(r))
  dbManager.closeAll?.()
  await sleep(200)
  await removeDirWithRetry(DATA_DIR).catch(() => {})

  console.log(failed ? `\n失败 ${failed} 条` : '\n全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('冒烟异常：', e); process.exit(1) })
