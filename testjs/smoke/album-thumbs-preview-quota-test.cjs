/**
 * album-thumbs-preview-quota-test.cjs —— 「预览额度」回归
 *
 * 用户原话：「中断是真的会中断后端上一批微缩图吗？能不能中断之后马上释放配额给新任务？
 * 能不能预览配额和生成配额分开，并且预览可以直接插队批量生成？」
 *
 * 修复前的实测（90 张 2400×1800，一屏 40，连续 6 轮「150ms 后滑走」）：
 *   扫描中额度 8 ：单张 200 只有 1/60，59 张 404
 *   空闲额度 48  ：60/60，0 张 404
 * 也就是说「有扫描任务在跑」时，浏览相册 80% 的格子拿不到图 → 前端 2.7 秒重试全落空
 * → 满屏「生成微缩图失败」。
 *
 * 现在要求：
 *   ① 一屏 40 张一次全部拿到（额度按「一屏」设计，不看扫描状态）
 *   ② 连续「滑走」（150ms 后 abort）之后，单张接口仍然立刻可用
 *      —— 断开会把「还没轮到」的额度还回去，新视口不用等上一批跑完
 *   ③ 全程没有一张因为「排队生成中」而 404
 *
 * 跑法：node testjs/smoke/album-thumbs-preview-quota-test.cjs
 * 退出码：0 = 全部通过；1 = 有断言失败
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { makeTempDir, removeDirWithRetry } = require('./_tmpdir.cjs')
const { parseFrames } = require('./_thumb-frames.cjs')

const ROOT = path.join(__dirname, '..', '..')
const BACKEND = path.join(ROOT, 'student-backend')
const BM = path.join(BACKEND, 'node_modules')

// 隔离环境：必须在 require dbManager 之前设置
const DATA_DIR = makeTempDir('album-preview-quota-')
process.env.DB_MASTER_KEY = 'album-preview-quota-smoke-key'
process.env.DATA_DIR = DATA_DIR
process.env.ALBUM_THUMBS_DIR = path.join(DATA_DIR, 'album-thumbs')

const express = require(path.join(BM, 'express'))
const sharp = require(path.join(BM, 'sharp'))
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const albumThumbs = require(path.join(BACKEND, 'albumThumbs'))
const albumRouter = require(path.join(BACKEND, 'routes', 'album'))

const USERNAME = 'preview-quota-smoke'
// 一屏 40 张：真实网格在 4 列 × 10 行左右就是这个量级，必须一次全部出图
const SCREEN = 40
// 总量要够滚好几屏
const TOTAL = 160

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && detail !== undefined) {
    console.log('    →', typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 单张：返回状态码 + 响应体（用来区分「排队生成中」和别的 404）
function get(port, id) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: `/api/album/photo/${id}/thumb`, method: 'GET' }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    r.on('error', () => resolve({ status: 0, body: Buffer.alloc(0) }))
    r.setTimeout(30000, () => { r.destroy(); resolve({ status: 0, body: Buffer.alloc(0) }) })
    r.end()
  })
}

// 批量：abortAfterMs 毫秒后主动 destroy，模拟用户滑走（前端同样调 abort）
function batch(port, ids, abortAfterMs = 0) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ ids })
    const t0 = Date.now()
    const chunks = []
    let done = false
    const finish = (aborted, status) => {
      if (done) return
      done = true
      resolve({ aborted, status, buf: Buffer.concat(chunks), ms: Date.now() - t0 })
    }
    const r = http.request({
      host: '127.0.0.1', port, path: '/api/album/photo/thumbs', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => finish(false, res.statusCode))
    })
    r.on('error', () => finish(true, 0))
    if (abortAfterMs) setTimeout(() => { r.destroy(); finish(true, 0) }, abortAfterMs)
    r.end(payload)
  })
}

async function main() {
  const srcDir = path.join(DATA_DIR, 'src')
  fs.mkdirSync(srcDir, { recursive: true })

  const { slug } = dbManager.createTeacher(USERNAME, 'not-a-real-hash', 'teacher')
  dbManager.withDb(slug, () => {
    const conn = dbManager.current()
    conn.prepare('INSERT INTO albums (id, name, folder_path, kind) VALUES (1, ?, ?, ?)').run('预览额度', DATA_DIR, 'folder')
    const ins = conn.prepare('INSERT INTO album_photos (id, album_id, file_path, file_name, file_size) VALUES (?, 1, ?, ?, 0)')
    for (let i = 1; i <= TOTAL; i++) ins.run(i, path.join(srcDir, `${i}.jpg`), `${i}.jpg`)
  })

  // 真图，必须够大：纯色小图 sharp 几毫秒就完事，abort 根本来不及暴露「还在跑」
  for (let i = 1; i <= TOTAL; i++) {
    const W = 2400
    const H = 1800
    const raw = Buffer.alloc(W * H * 3)
    for (let k = 0; k < raw.length; k += 3) {
      const v = (Math.random() * 255) | 0
      raw[k] = v; raw[k + 1] = v; raw[k + 2] = v
    }
    const p = path.join(srcDir, `${i}.jpg`)
    await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 82 }).toFile(p)
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

  // ---------- ① 一屏 40 张：一次全部拿到 ----------
  // 这是本文件的理由：修复前（扫描中额度 8）这里只有 8 张。
  const firstIds = Array.from({ length: SCREEN }, (_, i) => i + 1)
  const first = await batch(port, firstIds)
  const firstFrames = parseFrames(first.buf)
  check(`一屏 ${SCREEN} 张 → 200`, first.status === 200, first.status)
  check(`一屏 ${SCREEN} 张**一次全部**拿到（额度按一屏设计，不看扫描状态）`,
    firstFrames.length === SCREEN, { got: firstFrames.length, want: SCREEN, ms: first.ms })

  // ---------- ② 断开后额度立刻回到池子里 ----------
  // 判据取「新请求能拿到多少张」，不取延迟（延迟受机器负载影响，不稳）。
  // 旧批 abort 时 grant=40，若不归还，新批 avail 只有 48-40=8 → 只能拿 8 张；
  // 归还「还没轮到」的（started=8，还 32）后 avail=40 → 30 张全拿。
  // 注意必须用**全新 id**：已缓存的走「直接读图」分支，根本不占额度，测不出东西。
  const abortIds = Array.from({ length: SCREEN }, (_, i) => 41 + i)      // 41~80，全新
  const freshProbe = Array.from({ length: 30 }, (_, i) => 81 + i)        // 81~110，全新
  await batch(port, abortIds, 150)                                       // 150ms 后滑走
  await sleep(20)                                                         // 20ms 后才发新请求
  const afterAbort = await batch(port, freshProbe)
  const afterFrames = parseFrames(afterAbort.buf)
  check('断开 20ms 后请求 30 张新图 → 全部拿到（额度已还回池子，没等旧批跑完）',
    afterFrames.length === freshProbe.length,
    { got: afterFrames.length, want: freshProbe.length, ms: afterAbort.ms })

  // ---------- ③ 连续「滑走」：每次 abort 之后单张必须立刻可用 ----------
  // 每轮换一屏没缓存过的照片（31~70、41~80 …），模拟一直往下滚
  let roundBad = 0
  const roundDetail = []
  for (let round = 1; round <= 4; round++) {
    const ids = Array.from({ length: SCREEN }, (_, i) => ((round * 10 + i) % TOTAL) + 1)
    await batch(port, ids, 150) // 150ms 后滑走
    // 20ms 后立刻测 6 张单张：额度已经还回去了，不该排队
    await sleep(20)
    const probeIds = Array.from({ length: 6 }, (_, i) => ((round * 10 + i) % TOTAL) + 1)
    const codes = []
    for (const id of probeIds) codes.push(await get(port, id))
    const ok = codes.filter((c) => c.status === 200).length
    const queued = codes.filter((c) => c.status === 404 && c.body.toString('utf8').includes('排队')).length
    roundDetail.push({ round, ok, queued })
    if (ok !== probeIds.length) roundBad++
  }
  check('连续 4 轮「滑走」后，每轮紧接着的单张请求全部 200',
    roundBad === 0, roundDetail)
  const totalQueued = roundDetail.reduce((s, r) => s + r.queued, 0)
  check('全程没有一张因「排队生成中」被拒', totalQueued === 0, roundDetail)

  // ---------- ③ 中断确实生效：abort 的那批不该被完整做完 ----------
  // 单独清一批没缓存的照片，150ms 就断，然后数磁盘上实际生成了几张
  const freshIds = Array.from({ length: SCREEN }, (_, i) => 121 + i) // 121~160，前面没用过
  const thumbDir = path.join(dbManager.thumbsDir, albumThumbs.safeSlug(slug))
  const before = freshIds.filter((id) => fs.existsSync(path.join(thumbDir, `${id}.jpg`))).length
  await batch(port, freshIds, 150)
  await sleep(600) // 给正在跑的那一批收尾时间
  const gen = freshIds.filter((id) => fs.existsSync(path.join(thumbDir, `${id}.jpg`))).length - before
  check('abort 之后没有把整批 40 张都跑完（中断是真的）', gen < SCREEN, { generated: gen, screen: SCREEN })

  // ---------- 收尾 ----------
  await new Promise((r) => server.close(r))
  dbManager.closeAll?.()
  await sleep(200)
  await removeDirWithRetry(DATA_DIR).catch(() => {})

  console.log(failed ? `\n失败 ${failed} 条` : '\n全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('冒烟异常：', e); process.exit(1) })
