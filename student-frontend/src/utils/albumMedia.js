// 相册缩略图 URL 统一出口。
//
// 后端生成缩略图时带「缓存版本」（THUMB_VERSION，改尺寸/质量时 +1），
// 但浏览器对 <img> 的缓存是看 URL + max-age(86400)，URL 不变就会继续用旧图一天。
// 因此这里把版本号拼进查询串：版本一升，URL 变化，旧缓存自然失效。
//
// 注意：这里的版本必须与 student-backend/albumScan.js 的 THUMB_VERSION 保持一致，
// 两边一起改（当前：256px / q82 → 版本 5）。
import { resourceUrl, apiFetch } from './apiUrl'

export const ALBUM_THUMB_VERSION = 5

export function albumThumbUrl(photoId) {
  if (!photoId) return ''
  return resourceUrl(`/api/album/photo/${photoId}/thumb?v=${ALBUM_THUMB_VERSION}`)
}

// 相册原图/视频源文件（查看器用），不需要版本
export function albumFileUrl(photoId) {
  if (!photoId) return ''
  return resourceUrl(`/api/album/photo/${photoId}/file`)
}

// ---------------------------------------------------------------------------
// 批量取缩略图（性能优化）
// ---------------------------------------------------------------------------
// 网格一次要显示几十上百张缩略图，逐个 <img> 请求受浏览器同源并发连接数限制
// （HTTP/1.1 通常 6 条），往返开销占比很高。实测批量比逐个快约 10 倍
// （0.19 ms/张 vs 2.43 ms/张）。
//
// 响应格式：每张图「4 字节小端长度 + JPEG 数据」逐张拼接，
// 配合响应头 X-Thumb-Ids 给出实际返回的 photoId 顺序。
// 缺图的 photoId 不会出现在响应里（服务端不现场生成缩略图，太重），
// 这些格子回落到单张 albumThumbUrl 即可。

// 一次最多请求多少张（与服务端上限 200 对齐，留余量）
const BATCH_MAX = 200

// 解析批量响应 → [{ id, blob }]
// 段数由 X-Thumb-Ids 决定（服务端保证 id 数与段数一致）
export function parseThumbBatch(buffer, idsHeader) {
  const ids = (idsHeader || '').split(',').filter(Boolean).map(Number).filter(Boolean)
  if (!ids.length || !buffer || !buffer.byteLength) return []
  // 兼容 ArrayBuffer（fetch res.arrayBuffer()）与 TypedArray 视图两种入参：
  // 生产调用方传的是 ArrayBuffer，直接读 .buffer/.byteOffset 会得到 undefined 并抛错。
  const ab = buffer instanceof ArrayBuffer
    ? buffer
    : (ArrayBuffer.isView(buffer) ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : null)
  if (!ab) return []
  const dv = new DataView(ab)
  const out = []
  let off = 0
  for (const id of ids) {
    if (off + 4 > ab.byteLength) break
    const len = dv.getUint32(off, true)
    off += 4
    if (len <= 0 || off + len > ab.byteLength) break
    out.push({ id, blob: new Blob([ab.slice(off, off + len)], { type: 'image/jpeg' }) })
    off += len
  }
  return out
}

// 批量取缩略图，返回 Map<photoId, blob>
//
// 三种结果必须能分辨，别再把它们塌成一种：
//   Map（可能为空） → 请求成功。空 Map 表示「服务端确实没有这些缩略图」，
//                     调用方可以永久放弃批量、回落单张 /thumb。
//   null            → 这次**没拿到**（网络断、后端 5xx、响应解析失败）。
//                     这不代表服务端没图，必须允许重试 —— 原先四种失败全塌成空 Map，
//                     一次抖动就把这些 id 永久判成「没有」，批量预取对它们彻底失效，
//                     只能逐张回落，10 倍性能优化静默没了。
export async function fetchThumbBatch(photoIds) {
  const ids = (photoIds || []).filter(v => Number.isInteger(v) && v > 0).slice(0, BATCH_MAX)
  if (!ids.length) return new Map()
  try {
    // 走统一封装：安全模式下凭据是 X-Auth-Proof 密文头（裸 Authorization 会被后端拒绝）
    const res = await apiFetch('/api/album/photo/thumbs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    const list = parseThumbBatch(buf, res.headers.get('X-Thumb-Ids'))
    const map = new Map()
    for (const { id, blob } of list) map.set(id, blob)
    return map
  } catch (_) {
    return null
  }
}
