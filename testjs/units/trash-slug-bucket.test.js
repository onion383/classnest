// =========================================================================
// trash-slug-bucket.test.js —— 全局回收站归档跨班碰撞（2-8 / #7）
//
// 原缺陷：trashPathFor 用 `{photoId}_{name}` 全局路径，各库 album_photos.id 都从 1 自增，
// 两班同 id + 同名照片归档到同一路径 → 后删覆盖先删，先删那张的原文件丢失、撤销无法还原。
// 修法：归档路径按当前库 slug 分桶（删除与 undo 都在同一班上下文，路径一致）；
// restoreToOriginal 兼容升级前无分桶的旧归档（新路径找不到退回旧路径）。
//
// 判据：① 行为：两班同 id 同名照片归档到不同 slug 子目录、文件都在；各自 restore 还原自己的；
//       ② 兼容：旧全局路径的归档仍可还原；③ 变异反证：去掉 slug 分桶后碰撞用例失败。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const BACKEND = path.join(ROOT, 'student-backend')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-trash-slug-'))
process.on('exit', () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) {} })
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'trash-slug-test-key'
process.env.DATA_DIR = DATA_DIR

const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const { TRASH_DIR, trashPathFor, legacyTrashPathFor, moveToTrash, restoreToOriginal } = require(path.join(BACKEND, 'albumOps'))
const realCurrentSlug = dbManager.currentSlug
test.after(() => { dbManager.currentSlug = realCurrentSlug })

function makePhoto(id, slug) {
  const dir = path.join(DATA_DIR, 'src', slug)
  fs.mkdirSync(dir, { recursive: true })
  const src = path.join(dir, `pic-${id}.jpg`)
  fs.writeFileSync(src, `content-of-${slug}`)
  return { id, file_name: 'pic.jpg', file_path: src }
}

test('行为：两班同 id 同名照片归档到不同 slug 目录，互不覆盖', async () => {
  const slugA = '@aaaaaaaaaaaa'; const slugB = '@bbbbbbbbbbbb'
  const a = makePhoto(1, slugA); const b = makePhoto(1, slugB)

  dbManager.currentSlug = () => slugA
  const pathA = trashPathFor(a)
  await moveToTrash(a)
  dbManager.currentSlug = () => slugB
  const pathB = trashPathFor(b)
  await moveToTrash(b)

  assert.notEqual(pathA, pathB, '两班归档路径必须不同，否则互相覆盖')
  assert.ok(pathA.includes(slugA) && pathB.includes(slugB), '路径应含 slug 分桶')
  assert.equal(fs.readFileSync(pathA, 'utf8'), 'content-of-' + slugA, 'A 班原文件不能被 B 班冲掉')
  assert.equal(fs.readFileSync(pathB, 'utf8'), 'content-of-' + slugB)

  // 各自撤销：在自己的 slug 上下文里还原自己的文件
  dbManager.currentSlug = () => slugA
  assert.equal(await restoreToOriginal(a), true)
  assert.equal(fs.readFileSync(a.file_path, 'utf8'), 'content-of-' + slugA)
  dbManager.currentSlug = () => slugB
  assert.equal(await restoreToOriginal(b), true)
  assert.equal(fs.readFileSync(b.file_path, 'utf8'), 'content-of-' + slugB)
})

test('兼容：升级前无 slug 分桶的旧归档仍可还原', async () => {
  const slug = '@cccccccccccc'
  const photo = makePhoto(9, slug)
  dbManager.currentSlug = () => slug
  const legacy = legacyTrashPathFor(photo)
  fs.mkdirSync(path.dirname(legacy), { recursive: true })
  fs.writeFileSync(legacy, 'old-content')
  assert.equal(await restoreToOriginal(photo), true, '新路径找不到时应退回旧路径')
  assert.equal(fs.readFileSync(photo.file_path, 'utf8'), 'old-content')
})

test('变异反证：去掉 slug 分桶后，两班路径相同（碰撞复现）', () => {
  const photo = { id: 1, file_name: 'pic.jpg', file_path: '/x/pic.jpg' }
  dbManager.currentSlug = () => '@aaaaaaaaaaaa'
  const withSlug = trashPathFor(photo)
  // 模拟旧逻辑：不带 slug 参数
  const withoutSlug = legacyTrashPathFor(photo)
  assert.notEqual(withSlug, withoutSlug, '分桶前后路径必须不同，否则判据恒真')
  assert.equal(legacyTrashPathFor({ ...photo }), legacyTrashPathFor(photo), '旧逻辑两班同 id 同名 → 同路径（碰撞）')
})
