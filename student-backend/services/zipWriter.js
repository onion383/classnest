// =========================================================================
// zipWriter.js —— 多文件 ZIP 打包（可选 ZipCrypto 传统加密）
//
// 为什么自己写而不装库：
//   后端现有依赖里没有 zip 写库（yauzl 只能读），而这个功能只需要「把若干内存
//   里的 Buffer 打成一个包」，实现量不大；electron/afterPack.js 里已有一份单文件
//   的 CRC32 + deflate 写法，这里扩成多文件并补上加密，不引入新依赖、不影响打包脚本。
//
// 为什么用 ZipCrypto 而不是 AES：
//   Windows 资源管理器双击就能输入密码解压，只有 ZipCrypto 支持；AES-256 必须装
//   WinRAR / 7-Zip / Bandizip，普通用户会看到「文件已损坏」。这是一个明确的取舍：
//   只防「随手打开」，挡不住针对性破解。强加密需求应走「导出数据库」那条链路。
//
// 关键实现约束：
//   - 用传统加密时 CRC 必须写在本地头里（不能用数据描述符），解压端要靠 CRC 高字节
//     校验 12 字节加密头是否解对了，所以这里一律不开 bit 3。
//   - 文件名走 UTF-8（通用标志位 bit 11），否则中文表名在解压后是乱码。
//   - 先 deflate 原始数据、再加密压缩结果（顺序反了就是「先加密再压缩」，体积和
//     兼容性都会出问题）。
// =========================================================================
const zlib = require('zlib')

// CRC32 — 与 afterPack.js 同款内置表，避免依赖 zlib.crc32 的 Node 版本差异
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

// ZipCrypto 的 key0 走的是同一张表，但作用在「上一次的 key0」上
function crc32Byte(crc, byte) {
  return (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]
}

// DOS 时间格式（不是 Unix 时间戳）：年份从 1980 起算，秒数按 2 秒粒度
function dosDateTime(d) {
  const year = Math.max(d.getFullYear(), 1980)
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
  }
}

// ---------- ZipCrypto ----------
// 三个 32 位 key 流，逐字节推进；解密字节由 key2 派生后与密文异或。
// 加密时也要用**明文**推进 key，所以 update 与 xor 必须成对、顺序固定。
function createZipCrypto(password) {
  let key0 = 0x12345678
  let key1 = 0x23456789
  let key2 = 0x34567890

  function update(byte) {
    key0 = crc32Byte(key0, byte)
    // key1 的乘法必须在 32 位内回绕：Math.imul 只取乘积低 32 位，正是 PKZIP 的行为
    key1 = (Math.imul((key1 + (key0 & 0xff)) >>> 0, 134775813) + 1) >>> 0
    key2 = crc32Byte(key2, (key1 >>> 24) & 0xff)
  }

  // 用 Math.imul 保持 32 位整数乘法不丢精度（key1 的乘数 134775813 > 2^24）
  function streamByte() {
    const temp = (key2 | 2) >>> 0
    return ((Math.imul(temp, temp ^ 1) >>> 8) & 0xff)
  }

  const pw = Buffer.from(String(password || ''), 'utf8')
  for (let i = 0; i < pw.length; i++) update(pw[i])

  return {
    // 就地加密：传明文，返回等长密文（加密头与正文共用同一个 key 流，必须连续调用）
    encrypt(plain) {
      const out = Buffer.allocUnsafe(plain.length)
      for (let i = 0; i < plain.length; i++) {
        const p = plain[i]
        out[i] = p ^ streamByte()
        update(p)
      }
      return out
    },
  }
}

/**
 * 把一组条目打成 ZIP。
 * @param {Array<{name: string, data: Buffer|string}>} entries 归档内路径与内容
 * @param {string} [password] 传了就走 ZipCrypto 加密；空串/未传 = 不加密
 * @returns {Buffer}
 */
function buildZip(entries, password) {
  const encrypted = !!password
  // 加密模式下一个 key 流只对**一个文件**有效，每个文件都要从密码重新派生（PKZIP 规范）
  const parts = []
  const central = []
  let offset = 0
  const now = dosDateTime(new Date())

  for (const entry of entries || []) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const crc = crc32(raw)
    const deflated = zlib.deflateRawSync(raw, { level: 6 })
    const nameBytes = Buffer.from(String(entry.name || 'file').replace(/\\/g, '/'), 'utf8')

    let payload = deflated
    if (encrypted) {
      const cipher = createZipCrypto(password)
      // 12 字节加密头：前 11 字节随机，第 12 字节 = CRC 高字节（解压端据此判密码对不对）
      const header = Buffer.allocUnsafe(12)
      require('crypto').randomFillSync(header, 0, 11)
      header[11] = (crc >>> 24) & 0xff
      const encHeader = cipher.encrypt(header)
      const encBody = cipher.encrypt(deflated)
      payload = Buffer.concat([encHeader, encBody])
    }

    const flags = 0x0800 | (encrypted ? 0x0001 : 0) // bit11 UTF-8 文件名 / bit0 加密

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // 解压所需版本
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(now.time, 10)
    local.writeUInt16LE(now.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // 扩展区长度

    const localOffset = offset
    const localBlock = Buffer.concat([local, nameBytes, payload])
    parts.push(localBlock)
    offset += localBlock.length

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4) // 创建版本
    cd.writeUInt16LE(20, 6) // 解压所需版本
    cd.writeUInt16LE(flags, 8)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt16LE(now.time, 12)
    cd.writeUInt16LE(now.date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(payload.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBytes.length, 28)
    cd.writeUInt16LE(0, 30) // 扩展区
    cd.writeUInt16LE(0, 32) // 注释
    cd.writeUInt16LE(0, 34) // 起始磁盘
    cd.writeUInt16LE(0, 36) // 内部属性
    cd.writeUInt32LE(0, 38) // 外部属性
    cd.writeUInt32LE(localOffset, 42)
    central.push(Buffer.concat([cd, nameBytes]))
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...parts, centralBuf, end])
}

module.exports = { buildZip, crc32 }
