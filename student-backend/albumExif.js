// =========================================================================
// albumExif.js —— 从图片文件里读「拍摄时间」
//
// 为什么需要：相册时间轴原来按文件修改时间（mtime）分组，而 mtime 会被
// 复制、解压、微信/QQ 转存、同步盘上传下载全部改写 —— 一批 2019 年拍的
// 照片从QQ 导出来，时间轴就全变成「今天」。真正的拍摄时间在 EXIF 里：
// DateTimeOriginal（0x9003，实际拍摄）/ DateTimeDigitized（0x9004，数字化时间）
// / DateTime（0x0132，I FD0 里的通用时间），XMP 里也有 exif:DateTimeOriginal。
//
// 为什么不引第三方 exif 库：EXIF 就是一段 TIFF 头 + IFD 目录，本模块只需要
// 三个 ASCII 标签，自己解约 80 行，比多一个依赖更可控（也不进node_modules）。
//
// 覆盖格式：sharp 能解头的 JPEG / PNG / WebP / TIFF / AVIF / HEIF（有损或无损
// 由 sharp 构建决定）。读不动就返回 ''，调用方回退到 mtime —— 绝不猜。
// 视频没有 EXIF（ffprobe 太慢，扫描时每张都调命令行不可接受），一律走 mtime。
// =========================================================================

const MIN_YEAR = 1980   // 早于 1980 的「拍摄时间」基本是相机没上电的默认值
const MAX_SKEW_DAYS = 2 // 比「现在」还晚超过 2 天的，视为相机时钟没校准

// 把 "2024:05:06 10:11:12" 这种 EXIF 写法转成 "2024-05-06T10:11:12"（本地时间，无时区后缀）
// dateKey() 用 new Date() 解析无后缀字符串会按本地时间处理，日期分组才不会偏。
function normalizeExifDate(str) {
  if (!str) return ''
  const m = String(str).trim().match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return ''
  const [, y, mo, d, h, mi, s] = m
  const year = +y
  const mon = +mo
  const day = +d
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return ''
  if (h > 23 || mi > 59 || s > 59) return ''
  // 合理性校验：相机没上电时会写 0000:00:00 或 1970:01:01，相机时钟没校准会写未来时间
  if (year < MIN_YEAR) return ''
  const dt = new Date(year, mon - 1, day, +h, +mi, +s)
  if (isNaN(dt.getTime())) return ''
  // ⚠️ 必须校验「日期是否真实存在」，不能只查 day<=31：
  //   2024-02-31 这种不存在的日期会被 new Date(2024, 1, 31) **静默滚到 3-02**
  //   （JavaScript 的 Date 会进位），结果就是「照片被归到 3 月 2 日」——
  //   非法串被原样吐出，用户看到的时间线凭空错开一个月。
  //   做法：构造后把月/日读回来，与输入不一致即说明发生了进位 → 判非法。
  if (dt.getMonth() !== mon - 1 || dt.getDate() !== day) return ''
  if (dt.getTime() - Date.now() > MAX_SKEW_DAYS * 86400000) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${year}-${p(mon)}-${p(day)}T${p(+h)}:${p(+mi)}:${p(+s)}`
}

// 从一段 TIFF/EXIF 字节里取出 IFD0 / Exif / GPS 三个标签表。
// 拆成独立函数，是因为「只读拍摄时间」（扫描时每张都跑）和「读完整信息」（查看器里按需跑）
// 需要同一套 IFD 遍历，没必要写两遍。
function parseIfds(buf) {
  const empty = { ifd0: new Map(), exif: new Map(), gps: new Map() }
  if (!buf || buf.length < 8) return empty
  // sharp 给的通常已是 TIFF 头；少数来源前面带 "Exif\0\0" 前缀，跳过
  let base = 0
  if (buf.length > 6 && buf[0] === 0x45 && buf[1] === 0x78 && buf[2] === 0x69 && buf[3] === 0x66) base = 6
  const le = buf[base] === 0x49 && buf[base + 1] === 0x49
  const be = buf[base] === 0x4d && buf[base + 1] === 0x4d
  if (!le && !be) return empty
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))

  if (u16(base + 2) !== 42) return empty // TIFF magic
  // 注意：块内所有偏移都是相对 TIFF 头（即 base），带 "Exif\0\0" 前缀时要加上 base
  const ifd0 = base + u32(base + 4)
  if (ifd0 < 8 || ifd0 + 2 > buf.length) return empty

  // 读一个 IFD 的全部条目，返回 Map<tag, 值>
  // 值类型：ASCII 字符串 / SHORT、LONG 数字 / RATIONAL 数字（count>1 时给数组）
  function readIfd(offset) {
    const out = new Map()
    if (offset < 8 || offset + 2 > buf.length) return out
    const n = u16(offset)
    // 条目数异常（截断/损坏）时按剩余长度收敛，避免越界读
    const maxEntries = Math.min(n, Math.floor((buf.length - offset - 2) / 12))
    for (let i = 0; i < maxEntries; i++) {
      const e = offset + 2 + i * 12
      if (e + 12 > buf.length) break
      const tag = u16(e)
      const type = u16(e + 2)
      const count = u32(e + 4)
      const valOff = e + 8
      if (type === 2) { // ASCII
        const start = count <= 4 ? valOff : base + u32(valOff)
        if (start < 0 || start >= buf.length) continue
        let end = start
        const max = Math.min(count, buf.length - start)
        while (end < start + max && buf[end] !== 0) end++
        out.set(tag, buf.toString('latin1', start, end))
      } else if (type === 3) { // SHORT
        out.set(tag, count <= 2 ? u16(valOff) : u16(base + u32(valOff)))
      } else if (type === 4) { // LONG
        out.set(tag, count <= 1 ? u32(valOff) : u32(base + u32(valOff)))
      } else if (type === 5) { // RATIONAL：GPS 经纬度就是 3 个「度/分/秒」有理数
        // 一个 RATIONAL 占 8 字节（分子+分母），count=1 也放不进 4 字节的内联槽位，恒为外部偏移
        const need = count * 8
        const start = need <= 4 ? valOff : base + u32(valOff)
        const arr = []
        for (let k = 0; k < count; k++) {
          const o = start + k * 8
          if (o + 8 > buf.length) break
          const num = u32(o)
          const den = u32(o + 4)
          arr.push(den === 0 ? NaN : num / den)
        }
        out.set(tag, count === 1 ? arr[0] : arr)
      }
    }
    return out
  }

  const ifd0Tags = readIfd(ifd0)
  const exifPtr = ifd0Tags.get(0x8769) // Exif IFD 指针
  const exifTags = typeof exifPtr === 'number' ? readIfd(base + exifPtr) : new Map()
  const gpsPtr = ifd0Tags.get(0x8825) // GPS IFD 指针（经纬度在这里，不在 Exif IFD）
  const gpsTags = typeof gpsPtr === 'number' ? readIfd(base + gpsPtr) : new Map()
  return { ifd0: ifd0Tags, exif: exifTags, gps: gpsTags }
}

// 从一段 TIFF/EXIF 字节里取出拍摄时间（保留原接口，扫描流程在用）。
function readExifBuf(buf) {
  const { ifd0, exif } = parseIfds(buf)
  // 优先级：实际拍摄时间 > 数字化时间 > IFD0 通用时间
  const candidates = [
    exif.get(0x9003), // DateTimeOriginal
    exif.get(0x9004), // DateTimeDigitized
    ifd0.get(0x0132),  // DateTime
  ]
  for (const c of candidates) {
    const v = normalizeExifDate(c)
    if (v) return v
  }
  return null
}

// XMP 里也常有拍摄时间（部分手机/相机只写 XMP 不写 EXIF）。字符串里正则捞一把。
function readXmp(xmp) {
  if (!xmp || typeof xmp !== 'string') return ''
  const m = xmp.match(/(?:exif:)?DateTimeOriginal\s*=\s*"([^"]+)"/)
    || xmp.match(/<exif:DateTime(?:Original|Digitized)?[^>]*>([^<]+)<\/exif:DateTime[^>]*>/)
  return m ? normalizeExifDate(m[1]) : ''
}

/**
 * 读一个图片文件的拍摄时间。
 * @returns {Promise<string>} 形如 "2024-05-06T10:11:12"（本地时间）；读不到返回 ''
 */
async function readExifDate(filePath) {
  try {
    const sharp = require('sharp') // 懒加载：与genThumb 一致，启动不背 sharp 初始化成本
    const meta = await sharp(filePath, { failOn: 'none' }).metadata()
    if (!meta) return ''
    return readExifBuf(meta.exif) || readXmp(meta.xmp) || ''
  } catch (_) {
    // 格式不支持 / 文件损坏 / 权限问题：全部回退到 mtime，不抛
    return ''
  }
}

// ---------------------------------------------------------------------------
// 以下为「照片信息」面板服务：按需读一张图的完整元数据
// ---------------------------------------------------------------------------

// 读一个 ICC 文本标签的内容。两种格式都要认：
//   · desc  —— ICC v2 的 textDescriptionType，ASCII 串（"sRGB IEC61966-2.1"）
//   · mluc  —— ICC v4 的 multiLocalizedUnicodeType，UTF-16BE，带语言/地区记录
// 只认 desc 会把 v4 profile 全部读空（实测：sharp 内置的 P3 profile 就是 mluc，
// 内容 "sP3C"，若读不到就会错误地回落到 EXIF ColorSpace=1 报成 sRGB）。
function iccText(icc, off, size) {
  const type = icc.toString('latin1', off, off + 4)
  const limit = Math.min(off + size, icc.length)
  if (type === 'desc') {
    // v2：reserved(4) + ASCII 字节数(4) + ASCII 串
    if (off + 12 > icc.length) return ''
    const len = icc.readUInt32BE(off + 8)
    return icc.toString('latin1', off + 12, Math.min(off + 12 + len, limit))
  }
  if (type === 'mluc') {
    // v4：reserved(4) + 记录数(4) + 记录长度(4) + 记录表；记录 = 语言(2)+地区(2)+长度(4)+偏移(4)
    // 偏移相对标签起点。取第一条记录（通常是 enUS）。
    if (off + 16 > icc.length) return ''
    const recCount = icc.readUInt32BE(off + 8)
    if (recCount <= 0 || recCount > 64) return ''
    const rec = off + 16
    if (rec + 12 > icc.length) return ''
    const len = icc.readUInt32BE(rec + 4)
    const strOff = off + icc.readUInt32BE(rec + 8)
    if (strOff < 0 || strOff >= icc.length) return ''
    const end = Math.min(strOff + len, icc.length)
    let s = ''
    for (let i = strOff; i + 1 < end; i += 2) s += String.fromCharCode(icc.readUInt16BE(i))
    return s
  }
  return ''
}

// 从 ICC profile 里取 desc 标签的文本（"sRGB IEC61966-2.1" / "Display P3" 等）。
// 为什么不用 EXIF 的 ColorSpace 就够：那个标签只有 sRGB / Adobe RGB / 未校准三个值，
// 广色域设备（P3、Adobe RGB）普遍写 0xFFFF「未校准」，真实色域只在 ICC 里。
// ICC 结构固定：128 字节头 + tag 表（每项 12 字节：签名 4 + 偏移 4 + 长度 4）。
function iccDesc(icc) {
  if (!Buffer.isBuffer(icc) || icc.length < 132) return ''
  const count = icc.readUInt32BE(128)
  // tag 表条目数不合理时直接放弃（防止损坏文件让我们循环很久）
  if (count <= 0 || count > 256) return ''
  for (let i = 0; i < count; i++) {
    const e = 132 + i * 12
    if (e + 12 > icc.length) break
    if (icc.toString('latin1', e, e + 4) !== 'desc') continue
    const off = icc.readUInt32BE(e + 4)
    const size = icc.readUInt32BE(e + 8)
    if (off + 8 > icc.length) return ''
    return iccText(icc, off, size).replace(/\0+$/, '').trim()
  }
  return ''
}

// 把 ICC 描述 / EXIF ColorSpace / sharp 的色彩空间归一成一句人话
function describeColorSpace(meta, exifTags) {
  const desc = iccDesc(meta.icc)
  if (desc) {
    // 判断顺序有讲究：sRGB 要先判，否则某些厂商 profile 名里带 "p3" 字样会被误判成 P3
    if (/srgb|iec\s*61966/i.test(desc)) return 'sRGB'
    if (/adobe\s*rgb/i.test(desc)) return 'Adobe RGB'
    // 覆盖 "Display P3" 以及紧凑 profile 的简写（如 sharp 内置的 "sP3C"）
    if (/p3/i.test(desc)) return 'Display P3'
    if (/prophoto/i.test(desc)) return 'ProPhoto RGB'
    return desc
  }
  // 0xA001 ColorSpace：1=sRGB / 2=Adobe RGB / 0xFFFF=未校准
  const cs = exifTags.get(0xA001)
  if (cs === 1) return 'sRGB'
  if (cs === 2) return 'Adobe RGB'
  // 兜底看 sharp 的判断（PNG/WebP 等常常既没 ICC 也没 ColorSpace 标签）
  if (meta.space === 'srgb') return 'sRGB'
  if (meta.space === 'cmyk') return 'CMYK'
  if (meta.space === 'b-w') return '灰度'
  return ''
}

// 把 GPS 的「度/分/秒 + 半球」转成十进制度。
// 南纬 / 西经为负值——这正是面板上要显示的符号，不能丢。
function gpsDecimal(parts, ref) {
  if (!Array.isArray(parts) || parts.length < 3) return null
  const [d, m, s] = parts
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(s)) return null
  let v = d + m / 60 + s / 3600
  if (!Number.isFinite(v)) return null
  const r = String(ref || '').trim().toUpperCase()
  if (r === 'S' || r === 'W') v = -v
  return v
}

// 厂牌 + 型号拼成设备名。型号多数已含厂牌（"Canon EOS 5D Mark IV"、"Apple iPhone 13"），
// 直接拼接会变成 "Canon Canon EOS 5D"，故先判前缀。
function describeCamera(make, model) {
  const mk = String(make || '').trim()
  const md = String(model || '').trim()
  if (!mk && !md) return ''
  if (!md) return mk
  if (!mk) return md
  if (md.toLowerCase().startsWith(mk.toLowerCase())) return md
  return `${mk} ${md}`
}

/**
 * 读一张图片的完整元数据（供相册「照片信息」面板）。
 * 读不到的字段一律给空值 / null，由前端显示「未知」——不猜、不编。
 * @returns {Promise<{width:number|null,height:number|null,colorSpace:string,takenAt:string,
 *                    camera:string,lat:number|null,lng:number|null,format:string,orientation:number}>}
 */
async function readExifDetail(filePath) {
  const out = {
    width: null, height: null, colorSpace: '', takenAt: '',
    camera: '', lat: null, lng: null, format: '', orientation: 1,
  }
  let meta
  try {
    const sharp = require('sharp')
    meta = await sharp(filePath, { failOn: 'none' }).metadata()
  } catch (_) {
    return out // 视频 / 损坏文件 / 不支持格式：交给前端显示「未知」
  }
  if (!meta) return out

  out.format = String(meta.format || '').toUpperCase()
  out.orientation = Number(meta.orientation) || 1

  // 宽高按「观感」给：EXIF Orientation 5~8 表示画面被旋转 90°，
  // 此时存储的宽高与实际看到的是反的，竖拍的手机照片不换会让用户觉得写错了。
  let w = meta.width || null
  let h = meta.height || null
  if (w && h && out.orientation >= 5) { const t = w; w = h; h = t }
  out.width = w
  out.height = h

  const { ifd0, exif, gps } = parseIfds(meta.exif)

  out.colorSpace = describeColorSpace(meta, exif)
  out.camera = describeCamera(ifd0.get(0x010F), ifd0.get(0x0110))

  // 拍摄时间：与扫描时同一套优先级，并复用 XMP 兜底
  let taken = ''
  for (const c of [exif.get(0x9003), exif.get(0x9004), ifd0.get(0x0132)]) {
    const v = normalizeExifDate(c)
    if (v) { taken = v; break }
  }
  if (!taken) taken = readXmp(meta.xmp)
  // "2024-05-06T10:11:12" → "2024-05-06 10:11:12"（面板上直接读，不用前端再转）
  out.takenAt = taken ? taken.replace('T', ' ') : ''

  const lat = gpsDecimal(gps.get(0x0002), gps.get(0x0001))
  const lng = gpsDecimal(gps.get(0x0004), gps.get(0x0003))
  // 范围校验：越界值（相机写坏 / 空值）当作没有，避免显示 "1234.5, 999"
  if (lat !== null && lat >= -90 && lat <= 90) out.lat = lat
  if (lng !== null && lng >= -180 && lng <= 180) out.lng = lng

  return out
}

module.exports = {
  readExifDate, normalizeExifDate, readExifBuf, readXmp, readExifDetail,
}