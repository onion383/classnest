// =========================================================================
// zipWriter.js —— ZIP 零件：CRC32 / 条目名净化 / ZipCrypto 加密
//
// 打包本体在 zipStream.js（边读边写）。这里只留「与流无关、可被两部分共用」的零件：
//   · CRC32（含增量版，流式写大文件时不能整包读进内存）
//   · sanitizeEntryName —— 归档内路径的唯一净化点
//   · createZipCrypto —— 传统加密的 key 流
//
// 为什么自己写而不装库：
//   后端现有依赖里没有 zip 写库（yauzl 只能读）。electron/afterPack.js 里已有一份
//   单文件的 CRC32 + deflate 写法，这里扩成多文件并补上加密，不引入新依赖。
//
// 为什么用 ZipCrypto 而不是 AES：
//   Windows 资源管理器双击就能输入密码解压，只有 ZipCrypto 支持；AES-256 必须装
//   WinRAR / 7-Zip / Bandizip，普通用户会看到「文件已损坏」。这是一个明确的取舍：
//   只防「随手打开」，挡不住针对性破解。强加密需求应走「导出数据库」那条链路。
//
// 关键实现约束：
//   - 用传统加密时 CRC 必须写在本地头里（不能用数据描述符），解压端要靠 CRC 高字节
//     校验 12 字节加密头是否解对了。
//   - 文件名走 UTF-8（通用标志位 bit 11），否则中文表名在解压后是乱码。
//   - 先 deflate 原始数据、再加密压缩结果（顺序反了就是「先加密再压缩」，体积和
//     兼容性都会出问题）。
// =========================================================================

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
  let c = crc32Start()
  c = crc32Update(c, buf)
  return crc32End(c)
}

// 增量 CRC（流式写大文件时不能把整包读进内存）：这三个函数与 crc32 共用同一张表
function crc32Start() {
  return 0 ^ -1
}
function crc32Update(state, buf) {
  let c = state
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return c
}
function crc32End(state) {
  return (state ^ -1) >>> 0
}

// 归档内路径的**唯一**净化点（审查 v6 · A1-03 / N3-03 Zip Slip）：
// 条目名会被原样写进 ZIP，解压端（含 Windows 资源管理器）会照着建目录 ——
// 名字里带 `../` 或盘符就能写到解压目录之外。这里按「逐段白名单」处理：
//   · 反斜杠统一成正斜杠
//   · 去掉盘符（C:）与开头的 /（绝对路径）
//   · `.` 段丢弃，`..` 段弹掉上一段（前导 `..` 直接丢弃）
//   · 结果为空时退回 'file'，绝不返回空名（空名条目在部分解压器里会退化）
function sanitizeEntryName(name) {
  const raw = String(name == null ? '' : name).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '')
  const out = []
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg.replace(/[\u0000-\u001f]/g, ''))
  }
  const joined = out.filter(Boolean).join('/')
  return joined || 'file'
}

// ZipCrypto 的 key0 走的是同一张表，但作用在「上一次的 key0」上
function crc32Byte(crc, byte) {
  return (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]
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

module.exports = { crc32, crc32Start, crc32Update, crc32End, sanitizeEntryName, createZipCrypto }
