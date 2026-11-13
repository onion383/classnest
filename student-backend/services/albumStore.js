// ==================== 相册索引（albums / album_photos）的 SQL 出口 ====================
// 档 C · M12-B2：相册路由只保留文件系统副作用（unlink 缩略图、派发扫描）与事务编排，
// 语句收在这里。**事务仍留在路由**：相册的复合写都夹着 FS 副作用（删缩略图、派发子进程），
// 把事务搬进 service 会让「先删缓存再删库」这类顺序变得看不见。
const { db } = require('../db')

// ---------- 相册列表 ----------
// cover_photo_id：相册卡片的封面取「最新一张图片」的 id（按 mtime 倒序，排除视频），
// 直接在 SQL 里筛出，避免把整个相册的上万行照片取回前端再过滤。
// 视频扩展名需与 mediaTypeOf 的判断保持一致，新增格式这里也要加。
const NOT_VIDEO_SQL = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'ogv']
  .map(ext => `LOWER(p.file_name) NOT LIKE '%.${ext}'`)
  .join(' AND ')

// 相册列表（含照片数、封面），按 sort_order 排序；共用于 GET /api/album 与 /api/dashboard
function listAlbums() {
  return db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM album_photos p WHERE p.album_id = a.id) AS photo_count,
      (SELECT p.id FROM album_photos p
        WHERE p.album_id = a.id AND ${NOT_VIDEO_SQL}
        ORDER BY p.mtime DESC, p.id DESC LIMIT 1) AS cover_photo_id
    FROM albums a ORDER BY a.sort_order ASC, a.id ASC
  `).all()
}

// 全局相册统计：按 file_path 去重，避免虚拟相册复制同一份索引时把照片数与体积算重
function stats() {
  const row = db.prepare(`
    SELECT COUNT(*) AS photo_count, COALESCE(SUM(file_size), 0) AS total_size
    FROM (SELECT file_path, MAX(file_size) AS file_size FROM album_photos GROUP BY file_path)
  `).get() || {}
  return { photo_count: row.photo_count || 0, total_size: row.total_size || 0 }
}

// 全部相册的 id → 名称（任务列表回填相册名用）
function albumNameRows() {
  return db.prepare('SELECT id, name FROM albums').all()
}

// ---------- 相册单行 ----------
function albumById(id) {
  return db.prepare('SELECT * FROM albums WHERE id = ?').get(id)
}

// 只取合并/移动判断需要的最小列
function albumBrief(id) {
  return db.prepare('SELECT id, name, kind FROM albums WHERE id = ?').get(id)
}

function albumKind(id) {
  return db.prepare('SELECT id, kind FROM albums WHERE id = ?').get(id)
}

// 新建相册。sort_order 随后按「排到最后」的约定单独写（见 setAlbumSort）。
function insertFolderAlbum(name, folderPath, ts) {
  return db.prepare("INSERT INTO albums (name, folder_path, kind, created_at, updated_at) VALUES (?, ?, 'folder', ?, ?)")
    .run(name, folderPath, ts, ts)
}

function insertVirtualAlbum(name, ts) {
  return db.prepare("INSERT INTO albums (name, folder_path, kind, created_at, updated_at) VALUES (?, '', 'virtual', ?, ?)")
    .run(name, ts, ts)
}

function setAlbumSort(id, sortOrder) {
  return db.prepare('UPDATE albums SET sort_order = ? WHERE id = ?').run(sortOrder, id)
}

function updateAlbumFields(id, name, folderPath, ts) {
  return db.prepare('UPDATE albums SET name = ?, folder_path = ?, updated_at = ? WHERE id = ?')
    .run(name, folderPath, ts, id)
}

function touchAlbum(id, ts) {
  return db.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').run(ts, id)
}

function deleteAlbumRow(id) {
  return db.prepare('DELETE FROM albums WHERE id = ?').run(id)
}

// ---------- 照片行 ----------
// 照片行的公共列与排序 —— 全量路径与分页路径必须完全同源。
// 两条路径各写一份 SQL 的话，字段或顺序迟早会分叉，表现是「刷新后照片换了位置」。
const PHOTO_COLS = 'id, file_path, file_name, file_size, mtime, photo_date, exif_date, date_src'
const PHOTO_ORDER = 'ORDER BY photo_date DESC, mtime DESC, id DESC'

function photoById(id) {
  return db.prepare('SELECT * FROM album_photos WHERE id = ?').get(id)
}

function photosOfAlbum(albumId) {
  return db.prepare('SELECT * FROM album_photos WHERE album_id = ?').all(albumId)
}

function photoCount(albumId) {
  return db.prepare('SELECT COUNT(*) AS c FROM album_photos WHERE album_id = ?').get(albumId).c
}

// 整册照片（网格列，不含 album_id）
function listPhotos(albumId) {
  return db.prepare(`SELECT ${PHOTO_COLS} FROM album_photos WHERE album_id = ? ${PHOTO_ORDER}`).all(albumId)
}

// 指定若干天内的照片（占位符个数 = 天数，用绑定值而不是拼字符串）
function listPhotosInDates(albumId, dates) {
  const marks = dates.map(() => '?').join(',')
  return db.prepare(
    `SELECT ${PHOTO_COLS} FROM album_photos
     WHERE album_id = ? AND photo_date IN (${marks}) ${PHOTO_ORDER}`
  ).all(albumId, ...dates)
}

// 「未知时间」那一组（读不到 EXIF 的行，photo_date 为空串，天然排在最后）
function listUnknownDatePhotos(albumId) {
  return db.prepare(`SELECT ${PHOTO_COLS} FROM album_photos WHERE album_id = ? AND photo_date = '' ${PHOTO_ORDER}`).all(albumId)
}

// 网格用的照片列 + album_id：定位要按它切相册
function photoForLocate(id) {
  return db.prepare(`SELECT ${PHOTO_COLS}, album_id FROM album_photos WHERE id = ?`).get(id)
}

// 批量缩略图：只取生成缩略图需要的五列
function thumbRowsByIds(ids) {
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(`SELECT id, file_path, file_name, thumb_path, thumb_v FROM album_photos WHERE id IN (${placeholders})`).all(...ids)
}

// 删除相册时清理缩略图要用的行（id + 库里的 thumb_path）
function thumbRefsOfAlbum(albumId) {
  return db.prepare('SELECT id, thumb_path FROM album_photos WHERE album_id = ?').all(albumId)
}

// 复制一行照片索引到目标相册。
// thumb_path 置空：新行有自己的 id，缩略图由 /thumb 按需生成（{新id}.jpg），
// 不与源行共用同一个缓存文件，避免源侧删照片时把目标的缩略图一起删掉。
// 同一相册里 file_path 相同则跳过（INSERT OR IGNORE 配合唯一索引）。
function copyPhotoRow(albumId, photo) {
  return db.prepare(`
    INSERT OR IGNORE INTO album_photos (album_id, file_path, file_name, file_size, mtime, photo_date, exif_date, date_src, thumb_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '')
  `).run(albumId, photo.file_path, photo.file_name, photo.file_size || 0, photo.mtime || '', photo.photo_date || '', photo.exif_date || '', photo.date_src || '')
}

function deletePhotoRow(id) {
  return db.prepare('DELETE FROM album_photos WHERE id = ?').run(id)
}

function deletePhotosOfAlbum(albumId) {
  return db.prepare('DELETE FROM album_photos WHERE album_id = ?').run(albumId)
}

function updateThumbPath(id, thumbPath, version) {
  return db.prepare('UPDATE album_photos SET thumb_path = ?, thumb_v = ? WHERE id = ?').run(thumbPath, version, id)
}

// ---------- 日期索引 / 分页 ----------
// 每个日期各有多少张（日期索引；5 万张也只有十几 KB）
function photoDateCounts(albumId) {
  return db.prepare(`
      SELECT photo_date AS date, COUNT(*) AS count
      FROM album_photos WHERE album_id = ?
      GROUP BY photo_date
      ORDER BY photo_date DESC
    `).all(albumId)
}

// 日期游标分页第一步：候选日期 + 每天张数（多取一条用于判「还有更多日期」）。
// 走 idx_album_photos_album_date 的 COVERING INDEX，不读照片行，代价与天数成正比。
function photoDateCountsPage(albumId, days, before) {
  if (before) {
    return db.prepare(
      `SELECT photo_date AS d, COUNT(*) AS n FROM album_photos
         WHERE album_id = ? AND photo_date <> '' AND photo_date < ?
         GROUP BY photo_date ORDER BY photo_date DESC LIMIT ?`
    ).all(albumId, before, days + 1)
  }
  return db.prepare(
    `SELECT photo_date AS d, COUNT(*) AS n FROM album_photos
       WHERE album_id = ? AND photo_date <> ''
       GROUP BY photo_date ORDER BY photo_date DESC LIMIT ?`
  ).all(albumId, days + 1)
}

// ---------- 首页随机配图 ----------
// ORDER BY RANDOM() 是整表扫一遍，但只回一行、不物化结果集：实测 13k 行 1.2ms。
// 真涨到几十万张时再换成「随机 rowid + 就近取」。
// exclude：首页「换一张」把当前这张排掉，否则照片少时大概率抽到同一张。
// 排除后查不到（库里只剩这一张）由调用方退回不排除，绝不回 404。
function randomPhotoId(exclude) {
  const pick = (sql, args) => db.prepare(sql).get(...args)
  let row = exclude
    ? pick('SELECT id FROM album_photos WHERE id <> ? ORDER BY RANDOM() LIMIT 1', [exclude])
    : pick('SELECT id FROM album_photos ORDER BY RANDOM() LIMIT 1', [])
  if (!row) row = pick('SELECT id FROM album_photos ORDER BY RANDOM() LIMIT 1', [])
  return row ? row.id : 0
}

module.exports = {
  listAlbums,
  stats,
  albumNameRows,
  albumById,
  albumBrief,
  albumKind,
  insertFolderAlbum,
  insertVirtualAlbum,
  setAlbumSort,
  updateAlbumFields,
  touchAlbum,
  deleteAlbumRow,
  photoById,
  photosOfAlbum,
  photoCount,
  listPhotos,
  listPhotosInDates,
  listUnknownDatePhotos,
  photoForLocate,
  thumbRowsByIds,
  thumbRefsOfAlbum,
  copyPhotoRow,
  deletePhotoRow,
  deletePhotosOfAlbum,
  updateThumbPath,
  photoDateCounts,
  photoDateCountsPage,
  randomPhotoId,
}
