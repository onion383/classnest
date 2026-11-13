// =========================================================================
// album-photo-focus.test.js —— 首页配图点进相册「定位到这一张」的链路
//
// 链路：首页 GET /random-photo/thumb 拿图 + 响应头 X-Photo-Id
//       → 点击带 /album?photo=<id>
//       → 相册页 GET /photo/<id>/locate 查相册与日期 → 滚过去 + 打开查看器
//
// 锁四件事：
//   ① 响应头里的 id 必须与这次返回的 JPEG 是同一张（抽两次 / 写错 id 都会串图）；
//   ② /locate 返回索引行，且只返回一行（不为一张图拉一整册）；
//   ③ 不存在的照片 404，不是 200 空对象；
//   ④ 前后端各处真的接上了：源码判据覆盖 CORS 暴露头、首页跳转、相册页消费 query。
//      只测后端接口会假绿 —— 前端没读头 / 没读 query 时功能一样是断的。
// =========================================================================
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createBackendDb } = require('./_db-express-fixture.cjs')

const ROOT = path.resolve(__dirname, '../..')
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const fx = createBackendDb({ label: 'album-photo-focus' })
const conn = fx.conn
const TMP = process.env.DATA_DIR
const ALBUM_ID = 7
const ins = conn.prepare(
  'INSERT INTO album_photos (album_id, file_path, file_name, file_size, mtime, photo_date, exif_date, date_src, thumb_path, thumb_v) VALUES (?,?,?,?,?,?,?,?,?,?)'
)
conn.prepare("INSERT INTO albums (id, name, folder_path, kind) VALUES (?,?,?,?)").run(ALBUM_ID, '定位用相册', 'D:\\p', 'folder')

const thumbs = [
  Buffer.from('focus-thumb-AAA'),
  Buffer.from('focus-thumb-BBB'),
  Buffer.from('focus-thumb-CCC'),
]
thumbs.forEach((buf, i) => {
  const p = path.join(TMP, `focus-thumb-${i}.jpg`)
  fs.writeFileSync(p, buf)
  ins.run(ALBUM_ID, `D:\\p\\FOCUS_${i}.jpg`, `FOCUS_${i}.jpg`, 1000 + i, `2026-06-0${i + 1} 10:00:00`,
    `2026-06-0${i + 1}`, `2026-06-0${i + 1} 10:00:00`, 'exif', p, 999)
})

let base
test.before(async () => {
  base = await fx.mount('/api/album', 'student-backend/routes/album.js')
})
test.after(() => {
  fx.close()
  for (const [i] of thumbs.entries()) { try { fs.rmSync(path.join(TMP, `focus-thumb-${i}.jpg`)) } catch (_) { /* 已删 */ } }
})

test('随机图响应头带回的 id，就是本次返回的那张图', async () => {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${base}/random-photo/thumb`)
    assert.equal(r.status, 200)
    const id = Number(r.headers.get('x-photo-id'))
    assert.ok(Number.isInteger(id) && id > 0, '缺 X-Photo-Id 首页就没法定位到这一张')
    const row = conn.prepare('SELECT thumb_path FROM album_photos WHERE id = ?').get(id)
    assert.ok(row, '头里的 id 必须是库里真实存在的照片')
    const body = Buffer.from(await r.arrayBuffer())
    assert.ok(body.equals(fs.readFileSync(row.thumb_path)), `第 ${i + 1} 次：头里的 id 与返回的图不是同一张`)
  }
})

test('/locate 只回这一行的索引字段，供相册页切相册 + 按日期滚动', async () => {
  const id = conn.prepare('SELECT id FROM album_photos WHERE file_name = ?').get('FOCUS_1.jpg').id
  const r = await fetch(`${base}/photo/${id}/locate`)
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.success, true)
  assert.equal(body.data.id, id)
  assert.equal(body.data.album_id, ALBUM_ID)
  assert.equal(body.data.file_name, 'FOCUS_1.jpg')
  assert.equal(body.data.photo_date, '2026-06-02')
  assert.ok(body.data.file_path, '查看器信息面板要用')
  // 必须是单行对象，不能把整册分组带出来
  assert.equal(Array.isArray(body.data), false)
  assert.equal(body.data.photos, undefined)
})

test('照片不存在：404 + 明确错误，前端据此安静地只停在相册页', async () => {
  const r = await fetch(`${base}/photo/99999/locate`)
  assert.equal(r.status, 404)
  assert.match(String((await r.json()).error), /照片不存在/)
})

test('源码判据：CORS 真的放行了 X-Photo-Id，否则打包版跨域读不到头', () => {
  assert.match(readSrc('student-backend/app.js'), /exposedHeaders:[^\]]*X-Photo-Id/)
  assert.match(readSrc('student-backend/routes/album.js'), /res\.setHeader\('X-Photo-Id'/)
})

test('源码判据：首页真的读头并带 ?photo 跳转（卡片与按钮两处入口）', () => {
  const src = readSrc('student-frontend/src/views/DashboardView.vue')
  assert.match(src, /h\.get\('X-Photo-Id'\)/, '必须从响应头读照片 id')
  assert.match(src, /query:\s*\{\s*photo:\s*String\(id\)\s*\}/, '跳转必须带 ?photo=<id>')
  assert.ok((src.match(/goToAlbumPhoto\(\)/g) || []).length >= 2, '整卡与按钮都要走带 id 的跳转')
})

test('exclude：点「换一张」不会抽到当前这一张', async () => {
  const cur = conn.prepare('SELECT id FROM album_photos WHERE file_name = ?').get('FOCUS_0.jpg').id
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${base}/random-photo/thumb?exclude=${cur}`)
    assert.equal(r.status, 200)
    assert.notEqual(Number(r.headers.get('x-photo-id')), cur, '抽到同一张，按钮点了像没反应')
  }
})

test('源码判据：首页换一张按钮 + 磁贴式动画 + blob 释放时机', () => {
  const src = readSrc('student-frontend/src/views/DashboardView.vue')
  assert.match(src, /@click\.stop="cycleAlbumPhoto\(\)"/, '按钮必须 stop，否则点一下就跳去相册页了')
  assert.match(src, /params:\s*exclude\s*\?\s*\{\s*exclude\s*\}/, '换图请求要排除当前这张')
  assert.match(src, /keepOnError:\s*true/, '换图失败不能把当前图清空')
  // 毛玻璃主题会给所有 button 补 1px 深色圆环，必须显式清掉，否则按钮看着像带黑框
  assert.match(src, /border:\s*1px solid transparent !important/, '循环按钮的边框要清掉')
  assert.match(src, /\.photo-cycle-btn::before\s*\{\s*display:\s*none !important/, '主题的荧光描边也要清掉')
  // 转圈不能请求一回来就停：要一直转到换图过渡动画收尾（后端命中缓存只有几十毫秒）
  assert.match(src, /function finishPhotoAnim\(\)[\s\S]{0,400}spinPending[\s\S]{0,100}photoSwitching\.value = false/,
    '转圈的停止点必须放在换图动画收尾里')
  assert.match(src, /animated = replaceAlbumPhoto\(thumbRes\.data, !!exclude\)/,
    '按钮这一轮要用 replaceAlbumPhoto 的返回值登记「等动画」')
  assert.match(src, /if \(!\(albumPhotoSeq\.isCurrent\(my\) && animated && spinPending\)\)/,
    '关闭动画/失败/被接管时必须立刻停，别让按钮转个不停')
  assert.match(src, /photo-spin 560ms/, '一圈与换图动画总时长对齐')
  assert.match(src, /@keyframes photo-retreat/, '旧图后退的关键帧')
  assert.match(src, /@keyframes photo-float-in/, '新图浮入的关键帧')
  assert.match(src, /photoOutUrl/, '必须保留后层旧图')
  assert.match(src, /photoAnimFallback\(finishPhotoAnim, 700\)/, '动画不触发时要有兜底收尾')
  assert.match(src, /finishPhotoAnim[\s\S]{0,400}revokeBlobUrl\(old\)/, '旧图要等动画结束才释放')
})

test('源码判据：相册页消费 ?photo，且挂载 / 切回 / query 变化三个入口都接上', () => {
  const src = readSrc('student-frontend/src/views/AlbumView.vue')
  assert.match(src, /route\.query\.photo/)
  assert.match(src, /photo\/\$\{id\}\/locate/)
  assert.match(src, /viewPhoto\(p\)/)
  assert.ok((src.match(/applyPhotoFocus\(\)/g) || []).length >= 3,
    '定义 + onMounted + onActivated 至少 3 处')
  assert.match(src, /watch\(\(\) => route\.query\.photo, applyPhotoFocus\)/,
    'KeepAlive 缓存后从首页再点进来，只会变 query，必须靠 watch 触发')
})

// 放在最后：会删掉两行照片，前面的用例都依赖三张图
test('库里只剩一张时 exclude 仍 200（回退不排除），不把首页配图弄没', async () => {
  conn.prepare("DELETE FROM album_photos WHERE file_name <> 'FOCUS_2.jpg'").run()
  const only = conn.prepare("SELECT id FROM album_photos WHERE file_name = ?").get('FOCUS_2.jpg').id
  const r = await fetch(`${base}/random-photo/thumb?exclude=${only}`)
  assert.equal(r.status, 200)
  assert.equal(Number(r.headers.get('x-photo-id')), only)
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(thumbs[2]))
})
