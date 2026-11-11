// =========================================================================
// zipPeek.js —— 只读备份包开头的 `bundle.json`，判断「这个包要不要口令」
//
// 为什么需要：v3 包是个 ZIP，恢复时前端看不到里面是什么；而界面要不要显示
// 「密码 / 助记词」输入框，完全取决于包里那把库钥匙是怎么包的：
//   · 明文库（encrypted:false）      → 没有钥匙，什么都不用输
//   · 加密库 + 明文 key 随包         → 钥匙就在包里，什么都不用输
//   · 只给 wrappedByPassword/Mnemonic → 必须输对应口令才能解出钥匙
// 以前只能「两个框都摆着，让用户猜」，输了密码才发现根本不需要。
//
// 代价很小：`writeBundle` 把 `bundle.json` 放在**第一个条目**且 **store 不压缩**
// （见 services/backupArchive.js 与 zipStream.js 的 `flags`），
// 所以读文件开头 64KB 就能拿到完整 meta，不必把几百 MB 的包读进来，也不必解压。
//
// 解析不出来时一律返回 null（调用方降级为「显示输入框」）——
// 宁可多问一句，也不能让用户以为不用密码、结果恢复失败。
// =========================================================================

const META_NAME = 'bundle.json'
const LOCAL_SIG = 0x04034b50 // PK\x03\x04
const DESC_SIG = [0x50, 0x4b, 0x07, 0x08] // PK\x07\x08（数据描述符）
const DEFAULT_PEEK = 64 * 1024

// 与后端 `services/bundleRestore.js` 的 isEncrypted **必须逐字一致**。
// 两边不一致的后果：前端以为不用密码（隐藏输入框）→ 后端解不出钥匙 → 用户卡在恢复失败，
// 而且他连「该填什么」都看不到。改这里时请同步改那边。
export function isEncryptedMeta(meta) {
  return !(meta.encrypted === false || meta.encrypted === 0 || meta.encrypted === '0')
}

/**
 * 这个包恢复时需不需要用户提供口令。
 * @param {object|null} meta peekBundleMeta 的结果
 * @returns {boolean} 解析不出来时保守返回 true（显示输入框）
 */
export function bundleNeedsSecret(meta) {
  if (!meta || typeof meta !== 'object') return true
  if (!isEncryptedMeta(meta)) return false // 明文库：没有库钥匙要解
  if (meta.key) return false               // 钥匙明文随包：换机免密恢复
  return true                              // 只剩 wrappedByPassword / wrappedByMnemonic
}

/**
 * 从 File/Blob 里读出 `bundle.json`。
 * @param {Blob} blob 用户选中的 .zip
 * @param {{maxBytes?: number}} [opts]
 * @returns {Promise<object|null>} 不是 v3 包 / 格式不符 / 解析失败 → null
 */
export async function peekBundleMeta(blob, opts = {}) {
  if (!blob || typeof blob.slice !== 'function') return null
  const maxBytes = opts.maxBytes || DEFAULT_PEEK
  let buf
  try {
    buf = new Uint8Array(await blob.slice(0, maxBytes).arrayBuffer())
  } catch (_) {
    return null
  }
  if (buf.length < 30) return null
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0, true) !== LOCAL_SIG) return null

  const method = dv.getUint16(8, true)
  if (method !== 0) return null // 将来改成 deflate 就不猜了，交给降级

  const nameLen = dv.getUint16(26, true)
  const extraLen = dv.getUint16(28, true)
  const dataStart = 30 + nameLen + extraLen
  if (dataStart > buf.length) return null

  let name
  try {
    name = new TextDecoder('utf-8').decode(buf.subarray(30, 30 + nameLen))
  } catch (_) {
    return null
  }
  if (name !== META_NAME) return null // 第一个条目不是 bundle.json：不是我们的包（或格式变了）

  // 条目用了数据描述符（bit 3），头部里的 size 是 0，只能扫到 PK\x07\x08 为止。
  // 因为 method === 0（store），内容就是原样字节。
  let end = -1
  for (let i = dataStart; i + 3 < buf.length; i++) {
    if (buf[i] === DESC_SIG[0] && buf[i + 1] === DESC_SIG[1] && buf[i + 2] === DESC_SIG[2] && buf[i + 3] === DESC_SIG[3]) {
      end = i
      break
    }
  }
  if (end < 0) return null // 64KB 内没扫到描述符：meta 异常大，不猜

  try {
    const text = new TextDecoder('utf-8').decode(buf.subarray(dataStart, end))
    const meta = JSON.parse(text)
    return meta && typeof meta === 'object' ? meta : null
  } catch (_) {
    return null
  }
}
