// =========================================================================
// album-virtual-all.test.js —— 虚拟相册「整册全选」（POST /api/album 的 all_from）
//
// 背景：选照片弹窗改成按日期分页后，「全选」不能再靠前端把整册照片拉下来展开成 id 列表。
// 现在的做法是前端只交一段「选择描述」：源相册 + 要排除的那几张，由后端展开。
//
// 本用例锁六件事：
//   ① all_from 展开后张数 = 源相册张数（不是 0，也不是只拷一部分）；
//   ② exclude 真的排除掉了，且不影响没被排除的；
//   ③ 源是文件夹相册 → 源索引不动（不能把源相册搬空）；
//   ④ 源是虚拟相册 → 源索引被移走（与「逐张选」的既有语义一致）；
//   ⑤ 全被排除 / 源相册不存在 → 400 / 404，不是静默建成空相册；
//   ⑥ 老的 photos 数组路径仍然工作（别把逐张选弄坏了）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendDb } = require('./_db-express-fixture.cjs')

// 公共夹具：内存库 + db.js Proxy / dbManager.current 的进程级 stub。
// currentSlug 给固定值：虚拟相册复制完会清源行缩略图缓存（路径按 slug 推导），
// 不给的话会算出怪路径。
const fx = createBackendDb({ label: 'album-virtual-all', currentSlug: 'testslug' })
const conn = fx.conn

const FOLDER_ID = 1
const VIRTUAL_ID = 2
const ins = conn.prepare(
  'INSERT INTO album_photos (album_id, file_path, file_name, file_size, mtime, photo_date, exif_date, date_src, thumb_path) VALUES (?,?,?,?,?,?,?,?,?)'
)
conn.prepare("INSERT INTO albums (id, name, folder_path, kind) VALUES (?,?,?,?)").run(FOLDER_ID, '文件夹册', 'D:\\photos', 'folder')
conn.prepare("INSERT INTO albums (id, name, folder_path, kind) VALUES (?,?,?,?)").run(VIRTUAL_ID, '虚拟册', '', 'virtual')

const FOLDER_PHOTOS = 12
const VIRTUAL_PHOTOS = 5
conn.transaction(() => {
  for (let i = 0; i < FOLDER_PHOTOS; i++) {
    ins.run(FOLDER_ID, `D:\\photos\\IMG_${i}.jpg`, `IMG_${i}.jpg`, 1000 + i,
      `2026-05-${String((i % 28) + 1).padStart(2, '0')} 10:00:00`, `2026-05-${String((i % 28) + 1).padStart(2, '0')}`, '', 'exif', '')
  }
  for (let i = 0; i < VIRTUAL_PHOTOS; i++) {
    ins.run(VIRTUAL_ID, `D:\\photos\\V_${i}.jpg`, `V_${i}.jpg`, 2000 + i,
      `2026-06-0${i + 1} 10:00:00`, `2026-06-0${i + 1}`, '', 'exif', '')
  }
})()

let base
test.before(async () => {
  base = await fx.mount('/api/album', 'student-backend/routes/album.js')
})
test.after(() => fx.close())

const post = async (body) => {
  const r = await fetch(base + '/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, json: await r.json() }
}
const countOf = (albumId) => conn.prepare('SELECT COUNT(*) AS c FROM album_photos WHERE album_id = ?').get(albumId).c
const photoIdsOf = (albumId) => conn.prepare('SELECT id FROM album_photos WHERE album_id = ? ORDER BY id').all(albumId).map(r => r.id)

test('all_from：整册复制，源是文件夹相册 → 全量拷过去、源不动', async () => {
  const before = photoIdsOf(FOLDER_ID)
  const r = await post({ kind: 'virtual', name: '整册副本', all_from: FOLDER_ID })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(countOf(r.json.id), FOLDER_PHOTOS, '必须一张不少')
  assert.deepEqual(photoIdsOf(FOLDER_ID), before, '文件夹相册的索引不能被搬走')
})

test('all_from + exclude：排除指定照片，其余照旧', async () => {
  const all = photoIdsOf(FOLDER_ID)
  const drop = [all[0], all[3]]
  const r = await post({ kind: 'virtual', name: '排除两张', all_from: FOLDER_ID, exclude: drop })
  assert.equal(r.status, 200)
  assert.equal(countOf(r.json.id), FOLDER_PHOTOS - 2)
  // 排除掉的那些不该出现在新相册里（按 file_path 比对，新行有自己的 id）
  const names = conn.prepare('SELECT file_name FROM album_photos WHERE album_id = ?').all(r.json.id).map(x => x.file_name)
  const dropped = conn.prepare(`SELECT file_name FROM album_photos WHERE id IN (${drop.map(() => '?').join(',')})`).all(...drop).map(x => x.file_name)
  for (const n of dropped) assert.ok(!names.includes(n), `被排除的 ${n} 不该被复制`)
})

test('all_from：源是虚拟相册 → 源索引被移走（与逐张选的语义一致）', async () => {
  const beforeCount = countOf(VIRTUAL_ID)
  assert.ok(beforeCount > 0, '前置：虚拟相册里得有照片')
  const r = await post({ kind: 'virtual', name: '搬走虚拟册', all_from: VIRTUAL_ID })
  assert.equal(r.status, 200)
  assert.equal(countOf(r.json.id), beforeCount, '目标拿到全部')
  assert.equal(countOf(VIRTUAL_ID), 0, '源虚拟相册被搬空（这是既有语义，不是 bug）')
})

test('全部排除 → 400，不能静默建个空相册', async () => {
  const all = photoIdsOf(FOLDER_ID)
  const r = await post({ kind: 'virtual', name: '一张不剩', all_from: FOLDER_ID, exclude: all })
  assert.equal(r.status, 400)
  assert.match(String(r.json.error), /请先选择照片/)
  // 也不能留下半成品相册
  assert.equal(conn.prepare("SELECT COUNT(*) AS c FROM albums WHERE name = '一张不剩'").get().c, 0)
})

test('源相册不存在 → 404', async () => {
  const r = await post({ kind: 'virtual', name: '无源', all_from: 9999 })
  assert.equal(r.status, 404)
  assert.match(String(r.json.error), /源相册不存在/)
})

test('老的 photos 数组路径仍然工作（逐张选不能坏）', async () => {
  const pick = photoIdsOf(FOLDER_ID).slice(0, 3)
  const r = await post({ kind: 'virtual', name: '逐张选', photos: pick.map(id => ({ photo_id: id })) })
  assert.equal(r.status, 200)
  assert.equal(countOf(r.json.id), 3)
})
