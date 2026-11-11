// =========================================================================
// blob-error.test.js —— 二进制下载失败时，后端写的那句原因必须能到用户界面
//                        （A4-01 / X2-06 / K1-01，§4-2）
//
// 事故：responseType:'blob' 的请求 4xx 时 err.response.data 也是 Blob。
// 全库几十处 `err.response?.data?.error` 与若干处 `err.message` 都取不到后端原因，
// 界面只剩「导出失败 / Request failed with status code 400」。
//
// 判据分两层，缺一层就是假绿：
//   ① 行为：真 Blob → 解析 → 归一成对象 + 补文案；非 JSON / 超大 / 已解析的不动；
//      拦截器装到假 axios 上**真跑一遍**，并验证它在安全通道之前（否则 401 误判）；
//   ② 接线：四个窗口入口都走 setupApiClient、调用点不再各写一份 Blob 解析。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const MODULE = pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/blobError.js')).href
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const load = () => import(MODULE)

function blobErr(body, { type = 'application/json', status = 400 } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    message: 'Request failed with status code 400',
    response: {
      status,
      data: new Blob([text], { type }),
      headers: { 'content-type': type },
    },
  }
}

// —— 行为层 ——

test('后端 { error, code } 包在 Blob 里：解析出原始信封', async () => {
  const { parseBlobError } = await load()
  const parsed = await parseBlobError(blobErr({ error: '没有要打包的文件', code: 'NO_ENTRIES' }))
  assert.ok(parsed)
  assert.equal(parsed.error, '没有要打包的文件')
  assert.equal(parsed.code, 'NO_ENTRIES')
  assert.deepEqual(parsed.raw, { error: '没有要打包的文件', code: 'NO_ENTRIES' })
})

test('归一后：既有 err.response.data.error 与只读 err.message 的 catch 同时生效', async () => {
  const { materializeBlobError } = await load()
  const err = blobErr({ error: '文件「张三.docx」内容无法解析' })
  const out = await materializeBlobError(err)
  assert.equal(out, err, '必须就地修改同一个 error（拦截器靠它把错误继续抛出去）')
  assert.equal(err.response.data.error, '文件「张三.docx」内容无法解析')
  assert.equal(err.friendlyMessage, '文件「张三.docx」内容无法解析')
  assert.equal(err.message, '文件「张三.docx」内容无法解析')
  assert.equal(err.axiosMessage, 'Request failed with status code 400', '原 axios 文案要留着排查')
})

test('没有 content-type 也能解析（本地后端 / 降级响应可能不带）', async () => {
  const { parseBlobError } = await load()
  const err = blobErr({ error: '密码错误' }, { type: '' })
  err.response.headers = {}
  assert.equal((await parseBlobError(err)).error, '密码错误')
})

test('HTML 代理错误页不是业务错误：保持原 Blob，不改 message', async () => {
  const { parseBlobError, materializeBlobError } = await load()
  const err = blobErr('<!doctype html><html><body>502 Bad Gateway</body></html>', { type: 'text/html' })
  assert.equal(await parseBlobError(err), null)
  const before = err.response.data
  await materializeBlobError(err)
  assert.equal(err.response.data, before)
  assert.equal(err.friendlyMessage, undefined)
  assert.equal(err.message, 'Request failed with status code 400')
})

test('已经解析好的对象 / 字符串 / 空值：原样不动（幂等，重试时不会二次归一）', async () => {
  const { parseBlobError, materializeBlobError } = await load()
  for (const data of [{ error: '已是对象' }, '已是文本', null, undefined, 123]) {
    const err = { message: 'm', response: { data } }
    assert.equal(await parseBlobError(err), null)
    await materializeBlobError(err)
    assert.equal(err.response.data, data)
  }
})

test('只有 text() 没有 slice() 的假 Blob 不算 Blob（鸭子判定两个条件缺一不可）', async () => {
  const { parseBlobError } = await load()
  const err = { response: { data: { size: 10, text: async () => '{"error":"伪装"}' } } }
  assert.equal(await parseBlobError(err), null)
})

test('安全通道信封 { d:"session-expired" }：归一形状但不编造文案', async () => {
  const { materializeBlobError } = await load()
  const err = blobErr({ d: 'session-expired' })
  await materializeBlobError(err)
  assert.equal(err.response.data.d, 'session-expired', '加密层的判定必须能读到 .d')
  assert.equal(err.friendlyMessage, undefined, '这不是给用户看的错误原因')
  assert.equal(err.message, 'Request failed with status code 400')
})

test('后端只给 message 不给 error 时也能取到文案', async () => {
  const { parseBlobError } = await load()
  assert.equal((await parseBlobError(blobErr({ message: '磁盘空间不足' }))).error, '磁盘空间不足')
  assert.equal((await parseBlobError(blobErr({ error: '  ', message: ' 磁盘空间不足 ' }))).error, '磁盘空间不足')
})

test('超大失败体只读前 256KB，不把整块二进制读进内存', async () => {
  const { parseBlobError } = await load()
  const calls = []
  const err = {
    response: {
      data: {
        size: 300 * 1024,
        slice: (start, end) => {
          calls.push([start, end])
          return { text: async () => '{"error":"被截断' } // 截不完整的 JSON
        },
        text: async () => '{"error":"整块读成功"}', // 不限流就会解析成功 → 判据变红
      },
    },
  }
  assert.equal(await parseBlobError(err), null)
  assert.deepEqual(calls, [[0, 256 * 1024]])
})

test('friendlyError 优先级：友好文案 > 解密后的后端 error > axios message > 兜底', async () => {
  const { friendlyError } = await load()
  assert.equal(friendlyError({ friendlyMessage: 'A', message: 'B', response: { data: { error: 'C' } } }, 'Z'), 'A')
  assert.equal(friendlyError({ message: 'B', response: { data: { error: 'C' } } }, 'Z'), 'C')
  assert.equal(friendlyError({ message: 'B', response: { data: {} } }, 'Z'), 'B')
  assert.equal(friendlyError(null, '导出失败'), '导出失败')
  assert.equal(friendlyError({ response: { data: new Blob(['{"error":"不该读我"}']) } }, '导出失败'), '导出失败')
})

test('装到 axios 上的拦截器：真跑一遍，且必须 reject 同一个 error', async () => {
  const { installBlobErrorNormalizer } = await load()
  let onRejected = null
  const fakeAxios = { interceptors: { response: { use: (_ok, err) => { onRejected = err } } } }
  installBlobErrorNormalizer(fakeAxios)
  assert.equal(typeof onRejected, 'function', '没注册响应错误拦截器')

  const err = blobErr({ error: '没有要打包的文件' })
  await assert.rejects(onRejected(err), (e) => e === err)
  assert.equal(err.response.data.error, '没有要打包的文件')
})

test('顺序：归一必须先于安全通道 —— 后一个拦截器能读到 { d } / { error }', async () => {
  const { installBlobErrorNormalizer } = await load()
  const handlers = []
  const fakeAxios = { interceptors: { response: { use: (_ok, err) => handlers.push(err) } } }
  installBlobErrorNormalizer(fakeAxios)
  // 模拟 secureAxios 的 rejected：读字段决定要不要清会话重试 / 解密
  handlers.push(async (err) => {
    err.__seenBySecureLayer = err.response?.data?.d || err.response?.data?.error || 'BLOB'
    return Promise.reject(err)
  })

  const expired = blobErr({ d: 'session-expired' })
  // 按 axios 的真实链路串：前一个 onRejected 的 rejection 会交给下一个 onRejected
  let chain = Promise.reject(expired)
  for (const h of handlers) chain = chain.catch(h)
  await assert.rejects(chain, (e) => e === expired)
  assert.equal(expired.__seenBySecureLayer, 'session-expired', '归一排在后面的话加密层只会看到 Blob')
})

// —— 接线层（源码判据：防止「统一入口存在但没人用」）——

test('接线：四个窗口入口都走 setupApiClient（新窗口别绕过）', () => {
  const entries = [
    'student-frontend/src/main.js',
    'student-frontend/src/subwindows/setup/main.js',
    'student-frontend/src/subwindows/widget/main.js',
    'student-frontend/src/subwindows/desktop-widget/main.js',
  ]
  for (const rel of entries) {
    assert.match(read(rel), /setupApiClient\s*\(/, `${rel} 没装配统一 axios`)
  }
})

test('接线：httpClient 先装归一、再装安全通道，且不在别处重复解析', () => {
  // 先剥注释：注释里出现的同名调用不算接线（否则「把调用注释掉」能骗过判据）
  const src = read('student-frontend/src/utils/httpClient.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  const atNormalize = src.indexOf('installBlobErrorNormalizer(axios)')
  const atSecure = src.indexOf('setupSecureAxios(axios)')
  assert.ok(atNormalize >= 0, '归一拦截器没接到统一 axios 装配上')
  assert.ok(atSecure >= 0)
  assert.ok(atNormalize < atSecure, '归一必须排在安全通道之前（否则 blob 401 被误判成登录过期）')
  assert.equal(src.split('installBlobErrorNormalizer(axios)').length - 1, 1, '只能装一次')
  assert.ok(!/await materializeBlobError\(error\)/.test(src), '错误拦截器里不该再重复解析一次')
  assert.match(src, /import \{ installBlobErrorNormalizer \} from '\.\/blobError\.js'/)
})

test('接线：三个调用点不再各写一份 Blob 解析，统一用 friendlyError', () => {
  const settings = read('student-frontend/src/views/SettingsView/SettingsView.data.js')
  assert.match(settings, /import \{ friendlyError \} from '\.\.\/\.\.\/utils\/blobError\.js'/)
  assert.ok(!/function readBlobError|await readBlobError/.test(settings), '设置页还留着本地重复解析')
  assert.match(settings, /ctx\.showAlert\(friendlyError\(err, '导出失败'\)\)/)

  const excel = read('student-frontend/src/components/import-export/ExportExcel/ExportExcel.vue')
  assert.match(excel, /import \{ friendlyError \} from '\.\.\/\.\.\/\.\.\/utils\/blobError\.js'/)
  assert.ok(!/notifyError\(err && err\.message \? err\.message : '导出失败，请重试'\)/.test(excel),
    '自定义导出（zip 打包）的 catch 还在只读 axios 通用 message')
})
