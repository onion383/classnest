// =========================================================================
// _thumb-frames.cjs —— 批量缩略图**流式**响应的帧解析（冒烟脚本共用）
//
// 帧格式：[id: uint32 LE][len: uint32 LE][JPEG len 字节]，逐帧拼接。
// 帧自带 id 是流式的前提：服务端生成一张写一张，写第一帧时还不知道
// 最终会发出哪些 id，所以没法再用响应头 X-Thumb-Ids 与段序对位。
//
// 下划线前缀是刻意的：run-smoke.cjs 收集用例时跳过 `_` 开头的文件，
// 这个文件不会被当成测试跑。
// =========================================================================

// 解析完整 buffer → [{ id, len }]
// 末尾若是半帧（理论上不该出现，服务端 end 前一定写完）直接丢弃，不抛。
function parseFrames(buf) {
  const out = []
  let off = 0
  while (off + 8 <= buf.length) {
    const id = buf.readUInt32LE(off)
    const len = buf.readUInt32LE(off + 4)
    if (off + 8 + len > buf.length) break
    out.push({ id, len })
    off += 8 + len
  }
  return out
}

module.exports = { parseFrames }
