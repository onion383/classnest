// =========================================================================
// zip64.test.js —— 备份包 >4GB 的 ZIP64 写出结构（N2 · 照片多的账号备份会过 4GB）
//
// 判据：真跑 zipStream 写出一个 >4GB 条目（稀疏源 + store），但 sink 是丢弃型——
//   只保留结构小 chunk（本地头/描述符/中央目录/EOCD），丢掉 256KB 数据体，
//   所以不占盘、几秒跑完。断言 ZIP64 的四个结构都在正确位置。
//   yauzl 读回 4GB 尺寸的端到端验证见清单批次 65（一次性脚本，不入库）。
// =========================================================================
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Writable } = require('node:stream')
const test = require('node:test')
const assert = require('node:assert/strict')
const { abs } = require('#testjs/paths')

const { createZipWriter } = require(abs('student-backend/services/zipStream.js'))
const { createRequire } = require('node:module')
const backendRequire = createRequire(abs('student-backend/package.json'))
const yauzl = backendRequire('yauzl')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zip64-'))
const BIG = 4 * 1024 * 1024 * 1024 + 4096

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

// 丢弃型 sink：小 chunk 全留（结构字节），大 chunk（数据体 / central+tail）只留头部和尾部。
// central+tail 是大 chunk 但 ZIP64 结构在尾部，所以尾部 400 字节必须留。
function structureSink() {
  const kept = []
  let lastTail = Buffer.alloc(0)
  let total = 0
  const sink = new Writable({
    write(chunk, _enc, cb) {
      total += chunk.length
      if (chunk.length < 1024) {
        kept.push(Buffer.from(chunk))
        lastTail = Buffer.from(chunk) // close() 的 central+tail 也是小 chunk，最后一次写入即它
      } else {
        kept.push(Buffer.from(chunk.subarray(0, 64)))
        lastTail = Buffer.from(chunk.subarray(-400))
      }
      cb()
    },
  })
  return { sink, kept, total: () => total, lastTail: () => lastTail }
}

test('ZIP64 条目：本地头 extra / 24 字节描述符 / 中央目录 extra 都写出', async () => {
  const src = path.join(tmp, 'big1.bin')
  const fd = fs.openSync(src, 'w')
  fs.ftruncateSync(fd, BIG)
  fs.closeSync(fd)

  const { sink, kept } = structureSink()
  const writer = createZipWriter(sink)
  const rec = await writer.add({ name: 'big.bin', path: src }) // store
  const stats = await writer.close()

  assert.equal(rec.size, BIG, '条目原始尺寸必须是 4GB+（稀疏源 stat）')
  assert.ok(stats.bytes > 4 * 1024 * 1024 * 1024, '写出字节数必须过 4GB')

  const all = Buffer.concat(kept)
  // 本地头 ZIP64 extra：id=0x0001, size=16（两个 8 字节占位）
  assert.ok(all.includes(Buffer.from([0x01, 0x00, 0x10, 0x00])), '本地头必须带 ZIP64 extra（0x0001/16）')
  // 中央目录 ZIP64 extra：id=0x0001, size=24（raw/comp/offset 三个 8 字节）
  assert.ok(all.includes(Buffer.from([0x01, 0x00, 0x18, 0x00])), '中央目录必须带 ZIP64 extra（0x0001/24）')
  // 数据描述符签名 0x08074b50 后跟 20 字节（8+8 的 64 位尺寸）
  const desc = Buffer.from([0x50, 0x4b, 0x07, 0x08])
  const at = all.indexOf(desc)
  assert.ok(at >= 0, '必须有数据描述符签名')
  assert.ok(at + 24 <= all.length, '描述符后必须有 8+8 的 64 位尺寸区')
})

test('ZIP64 EOCD：过 4GB 的整包写出 EOCD64 + locator + 哨兵经典 EOCD', async () => {
  const src = path.join(tmp, 'big2.bin')
  if (!fs.existsSync(src)) {
    const fd = fs.openSync(src, 'w')
    fs.ftruncateSync(fd, BIG)
    fs.closeSync(fd)
  }

  const { sink, lastTail } = structureSink()
  const writer = createZipWriter(sink)
  await writer.add({ name: 'big.bin', path: src })
  const stats = await writer.close()
  assert.ok(stats.bytes > 4 * 1024 * 1024 * 1024)

  // close() 最后一次写入是 central+tail，其尾部 400 字节连续含 EOCD64/locator/EOCD 三块
  const tail = lastTail()
  const eocd64 = Buffer.from([0x50, 0x4b, 0x06, 0x06])
  const locator = Buffer.from([0x50, 0x4b, 0x06, 0x07]) // 0x07064b50 小端
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  assert.ok(tail.includes(eocd64), '必须有 ZIP64 EOCD record（0x06064b50）')
  assert.ok(tail.includes(locator), '必须有 ZIP64 locator（0x07064b50）')
  const eocdAt = tail.lastIndexOf(eocd)
  assert.ok(eocdAt >= 0, '必须保留经典 EOCD（0x06054b50）')
  assert.equal(tail.readUInt16LE(eocdAt + 8), 0xffff, 'EOCD entry count 必须是 0xffff')
  assert.equal(tail.readUInt32LE(eocdAt + 12), 0xffffffff, 'EOCD central size 必须是哨兵')
  assert.ok(tail.lastIndexOf(eocd64) < tail.indexOf(locator), 'EOCD64 必须在 locator 之前')
  assert.ok(tail.indexOf(locator) < eocdAt, 'locator 必须在经典 EOCD 之前')
})

test('统一 ZIP64：小包也写 ZIP64 结构，且 yauzl 能原样读回（回归关键）', async () => {
  // 统一前小包走 ZIP32、超限才 ZIP64；统一后所有包结构一致。这条同时验证两件事：
  // ① 小包的字节里也有 ZIP64 extra + EOCD64（结构确实统一了）
  // ② 读侧 yauzl 对这种"逻辑小、结构 ZIP64"的包仍能逐字节读回（不是只能读大包）
  const { sink, kept } = structureSink()
  const writer = createZipWriter(sink)
  await writer.add({ name: 'small.txt', data: Buffer.from('hello zip64') })
  await writer.close()
  const all = Buffer.concat(kept)
  assert.ok(all.includes(Buffer.from([0x01, 0x00, 0x10, 0x00])), '小包也要有 ZIP64 extra（0x0001/16）')
  assert.ok(all.includes(Buffer.from([0x01, 0x00, 0x18, 0x00])), '小包中央目录也要有 ZIP64 extra（0x0001/24）')
  assert.ok(all.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), '小包也要有 EOCD64')

  // 真写一个落盘小包，用 yauzl 读回——结构统一不能牺牲可读性
  const zipPath = path.join(tmp, 'small.zip')
  const ws = require('node:fs').createWriteStream(zipPath)
  const w = createZipWriter(ws)
  await w.add({ name: 'a.txt', data: Buffer.from('abc') })
  await w.add({ name: 'b.txt', data: Buffer.from('def'), method: 'deflate' })
  await w.close()
  ws.end()
  await new Promise((r) => ws.on('close', r))

  const entries = await new Promise((resolve, reject) => {
    const out = []
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err)
      zip.on('error', reject)
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (e, rs) => {
          if (e) return reject(e)
          const chunks = []
          rs.on('data', (c) => chunks.push(c))
          rs.on('end', () => { out.push({ name: entry.fileName, data: Buffer.concat(chunks), size: entry.uncompressedSize }); zip.readEntry() })
          rs.on('error', reject)
        })
      })
      zip.on('end', () => resolve(out))
      zip.readEntry()
    })
  })
  const byName = new Map(entries.map((e) => [e.name, e]))
  assert.equal(byName.get('a.txt').data.toString('utf8'), 'abc')
  assert.equal(byName.get('a.txt').size, 3)
  assert.equal(byName.get('b.txt').data.toString('utf8'), 'def')
  assert.equal(byName.get('b.txt').size, 3)
})

test('ZIP64 上限同源：写侧不再限 4GB，读侧闸与上传上限统一派生', () => {
  const { ZIP64_LIMITS } = require(abs('student-backend/services/backupArchive.js'))
  assert.ok(ZIP64_LIMITS.maxEntryBytes > 4 * 1024 * 1024 * 1024, '单条目闸必须过 4GB')
  assert.ok(ZIP64_LIMITS.maxTotalBytes > 4 * 1024 * 1024 * 1024, '总量闸必须过 4GB')
  assert.equal(ZIP64_LIMITS.uploadBytes, ZIP64_LIMITS.maxTotalBytes, '上传上限必须与解包总量闸一致')

  // multer 上限确实读的是同一常量，不是写死的 4GB
  const accountSrc = fs.readFileSync(abs('student-backend/routes/account.js'), 'utf8')
  assert.match(accountSrc, /ZIP64_LIMITS\.uploadBytes/, // @pin student-backend/services/backupArchive.js#ZIP64_LIMITS
    '上传上限必须从 ZIP64_LIMITS 派生（写侧放宽后读侧要同步）')
  assert.doesNotMatch(accountSrc, /fileSize:\s*4\s*\*\s*1024/, // @pin student-backend/services/backupArchive.js#ZIP64_LIMITS
    '不应再有写死的 4GB 上传上限')
})
