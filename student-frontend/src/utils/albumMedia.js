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
// 批量取缩略图（**流式**）
// ---------------------------------------------------------------------------
// 网格一次要显示几十上百张缩略图，逐个 <img> 请求受浏览器同源并发连接数限制
// （HTTP/1.1 通常 6 条），往返开销占比很高。实测批量比逐个快约 10 倍
// （0.19 ms/张 vs 2.43 ms/张）。
//
// 响应是**流**：每帧「id(4 字节小端) + len(4 字节小端) + JPEG len 字节」，
// 服务端生成完一张就发一张。前端边收边渲染 —— 第一张约 200ms 就到，
// 而不是等整批（几秒）收完才一次性全出。这是「感觉慢」的主要来源：
// 后端生成 40 张本来就要 1~2 秒（一张 4000×3000 的原图解码就要 80ms，
// 这是 CPU 物理下限，跟 sharp 调参无关），但用户不必等最后一张才知道有图。
//
// 帧自带 id，所以**不保证顺序**（谁先生成完谁先发）。原来的实现靠响应头
// X-Thumb-Ids 与段序对位，流式下做不到 —— 写第一帧时还不知道会发出哪些 id。
//
// 服务端会为缺图的照片现场生成（受配额闸限制），所以「流里没有」= 这次确实没有，
// 调用方回落到单张 /thumb 即可。

// 一次最多请求多少张（与服务端上限 200 对齐，留余量）
const BATCH_MAX = 200

// 增量帧解析器：喂任意切分的字节块，吐出完整帧 [{ id, bytes }]。
//
// 必须能处理「一帧被切在两半」：fetch 的 reader 按网络到达给块，
// 不保证按帧对齐（一帧 8KB，很可能跨两个 chunk）。攒不够就留着等下次 push。
export function createThumbFrameParser() {
  let pending = new Uint8Array(0)
  return function push(chunk) {
    if (chunk && chunk.length) {
      if (pending.length) {
        const merged = new Uint8Array(pending.length + chunk.length)
        merged.set(pending, 0)
        merged.set(chunk, pending.length)
        pending = merged
      } else {
        // 不直接持有 chunk：reader 可能复用同一个底层 ArrayBuffer，
        // 后续 slice 走的是拷贝，这里只借用引用是安全的。
        pending = chunk
      }
    }
    const out = []
    let off = 0
    for (;;) {
      if (pending.length - off < 8) break
      const dv = new DataView(pending.buffer, pending.byteOffset + off, 8)
      const id = dv.getUint32(0, true)
      const len = dv.getUint32(4, true)
      if (pending.length - off - 8 < len) break
      out.push({ id, bytes: pending.slice(off + 8, off + 8 + len) })
      off += 8 + len
    }
    if (off) pending = pending.slice(off)
    return out
  }
}

// 流式取缩略图。每解析出一张就立刻调 onThumb(photoId, blob)。
//
// 返回值：
//   'ok'  → 流正常结束（收到几张就是几张，没收到的是服务端确实没有）
//   null  → 这次没拿到（网络断 / 后端 5xx / abort）。**不代表服务端没图**，必须允许重试。
//           调用方要自己先判 signal.aborted，别把 abort 当成「没拿到」去排重试。
export async function streamThumbBatch(photoIds, signal, onThumb) {
  const ids = (photoIds || []).filter(v => Number.isInteger(v) && v > 0).slice(0, BATCH_MAX)
  if (!ids.length) return 'ok'
  let reader = null
  try {
    // 走统一封装：安全模式下凭据是 X-Auth-Proof 密文头（裸 Authorization 会被后端拒绝）。
    // apiFetch 只在 content-type 是 application/json 时才包装 res.json，
    // 二进制流原样返回，所以 res.body 可以直接读。
    const res = await apiFetch('/api/album/photo/thumbs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
      signal,
    })
    if (!res.ok) return null
    const parser = createThumbFrameParser()
    const emit = (frames) => {
      for (const f of frames) onThumb(f.id, new Blob([f.bytes], { type: 'image/jpeg' }))
    }
    if (!res.body) {
      // 理论上不会走到（Electron 的 Chromium 一定支持流）；留着是为了万一
      // 被某层中间件吃掉 body 时，功能退化成「整包读」而不是「一张都没有」。
      emit(parser(new Uint8Array(await res.arrayBuffer())))
      return 'ok'
    }
    reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      emit(parser(value))
    }
    return 'ok'
  } catch (_) {
    // abort 也会走到这里（reader.read() 抛 AbortError）。把连接明确放掉，
    // 别让 socket 挂到 GC 才回收。
    if (reader) { try { reader.cancel() } catch (_) { /* 已经断了 */ } }
    return null
  }
}
