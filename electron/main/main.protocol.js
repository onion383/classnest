// =========================================================================
// protocol.js —— 渲染层静态资源服务：app:// 协议 + 渲染进程 V8 代码缓存
//
// 打包模式用自定义 app:// 安全协议加载前端，避免 file:// 的「不透明 origin」导致
// localStorage 仅会话内生效、每次重启即清空（表现：重新登录 + 设置还原）。
//
// 注意：协议本身的 registerSchemesAsPrivileged 必须在 app ready 前于入口(main.js)完成，
// 本模块只负责 ready 之后的 protocol.handle 注册与代码缓存目录设置。
// =========================================================================

const { app, session, protocol } = require('electron')
const path = require('path')
const fs = require('fs')
const { createApiProxy, nodeFetch } = require('./main.api-proxy')

const { isDev } = require('./main.env')

// 打包模式静态资源 MIME 表
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
}

// 注册 app:// 协议：从打包产物目录安全地提供静态文件（支持 asar 内 fs 流式读取）。
// 性能要点：不做任何逐请求的同步 fs（原 existsSync+statSync 会阻塞主进程），
// 只在启动时 readdir 一次拿到顶级 html 入口名单，之后纯按路径规则直接流式读盘。
// prod 下也不再逐请求打日志。
const IMMUTABLE_ASSET_RE = /\.(js|css|wasm|png|jpe?g|gif|webp|svg|woff2?)$/i

// 渲染进程 V8 代码缓存：把构建产物的 JS（首屏约 250KB）解析 + 编译结果缓存到磁盘，
// 第 2 次及以后启动直接复用。与主进程的 NODE_COMPILE_CACHE 对称。
// 注意：app:// 属自定义协议，除注册时声明 codeCache:true 外，还需在此显式指定缓存目录；
// 必须在首个页面加载前调用。不可用时静默忽略（退回 Chromium 默认行为）。
// 缓存条目按资源内容哈希命名，应用更新后旧条目永不命中，会随版本累积（实测可达 50MB+）。
// 故按应用版本号做一次性清理：版本未变则零开销直接返回；版本变化时后台异步删除旧条目，
// 不阻塞启动，删除失败（文件被占用）静默忽略，下次启动再试。
// 缓存目录体积上限：超过就把最旧的条目删到只剩 70%。
// 为什么需要：版本号清理只在「应用更新」时生效，同一版本内条目仍会累积
// （开发模式下 Vite 的模块 URL 带 hash、每次改动都产生新条目，实测可达 240MB+）。
// 代码缓存是可再生的（删掉只是下次启动多一次解析），因此按体积兜底清理不影响任何功能。
const CC_MAX_BYTES = 64 * 1024 * 1024
const CC_TARGET_RATIO = 0.7

// 递归算目录体积（字节）。只用于体积兜底判断，失败一律当 0。
async function dirSizeBytes(dir) {
  let total = 0
  let entries = []
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch (_) { return 0 }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    try {
      if (e.isDirectory()) total += await dirSizeBytes(p)
      else total += (await fs.promises.stat(p)).size
    } catch (_) { /* 单条失败忽略 */ }
  }
  return total
}

function pruneOversizeCodeCache(dir) {
  fs.promises.readdir(dir, { withFileTypes: true })
    .then(async (entries) => {
      const items = []
      let total = 0
      for (const e of entries) {
        if (e.name === '.cc-version') continue
        const p = path.join(dir, e.name)
        try {
          const st = await fs.promises.stat(p)
          const size = e.isDirectory() ? await dirSizeBytes(p) : st.size
          total += size
          items.push({ p, size, mtime: st.mtimeMs })
        } catch (_) { /* 忽略单项 */ }
      }
      if (total <= CC_MAX_BYTES) return
      const target = CC_MAX_BYTES * CC_TARGET_RATIO
      items.sort((a, b) => a.mtime - b.mtime) // 最旧的先删
      let cur = total
      for (const it of items) {
        if (cur <= target) break
        await fs.promises.rm(it.p, { recursive: true, force: true }).catch(() => {})
        cur -= it.size
      }
      console.log(`[main] 渲染代码缓存超限，已清理至约 ${Math.round(cur / 1048576)}MB`)
    })
    .catch(() => {})
}

function pruneStaleCodeCache(dir) {
  const marker = path.join(dir, '.cc-version')
  const cur = app.getVersion()
  let prev = ''
  try { prev = fs.readFileSync(marker, 'utf8').trim() } catch (_) {}
  if (prev === cur) return
  fs.promises.readdir(dir, { withFileTypes: true })
    .then((entries) => Promise.all(entries
      .filter((e) => e.name !== '.cc-version')
      .map((e) => fs.promises.rm(path.join(dir, e.name), { recursive: true, force: true }).catch(() => {}))))
    .then(() => fs.promises.writeFile(marker, cur, 'utf8').catch(() => {}))
    .catch(() => {})
}

function setupRendererCodeCache() {
  // 分段打点（仅 PERF_STARTUP=1）：这一段在打包版稳定占 20~29ms，但从外面看不出花在哪。
  // 只进 stdout，不进启动时间线（避免污染用户可见的耗时明细）；不打点时 _p 是空函数。
  const _t0 = Date.now()
  const _p = process.env.PERF_STARTUP === '1'
    ? (name) => { try { console.log(`[perf] 代码缓存 ${name} ${Date.now() - _t0}ms`) } catch (_) { /* 打点失败忽略 */ } }
    : () => {}
  try {
    const dir = path.join(app.getPath('userData'), 'renderer-code-cache')
    _p('getPath 完成')
    fs.mkdirSync(dir, { recursive: true })
    _p('mkdirSync 完成')
    pruneStaleCodeCache(dir)
    _p('pruneStale 已排程')
    // 体积兜底：延后 8s 再跑。这一步要遍历整个缓存目录（可能上百 MB、上万个文件），
    // 立刻跑会和首屏资源的读取抢线程池 IO；它只是磁盘维护，晚几秒做完全等价。
    setTimeout(() => pruneOversizeCodeCache(dir), 8000)
    session.defaultSession.setCodeCachePath(dir)
    _p('setCodeCachePath 完成')
  } catch (err) {
    console.error('[main] 渲染进程代码缓存不可用，跳过:', err?.message || err)
  }
}

function setupAppProtocol() {
  if (isDev) return
  // 分段打点（仅 PERF_STARTUP=1）：打包版「协议注册」稳定 20~29ms，逐段拆开看归属。
  const _t0 = Date.now()
  const _p = process.env.PERF_STARTUP === '1'
    ? (name) => { try { console.log(`[perf] 协议注册 ${name} ${Date.now() - _t0}ms`) } catch (_) { /* 打点失败忽略 */ } }
    : () => {}
  const distDir = path.join(__dirname, '../../student-frontend/dist')
  const root = path.normalize(distDir)
  const indexHtml = path.join(root, 'index.html')

  // 顶级 html 入口（index/setup/widget/migration/desktop-widget…），仅枚举一次
  let htmlEntries = new Set()
  try {
    htmlEntries = new Set(fs.readdirSync(distDir).filter((f) => f.endsWith('.html')))
  } catch (_) {
    // dist 缺失时不阻断启动，后续请求走 index.html 回退
  }
  _p('readdirSync 入口枚举完成')

  // 懒加载 stream：只有生产模式的静态资源流式返回用得到，挪出主进程启动关键路径
  const { Readable } = require('stream')
  _p('require stream 完成')
  const serveFile = (file, headers) =>
    new Response(Readable.toWeb(fs.createReadStream(file)), { headers })

  // 内容安全策略（打包版生效；开发模式页面由 Vite dev server 提供，不走这里）。
  // 只放行实际用到的三类「非 self」资源，其余一律拒绝：
  //   · style 'unsafe-inline' —— Vue 的 scoped 样式与运行时动态内联样式（改主题色/进度条宽度）依赖它；
  //   · img/media http://127.0.0.1:3000 —— 相册与背景图走媒体绝对地址（Lax Cookie 要求同站请求）；
  //   · img data: blob: —— 图标与本地预览图。
  // 脚本只允许 'self'（生产构建没有 eval，也不需要外链脚本），但有两处内联脚本必须放行：
  //
  // ① 构建产物里样式表带 onload="this.media='all'"（vite.config.js 的 nonBlockingCss 加的，
  //    作用是把首帧不阻塞的 media="print" 切回 all）。**内联事件处理器属于 script-src 管辖**，
  //    不放行就会被拦下，4 个入口 CSS 永远停在 media=print —— 整页只剩运行时动态插入的组件 CSS，
  //    基础布局与工具类全部失效（2026-11-12 打包版「样式全乱」的根因，dev 走 Vite 所以看不出来）。
  // ② 首屏占位里的主题抢跑脚本（splash/splash.html），在 Vue 挂载前把 data-theme/data-mode
  //    写到 <html> 上，不放行则深色模式启动先闪一下浅色。
  //
  // 不用 'unsafe-inline'：那等于允许任意内联脚本执行；只放行这两段固定内容的 sha256。
  // 事件处理器那条还需 'unsafe-hashes'（否则 hash 只匹配 <script> 块、不匹配 onload 属性）。
  //
  // ③ 'wasm-unsafe-eval'：PDF 导出的中文字体子集化走 harfbuzz 的 wasm
  //    （student-frontend/src/utils/hbSubset.js）。CSP3 把 WebAssembly.compile/instantiate
  //    归为「脚本执行」，没有这条就抛
  //    「Compiling or instantiating WebAssembly module violates ... script-src」。
  //    少了它不会让导出失败（pdfFont.js 会退回全量字体），但 PDF 从 121KB/22ms 变成
  //    1.78MB/386ms，且只有 console.warn —— 静默退化，很难发现（2026-11-12 实测）。
  //    它只放行 wasm 字节码编译，不等于 'unsafe-eval'（仍不能用 eval/new Function 执行字符串）。
  // ⚠️ 三处必须同步：改 vite.config.js 里那句 handler 或 splash/splash.html 里的脚本，
  //    就要重算对应 hash。忘了改不会有任何报错，只会让打包版静默失去基础样式 / 深色防闪白
  //    （单测 packaged-csp 会把两个 hash 与源内容对账，改漏一处就红）。
  const CSS_ONLOAD_HASH = 'sha256-MhtPZXr7+LpJUY5qtMutB+qWfQtMaPccfe7QXtCcEYc='
  const SPLASH_SCRIPT_HASH = 'sha256-WLc7cp/RKX95aLX2rMwaWD5aJ5PbXZ6yw3+iOa9Nwys='
  const SCRIPT_SRC = `script-src 'self' 'unsafe-hashes' 'wasm-unsafe-eval' '${CSS_ONLOAD_HASH}' '${SPLASH_SCRIPT_HASH}'`
  // frame-src 必须显式写出：CSP 没写 frame-src 时由 default-src 回落，而 default-src 'self'
  // 只认同源 app://，会把 <iframe> 一律拦掉。全库唯一在应用内使用 iframe 的地方是
  // ReceiptDialog 的 PDF 预览（src = resourceUrl(path) → BACKEND_ORIGIN + path），
  // 少了这一条打包版点开 PDF 就是一片空白（dev 模式不发 CSP，所以看不出来）。
  // blob: 留给本地生成的预览地址（resourceUrl 对 blob:/data: 原样返回）。
  // 别与下面的 frame-ancestors 混：frame-src 管「本页能不能嵌别人」，
  // frame-ancestors 管「本页能不能被别人嵌」。
  // ⚠️ 这里写死的后端 origin 与 student-frontend/src/utils/backendOrigin.js 的
  //    BACKEND_ORIGIN 必须一致，改端口要一起改（单测 packaged-csp 会对账）。
  const CSP = [
    "default-src 'self'",
    SCRIPT_SRC,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http://127.0.0.1:3000",
    "media-src 'self' blob: http://127.0.0.1:3000",
    "font-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:3000",
    "frame-src 'self' http://127.0.0.1:3000 blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
  // 引导页例外：setup.html 内联了一小段「程序正在干嘛」的状态提示脚本。
  // 它必须在 HTML 里内联 —— 那段代码的意义就是「Vue 还没挂载时先显示点什么」，
  // 挪成外部文件会多一次请求、正好毁掉它的用途。只对这一页放开内联脚本。
  const CSP_SETUP = CSP.replace(SCRIPT_SRC, `${SCRIPT_SRC} 'unsafe-inline'`)
  const htmlHeadersFor = (name) => ({
    'content-type': MIME['.html'],
    'cache-control': 'no-cache',
    'content-security-policy': name === 'setup.html' ? CSP_SETUP : CSP,
  })
  const serveIndex = () => serveFile(indexHtml, htmlHeadersFor('index.html'))

  // B1：/api/* 同源代理到后端；其余路径仍走静态文件。
  // 2-16 对照：底层从 net.fetch 换成 Node http.request，绕过 Chromium 网络服务。
  const proxyApi = createApiProxy({ fetchImpl: nodeFetch })
  _p('createApiProxy 完成')

  const handleApp = async (req) => {
    const proxied = await proxyApi(req)
    if (proxied) return proxied

    let p
    let file
    try {
      const url = new URL(req.url)
      p = decodeURIComponent(url.pathname)
      if (p === '/' || p === '') p = '/index.html'
      file = path.normalize(path.join(root, p))
      // 防目录穿越
      if (file !== root && !file.startsWith(root + path.sep)) {
        return new Response('Forbidden', { status: 403 })
      }
    } catch (_) {
      return new Response('Not Found', { status: 404 })
    }

    const ext = path.extname(file).toLowerCase()

    // 无扩展名 → 客户端路由（SPA），回退入口 html
    if (ext === '') return serveIndex()

    if (ext === '.html') {
      const name = p.replace(/^\/+/, '')
      // 已登记的顶级入口直接给；其余 html 路径按 SPA 路由回退
      if (!name.includes('/') && htmlEntries.has(name)) {
        return serveFile(file, htmlHeadersFor(name))
      }
      return serveIndex()
    }

    // 其余带扩展名的静态资源（含 hash 命名的 bundle）：直接流式返回。
    // hash 资源可长缓存，让后续启动直接命中 Chromium 磁盘缓存；字体等短名资源不缓存。
    return serveFile(file, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': IMMUTABLE_ASSET_RE.test(file)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    })
  }

  // 2-18 归因：首屏要发十几个 app:// 资源请求，每次都要过这层 handler
  // （Chromium 网络服务 → 主进程 IPC → asar 读 → 加 CSP/缓存头 → 回传）。
  // app:// 不进 Resource Timing，前端完全量不到，只能在这里记账。
  // 用 PERF_STARTUP 门控：正常启动零开销（不打点时不走计时分支）。
  const protoPerfOn = process.env.PERF_STARTUP === '1'
  protocol.handle('app', async (req) => {
    if (!protoPerfOn) return handleApp(req)
    const t0 = performance.now()
    try {
      return await handleApp(req)
    } finally {
      try {
        let p = '?'
        try { p = new URL(req.url).pathname } catch (_) { /* 非法 URL 就记 ? */ }
        console.log(`[perf] 协议 ${p} ${(performance.now() - t0).toFixed(1)}ms`)
      } catch (_) { /* 打点失败绝不能影响响应本身 */ }
    }
  })
  _p('protocol.handle 注册完成')
}

module.exports = { setupRendererCodeCache, setupAppProtocol }