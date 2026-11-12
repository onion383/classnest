// =========================================================================
// utils/textHead.js —— 只读文件头部 N 个字符（避免「为截断而整份读入」）
//
// 背景（v6 性能专题 · 2-12）：AI 附件解析的返回上限是 100000 字符
// （ai.upload.js 的 MAX_TEXT_LEN），但原实现是
//    fs.readFileSync(tempPath, 'utf-8')  →  text.slice(0, MAX_TEXT_LEN)
// 即先整份读入再丢掉 99.5%。一个 20MB（multer 上限）的 txt 会先变成约 40MB 的
// V8 字符串（内部 UTF-16），纯粹读完就丢。
//
// 这里改成「按字节读够用就停」：UTF-8 单字符最多 4 字节（emoji / 生僻字），
// 所以读 maxChars*4 字节必然覆盖前 maxChars 个字符。读满时末尾可能落在多字节
// 序列中间，用 trimIncomplete 裁掉不完整尾字节，避免产生 U+FFFD 乱码字符。
//
// 只做文件头读取与解码，不掺业务语义（「已截断」提示由调用方拼）。
// =========================================================================

const fs = require('fs')

// 从尾部回退最多 3 字节，判断最后一个字符是否被切断；切断则裁掉残字节。
function trimIncomplete(buf) {
  const n = buf.length
  if (!n) return buf
  for (let i = n - 1, steps = 0; i >= 0 && steps < 4; steps++, i--) {
    const b = buf[i]
    // ASCII：本身就是完整字符，尾部安全
    if ((b & 0x80) === 0) return buf
    // 起始字节（110xxxxx / 1110xxxx / 11110xxx）
    if ((b & 0xC0) === 0xC0) {
      const need = (b & 0xE0) === 0xC0 ? 2 : (b & 0xF0) === 0xE0 ? 3 : 4
      return n - i >= need ? buf : buf.subarray(0, i)
    }
    // 0x80~0xBF 是续字节：继续往前找起始字节
  }
  return buf
}

// 把一段 Buffer 解成不超过 maxChars 个字符的字符串。
// 同时返回完整解码长度 full，供调用方判断「是否被截断」——只比 text.length 不可靠，
// 因为文件恰好等于上限时也不该算截断。
//
// 长度按 UTF-16 code unit 计（与旧实现 slice(0, MAX_TEXT_LEN) 同口径），但末尾若停在
// 高代理（emoji 等补充平面字符被切成两半）就再退一个 code unit —— 否则前端渲染出
// 孤立代理「�」，比少一个字符难查得多。
function decodeHead(buf, maxChars) {
  if (!buf || !buf.length) return { text: '', full: 0 }
  const safe = trimIncomplete(buf)
  const s = safe.toString('utf8')
  let out = s.length > maxChars ? s.slice(0, maxChars) : s
  if (out.length) {
    const code = out.charCodeAt(out.length - 1)
    if (code >= 0xD800 && code <= 0xDBFF) out = out.slice(0, -1)
  }
  return { text: out, full: s.length }
}

/**
 * 读文件头部，最多返回 maxChars 个字符。
 * @param {string} filePath
 * @param {number} maxChars 目标字符数上限
 * @returns {{ text: string, truncated: boolean, bytesRead: number, fileSize: number }}
 *   truncated 为 true 表示「文件还有更多内容没读」—— 调用方据此决定是否拼提示。
 */
function readTextHead(filePath, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : 0
  if (!limit) return { text: '', truncated: false, bytesRead: 0, fileSize: 0 }

  // 4 字节/字符是 UTF-8 的最坏情况，读这么多必然够 maxChars 个字符
  const maxBytes = limit * 4
  const fd = fs.openSync(filePath, 'r')
  let fileSize = 0
  let bytesRead = 0
  let buf
  try {
    fileSize = fs.fstatSync(fd).size
    const want = Math.min(fileSize, maxBytes)
    buf = Buffer.allocUnsafe(want)
    while (bytesRead < want) {
      const n = fs.readSync(fd, buf, bytesRead, want - bytesRead, bytesRead)
      if (n <= 0) break
      bytesRead += n
    }
  } finally {
    try { fs.closeSync(fd) } catch (_) { /* 关闭失败不掩盖原始错误 */ }
  }

  const { text, full } = decodeHead(buf.subarray(0, bytesRead), limit)
  // 两个触发条件：文件比本次读取量大（还有没读的字节），或字节读全了但字符仍超上限
  const truncated = fileSize > maxBytes || full > limit
  return { text, truncated, bytesRead, fileSize }
}

module.exports = { readTextHead, decodeHead, trimIncomplete }
