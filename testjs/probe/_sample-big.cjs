// =========================================================================
// _sample-big.cjs —— 4032×3024 大样本图生成器（查看器类探针的公共前置）
//
// 为什么需要它：纯色图会被 JPEG 压到几十 KB，解码几乎不花时间，测不出真实体感。
// 所以填一层「伪随机 + 低频渐变」，让文件体积接近手机原图（3~4MB），
// 解码成本才有代表性。
//
// 这段逻辑原先长在 viewer-open-probe.cjs 里。那个脚本本身是「排除 backdrop-filter
// 合成开销」的一次性诊断，结论已定稿（glass 与深色都是 ~16ms，不是瓶颈），
// 脚本不再保留；但样本图有三个脚本要用，所以单独提出来。
//
// 用法：
//   const { BIG, THUMB, ensureSampleImages } = require('./_sample-big')
//   const imgs = await ensureSampleImages()   // 已存在则直接返回，缺哪个补哪个
// =========================================================================

const fs = require('fs')
const path = require('path')

const BACKEND = path.join(__dirname, '..', '..', 'student-backend')
const TMP = path.join(__dirname, '..', 'tmp', 'viewer-open-probe')
const BIG = path.join(TMP, 'big.jpg')
const THUMB = path.join(TMP, 'thumb.jpg')

const W = 4032
const H = 3024

async function ensureSampleImages() {
  fs.mkdirSync(TMP, { recursive: true })
  // 只判「文件存在」不够：上次生成中途失败会留下 0 字节/截断文件，
  // 直接复用会让后续探针在「解码大图」这一步莫名其妙地失败（审查 v4 · B14-24）。
  const sizeOk = (p, minBytes) => {
    try { return fs.statSync(p).size >= minBytes } catch (_) { return false }
  }
  const needBig = !sizeOk(BIG, 1024 * 1024)   // 预期 3~4MB
  // BIG 重建时缩略图必须跟着重建（thumb 是从 big 生成的）
  const needThumb = needBig || !sizeOk(THUMB, 10 * 1024)
  // 已存在时既不生成 raw（36MB buffer）也不 require sharp，省掉几秒启动时间
  if (needBig || needThumb) {
    const sharp = require(path.join(BACKEND, 'node_modules', 'sharp'))
    if (needBig) {
      const raw = Buffer.allocUnsafe(W * H * 3)
      for (let i = 0, p = 0; i < raw.length; i += 3, p++) {
        const x = p % W
        const y = (p / W) | 0
        // 伪随机 + 低频渐变：既有噪声（撑体积）又不至于全白噪声（JPEG 会爆）
        const n = ((x * 7919 + y * 104729) % 89) | 0
        const base = ((x * 255 / W) | 0) + (((y * 255 / H) | 0) >> 1)
        raw[i] = Math.min(255, base + n)
        raw[i + 1] = Math.min(255, base + ((n * 3) % 61))
        raw[i + 2] = Math.min(255, base + ((n * 7) % 43))
      }
      await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 90 }).toFile(BIG)
    }
    if (needThumb) {
      await sharp(BIG).resize(600, 450, { fit: 'cover' }).jpeg({ quality: 82 }).toFile(THUMB)
    }
  }
  return {
    big: BIG,
    thumb: THUMB,
    bigMB: (fs.statSync(BIG).size / 1024 / 1024).toFixed(2),
    thumbKB: (fs.statSync(THUMB).size / 1024).toFixed(0),
  }
}

module.exports = { TMP, BIG, THUMB, ensureSampleImages }
