// =========================================================================
// zipStream.js —— 流式写 ZIP，专供「整库备份包」与「数据导出」这类可能上 GB 的出口
//
// 为什么不复用内存版打包：把所有条目同时驻留内存再拼终包，等于文件大小 × 4
// （原始 Buffer + 压缩副本 + 每条局部块 + 终包 concat）。几百 MB 收据就会把后端顶爆
// （审查 v6 · P2-01）。这里改成「边读边写」：任何时刻只持有一个 256KB 块。
//
// 关键取舍：
//   · **明文条目用数据描述符**（bit 3）：CRC 只能在数据流完后才知道，所以本地头里先写 0，
//     数据后面跟 16 字节描述符。yauzl / Windows 资源管理器 / 7-Zip 都支持。
//   · **加密条目不能用数据描述符**：ZipCrypto 的 12 字节加密头里第 12 字节是 CRC 高字节，
//     解压端要靠它校验口令，所以 CRC 必须在本地头里。做法是先读一遍算 CRC（文件条目），
//     再把 CRC/尺寸写进本地头；文件条目用 store 而不是 deflate —— 两者都要预读一遍，
//     而 store 让「压缩后尺寸」直接等于文件大小，不必为拿尺寸再压一遍。
//   · **统一 ZIP64**：所有条目恒写 ZIP64（extra field 0x0001 + 24 字节数据描述符 + ZIP64 EOCD），
//     不按尺寸在 ZIP32/ZIP64 间切换——切换要靠 statSync 预知尺寸，文件在写入期间变动会让本地头 /
//     描述符 / 中央目录三处的 zip64 决定错配，写出尺寸撒谎的包。读侧 yauzl 原生支持；代价是小包
//     多几十字节、不再兼容很老的解压器（Win10+ / 7-Zip / macOS / yauzl 都支持 ZIP64）。
//   · 文件名一律过 sanitizeEntryName（Zip Slip 的唯一净化点）。
//
// 为什么要 createZipWriter（增量）而不只是 writeZip：备份包的 manifest 必须
// 在**所有文件写完之后**才能生成（要有每项的字节数与 sha256），所以需要「边加边算、
// 最后再追加一个条目」。条目可带 `hash: true` 顺带算 sha256 —— 单遍 IO。
// =========================================================================
const fs = require('node:fs')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { once } = require('node:events')
const { Readable, Writable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { crc32Start, crc32Update, crc32End, createZipCrypto, sanitizeEntryName } = require('./zipWriter')

const MAX32 = 0xffffffff
const CHUNK = 256 * 1024

// ---- ZIP64 辅助（APPNOTE 6.3.10 §4.5.3 / §4.3.9.2 / §4.3.14-16）----
// extra field 0x0001：header id + size + 按固定顺序的 64 位值。
// local header 必须同时带 raw/comp（§4.5.3）；central 只带对应字段为哨兵的值。
function zip64Extra(values) {
  const body = Buffer.alloc(8 * values.length)
  values.forEach((v, i) => body.writeBigUInt64LE(BigInt(v), i * 8))
  const head = Buffer.alloc(4)
  head.writeUInt16LE(0x0001, 0) // ZIP64 extended information extra field
  head.writeUInt16LE(body.length, 2)
  return Buffer.concat([head, body])
}

function dosDateTime(d) {
  const year = Math.max(d.getFullYear(), 1980)
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
  }
}

async function writeChunk(writable, buf) {
  if (!writable.write(buf)) await once(writable, 'drain')
}

function toBuffer(data) {
  return Buffer.isBuffer(data) ? data : Buffer.from(String(data == null ? '' : data), 'utf8')
}

function crc32Of(buf) {
  return crc32End(crc32Update(crc32Start(), buf))
}

function sourceOf(entry) {
  if (entry.path) return fs.createReadStream(entry.path, { highWaterMark: CHUNK })
  return Readable.from([toBuffer(entry.data)])
}

/**
 * 创建一个增量 ZIP 写入器。
 * @param {import('node:stream').Writable} writable 目标流（通常是 fs.createWriteStream 或 res）
 * @param {{ now?: Date, password?: string }} [opts] 传 password 则整包走 ZipCrypto
 */
function createZipWriter(writable, opts = {}) {
  const now = dosDateTime(opts.now || new Date())
  const password = opts.password ? String(opts.password) : ''
  const central = []
  let offset = 0
  let count = 0
  let closed = false

  // 中央目录恒写 ZIP64：三个字段都写哨兵，extra 按固定顺序带全 64 位真值（§4.5.3）。
  // 全带（而非只带溢位项）更简单且合规——reader 忽略用不到的项。
  function addCentral({ nameBytes, flags, method, crc, compSize, rawSize, localOffset }) {
    const extra = zip64Extra([rawSize, compSize, localOffset])
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(45, 4) // version made by / needed 4.5
    cd.writeUInt16LE(45, 6)
    cd.writeUInt16LE(flags, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(now.time, 12)
    cd.writeUInt16LE(now.date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(MAX32, 20) // compressed size = 哨兵
    cd.writeUInt32LE(MAX32, 24) // uncompressed size = 哨兵
    cd.writeUInt16LE(nameBytes.length, 28)
    cd.writeUInt16LE(extra.length, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(MAX32, 42) // local header offset = 哨兵
    central.push(Buffer.concat([cd, nameBytes, extra]))
  }

  // 本地头恒写 ZIP64：size 字段恒为哨兵，真值走 extra（流式 bit3 写占位 0，加密条目写真值）。
  function localHeader({ nameBytes, flags, method, crc, extra }) {
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(45, 4) // version needed 4.5
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(now.time, 10)
    local.writeUInt16LE(now.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(MAX32, 18) // compressed size = 哨兵
    local.writeUInt32LE(MAX32, 22) // uncompressed size = 哨兵
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(extra.length, 28) // 20 字节 ZIP64 extra（id+size+两个 8 字节）
    return local
  }

  // 明文：本地头先写哨兵 + 20 字节占位 extra，数据流完再补 24 字节数据描述符（bit3）。
  // 尺寸不预知——恒用 64 位字段，文件在写入期间变大也不会格式错配（统一 ZIP64 的收益）。
  async function addStreamed(entry, name, nameBytes, localOffset, method) {
    const flags = 0x0800 | 0x0008
    const zip64LocalExtra = Buffer.alloc(20) // id+size+两个 8 字节占位(0)，真值走描述符
    zip64LocalExtra.writeUInt16LE(0x0001, 0)
    zip64LocalExtra.writeUInt16LE(16, 2)
    await writeChunk(writable, Buffer.concat([
      localHeader({ nameBytes, flags, method, crc: 0, extra: zip64LocalExtra }),
      nameBytes, zip64LocalExtra,
    ]))
    offset += 30 + nameBytes.length + zip64LocalExtra.length

    const hasher = entry.hash ? crypto.createHash('sha256') : null
    let crc = crc32Start()
    let rawSize = 0
    const track = async function* () {
      for await (const chunk of sourceOf(entry)) {
        crc = crc32Update(crc, chunk)
        rawSize += chunk.length
        hasher?.update(chunk)
        yield chunk
      }
    }

    let compSize = 0
    if (method === 8) {
      // deflate 边压边写：sink 只负责转发与计数，不结束调用方的 writable
      const sink = new Writable({
        write(chunk, _enc, cb) {
          compSize += chunk.length
          offset += chunk.length
          if (writable.write(chunk)) cb()
          else writable.once('drain', cb)
        },
      })
      await pipeline(track(), zlib.createDeflateRaw(), sink)
    } else {
      for await (const chunk of track()) {
        compSize += chunk.length
        offset += chunk.length
        await writeChunk(writable, chunk)
      }
    }

    const crcValue = crc32End(crc)
    const desc = Buffer.alloc(24) // 签名 + CRC(4) + compSize(8) + rawSize(8)（§4.3.9.2）
    desc.writeUInt32LE(0x08074b50, 0)
    desc.writeUInt32LE(crcValue, 4)
    desc.writeBigUInt64LE(BigInt(compSize), 8)
    desc.writeBigUInt64LE(BigInt(rawSize), 16)
    await writeChunk(writable, desc)
    offset += desc.length

    addCentral({ nameBytes, flags, method, crc: crcValue, compSize, rawSize, localOffset })
    count += 1
    return { name, size: rawSize, sha256: hasher ? hasher.digest('hex') : undefined }
  }

  // 加密前置：CRC / 尺寸必须在写本地头之前拿到
  async function planEncrypted(entry, name) {
    if (entry.path) {
      const hasher = entry.hash ? crypto.createHash('sha256') : null
      let crc = crc32Start()
      let size = 0
      for await (const chunk of fs.createReadStream(entry.path, { highWaterMark: CHUNK })) {
        crc = crc32Update(crc, chunk)
        size += chunk.length
        hasher?.update(chunk)
      }
      // 收据 / 视频本身已是压缩格式，deflate 基本不缩小；store 让尺寸在写头时已知
      return { method: 0, crc: crc32End(crc), rawSize: size, compSize: size, sha256: hasher && hasher.digest('hex') }
    }
    const raw = toBuffer(entry.data)
    const deflated = zlib.deflateRawSync(raw, { level: 6 })
    return {
      method: 8,
      crc: crc32Of(raw),
      rawSize: raw.length,
      compSize: deflated.length,
      payload: deflated,
      sha256: entry.hash ? crypto.createHash('sha256').update(raw).digest('hex') : undefined,
    }
  }

  async function addEncrypted(entry, name, nameBytes, localOffset) {
    const plan = await planEncrypted(entry, name)
    const flags = 0x0800 | 0x0001 // bit11 UTF-8 文件名 / bit0 加密
    // 加密条目不用 bit3：本地头 size 是哨兵，ZIP64 extra 带 64 位真值（不是占位 0）。
    const extra = zip64Extra([plan.rawSize, plan.compSize])
    await writeChunk(writable, Buffer.concat([
      localHeader({ nameBytes, flags, method: plan.method, crc: plan.crc, extra }),
      nameBytes, extra,
    ]))
    offset += 30 + nameBytes.length + extra.length

    // 一个 key 流只对一个文件有效（PKZIP 规范），每个条目都从密码重新派生
    const cipher = createZipCrypto(password)
    // 12 字节加密头：前 11 字节随机，第 12 字节 = CRC 高字节（解压端据此判口令对不对）
    const header = Buffer.allocUnsafe(12)
    crypto.randomFillSync(header, 0, 11)
    header[11] = (plan.crc >>> 24) & 0xff
    const encHeader = cipher.encrypt(header)
    await writeChunk(writable, encHeader)
    offset += encHeader.length

    const writeEncrypted = async (chunk) => {
      const out = cipher.encrypt(chunk)
      await writeChunk(writable, out)
      offset += out.length
    }
    if (plan.payload) {
      // 内存条目本来就是小文件（表格文本），按块加密只为少一次整份副本
      for (let i = 0; i < plan.payload.length; i += CHUNK) await writeEncrypted(plan.payload.subarray(i, i + CHUNK))
    } else {
      for await (const chunk of fs.createReadStream(entry.path, { highWaterMark: CHUNK })) await writeEncrypted(chunk)
    }

    addCentral({ nameBytes, flags, method: plan.method, crc: plan.crc, compSize: plan.compSize, rawSize: plan.rawSize, localOffset })
    count += 1
    return { name, size: plan.rawSize, sha256: plan.sha256 }
  }

  async function add(entry) {
    if (closed) throw new Error('ZIP 已关闭，不能再追加条目')
    const name = sanitizeEntryName(entry.name)
    const nameBytes = Buffer.from(name, 'utf8')
    const localOffset = offset
    if (password) return addEncrypted(entry, name, nameBytes, localOffset)
    return addStreamed(entry, name, nameBytes, localOffset, entry.method === 'deflate' ? 8 : 0)
  }

  async function close() {
    if (closed) return { entries: count, bytes: offset }
    const centralBuf = Buffer.concat(central)
    // 恒写 ZIP64 EOCD：紧跟中央目录，其自身文件偏移 = offset + centralBuf.length（§4.3.14-15）
    const zip64EocdOffset = offset + centralBuf.length
    const z64 = Buffer.alloc(56)
    z64.writeUInt32LE(0x06064b50, 0)
    z64.writeBigUInt64LE(44n, 4) // record size = 固定 56 - 前 12 字节
    z64.writeUInt16LE(45, 12)    // version made by / needed 4.5
    z64.writeUInt16LE(45, 14)
    z64.writeUInt32LE(0, 16)     // number of this disk
    z64.writeUInt32LE(0, 20)     // disk with start of central dir
    z64.writeBigUInt64LE(BigInt(count), 24) // entries on this disk
    z64.writeBigUInt64LE(BigInt(count), 32) // total entries
    z64.writeBigUInt64LE(BigInt(centralBuf.length), 40)
    z64.writeBigUInt64LE(BigInt(offset), 48) // central dir offset
    const loc = Buffer.alloc(20)
    loc.writeUInt32LE(0x07064b50, 0)
    loc.writeUInt32LE(0, 4)
    loc.writeBigUInt64LE(BigInt(zip64EocdOffset), 8)
    loc.writeUInt32LE(1, 16) // total disks
    const end = Buffer.alloc(22) // 经典 EOCD，字段写哨兵（§4.3.16）
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0xffff, 4)
    end.writeUInt16LE(0xffff, 6)
    end.writeUInt16LE(0xffff, 8)
    end.writeUInt16LE(0xffff, 10)
    end.writeUInt32LE(MAX32, 12)
    end.writeUInt32LE(MAX32, 16)
    end.writeUInt16LE(0, 20)
    const tail = Buffer.concat([z64, loc, end])
    await writeChunk(writable, Buffer.concat([centralBuf, tail]))
    closed = true
    return { entries: count, bytes: offset + centralBuf.length + tail.length }
  }

  return { add, close }
}

/** 一次性写一批条目（保留原 API，内部是 createZipWriter 的薄封装） */
async function writeZip(entries, writable, opts = {}) {
  const zip = createZipWriter(writable, opts)
  const added = []
  for (const entry of Array.isArray(entries) ? entries : []) added.push(await zip.add(entry))
  const stats = await zip.close()
  return { ...stats, added }
}

module.exports = { createZipWriter, writeZip }
