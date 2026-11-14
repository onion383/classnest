// =========================================================================
// data-export-zip.test.js —— 数据导出 /api/data/zip 的流式打包（v6 · 4-11 P2-01）
//
// 这个端点过去把「收据整文件 readFileSync → buildZip（deflate 副本 + 局部块 Buffer
// + 终包 concat）」全放在内存里，几百 MB 收据时后端会被顶爆。本文件锁三件事：
//   ① 收据按磁盘路径流式读，不读进内存（Spy 住 readFileSync 断言没被调用）
//   ② 响应不再预置 Content-Length（预置就必须先把整包拼出来才能知道长度）
//   ③ 出来的包仍能被标准解压器逐字节读回，且加密开关确实交给了写入器
//
// 手法：真 DATA_DIR（临时目录） + 真 Express router + 真 HTTP + yauzl 读回。
// =========================================================================
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const yauzl = backendRequire('yauzl')
const express = backendRequire('express')

// 必须在 require 路由之前把数据目录指到临时目录：dbManager 在模块加载时就把
// dataDir / uploadsDir 算好了，晚一步就会落到真实用户目录里。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-export-zip-'))
process.env.DATA_DIR = tmp
// 真路由会加载 dbManager，它要求主密钥存在；本用例不碰 index.db，给个测试值即可
process.env.DB_MASTER_KEY = 'test-only-master-key'

const router = require('../../student-backend/routes/dataExport')

// v2 布局：上传文件在 content/uploads，dbManager.uploadsDir 也指向这里
const uploads = path.join(tmp, 'content', 'uploads')
fs.mkdirSync(uploads, { recursive: true })

function readZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    const out = []
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err)
      zip.on('error', reject)
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) { zip.readEntry(); return }
        zip.openReadStream(entry, (e, rs) => {
          if (e) return reject(e)
          const chunks = []
          rs.on('data', (c) => chunks.push(c))
          rs.on('end', () => {
            out.push({ name: entry.fileName, data: Buffer.concat(chunks), crc: entry.crc32 })
            zip.readEntry()
          })
          rs.on('error', reject)
        })
      })
      zip.on('end', () => resolve(out))
      zip.readEntry()
    })
  })
}

let server
let base
test.before(async () => {
  const app = express()
  app.use(express.json({ limit: '20mb' }))
  app.use('/api/data', router)
  await new Promise((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})

test.after(() => {
  server?.close()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) { /* 清理失败不影响结论 */ }
})

function postZip(body) {
  return fetch(`${base}/api/data/zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('收据按路径流式进包：不整文件读进内存，包仍能被标准解压器读回', async () => {
  const name = '收据.pdf'
  const data = Buffer.alloc(2 * 1024 * 1024)
  for (let i = 0; i < data.length; i++) data[i] = i % 251
  const abs = path.join(uploads, name)
  fs.writeFileSync(abs, data)

  // 旧实现用 readFileSync 把收据整份装进 Buffer；改成流式后这里必须一次都不出现
  const seen = []
  const orig = fs.readFileSync
  fs.readFileSync = function (p, ...rest) {
    seen.push(path.resolve(String(p)))
    return orig.call(this, p, ...rest)
  }
  let res
  try {
    res = await postZip({
      entries: [{ name: '学生名单.csv', data: Buffer.from('姓名\n张三').toString('base64') }],
      receiptGroups: [{ code: 'F001', items: [{ path: `/uploads/${name}`, name }] }],
    })
  } finally {
    fs.readFileSync = orig
  }

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/zip')
  assert.equal(res.headers.get('content-length'), null, '预置 Content-Length 就必须先拼出整包')
  assert.equal(seen.includes(path.resolve(abs)), false, '收据不能整文件读进内存')

  const zipPath = path.join(tmp, 'out.zip')
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
  const entries = await readZipEntries(zipPath)
  const byName = new Map(entries.map((e) => [e.name, e]))
  assert.equal(byName.get('学生名单.csv').data.toString('utf8'), '姓名\n张三')
  assert.equal(byName.get('收据文件/F001/收据.pdf').data.equals(data), true, '收据内容必须逐字节一致')
})

test('收据文件不存在时只跳过该文件，其它条目照常出包', async () => {
  const res = await postZip({
    entries: [{ name: '班费.xlsx', data: Buffer.from('X').toString('base64') }],
    receiptGroups: [{ code: 'F002', items: [{ path: '/uploads/不存在.pdf', name: '不存在.pdf' }] }],
  })
  assert.equal(res.status, 200)
  const zipPath = path.join(tmp, 'skip.zip')
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
  const names = (await readZipEntries(zipPath)).map((e) => e.name)
  assert.deepEqual(names, ['班费.xlsx'], '缺文件不应拖垮整包，也不该留下空条目')
})

test('密码交给流式写入器：本地头置加密位（ZipCrypto 仍可用）', async () => {
  const res = await postZip({
    entries: [{ name: '数据.csv', data: Buffer.from('a,b\n1,2').toString('base64') }],
    password: 'Test1234',
  })
  assert.equal(res.status, 200)
  const buf = Buffer.from(await res.arrayBuffer())
  assert.equal(buf.readUInt32LE(0), 0x04034b50, '必须是一个 ZIP 本地头')
  assert.equal(buf.readUInt16LE(6) & 0x0001, 0x0001, '传了密码就必须置加密位')
  assert.equal(buf.readUInt16LE(6) & 0x0008, 0, '加密条目不能用数据描述符（CRC 要在本地头）')
})
