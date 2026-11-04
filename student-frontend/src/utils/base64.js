// Uint8Array / ArrayBuffer → base64。
//
// 为什么不用 `btoa(String.fromCharCode(...bytes))`：参数展开受引擎的实参上限限制，
// 导出的 xlsx 上万行时直接爆栈（RangeError: Maximum call stack size exceeded）。
// 必须分块拼接。这里的 0x8000 是经验值，再大也会在某些环境下触发同样的限制。
export function bufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

// Blob → base64（导出链路里拿到的都是 Blob，先取 arrayBuffer 再转）
export async function blobToBase64(blob) {
  return bufferToBase64(await blob.arrayBuffer())
}
