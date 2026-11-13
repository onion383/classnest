// =========================================================================
// album-random-thumb.test.js —— 首页随机配图（GET /api/album/random-photo/thumb）
//
// 背景：首页只需要「一张图」，原来是前端遍历每个相册各拉一次全量照片列表再自己挑
// （真实数据 12,968 行 / 3.44MB），而且每次进首页都跑。改成后端随机抽一张、
// 直接把缩略图递过来 —— 一次请求。
//
// 本用例锁四件事：
//   ① 没有照片时回 404（不是空图、不是 200 空 body）；
//   ② 真的随机：多次请求能拿到不同的照片（用不同的缩略图字节区分，不靠响应头）；
//   ③ 不许缓存：URL 固定，让浏览器缓存 24h 的话首页永远是同一张；
//   ④ 单张 /thumb 重构后行为不变（同一条 sendThumb，缓存头仍是 max-age=86400）。
// =========================================================================
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createBackendDb } = require('./_db-express-fixture.cjs')

// 公共夹具：内存库 + db.js Proxy / dbManager.current 的进程级 stub
const fx = createBackendDb({ label: 'album-random-thumb' })
const conn = fx.conn

const TMP = process.env.DATA_DIR
const ALBUM_ID = 1
const ins = conn.prepare(
  'INSERT INTO album_photos (album_id, file_path, file_name, file_size, mtime, photo_date, exif_date, date_src, thumb_path, thumb_v) VALUES (?,?,?,?,?,?,?,?,?,?)'
)
conn.prepare("INSERT INTO albums (id, name, folder_path, kind) VALUES (?,?,?,?)").run(ALBUM_ID, '配图相册', 'D:\\p', 'folder')

// 三张「缩略图」：内容各不相同，靠返回的字节就能判断这次抽到的是哪一张。
// thumb_v 给一个大数（>= THUMB_VERSION=5），保证 thumbOf 直接采信、不触发重建。
const thumbs = [
  Buffer.from('thumb-AAA'),
  Buffer.from('thumb-BBB'),
  Buffer.from('thumb-CCC'),
]
thumbs.forEach((buf, i) => {
  const p = path.join(TMP, `thumb-${i}.jpg`)
  fs.writeFileSync(p, buf)
  ins.run(ALBUM_ID, `D:\\p\\IMG_${i}.jpg`, `IMG_${i}.jpg`, 1000 + i, `2026-05-0${i + 1} 10:00:00`,
    `2026-05-0${i + 1}`, `2026-05-0${i + 1} 10:00:00`, 'exif', p, 999)
})

let base
test.before(async () => {
  base = await fx.mount('/api/album', 'student-backend/routes/album.js')
})
test.after(() => {
  fx.close()
  for (const [i] of thumbs.entries()) { try { fs.rmSync(path.join(TMP, `thumb-${i}.jpg`)) } catch (_) { /* 已删 */ } }
})

const bytesOf = async (url) => {
  const r = await fetch(url)
  const ab = await r.arrayBuffer()
  return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), buf: Buffer.from(ab) }
}

test('有照片：随机接口返回一张真图，且禁缓存', async () => {
  const r = await bytesOf(`${base}/random-photo/thumb`)
  assert.equal(r.status, 200)
  assert.equal(r.type, 'image/jpeg')
  assert.ok(thumbs.some((t) => t.equals(r.buf)), '返回的必须是其中一张缩略图')
  assert.match(String(r.cache), /no-store/, 'URL 固定，缓存了首页就永远是同一张')
})

test('真的随机：20 次请求能抽到不同的照片', async () => {
  const seen = new Set()
  for (let i = 0; i < 20; i++) {
    const r = await bytesOf(`${base}/random-photo/thumb`)
    assert.equal(r.status, 200)
    seen.add(r.buf.toString())
  }
  assert.ok(seen.size >= 2, `20 次只抽到同一种（${[...seen]}），说明没随机`)
})

test('单张 /thumb 回归：缓存头仍是 private, max-age=86400', async () => {
  const id = conn.prepare('SELECT id FROM album_photos WHERE file_name = ?').get('IMG_1.jpg').id
  const r = await bytesOf(`${base}/photo/${id}/thumb`)
  assert.equal(r.status, 200)
  assert.ok(thumbs[1].equals(r.buf), '必须回这张照片自己的缩略图')
  assert.match(String(r.cache), /max-age=86400/)
})

test('照片不存在：404 + 明确错误，不是空 200', async () => {
  const r = await fetch(`${base}/photo/99999/thumb`)
  assert.equal(r.status, 404)
  assert.match(String((await r.json()).error), /照片不存在/)
})

test('没有照片时随机接口回 404，前端据此保留旧图/清空', async () => {
  conn.prepare('DELETE FROM album_photos WHERE album_id = ?').run(ALBUM_ID)
  const r = await fetch(`${base}/random-photo/thumb`)
  assert.equal(r.status, 404)
  assert.match(String((await r.json()).error), /还没有照片/)
})
