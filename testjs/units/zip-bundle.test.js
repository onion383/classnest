// =========================================================================
// zip-bundle.test.js —— 备份包的两块地基（v6 · A1-03/N3-03 Zip Slip + 3-3 流式打包）
//
// ① `sanitizeEntryName`：条目名里带 `../` 或盘符就能写出解压目录之外（Zip Slip）
// ② `writeZip` 流式打包：GB 级备份不能把整包读进内存 —— 写完必须能被标准解压器读回，
//    条目名、内容、CRC/尺寸都要对得上（写坏的包比不备份更糟）
//
// 手法：真写临时文件 + 用后端自带的 yauzl 读回来逐条比对（不用自造的读取器自证）。
// =========================================================================
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const yauzl = backendRequire('yauzl')

const { sanitizeEntryName, crc32 } = require('../../student-backend/services/zipWriter')
const { writeZip } = require('../../student-backend/services/zipStream')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-bundle-'))
const tmpFile = (name) => path.join(tmp, name)

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
            out.push({ name: entry.fileName, data: Buffer.concat(chunks), size: entry.uncompressedSize, crc: entry.crc32, method: entry.compressionMethod })
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

test('sanitizeEntryName：路径穿越 / 盘符 / 绝对路径都被归一', () => {
  const cases = [
    ['../../etc/passwd', 'etc/passwd'],
    ['a/../b/c.txt', 'b/c.txt'],
    ['/abs/x.txt', 'abs/x.txt'],
    ['C:\\Users\\x\\收据.pdf', 'Users/x/收据.pdf'],
    ['..\\..\\win.ini', 'win.ini'],
    ['', 'file'],
    [null, 'file'],
    ['收据/2026/a.pdf', '收据/2026/a.pdf'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(sanitizeEntryName(input), expected, `输入 ${JSON.stringify(input)}`)
  }
})

test('writeZip 支持 deflate 压缩：解压后内容一致、CRC 与尺寸都对', async () => {
  // 数据导出传的是表格文本，deflate 能显著减小体积；流式 deflate 必须仍写出
  // 「标准解压器能读回」的包（压缩方法写 8，数据描述符里的压缩/原始尺寸要分开记）
  const text = '姓名,学号\n张三,001\n'.repeat(2000)
  const zipPath = tmpFile('deflate.zip')
  const ws = fs.createWriteStream(zipPath)
  await writeZip([
    { name: '学生名单.csv', data: text, method: 'deflate' },
    { name: '原样.bin', data: 'plain', method: 'store' },
  ], ws)
  ws.end()
  await new Promise((r) => ws.on('close', r))

  const entries = await readZipEntries(zipPath)
  const byName = new Map(entries.map((e) => [e.name, e]))
  assert.equal(byName.get('学生名单.csv').data.toString('utf8'), text, 'deflate 条目解压后必须与原文一致')
  assert.equal(byName.get('学生名单.csv').crc >>> 0, crc32(Buffer.from(text, 'utf8')))
  assert.equal(byName.get('原样.bin').data.toString('utf8'), 'plain')
  // yauzl 校验的是「包的声明尺寸」，压缩方法写错时内容照样能读回，所以必须单独断言
  assert.equal(byName.get('学生名单.csv').method, 8, 'method=deflate 的条目压缩方法必须是 8')
  assert.equal(byName.get('原样.bin').method, 0, 'method=store 的条目压缩方法必须是 0')
})

test('writeZip 加密模式：本地头带 CRC/尺寸、不开数据描述符，标准 ZipCrypto 能解回原文', async () => {
  // 传统加密（ZipCrypto）下 CRC 必须写在本地头里（解压端用它校验 12 字节加密头），
  // 所以这条链路不能像明文那样用数据描述符 —— 否则 Windows 资源管理器会报「文件已损坏」。
  const password = 'Test1234'
  const text = '班费记录\n'.repeat(500)
  const srcPath = tmpFile('receipt-enc.bin')
  const fileData = Buffer.alloc(256 * 1024, 7)
  fs.writeFileSync(srcPath, fileData)

  const zipPath = tmpFile('encrypted.zip')
  const ws = fs.createWriteStream(zipPath)
  await writeZip([
    { name: '班费.csv', data: text, method: 'deflate' },
    { name: '收据/a.bin', path: srcPath },
  ], ws, { password })
  ws.end()
  await new Promise((r) => ws.on('close', r))

  const buf = fs.readFileSync(zipPath)
  const first = firstLocalHeader(buf)
  assert.equal(first.flags & 0x0001, 0x0001, '必须置加密位 bit0')
  assert.equal(first.flags & 0x0008, 0, '加密条目不得使用数据描述符（CRC 要在本地头里）')
  assert.equal(first.crc >>> 0, crc32(Buffer.from(text, 'utf8')), '本地头 CRC 必须是明文 CRC')
  assert.equal(first.compSize, zlib.deflateRawSync(Buffer.from(text, 'utf8')).length)

  const plain = decryptEntry(buf, first, password)
  assert.equal(plain.header[11], (first.crc >>> 24) & 0xff, '加密头第 12 字节必须是 CRC 高字节')
  assert.equal(zlib.inflateRawSync(plain.body).toString('utf8'), text)

  const second = firstLocalHeader(buf, '收据/a.bin')
  assert.equal(second.flags & 0x0008, 0, '大文件同样不能用数据描述符')
  assert.equal(second.method, 0, '整文件加密走 store（压缩率接近 0 且要预读 CRC）')
  assert.equal(second.crc >>> 0, crc32(fileData))
  assert.equal(decryptEntry(buf, second, password).body.equals(fileData), true, '大文件必须逐字节解回')
})

// 取本地头：yauzl 不支持加密条目，这里只解析头部字段（不依赖库的判断）
function firstLocalHeader(buf, name) {
  let pos = 0
  while (pos + 30 <= buf.length) {
    const sig = buf.readUInt32LE(pos)
    if (sig !== 0x04034b50) break
    const nameLen = buf.readUInt16LE(pos + 26)
    const extraLen = buf.readUInt16LE(pos + 28)
    const entryName = buf.subarray(pos + 30, pos + 30 + nameLen).toString('utf8')
    const head = {
      flags: buf.readUInt16LE(pos + 6),
      method: buf.readUInt16LE(pos + 8),
      crc: buf.readUInt32LE(pos + 14),
      compSize: buf.readUInt32LE(pos + 18),
      rawSize: buf.readUInt32LE(pos + 22),
      bodyStart: pos + 30 + nameLen + extraLen,
    }
    if (!name || entryName === name) return head
    // 加密条目的正文前面还有 12 字节加密头，它不计入 compSize
    pos = head.bodyStart + (head.flags & 0x0001 ? 12 : 0) + head.compSize
  }
  throw new Error(`本地头里找不到条目：${name || '第一个'}`)
}

// 测试专用的 ZipCrypto 解密（与生产加密实现同源的 PKZIP 标准算法）：
// yauzl 不支持加密条目，而「能解回原文」才是加密包没写坏的证据。
function decryptEntry(buf, head, password) {
  const TABLE = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()
  const crcByte = (crc, b) => (crc >>> 8) ^ TABLE[(crc ^ b) & 0xff]
  let key0 = 0x12345678
  let key1 = 0x23456789
  let key2 = 0x34567890
  const update = (b) => {
    key0 = crcByte(key0, b)
    key1 = (Math.imul((key1 + (key0 & 0xff)) >>> 0, 134775813) + 1) >>> 0
    key2 = crcByte(key2, (key1 >>> 24) & 0xff)
  }
  const streamByte = () => {
    const temp = (key2 | 2) >>> 0
    return (Math.imul(temp, temp ^ 1) >>> 8) & 0xff
  }
  for (const b of Buffer.from(password, 'utf8')) update(b)

  const raw = buf.subarray(head.bodyStart, head.bodyStart + 12 + head.compSize)
  const out = Buffer.allocUnsafe(raw.length)
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] ^ streamByte()
    out[i] = p
    update(p)
  }
  return { header: out.subarray(0, 12), body: out.subarray(12) }
}

test('writeZip 流式打包：磁盘文件 + 内存条目都能被标准解压器原样读回', async () => {
  // 造一个 512KB 的伪二进制文件（流式路径走的是 createReadStream，不是 Buffer）
  const srcPath = tmpFile('receipt.bin')
  const payload = Buffer.alloc(512 * 1024)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251
  fs.writeFileSync(srcPath, payload)

  const zipPath = tmpFile('bundle.zip')
  const ws = fs.createWriteStream(zipPath)
  const stats = await writeZip([
    { name: 'db/@abc.db', data: Buffer.from('假库文件') },
    { name: 'manifest.json', data: JSON.stringify({ version: 3, files: 2 }) },
    { name: 'uploads/收据/2026/a.bin', path: srcPath },
    { name: '../逃逸.txt', data: 'no' },
  ], ws)
  ws.end()
  await new Promise((r) => ws.on('close', r))

  assert.equal(stats.entries, 4)
  assert.ok(stats.bytes > 0)
  assert.ok(fs.statSync(zipPath).size >= stats.bytes - 22, '磁盘上的包大小应与统计一致')

  const entries = await readZipEntries(zipPath)
  const byName = new Map(entries.map((e) => [e.name, e]))
  assert.deepEqual([...byName.keys()].sort(), ['db/@abc.db', 'manifest.json', 'uploads/收据/2026/a.bin', '逃逸.txt'].sort(), '条目名必须被净化')
  assert.equal(byName.get('db/@abc.db').data.toString('utf8'), '假库文件')
  assert.equal(byName.get('uploads/收据/2026/a.bin').data.equals(payload), true, '二进制内容必须逐字节一致（CRC/尺寸对不上会被 yauzl 判坏包）')
  assert.equal(byName.get('uploads/收据/2026/a.bin').size, payload.length)
  // yauzl **不校验 CRC32**（只校验尺寸），所以必须自己比：中央目录写错 CRC 时，
  // Windows 资源管理器会报「文件已损坏」，而这里如果只比内容就发现不了。
  assert.equal(byName.get('uploads/收据/2026/a.bin').crc >>> 0, crc32(payload), '中央目录 CRC 必须与内容一致')
  assert.equal(byName.get('db/@abc.db').crc >>> 0, crc32(Buffer.from('假库文件')), '小条目的 CRC 也要对')
})

test('空清单也能写出一个合法的空包（解压器不报错）', async () => {
  const zipPath = tmpFile('empty.zip')
  const ws = fs.createWriteStream(zipPath)
  await writeZip([], ws)
  ws.end()
  await new Promise((r) => ws.on('close', r))
  const entries = await readZipEntries(zipPath)
  assert.deepEqual(entries, [])
})

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) { /* 清理失败不影响结论 */ }
})
