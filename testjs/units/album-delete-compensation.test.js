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

test('接线：删索引失败时调 restoreToOriginal 补偿', () => {
  const h = deleteHandler()
  // deletePhotoRow 必须在 try 里，catch 里调 restoreToOriginal
  assert.match(h, /try\s*\{[\s\S]{0,120}albumStore\.deletePhotoRow\(photo\.id\)/, '删索引要在 try 内')
  assert.match(h, /catch \(err\)[\s\S]{0,200}restoreToOriginal\(photo\)/, '失败时要把文件搬回')
  assert.match(h, /已回退文件/, '回包要说明做了补偿')
})

test('变异反证：去掉补偿调用后接线判据必须失败', () => {
  const h = deleteHandler()
  const mutated = h.replace(/await restoreToOriginal\(photo\)/, 'await Promise.resolve()')
  assert.ok(mutated !== h, '变异没匹配到补偿调用')
  assert.doesNotMatch(mutated, /restoreToOriginal\(photo\)/, '变异后接线判据应判失败')
})
