/**
 * album-thumbs-rebuild-batch-test.cjs —— 「清理微缩图后，一屏图能不能立刻长回来」回归
 *
 * 为什么单独一条：album-thumbs-purge-test.cjs 只造 2 张，2 张永远在配额闸之内，
 * 所以它测不出真正的坑。真实场景是「用户滚到一屏 12~40 张」——
 * 清理之后这 12 张全都没有缓存，会一次性撞上后端的现场生成配额闸。
 *
 * 修复前的行为（实测）：
 *   批量请求 12 张 → X-Thumb-Ids 为空（整批被拒，全部转交子进程）
 *   → 前端逐张回落单张接口 → 12 个全部 404「排队生成中」
 *   → 前端把 <img> 换成占位图，且不会重试 → 整屏永久空白
 *
 * 现在要求：
 *   ① 批量请求 12 张，**当场**拿回 12 张（没有扫描任务在跑时不该自己限自己）
 *   ② 逐张回落接口同样全部 200
 *   ③ 12 个缩略图文件全部重新落盘
 *
 * 跑法：node testjs/smoke/album-thumbs-rebuild-batch-test.cjs
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
const DATA_DIR = makeTempDir('album-thumbs-batch-')
process.env.DB_MASTER_KEY = 'album-thumbs-batch-smoke-key'
process.env.DATA_DIR = DATA_DIR
process.env.ALBUM_THUMBS_DIR = path.join(DATA_DIR, 'album-thumbs')

const express = require(path.join(BM, 'express'))
const sharp = require(path.join(BM, 'sharp'))
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const albumThumbs = require(path.join(BACKEND, 'albumThumbs'))
const albumRouter = require(path.join(BACKEND, 'routes', 'album'))

// 一屏的量，故意大于旧的 ON_DEMAND_LIMIT = 8
const N = 12
const USERNAME = 'thumbs-batch-smoke'

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && detail !== undefined) {
    console.log('    →', typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300))
  }
}

function req(port, { method = 'GET', p = '/', body = null } = {}) {
  return new Promise((resolve) => {
    const payload = body != null ? JSON.stringify(body) : null
    const headers = { 'Content-Type': 'application/json' }
    if (payload != null) headers['Content-Length'] = Buffer.byteLength(payload)
    // 记每个 data 块的到达时刻：这是「真流式」唯一可靠的证据。
    // 只看「没有 Content-Length」没用 —— writeHead 之后补发整包也照样是 chunked。
    const t0 = Date.now()
    const stamps = []
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => { stamps.push(Date.now() - t0); chunks.push(c) })
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        let json = null
        try { json = JSON.parse(buf.toString('utf8')) } catch (_) { /* 二进制体 */ }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buf,
          json,
          firstAt: stamps.length ? stamps[0] : null,
          lastAt: stamps.length ? stamps[stamps.length - 1] : null,
          total: Date.now() - t0,
        })
      })
    })
    r.on('error', (e) => resolve({ status: 0, error: e.message }))
    r.setTimeout(30000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }) })
    r.end(payload)
  })
}

const thumbPathOf = (s, id) => path.join(dbManager.thumbsDir, albumThumbs.safeSlug(s), `${id}.jpg`)

async function main() {
  const srcDir = path.join(DATA_DIR, 'src')
  fs.mkdirSync(srcDir, { recursive: true })

  const { slug } = dbManager.createTeacher(USERNAME, 'not-a-real-hash', 'teacher')
  dbManager.withDb(slug, () => {
    const conn = dbManager.current()
    conn.prepare('INSERT INTO albums (id, name, folder_path, kind) VALUES (1, ?, ?, ?)').run('批量重建', DATA_DIR, 'folder')
    const ins = conn.prepare('INSERT INTO album_photos (id, album_id, file_path, file_name, file_size) VALUES (?, 1, ?, ?, 0)')
    for (let i = 1; i <= N; i++) ins.run(i, path.join(srcDir, `${i}.jpg`), `${i}.jpg`)
  })

  // 真图。**必须是噪点大图**：纯色小图 sharp 几毫秒就完事，整批瞬间完成，
  // 于是「首帧先到」与「攒完整包一起发」在时间上分不出来 —— 那样的流式断言等于没测。
  // 1600×1200 噪点约 2MB/张，生成缩略图 12~18ms，12 张足以在时间轴上拉开差距。
  for (let i = 1; i <= N; i++) {
    const p = path.join(srcDir, `${i}.jpg`)
    const w = 1600
    const h = 1200
    const raw = Buffer.alloc(w * h * 3)
    for (let k = 0; k < raw.length; k += 3) {
      const v = (Math.random() * 255) | 0
      raw[k] = v
      raw[k + 1] = v
      raw[k + 2] = v
    }
    await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 82 }).toFile(p)
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

  const ids = Array.from({ length: N }, (_, i) => i + 1)

  // ---------- 预热：先让 12 张都有缓存 ----------
  let warm = 0
  for (const id of ids) if ((await req(port, { p: `/api/album/photo/${id}/thumb` })).status === 200) warm++
  check(`预热：${N} 张缩略图全部生成成功`, warm === N, { warm, N })
  check('预热后文件全部在磁盘上', ids.every((id) => fs.existsSync(thumbPathOf(slug, id))))

  // ---------- 清理 ----------
  const purge = await req(port, { method: 'POST', p: '/api/album/thumbs/purge' })
  const d = (purge.json && purge.json.data) || {}
  check('purge → 200 且删掉全部文件', purge.status === 200 && d.files === N, { status: purge.status, d })
  check('文件确实不在了', ids.every((id) => !fs.existsSync(thumbPathOf(slug, id))))

  // ---------- ① 批量请求一屏：当场就要拿满 ----------
  const batch = await req(port, { method: 'POST', p: '/api/album/photo/thumbs', body: { ids } })
  const frames = parseFrames(batch.buf)
  const gotIds = frames.map((f) => f.id)
  check(`批量请求 ${N} 张 → 200`, batch.status === 200, batch.status)
  // 这一条就是本文件存在的理由：修复前这里是 0
  check(`批量**当场**拿回 ${N} 张（修复前为 0，整批被配额闸拒）`, frames.length === N, { got: frames.length, N })
  // 流式响应不保证顺序（谁先生成完谁先发），但必须一张不少、也不能多。
  // 前端按帧里的 id 落位，所以「顺序」不再是契约 —— 这里断言集合相等。
  check('返回的 id 集合与请求完全一致（流式乱序允许，缺/多不允许）',
    gotIds.slice().sort((a, b) => a - b).join(',') === ids.join(','),
    { got: gotIds.join(','), want: ids.join(',') })
  check('每帧都带非空 JPEG 数据', frames.every((f) => f.len > 0), frames.map((f) => f.len))
  // **流式的硬证据**：首帧必须远早于整批结束，且数据分多次到达。
  // 攒完整包再 end 时，firstAt ≈ total、lastAt - firstAt ≈ 0 —— 上面那些
  // 「帧数对」「id 对」的断言在整包模式下也全绿，只有这两条能把它抓出来（实测过）。
  // 阈值 0.7：整机负载高时首帧会被推迟（实测套件并发 55ms/90ms ≈ 0.61，独立跑 36ms/91ms ≈ 0.40）。
  // 攒完整包再 end 时 firstAt ≈ total（比值接近 1），0.7 仍能把那种非流式实现抓出来。
  check(`首帧在结束前就到（firstAt ${batch.firstAt}ms vs total ${batch.total}ms）`,
    batch.firstAt != null && batch.firstAt < batch.total * 0.7, { firstAt: batch.firstAt, total: batch.total })
  check(`数据分多次到达（${batch.firstAt}ms → ${batch.lastAt}ms，跨度 ${batch.lastAt - batch.firstAt}ms）`,
    (batch.lastAt - batch.firstAt) > 10, { firstAt: batch.firstAt, lastAt: batch.lastAt, total: batch.total })
  // 这条只防「显式设了长度」，防不住「先 writeHead 再补发整包」，所以不能单独当流式证据
  check('响应没有显式 Content-Length',
    !batch.headers['content-length'], batch.headers['content-length'])
  check('不再下发 X-Thumb-Ids（流式下无法预知会发出哪些 id）',
    !batch.headers['x-thumb-ids'], batch.headers['x-thumb-ids'])

  // ---------- ② 逐张回落同样可用 ----------
  const codes = []
  for (const id of ids) codes.push((await req(port, { p: `/api/album/photo/${id}/thumb` })).status)
  check('逐张回落接口全部 200（不再有「排队生成中」404）', codes.every((c) => c === 200), codes)

  // ---------- ③ 文件全部重建 ----------
  check('12 个缩略图文件全部重新落盘', ids.every((id) => fs.existsSync(thumbPathOf(slug, id))))

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
