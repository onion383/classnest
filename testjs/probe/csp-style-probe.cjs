// 打包版「样式全乱」的复现/验证探针：
// 用真实 dist + 从 electron/main/main.protocol.js 里提取的真实 CSP，注册 app:// 加载首屏，
// 检查每个 <link rel=stylesheet> 最终 media 是否变成 all、CSS 是否真的加载进来。
//
// 为什么必须走真实 CSP：dev 模式页面由 Vite dev server 提供（不走这个协议、不发 CSP header），
// 所以这个问题只在打包版出现 —— 用户看到的正是打包版。
//
// 跑法：npx electron testjs/probe/csp-style-probe.cjs
const { app, BrowserWindow, protocol } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '../..')
const DIST = path.join(ROOT, 'student-frontend/dist')

// 从源码里提取 CSP（不复制字符串，避免探针与实现各写一份后漂移）。
// script-src 是模板字符串拼了多个 hash 常量，先收集常量表再替换变量。
function readCsp() {
  const src = fs.readFileSync(path.join(ROOT, 'electron/main/main.protocol.js'), 'utf8')
  const consts = {}
  for (const m of src.matchAll(/const (\w+_HASH) = '(sha256-[^']+)'/g)) consts[m[1]] = m[2]
  const tplM = src.match(/const SCRIPT_SRC = `([^`]*)`/)
  if (!tplM) throw new Error('未能从 main.protocol.js 提取 SCRIPT_SRC')
  const scriptSrc = tplM[1].replace(/\$\{(\w+)\}/g, (_, n) => consts[n] ?? '')
  const arr = src.match(/const CSP = \[([\s\S]*?)\]\.join\('; '\)/)
  if (!arr) throw new Error('未能从 main.protocol.js 提取 CSP 数组')
  const parts = []
  for (const raw of arr[1].split('\n')) {
    const line = raw.trim().replace(/,$/, '')
    if (!line) continue
    if (line === 'SCRIPT_SRC') { parts.push(scriptSrc); continue }
    const m = line.match(/^"([^"]*)"$/)
    if (m) parts.push(m[1])
  }
  return parts.join('; ')
}

const CSP = readCsp()
const CSP_SETUP = CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

app.whenReady().then(async () => {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url)
    let p = decodeURIComponent(u.pathname)
    if (p === '/' || p === '') p = '/index.html'
    const file = path.join(DIST, p)
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 })
    if (!fs.existsSync(file)) return new Response('Not Found', { status: 404 })
    const ext = path.extname(file).toLowerCase()
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream' }
    if (ext === '.html') {
      headers['content-security-policy'] = p === '/setup.html' ? CSP_SETUP : CSP
      headers['cache-control'] = 'no-cache'
    }
    return new Response(fs.readFileSync(file), { headers })
  })

  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true } })
  const violations = []
  win.webContents.on('console-message', (e) => {
    const msg = String(e?.message ?? '')
    if (/Content Security Policy|Refused to execute/i.test(msg)) violations.push(msg.slice(0, 200))
  })

  await win.loadURL('app://local/index.html')
  await new Promise((r) => setTimeout(r, 2500))

  const out = await win.webContents.executeJavaScript(`(() => {
    const links = [...document.querySelectorAll('link[rel=stylesheet]')]
    return {
      links: links.map(l => ({ href: l.getAttribute('href'), media: l.media, hasMediaAttr: l.hasAttribute('media') })),
      theme: document.documentElement.getAttribute('data-theme'),
      mode: document.documentElement.getAttribute('data-mode'),
      sheets: [...document.styleSheets].map(s => {
        let n = -1
        try { n = s.cssRules ? s.cssRules.length : -1 } catch (_) {}
        return { href: s.href ? s.href.split('/').pop() : null, rules: n, media: s.media && s.media.mediaText }
      }),
    }
  })()`)

  console.log('\n当前 CSP：' + CSP)
  console.log('\n=== <link rel=stylesheet> 的 media（空 = 没写 media 属性，默认 all） ===')
  for (const l of out.links) {
    console.log(`  ${(l.media || '(默认 all)').padEnd(11)} ${l.hasMediaAttr ? '[HTML 声明]' : '[运行时插入]'}  ${l.href}`)
  }
  console.log('\n=== 已加载的样式表（rules 为规则条数） ===')
  for (const s of out.sheets) console.log(`  rules=${String(s.rules).padStart(5)}  media=${s.media}  ${s.href}`)
  // 只判定 HTML 里声明过 media 的那几个（运行时插入的本来就没有 media 属性，先天生效）
  const declared = out.links.filter((l) => l.hasMediaAttr)
  const applied = declared.length > 0 && declared.every((l) => l.media === 'all')
  const loaded = out.sheets.filter((s) => s.rules > 0).length
  console.log(`\nCSP 报错 ${violations.length} 条` + (violations.length ? '：\n  ' + violations.map((v) => v.slice(0, 120)).join('\n  ') : ''))
  console.log(`html[data-theme]=${out.theme} data-mode=${out.mode}  ← 主题抢跑脚本是否执行`)
  console.log(`判定：HTML 声明的 ${declared.length} 个样式表全部 media=all → ${applied ? '是（样式已应用）' : '否（被 print 挡住 = 界面无样式）'}；有规则的样式表 ${loaded} 张`)
  app.quit()
})
