// V9 测试守卫批次：静态/副本变异判据为旁证；真行为覆盖见 logout-quiet-window.behavior.test.js 与 ai-read-scope-gate.test.js 的 loadMutated 范式。
// =========================================================================
// backend-origin.test.js —— B1 的地址口径与代理接线
//
// 验收点：
//   ① API 永远相对路径（dev Vite / 打包 app:// 代理）；
//   ② 媒体仍走后端绝对地址，保持 Cookie/Range 语义；
//   ③ app:// 协议必须把 /api 代理到后端，静态路径不受影响；
//   ④ 主窗口/引导/挂件保持 app://local，不再换源。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const FRONTEND = abs('student-frontend')
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), 'utf8')
const load = () => import(pathToFileURL(path.join(FRONTEND, 'src/utils/backendOrigin.js')).href)

test('API 永远相对路径：dev 与打包都走同源', async () => {
  const { apiBaseUrl } = await load()
  assert.equal(apiBaseUrl(), '')
})

test('媒体地址：dev 走代理，打包补全后端绝对地址', async () => {
  const { resolveMediaBase, BACKEND_ORIGIN } = await load()
  assert.equal(resolveMediaBase({ isDev: true }), '')
  assert.equal(resolveMediaBase({ isDev: false }), BACKEND_ORIGIN)
})

test('三处 API 口径统一：httpClient / apiUrl / secureChannel', () => {
  const http = read('src/utils/httpClient.js')
  assert.match(http, /export \{ apiBaseUrl as backendBaseUrl \} from '\.\/backendOrigin\.js'/)
  const api = read('src/utils/apiUrl.js')
  assert.match(api, /from '\.\/backendOrigin\.js'/)
  assert.match(api, /const base = mediaBaseUrl\(\)/, '媒体必须用绝对地址')
  assert.match(api, /fetch\(apiBaseUrl\(\) \+ path/, 'apiFetch 必须走同源 API 路径')
  const secure = read('src/composables/secureChannel.js')
  assert.match(secure, /function BASE\(\) \{ return apiBaseUrl\(\) \}/)
})

test('app:// 协议代理 /api，静态资源仍走文件流', () => {
  const protocol = fs.readFileSync(abs('electron/main/main.protocol.js'), 'utf8')
  assert.match(protocol, /createApiProxy/)
  assert.match(protocol, /const proxied = await proxyApi\(req\)/)
  assert.match(protocol, /net\.fetch/)

  const main = fs.readFileSync(abs('electron/main/main.js'), 'utf8')
  assert.match(main, /app:\/\/local\/index\.html/)
  assert.match(main, /app:\/\/local\/setup\.html/)
  assert.doesNotMatch(main, /http:\/\/127\.0\.0\.1:3000\/index\.html/, 'B1 不再换源')

  const widget = fs.readFileSync(abs('electron/main/main.widget.js'), 'utf8')
  assert.match(widget, /app:\/\/local\/widget\.html/)
  assert.match(widget, /app:\/\/local\/desktop-widget\.html/)
})
