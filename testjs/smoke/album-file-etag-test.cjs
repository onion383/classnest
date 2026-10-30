/**
 * 相册源文件接口冒烟：GET /api/album/photo/:photoId/file 的 ETag / 304 / Range 语义
 *
 * 为什么单独测：`Cache-Control: no-cache` 只是「用之前必须回来问」，以前没给 ETag，
 * 浏览器回来问也没得比，等于每次都全量重下 3~8MB。加了 ETag 之后必须守住三条契约：
 *   ① 没变 → 304 且没有 body（否则白加）
 *   ② 变了 → 不能给 304（否则用户看到旧图）
 *   ③ 带 Range 的请求不能被 304 拦掉；If-Range 对不上时必须退回 200 全量
 *      （否则视频/大图会把新旧两段拼成坏文件）
 *
 * 不启动完整后端：临时 DATA_DIR + 直接 require 路由，模式同 album-photo-info-test.cjs。
 *
 * 跑法：node testjs/smoke/album-file-etag-test.cjs
 */
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const BACKEND = path.join(__dirname, '..', '..', 'student-backend')
const BACKEND_MODULES = path.join(BACKEND, 'node_modules')

// 隔离环境：必须早于 require dbManager（它在加载时校验主密钥）
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banji-file-etag-'))
process.env.DB_MASTER_KEY = 'file-etag-smoke-master-key'
process.env.DATA_DIR = DATA_DIR
process.env.ALBUM_THUMBS_DIR = path.join(DATA_DIR, 'album-thumbs')

const express = require(path.join(BACKEND_MODULES, 'express'))
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const albumRouter = require(path.join(BACKEND, 'routes', 'album'))

const USERNAME = 'file-etag-smoke'
const { slug } = dbManager.createTeacher(USERNAME, 'not-a-real-hash', 'teacher')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && detail !== undefined) {
    console.log('    →', typeof detail === 'string' ? detail.slice(0, 200) : JSON.stringify(detail).slice(0, 200))
  }
}

// 收原始 Buffer 而不是拼字符串：要比字节数（Range 切片长度、全量长度）
function request(port, { method = 'GET', path: reqPath = '/', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        resolve({ status: res.statusCode, headers: res.headers, bytes: body.length, body })
      })
    })
    req.on('error', (e) => resolve({ status: 0, error: e.message, headers: {}, bytes: 0 }))
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, error: 'timeout', headers: {}, bytes: 0 }) })
    req.end()
  })
}

;(async () => {
  // 样本文件：内容无所谓，只看字节是否原样吐回；用伪随机保证不是全同字节
  const src = path.join(DATA_DIR, 'source.bin')
  const original = Buffer.alloc(3000)
  for (let i = 0; i < original.length; i++) original[i] = (i * 37 + 11) & 0xff
  fs.writeFileSync(src, original)

  dbManager.withDb(slug, () => {
    const conn = dbManager.current()
    conn.prepare('INSERT INTO albums (id, name, folder_path, kind) VALUES (?, ?, ?, ?)')
      .run(1, '冒烟相册', DATA_DIR, 'virtual')
    conn.prepare('INSERT INTO album_photos (id, album_id, file_path, file_name, file_size) VALUES (?, ?, ?, ?, ?)')
      .run(1, 1, src, 'source.jpg', original.length)
  })

  const app = express()
  app.use(express.json({ limit: '4mb' }))
  const bind = (req, res, next) => {
    req.user = { username: USERNAME, role: 'teacher', dbSlug: slug }
    dbManager.withDb(slug, () => next())
  }
  app.use('/api/album', bind, albumRouter)

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const port = server.address().port
  const FILE = '/api/album/photo/1/file'

  try {
    // ---------- ① 首次请求：200 + 带 ETag ----------
    const r1 = await request(port, { path: FILE })
    const etag = r1.headers.etag
    check('① 200', r1.status === 200, `status=${r1.status}`)
    check('① 响应带 ETag', typeof etag === 'string' && etag.startsWith('"') && etag.endsWith('"'), etag)
    check('① 全量字节数等于文件大小', r1.bytes === original.length, `${r1.bytes} vs ${original.length}`)
    check('① 字节内容原样', r1.body && r1.body.equals(original))
    check('① 仍声明 Accept-Ranges: bytes', r1.headers['accept-ranges'] === 'bytes', r1.headers['accept-ranges'])

    // ---------- ② 用同一个 ETag 再要：3000 字节 → 几十字节 ----------
    const r2 = await request(port, { path: FILE, headers: { 'If-None-Match': etag } })
    check('② 命中 ETag → 304', r2.status === 304, `status=${r2.status}`)
    check('② 304 没有 body', r2.bytes === 0, `bytes=${r2.bytes}`)
    check('② 304 也回带 ETag', r2.headers.etag === etag, r2.headers.etag)

    // ---------- ③ 对不上就不能误判 ----------
    const r3 = await request(port, { path: FILE, headers: { 'If-None-Match': '"deadbeef-0"' } })
    check('③ ETag 对不上 → 200 全量', r3.status === 200 && r3.bytes === original.length, `status=${r3.status} bytes=${r3.bytes}`)

    // ---------- ④ 多个候选值 / 通配符 ----------
    const r4 = await request(port, { path: FILE, headers: { 'If-None-Match': `"aaa", ${etag}, "bbb"` } })
    check('④ 逗号分隔里命中 → 304', r4.status === 304, `status=${r4.status}`)
    const r5 = await request(port, { path: FILE, headers: { 'If-None-Match': '*' } })
    check('④ 通配符 * → 304', r5.status === 304, `status=${r5.status}`)

    // ---------- ⑤ Range：不能被 304 拦掉 ----------
    const r6 = await request(port, { path: FILE, headers: { Range: 'bytes=100-199' } })
    check('⑤ Range → 206', r6.status === 206, `status=${r6.status}`)
    check('⑤ Content-Range 正确', r6.headers['content-range'] === `bytes 100-199/${original.length}`, r6.headers['content-range'])
    check('⑤ 只回 100 字节', r6.bytes === 100, `bytes=${r6.bytes}`)
    check('⑤ 字节是原文件的 100..199', r6.body && r6.body.equals(original.subarray(100, 200)))
    check('⑤ 206 也带 ETag', r6.headers.etag === etag, r6.headers.etag)
    // 浏览器若同时带 If-None-Match 与 Range，仍应给片段（片段请求不存在「没变」这回事）
    const r6b = await request(port, { path: FILE, headers: { Range: 'bytes=0-9', 'If-None-Match': etag } })
    check('⑤ Range + 命中 ETag 仍是 206', r6b.status === 206 && r6b.bytes === 10, `status=${r6b.status} bytes=${r6b.bytes}`)

    // ---------- ⑥ If-Range 契约 ----------
    const r7 = await request(port, { path: FILE, headers: { Range: 'bytes=0-9', 'If-Range': etag } })
    check('⑥ If-Range 匹配 → 正常 206', r7.status === 206 && r7.bytes === 10, `status=${r7.status} bytes=${r7.bytes}`)
    const r8 = await request(port, { path: FILE, headers: { Range: 'bytes=0-9', 'If-Range': '"stale-0"' } })
    check('⑥ If-Range 过期 → 忽略 Range 回 200 全量', r8.status === 200 && r8.bytes === original.length, `status=${r8.status} bytes=${r8.bytes}`)

    // ---------- ⑦ 文件真的变了：ETag 必须变，旧 ETag 不能再拿 304 ----------
    const changed = Buffer.from(original)
    changed[0] = (changed[0] + 1) & 0xff
    fs.writeFileSync(src, changed)
    const later = new Date(Date.now() + 5000) // 显式推后 mtime，避免同毫秒内写回导致 mtime 不变
    fs.utimesSync(src, later, later)

    const r9 = await request(port, { path: FILE })
    check('⑦ 文件变了 → ETag 也变', r9.headers.etag && r9.headers.etag !== etag, `${etag} → ${r9.headers.etag}`)
    const r10 = await request(port, { path: FILE, headers: { 'If-None-Match': etag } })
    check('⑦ 拿旧 ETag 请求 → 200 全量（不能给 304）', r10.status === 200 && r10.bytes === original.length, `status=${r10.status} bytes=${r10.bytes}`)

    // ---------- ⑧ 不存在的照片仍 404 ----------
    const r11 = await request(port, { path: '/api/album/photo/9999/file' })
    check('⑧ 不存在的 photoId → 404', r11.status === 404, `status=${r11.status}`)
  } finally {
    await new Promise((r) => server.close(r))
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch (_) { /* 句柄未释放 */ }
  }

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => {
  console.error('冒烟异常：', e)
  process.exit(2)
})
