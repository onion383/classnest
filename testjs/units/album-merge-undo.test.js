// =========================================================================
// album-merge-undo.test.js —— 合并相册的撤销（Q2-09 / §4-6）
//
// 事故面：`POST /api/album/merge` 建新虚拟相册、复制照片索引、删掉全部源相册，
// 但没有任何撤销——合并错了只能重建相册、重新扫描整目录。
//
// 判据分两层：
//   ① 行为（真内存库 + 真 Express router + 真 HTTP）：合并 → 撤销后
//      源相册与照片索引原样回来、新相册消失；重做再合并一遍
//   ② 接线：后端带回三段快照，前端登记成一条 album_merge
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'album-merge' })
const { executors } = require('../../student-backend/routes/undo/undo.executors')

test.before(() => fx.mount('/api/album', 'student-backend/routes/album.js'))
test.after(() => fx.close())

const postMerge = (body) => fx.call('POST', '/merge', body)

// 两个虚拟相册；第二个人里故意放一张与第一人**同一路径**的照片（合并时按 file_path 去重）
function freshDb() {
  const conn = fx.reset()
  conn.exec(`
    INSERT INTO albums (id, name, folder_path, kind, sort_order) VALUES (1, 'A', '', 'virtual', 1);
    INSERT INTO albums (id, name, folder_path, kind, sort_order) VALUES (2, 'B', '', 'virtual', 2);
    INSERT INTO album_photos (id, album_id, file_path, file_name, thumb_path) VALUES (10, 1, '/x/a.jpg', 'a.jpg', '/t/a.jpg');
    INSERT INTO album_photos (id, album_id, file_path, file_name, thumb_path) VALUES (11, 2, '/x/b.jpg', 'b.jpg', '/t/b.jpg');
    INSERT INTO album_photos (id, album_id, file_path, file_name, thumb_path) VALUES (12, 2, '/x/a.jpg', 'a.jpg', '/t/a.jpg');
  `)
  return conn
}

const count = (conn, table, where = '') => conn.prepare(`SELECT COUNT(*) AS c FROM ${table} ${where}`).get().c

// ---------------------------------------------------------------------------
// ① 行为
// ---------------------------------------------------------------------------
test('Q2-09 复现：合并会删掉源相册并复制照片索引，快照必须三段齐全', async () => {
  const conn = freshDb()
  const { status, json } = await postMerge({ album_ids: [1, 2] })

  assert.equal(status, 200)
  assert.equal(count(conn, 'albums'), 1, '只剩合并出的新相册')
  assert.equal(count(conn, 'albums', 'WHERE id IN (1,2)'), 0)
  assert.equal(count(conn, 'album_photos'), 2, '同路径照片按 file_path 去重')

  const removed = json.removed
  assert.equal(removed.newAlbum.name, 'A + B')
  assert.equal(removed.newPhotos.length, 2)
  assert.equal(removed.sources.length, 2)
  assert.deepEqual(removed.sources.map(s => s.album.name), ['A', 'B'])
  assert.deepEqual(removed.sources.map(s => s.photos.length), [1, 2], '源相册照片整行都要带回')
})

test('撤销：删掉新相册，把两个源相册与照片索引原样恢复', async () => {
  const conn = freshDb()
  const { json } = await postMerge({ album_ids: [1, 2] })

  executors.album_merge.undo(json.removed)

  assert.equal(count(conn, 'albums'), 2)
  assert.deepEqual(conn.prepare('SELECT name FROM albums ORDER BY id').all().map(r => r.name), ['A', 'B'])
  assert.equal(count(conn, 'album_photos', 'WHERE album_id = 1'), 1)
  assert.equal(count(conn, 'album_photos', 'WHERE album_id = 2'), 2)
  // 合并时源缩略图文件已被物理删除：恢复的索引不能还指着旧路径
  assert.equal(
    conn.prepare('SELECT COUNT(*) AS c FROM album_photos WHERE thumb_path <> \'\'').get().c,
    0,
    '恢复的索引必须清空 thumb_path，等前端重新生成'
  )
})

test('重做：再次删掉源相册并重建合并结果', async () => {
  const conn = freshDb()
  const { json } = await postMerge({ album_ids: [1, 2] })
  executors.album_merge.undo(json.removed)

  executors.album_merge.redo(json.removed)

  assert.equal(count(conn, 'albums'), 1)
  assert.equal(count(conn, 'albums', 'WHERE id IN (1,2)'), 0)
  assert.equal(conn.prepare('SELECT name FROM albums').get().name, 'A + B')
  assert.equal(count(conn, 'album_photos'), 2)
})

test('validate：缺新相册整行直接拒绝', () => {
  assert.equal(executors.album_merge.validate({}), '参数不完整')
  assert.equal(executors.album_merge.validate({ newAlbum: { id: '3' } }), '参数不完整')
  assert.equal(executors.album_merge.validate({ newAlbum: { id: 3 } }), null)
})

// ---------------------------------------------------------------------------
// ② 接线
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('接线：路由在删除前取证并返回三段快照，执行器已注册', () => {
  const route = read('student-backend/routes/album.js')
  assert.match(route, /removed:\s*\{\s*newAlbum,\s*newPhotos,\s*sources\s*\}/)
  const ex = read('student-backend/routes/undo/undo.executors.js')
  assert.match(ex, /album_merge:/)
  // M12-B8：语句搬进 undoStore.restoreMergedAlbum，判据跟着语句走
  assert.match(ex, /undoStore\.restoreMergedAlbum\(payload\)/)
  const st = read('student-backend/services/undoStore.js')
  assert.match(st, /insertRow\('album_photos', \{ \.\.\.p, thumb_path: '' \}\)/)
})

test('接线：前端把合并登记成一条 album_merge 命令', () => {
  const view = read('student-frontend/src/views/AlbumView.vue')
  assert.match(view, /type:\s*'album_merge'/)
  assert.match(view, /payload:\s*removed/)
})
