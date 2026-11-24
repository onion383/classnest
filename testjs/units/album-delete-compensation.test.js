// =========================================================================
// album-delete-compensation.test.js —— 删除照片双写失败补偿（2-5 / #13）
//
// 原缺陷：DELETE /photo/:id 先把文件 moveToTrash、再 deletePhotoRow 删索引。
// 若删索引失败，文件已进回收站、索引仍在 → 文件系统与 DB 永久不一致。
// 修法：deletePhotoRow 失败时调 restoreToOriginal 把文件搬回，保持两边一致。
//
// 判据：
//   ① 行为：moveToTrash → restoreToOriginal 能把文件完整搬回原路径（补偿原语可靠）；
//   ② 接线：handler 在 deletePhotoRow 的 catch 里调 restoreToOriginal；
//   ③ 变异反证：去掉补偿调用后接线判据失败。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const BACKEND = path.join(ROOT, 'student-backend')
const ALBUM = path.join(BACKEND, 'routes', 'album.js')

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-album-comp-'))
process.on('exit', () => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) {}
})
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'album-comp-test-key'
process.env.DATA_DIR = DATA_DIR

const { moveToTrash, restoreToOriginal, trashPathFor } = require(path.join(BACKEND, 'albumOps'))

test('行为：moveToTrash 后 restoreToOriginal 把文件完整搬回原路径', async () => {
  const src = path.join(DATA_DIR, 'photo-src', 'pic.jpg')
  fs.mkdirSync(path.dirname(src), { recursive: true })
  fs.writeFileSync(src, 'image-bytes')
  const photo = { id: 1, file_name: 'pic.jpg', file_path: src }
  const trash = trashPathFor(photo)

  assert.equal(await moveToTrash(photo), true)
  assert.ok(!fs.existsSync(src), '源文件应已移入回收站')
  assert.ok(fs.existsSync(trash), '回收站应有归档')

  assert.equal(await restoreToOriginal(photo), true)
  assert.ok(fs.existsSync(src), '补偿后源文件必须回到原路径')
  assert.equal(fs.readFileSync(src, 'utf8'), 'image-bytes', '内容不能丢')
  assert.ok(!fs.existsSync(trash), '回收站归档应被搬走')
})

function deleteHandler() {
  const src = fs.readFileSync(ALBUM, 'utf8')
  const parts = src.split(/(?=router\.(?:get|post|put|patch|delete)\s*\()/)
  const h = parts.find((p) => p.startsWith("router.delete('/photo/:photoId'"))
  assert.ok(h, '未找到 DELETE /photo/:photoId handler')
  return h
}

// 判据抽成可复用函数（T04-01）：主用例与变异反证共用同一份
function wiringGuard(h) {
  if (!/try\s*\{[\s\S]{0,120}albumStore\.deletePhotoRow\(photo\.id\)/.test(h)) {
    return { ok: false, why: '删索引要在 try 内' }
  }
  if (!/catch \(err\)[\s\S]{0,200}restoreToOriginal\(photo\)/.test(h)) {
    return { ok: false, why: '失败时要把文件搬回' }
  }
  if (!/已回退文件/.test(h)) return { ok: false, why: '回包要说明做了补偿' }
  return { ok: true }
}

test('接线：删索引失败时调 restoreToOriginal 补偿', () => {
  const r = wiringGuard(deleteHandler())
  assert.ok(r.ok, r.why)
})

test('变异反证：去掉补偿调用后，原始接线判据必须失败', () => {
  const h = deleteHandler()
  assert.equal(wiringGuard(h).ok, true, '基线接线判据应先通过')
  const mutated = h.replace(/await restoreToOriginal\(photo\)/, 'await Promise.resolve()')
  assert.ok(mutated !== h, '变异没匹配到补偿调用')
  assert.equal(wiringGuard(mutated).ok, false, '去掉补偿后判据仍 PASS —— 判据假绿')
})

// 行为注入（T04-05）：真跑 DELETE handler，用夹具让删索引那一步抛错，
// 断言「文件被搬回 + 索引仍在」——只靠源码正则钉扎无法证明 catch 真的补偿成功。
test('行为注入：删索引失败时文件被搬回、索引保留（T04-05）', async () => {
  const { createBackendDb } = require('./_db-express-fixture.cjs')
  const fx = createBackendDb({ label: 'album-comp-fault', faults: true })
  try {
    await fx.mount('/api/album', 'student-backend/routes/album.js')
    const src = path.join(DATA_DIR, 'photo-src2', 'pic2.jpg')
    fs.mkdirSync(path.dirname(src), { recursive: true })
    fs.writeFileSync(src, 'bytes2')
    fx.reset({ seed: (c) => {
      c.prepare("INSERT INTO albums (id, name, folder_path, kind) VALUES (1, '测试相册', '', 'folder')").run()
      c.prepare("INSERT INTO album_photos (id, album_id, file_path, file_name, file_size) VALUES (1, 1, ?, 'pic2.jpg', 6)").run(src)
    }})
    fx.inject({ failMatch: /DELETE FROM album_photos/i, failAtMatch: 1 })
    const r = await fx.call('DELETE', '/api/album/photo/1')
    assert.equal(r.status, 500, JSON.stringify(r.json))
    assert.match(String(r.json && r.json.error), /已回退文件/)
    assert.ok(fs.existsSync(src), '补偿后文件必须回到源路径')
    assert.equal(fs.readFileSync(src, 'utf8'), 'bytes2', '文件内容不能丢')
    assert.ok(fx.conn.prepare('SELECT 1 FROM album_photos WHERE id = 1').get(), '索引必须保留')
  } finally {
    fx.close()
  }
})
