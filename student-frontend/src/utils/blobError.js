// =========================================================================
// 二进制下载的「失败原因」统一入口（A4-01 / X2-06 / K1-01）
//
// 事故：导出 zip、下载收据原件、相册另存这些都带 `responseType: 'blob'`。
// 成功时 axios 给 Blob（正确），**失败时给的也是 Blob** —— 后端那句
// `{ error: '没有要打包的文件' }` 是包在 Blob 里的 JSON 文本，于是
// `err.response.data.error` 恒为 undefined、`err.message` 停在 axios 的
// "Request failed with status code 400"。后端写了原因，界面上永远只剩「导出失败」。
//
// 根因不在某个调用点：成功流（二进制）和失败流（JSON）共用一条通道，
// 却没有一层把「失败体」还原成业务对象。每个调用点各写一份 `await data.text()`
// 只会让下一个 blob 接口继续踩坑。这里把还原做成拦截器层的一次性归一：
//   · `err.response.data` 换回解析后的对象 → 全库几十处 `err.response?.data?.error`
//     的既有写法自动生效，一个调用点都不用改；
//   · `err.friendlyMessage` / `err.message` 补上后端文案 → 只读 err.message 的
//     老 catch 也能显示具体原因；
//   · `friendlyError()` 是给新代码用的单一取文案入口。
//
// 归一化必须发生在安全通道拦截器**之前**：安全通道靠 `err.response.data.d`
// 判断「会话过期」并解密 `{ d: 密文 }` 错误信封，Blob 形状下这些判断全部失灵，
// 会把 blob 下载的 401 误判成登录过期（详见 httpClient.js 的注册顺序注释）。
// =========================================================================

// 错误体不该是大文件；只读开头这一段，避免把一个异常返回的超大二进制整块读进内存。
// 超过上限时 JSON.parse 会因截断而失败 → 按「解析不出来」退回通用文案，不会误伤成功流。
const MAX_ERROR_BODY_BYTES = 256 * 1024
const JSON_HEAD = /^\s*[{[]/

// 不用 `instanceof Blob`：axios 在不同上下文（Node 测试 / 渲染层）可能给出跨 realm 的 Blob，
// 而 Buffer、字符串、已解析好的对象都没有 .text() + .slice()，鸭子判定更稳也更可测。
function isBlobLike(data) {
  return !!data && typeof data.text === 'function' && typeof data.slice === 'function'
}

async function readLimitedText(data) {
  const size = typeof data.size === 'number' ? data.size : 0
  const part = size > MAX_ERROR_BODY_BYTES ? data.slice(0, MAX_ERROR_BODY_BYTES) : data
  return String(await part.text())
}

/**
 * 把 blob 错误体解析成统一形状；解析不出来返回 null（调用方保留原 Blob）。
 *
 * 判据刻意只看首字节、不看 Content-Type：本地后端 / 代理 / 降级响应可能没有
 * content-type，Blob.type 也可能是空的；而 HTML 错误页的首字节是 `<`，天然不会
 * 被当成业务错误。比「猜类型」更不容易误判。
 *
 * @returns {Promise<{ code: string, error: string, raw: object } | null>}
 */
export async function parseBlobError(error) {
  const data = error?.response?.data
  if (!isBlobLike(data)) return null

  let text
  try {
    text = await readLimitedText(data)
  } catch (_) {
    return null // Blob 已被消费/损坏：不要改变错误形状，交给调用方兜底
  }
  if (!JSON_HEAD.test(text)) return null

  let raw
  try {
    raw = JSON.parse(text)
  } catch (_) {
    return null // 代理错误页、截断的大文件、半截 JSON
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  // 信封里可能只有 { d: 'session-expired' } 或 { d: 密文 }，此时仍要归一形状
  // （安全通道要读 .d），只是没有可展示文案。
  const msg = typeof raw.error === 'string' && raw.error.trim()
    ? raw.error.trim()
    : (typeof raw.message === 'string' ? raw.message.trim() : '')
  return {
    code: typeof raw.code === 'string' ? raw.code : '',
    error: msg,
    raw,
  }
}

/** 就地归一 axios 错误（供响应错误拦截器调用），返回同一个 error 对象。 */
export async function materializeBlobError(error) {
  if (!error || !error.response) return error
  const parsed = await parseBlobError(error)
  if (!parsed) return error

  error.response.data = parsed.raw
  error.friendlyCode = parsed.code
  if (parsed.error) {
    error.friendlyMessage = parsed.error
    // 只读 err.message 的 catch（ExportExcel 的导出失败提示等）也要拿到后端原因；
    // 原 axios 文案留在 axiosMessage 里，排查时仍可对照状态码。
    error.axiosMessage = error.message
    error.message = parsed.error
  }
  return error
}

/** 取一条可展示文案：后端原因优先，axios 通用文案兜底。 */
export function friendlyError(error, fallback = '操作失败，请重试') {
  const data = error?.response?.data
  const backend = data && typeof data === 'object' && !isBlobLike(data)
    ? (typeof data.error === 'string' && data.error.trim()
      ? data.error.trim()
      : (typeof data.message === 'string' ? data.message.trim() : ''))
    : ''
  return error?.friendlyMessage || backend || error?.message || fallback || '操作失败，请重试'
}

/**
 * 把归一化拦截器装到 axios 上。单独成一个函数是为了能被单测**真跑一遍**
 * （传一个假的 axios 记录拦截器 → 直接调用返回的 onRejected），
 * 而不是只靠「源码里出现了某个字符串」来证明接线。
 */
export function installBlobErrorNormalizer(axios) {
  axios.interceptors.response.use(
    res => res,
    async (error) => {
      await materializeBlobError(error)
      return Promise.reject(error)
    },
  )
}
