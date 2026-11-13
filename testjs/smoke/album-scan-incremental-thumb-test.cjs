/**
 * album-scan-incremental-thumb-test.cjs —— 「增量跳过已有的、补齐丢的；全量无条件重建」回归
 *
 * 用户拍板的两套语义（刻意相反，别合并）：
 *   · 增量更新：已有缩略图就跳过（不管是预览现场生成的还是之前扫描生成的），只补丢的
 *   · 全量更新：有没有都重新生成（它是「修坏图 / 刷缓存」的唯一入口）
 *
 * 判据是**文件在不在**，不读内容（已生成的 jpg 不太可能自己损坏）。
 * 唯一例外：mtime 变了 = 源图变了，即使缩略图在也必须重建（否则显示错图）。
 *
 * 用缩略图文件的 mtimeMs 判断「有没有被重做」：genThumb 是写临时文件再 rename，
 * 只要真的重跑过，mtime 一定变；跳过则原文件分毫不动。
 *
 * 跑法：node testjs/smoke/album-scan-incremental-thumb-test.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { makeTempDir, removeDirWithRetry } = require('./_tmpdir.cjs')

const ROOT = path.join(__dirname, '..', '..')
const BACKEND = path.join(ROOT, 'student-backend')
const BM = path.join(BACKEND, 'node_modules')

const DATA_DIR = makeTempDir('album-inc-thumb-')
process.env.DB_MASTER_KEY = 'album-inc-thumb-smoke-key'
process.env.DATA_DIR = DATA_DIR
process.env.ALBUM_THUMBS_DIR = path.join(DATA_DIR, 'album-thumbs')

const express = require(path.join(BM, 'express'))
const sharp = require(path.join(BM, 'sharp'))
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const albumThumbs = require(path.join(BACKEND, 'albumThumbs'))
const albumScan = require(path.join(BACKEND, 'albumScan'))
const albumRouter = require(path.join(BACKEND, 'routes', 'album'))

const USERNAME = 'inc-thumb-smoke'
const N = 8

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && detail !== undefined) {
    console.log('    →', typeof detail === 'string' ? detail.slice(0, 400) : JSON.stringify(detail).slice(0, 400))
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(port, id) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: `/api/album/photo/${id}/thumb`, method: 'GET' }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(res.statusCode))
    })
    r.on('error', () => resolve(0))
    r.setTimeout(30000, () => { r.destroy(); resolve(0) })
    r.end()
  })
}

async function main() {
  const srcDir = path.join(DATA_DIR, 'src')
  fs.mkdirSync(srcDir, { recursive: true })

  const { slug } = dbManager.createTeacher(USERNAME, 'not-a-real-hash', 'teacher')
  let conn = null
  dbManager.withDb(slug, () => {
    conn = dbManager.current()
    conn.prepare('INSERT INTO albums (id, name, folder_path, kind) VALUES (1, ?, ?, ?)').run('增量补图', srcDir, 'folder')
  })

  const thumbDir = path.join(dbManager.thumbsDir, albumThumbs.safeSlug(slug))
  const thumbPathOf = (id) => path.join(thumbDir, `${id}.jpg`)
  const mtimes = () => {
    const m = new Map()
    for (let id = 1; id <= N; id++) {
      if (fs.existsSync(thumbPathOf(id))) m.set(id, fs.statSync(thumbPathOf(id)).mtimeMs)
    }
    return m
  }

  // 真图（噪点）：纯色小图几毫秒就完事，「有没有重做」在时间轴上分不开
  for (let i = 1; i <= N; i++) {
    const W = 1600
    const H = 1200
    const raw = Buffer.alloc(W * H * 3)
    for (let k = 0; k < raw.length; k += 3) {
      const v = (Math.random() * 255) | 0
      raw[k] = v; raw[k + 1] = v; raw[k + 2] = v
    }
    const p = path.join(srcDir, `${i}.jpg`)
    await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 82 }).toFile(p)
    dbManager.withDb(slug, () => {
      conn.prepare('UPDATE album_photos SET file_size = ? WHERE id = ?').run(fs.statSync(p).size, i)
    })
  }
  // 索引先建好，但缩略图一张都没生成 —— 模拟「扫描只跑完索引」
  dbManager.withDb(slug, () => {
    const ins = conn.prepare('INSERT INTO album_photos (id, album_id, file_path, file_name, file_size, mtime, photo_date) VALUES (?, 1, ?, ?, 0, ?, ?)')
    for (let i = 1; i <= N; i++) {
      const st = fs.statSync(path.join(srcDir, `${i}.jpg`))
      ins.run(i, path.join(srcDir, `${i}.jpg`), `${i}.jpg`, st.mtime.toISOString(), '2026-01-01')
    }
  })

  // 起一个后端只为走「预览链路」GET /thumb（它会现场生成并写回库）
  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use('/api/album', (rq, rs, next) => {
    rq.user = { username: USERNAME, role: 'teacher', dbSlug: slug }
    dbManager.withDb(slug, () => next())
  }, albumRouter)
  const server = http.createServer(app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  let token = 0
  const runIncremental = async () => {
    token += 1
    albumScan.claimScanTask(conn, 1, 'incremental', token, '')
    await albumScan.incrementalScan(conn, 1, '', slug, null, token)
  }
  const runFull = async () => {
    token += 1
    albumScan.claimScanTask(conn, 1, 'full', token, '')
    await albumScan.fullScan(conn, 1, '', slug, null, token)
  }

  // ---------- ① 首次增量：全部补齐 ----------
  await runIncremental()
  const base = mtimes()
  check(`首次增量：${N} 张缩略图全部补齐`, base.size === N, { got: base.size, want: N })

  // ---------- ② 已有的跳过，丢的补齐 ----------
  await sleep(30)
  const lost = [2, 4, 6]
  for (const id of lost) fs.unlinkSync(thumbPathOf(id))
  await runIncremental()
  const after = mtimes()
  const rebuilt = lost.filter((id) => after.has(id) && after.get(id) > (base.get(id) || 0))
  const untouched = [1, 3, 5, 7, 8].filter((id) => after.get(id) === base.get(id))
  check('丢掉的 3 张被补回来了（文件重新落盘）', rebuilt.length === lost.length, { rebuilt, lost })
  check('已有的 5 张**一张都没重做**（mtime 原封不动）', untouched.length === 5, { untouched, after: [...after], base: [...base] })

  // ---------- ③ 预览现场生成的也算「已有」 ----------
  await sleep(30)
  fs.unlinkSync(thumbPathOf(3))
  check('预览链路 GET /thumb → 200（模拟浏览时现场生成）', (await get(port, 3)) === 200)
  const previewMtime = fs.statSync(thumbPathOf(3)).mtimeMs
  await sleep(30)
  await runIncremental()
  check('预览生成的那张也被增量跳过（mtime 没变）',
    fs.statSync(thumbPathOf(3)).mtimeMs === previewMtime,
    { before: previewMtime, after: fs.statSync(thumbPathOf(3)).mtimeMs })

  // ---------- ④ 全量：无条件重建每一张 ----------
  const beforeFull = mtimes()
  await sleep(30)
  await runFull()
  const afterFull = mtimes()
  const allRebuilt = [...beforeFull.keys()].every((id) => afterFull.get(id) > beforeFull.get(id))
  check(`全量更新把 ${beforeFull.size} 张**全部**重新生成（不看有没有）`, allRebuilt,
    { before: [...beforeFull], after: [...afterFull] })

  await new Promise((r) => server.close(r))
  dbManager.closeAll?.()
  await sleep(200)
  await removeDirWithRetry(DATA_DIR).catch(() => {})

  console.log(failed ? `\n失败 ${failed} 条` : '\n全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('冒烟异常：', e); process.exit(1) })
