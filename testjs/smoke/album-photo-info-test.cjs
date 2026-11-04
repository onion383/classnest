/**
 * 相册「照片信息」接口冒烟：GET /api/album/photo/:photoId/info
 *
 * 覆盖三类文件，因为它们各自走不同的分支：
 *   ① 带完整 EXIF 的 JPEG（厂牌/型号/ColorSpace/拍摄时间/GPS）→ 字段应全部读出来
 *   ② 内容是垃圾字节的「图片」                        → 读不动，分辨率等为空、不报错
 *   ③ 不存在的 photoId                                → 404
 *
 * 不启动完整后端，也不碰真实数据库：临时 DATA_DIR + 直接 require 路由。
 * 模式照 api-routes-test.cjs（同样是为了绕开安全通道，只验业务逻辑）。
 *
 * 跑法：node testjs/smoke/album-photo-info-test.cjs
 */
const http = require('node:http')
const { makeTempDir, removeDirWithRetry } = require('./_tmpdir.cjs')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const BACKEND = path.join(__dirname, '..', '..', 'student-backend')
const BACKEND_MODULES = path.join(BACKEND, 'node_modules')

// 隔离环境：必须早于 require dbManager（它在加载时校验主密钥）
const DATA_DIR = makeTempDir('banji-photo-info-')
process.env.DB_MASTER_KEY = 'photo-info-smoke-master-key'
process.env.DATA_DIR = DATA_DIR
process.env.ALBUM_THUMBS_DIR = path.join(DATA_DIR, 'album-thumbs')

const express = require(path.join(BACKEND_MODULES, 'express'))
const sharp = require(path.join(BACKEND_MODULES, 'sharp'))
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const albumRouter = require(path.join(BACKEND, 'routes', 'album'))

const USERNAME = 'photo-info-smoke'
const { slug } = dbManager.createTeacher(USERNAME, 'not-a-real-hash', 'teacher')

let server = null
// 收尾必须覆盖 setup 阶段：原先 try 从「起完监听」才开始，建库/造数据/监听任一步抛错
// 都会直接 exit(2)，临时目录与端口全留着（每失败一次漏一个目录）。
async function cleanup() {
  if (server) {
    await new Promise((r) => {
      const t = setTimeout(r, 2000)      // keep-alive 连接会让 close 迟迟不回调
      try { server.closeAllConnections?.() } catch (_) { /* 老版本无此方法 */ }
      server.close(() => { clearTimeout(t); r() })
    })
    server = null
  }
  try { dbManager.evictConn(slug) } catch (_) { /* best-effort：关闭库连接 */ }
  await removeDirWithRetry(DATA_DIR)
}

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && detail !== undefined) {
    console.log('    →', typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300))
  }
}

function request(port, { method = 'GET', path: reqPath = '/', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      let text = ''
      res.on('data', (c) => { if (text.length < 8000) text += c.toString('utf8') })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch (_) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, text })
      })
    })
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }) })
    req.end()
  })
}

async function makeJpegWithExif() {
  const out = path.join(DATA_DIR, 'shot.jpg')
  await sharp({ create: { width: 640, height: 480, channels: 3, background: '#88aacc' } })
    .jpeg({ quality: 90 })
    .withMetadata({
      // Orientation 只能用顶层选项写（写进 exif.IFD0 会被 sharp 忽略）；
      // 它只写标签不旋转像素，正好模拟手机竖拍：存储 640x480，观感 480x640。
      orientation: 6,
      exif: {
        IFD0: { Make: 'TestMake', Model: 'TestModel 3000' },
        IFD2: { ColorSpace: '1', DateTimeOriginal: '2024:05:06 10:11:12' },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '31/1 14/1 49/1',
          GPSLongitudeRef: 'E',
          GPSLongitude: '121/1 28/1 25/1',
        },
      },
    })
    .toFile(out)
  return out
}

// ③ 带 ICC v4 广色域 profile 的图：验证「色域」不是只靠 EXIF ColorSpace 猜的。
// sharp 内置的 P3 profile 用的是 v4 的 mluc 标签（内容 "sP3C"），
// 只认 v2 desc 标签的实现会读空、然后错误地回落到 ColorSpace=1 报成 sRGB。
async function makeP3Jpeg() {
  const out = path.join(DATA_DIR, 'p3.jpg')
  await sharp({ create: { width: 120, height: 90, channels: 3, background: '#aa7744' } })
    .jpeg()
    .withMetadata({ icc: 'p3' })
    .toFile(out)
  return out
}

;(async () => {
  const jpgPath = await makeJpegWithExif()
  const p3Path = await makeP3Jpeg()
  // ② 扩展名是 .jpg 但内容不是图片：sharp 读不动，应走「读不到就留空」分支
  const junkPath = path.join(DATA_DIR, 'broken.jpg')
  fs.writeFileSync(junkPath, Buffer.alloc(2048, 0x41))

  dbManager.withDb(slug, () => {
    const conn = dbManager.current()
    conn.prepare('INSERT INTO albums (id, name, folder_path, kind) VALUES (?, ?, ?, ?)')
      .run(1, '冒烟相册', DATA_DIR, 'virtual')
    conn.prepare('INSERT INTO album_photos (id, album_id, file_path, file_name, file_size) VALUES (?, ?, ?, ?, ?)')
      .run(1, 1, jpgPath, 'shot.jpg', fs.statSync(jpgPath).size)
    conn.prepare('INSERT INTO album_photos (id, album_id, file_path, file_name, file_size) VALUES (?, ?, ?, ?, ?)')
      .run(2, 1, junkPath, 'broken.jpg', fs.statSync(junkPath).size)
    conn.prepare('INSERT INTO album_photos (id, album_id, file_path, file_name, file_size) VALUES (?, ?, ?, ?, ?)')
      .run(3, 1, p3Path, 'p3.jpg', fs.statSync(p3Path).size)
  })

  const app = express()
  app.use(express.json({ limit: '4mb' }))
  const bind = (req, res, next) => {
    req.user = { username: USERNAME, role: 'teacher', dbSlug: slug }
    dbManager.withDb(slug, () => next())
  }
  app.use('/api/album', bind, albumRouter)

  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const port = server.address().port

  try {
    // ---------- ① 带 EXIF ----------
    const r1 = await request(port, { path: '/api/album/photo/1/info' })
    const d1 = r1.json && r1.json.data
    check('① 200', r1.status === 200, r1.text)
    check('① fileName', d1 && d1.fileName === 'shot.jpg', d1 && d1.fileName)
    check('① filePath 是绝对路径且指向源文件', d1 && d1.filePath === jpgPath, d1 && d1.filePath)
    check('① fileSize 取磁盘实际大小', d1 && d1.fileSize === fs.statSync(jpgPath).size, d1 && d1.fileSize)
    check('① 分辨率按观感交换（640x480 + orientation 6 → 480x640）',
      d1 && d1.width === 480 && d1.height === 640, d1 && `${d1.width}x${d1.height}`)
    check('① 色域 sRGB', d1 && d1.colorSpace === 'sRGB', d1 && d1.colorSpace)
    check('① 拍摄时间', d1 && d1.takenAt === '2024-05-06 10:11:12', d1 && d1.takenAt)
    check('① 拍摄设备（厂牌+型号去重拼接）', d1 && d1.camera === 'TestMake TestModel 3000', d1 && d1.camera)
    const latExpect = 31 + 14 / 60 + 49 / 3600
    const lngExpect = 121 + 28 / 60 + 25 / 3600
    check('① 纬度（度分秒 → 十进制）', d1 && Math.abs(d1.lat - latExpect) < 1e-9, d1 && d1.lat)
    check('① 经度（度分秒 → 十进制）', d1 && Math.abs(d1.lng - lngExpect) < 1e-9, d1 && d1.lng)

    // ---------- ② 读不动文件 ----------
    const r2 = await request(port, { path: '/api/album/photo/2/info' })
    const d2 = r2.json && r2.json.data
    check('② 200（不因读不动元数据而报错）', r2.status === 200, r2.text)
    check('② 文件名仍可用', d2 && d2.fileName === 'broken.jpg', d2 && d2.fileName)
    check('② 大小仍可用', d2 && d2.fileSize === 2048, d2 && d2.fileSize)
    check('② 分辨率留空', d2 && d2.width === null && d2.height === null, d2 && `${d2.width}x${d2.height}`)
    check('② 色域/设备/经纬度留空',
      d2 && d2.colorSpace === '' && d2.camera === '' && d2.lat === null && d2.lng === null, d2)

    // ---------- ③ 广色域 ICC ----------
    const r4 = await request(port, { path: '/api/album/photo/3/info' })
    const d4 = r4.json && r4.json.data
    check('③ 200', r4.status === 200, r4.text)
    check('③ ICC v4 (mluc) 的 P3 profile 识别为 Display P3', d4 && d4.colorSpace === 'Display P3', d4 && d4.colorSpace)

    // ---------- ④ 不存在的照片 ----------
    const r3 = await request(port, { path: '/api/album/photo/9999/info' })
    check('④ 不存在 → 404', r3.status === 404, r3.text)
  } finally {
    await cleanup()
  }

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
})().catch(async (e) => {
  console.error('冒烟异常：', e)
  await cleanup()
  process.exit(2)
})
